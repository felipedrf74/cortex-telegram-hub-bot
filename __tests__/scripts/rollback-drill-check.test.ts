import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = path.resolve('scripts/rollback-drill-check.mjs');

describe('rollback-drill-check', () => {
  let tmp: string;
  let evidencePath: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-rollback-drill-'));
    evidencePath = path.join(tmp, 'docs/release/evidence/rollback-drill-latest.json');
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function run() {
    return spawnSync('node', [script, '--root', tmp, '--json'], { encoding: 'utf8' });
  }

  function writeEvidence(patch: Record<string, unknown> = {}) {
    const evidence = {
      schema: 'nexus.rollback-drill.v1',
      drilledAt: new Date().toISOString(),
      result: 'passed',
      restoreMode: 'dry-run',
      sourceVersion: '4.14.205',
      targetVersion: '4.14.204',
      sourceSha: '0123456789abcdef0123456789abcdef01234567',
      targetBackup: 'v4.14.204_20260606_120000.tar.gz',
      operator: 'release-lead',
      databaseIntegrity: 'ok',
      backupContainsDatabase: true,
      healthCheck: 'passed',
      ...patch,
    };
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
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
});
