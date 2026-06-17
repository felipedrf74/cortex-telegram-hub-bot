import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const nodeBin = process.execPath;

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'nexus-reward-check-'));
}

function runReward(args: string[], env: Record<string, string> = {}) {
  return spawnSync(nodeBin, ['scripts/reward-check.mjs', ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

describe('reward-check verdict semantics', () => {
  it('forces FAIL for hard failures even in advisory mode', () => {
    const dir = tempDir();
    const changed = join(dir, 'changed.txt');
    const output = join(dir, 'run.json');
    writeFileSync(changed, '.env\n');

    const result = runReward([
      '--area',
      'backend',
      '--changed-files',
      changed,
      '--output',
      output,
      '--json',
      '--advisory',
    ]);

    expect(result.status).toBe(0);
    const run = JSON.parse(readFileSync(output, 'utf8'));
    expect(run.verdict).toBe('FAIL');
    expect(run.hardFailures.map((failure: { id: string }) => failure.id)).toContain('env-file-touched');
    expect(run.score).toBeLessThan(80);
  });

  it('exits non-zero in enforce mode when verdict is FAIL', () => {
    const dir = tempDir();
    const changed = join(dir, 'changed.txt');
    writeFileSync(changed, '.env\n');

    const result = runReward([
      '--area',
      'backend',
      '--changed-files',
      changed,
      '--output',
      join(dir, 'run.json'),
      '--enforce',
    ]);

    expect(result.status).toBe(1);
  });

  it('uses MANUAL_REQUIRED for backend changes without verification evidence', () => {
    const dir = tempDir();
    const changed = join(dir, 'changed.txt');
    const output = join(dir, 'run.json');
    writeFileSync(changed, 'src/api/routes/auth.ts\n');

    const result = runReward([
      '--area',
      'backend',
      '--changed-files',
      changed,
      '--output',
      output,
      '--json',
    ]);

    expect(result.status).toBe(0);
    const run = JSON.parse(readFileSync(output, 'utf8'));
    expect(run.verdict).toBe('MANUAL_REQUIRED');
    expect(run.skippedChecks.some((check: { id: string; skipClassification: string }) => (
      check.id === 'backend-verification-evidence'
      && check.skipClassification === 'manual review required'
    ))).toBe(true);
  });

  it('supports docs advisory runs with skipped docs audit as WARN', () => {
    const dir = tempDir();
    const changed = join(dir, 'changed.txt');
    const output = join(dir, 'run.json');
    writeFileSync(changed, 'docs/agents/VERIFIABLE_REWARD_PROTOCOL.md\n');

    const result = runReward([
      '--area',
      'docs',
      '--changed-files',
      changed,
      '--output',
      output,
      '--json',
      '--advisory',
    ], { NEXUS_REWARD_CHECK_SKIP_DOCS_AUDIT: '1' });

    expect(result.status).toBe(0);
    const run = JSON.parse(readFileSync(output, 'utf8'));
    expect(run.verdict).toBe('WARN');
    expect(run.mandatoryChecks.some((check: { id: string; status: string }) => (
      check.id === 'docs-audit' && check.status === 'SKIPPED'
    ))).toBe(true);
  });

  it('prints JSON with the output path when requested', () => {
    const dir = tempDir();
    const changed = join(dir, 'changed.txt');
    const output = join(dir, 'run.json');
    writeFileSync(changed, '');
    const raw = execFileSync(nodeBin, [
      'scripts/reward-check.mjs',
      '--area',
      'auto',
      '--changed-files',
      changed,
      '--output',
      output,
      '--json',
    ], {
      encoding: 'utf8',
      env: { ...process.env },
    });

    const parsed = JSON.parse(raw);
    expect(parsed.outputPath).toBe(output);
    expect(parsed.version).toBe('1.0.0');
    expect(parsed.verdict).toBe('NOT_APPLICABLE');
  });
});
