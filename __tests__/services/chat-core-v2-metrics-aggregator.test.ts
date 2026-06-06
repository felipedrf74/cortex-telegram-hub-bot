// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * WP-06 — Chat Core v2 auto-revert metrics aggregator (READ-ONLY half of B7).
 *
 * DMV: the health mapping is tested against the REAL
 * `computeChatCoreV2OllamaHealthy`, never a stub — this is the exact area a
 * prior QA found an inert valve. The composed metrics are round-tripped through
 * the REAL `evaluateChatCoreV2AutoRevertPolicy` to prove the wiring fires.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

import {
  CHAT_CORE_V2_METRICS_AGGREGATOR_VERSION,
  DEFAULT_OLLAMA_HEALTH_STALENESS_MS,
  computeChatCoreV2AutoRevertMetrics,
  computeChatCoreV2OllamaHealthy,
  computeLegacyFallbackRate24h,
  computeSchemaComplianceRate1h,
  getActiveChatCoreV2TenantIds,
  _CHAT_CORE_V2_METRICS_WINDOWS_FOR_TESTS,
  type ChatCoreV2OllamaHealthProbe,
} from '../../src/services/chat-core-v2/metrics-aggregator';
import { evaluateChatCoreV2AutoRevertPolicy } from '../../src/services/chat-core-v2/auto-revert-policy';

const NOW = new Date('2026-05-30T12:00:00.000Z');

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_v2_trace_spans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_span_id TEXT NOT NULL UNIQUE,
      turn_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      parent_span_id TEXT,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      sensitivity TEXT NOT NULL,
      retention_policy TEXT NOT NULL,
      redacted_summary TEXT NOT NULL,
      attributes_json TEXT NOT NULL DEFAULT '{}',
      started_at TEXT NOT NULL,
      ended_at TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

let spanCounter = 0;
function insertSpan(db: Database.Database, tenantId: string, startedAt: string): void {
  spanCounter += 1;
  db.prepare(
    `INSERT INTO chat_v2_trace_spans
       (trace_span_id, turn_id, tenant_id, user_id, kind, name, status, sensitivity, retention_policy, redacted_summary, started_at)
     VALUES (?, ?, ?, ?, 'router', 'route_decision', 'success', 'normal', '90d', 'redacted', ?)`,
  ).run(`span-${spanCounter}`, `turn-${spanCounter}`, tenantId, 'user-x', startedAt);
}

/** A probe row with sensible defaults; `ts` defaults to "fresh" (now). */
function probe(overrides: Partial<ChatCoreV2OllamaHealthProbe> = {}): ChatCoreV2OllamaHealthProbe {
  return {
    provider: 'ollama',
    status: 'ok',
    latencyMs: 5,
    errorMessage: null,
    ts: NOW.toISOString(),
    ...overrides,
  };
}

const CONFIGURED_ENV = { OLLAMA_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv;
const NOT_CONFIGURED_ENV = { OLLAMA_ENABLED: 'false' } as unknown as NodeJS.ProcessEnv;

describe('WP-06 metrics aggregator — fallback / compliance reads (per tenant)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => db.close());

  it('empty-table defaults are revert-SAFE (division-by-zero safe)', () => {
    // No queryable source exists yet → documented no-data defaults.
    // Fallback rate: 0.0 (below the 0.05 auto-shadow threshold → no revert).
    expect(computeLegacyFallbackRate24h(db, { tenantId: 'tenant-a' }, NOW)).toBe(0.0);
    // Compliance rate: 1.0 (a 0.0 default would auto-pin the planner on idle
    // tenants — the inert/false-positive valve class DMV warns against).
    expect(computeSchemaComplianceRate1h(db, { tenantId: 'tenant-a' }, NOW)).toBe(1.0);
  });

  it('no-data compliance default does NOT trip the policy pin-planner arm', () => {
    const metrics = {
      legacyFallbackRate24h: computeLegacyFallbackRate24h(db, { tenantId: 'tenant-a' }, NOW),
      ollamaHealthy: true,
      schemaComplianceRate1h: computeSchemaComplianceRate1h(db, { tenantId: 'tenant-a' }, NOW),
    };
    const decision = evaluateChatCoreV2AutoRevertPolicy(metrics);
    expect(decision.actions).toEqual(['keep_current_mode']);
    expect(decision.reasonCodes).toHaveLength(0);
  });
});

