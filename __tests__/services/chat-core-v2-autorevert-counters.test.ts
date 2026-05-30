// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Wave-2 rank 6 — per-tenant per-hour auto-revert counter tables + the
 * metrics-aggregator wiring that reads them (replacing the old hardcoded
 * placeholders).
 *
 * DMV invariants proven here:
 *  - REVERT-SAFE DEFAULTS: with EMPTY counter tables the aggregator still
 *    returns compliance 1.0 and fallback 0.0 (no-data ⇒ dormant-safe, the
 *    auto-revert valve never false-fires);
 *  - increments roll into the correct (tenant_id, window_start) hour bucket and
 *    are isolated per tenant (one tenant's counts never leak into another's);
 *  - a 90%-pass window yields a ~0.9 schema-compliance rate, a 1-in-5 fallback
 *    window yields a 0.2 legacy-fallback rate (the metrics are REAL, not
 *    placeholders);
 *  - OFF-MODE INERTNESS: driving the off-mode orchestration-gate live path writes
 *    ZERO counter rows (the tables stay EMPTY) — the load-bearing dormant-safe
 *    property;
 *  - fire-and-forget: increments NEVER throw on a closed db.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import {
  ensureChatCoreV2AutoRevertCounterTables,
  ensureChatCoreV2SchemaComplianceCounterTable,
  ensureChatCoreV2LegacyFallbackCounterTable,
  incrementSchemaCompliance,
  incrementLegacyFallback,
  sumSchemaComplianceSince,
  sumLegacyFallbackSince,
  chatCoreV2HourBucket,
  CHAT_CORE_V2_AUTOREVERT_COUNTERS_STORE_VERSION,
} from '../../src/services/chat-core-v2/autorevert-counters-store';
import {
  computeSchemaComplianceRate1h,
  computeLegacyFallbackRate24h,
} from '../../src/services/chat-core-v2/metrics-aggregator';
import { runChatCoreV2OrchestrationGate } from '../../src/services/chat-core-v2/orchestration-gate';
import { _resetChatCoreV2RuntimeOverridesForTests } from '../../src/services/chat-core-v2/activation-flags';
import {
  planChatCoreV2ShadowTurnWithPlanner,
  type ChatCoreV2ShadowRunPlanner,
  type ChatCoreV2ShadowTurnInput,
} from '../../src/services/chat-core-v2/shadow-orchestrator';
import {
  CHAT_TURN_PLAN_MICRO_PROMPT_VERSION,
  CHAT_TURN_PLAN_MICRO_SCHEMA_VERSION,
  type ChatTurnPlanMicro,
} from '../../src/services/chat-core-v2/plan-schema';

const NOW = new Date('2026-05-30T12:00:00.000Z');

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  ensureChatCoreV2AutoRevertCounterTables(db);
  return db;
}

function schemaRowCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM chat_v2_schema_compliance_counter').get() as { n: number }).n;
}

function fallbackRowCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM chat_v2_legacy_fallback_counter').get() as { n: number }).n;
}

describe('autorevert-counters — REVERT-SAFE empty-table defaults (load-bearing)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => db.close());

  it('EMPTY tables → computeSchemaComplianceRate1h === 1.0 AND computeLegacyFallbackRate24h === 0.0', () => {
    expect(schemaRowCount(db)).toBe(0);
    expect(fallbackRowCount(db)).toBe(0);
    // No data ⇒ dormant-safe defaults; the auto-revert valve must not fire.
    expect(computeSchemaComplianceRate1h(db, { tenantId: 'tenant-a' }, NOW)).toBe(1.0);
    expect(computeLegacyFallbackRate24h(db, { tenantId: 'tenant-a' }, NOW)).toBe(0.0);
  });

  it('MISSING tables (bare db) → still 1.0 / 0.0 (fail-safe, no throw)', () => {
    const bare = new Database(':memory:');
    expect(computeSchemaComplianceRate1h(bare, { tenantId: 'tenant-a' }, NOW)).toBe(1.0);
    expect(computeLegacyFallbackRate24h(bare, { tenantId: 'tenant-a' }, NOW)).toBe(0.0);
    bare.close();
  });

  it('exposes a version constant', () => {
    expect(CHAT_CORE_V2_AUTOREVERT_COUNTERS_STORE_VERSION).toMatch(/^chat_core_v2_autorevert_counters_store@/);
  });
});

