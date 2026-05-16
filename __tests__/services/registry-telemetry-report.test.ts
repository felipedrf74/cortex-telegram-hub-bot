// Phase 4 batch 20 (2026-05-15): registry-telemetry feedback report tests.
//
// Exercises the report module against an in-memory SQLite fixture that
// mimics the `chat_action_telemetry` schema. The tests pin:
//
//   • readTelemetryRows respects since/tenant/user filters
//   • summarizeByAction aggregates outcomes / failures / tiers correctly
//   • clarification-rate and latency-p95 thresholds flag the right rows
//   • formatTelemetryReportMarkdown produces a stable markdown shape

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

import {
  formatTelemetryReportMarkdown,
  generateRegistryTelemetryReport,
  readTelemetryRows,
  summarizeByAction,
} from '../../src/services/registry-telemetry-report';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE chat_action_telemetry (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      conversation_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      planner TEXT NOT NULL,
      route_tier TEXT NOT NULL,
      skill TEXT,
      action TEXT,
      status TEXT,
      calibrated_score REAL,
      threshold REAL,
      model_provider TEXT,
      model TEXT,
      estimated_token_cost_usd REAL,
      verifier_status TEXT,
      latency_ms INTEGER,
      outcome TEXT,
      failure_reason TEXT,
      predicted_action_hash TEXT,
      slot_provenance_json TEXT,
      created_at TEXT NOT NULL
    );
  `);
});

afterEach(() => {
  db.close();
});

interface FixtureRow {
  tenantId?: number;
  userId?: number;
  skill?: string;
  action?: string;
  tier?: string;
  status?: string;
  outcome?: string;
  failureReason?: string;
  latencyMs?: number;
  costUsd?: number;
  createdAt?: string;
}

function insertRow(row: FixtureRow): void {
  const id = `tel-${randomUUID()}`;
  db.prepare(`
    INSERT INTO chat_action_telemetry (
      id, user_id, tenant_id, conversation_id, message_id, planner, route_tier,
      skill, action, status, latency_ms, outcome, failure_reason,
      estimated_token_cost_usd, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    row.userId ?? 1,
    row.tenantId ?? 1,
    `conv-${randomUUID()}`,
    `msg-${randomUUID()}`,
    'deterministic',
    row.tier ?? 'tier0_deterministic',
    row.skill ?? null,
    row.action ?? null,
    row.status ?? 'planned',
    row.latencyMs ?? null,
    row.outcome ?? null,
    row.failureReason ?? null,
    row.costUsd ?? null,
    row.createdAt ?? '2026-05-15T12:00:00.000Z',
  );
}

describe('registry-telemetry-report — readTelemetryRows', () => {
  it('reads all rows when no filters are provided', () => {
    insertRow({ skill: 'tasks', action: 'create_task' });
    insertRow({ skill: 'mail', action: 'send_email' });
    const rows = readTelemetryRows(db);
    expect(rows).toHaveLength(2);
  });

  it('respects the since filter', () => {
    insertRow({ skill: 'tasks', action: 'create_task', createdAt: '2026-05-01T00:00:00Z' });
    insertRow({ skill: 'tasks', action: 'create_task', createdAt: '2026-05-15T00:00:00Z' });
    const rows = readTelemetryRows(db, { since: '2026-05-10T00:00:00Z' });
    expect(rows).toHaveLength(1);
    expect(rows[0].createdAt).toBe('2026-05-15T00:00:00Z');
  });

  it('respects the tenant filter', () => {
    insertRow({ tenantId: 1, skill: 'tasks', action: 'create_task' });
    insertRow({ tenantId: 2, skill: 'tasks', action: 'create_task' });
    const rows = readTelemetryRows(db, { tenantId: 1 });
    expect(rows).toHaveLength(1);
  });

  it('respects the user filter', () => {
    insertRow({ userId: 1, skill: 'tasks', action: 'create_task' });
    insertRow({ userId: 2, skill: 'tasks', action: 'create_task' });
    const rows = readTelemetryRows(db, { userId: 1 });
    expect(rows).toHaveLength(1);
  });
});

