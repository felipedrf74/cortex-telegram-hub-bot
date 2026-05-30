import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import {
  ensureChatCoreV2GateMetricsTables,
  upsertRecallAt8,
  getLatestRecallAt8,
  measureChatCoreV2ShadowGateReadiness,
  gateCanPromote,
  recordChatCoreV2GateCheck,
  listChatCoreV2GateCheckLog,
  getSyntheticSeedCorpusContentHash,
  computeChatCoreV2CorpusContentHash,
  CHAT_CORE_V2_GATE_RECALL_AT_8_TARGET,
  RECALL_AT_8_METRIC_KEY,
} from '../../src/services/chat-core-v2/gate-metrics-store';
import { runChatCoreV2ShadowRouteHook } from '../../src/services/chat-core-v2';
import { CHAT_CORE_V2_GOLDEN_CORPUS_SEED } from '../../src/services/chat-core-v2/golden-corpus-seed';

let db: Database.Database;

const ENABLED_ENV = {
  CHAT_CORE_V2_SHADOW_ROUTE_HOOK_ENABLED: 'true',
  CHAT_CORE_V2_SHADOW_ROUTE_HMAC_SECRET: 'gate-metrics-store-test-secret',
};

const NON_SYNTHETIC_HASH = 'real-peer-reviewed-corpus-hash-deadbeef';

/** Seed N clean, schema-valid, safe-shaped shadow rows so shadow readiness can be met. */
function seedSafeShadowTurns(count: number): void {
  for (let i = 0; i < count; i += 1) {
    const result = runChatCoreV2ShadowRouteHook({
      normalizedText: `What is my next training session number ${i}?`,
      userId: 7,
      tenantId: 7,
      chatRequestId: `gms-turn-${i}`,
      userMessageId: `gms-msg-${i}`,
      clientMessageId: `gms-client-${i}`,
      locale: 'en',
      env: ENABLED_ENV,
      db,
    });
    expect(result.recorded).toBe(true);
  }
}

