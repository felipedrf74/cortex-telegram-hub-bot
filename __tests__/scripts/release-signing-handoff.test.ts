import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = resolve(process.cwd());
const script = join(root, 'scripts/release-signing-handoff.mjs');
const sourceSha = '1'.repeat(40);
const migrationBase = '2'.repeat(40);
const backendDigest = `sha256:${'3'.repeat(64)}`;
const contentEngineDigest = `sha256:${'4'.repeat(64)}`;
const directories: string[] = [];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'nexus-signing-handoff-'));
  directories.push(directory);
  const hosted = join(directory, 'hosted.json');
  const compose = join(directory, 'compose.yml');
  const handoff = join(directory, 'handoff');
  mkdirSync(handoff);
  const hostedBytes = `${JSON.stringify({
    ok: true,
    comparisonBase: migrationBase,
    cdEligibility: { eligible: true },
    migrationInventory: [{ file: '001_fixture.sql' }],
    migrationReconciliation: { schema: 'fixture' },
  })}\n`;
  writeFileSync(hosted, hostedBytes);
  const hostedDigest = createHash('sha256').update(hostedBytes).digest('hex');
  writeFileSync(compose, 'services:\n  backend:\n    image: fixture\n');
  const created = spawnSync(process.execPath, [
    script,
    'create',
    '--source-sha', sourceSha,
    '--ci-run-id', '123',
    '--migration-base', migrationBase,
    '--backend-digest', backendDigest,
    '--content-engine-digest', contentEngineDigest,
    '--hosted-migration-result', hosted,
    '--hosted-migration-digest', hostedDigest,
    '--compose', compose,
    '--output-directory', handoff,
  ], { cwd: root, encoding: 'utf8' });
  expect(created.status, created.stderr).toBe(0);
  const digest = JSON.parse(created.stdout).digest as string;
  return { directory, hosted, hostedDigest, compose, handoff, digest };
}

function verify(
  handoff: string,
  digest: string,
  overrides: { sourceSha?: string; ciRunId?: string } = {},
) {
  return spawnSync(process.execPath, [
    script,
    'verify',
    '--directory', handoff,
    '--expected-digest', digest,
    '--source-sha', overrides.sourceSha ?? sourceSha,
    '--ci-run-id', overrides.ciRunId ?? '123',
    '--migration-base', migrationBase,
    '--backend-digest', backendDigest,
    '--content-engine-digest', contentEngineDigest,
  ], { cwd: root, encoding: 'utf8' });
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('release signing handoff', () => {
  it('round-trips only JSON and Compose evidence bound to the protected identities', () => {
    const candidate = fixture();
    const result = verify(candidate.handoff, candidate.digest);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schema: 'nexus.release-signing-handoff-verification.v1',
      digest: candidate.digest,
    });
  });

  it('refuses evidence changed after the hosted recomputation emitted its digest', () => {
    const candidate = fixture();
    const output = join(candidate.directory, 'changed-handoff');
    mkdirSync(output);
    writeFileSync(candidate.hosted, '{}\n');
    const result = spawnSync(process.execPath, [
      script,
      'create',
      '--source-sha', sourceSha,
      '--ci-run-id', '123',
      '--migration-base', migrationBase,
      '--backend-digest', backendDigest,
      '--content-engine-digest', contentEngineDigest,
      '--hosted-migration-result', candidate.hosted,
      '--hosted-migration-digest', candidate.hostedDigest,
      '--compose', candidate.compose,
      '--output-directory', output,
    ], { cwd: root, encoding: 'utf8' });
    expect(result.status).toBe(65);
    expect(result.stderr).toContain('changed after the secretless recomputation');
  });

  it('rejects any additional executable or undeclared artifact file', () => {
    const candidate = fixture();
    writeFileSync(join(candidate.handoff, 'postinstall.sh'), '#!/bin/sh\nexit 0\n');
    const result = verify(candidate.handoff, candidate.digest);
    expect(result.status).toBe(65);
    expect(result.stderr).toContain('exactly the governed three files');
  });

  it('rejects a manifest changed after the builder emitted its digest', () => {
    const candidate = fixture();
    const manifest = join(candidate.handoff, 'release-signing-handoff.json');
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
    parsed.source.sha = '5'.repeat(40);
    writeFileSync(manifest, `${JSON.stringify(parsed, null, 2)}\n`);
    const result = verify(candidate.handoff, candidate.digest);
    expect(result.status).toBe(65);
    expect(result.stderr).toContain('manifest digest does not match');
  });

  it('rejects an unknown manifest field even when its new byte digest is supplied', () => {
    const candidate = fixture();
    const manifest = join(candidate.handoff, 'release-signing-handoff.json');
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
    parsed.command = './postinstall.sh';
    const bytes = `${JSON.stringify(parsed, null, 2)}\n`;
    writeFileSync(manifest, bytes);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const result = verify(candidate.handoff, digest);
    expect(result.status).toBe(65);
    expect(result.stderr).toContain('fields do not match the governed schema');
  });

  it('rejects a file whose bytes no longer match the closed manifest', () => {
    const candidate = fixture();
    writeFileSync(
      join(candidate.handoff, 'docker-compose.release.yml'),
      'services:\n  backend:\n    image: tampered\n',
    );
    const result = verify(candidate.handoff, candidate.digest);
    expect(result.status).toBe(65);
    expect(result.stderr).toContain('file digest does not match');
  });

  it('rejects symlinked handoff evidence', () => {
    const candidate = fixture();
    const hosted = join(candidate.handoff, 'hosted-migration-safety.json');
    rmSync(hosted);
    symlinkSync(candidate.hosted, hosted);
    const result = verify(candidate.handoff, candidate.digest);
    expect(result.status).toBe(65);
    expect(result.stderr).toContain('hosted migration result is invalid');
  });

  it('rejects a caller identity that differs from the builder job output', () => {
    const candidate = fixture();
    const result = verify(candidate.handoff, candidate.digest, {
      sourceSha: '6'.repeat(40),
    });
    expect(result.status).toBe(65);
    expect(result.stderr).toContain('identity does not match');
  });
});
