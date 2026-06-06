// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Phase 4 batch 20 (2026-05-15): registry-driven telemetry feedback report.
//
// Pulls rows from `chat_action_telemetry` (populated by
// recordChatActionTelemetry in chat-action-state.ts) and aggregates them into
// per-action quality signals. The goal is to surface:
//
//   • Phrase-coverage gaps — actions with high clarification rates may need
//     more golden / paraphrase examples
//   • Risk hotspots — actions with high failureReason rates that suggest
//     a parser ambiguity or a downstream-executor failure
//   • Latency outliers — actions whose p95 exceeds the per-tier budget
//   • Cost outliers — actions whose median verified-success cost is high
//
// The report is read-only: it queries telemetry and emits markdown. No
// schema changes, no auto-mutation of the registry. Intended for periodic
// review (Felipe checks weekly) rather than real-time alerts.

import Database from 'better-sqlite3';

export interface TelemetryReportRow {
  skill: string | null;
  action: string | null;
  routeTier: string;
  status: string;
  outcome: string | null;
  failureReason: string | null;
  latencyMs: number | null;
  costUsd: number | null;
  createdAt: string;
}

export interface ActionTelemetrySummary {
  skill: string | null;
  action: string | null;
  total: number;
  outcomes: Record<string, number>;
  failureReasons: Record<string, number>;
  byTier: Record<string, number>;
  clarificationRate: number;
  successRate: number;
  failureRate: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  meanCostUsd: number | null;
}

export interface TelemetryReportOptions {
  /** Read rows whose createdAt >= since (ISO string). */
  since?: string;
  /** Filter to a specific tenant. */
  tenantId?: number;
  /** Filter to a specific user. */
  userId?: number;
  /** Latency p95 threshold per route tier. */
  latencyP95BudgetMsByTier?: Partial<Record<string, number>>;
  /** Clarification rate threshold above which an action is flagged. */
  clarificationRateBudget?: number;
}

const DEFAULT_LATENCY_BUDGET: Record<string, number> = {
  tier0_deterministic: 250,
  tier1_classifier: 1500,
  tier2_structured_planner: 3500,
  tier3_reviewer: 6000,
};

const DEFAULT_CLARIFICATION_BUDGET = 0.35;

/**
 * Reads telemetry rows from the provided DB connection. Caller is
 * responsible for opening the DB. The function does not write anything.
 */
export function readTelemetryRows(
  db: Database.Database,
  options: TelemetryReportOptions = {},
): TelemetryReportRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.since) {
    where.push('created_at >= ?');
    params.push(options.since);
  }
  if (options.tenantId != null) {
    where.push('tenant_id = ?');
    params.push(options.tenantId);
  }
  if (options.userId != null) {
    where.push('user_id = ?');
    params.push(options.userId);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const stmt = db.prepare(`
    SELECT skill, action, route_tier, status, outcome, failure_reason,
           latency_ms, estimated_token_cost_usd AS cost_usd, created_at
    FROM chat_action_telemetry
    ${clause}
    ORDER BY created_at ASC
  `);
  const rows = stmt.all(...params) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    skill: row.skill as string | null,
    action: row.action as string | null,
    routeTier: (row.route_tier as string | null) ?? 'tier0_deterministic',
    status: (row.status as string | null) ?? 'unknown',
    outcome: row.outcome as string | null,
    failureReason: row.failure_reason as string | null,
    latencyMs: row.latency_ms as number | null,
    costUsd: row.cost_usd as number | null,
    createdAt: (row.created_at as string | null) ?? '',
  }));
}