describe('Chat Core v2 gate-metrics store (WP-13)', () => {
  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  describe('migration / DDL idempotency', () => {
    it('ensure-table is idempotent (safe to call repeatedly)', () => {
      ensureChatCoreV2GateMetricsTables(db);
      ensureChatCoreV2GateMetricsTables(db);
      ensureChatCoreV2GateMetricsTables(db);

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('chat_v2_gate_metrics', 'chat_v2_gate_check_log')")
        .all()
        .map((r: any) => r.name)
        .sort();
      expect(tables).toEqual(['chat_v2_gate_check_log', 'chat_v2_gate_metrics']);
    });
  });

  describe('upsert / read round-trip', () => {
    it('getLatestRecallAt8 returns null when the store is empty', () => {
      ensureChatCoreV2GateMetricsTables(db);
      expect(getLatestRecallAt8(db)).toBeNull();
    });

    it('getLatestRecallAt8 returns null gracefully when the table does not exist', () => {
      // No ensure-table call: a fresh in-memory db with no migration applied.
      expect(getLatestRecallAt8(db)).toBeNull();
    });

    it('upsert then read round-trips the value, hash, and timestamp', () => {
      const persisted = upsertRecallAt8(0.92, { corpusContentHash: NON_SYNTHETIC_HASH, recordedAt: '2026-05-30T00:00:00.000Z' }, db);
      expect(persisted.metricKey).toBe(RECALL_AT_8_METRIC_KEY);
      expect(persisted.recallAt8).toBe(0.92);
      expect(persisted.corpusContentHash).toBe(NON_SYNTHETIC_HASH);

      const read = getLatestRecallAt8(db);
      expect(read).not.toBeNull();
      expect(read!.recallAt8).toBe(0.92);
      expect(read!.corpusContentHash).toBe(NON_SYNTHETIC_HASH);
      expect(read!.recordedAt).toBe('2026-05-30T00:00:00.000Z');
    });

    it('upsert keeps a SINGLE latest row (a second measurement replaces the first)', () => {
      upsertRecallAt8(0.80, { corpusContentHash: NON_SYNTHETIC_HASH }, db);
      upsertRecallAt8(0.95, { corpusContentHash: NON_SYNTHETIC_HASH }, db);

      const rowCount = db.prepare('SELECT COUNT(*) AS n FROM chat_v2_gate_metrics').get() as { n: number };
      expect(rowCount.n).toBe(1);
      expect(getLatestRecallAt8(db)!.recallAt8).toBe(0.95);
    });

    it('rejects a non-finite recall value', () => {
      expect(() => upsertRecallAt8(Number.NaN, {}, db)).toThrow(TypeError);
    });
  });

  describe('gateCanPromote truth table (HONEST)', () => {
    it('FALSE when recall is null (the default/honest state until WP-19-seed runs)', () => {
      // Shadow readiness MET, but no persisted recall yet.
      seedSafeShadowTurns(50);
      const report = measureChatCoreV2ShadowGateReadiness(db);

      expect(report.shadow.meetsMinRows).toBe(true);
      expect(report.shadow.meetsSchemaValidity).toBe(true);
      expect(report.shadow.meetsSafeShape).toBe(true);
      expect(report.persistedRecallAt8).toBeNull();
      expect(report.recallMeetsTarget).toBe(false);
      expect(report.gateCanPromote).toBe(false);
      expect(gateCanPromote(db)).toBe(false);
      expect(report.notes).toContain('WP-19-seed');
    });

    it('FALSE when shadow readiness is unmet, even with a real recall >= target', () => {
      // Only a few shadow rows (< 50) -> shadow readiness NOT met.
      seedSafeShadowTurns(3);
      upsertRecallAt8(0.95, { corpusContentHash: NON_SYNTHETIC_HASH }, db);

      const report = measureChatCoreV2ShadowGateReadiness(db);
      expect(report.shadow.meetsMinRows).toBe(false);
      expect(report.recallMeetsTarget).toBe(true); // recall itself is fine
      expect(report.gateCanPromote).toBe(false); // but shadow readiness blocks it
      expect(report.notes).toContain('shadow readiness');
    });

    it('FALSE when the persisted recall is bound to the synthetic-seed hash (synthetic can never promote)', () => {
      seedSafeShadowTurns(50);
      // A recall >= target, but measured over the REJECTED synthetic seed corpus.
      upsertRecallAt8(0.99, { corpusContentHash: getSyntheticSeedCorpusContentHash() }, db);

      const report = measureChatCoreV2ShadowGateReadiness(db);
      expect(report.shadow.meetsMinRows).toBe(true);
      expect(report.persistedRecallAt8).toBe(0.99);
      expect(report.recallBoundToSyntheticSeed).toBe(true);
      expect(report.recallMeetsTarget).toBe(false); // synthetic-bound is treated as not meeting the gate
      expect(report.gateCanPromote).toBe(false);
      expect(report.notes).toContain('synthetic');
    });

    it('FALSE when a real recall is below the 0.90 target', () => {
      seedSafeShadowTurns(50);
      upsertRecallAt8(0.85, { corpusContentHash: NON_SYNTHETIC_HASH }, db);

      const report = measureChatCoreV2ShadowGateReadiness(db);
      expect(report.shadow.meetsMinRows).toBe(true);
      expect(report.persistedRecallAt8).toBe(0.85);
      expect(report.gateCanPromote).toBe(false);
    });

    it('TRUE only when shadow readiness met AND a real (non-synthetic) recall >= target', () => {
      seedSafeShadowTurns(50);
      upsertRecallAt8(0.91, { corpusContentHash: NON_SYNTHETIC_HASH }, db);

      const report = measureChatCoreV2ShadowGateReadiness(db);
      expect(report.shadow.meetsMinRows).toBe(true);
      expect(report.shadow.meetsSchemaValidity).toBe(true);
      expect(report.shadow.meetsSafeShape).toBe(true);
      expect(report.persistedRecallAt8).toBe(0.91);
      expect(report.recallBoundToSyntheticSeed).toBe(false);
      expect(report.recallMeetsTarget).toBe(true);
      expect(report.recallTarget).toBe(CHAT_CORE_V2_GATE_RECALL_AT_8_TARGET);
      expect(report.gateCanPromote).toBe(true);
      expect(gateCanPromote(db)).toBe(true);
      expect(report.notes).toContain('gateCanPromote=true');
    });
  });

  describe('synthetic-seed hash binding', () => {
    it('the synthetic-seed hash is stable and matches a recompute over the seed', () => {
      // Recompute over the seed's recall-relevant signal must equal the memoized hash.
      const recomputed = computeChatCoreV2CorpusContentHash(CHAT_CORE_V2_GOLDEN_CORPUS_SEED);
      expect(recomputed).toBe(getSyntheticSeedCorpusContentHash());
      expect(recomputed).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('automated gate-check log', () => {
    it('records a gate-check row reflecting the composed (false) gate and reads it back', () => {
      seedSafeShadowTurns(50); // shadow met, recall still null -> gate false
      const { report, logRowId } = recordChatCoreV2GateCheck(db);
      expect(report.gateCanPromote).toBe(false);
      expect(logRowId).toBeGreaterThan(0);

      const rows = listChatCoreV2GateCheckLog(db);
      expect(rows.length).toBe(1);
      expect(rows[0].gateCanPromote).toBe(false);
      expect(rows[0].meetsMinRows).toBe(true);
      expect(rows[0].recallAt8).toBeNull();
      expect(rows[0].shadowRowCount).toBe(50);
    });

    it('listChatCoreV2GateCheckLog returns [] when the table does not exist', () => {
      expect(listChatCoreV2GateCheckLog(db)).toEqual([]);
    });
  });
});
