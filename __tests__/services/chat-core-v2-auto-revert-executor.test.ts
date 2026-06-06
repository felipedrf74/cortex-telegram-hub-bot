// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * WP-07 — Chat Core v2 auto-revert EXECUTOR (the WRITE half of B7).
 *
 * Proves the safety valve actually fires per tenant:
 *  - persistence (incl. tenant_id and a keep_current_mode audit row);
 *  - a DB failure is NON-BLOCKING (Map still mutates, no throw);
 *  - each action mutates ONLY the target tenant's override entry (per-tenant
 *    isolation: flip tenant A, assert tenant B untouched);
 *  - pager present / absent / non-2xx / AbortError are ALL non-fatal;
 *  - the persisted metrics snapshot is SAFE SCALARS ONLY (no raw strings / PII).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

import {
  applyAutoRevertDecision,
  buildAutoRevertMetricsSnapshot,
} from '../../src/services/chat-core-v2/auto-revert-executor';
import {
  _resetChatCoreV2RuntimeOverridesForTests,
  getChatCoreV2RuntimeOverride,
  isLanguageShadowOverrideSet,
  isPlannerPinnedToRepairOnly,
} from '../../src/services/chat-core-v2/activation-flags';
import type {
  ChatCoreV2AutoRevertDecision,
  ChatCoreV2AutoRevertMetrics,
} from '../../src/services/chat-core-v2/auto-revert-policy';

const TENANT_A = '111';
const TENANT_B = '222';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  // Mirror migrations/173_chat_v2_auto_revert_decisions.sql.
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_v2_auto_revert_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      actions_json TEXT NOT NULL DEFAULT '[]',
      affected_languages_json TEXT NOT NULL DEFAULT '[]',
      reason_codes_json TEXT NOT NULL DEFAULT '[]',
      metrics_snapshot_json TEXT NOT NULL DEFAULT '{}',
      decided_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function metrics(overrides: Partial<ChatCoreV2AutoRevertMetrics> = {}): ChatCoreV2AutoRevertMetrics {
  return {
    legacyFallbackRate24h: 0.0,
    ollamaHealthy: true,
    schemaComplianceRate1h: 1.0,
    ...overrides,
  };
}

function decision(overrides: Partial<ChatCoreV2AutoRevertDecision> = {}): ChatCoreV2AutoRevertDecision {
  return {
    actions: ['keep_current_mode'],
    affectedLanguages: [],
    reasonCodes: [],
    ...overrides,
  };
}

function readRows(db: Database.Database): Array<{
  tenant_id: string;
  actions_json: string;
  affected_languages_json: string;
  reason_codes_json: string;
  metrics_snapshot_json: string;
}> {
  return db
    .prepare('SELECT tenant_id, actions_json, affected_languages_json, reason_codes_json, metrics_snapshot_json FROM chat_v2_auto_revert_decisions ORDER BY id ASC')
    .all() as Array<{
      tenant_id: string;
      actions_json: string;
      affected_languages_json: string;
      reason_codes_json: string;
      metrics_snapshot_json: string;
    }>;
}

