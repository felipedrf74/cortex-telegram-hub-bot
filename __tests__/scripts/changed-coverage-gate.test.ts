import { describe, expect, it } from 'vitest';
import {
  aggregateCoverage,
  thresholdFailures,
  validateCoverageException,
} from '../../scripts/changed-coverage-gate.mjs';

describe('changed-module coverage gate', () => {
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
