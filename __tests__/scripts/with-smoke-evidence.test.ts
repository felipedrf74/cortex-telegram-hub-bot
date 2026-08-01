import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildReleaseArtifactManifest } from '../../scripts/lib/release-artifact-manifest.mjs';

const temporaryRoots: string[] = [];

function evidenceRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-smoke-evidence-'));
  temporaryRoots.push(root);
  return path.join(root, '.local', 'release', 'smoke-evidence');
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    fs.rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

describe('with-smoke-evidence exact release identity', () => {
  it('writes a full runtime/artifact-bound filename and v2 receipt', () => {
    const runtimeSha = 'a'.repeat(40);
    const artifactDigest = 'b'.repeat(64);
    const evidenceDir = evidenceRoot();
    const result = spawnSync('bash', [
      path.resolve('scripts/with-smoke-evidence.sh'),
      'exact-cross-skill',
      process.execPath,
      '-e',
      'process.stdout.write("safe-smoke\\n")',
    ], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      env: {
        ...process.env,
        NEXUS_SMOKE_EVIDENCE_DIR: evidenceDir,
        NEXUS_SMOKE_REQUIRE_EXACT_IDENTITY: '1',
        NEXUS_RELEASE_SHA: runtimeSha,
        NEXUS_RELEASE_ARTIFACT_SHA256: artifactDigest,
        NEXUS_RELEASE_ROLE: 'staging',
      },
    });

    expect(result.status).toBe(0);
    const files = fs.readdirSync(evidenceDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain(`exact-cross-skill-${runtimeSha}-${artifactDigest}-`);
    const receipt = JSON.parse(fs.readFileSync(path.join(evidenceDir, files[0]), 'utf8'));
    expect(receipt).toMatchObject({
      version: '2',
      smokeName: 'exact-cross-skill',
      sha: runtimeSha,
      runtimeSha,
      artifactDigest,
      releaseRole: 'staging',
      nonEvidentiary: false,
      verdict: 'passed',
      exitCode: 0,
    });
  });

  it('fails before running when exact installed identity is incomplete', () => {
    const evidenceDir = evidenceRoot();
    const result = spawnSync('bash', [
      path.resolve('scripts/with-smoke-evidence.sh'),
      'missing-exact-identity',
      process.execPath,
      '-e',
      'process.exit(99)',
    ], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      env: {
        ...process.env,
        NEXUS_SMOKE_EVIDENCE_DIR: evidenceDir,
        NEXUS_SMOKE_REQUIRE_EXACT_IDENTITY: '1',
        NEXUS_RELEASE_SHA: 'a'.repeat(40),
        NEXUS_RELEASE_ARTIFACT_SHA256: '',
        NEXUS_RELEASE_ROLE: 'staging',
      },
    });

    // 3, never 2: exit 2 is reserved for "intentionally blocked by design", and
    // callers treat that as benign. A hard refusal must not borrow it.
    expect(result.status).toBe(3);
    expect(result.status).not.toBe(2);
    expect(result.stderr).toContain('requires an artifact digest');
    expect(fs.existsSync(evidenceDir)).toBe(false);
  });

  it('refuses a run that claims both exact release evidence and non-evidentiary status', () => {
    const evidenceDir = evidenceRoot();
    const result = spawnSync('bash', [
      path.resolve('scripts/with-smoke-evidence.sh'),
      'contradictory-identity',
      process.execPath,
      '-e',
      'process.stdout.write("must-not-run\\n")',
    ], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      env: {
        ...process.env,
        NEXUS_SMOKE_EVIDENCE_DIR: evidenceDir,
        NEXUS_SMOKE_REQUIRE_EXACT_IDENTITY: '1',
        NEXUS_SMOKE_NON_EVIDENTIARY: '1',
        NEXUS_RELEASE_SHA: 'a'.repeat(40),
        NEXUS_RELEASE_ARTIFACT_SHA256: 'b'.repeat(64),
        NEXUS_RELEASE_ROLE: 'staging',
      },
    });

    expect(result.status).toBe(3);
    expect(result.stderr).toContain('cannot be both exact release evidence and non-evidentiary');
    expect(result.stdout).not.toContain('must-not-run');
    expect(fs.existsSync(evidenceDir)).toBe(false);
  });

  it('marks a non-evidentiary run in both the evidence filename and the receipt', () => {
    const evidenceDir = evidenceRoot();
    const result = spawnSync('bash', [
      path.resolve('scripts/with-smoke-evidence.sh'),
      'training-cross-skill-staging',
      process.execPath,
      '-e',
      'process.stdout.write("dry-run-smoke\\n")',
    ], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      env: {
        ...process.env,
        NEXUS_SMOKE_EVIDENCE_DIR: evidenceDir,
        NEXUS_SMOKE_BUFFERED_CAPTURE: '1',
        NEXUS_SMOKE_NON_EVIDENTIARY: '1',
        NEXUS_RELEASE_SHA: 'a'.repeat(40),
        NEXUS_RELEASE_ARTIFACT_SHA256: 'b'.repeat(64),
        NEXUS_RELEASE_ROLE: '',
      },
    });

    expect(result.status).toBe(0);
    const files = fs.readdirSync(evidenceDir);
    expect(files).toHaveLength(1);
    // A source-built dry-run still carries a real-looking runtime/artifact
    // identity, so the filename itself has to disclaim release proof.
    expect(files[0]).toMatch(/^nonevidentiary-training-cross-skill-staging-/);
    const receipt = JSON.parse(fs.readFileSync(path.join(evidenceDir, files[0]), 'utf8'));
    expect(receipt).toMatchObject({
      smokeName: 'training-cross-skill-staging',
      nonEvidentiary: true,
      verdict: 'passed',
    });
  });

  it('propagates the wrapped exit status when the buffered replay cannot read its buffer', () => {
    const evidenceDir = evidenceRoot();
    // The wrapped command unlinks exactly the two capture buffers it inherited
    // as fd 1/2 (matched by inode, so no other run's buffers are touched), which
    // makes the wrapper's replay `cat` calls fail.
    const result = spawnSync('bash', [
      path.resolve('scripts/with-smoke-evidence.sh'),
      'replay-exit-status',
      process.execPath,
      '-e',
      [
        'const fs = require("node:fs");',
        'const os = require("node:os");',
        'const path = require("node:path");',
        'const own = new Set([1, 2].map((fd) => {',
        '  const stat = fs.fstatSync(fd);',
        '  return `${stat.dev}:${stat.ino}`;',
        '}));',
        'for (const directory of new Set([os.tmpdir(), "/tmp"])) {',
        '  for (const name of fs.readdirSync(directory)) {',
        '    if (!name.startsWith("nx-smoke-")) continue;',
        '    const candidate = path.join(directory, name);',
        '    try {',
        '      const stat = fs.statSync(candidate);',
        '      if (own.has(`${stat.dev}:${stat.ino}`)) fs.unlinkSync(candidate);',
        '    } catch {}',
        '  }',
        '}',
        'process.exit(7);',
      ].join('\n'),
    ], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      env: {
        ...process.env,
        NEXUS_SMOKE_EVIDENCE_DIR: evidenceDir,
        NEXUS_SMOKE_BUFFERED_CAPTURE: '1',
      },
    });

    // The replay is best-effort; the wrapped command's status is authoritative.
    expect(result.status).toBe(7);
    const files = fs.readdirSync(evidenceDir);
    expect(files).toHaveLength(1);
    const receipt = JSON.parse(fs.readFileSync(path.join(evidenceDir, files[0]), 'utf8'));
    expect(receipt).toMatchObject({ exitCode: 7, verdict: 'failed' });
  });

  it('preserves the generic caller filename/sha while adding full runtime provenance', () => {
    const evidenceDir = evidenceRoot();
    const fullSha = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const shortSha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const genericEnv = { ...process.env };
    delete genericEnv.NEXUS_RELEASE_SHA;
    delete genericEnv.NEXUS_RELEASE_ARTIFACT_SHA256;
    delete genericEnv.NEXUS_RELEASE_ROLE;
    delete genericEnv.NEXUS_SMOKE_REQUIRE_EXACT_IDENTITY;
    Object.assign(genericEnv, {
      NEXUS_SMOKE_EVIDENCE_DIR: evidenceDir,
      // Tests use the hardened capture mode; production generic callers keep
      // their historical live tee unless they opt into this mode.
      NEXUS_SMOKE_BUFFERED_CAPTURE: '1',
    });

    const result = spawnSync('bash', [
      path.resolve('scripts/with-smoke-evidence.sh'),
      'generic-smoke',
      process.execPath,
      '-e',
      'process.stdout.write("generic-safe-smoke\\n")',
    ], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      env: genericEnv,
    });

    expect(result.status).toBe(0);
    const files = fs.readdirSync(evidenceDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(new RegExp(`^generic-smoke-${shortSha}-\\d{8}T\\d{6}Z\\.json$`));
    const receipt = JSON.parse(fs.readFileSync(path.join(evidenceDir, files[0]), 'utf8'));
    expect(receipt).toMatchObject({
      smokeName: 'generic-smoke',
      sha: shortSha,
      runtimeSha: fullSha,
      artifactDigest: null,
      releaseRole: null,
      verdict: 'passed',
    });
  });

  it('executes the installed cross-skill wrapper against verifier-derived identity', () => {
    const runtimeSha = 'c'.repeat(40);
    const fixtureBase = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-installed-smoke-'));
    temporaryRoots.push(fixtureBase);
    const source = path.join(fixtureBase, 'source');
    for (const directory of ['dist/tools', 'scripts/lib', 'config', 'migrations', 'prompts']) {
      fs.mkdirSync(path.join(source, directory), { recursive: true });
    }
    fs.writeFileSync(path.join(source, 'package.json'), '{"version":"1.0.0"}\n');
    fs.writeFileSync(path.join(source, 'package-lock.json'), '{"lockfileVersion":3}\n');
    fs.writeFileSync(path.join(source, 'config/capability-manifest.json'), '{"schemaReferences":{}}\n');
    fs.writeFileSync(path.join(source, 'migrations/001_init.sql'), 'SELECT 1;\n');
    fs.writeFileSync(path.join(source, 'prompts/base.md'), 'prompt\n');
    fs.writeFileSync(
      path.join(source, 'dist/tools/training-cross-skill-staging-smoke.js'),
      [
        'if (!/^[0-9a-f]{40}$/.test(process.env.NEXUS_RELEASE_SHA || "")) process.exit(3);',
        'if (!/^[0-9a-f]{64}$/.test(process.env.NEXUS_RELEASE_ARTIFACT_SHA256 || "")) process.exit(4);',
        'process.stdout.write("verified-wrapper-smoke\\n");',
      ].join('\n'),
    );
    for (const relative of [
      'scripts/training-cross-skill-staging-smoke.sh',
      'scripts/with-smoke-evidence.sh',
      'scripts/release-artifact-manifest.mjs',
      'scripts/lib/release-artifact-manifest.mjs',
    ]) {
      const destination = path.join(source, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.resolve(relative), destination);
    }

    const manifest = buildReleaseArtifactManifest(source);
    const releaseBase = path.join(fixtureBase, 'runtime-base');
    const release = path.join(releaseBase, 'releases', `${runtimeSha}-${manifest.digest.slice(0, 12)}`);
    fs.mkdirSync(release, { recursive: true });
    for (const entry of manifest.files) {
      const destination = path.join(release, entry.path);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(source, entry.path), destination);
    }
    fs.writeFileSync(
      path.join(release, 'artifact-manifest.json'),
      `${JSON.stringify({ ...manifest, root: '.' }, null, 2)}\n`,
    );
    fs.writeFileSync(path.join(release, '.complete.json'), `${JSON.stringify({
      schema: 'nexus.release-bundle.v1',
      runtimeSha,
      packageVersion: '1.0.0',
      artifactDigest: manifest.digest,
      fileCount: manifest.fileCount,
      createdAt: '2026-07-31T20:00:00.000Z',
    }, null, 2)}\n`);

    const result = spawnSync('bash', [path.join(release, 'scripts/training-cross-skill-staging-smoke.sh')], {
      cwd: release,
      encoding: 'utf8',
      env: {
        ...process.env,
        NEXUS_RELEASE_BASE_DIR: releaseBase,
        NEXUS_RELEASE_ROLE: 'staging',
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('verified-wrapper-smoke');
    const evidenceDir = path.join(releaseBase, '.local/release/smoke-evidence');
    const receiptFile = fs.readdirSync(evidenceDir).find((name) => name.endsWith('.json'));
    expect(receiptFile).toContain(`${runtimeSha}-${manifest.digest}-`);
    const receipt = JSON.parse(fs.readFileSync(path.join(evidenceDir, receiptFile!), 'utf8'));
    expect(receipt).toMatchObject({
      runtimeSha,
      artifactDigest: manifest.digest,
      releaseRole: 'staging',
      nonEvidentiary: false,
      verdict: 'passed',
    });
    expect(fs.existsSync(path.join(release, '.local'))).toBe(false);
    // Nested manifest verification plus two shell/node hops needs more than the
    // 10s default when the machine is busy.
  }, 60000);
});
