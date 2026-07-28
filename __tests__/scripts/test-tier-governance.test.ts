import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadTestPolicy,
  partitionTestFiles,
  resolveTestDisposition,
  walkTestFiles,
} from '../../scripts/lib/test-policy.mjs';

describe('lean test-tier governance', () => {
  it('rejects traversal and symlink parents for JSON reporter output', () => {
    const packageBefore = fs.readFileSync('package.json', 'utf8');
    const traversal = spawnSync(process.execPath, [
      'scripts/run-test-tier.mjs',
      'deterministic',
      '--list',
      '--json-output',
      '.local/../package.json',
    ], { encoding: 'utf8' });
    expect(traversal.status).not.toBe(0);
    expect(traversal.stderr).toContain('must stay strictly under .local');
    expect(fs.readFileSync('package.json', 'utf8')).toBe(packageBefore);

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-json-output-outside-'));
    const link = path.join('.local', `json-output-link-${process.pid}-${Date.now()}`);
    fs.mkdirSync('.local', { recursive: true });
    fs.symlinkSync(outside, link);
    try {
      const symlinked = spawnSync(process.execPath, [
        'scripts/run-test-tier.mjs',
        'deterministic',
        '--list',
        '--json-output',
        `${link}/report.json`,
      ], { encoding: 'utf8' });
      expect(symlinked.status).not.toBe(0);
      expect(symlinked.stderr).toContain('parent must be a real directory');
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.unlinkSync(link);
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('preserves policy-order disposition provenance', () => {
    const earlierGlob = {
      dispositionRules: [
        { pattern: '__tests__/**/*.test.ts', disposition: 'keep', reason: 'earlier glob' },
        { pattern: '__tests__/exact.test.ts', disposition: 'eval', reason: 'later exact' },
      ],
    };
    const earlierExact = {
      dispositionRules: [
        { pattern: '__tests__/exact.test.ts', disposition: 'eval', reason: 'earlier exact' },
        { pattern: '__tests__/**/*.test.ts', disposition: 'keep', reason: 'later glob' },
      ],
    };
    expect(resolveTestDisposition('__tests__/exact.test.ts', earlierGlob)).toMatchObject({
      disposition: 'keep',
      provenance: { kind: 'pattern', ruleIndex: 0 },
    });
    expect(resolveTestDisposition('__tests__/exact.test.ts', earlierExact)).toMatchObject({
      disposition: 'eval',
      provenance: { kind: 'exact', ruleIndex: 0 },
    });
  });

  it('keeps one compact disposition policy and no automatic full-suite triggers', () => {
    const policy = loadTestPolicy();
    expect(policy).not.toHaveProperty('fullSuiteTriggers');
    expect(policy.dispositionRules).toHaveLength(3);
    expect(policy.tiers).not.toHaveProperty('critical');
    expect(policy.defaultTier).toBe('affected-groups');
  });

  it('partitions deterministic correctness from the two subjective evaluations', () => {
    const files = walkTestFiles();
    const partitions = partitionTestFiles(files, loadTestPolicy());
    expect(partitions.evaluation).toEqual([
      '__tests__/services/coach-kernel-evaluation.test.ts',
      '__tests__/services/content-day-to-day-evaluation.test.ts',
    ]);
    expect(new Set([...partitions.deterministic, ...partitions.evaluation]).size).toBe(files.length);
  });

  it('binds test:fast to the same six-file core pack as the group policy', () => {
    const groups = JSON.parse(fs.readFileSync('config/test-groups.json', 'utf8'));
    const listed = execFileSync(process.execPath, [
      'scripts/run-test-tier.mjs',
      'core',
      '--list',
    ], { encoding: 'utf8' }).trim().split('\n');
    expect([...listed].sort()).toEqual([...groups.core.tests].sort());
    expect(groups.core.targetSeconds).toBe(30);
    const runner = fs.readFileSync('scripts/run-test-tier.mjs', 'utf8');
    expect(runner).toContain('{ maxSeconds: groupPolicy.core.targetSeconds }');
    expect(runner).toContain('Core safety pack exceeded its cold');
  });

  it('keeps the explicit full runners as exact deterministic partitions', () => {
    const deterministic = execFileSync(process.execPath, [
      'scripts/run-test-tier.mjs',
      'deterministic',
      '--list',
    ], { encoding: 'utf8' }).trim().split('\n');
    const sharded = execFileSync(process.execPath, [
      'scripts/run-test-tier.mjs',
      'full-sharded',
      '--list',
    ], { encoding: 'utf8' }).trim().split('\n');
    expect(sharded).toEqual(deterministic);
  });
});
