import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  aggregateCoverage,
  analyzeExistingCoverage,
  changedExecutableCoverage,
  parseAddedLines,
  resolveExactCommit,
  thresholdFailures,
  validateCoverageException,
} from '../../scripts/changed-coverage-gate.mjs';

describe('changed-module coverage gate', () => {
  it('analyzes the existing selected-test report without a second test invocation', () => {
    const source = fs.readFileSync('scripts/changed-coverage-gate.mjs', 'utf8');
    expect(source).not.toContain('node_modules/vitest');
    expect(source).not.toContain('--shard=');

    const result = analyzeExistingCoverage({
      base: 'a'.repeat(40),
      head: 'b'.repeat(40),
      files: ['src/example.ts'],
      criticalFiles: ['src/example.ts'],
      coverageByFile: new Map([['src/example.ts', {
        statementMap: {
          0: { start: { line: 10 }, end: { line: 10 } },
          1: { start: { line: 11 }, end: { line: 11 } },
        },
        s: { 0: 1, 1: 0 },
        branchMap: {},
        b: {},
        fnMap: {},
        f: {},
      }]]),
      changedLineSets: new Map([['src/example.ts', new Set([10, 11])]]),
      policy: {
        coverage: {
          changed: { lines: 50, branches: 0 },
          critical: { lines: 50, branches: 0 },
          exceptions: [],
        },
      },
      selectedTests: ['__tests__/example.test.ts'],
    });
    expect(result).toMatchObject({
      schema: 'nexus.changed-coverage-result.v3',
      analysisOnly: true,
      selectedTestCount: 1,
      verdict: 'PASS',
      missing: [],
    });
    expect(result.changedCoverage.lines).toEqual({ total: 2, covered: 1, pct: 50 });
  });

  it('keeps exception ratchets on the same selected-test coverage record', () => {
    const file = 'src/services/database.ts';
    const result = analyzeExistingCoverage({
      base: 'a'.repeat(40),
      head: 'b'.repeat(40),
      files: [file],
      criticalFiles: [file],
      coverageByFile: new Map([[file, {
        statementMap: {
          0: { start: { line: 1 }, end: { line: 1 } },
          1: { start: { line: 2 }, end: { line: 2 } },
        },
        s: { 0: 1, 1: 0 },
        branchMap: {},
        b: {},
        fnMap: {},
        f: {},
      }]]),
      changedLineSets: new Map([[file, new Set([1])]]),
      policy: {
        coverage: {
          changed: { lines: 80, branches: 75 },
          critical: { lines: 90, branches: 85 },
          exceptions: [{
            file,
            owner: 'test-infrastructure',
            reason: 'The selected run must preserve the observed full-file floor.',
            expires: '2099-12-31',
            minimum: { lines: 75, branches: 0 },
          }],
        },
      },
      selectedTests: ['__tests__/services/database.test.ts'],
    });
    expect(result.failures).toContain(
      'coverage exception src/services/database.ts lines 50% is below 75%',
    );
    expect(result.verdict).toBe('FAIL');
  });

  it('records deletion-only files without demanding nonexistent executable coverage', () => {
    const result = analyzeExistingCoverage({
      base: 'a'.repeat(40),
      head: 'b'.repeat(40),
      files: ['src/retired.ts'],
      coverageRequiredFiles: [],
      criticalFiles: [],
      coverageByFile: new Map(),
      changedLineSets: new Map([['src/retired.ts', new Set()]]),
      policy: {
        coverage: {
          changed: { lines: 80, branches: 75 },
          critical: { lines: 90, branches: 85 },
          exceptions: [],
        },
      },
      selectedTests: ['__tests__/replacement.test.ts'],
    });
    expect(result.files).toEqual(['src/retired.ts']);
    expect(result.coverageRequiredFiles).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.verdict).toBe('PASS');
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