describe('Chat Core v2 auto-revert executor (WP-07)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    _resetChatCoreV2RuntimeOverridesForTests();
    vi.unstubAllGlobals();
    delete process.env.CHAT_CORE_V2_PAGER_WEBHOOK_URL;
  });

  afterEach(() => {
    _resetChatCoreV2RuntimeOverridesForTests();
    vi.unstubAllGlobals();
    db.close();
    delete process.env.CHAT_CORE_V2_PAGER_WEBHOOK_URL;
  });

  describe('persistence', () => {
    it('persists exactly one row with tenant_id + the decision fields', async () => {
      await applyAutoRevertDecision(
        TENANT_A,
        decision({
          actions: ['flip_global_to_shadow'],
          affectedLanguages: [],
          reasonCodes: ['ollama_unhealthy'],
        }),
        metrics({ ollamaHealthy: false }),
        db,
      );

      const rows = readRows(db);
      expect(rows).toHaveLength(1);
      expect(rows[0].tenant_id).toBe(TENANT_A);
      expect(JSON.parse(rows[0].actions_json)).toEqual(['flip_global_to_shadow']);
      expect(JSON.parse(rows[0].reason_codes_json)).toEqual(['ollama_unhealthy']);
    });

    it('persists a keep_current_mode (no-op) audit row too', async () => {
      await applyAutoRevertDecision(TENANT_A, decision(), metrics(), db);

      const rows = readRows(db);
      expect(rows).toHaveLength(1);
      expect(rows[0].tenant_id).toBe(TENANT_A);
      expect(JSON.parse(rows[0].actions_json)).toEqual(['keep_current_mode']);
      // A no-op decision must NOT mutate the override Map.
      expect(getChatCoreV2RuntimeOverride(TENANT_A)).toBeUndefined();
    });

    it('persists ONLY safe scalars in the metrics snapshot (no raw strings / PII)', async () => {
      await applyAutoRevertDecision(
        TENANT_A,
        decision({ actions: ['flip_language_to_shadow'], affectedLanguages: ['pt'] }),
        metrics({
          legacyFallbackRate24h: 0.07,
          schemaComplianceRate1h: 0.91,
          prepassRecallByLanguage: { pt: 0.4, en: 0.99 },
        }),
        db,
      );

      const snapshot = JSON.parse(readRows(db)[0].metrics_snapshot_json) as Record<string, unknown>;
      // Allowlisted scalar keys only.
      expect(Object.keys(snapshot).sort()).toEqual(
        ['legacyFallbackRate24h', 'ollamaHealthy', 'perLanguageArmTrackedCount', 'schemaComplianceRate1h'].sort(),
      );
      // Every persisted value is a number or boolean — never a string/object/array.
      for (const value of Object.values(snapshot)) {
        expect(['number', 'boolean']).toContain(typeof value);
      }
      // The per-language MAP is collapsed to a count (scalar), not persisted raw.
      expect(snapshot.perLanguageArmTrackedCount).toBe(2);
      expect(JSON.stringify(snapshot)).not.toContain('0.99'); // the map values are not persisted
    });

    it('buildAutoRevertMetricsSnapshot drops non-finite numbers and the language map', () => {
      const snapshot = buildAutoRevertMetricsSnapshot(
        metrics({
          legacyFallbackRate24h: Number.NaN,
          schemaComplianceRate1h: Number.POSITIVE_INFINITY,
          prepassRecallByLanguage: { pt: 0.2 },
        }),
      );
      expect(snapshot.legacyFallbackRate24h).toBe(0);
      expect(snapshot.schemaComplianceRate1h).toBe(0);
      expect(snapshot.perLanguageArmTrackedCount).toBe(1);
      expect((snapshot as Record<string, unknown>).prepassRecallByLanguage).toBeUndefined();
    });
  });

  describe('DB failure is non-blocking', () => {
    it('still mutates the Map and does not throw when the INSERT fails', async () => {
      const brokenDb = new Database(':memory:'); // table intentionally NOT created.
      await expect(
        applyAutoRevertDecision(
          TENANT_A,
          decision({ actions: ['flip_global_to_shadow'], reasonCodes: ['ollama_unhealthy'] }),
          metrics({ ollamaHealthy: false }),
          brokenDb,
        ),
      ).resolves.toBeUndefined();

      // The live-path mutation still happened despite the persistence failure.
      expect(getChatCoreV2RuntimeOverride(TENANT_A)?.mode).toBe('shadow');
      brokenDb.close();
    });
  });

  describe('per-tenant isolation (§5.J)', () => {
    it('flip_global_to_shadow mutates ONLY tenant A; tenant B is untouched', async () => {
      await applyAutoRevertDecision(
        TENANT_A,
        decision({ actions: ['flip_global_to_shadow'] }),
        metrics({ ollamaHealthy: false }),
        db,
      );
      expect(getChatCoreV2RuntimeOverride(TENANT_A)?.mode).toBe('shadow');
      expect(getChatCoreV2RuntimeOverride(TENANT_B)).toBeUndefined();
    });

    it('pin_planner_to_repair_only mutates ONLY tenant A', async () => {
      await applyAutoRevertDecision(
        TENANT_A,
        decision({ actions: ['pin_planner_to_repair_only'] }),
        metrics({ schemaComplianceRate1h: 0.5 }),
        db,
      );
      expect(isPlannerPinnedToRepairOnly(TENANT_A)).toBe(true);
      expect(isPlannerPinnedToRepairOnly(TENANT_B)).toBe(false);
    });

    it('flip_language_to_shadow adds the language(s) to ONLY tenant A', async () => {
      await applyAutoRevertDecision(
        TENANT_A,
        decision({ actions: ['flip_language_to_shadow'], affectedLanguages: ['pt', 'es'] }),
        metrics({ prepassRecallByLanguage: { pt: 0.1, es: 0.2 } }),
        db,
      );
      expect(isLanguageShadowOverrideSet(TENANT_A, 'pt')).toBe(true);
      expect(isLanguageShadowOverrideSet(TENANT_A, 'es')).toBe(true);
      expect(isLanguageShadowOverrideSet(TENANT_B, 'pt')).toBe(false);
    });

    it('merges multiple actions into the same tenant entry without clobbering', async () => {
      await applyAutoRevertDecision(
        TENANT_A,
        decision({
          actions: ['flip_global_to_shadow', 'pin_planner_to_repair_only', 'flip_language_to_shadow'],
          affectedLanguages: ['pt'],
        }),
        metrics({ ollamaHealthy: false, schemaComplianceRate1h: 0.5, prepassRecallByLanguage: { pt: 0.1 } }),
        db,
      );
      const override = getChatCoreV2RuntimeOverride(TENANT_A);
      expect(override?.mode).toBe('shadow');
      expect(override?.plannerPinnedToRepairOnly).toBe(true);
      expect(override?.languageShadow).toEqual(['pt']);
      // Tenant B remains completely clean.
      expect(getChatCoreV2RuntimeOverride(TENANT_B)).toBeUndefined();
    });
  });

  describe('pager (page_operator action) is always non-fatal', () => {
    it('absent webhook URL → no fetch, no throw', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      await expect(
        applyAutoRevertDecision(
          TENANT_A,
          decision({ actions: ['page_operator'], reasonCodes: ['legacy_fallback_rate_pager_threshold'] }),
          metrics({ legacyFallbackRate24h: 0.2 }),
          db,
        ),
      ).resolves.toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('non-https webhook URL → refused (no fetch), no throw', async () => {
      process.env.CHAT_CORE_V2_PAGER_WEBHOOK_URL = 'http://insecure.example.com/page';
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      await applyAutoRevertDecision(
        TENANT_A,
        decision({ actions: ['page_operator'] }),
        metrics({ legacyFallbackRate24h: 0.2 }),
        db,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('https webhook is called with an opaque token + scalar payload only', async () => {
      process.env.CHAT_CORE_V2_PAGER_WEBHOOK_URL = 'https://pager.example.com/page';
      const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }) as unknown as Response);
      vi.stubGlobal('fetch', fetchSpy);
      await applyAutoRevertDecision(
        TENANT_A,
        decision({ actions: ['page_operator'], reasonCodes: ['legacy_fallback_rate_pager_threshold'] }),
        metrics({ legacyFallbackRate24h: 0.2 }),
        db,
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      // No raw tenant id leaks into the pager payload.
      expect(JSON.stringify(body)).not.toContain(TENANT_A);
      expect(typeof body.tenantToken).toBe('string');
      // Metrics in the payload are scalar-only.
      const payloadMetrics = body.metrics as Record<string, unknown>;
      for (const value of Object.values(payloadMetrics)) {
        expect(['number', 'boolean']).toContain(typeof value);
      }
    });

    it('non-2xx response → non-fatal (no throw)', async () => {
      process.env.CHAT_CORE_V2_PAGER_WEBHOOK_URL = 'https://pager.example.com/page';
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 }) as unknown as Response));
      await expect(
        applyAutoRevertDecision(
          TENANT_A,
          decision({ actions: ['page_operator'] }),
          metrics({ legacyFallbackRate24h: 0.2 }),
          db,
        ),
      ).resolves.toBeUndefined();
    });

    it('AbortError / network throw → non-fatal (no throw)', async () => {
      process.env.CHAT_CORE_V2_PAGER_WEBHOOK_URL = 'https://pager.example.com/page';
      vi.stubGlobal('fetch', vi.fn(async () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }));
      await expect(
        applyAutoRevertDecision(
          TENANT_A,
          decision({ actions: ['page_operator'] }),
          metrics({ legacyFallbackRate24h: 0.2 }),
          db,
        ),
      ).resolves.toBeUndefined();
    });

    it('does not page when no page_operator action is present', async () => {
      process.env.CHAT_CORE_V2_PAGER_WEBHOOK_URL = 'https://pager.example.com/page';
      const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }) as unknown as Response);
      vi.stubGlobal('fetch', fetchSpy);
      await applyAutoRevertDecision(
        TENANT_A,
        decision({ actions: ['flip_global_to_shadow'] }),
        metrics({ ollamaHealthy: false }),
        db,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