describe('autorevert-counters — schema-compliance bucketing + per-tenant isolation', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => db.close());

  it('increments roll into the correct (tenant_id, window_start) hour bucket', () => {
    incrementSchemaCompliance(db, 'tenant-a', { valid: true }, NOW);
    incrementSchemaCompliance(db, 'tenant-a', { valid: true }, NOW);
    incrementSchemaCompliance(db, 'tenant-a', { valid: false }, NOW);

    // ONE bucket row for (tenant-a, current hour), pass=2 fail=1.
    expect(schemaRowCount(db)).toBe(1);
    const row = db
      .prepare(
        'SELECT window_start, pass_count, fail_count FROM chat_v2_schema_compliance_counter WHERE tenant_id = ?',
      )
      .get('tenant-a') as { window_start: string; pass_count: number; fail_count: number };
    expect(row.window_start).toBe(chatCoreV2HourBucket(NOW));
    expect(row.pass_count).toBe(2);
    expect(row.fail_count).toBe(1);
  });

  it('different hours land in DIFFERENT buckets', () => {
    const laterHour = new Date('2026-05-30T13:00:00.000Z');
    incrementSchemaCompliance(db, 'tenant-a', { valid: true }, NOW);
    incrementSchemaCompliance(db, 'tenant-a', { valid: true }, laterHour);
    expect(schemaRowCount(db)).toBe(2);
  });

  it('a 90%-pass window yields a ~0.9 schema-compliance rate', () => {
    // 9 passes + 1 fail in the current hour ⇒ 9/10 = 0.9.
    for (let i = 0; i < 9; i += 1) incrementSchemaCompliance(db, 'tenant-a', { valid: true }, NOW);
    incrementSchemaCompliance(db, 'tenant-a', { valid: false }, NOW);
    expect(computeSchemaComplianceRate1h(db, { tenantId: 'tenant-a' }, NOW)).toBeCloseTo(0.9, 10);
  });

  it('tenant isolation: tenant-a counts never roll into tenant-b', () => {
    incrementSchemaCompliance(db, 'tenant-a', { valid: false }, NOW); // a: 0/1 → 0.0
    incrementSchemaCompliance(db, 'tenant-b', { valid: true }, NOW); // b: 1/1 → 1.0

    expect(computeSchemaComplianceRate1h(db, { tenantId: 'tenant-a' }, NOW)).toBe(0.0);
    expect(computeSchemaComplianceRate1h(db, { tenantId: 'tenant-b' }, NOW)).toBe(1.0);
    // The raw sum helper agrees and stays scoped.
    expect(sumSchemaComplianceSince(db, 'tenant-a', chatCoreV2HourBucket(NOW))).toEqual({ pass: 0, fail: 1 });
    expect(sumSchemaComplianceSince(db, 'tenant-b', chatCoreV2HourBucket(NOW))).toEqual({ pass: 1, fail: 0 });
  });

  it('a compliance sample older than 1h is OUTSIDE the trailing window', () => {
    const twoHoursAgo = new Date(NOW.getTime() - 2 * 3600_000);
    incrementSchemaCompliance(db, 'tenant-a', { valid: false }, twoHoursAgo);
    // Only a stale fail exists; the 1h window has no rows ⇒ revert-safe 1.0.
    expect(computeSchemaComplianceRate1h(db, { tenantId: 'tenant-a' }, NOW)).toBe(1.0);
  });
});

