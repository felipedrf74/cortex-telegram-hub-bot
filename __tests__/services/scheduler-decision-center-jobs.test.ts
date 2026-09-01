// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const SCHEDULER_PATH = path.resolve(__dirname, '../../src/services/scheduler.ts');

function schedulerJobBody(source: string, name: string, nextCron: string): string {
  const start = source.indexOf(`wrapJob('${name}'`);
  const end = source.indexOf(`cron.schedule('${nextCron}'`, start);
  expect(start, `${name} must be scheduled`).toBeGreaterThanOrEqual(0);
  expect(end, `${name} must end before ${nextCron}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('Decision Center scheduler observability', () => {
  const schedulerSource = fs.readFileSync(SCHEDULER_PATH, 'utf8');

  it('registers and schedules the immutable rank-snapshot backfill', () => {
    expect(schedulerSource).toContain(
      "registerJob('decision_rank_snapshot_backfill', 'Decision Rank Snapshot Backfill', '17,47 * * * *', 'system')",
    );
    const body = schedulerJobBody(
      schedulerSource,
      'decision_rank_snapshot_backfill',
      '22,52 * * * *',
    );
    expect(body).toContain('runDecisionRankSnapshotBackfillJob({ limit: 500 })');
    expect(body).toMatch(/if \(result\.failedScopes > 0\)[\s\S]*throw new Error/);
  });

  it('finishes independent daily-attention scopes but fails the durable job on partial failure', () => {
    const body = schedulerJobBody(
      schedulerSource,
      'decision_daily_attention',
      '17,47 * * * *',
    );
    expect(body).toContain('for (const target of getActiveUserTargets())');
    expect(body).toContain('failed += 1');
    expect(body).toMatch(/if \(failed > 0\)[\s\S]*throw new Error/);
  });

  it('does not checkpoint a partially failed handled-history backfill as healthy', () => {
    const body = schedulerJobBody(
      schedulerSource,
      'decision_handled_history_backfill',
      '7,37 * * * *',
    );
    expect(body).toContain('runDecisionHandledHistoryBackfillJob({ limit: 100 })');
    expect(body).toMatch(/if \(result\.failed > 0\)[\s\S]*throw new Error/);
  });

  it('includes immutable rank snapshots in the no-op retention decision', () => {
    const body = schedulerJobBody(
      schedulerSource,
      'decision_ledger_retention_prune',
      '50 4 * * *',
    );
    expect(body).toContain('result.rankSnapshotsPruned === 0');
  });
});
