// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Phase-2 measurement-contract INTEGRATION test (Wave-1 Rank 4).
//
// Unlike the focused unit test in
// `chat-core-v2-shadow-gate-readiness.test.ts` (which relies on the
// `ensure*Tables` idempotent DDL), this test stands up the PRODUCTION schema by
// applying the REAL numbered migrations (157 audit tables, 161 trace spans, 172
// trace-span retention column, 174 gate-metrics) to an in-memory SQLite DB. It
// then drives the live shadow-recording path
// (`runChatCoreV2ShadowRouteHook` -> `shadow-orchestrator` -> `shadow-replay`
// -> `trace-recorder`) 50+ times across MULTIPLE tenants / users / locales and
// asserts the documented Phase-2 measurement contract end to end:
//
//   - meetsMinRows           (>= 50 shadow rows)
//   - meetsSchemaValidity    (>= 99% schema-valid)
//   - meetsSafeShape         (NO raw strings — every identifier is hex/HMAC)
//   - cross-tenant isolation (the HMAC message-hash VARIES when tenantId,
//                             userId, or the secret changes)
//   - retention policy mapping (sensitivity -> 30d/90d + expires_at present
//                               on persisted rows)
//   - the gate stays HONESTLY CLOSED: `gateMet` is false and `gateCanPromote`
//     is false, and a synthetic-seed-bound recall@8 is REJECTED (it can never
//     open the gate even when persisted >= target).
//
// Fully self-contained: no Docker, no network. The shadow path is purely
// deterministic + synchronous; no model/planner is injected here.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHmac } from 'node:crypto';

import {
  evaluateChatCoreV2ShadowGateReadiness,
  measureChatCoreV2ShadowGateReadiness,
  gateCanPromote,
  upsertRecallAt8,
  getSyntheticSeedCorpusContentHash,
  runChatCoreV2ShadowRouteHook,
  CHAT_CORE_V2_GATE_RECALL_AT_8_TARGET,
} from '../../src/services/chat-core-v2';
import { incrementSchemaCompliance } from '../../src/services/chat-core-v2/autorevert-counters-store';

const MIGRATIONS_DIR = resolve(__dirname, '../../migrations');

// The REAL migration files that own the tables the readiness evaluator and the
// gate-metrics store read from. Applied in numeric order, exactly as
// `runMigrations` would in production.
const REQUIRED_MIGRATIONS = [
  '161_chat_core_v2_trace_spans.sql', // chat_v2_trace_spans (pre-expires_at)
  '172_chat_v2_trace_spans_expires_at.sql', // adds expires_at + backfill
  '174_chat_v2_gate_metrics.sql', // chat_v2_gate_metrics + chat_v2_gate_check_log
  '177_chat_v2_autorevert_counters.sql', // planner schema-compliance counters
  '178_chat_core_v2_model_audit.sql', // chat_v2_model_runs + chat_v2_replay_bundles
] as const;

const HMAC_HEX_64 = /^[a-f0-9]{64}$/;

// A privacy-safe HMAC secret for the shadow hook. Never a real production
// secret; only proves the hashing path and cross-tenant variance.
const HMAC_SECRET = 'rank4-integration-shadow-secret';
const SCHEMA_NOW = new Date('2026-05-30T12:00:00.000Z');

const ENABLED_ENV = {
  CHAT_CORE_V2_SHADOW_ROUTE_HOOK_ENABLED: 'true',
  CHAT_CORE_V2_SHADOW_ROUTE_HMAC_SECRET: HMAC_SECRET,
} as const;

// Multiple tenants/users/locales so the corpus is genuinely cross-tenant and
// multi-locale (mirrors the local-shadow-traffic.sh evidence script).
const TENANTS = [11, 22, 33, 44] as const;
const USERS = [101, 202, 303, 404, 505] as const;
const LOCALES = ['en', 'pt-BR', 'es-ES', 'fr-FR'] as const;

// Varied, privacy-bearing natural-language turns. None of this raw text may
// ever appear in a persisted shadow row — that is the load-bearing assertion.
const READ_PHRASINGS = [
  'What is my next training session today?',
  'Show me my tasks for this week',
  'How much did I spend on groceries last month?',
  'Qual é o meu treino de hoje?',
  'Quais são as minhas tarefas para amanhã?',
  '¿Cuál es mi plan de comidas para hoy?',
  'Quel est mon prochain entraînement de cyclisme?',
  'List my upcoming calendar events',
  'Resume da minha semana de corrida',
  'How is my readiness score trending?',
];

let db: Database.Database;

function applyRealMigrations(target: Database.Database): void {
  for (const file of REQUIRED_MIGRATIONS) {
    const sql = readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8');
    target.exec(sql);
  }
}