describe('registry-telemetry-report — summarizeByAction', () => {
  it('groups by (skill, action) and counts outcomes', () => {
    insertRow({ skill: 'tasks', action: 'create_task', outcome: 'verified_success' });
    insertRow({ skill: 'tasks', action: 'create_task', outcome: 'needs_clarification' });
    insertRow({ skill: 'tasks', action: 'create_task', outcome: 'verified_success' });
    insertRow({ skill: 'mail', action: 'send_email', outcome: 'failed', failureReason: 'provider_timeout' });
    const rows = readTelemetryRows(db);
    const summaries = summarizeByAction(rows);
    const tasksSummary = summaries.find((s) => s.action === 'create_task');
    const mailSummary = summaries.find((s) => s.action === 'send_email');
    expect(tasksSummary?.total).toBe(3);
    expect(tasksSummary?.successRate).toBeCloseTo(2 / 3, 2);
    expect(tasksSummary?.clarificationRate).toBeCloseTo(1 / 3, 2);
    expect(mailSummary?.failureRate).toBe(1);
    expect(mailSummary?.failureReasons.provider_timeout).toBe(1);
  });

  it('computes p50 and p95 latency from non-null values', () => {
    for (const ms of [100, 150, 200, 250, 300, 400, 500, 600, 700, 1500]) {
      insertRow({ skill: 'tasks', action: 'create_task', outcome: 'verified_success', latencyMs: ms });
    }
    const rows = readTelemetryRows(db);
    const summaries = summarizeByAction(rows);
    const summary = summaries[0];
    expect(summary.p50LatencyMs).not.toBeNull();
    expect(summary.p95LatencyMs).not.toBeNull();
    expect(summary.p50LatencyMs!).toBeLessThan(summary.p95LatencyMs!);
  });

  it('returns empty summaries when no rows exist', () => {
    expect(summarizeByAction([])).toHaveLength(0);
  });
});

describe('registry-telemetry-report — formatTelemetryReportMarkdown', () => {
  it('emits a stable markdown shape with totals and per-action table', () => {
    insertRow({ skill: 'tasks', action: 'create_task', outcome: 'verified_success', latencyMs: 150 });
    insertRow({ skill: 'mail', action: 'send_email', outcome: 'failed', failureReason: 'auth_token_expired', latencyMs: 4500, tier: 'tier2_structured_planner' });
    const rows = readTelemetryRows(db);
    const summaries = summarizeByAction(rows);
    const markdown = formatTelemetryReportMarkdown(summaries);
    expect(markdown).toMatch(/Chat Action Telemetry/);
    expect(markdown).toMatch(/Per-action summary/);
    expect(markdown).toMatch(/tasks.*create_task/);
    expect(markdown).toMatch(/mail.*send_email/);
    expect(markdown).toMatch(/auth_token_expired/);
  });

  it('flags actions whose clarification rate exceeds the budget', () => {
    for (let i = 0; i < 8; i++) {
      insertRow({ skill: 'tasks', action: 'update_task', outcome: 'needs_clarification' });
    }
    for (let i = 0; i < 2; i++) {
      insertRow({ skill: 'tasks', action: 'update_task', outcome: 'verified_success' });
    }
    const rows = readTelemetryRows(db);
    const summaries = summarizeByAction(rows);
    const markdown = formatTelemetryReportMarkdown(summaries, {
      clarificationRateBudget: 0.5,
    });
    expect(markdown).toMatch(/HIGH_CLARIFY/);
    expect(markdown).toMatch(/Phrase-coverage candidates/);
    expect(markdown).toMatch(/tasks\.update_task/);
  });

  it('flags actions whose p95 latency exceeds the tier budget', () => {
    // tier0 budget is 250ms; insert rows whose p95 = 800ms. Use 10 slow +
    // 10 fast so the p95 index lands in the slow band.
    for (let i = 0; i < 10; i++) {
      insertRow({ skill: 'tasks', action: 'create_task', latencyMs: 100 });
    }
    for (let i = 0; i < 10; i++) {
      insertRow({ skill: 'tasks', action: 'create_task', latencyMs: 800 });
    }
    const rows = readTelemetryRows(db);
    const summaries = summarizeByAction(rows);
    const markdown = formatTelemetryReportMarkdown(summaries);
    expect(markdown).toMatch(/SLOW_P95/);
  });
});

describe('registry-telemetry-report — generateRegistryTelemetryReport', () => {
  it('composes read + summarize + format', () => {
    insertRow({ skill: 'tasks', action: 'create_task', outcome: 'verified_success' });
    const result = generateRegistryTelemetryReport(db);
    expect(result.summaries.length).toBe(1);
    expect(result.markdown).toMatch(/Chat Action Telemetry/);
  });
});