describe('WP-06 metrics aggregator — active tenant set (24h window, per tenant)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => db.close());

  it('empty / missing table → empty active set (safe no-op)', () => {
    expect(getActiveChatCoreV2TenantIds(db, NOW)).toEqual([]);
    const bare = new Database(':memory:');
    expect(getActiveChatCoreV2TenantIds(bare, NOW)).toEqual([]); // table missing → []
    bare.close();
  });

  it('returns distinct tenants with activity in the trailing 24h only', () => {
    insertSpan(db, 'tenant-a', new Date(NOW.getTime() - 60_000).toISOString()); // 1m ago
    insertSpan(db, 'tenant-a', new Date(NOW.getTime() - 120_000).toISOString()); // dup tenant
    insertSpan(db, 'tenant-b', new Date(NOW.getTime() - 23 * 3600_000).toISOString()); // 23h ago
    insertSpan(db, 'tenant-c', new Date(NOW.getTime() - 25 * 3600_000).toISOString()); // 25h ago → excluded

    const tenants = getActiveChatCoreV2TenantIds(db, NOW);
    expect(tenants).toEqual(['tenant-a', 'tenant-b']);
  });

  it('includes tenants observed only through the live legacy-fallback counter', () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_v2_legacy_fallback_counter (
        tenant_id TEXT NOT NULL,
        window_start TEXT NOT NULL,
        fallback_count INTEGER NOT NULL DEFAULT 0,
        total_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (tenant_id, window_start)
      )
    `);
    db.prepare(`
      INSERT INTO chat_v2_legacy_fallback_counter
        (tenant_id, window_start, fallback_count, total_count, updated_at)
      VALUES (?, ?, 1, 2, ?)
    `).run('tenant-counter-only', '2026-05-30T11', NOW.toISOString());

    expect(getActiveChatCoreV2TenantIds(db, NOW)).toEqual(['tenant-counter-only']);
  });

  it('includes tenants observed only through the attributed legacy-fallback counter', () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_v2_legacy_fallback_attribution_counter (
        tenant_id TEXT NOT NULL,
        window_start TEXT NOT NULL,
        domain TEXT NOT NULL DEFAULT 'unknown',
        route_owner TEXT NOT NULL DEFAULT 'unknown',
        route_method TEXT NOT NULL DEFAULT 'unknown',
        fallback_count INTEGER NOT NULL DEFAULT 0,
        total_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (tenant_id, window_start, domain, route_owner, route_method)
      )
    `);
    db.prepare(`
      INSERT INTO chat_v2_legacy_fallback_attribution_counter
        (tenant_id, window_start, domain, route_owner, route_method, fallback_count, total_count, updated_at)
      VALUES (?, ?, 'tasks', 'chat_core_v2_route_decision', 'needs_clarification', 1, 2, ?)
    `).run('tenant-attribution-only', '2026-05-30T11', NOW.toISOString());

    expect(getActiveChatCoreV2TenantIds(db, NOW)).toEqual(['tenant-attribution-only']);
  });

  it('attributed fallback rows older than 24h are excluded from the active set', () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_v2_legacy_fallback_attribution_counter (
        tenant_id TEXT NOT NULL,
        window_start TEXT NOT NULL,
        domain TEXT NOT NULL DEFAULT 'unknown',
        route_owner TEXT NOT NULL DEFAULT 'unknown',
        route_method TEXT NOT NULL DEFAULT 'unknown',
        fallback_count INTEGER NOT NULL DEFAULT 0,
        total_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (tenant_id, window_start, domain, route_owner, route_method)
      )
    `);
    db.prepare(`
      INSERT INTO chat_v2_legacy_fallback_attribution_counter
        (tenant_id, window_start, domain, route_owner, route_method, fallback_count, total_count, updated_at)
      VALUES (?, ?, 'tasks', 'chat_core_v2_route_decision', 'needs_clarification', 1, 2, ?)
    `).run('tenant-stale-attribution', '2026-05-29T11', NOW.toISOString());

    expect(getActiveChatCoreV2TenantIds(db, NOW)).toEqual([]);
  });

  it('a row for tenant A does not surface tenant B', () => {
    insertSpan(db, 'tenant-a', new Date(NOW.getTime() - 60_000).toISOString());
    expect(getActiveChatCoreV2TenantIds(db, NOW)).toEqual(['tenant-a']);
  });
});

describe('WP-06 metrics aggregator — Ollama health mapping matrix (§5.I, REAL fn)', () => {
  it("status 'ok' (configured) → healthy=true", async () => {
    await expect(
      computeChatCoreV2OllamaHealthy(probe({ status: 'ok' }), { env: CONFIGURED_ENV, now: NOW }),
    ).resolves.toBe(true);
  });

  it("status 'fail' (configured) → healthy=false (valve may fire)", async () => {
    await expect(
      computeChatCoreV2OllamaHealthy(probe({ status: 'fail', errorMessage: 'HTTP 500' }), {
        env: CONFIGURED_ENV,
        now: NOW,
      }),
    ).resolves.toBe(false);
  });

  it("status 'skipped' → short-circuit healthy=true", async () => {
    await expect(
      computeChatCoreV2OllamaHealthy(probe({ status: 'skipped', errorMessage: 'not configured' }), {
        env: CONFIGURED_ENV,
        now: NOW,
      }),
    ).resolves.toBe(true);
  });

  it("errorMessage 'not configured' (even with fail status) → short-circuit healthy=true", async () => {
    await expect(
      computeChatCoreV2OllamaHealthy(probe({ status: 'fail', errorMessage: 'not configured' }), {
        env: CONFIGURED_ENV,
        now: NOW,
      }),
    ).resolves.toBe(true);
  });

  it('MISSING ollama key (no probe row) → short-circuit healthy=true', async () => {
    await expect(
      computeChatCoreV2OllamaHealthy(undefined, {
        env: CONFIGURED_ENV,
        now: NOW,
        readProbe: () => undefined, // simulate missing 'ollama' key
      }),
    ).resolves.toBe(true);
  });

  it('Ollama NOT configured → short-circuit healthy=true even when probe says fail', async () => {
    await expect(
      computeChatCoreV2OllamaHealthy(probe({ status: 'fail' }), { env: NOT_CONFIGURED_ENV, now: NOW }),
    ).resolves.toBe(true);
  });

  it('throw while CONFIGURED → healthy=false', async () => {
    await expect(
      computeChatCoreV2OllamaHealthy(undefined, {
        env: CONFIGURED_ENV,
        now: NOW,
        readProbe: () => {
          throw new Error('db blew up');
        },
      }),
    ).resolves.toBe(false);
  });

  it('throw while NOT configured → healthy=true (valve skipped before the read)', async () => {
    await expect(
      computeChatCoreV2OllamaHealthy(undefined, {
        env: NOT_CONFIGURED_ENV,
        now: NOW,
        readProbe: () => {
          throw new Error('should never be called');
        },
      }),
    ).resolves.toBe(true);
  });

  it('STALE ollama row (ts beyond the staleness window) → short-circuit healthy=true', async () => {
    const staleTs = new Date(NOW.getTime() - (DEFAULT_OLLAMA_HEALTH_STALENESS_MS + 60_000)).toISOString();
    // Even though the stale row says 'fail', staleness wins → healthy=true (never
    // auto-flip on stale data; a dead probe is a paging condition).
    await expect(
      computeChatCoreV2OllamaHealthy(probe({ status: 'fail', ts: staleTs }), {
        env: CONFIGURED_ENV,
        now: NOW,
      }),
    ).resolves.toBe(true);
  });

  it('FRESH ollama fail row (ts inside the window) → healthy=false', async () => {
    const freshTs = new Date(NOW.getTime() - (DEFAULT_OLLAMA_HEALTH_STALENESS_MS - 60_000)).toISOString();
    await expect(
      computeChatCoreV2OllamaHealthy(probe({ status: 'fail', ts: freshTs }), {
        env: CONFIGURED_ENV,
        now: NOW,
      }),
    ).resolves.toBe(false);
  });

  it("parses the integration_health ts format (no trailing 'Z', UTC) for staleness", async () => {
    // SQLite datetime('now') yields 'YYYY-MM-DD HH:MM:SS' with no zone.
    const freshSqliteTs = '2026-05-30 11:58:00';
    await expect(
      computeChatCoreV2OllamaHealthy(probe({ status: 'fail', ts: freshSqliteTs }), {
        env: CONFIGURED_ENV,
        now: NOW,
      }),
    ).resolves.toBe(false); // 2 min old → fresh → fail honored
  });
});

describe('WP-06 metrics aggregator — composed shape + policy round-trip', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => db.close());

  it('composes a ChatCoreV2AutoRevertMetrics with the dormant per-language arm', async () => {
    const metrics = await computeChatCoreV2AutoRevertMetrics(db, { tenantId: 'tenant-a' }, probe({ status: 'ok' }), {
      env: CONFIGURED_ENV,
      now: NOW,
    });
    expect(metrics.legacyFallbackRate24h).toBe(0.0);
    expect(metrics.schemaComplianceRate1h).toBe(1.0);
    expect(metrics.ollamaHealthy).toBe(true);
    // OD-3 open: per-language arm intentionally empty/undefined (dormant).
    expect(metrics.prepassRecallByLanguage).toBeUndefined();
  });

  it('round-trip: healthy Ollama + no-data → policy keeps current mode (no revert)', async () => {
    const metrics = await computeChatCoreV2AutoRevertMetrics(db, { tenantId: 'tenant-a' }, probe({ status: 'ok' }), {
      env: CONFIGURED_ENV,
      now: NOW,
    });
    const decision = evaluateChatCoreV2AutoRevertPolicy(metrics);
    expect(decision.actions).toEqual(['keep_current_mode']);
  });

  it('round-trip: UNHEALTHY Ollama → policy returns flip_global_to_shadow', async () => {
    const freshTs = new Date(NOW.getTime() - 60_000).toISOString();
    const metrics = await computeChatCoreV2AutoRevertMetrics(
      db,
      { tenantId: 'tenant-a' },
      probe({ status: 'fail', ts: freshTs }),
      { env: CONFIGURED_ENV, now: NOW },
    );
    expect(metrics.ollamaHealthy).toBe(false);
    const decision = evaluateChatCoreV2AutoRevertPolicy(metrics);
    expect(decision.actions).toContain('flip_global_to_shadow');
    expect(decision.reasonCodes).toContain('ollama_unhealthy');
  });

  it("per-language arm stays dormant: empty prepassRecallByLanguage never adds 'flip_language_to_shadow'", async () => {
    const metrics = await computeChatCoreV2AutoRevertMetrics(db, { tenantId: 'tenant-a' }, probe({ status: 'ok' }), {
      env: CONFIGURED_ENV,
      now: NOW,
    });
    const decision = evaluateChatCoreV2AutoRevertPolicy(metrics);
    expect(decision.actions).not.toContain('flip_language_to_shadow');
    expect(decision.affectedLanguages).toEqual([]);
  });
});

describe('WP-06 documented cadence + version', () => {
  it('staleness default = probe interval (5 min) × 3 = 15 min', () => {
    expect(_CHAT_CORE_V2_METRICS_WINDOWS_FOR_TESTS.ollamaProbeIntervalMs).toBe(5 * 60_000);
    expect(DEFAULT_OLLAMA_HEALTH_STALENESS_MS).toBe(15 * 60_000);
    expect(_CHAT_CORE_V2_METRICS_WINDOWS_FOR_TESTS.ollamaStalenessMs).toBe(15 * 60_000);
  });

  it('windows: fallback 24h, compliance 1h, active-tenant 24h', () => {
    expect(_CHAT_CORE_V2_METRICS_WINDOWS_FOR_TESTS.fallbackRateWindowMs).toBe(24 * 3600_000);
    expect(_CHAT_CORE_V2_METRICS_WINDOWS_FOR_TESTS.schemaComplianceWindowMs).toBe(3600_000);
    expect(_CHAT_CORE_V2_METRICS_WINDOWS_FOR_TESTS.activeTenantWindowMs).toBe(24 * 3600_000);
  });

  it('exports a version constant', () => {
    expect(CHAT_CORE_V2_METRICS_AGGREGATOR_VERSION).toMatch(/^chat_core_v2_metrics_aggregator@/);
  });
});

/**
 * Scheduler wiring (source-text + privacy). Mirrors the existing
 * scheduler-secretary-agenda-sync regression style: assert registration is
 * mode-gated (default-off), the cron is compute+log only (executor is WP-07),
 * and the log payload carries no raw PII.
 */
describe('WP-06 scheduler wiring (default-off, compute+log only, no raw PII)', () => {
  const SCHEDULER_PATH = path.resolve(__dirname, '../../src/services/scheduler.ts');
  const source = fs.readFileSync(SCHEDULER_PATH, 'utf8');

  it('registers chat_v2_auto_revert_eval at */5 only when mode !== off and the eval cron is enabled', () => {
    expect(source).toContain(
      "registerJob('chat_v2_auto_revert_eval', 'Chat Core v2 Auto-Revert Eval', '*/5 * * * *', 'system')",
    );
    // The registerJob call sits inside a mode-gate guard and a default-on
    // evidence-run escape hatch. Production/default behavior remains armed,
    // while distinct-endpoint parity runs can opt out of self-demotion.
    expect(source).toMatch(
      /resolveChatCoreV2ActivationConfig\(process\.env\)\.mode !== 'off' && isChatCoreV2AutoRevertEvalCronEnabled\(process\.env\)\)\s*\{\s*registerJob\('chat_v2_auto_revert_eval'/,
    );
    // The cron.schedule body is likewise gated by the same checks.
    const cronGate = source.match(
      /if \(resolveChatCoreV2ActivationConfig\(process\.env\)\.mode !== 'off' && isChatCoreV2AutoRevertEvalCronEnabled\(process\.env\)\) \{\s*cron\.schedule\('\*\/5 \* \* \* \*', wrapJob\('chat_v2_auto_revert_eval'/,
    );
    expect(cronGate).not.toBeNull();
    expect(source).toContain("CHAT_CORE_V2_AUTO_REVERT_EVAL ?? 'true'");
  });

  it('cron body computes (WP-06) AND applies the decision (WP-07) in ONE job', () => {
    const body = source.match(
      /wrapJob\('chat_v2_auto_revert_eval',\s*async[\s\S]*?\}\),\s*\{\s*timezone: 'UTC'\s*\}\)/,
    );
    expect(body).not.toBeNull();
    const text = body![0];
    expect(text).toContain('computeChatCoreV2AutoRevertMetrics');
    expect(text).toContain('evaluateChatCoreV2AutoRevertPolicy');
    expect(text).toContain('getActiveChatCoreV2TenantIds');
    // WP-07 (merged into the SAME cron per §5.C): the executor IS invoked here,
    // per tenant, inside the per-tenant try/catch.
    expect(text).toMatch(/applyAutoRevertDecision\s*\(\s*tenantId\s*,\s*decision\s*,\s*metrics\s*,\s*db\s*\)/);
    // Per-tenant try/catch keeps the loop alive.
    expect(text).toMatch(/for \(const tenantId of tenantIds\)/);
  });

  it('logged payload carries no raw tenantId/userId (opaque token only)', () => {
    const body = source.match(
      /wrapJob\('chat_v2_auto_revert_eval',\s*async[\s\S]*?\}\),\s*\{\s*timezone: 'UTC'\s*\}\)/,
    );
    expect(body).not.toBeNull();
    const text = body![0];
    expect(text).toContain('opaqueChatV2TenantToken(tenantId)');
    // The log object keys must not include raw identity fields.
    expect(text).not.toMatch(/tenantId:\s*tenantId/);
    expect(text).not.toContain('userId:');
  });

  it('opaqueChatV2TenantToken is a non-reversible salted hash (not the raw id)', () => {
    expect(source).toContain('function opaqueChatV2TenantToken(tenantId: string)');
    expect(source).toMatch(/createHash\('sha256'\)\.update\(`\$\{salt\}:tenant:\$\{tenantId\}`\)/);
  });
});