interface SeededTurn {
  tenantId: number;
  userId: number;
  text: string;
}

// Drive the real shadow-recording path once and return the inputs so the test
// can independently recompute the expected HMAC for cross-tenant assertions.
function recordTurn(index: number): SeededTurn {
  const tenantId = TENANTS[index % TENANTS.length];
  const userId = USERS[index % USERS.length];
  const locale = LOCALES[index % LOCALES.length];
  const text = `${READ_PHRASINGS[index % READ_PHRASINGS.length]} (#${index})`;

  const result = runChatCoreV2ShadowRouteHook({
    normalizedText: text,
    userId,
    tenantId,
    chatRequestId: `rank4-turn-${index}`,
    userMessageId: `rank4-msg-${index}`,
    clientMessageId: `rank4-client-${index}`,
    locale,
    env: ENABLED_ENV,
    db,
  });

  expect(result.enabled).toBe(true);
  expect(result.recorded).toBe(true);
  expect(result.replayBundleId).toMatch(/^chatv2-shadow-replay:/);
  return { tenantId, userId, text };
}

function seedShadowTurns(count: number): SeededTurn[] {
  const seeded: SeededTurn[] = [];
  for (let i = 0; i < count; i += 1) {
    seeded.push(recordTurn(i));
  }
  return seeded;
}

function seedPlannerSchemaCompliance(passCount: number, failCount = 0): void {
  for (let i = 0; i < passCount; i += 1) {
    expect(incrementSchemaCompliance(db, 'integration-tenant', { valid: true }, SCHEMA_NOW)).toBe(true);
  }
  for (let i = 0; i < failCount; i += 1) {
    expect(incrementSchemaCompliance(db, 'integration-tenant', { valid: false }, SCHEMA_NOW)).toBe(true);
  }
}

// Re-derive the exact message HMAC the hook computes, so the test can prove
// cross-tenant/user/secret isolation without depending on internals.
function expectedMessageHash(tenantId: number, userId: number, secret: string, value: string): string {
  return createHmac('sha256', secret)
    .update(`${tenantId}:${userId}:message:${value}`)
    .digest('hex');
}

function loadBundle(replayBundleId: string): Record<string, unknown> {
  const row = db
    .prepare('SELECT redacted_bundle_json FROM chat_v2_replay_bundles WHERE replay_bundle_id = ?')
    .get(replayBundleId) as { redacted_bundle_json: string } | undefined;
  expect(row).toBeDefined();
  return JSON.parse(row!.redacted_bundle_json) as Record<string, unknown>;
}

beforeEach(() => {
  db = new Database(':memory:');
  applyRealMigrations(db);
});

afterEach(() => {
  db.close();
});

