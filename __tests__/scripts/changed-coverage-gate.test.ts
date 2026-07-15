import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  aggregateCoverage,
  changedExecutableCoverage,
  coverageShardCount,
  parseAddedLines,
  preserveCoverageShardFailure,
  resolveExactCommit,
  thresholdFailures,
  validateCoverageException,
} from '../../scripts/changed-coverage-gate.mjs';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('changed-module coverage gate', () => {
  it('bounds coverage memory by splitting large selections into at most four shards', () => {
    expect(coverageShardCount(1)).toBe(1);
    expect(coverageShardCount(200)).toBe(1);
    expect(coverageShardCount(201)).toBe(2);
    expect(coverageShardCount(727)).toBe(4);
    expect(coverageShardCount(930)).toBe(4);
    expect(() => coverageShardCount(0)).toThrow('positive integer');
  });

  it('preserves opaque shard failures and completed blobs for CI diagnosis', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'changed-coverage-failure-'));
    temporaryDirectories.push(directory);
    const outputDir = path.join(directory, 'output');
    const blobDir = path.join(directory, 'blobs');
    fs.mkdirSync(blobDir, { recursive: true });
    fs.writeFileSync(path.join(blobDir, 'blob-1.json'), '{"complete":true}\n');

    const failure = preserveCoverageShardFailure({
      outputDir,
      blobDir,
      shard: 1,
      shardCount: 4,
      result: { status: 1, signal: null },
      reason: 'Changed coverage shard 1/4 exited with status 1',
    });

    expect(failure).toMatchObject({
      schema: 'nexus.changed-coverage-failure.v1',
      shard: 1,
      shardCount: 4,
      status: 1,
      signal: null,
      blobFiles: ['blob-1.json'],
    });
    expect(fs.existsSync(path.join(outputDir, 'failed-shards/blobs/blob-1.json'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(outputDir, 'failure.json'), 'utf8'))).toEqual(failure);
  });

  it('extracts only added-side lines from zero-context git hunks', () => {
    const lines = parseAddedLines([
      '@@ -10,0 +11,3 @@',
      '@@ -40,2 +43 @@',
      '@@ -99 +101,0 @@',
    ].join('\n'));
    expect([...lines]).toEqual([11, 12, 13, 43]);
  });

  it('measures executable changed lines and their branch outcomes, not untouched legacy code', () => {
    const coverage = changedExecutableCoverage({
      statementMap: {
        0: { start: { line: 10 }, end: { line: 10 } },
        1: { start: { line: 20 }, end: { line: 20 } },
        2: { start: { line: 20 }, end: { line: 21 } },
      },
      s: { 0: 0, 1: 2, 2: 0 },
      branchMap: {
        0: {
          loc: { start: { line: 19 }, end: { line: 21 } },
          locations: [
            { start: { line: 20 }, end: { line: 20 } },
            { start: { line: 20 }, end: { line: 20 } },
          ],
        },
        1: {
          loc: { start: { line: 19 }, end: { line: 40 } },
          locations: [{ start: { line: 30 }, end: { line: 40 } }],
        },
      },
      b: { 0: [3, 0], 1: [0] },
      fnMap: {
        0: { decl: { start: { line: 20 }, end: { line: 20 } } },
        1: { decl: { start: { line: 30 }, end: { line: 30 } } },
      },
      f: { 0: 1, 1: 0 },
    }, new Set([20, 21]));

    expect(coverage).toEqual({
      lines: { total: 2, covered: 1 },
      branches: { total: 2, covered: 1 },
      functions: { total: 1, covered: 1 },
      statements: { total: 2, covered: 1 },
    });
  });

  it('resolves a moving base ref to one immutable commit before planning', () => {
    const sha = 'a'.repeat(40);
    const calls: unknown[][] = [];
    const resolved = resolveExactCommit('/tmp/repository', 'origin/main', (...args: unknown[]) => {
      calls.push(args);
      return `${sha}\n`;
    });

    expect(resolved).toBe(sha);
    expect(calls[0]?.[1]).toEqual(['rev-parse', '--verify', 'origin/main^{commit}']);
    expect(resolveExactCommit('/tmp/repository', 'origin/main', () => 'not-a-sha\n')).toBeNull();
  });

  it('aggregates counters rather than averaging percentages', () => {
    const coverage = aggregateCoverage([
      {
        lines: { total: 90, covered: 90 }, branches: { total: 20, covered: 15 },
        functions: { total: 10, covered: 9 }, statements: { total: 90, covered: 90 },
      },
      {
        lines: { total: 10, covered: 0 }, branches: { total: 4, covered: 3 },
        functions: { total: 2, covered: 1 }, statements: { total: 10, covered: 0 },
      },
    ]);
    expect(coverage.lines).toEqual({ total: 100, covered: 90, pct: 90 });
    expect(coverage.branches).toEqual({ total: 24, covered: 18, pct: 75 });
  });

  it('fails only the governed line and branch thresholds', () => {
    const coverage = aggregateCoverage([{
      lines: { total: 100, covered: 79 }, branches: { total: 100, covered: 75 },
      functions: { total: 10, covered: 0 }, statements: { total: 100, covered: 0 },
    }]);
    expect(thresholdFailures('changed', coverage, { lines: 80, branches: 75 })).toEqual([
      'changed lines 79% is below 80%',
    ]);
  });

  it('treats a metric with no coverable items as fully covered', () => {
    const coverage = aggregateCoverage([]);
    expect(coverage.lines.pct).toBe(100);
    expect(coverage.branches.pct).toBe(100);
  });

  it('requires owned, expiring coverage exceptions with explicit ratchet floors', () => {
    const valid = {
      file: 'src/services/database.ts',
      owner: 'test-infrastructure',
      reason: 'Legacy facade is being split behind focused coverage.',
      expires: '2026-08-31',
      minimum: { lines: 25, branches: 26 },
    };
    expect(validateCoverageException(valid, new Date('2026-07-15T00:00:00Z'))).toEqual([]);
    expect(validateCoverageException(
      { ...valid, owner: '', expires: '2026-07-01' },
      new Date('2026-07-15T00:00:00Z'),
    )).toEqual([
      'coverage exception missing owner',
      'coverage exception expired: src/services/database.ts (2026-07-01)',
    ]);
  });
});