/** Aggregates rows by (skill, action) and computes summary stats. */
export function summarizeByAction(
  rows: TelemetryReportRow[],
): ActionTelemetrySummary[] {
  const buckets = new Map<string, TelemetryReportRow[]>();
  for (const row of rows) {
    const key = `${row.skill ?? '<null>'}/${row.action ?? '<null>'}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else buckets.set(key, [row]);
  }
  const summaries: ActionTelemetrySummary[] = [];
  for (const [, bucketRows] of buckets) {
    summaries.push(summarizeBucket(bucketRows));
  }
  summaries.sort((a, b) => b.total - a.total);
  return summaries;
}

function summarizeBucket(rows: TelemetryReportRow[]): ActionTelemetrySummary {
  const first = rows[0];
  const outcomes: Record<string, number> = {};
  const failureReasons: Record<string, number> = {};
  const byTier: Record<string, number> = {};
  const latencies: number[] = [];
  const costs: number[] = [];
  for (const row of rows) {
    const outcome = row.outcome ?? row.status;
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    if (row.failureReason) {
      failureReasons[row.failureReason] = (failureReasons[row.failureReason] ?? 0) + 1;
    }
    byTier[row.routeTier] = (byTier[row.routeTier] ?? 0) + 1;
    if (typeof row.latencyMs === 'number' && row.latencyMs >= 0) latencies.push(row.latencyMs);
    if (typeof row.costUsd === 'number' && row.costUsd >= 0) costs.push(row.costUsd);
  }
  const total = rows.length;
  const clarifications = (outcomes.needs_clarification ?? 0) + (outcomes.clarification ?? 0);
  const failures = (outcomes.failed ?? 0) + (outcomes.error ?? 0);
  const successes = (outcomes.verified_success ?? 0) + (outcomes.completed ?? 0);
  return {
    skill: first.skill,
    action: first.action,
    total,
    outcomes,
    failureReasons,
    byTier,
    clarificationRate: clarifications / total,
    successRate: successes / total,
    failureRate: failures / total,
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
    meanCostUsd: costs.length > 0 ? costs.reduce((s, x) => s + x, 0) / costs.length : null,
  };
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/**
 * Emits a markdown report from the summaries, flagging:
 *  • Clarification-rate breaches (> budget)
 *  • Latency p95 breaches (> tier budget)
 *  • Top failure reasons per action
 */
export function formatTelemetryReportMarkdown(
  summaries: ActionTelemetrySummary[],
  options: TelemetryReportOptions = {},
): string {
  const budgets = { ...DEFAULT_LATENCY_BUDGET, ...(options.latencyP95BudgetMsByTier ?? {}) };
  const clarificationBudget = options.clarificationRateBudget ?? DEFAULT_CLARIFICATION_BUDGET;

  const lines: string[] = [];
  lines.push(`# Chat Action Telemetry — Registry Feedback Report`);
  lines.push(``);
  lines.push(`_Generated ${new Date().toISOString()}_`);
  lines.push(``);
  lines.push(`## Totals`);
  lines.push(``);
  const grandTotal = summaries.reduce((s, x) => s + x.total, 0);
  lines.push(`- Actions seen: **${summaries.length}**`);
  lines.push(`- Total telemetry rows: **${grandTotal}**`);
  if (options.since) lines.push(`- Since: ${options.since}`);
  lines.push(``);
  lines.push(`## Per-action summary`);
  lines.push(``);
  lines.push(`| Skill | Action | Total | Success% | Clarify% | Fail% | p50 ms | p95 ms | Flags |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|`);
  for (const summary of summaries) {
    const flags: string[] = [];
    if (summary.clarificationRate > clarificationBudget) {
      flags.push(`HIGH_CLARIFY(${(summary.clarificationRate * 100).toFixed(1)}%)`);
    }
    const dominantTier = Object.entries(summary.byTier).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (dominantTier && summary.p95LatencyMs != null && budgets[dominantTier] != null) {
      if (summary.p95LatencyMs > budgets[dominantTier]) {
        flags.push(`SLOW_P95(${summary.p95LatencyMs}ms>${budgets[dominantTier]}ms)`);
      }
    }
    if (summary.failureRate > 0.1) {
      flags.push(`HIGH_FAIL(${(summary.failureRate * 100).toFixed(1)}%)`);
    }
    lines.push(
      `| ${summary.skill ?? '?'} | ${summary.action ?? '?'} | ${summary.total} | ${(summary.successRate * 100).toFixed(1)}% | ${(summary.clarificationRate * 100).toFixed(1)}% | ${(summary.failureRate * 100).toFixed(1)}% | ${summary.p50LatencyMs ?? '-'} | ${summary.p95LatencyMs ?? '-'} | ${flags.join(' ') || 'OK'} |`,
    );
  }
  lines.push(``);
  lines.push(`## Top failure reasons (across all actions)`);
  lines.push(``);
  const reasons: Record<string, number> = {};
  for (const summary of summaries) {
    for (const [reason, count] of Object.entries(summary.failureReasons)) {
      reasons[reason] = (reasons[reason] ?? 0) + count;
    }
  }
  const sortedReasons = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (sortedReasons.length === 0) {
    lines.push(`_No failure reasons recorded._`);
  } else {
    for (const [reason, count] of sortedReasons) {
      lines.push(`- \`${reason}\` — ${count}`);
    }
  }
  lines.push(``);
  lines.push(`## Phrase-coverage candidates`);
  lines.push(``);
  lines.push(
    `Actions with clarification rate above ${(clarificationBudget * 100).toFixed(0)}% — candidates for ` +
      `more registry examples (paraphrase or ambiguous coverage). The clarification rate suggests the ` +
      `current example bank doesn't cover the user's actual phrasings.`,
  );
  lines.push(``);
  const phraseGapCandidates = summaries.filter((s) => s.clarificationRate > clarificationBudget && s.total >= 5);
  if (phraseGapCandidates.length === 0) {
    lines.push(`_No actions exceed the clarification budget at the current volume threshold._`);
  } else {
    for (const summary of phraseGapCandidates) {
      lines.push(
        `- **${summary.skill}.${summary.action}** — ${summary.total} rows, ${(summary.clarificationRate * 100).toFixed(1)}% clarify rate`,
      );
    }
  }
  return lines.join('\n');
}

/**
 * Convenience composition: read rows, summarize, emit markdown. The caller
 * owns the DB lifecycle.
 */
export function generateRegistryTelemetryReport(
  db: Database.Database,
  options: TelemetryReportOptions = {},
): { summaries: ActionTelemetrySummary[]; markdown: string } {
  const rows = readTelemetryRows(db, options);
  const summaries = summarizeByAction(rows);
  const markdown = formatTelemetryReportMarkdown(summaries, options);
  return { summaries, markdown };
}