describe('Chat Core v2 shadow-gate readiness (integration, real migrations)', () => {
  it('applies the real migrations and exposes the production chat_v2 schema', () => {
    const tables = (db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>).map((r) => r.name);

    expect(tables).toContain('chat_v2_replay_bundles');
    expect(tables).toContain('chat_v2_trace_spans');
    expect(tables).toContain('chat_v2_gate_metrics');
    expect(tables).toContain('chat_v2_gate_check_log');
    expect(tables).toContain('chat_v2_schema_compliance_counter');

    // Migration 172's expires_at column is present on the migrated trace table.
    const traceCols = (db
      .prepare('PRAGMA table_info(chat_v2_trace_spans)')
      .all() as Array<{ name: string }>).map((c) => c.name);
    expect(traceCols).toContain('expires_at');
  });

  it('meets rows/schema/safe-shape thresholds at >=50 multi-tenant turns but keeps the gate honestly closed', () => {
    seedShadowTurns(55);
    seedPlannerSchemaCompliance(55);

    const readiness = evaluateChatCoreV2ShadowGateReadiness(db);

    // meetsMinRows: >= 50 shadow rows.
    expect(readiness.rowCount).toBe(55);
    expect(readiness.meetsMinRows).toBe(true);

    // meetsSchemaValidity: >= 99%. Every seeded row is a clean shadow plan.
    expect(readiness.schemaValidCount).toBe(55);
    expect(readiness.schemaSampleCount).toBe(55);
    expect(readiness.schemaValidPct).toBe(1);
    expect(readiness.schemaValidPct).toBeGreaterThanOrEqual(0.99);
    expect(readiness.meetsSchemaValidity).toBe(true);
    expect(readiness.replayBundleSchemaValidCount).toBe(55);
    expect(readiness.meetsReplayBundleSchemaValidity).toBe(true);

    // meetsSafeShape: zero raw strings.
    expect(readiness.safeShapeViolationCount).toBe(0);
    expect(readiness.meetsSafeShape).toBe(true);

    // HONEST GATE: recall@8 needs a labeled corpus, so gateMet is always false.
    expect(readiness.recallAt8).toBe('requires_labeled_corpus');
    expect(readiness.gateMet).toBe(false);
    expect(readiness.notes).toContain('recall@8');
  });

  it('persists every shadow row with ONLY hex/HMAC identifiers — no raw message text reaches the DB', () => {
    const seeded = seedShadowTurns(50);

    // Whole-table scan: the serialized bundle JSON must never contain any of the
    // raw natural-language turns we sent.
    const rows = db
      .prepare('SELECT redacted_bundle_json FROM chat_v2_replay_bundles')
      .all() as Array<{ redacted_bundle_json: string }>;
    expect(rows.length).toBe(50);

    const allJson = rows.map((r) => r.redacted_bundle_json).join('\n');
    for (const turn of seeded) {
      expect(allJson).not.toContain(turn.text);
    }
    // Distinctive raw fragments must be entirely absent from the persisted blob.
    expect(allJson).not.toContain('groceries');
    expect(allJson).not.toContain('treino');
    expect(allJson).not.toContain('comidas');

    // Every bundle carries a 64-hex HMAC messageHash and NO raw message field.
    for (const row of rows) {
      const bundle = JSON.parse(row.redacted_bundle_json) as Record<string, unknown>;
      const contextPack = bundle.contextPack as Record<string, unknown>;
      expect(typeof contextPack.messageHash).toBe('string');
      expect(contextPack.messageHash as string).toMatch(HMAC_HEX_64);
      expect(contextPack.userMessageHash as string).toMatch(HMAC_HEX_64);
      expect(contextPack.message).toBeUndefined();
      expect(contextPack.messagePreview).toBeUndefined();
    }

    // Trace spans use sha256-derived ids and carry only a `name:status`
    // redacted summary — never raw text.
    const spans = db
      .prepare('SELECT trace_span_id, redacted_summary FROM chat_v2_trace_spans')
      .all() as Array<{ trace_span_id: string; redacted_summary: string }>;
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) {
      expect(span.trace_span_id).toMatch(/^chatv2-shadow:[a-f0-9]{16}$/);
      expect(span.redacted_summary).toMatch(/^[a-z_]+:[a-z_]+$/);
    }
  });

  it('varies the HMAC message-hash when tenantId, userId, or the secret changes (cross-tenant isolation)', () => {
    const sameText = 'What is my next training session today?';

    // Same text, two DIFFERENT tenants -> two different message hashes.
    const tenantA = runChatCoreV2ShadowRouteHook({
      normalizedText: sameText,
      userId: 900,
      tenantId: 1,
      chatRequestId: 'iso-tenantA',
      userMessageId: 'iso-msgA',
      env: ENABLED_ENV,
      db,
    });
    const tenantB = runChatCoreV2ShadowRouteHook({
      normalizedText: sameText,
      userId: 900,
      tenantId: 2,
      chatRequestId: 'iso-tenantB',
      userMessageId: 'iso-msgB',
      env: ENABLED_ENV,
      db,
    });

    const hashA = loadBundle(tenantA.replayBundleId!).contextPack as Record<string, unknown>;
    const hashB = loadBundle(tenantB.replayBundleId!).contextPack as Record<string, unknown>;
    expect(hashA.messageHash).not.toBe(hashB.messageHash);
    // And each matches the independently-recomputed HMAC.
    expect(hashA.messageHash).toBe(expectedMessageHash(1, 900, HMAC_SECRET, sameText));
    expect(hashB.messageHash).toBe(expectedMessageHash(2, 900, HMAC_SECRET, sameText));

    // Same tenant+text, DIFFERENT user -> different hash.
    const userC = runChatCoreV2ShadowRouteHook({
      normalizedText: sameText,
      userId: 901,
      tenantId: 1,
      chatRequestId: 'iso-userC',
      userMessageId: 'iso-msgC',
      env: ENABLED_ENV,
      db,
    });
    const hashC = loadBundle(userC.replayBundleId!).contextPack as Record<string, unknown>;
    expect(hashC.messageHash).not.toBe(hashA.messageHash);

    // Same tenant+user+text, DIFFERENT secret -> different hash. (Recompute,
    // since the hook only persists one secret per run.)
    const otherSecretHash = expectedMessageHash(1, 900, 'a-totally-different-secret', sameText);
    expect(otherSecretHash).not.toBe(hashA.messageHash);
  });

  it('maps sensitivity to retention policy and stamps expires_at on persisted shadow rows', () => {
    seedShadowTurns(50);

    const bundles = db
      .prepare('SELECT sensitivity, retention_policy, expires_at, created_at FROM chat_v2_replay_bundles')
      .all() as Array<{ sensitivity: string; retention_policy: string; expires_at: string | null; created_at: string }>;
    expect(bundles.length).toBe(50);

    for (const row of bundles) {
      // financial/credential_adjacent -> 30d, everything else -> 90d.
      const expected = row.sensitivity === 'financial' || row.sensitivity === 'credential_adjacent'
        ? '30d'
        : '90d';
      expect(row.retention_policy).toBe(expected);
      expect(['30d', '90d', '1y', 'legal_required']).toContain(row.retention_policy);
    }

    // Trace spans carry a policy-derived expires_at (none are legal_required in
    // the shadow path, so every span must have a non-null expiry the retention
    // cron can act on).
    const spans = db
      .prepare('SELECT retention_policy, expires_at, started_at FROM chat_v2_trace_spans')
      .all() as Array<{ retention_policy: string; expires_at: string | null; started_at: string }>;
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) {
      expect(['30d', '90d']).toContain(span.retention_policy);
      expect(span.expires_at).not.toBeNull();
      expect(Date.parse(span.expires_at!)).toBeGreaterThan(Date.parse(span.started_at));
      const windowDays = span.retention_policy === '30d' ? 30 : 90;
      const expectedExpiry = Date.parse(span.started_at) + windowDays * 24 * 60 * 60 * 1000;
      expect(Date.parse(span.expires_at!)).toBe(expectedExpiry);
    }
  });

  it('keeps gateCanPromote FALSE even at >=50 rows when no recall has been persisted', () => {
    seedShadowTurns(52);
    seedPlannerSchemaCompliance(52);

    const report = measureChatCoreV2ShadowGateReadiness(db);
    expect(report.shadow.meetsMinRows).toBe(true);
    expect(report.shadow.meetsSchemaValidity).toBe(true);
    expect(report.shadow.meetsSafeShape).toBe(true);
    // No recall persisted yet -> gate cannot promote.
    expect(report.persistedRecallAt8).toBeNull();
    expect(report.recallMeetsTarget).toBe(false);
    expect(report.gateCanPromote).toBe(false);
    expect(gateCanPromote(db)).toBe(false);
  });

  it('REJECTS a synthetic-seed-bound recall@8 even when persisted >= the promotion target', () => {
    seedShadowTurns(60);
    seedPlannerSchemaCompliance(60);

    // Persist a recall ABOVE the promotion floor but bound to the rejected
    // synthetic-seed content-hash. The gate must still refuse to promote: a
    // synthetic corpus can never satisfy Phase 2->3.
    const syntheticHash = getSyntheticSeedCorpusContentHash();
    upsertRecallAt8(
      Math.max(0.99, CHAT_CORE_V2_GATE_RECALL_AT_8_TARGET + 0.05),
      { corpusContentHash: syntheticHash },
      db,
    );

    const report = measureChatCoreV2ShadowGateReadiness(db);
    expect(report.persistedRecallAt8).toBeGreaterThanOrEqual(CHAT_CORE_V2_GATE_RECALL_AT_8_TARGET);
    expect(report.recallCorpusContentHash).toBe(syntheticHash);
    expect(report.recallBoundToSyntheticSeed).toBe(true);
    // Bound to synthetic -> treated as NOT meeting target -> gate stays closed.
    expect(report.recallMeetsTarget).toBe(false);
    expect(report.gateCanPromote).toBe(false);
    expect(gateCanPromote(db)).toBe(false);

    // The underlying read-only readiness report still never claims the gate.
    expect(report.shadow.gateMet).toBe(false);
  });

  it('flags a crafted unsafe shadow row (raw text in contextPack) as a safe-shape violation', () => {
    seedShadowTurns(50); // 50 clean rows first
    seedPlannerSchemaCompliance(50);

    // Inject a shadow-prefixed bundle whose contextPack carries a RAW message
    // instead of an HMAC hash. The readiness report must catch it so a privacy
    // regression in the write path can never silently pass the gate.
    db.prepare(
      `INSERT INTO chat_v2_replay_bundles
        (replay_bundle_id, turn_id, sensitivity, retention_policy, redacted_bundle_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      'chatv2-shadow-replay:crafted-unsafe',
      'crafted-unsafe',
      'normal',
      '90d',
      JSON.stringify({
        response: { type: 'chat_core_v2_shadow_plan', routeMethod: 'llm_command_translation', wouldExecute: false },
        contextPack: { hashVersion: 'hmac_sha256@1', message: 'raw private text that must never appear' },
      }),
      '2026-05-30T12:00:00.000Z',
    );

    const readiness = evaluateChatCoreV2ShadowGateReadiness(db);
    expect(readiness.rowCount).toBe(51);
    expect(readiness.safeShapeViolationCount).toBe(1);
    expect(readiness.meetsSafeShape).toBe(false);
    expect(readiness.gateMet).toBe(false);
  });
});
