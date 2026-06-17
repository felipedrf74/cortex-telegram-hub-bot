import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const nodeBin = process.execPath;

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'nexus-reward-export-'));
}

function baseRun(overrides: Record<string, unknown> = {}) {
  return {
    version: '1.0.0',
    policyVersion: '2026-06-16',
    runId: 'run-export-fixture',
    timestamp: '2026-06-16T12:00:00.000Z',
    agent: { name: 'codex' },
    repo: { name: 'cortex-telegram-hub-bot', branch: 'main', baseRef: 'origin/main', headSha: 'abc123', dirty: true },
    area: 'backend',
    changedFiles: ['src/api/routes/auth.ts'],
    classifier: { command: 'classifier', versionHash: null, result: {} },
    signals: [
      { id: 'task-summary', label: 'Task', status: 'PASS', details: { summary: 'Improve auth evidence handling' } },
      { id: 'lesson', label: 'Lesson', status: 'PASS', details: { summary: 'Require tenant evidence before PASS' } },
    ],
    mandatoryChecks: [{ id: 'backend-verification-evidence', status: 'PASS' }],
    optionalChecks: [],
    skippedChecks: [],
    hardFailures: [],
    score: 92,
    verdict: 'PASS',
    evidence: [],
    redactions: [],
    exportEligibility: { eligible: true, reason: 'human-reviewed by Felipe' },
    ...overrides,
  };
}

describe('export-reward-dataset', () => {
  it('exports only eligible human-reviewed Nexus JSONL records', () => {
    const dir = tempDir();
    const inputDir = join(dir, 'runs');
    const output = join(dir, 'dataset.jsonl');
    writeFileSync(join(dir, 'placeholder'), '');
    execFileSync('mkdir', ['-p', inputDir]);
    writeFileSync(join(inputDir, 'eligible.json'), `${JSON.stringify(baseRun())}\n`);
    writeFileSync(join(inputDir, 'ineligible.json'), `${JSON.stringify(baseRun({
      runId: 'skip-me',
      exportEligibility: { eligible: false, reason: 'manual review required before export' },
    }))}\n`);

    const raw = execFileSync(nodeBin, [
      'scripts/export-reward-dataset.mjs',
      '--input',
      inputDir,
      '--output',
      output,
    ], { encoding: 'utf8' });

    const result = JSON.parse(raw);
    expect(result.exported).toBe(1);
    expect(result.skipped).toHaveLength(1);
    const lines = readFileSync(output, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record.humanLabel).toBe('good');
    expect(record.task).toContain('Improve auth evidence handling');
    expect(record.verifierOutput.verdict).toBe('PASS');
  });

  it('blocks exported records that still contain secret-like content', () => {
    const dir = tempDir();
    const inputDir = join(dir, 'runs');
    const output = join(dir, 'dataset.jsonl');
    execFileSync('mkdir', ['-p', inputDir]);
    writeFileSync(join(inputDir, 'secret.json'), `${JSON.stringify(baseRun({
      signals: [
        {
          id: 'task-summary',
          label: 'Task',
          status: 'PASS',
          details: { summary: 'API_KEY=supersecretvalue123 should not export' },
        },
      ],
    }))}\n`);

    const raw = execFileSync(nodeBin, [
      'scripts/export-reward-dataset.mjs',
      '--input',
      inputDir,
      '--output',
      output,
    ], { encoding: 'utf8' });

    const result = JSON.parse(raw);
    expect(result.exported).toBe(1);
    const record = JSON.parse(readFileSync(output, 'utf8').trim());
    expect(JSON.stringify(record)).not.toContain('supersecretvalue123');
    expect(record.task).toContain('[REDACTED:env-secret]');
  });
});
