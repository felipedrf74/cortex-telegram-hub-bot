import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = path.resolve('scripts/rollback-drill-check.mjs');

describe('rollback-drill-check', () => {
  let tmp: string;
  let evidencePath: string;
  let privateKeyPath: string;
  let publicKeyPath: string;
  const targetSha = '89abcdef0123456789abcdef0123456789abcdef';

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-rollback-drill-'));
    evidencePath = path.join(tmp, '.local/release/rollback-drill-latest.json');
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    privateKeyPath = path.join(tmp, 'private.pem');
    publicKeyPath = path.join(tmp, 'public.pem');
    fs.writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    fs.writeFileSync(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function run(extraArgs: string[] = [], env: NodeJS.ProcessEnv = process.env) {
    return spawnSync('node', [
      script,
      '--root',
      tmp,
      '--public-key',
      publicKeyPath,
      '--expect-sha',
      targetSha,
      '--expect-target-version',
      '4.14.205',
      '--json',
      ...extraArgs,
    ], { encoding: 'utf8', env });
  }

  function writeEvidence(patch: Record<string, unknown> = {}, sign = true) {
    const evidence = {
      schema: 'nexus.rollback-drill-payload.v1',
      drilledAt: new Date().toISOString(),
      result: 'passed',
      restoreMode: 'dry-run',
      dryRun: true,
      sourceVersion: '4.14.205',
      targetVersion: '4.14.205',
      sourceSha: '0123456789abcdef0123456789abcdef01234567',
      targetSha,
      targetBackup: 'v4.14.204_20260606_120000.tar.gz',
      operator: 'release-lead',
      databaseIntegrity: 'ok',
      backupContainsDatabase: true,
      healthCheck: 'passed',
      ...patch,
    };
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    if (sign) {
      const signed = spawnSync('node', [
        script,
        'sign',
        '--root',
        tmp,
        '--evidence',
        evidencePath,
        '--private-key',
        privateKeyPath,
        '--json',
      ], { encoding: 'utf8' });
      expect(signed.status).toBe(0);
    }
  }

  it('accepts current passed dry-run rollback evidence', () => {
    writeEvidence();

    const result = run();

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).ok).toBe(true);
  });

  it('rejects missing, stale, and incomplete rollback evidence', () => {
    const missing = run();
    expect(missing.status).toBe(1);
    expect(JSON.parse(missing.stdout).reasons).toContain('rollback_drill_evidence_missing');

    writeEvidence({
      drilledAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString(),
      backupContainsDatabase: false,
      databaseIntegrity: 'not_run',
      healthCheck: 'failed',
    });

    const stale = run();

    expect(stale.status).toBe(1);
    expect(JSON.parse(stale.stdout).reasons).toEqual(expect.arrayContaining([
      expect.stringContaining('drill_stale'),
      'backup_database_proof_missing',
      'database_integrity_not_ok:not_run',
      'health_check_not_passing:failed',
    ]));
  });

  it('rejects unsigned or forged rollback evidence and mismatched deploy targets', () => {
    writeEvidence({}, false);
    const unsigned = run();
    expect(unsigned.status).toBe(1);
    expect(JSON.parse(unsigned.stdout).reasons).toEqual(expect.arrayContaining([
      expect.stringContaining('schema_unsupported'),
      'signature_missing',
    ]));

    writeEvidence({ targetSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    const wrongSha = run();
    expect(wrongSha.status).toBe(1);
    expect(JSON.parse(wrongSha.stdout).reasons).toEqual(expect.arrayContaining([
      expect.stringContaining('targetSha_mismatch'),
    ]));

    writeEvidence({ restoreMode: 'live', dryRun: true });
    const live = run();
    expect(live.status).toBe(1);
    expect(JSON.parse(live.stdout).reasons).toContain('dry_run_restore_missing');
  });

  it('does not let max-age env values disable stale rollback drill checks', () => {
    writeEvidence({
      drilledAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString(),
    });

    for (const value of ['0', 'NaN', '99999']) {
      const stale = run([], { ...process.env, NEXUS_ROLLBACK_DRILL_MAX_AGE_DAYS: value });
      expect(stale.status).toBe(1);
      expect(JSON.parse(stale.stdout).reasons).toEqual(expect.arrayContaining([
        expect.stringContaining('drill_stale'),
      ]));
    }
  });

  it('caps the release gate at thirty days even when callers request a looser window', () => {
    writeEvidence({
      drilledAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const result = run(['--release-gate', '--max-age-days', '90']);
    const output = JSON.parse(result.stdout);

    expect(result.status).toBe(1);
    expect(output.releaseGate).toBe(true);
    expect(output.maxAgeDays).toBe(30);
    expect(output.evidenceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(output.reasons).toEqual(expect.arrayContaining([
      expect.stringContaining('drill_stale'),
    ]));
  });
});