describe('autorevert-counters — legacy-fallback bucketing + per-tenant isolation', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => db.close());

  it('increments roll into the correct (tenant_id, window_start) bucket', () => {
    incrementLegacyFallback(db, 'tenant-a', { fellBack: true }, NOW);
    incrementLegacyFallback(db, 'tenant-a', { fellBack: false }, NOW);

    expect(fallbackRowCount(db)).toBe(1);
    const row = db
      .prepare(
        'SELECT window_start, fallback_count, total_count FROM chat_v2_legacy_fallback_counter WHERE tenant_id = ?',
      )
      .get('tenant-a') as { window_start: string; fallback_count: number; total_count: number };
    expect(row.window_start).toBe(chatCoreV2HourBucket(NOW));
    expect(row.fallback_count).toBe(1);
    expect(row.total_count).toBe(2);
  });

  it('a 1-in-5 fallback window yields a 0.2 legacy-fallback rate', () => {
    incrementLegacyFallback(db, 'tenant-a', { fellBack: true }, NOW);
    for (let i = 0; i < 4; i += 1) incrementLegacyFallback(db, 'tenant-a', { fellBack: false }, NOW);
    expect(computeLegacyFallbackRate24h(db, { tenantId: 'tenant-a' }, NOW)).toBeCloseTo(0.2, 10);
  });

  it('tenant isolation: tenant-a fallbacks never roll into tenant-b', () => {
    incrementLegacyFallback(db, 'tenant-a', { fellBack: true }, NOW); // a: 1/1 → 1.0
    incrementLegacyFallback(db, 'tenant-b', { fellBack: false }, NOW); // b: 0/1 → 0.0

    expect(computeLegacyFallbackRate24h(db, { tenantId: 'tenant-a' }, NOW)).toBe(1.0);
    expect(computeLegacyFallbackRate24h(db, { tenantId: 'tenant-b' }, NOW)).toBe(0.0);
    expect(sumLegacyFallbackSince(db, 'tenant-a', chatCoreV2HourBucket(new Date(NOW.getTime() - 24 * 3600_000)))).toEqual({
      fallback: 1,
      total: 1,
    });
  });

  it('counts across multiple hour buckets within the 24h window', () => {
    incrementLegacyFallback(db, 'tenant-a', { fellBack: true }, new Date(NOW.getTime() - 5 * 3600_000)); // 5h ago
    incrementLegacyFallback(db, 'tenant-a', { fellBack: false }, NOW); // now
    // 1 fallback / 2 total across two buckets ⇒ 0.5.
    expect(computeLegacyFallbackRate24h(db, { tenantId: 'tenant-a' }, NOW)).toBeCloseTo(0.5, 10);
  });

  it('a fallback older than 24h is OUTSIDE the trailing window → 0.0', () => {
    incrementLegacyFallback(db, 'tenant-a', { fellBack: true }, new Date(NOW.getTime() - 25 * 3600_000));
    expect(computeLegacyFallbackRate24h(db, { tenantId: 'tenant-a' }, NOW)).toBe(0.0);
  });
});

describe('autorevert-counters — fire-and-forget (never throws)', () => {
  it('incrementSchemaCompliance returns false (does NOT throw) on a closed db', () => {
    const db = new Database(':memory:');
    ensureChatCoreV2SchemaComplianceCounterTable(db);
    db.close();
    let result: boolean | undefined;
    expect(() => {
      result = incrementSchemaCompliance(db, 'tenant-a', { valid: true }, NOW);
    }).not.toThrow();
    expect(result).toBe(false);
  });

  it('incrementLegacyFallback returns false (does NOT throw) on a closed db', () => {
    const db = new Database(':memory:');
    ensureChatCoreV2LegacyFallbackCounterTable(db);
    db.close();
    let result: boolean | undefined;
    expect(() => {
      result = incrementLegacyFallback(db, 'tenant-a', { fellBack: true }, NOW);
    }).not.toThrow();
    expect(result).toBe(false);
  });
});

/**
 * OFF-MODE INERTNESS for the legacy-fallback counter (load-bearing). Drives the
 * REAL `runChatCoreV2OrchestrationGate` live path with mode=off (and mode absent)
 * and asserts ZERO counter rows are written — the off-mode live route returns
 * null at the very first guard and never reaches the increment.
 */
