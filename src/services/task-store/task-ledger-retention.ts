// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Task ledger retention prune (M2B) — the age-based cleanup for the task
 * sync subsystem's write-heavy history tables, pattern-matched to the
 * decision-ledger retention precedent (decision-center.ts).
 *
 * Eligible classes ONLY:
 *   - task_mutations in a terminal, actionless status
 *     ('synced' | 'dead_letter' | 'superseded') older than 90 days;
 *   - task_sync_issues already 'resolved' whose resolved_at is older than
 *     90 days;
 *   - task_sync_observability_events older than 30 days.
 *
 * NEVER pruned: conflict/failed/queued/accepted_local/syncing mutations
 * (they are live repair state — a 100-day-old conflict is still a conflict
 * the user must resolve) and open issues (they back visible sync warnings).
 *
 * GLOBAL age-based prune, batched (bounded LIMIT per pass, capped pass
 * count) so a large backlog never runs as one long transaction. Table and
 * PK names are compile-time literals — no injection surface. No VACUUM: a
 * daily cron must not take SQLite's whole-DB write lock; freed pages are
 * reused by new inserts.
 */

import { getDb } from '../database';

export const TASK_LEDGER_RETENTION_POLICY = {
  /** Terminal mutation rows (synced/dead_letter/superseded) age out here. */
  mutationRetentionDays: 90,
  /** Resolved sync issues age out (by resolved_at) here. */
  resolvedIssueRetentionDays: 90,
  /** Observability events are short-lived diagnostics. */
  observabilityRetentionDays: 30,
} as const;

const PRUNABLE_MUTATION_STATUSES = ['synced', 'dead_letter', 'superseded'] as const;

export interface TaskLedgerRetentionResult {
  mutationsPruned: number;
  resolvedIssuesPruned: number;
  observabilityEventsPruned: number;
  mutationsRemaining: number;
  resolvedIssuesRemaining: number;
  observabilityEventsRemaining: number;
  batches: number;
  durationMs: number;
}

export function runTaskLedgerRetentionJob(
  input: {
    mutationRetentionDays?: number;
    resolvedIssueRetentionDays?: number;
    observabilityRetentionDays?: number;
    batchSize?: number;
    maxBatches?: number;
  } = {},
): TaskLedgerRetentionResult {
  const start = Date.now();
  const db = getDb();
  const batchSize = Math.min(Math.max(input.batchSize ?? 500, 1), 1000);
  const maxBatches = Math.min(Math.max(input.maxBatches ?? 50, 1), 500);
  const cutoff = (days: number | undefined, fallback: number): string =>
    `-${Math.floor(Math.max(days ?? fallback, 1))} days`;

  const pruneTable = (
    table: string,
    pkColumn: string,
    ageColumn: string,
    ageCutoff: string,
    extraPredicate = '1 = 1',
  ): { pruned: number; remaining: number; batches: number } => {
    const selectOld = db.prepare(`
      SELECT ${pkColumn} AS id FROM ${table}
       WHERE datetime(${ageColumn}) < datetime('now', ?) AND ${extraPredicate}
       ORDER BY ${ageColumn} ASC
       LIMIT ?
    `);
    const del = db.prepare(`DELETE FROM ${table} WHERE ${pkColumn} = ?`);
    const delBatch = db.transaction((ids: string[]) => {
      for (const id of ids) del.run(id);
    });
    let pruned = 0;
    let batches = 0;
    while (batches < maxBatches) {
      const rows = selectOld.all(ageCutoff, batchSize) as Array<{ id: string }>;
      if (rows.length === 0) break;
      delBatch(rows.map((row) => row.id));
      pruned += rows.length;
      batches += 1;
      if (rows.length < batchSize) break;
    }
    const remaining = (db.prepare(`
      SELECT COUNT(*) AS n FROM ${table}
       WHERE datetime(${ageColumn}) < datetime('now', ?) AND ${extraPredicate}
    `).get(ageCutoff) as { n: number }).n;
    return { pruned, remaining, batches };
  };

  const mutationStatusList = PRUNABLE_MUTATION_STATUSES.map((status) => `'${status}'`).join(', ');
  const mutations = pruneTable(
    'task_mutations',
    'mutation_id',
    'created_at',
    cutoff(input.mutationRetentionDays, TASK_LEDGER_RETENTION_POLICY.mutationRetentionDays),
    `status IN (${mutationStatusList})`,
  );
  const issues = pruneTable(
    'task_sync_issues',
    'id',
    'resolved_at',
    cutoff(input.resolvedIssueRetentionDays, TASK_LEDGER_RETENTION_POLICY.resolvedIssueRetentionDays),
    "state = 'resolved' AND resolved_at IS NOT NULL",
  );
  const observability = pruneTable(
    'task_sync_observability_events',
    'id',
    'created_at',
    cutoff(input.observabilityRetentionDays, TASK_LEDGER_RETENTION_POLICY.observabilityRetentionDays),
  );

  return {
    mutationsPruned: mutations.pruned,
    resolvedIssuesPruned: issues.pruned,
    observabilityEventsPruned: observability.pruned,
    mutationsRemaining: mutations.remaining,
    resolvedIssuesRemaining: issues.remaining,
    observabilityEventsRemaining: observability.remaining,
    batches: mutations.batches + issues.batches + observability.batches,
    durationMs: Date.now() - start,
  };
}