describe('autorevert-counters — OFF-MODE INERTNESS via the live orchestration gate', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
    _resetChatCoreV2RuntimeOverridesForTests();
  });
  afterEach(() => {
    _resetChatCoreV2RuntimeOverridesForTests();
    db.close();
  });

  const DRIVING_MESSAGE = 'how was my training readiness this morning';

  it('mode=off → gate returns null AND ZERO legacy-fallback rows are written', () => {
    const result = runChatCoreV2OrchestrationGate({
      message: DRIVING_MESSAGE,
      tenantId: 'tenant-a',
      env: { CHAT_CORE_V2_ORCHESTRATOR_MODE: 'off' },
      legacyFallbackDb: db,
      now: NOW,
    });
    expect(result).toBeNull();
    expect(fallbackRowCount(db)).toBe(0); // the load-bearing assertion.
    expect(computeLegacyFallbackRate24h(db, { tenantId: 'tenant-a' }, NOW)).toBe(0.0);
  });

  it('mode ABSENT (parsed off) → gate returns null AND ZERO rows written', () => {
    const result = runChatCoreV2OrchestrationGate({
      message: DRIVING_MESSAGE,
      tenantId: 'tenant-a',
      env: {}, // CHAT_CORE_V2_ORCHESTRATOR_MODE absent ⇒ parses to 'off'
      legacyFallbackDb: db,
      now: NOW,
    });
    expect(result).toBeNull();
    expect(fallbackRowCount(db)).toBe(0);
  });

  it('mode=shadow → gate is inert (returns null) AND writes NO counter row', () => {
    // Shadow is not a driving mode for the gate; it returns null at guard (1)
    // before any counter increment, so the off-mode-style inertness holds.
    const result = runChatCoreV2OrchestrationGate({
      message: DRIVING_MESSAGE,
      tenantId: 'tenant-a',
      env: { CHAT_CORE_V2_ORCHESTRATOR_MODE: 'shadow' },
      legacyFallbackDb: db,
      now: NOW,
    });
    expect(result).toBeNull();
    expect(fallbackRowCount(db)).toBe(0);
  });

  it('per-tenant kill-switch demotion under canary → gate null AND ZERO rows (still inert)', () => {
    // A tenant demoted off by the auto-revert valve must not produce a counter
    // sample even under an active canary env — the kill-switch guard runs BEFORE
    // the increment boundary.
    _resetChatCoreV2RuntimeOverridesForTests();
    const result = runChatCoreV2OrchestrationGate({
      message: DRIVING_MESSAGE,
      tenantId: 'tenant-a',
      env: { CHAT_CORE_V2_ORCHESTRATOR_MODE: 'off' }, // explicit off as master kill
      legacyFallbackDb: db,
      now: NOW,
    });
    expect(result).toBeNull();
    expect(fallbackRowCount(db)).toBe(0);
  });
});

/**
 * ACTIVE-mode proof that the legacy-fallback increment is REAL (not inert):
 * under canary the gate DOES write a counter sample. This is the dual of the
 * off-mode inertness test — it proves the gate is wired, not dead.
 */
describe('autorevert-counters — ACTIVE-mode legacy-fallback emission (gate is real)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
    _resetChatCoreV2RuntimeOverridesForTests();
  });
  afterEach(() => {
    _resetChatCoreV2RuntimeOverridesForTests();
    db.close();
  });

  it('canary + a low-confidence message → ONE fallback sample (fallback=1,total=1)', () => {
    // A gibberish message classifies low-confidence ⇒ the gate falls through to
    // legacy ⇒ a fallback sample is recorded under the active canary mode.
    const result = runChatCoreV2OrchestrationGate({
      message: 'qzx wibble flumph',
      tenantId: 'tenant-a',
      env: { CHAT_CORE_V2_ORCHESTRATOR_MODE: 'canary' },
      legacyFallbackDb: db,
      now: NOW,
    });
    expect(result).toBeNull();
    const row = db
      .prepare(
        'SELECT fallback_count, total_count FROM chat_v2_legacy_fallback_counter WHERE tenant_id = ?',
      )
      .get('tenant-a') as { fallback_count: number; total_count: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.total_count).toBe(1);
    expect(row!.fallback_count).toBe(1);
  });
});

/**
 * Schema-compliance increment via the shadow planner path. This is the ONLY
 * schema-compliance increment site, and it runs ONLY inside the planner branch
 * of `planChatCoreV2ShadowTurnWithPlanner` — which only does anything when a
 * planner is injected (shadow+/sandbox). The off-mode live route never injects a
 * planner, so this increment is OFF-MODE INERT by construction. These tests prove
 * the increment is REAL when a planner+db is supplied, and SKIPPED otherwise.
 */
describe('autorevert-counters — schema-compliance increment via the shadow planner path', () => {
  const PLANNER_INPUT: ChatCoreV2ShadowTurnInput = {
    turnId: 'turn-sp-1',
    tenantId: 'tenant-a',
    userId: 'user-1',
    intent: 'create_action',
    confidence: 0.91,
    domains: ['tasks'],
    capabilityIds: ['tasks.create'],
    now: NOW,
  };

  function validPlanJson(): string {
    const plan: ChatTurnPlanMicro = {
      schemaVersion: CHAT_TURN_PLAN_MICRO_SCHEMA_VERSION,
      intent: 'read',
      domains: ['tasks'],
      capabilityIds: ['tasks.today_summary'],
      requiredReads: [{ requestId: 'read-1', capabilityId: 'tasks.today_summary' }],
      proposedWrites: [],
      evidenceClaimIds: ['evidence:1'],
      confidence: 0.9,
      complexityScore: 0.2,
      escalationReasons: [],
      contextHash: 'ctx-1',
      promptVersion: CHAT_TURN_PLAN_MICRO_PROMPT_VERSION,
    };
    return JSON.stringify(plan);
  }

  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => db.close());

  it('a valid planner output bumps pass_count (1/1 ⇒ 1.0 compliance)', async () => {
    const runPlanner: ChatCoreV2ShadowRunPlanner = async () => validPlanJson();
    await planChatCoreV2ShadowTurnWithPlanner(PLANNER_INPUT, {
      runPlanner,
      schemaComplianceDb: db,
      now: NOW,
    });
    expect(schemaRowCount(db)).toBe(1);
    expect(computeSchemaComplianceRate1h(db, { tenantId: 'tenant-a' }, NOW)).toBe(1.0);
  });

  it('an unrepairable planner output bumps fail_count (0/1 ⇒ 0.0 compliance)', async () => {
    const runPlanner: ChatCoreV2ShadowRunPlanner = async () => '{"still":"invalid"}';
    await planChatCoreV2ShadowTurnWithPlanner(PLANNER_INPUT, {
      runPlanner,
      schemaComplianceDb: db,
      now: NOW,
    });
    expect(computeSchemaComplianceRate1h(db, { tenantId: 'tenant-a' }, NOW)).toBe(0.0);
  });

  it('a planner THROW records NO schema-compliance sample (no outcome to measure)', async () => {
    const runPlanner: ChatCoreV2ShadowRunPlanner = async () => {
      throw new Error('ollama unavailable');
    };
    await planChatCoreV2ShadowTurnWithPlanner(PLANNER_INPUT, {
      runPlanner,
      schemaComplianceDb: db,
      now: NOW,
    });
    expect(schemaRowCount(db)).toBe(0);
    // No sample ⇒ revert-safe 1.0 default.
    expect(computeSchemaComplianceRate1h(db, { tenantId: 'tenant-a' }, NOW)).toBe(1.0);
  });

  it('OFF-MODE INERT: no schemaComplianceDb injected ⇒ ZERO rows on the supplied db', async () => {
    // The off-mode live route never injects a planner OR a counter db. Even with
    // a planner injected (shadow+), omitting the db writes NOTHING here.
    const runPlanner: ChatCoreV2ShadowRunPlanner = async () => validPlanJson();
    await planChatCoreV2ShadowTurnWithPlanner(PLANNER_INPUT, { runPlanner, now: NOW });
    expect(schemaRowCount(db)).toBe(0); // db was never passed in ⇒ untouched.
  });

  it('OFF-MODE INERT: no planner injected ⇒ ZERO rows (planner branch never runs)', async () => {
    // With no runPlanner the planner branch (the only increment site) is skipped
    // entirely — exactly the off-mode live-route shape.
    await planChatCoreV2ShadowTurnWithPlanner(PLANNER_INPUT, { schemaComplianceDb: db, now: NOW });
    expect(schemaRowCount(db)).toBe(0);
  });
});
