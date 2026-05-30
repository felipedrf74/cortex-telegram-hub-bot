// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// WP-08 — Shadow data-retention cron.
//
// Exercises `runChatCoreV2ShadowDataRetention` (the body the midnight_cleanup
// cron invokes) directly against an in-memory SQLite DB so retention behaviour
// is deterministic and isolated from the cron schedule.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runChatCoreV2ShadowDataRetention } from '../../src/services/scheduler';
import {
  ensureChatCoreV2TraceTables,
  recordChatV2TraceSpan,
  getChatV2TraceSpanById,
  resolveTraceSpanExpiresAt,
  ensureChatCoreV2AuditTables,
  ensureChatCoreV2OnlineEvalTables,
  ensureChatCoreV2MemoryTables,
  ensureChatCoreV2HumanReviewTables,
  ensureChatCoreV2CanaryTurnLogTable,
} from '../../src/services/chat-core-v2';
import type { ChatV2TraceSpan } from '../../src/services/chat-core-v2';

let db: Database.Database;

// Fixed "now" so the day-window boundaries are deterministic.
const NOW = '2026-05-30T00:00:00.000Z';
const nowMs = Date.parse(NOW);
const DAY_MS = 24 * 60 * 60 * 1000;

function isoDaysAgo(days: number): string {
  return new Date(nowMs - days * DAY_MS).toISOString();
}
function isoDaysFromNow(days: number): string {
  return new Date(nowMs + days * DAY_MS).toISOString();
}

function baseSpan(overrides: Partial<ChatV2TraceSpan> & { traceSpanId: string }): ChatV2TraceSpan {
  return {
    turnId: 'turn-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    kind: 'router',
    name: 'route message',
    status: 'success',
    sensitivity: 'normal',
    retentionPolicy: '30d',
    redactedSummary: 'redacted',
    startedAt: NOW,
    ...overrides,
  };
}

// Raw inserts let us set arbitrary timestamps / statuses that the higher-level
// writers (which stamp "now" / enforce 'pending'-on-enqueue) would not allow.
function insertReplayBundle(id: string, expiresAt: string | null): void {
  ensureChatCoreV2AuditTables(db);
  db.prepare(
    `INSERT INTO chat_v2_replay_bundles
       (replay_bundle_id, turn_id, sensitivity, retention_policy, redacted_bundle_json, created_at, expires_at)
     VALUES (?, 'turn-1', 'normal', '30d', '{}', ?, ?)`,
  ).run(id, isoDaysAgo(1), expiresAt);
}

// Raw insert so we can set an arbitrary expires_at (the writer stamps
// recorded_at + 90 days; here we exercise the boundary directly). The column is
// NOT NULL per migration 178, so expires_at is always a concrete timestamp.
function insertCanaryTurn(turnId: string, expiresAt: string): void {
  ensureChatCoreV2CanaryTurnLogTable(db);
  db.prepare(
    `INSERT INTO chat_v2_canary_turn_log
       (tenant_id, user_id, turn_id, route_path, route_method, reasoning_tier, confidence, locale, recorded_at, expires_at)
     VALUES ('tenant-1', 'user-1', ?, '/api/v1/chat', 'POST', 'fast', 0.9, 'en', ?, ?)`,
  ).run(turnId, isoDaysAgo(1), expiresAt);
}

function insertEvalSample(id: string, createdAt: string): void {
  ensureChatCoreV2OnlineEvalTables(db);
  db.prepare(
    `INSERT INTO chat_v2_online_eval_samples
       (sample_id, turn_id, tenant_id, user_id, route_method, risk, sensitivity, reason, status, created_at)
     VALUES (?, 'turn-1', 'tenant-1', 'user-1', 'deterministic_read', 'low', 'normal', 'reservoir', 'sampled', ?)`,
  ).run(id, createdAt);
}

function ensureAutoRevertTable(): void {
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
}
function insertAutoRevertDecision(tenantId: string, decidedAt: string): void {
  ensureAutoRevertTable();
  db.prepare(
    `INSERT INTO chat_v2_auto_revert_decisions (tenant_id, decided_at) VALUES (?, ?)`,
  ).run(tenantId, decidedAt);
}

function insertMemoryItem(id: string, expiresAt: string | null): void {
  ensureChatCoreV2MemoryTables(db);
  db.prepare(
    `INSERT INTO chat_v2_memory_items
       (memory_id, user_id, tenant_id, type, value, confidence, sensitivity, status, created_at, updated_at, expires_at)
     VALUES (?, 'user-1', 'tenant-1', 'user_preference', 'v', 0.9, 'normal', 'active', ?, ?, ?)`,
  ).run(id, isoDaysAgo(400), isoDaysAgo(400), expiresAt);
}

function insertHumanReview(
  id: string,
  status: string,
  decidedAt: string | null,
  requestedAt: string,
): void {
  ensureChatCoreV2HumanReviewTables(db);
  db.prepare(
    `INSERT INTO chat_v2_human_reviews
       (review_id, turn_id, tenant_id, user_id, domain, reason, status, sensitivity, redacted_summary, requested_at, decided_at)
     VALUES (?, 'turn-1', 'tenant-1', 'user-1', 'finance', 'restricted_finance', ?, 'financial', 'redacted', ?, ?)`,
  ).run(id, status, requestedAt, decidedAt);
}

function countTrace(): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM chat_v2_trace_spans').get() as { c: number }).c;
}

beforeEach(() => {
  db = new Database(':memory:');
});

afterEach(() => {
  db.close();
});

describe('Chat Core v2 shadow data-retention sweep', () => {
  describe('replay bundles (expires_at)', () => {
    it('deletes rows whose expires_at is in the past and keeps future-expiry rows', () => {
      insertReplayBundle('past', isoDaysAgo(1));
      insertReplayBundle('future', isoDaysFromNow(1));
      runChatCoreV2ShadowDataRetention(db, NOW);
      const ids = (db.prepare('SELECT replay_bundle_id AS id FROM chat_v2_replay_bundles').all() as Array<{ id: string }>).map((r) => r.id);
      expect(ids).toEqual(['future']);
    });

    it('NEVER deletes a row whose expires_at is NULL', () => {
      insertReplayBundle('null-expiry', null);
      insertReplayBundle('past', isoDaysAgo(5));
      runChatCoreV2ShadowDataRetention(db, NOW);
      const ids = (db.prepare('SELECT replay_bundle_id AS id FROM chat_v2_replay_bundles').all() as Array<{ id: string }>).map((r) => r.id);
      expect(ids).toEqual(['null-expiry']);
    });
  });

  describe('canary turn log (WP-08b, expires_at)', () => {
    it('deletes rows whose expires_at is in the past and keeps future-expiry rows', () => {
      insertCanaryTurn('past', isoDaysAgo(1));
      insertCanaryTurn('future', isoDaysFromNow(1));
      runChatCoreV2ShadowDataRetention(db, NOW);
      const ids = (db.prepare('SELECT turn_id AS id FROM chat_v2_canary_turn_log ORDER BY turn_id').all() as Array<{ id: string }>).map((r) => r.id);
      expect(ids).toEqual(['future']);
    });

    it('keeps a future-expiry row untouched (boundary just past now stays)', () => {
      // migration 178 declares expires_at NOT NULL, so a NULL-expiry row is not
      // representable here. The stanza's `expires_at IS NOT NULL` guard is
      // harmless defence-in-depth that mirrors the replay-bundle stanza; this
      // case proves a barely-future row survives.
      insertCanaryTurn('barely-future', isoDaysFromNow(0.001));
      runChatCoreV2ShadowDataRetention(db, NOW);
      const ids = (db.prepare('SELECT turn_id AS id FROM chat_v2_canary_turn_log').all() as Array<{ id: string }>).map((r) => r.id);
      expect(ids).toEqual(['barely-future']);
    });

    it('reports the deleted count for the canary stanza', () => {
      insertCanaryTurn('past-1', isoDaysAgo(1));
      insertCanaryTurn('past-2', isoDaysAgo(2));
      insertCanaryTurn('future', isoDaysFromNow(1));
      const result = runChatCoreV2ShadowDataRetention(db, NOW);
      expect(result.chat_v2_canary_turn_log).toBe(2);
    });
  });

  describe('trace spans (expires_at + legal_required sentinel)', () => {
    it('deletes a past-expiry trace span and keeps a future-expiry one', () => {
      ensureChatCoreV2TraceTables(db);
      recordChatV2TraceSpan(baseSpan({ traceSpanId: 'old', retentionPolicy: '30d', startedAt: isoDaysAgo(40) }), db);
      recordChatV2TraceSpan(baseSpan({ traceSpanId: 'fresh', retentionPolicy: '30d', startedAt: isoDaysAgo(1) }), db);
      runChatCoreV2ShadowDataRetention(db, NOW);
      expect(getChatV2TraceSpanById('old', db)).toBeNull();
      expect(getChatV2TraceSpanById('fresh', db)).not.toBeNull();
    });

    it('ALWAYS keeps a legal_required trace span (compliance sentinel)', () => {
      ensureChatCoreV2TraceTables(db);
      // legal_required => expires_at is NULL on write, so it can never expire.
      recordChatV2TraceSpan(baseSpan({ traceSpanId: 'legal', retentionPolicy: 'legal_required', startedAt: isoDaysAgo(5000) }), db);
      runChatCoreV2ShadowDataRetention(db, NOW);
      expect(getChatV2TraceSpanById('legal', db)).not.toBeNull();
    });

    it('keeps a legal_required span even if it somehow carries a past expires_at (defence-in-depth guard)', () => {
      ensureChatCoreV2TraceTables(db);
      recordChatV2TraceSpan(baseSpan({ traceSpanId: 'legal-forced', retentionPolicy: 'legal_required', startedAt: isoDaysAgo(5000) }), db);
      // Force a past expires_at to prove the retention_policy guard, not just the NULL, protects it.
      db.prepare('UPDATE chat_v2_trace_spans SET expires_at = ? WHERE trace_span_id = ?').run(isoDaysAgo(10), 'legal-forced');
      runChatCoreV2ShadowDataRetention(db, NOW);
      expect(getChatV2TraceSpanById('legal-forced', db)).not.toBeNull();
    });

    it('never deletes a trace span whose expires_at is NULL', () => {
      ensureChatCoreV2TraceTables(db);
      recordChatV2TraceSpan(baseSpan({ traceSpanId: '90d-fresh', retentionPolicy: '90d', startedAt: isoDaysAgo(1) }), db);
      // Null out the expiry to assert the NULL-never-deleted invariant directly.
      db.prepare('UPDATE chat_v2_trace_spans SET expires_at = NULL WHERE trace_span_id = ?').run('90d-fresh');
      runChatCoreV2ShadowDataRetention(db, NOW);
      expect(getChatV2TraceSpanById('90d-fresh', db)).not.toBeNull();
    });
  });

  describe('online eval samples (90-day boundary)', () => {
    it('keeps a row just inside 90 days and deletes one just outside', () => {
      insertEvalSample('inside', isoDaysAgo(89));
      insertEvalSample('outside', isoDaysAgo(91));
      runChatCoreV2ShadowDataRetention(db, NOW);
      const ids = (db.prepare('SELECT sample_id AS id FROM chat_v2_online_eval_samples').all() as Array<{ id: string }>).map((r) => r.id);
      expect(ids).toEqual(['inside']);
    });
  });

  describe('auto-revert decisions (365-day boundary)', () => {
    it('keeps a decision just inside 365 days and deletes one just outside', () => {
      insertAutoRevertDecision('tenant-1', isoDaysAgo(364));
      insertAutoRevertDecision('tenant-1', isoDaysAgo(366));
      runChatCoreV2ShadowDataRetention(db, NOW);
      const count = (db.prepare('SELECT COUNT(*) AS c FROM chat_v2_auto_revert_decisions').get() as { c: number }).c;
      expect(count).toBe(1);
    });
  });

  describe('memory items (expiry column)', () => {
    it('deletes expired memory rows and keeps unexpired + NULL-expiry rows', () => {
      insertMemoryItem('expired', isoDaysAgo(1));
      insertMemoryItem('future', isoDaysFromNow(1));
      insertMemoryItem('never', null);
      runChatCoreV2ShadowDataRetention(db, NOW);
      const ids = (db.prepare('SELECT memory_id AS id FROM chat_v2_memory_items ORDER BY memory_id').all() as Array<{ id: string }>).map((r) => r.id);
      expect(ids).toEqual(['future', 'never']);
    });
  });

  describe('human reviews (resolved/expired >90d)', () => {
    it('deletes resolved/expired reviews older than 90d but keeps pending and recent ones', () => {
      insertHumanReview('old-approved', 'approved', isoDaysAgo(91), isoDaysAgo(120));
      insertHumanReview('old-expired', 'expired', null, isoDaysAgo(120));
      insertHumanReview('recent-denied', 'denied', isoDaysAgo(10), isoDaysAgo(20));
      insertHumanReview('old-pending', 'pending', null, isoDaysAgo(200));
      runChatCoreV2ShadowDataRetention(db, NOW);
      const ids = (db.prepare('SELECT review_id AS id FROM chat_v2_human_reviews ORDER BY review_id').all() as Array<{ id: string }>).map((r) => r.id);
      // old-pending survives (never sweep an open governance item); recent-denied
      // survives (inside 90d); the two old resolved/expired rows are gone.
      expect(ids).toEqual(['old-pending', 'recent-denied']);
    });
  });

  describe('independent-table-failure isolation', () => {
    it('runs every other stanza even when one table is missing', () => {
      // Create ONLY the trace table (+ a past-expiry row). Every other table is
      // absent, so its stanza must WARN-skip without aborting the trace sweep.
      ensureChatCoreV2TraceTables(db);
      recordChatV2TraceSpan(baseSpan({ traceSpanId: 'old', retentionPolicy: '30d', startedAt: isoDaysAgo(40) }), db);
      expect(() => runChatCoreV2ShadowDataRetention(db, NOW)).not.toThrow();
      // The trace stanza still ran and deleted the expired row despite all the
      // other tables being missing.
      expect(getChatV2TraceSpanById('old', db)).toBeNull();
      expect(countTrace()).toBe(0);
    });

    it('returns a per-table count map only for tables that succeeded', () => {
      ensureChatCoreV2TraceTables(db);
      insertEvalSample('outside', isoDaysAgo(91));
      const result = runChatCoreV2ShadowDataRetention(db, NOW);
      // trace + eval tables exist (count entries present); the missing tables
      // are absent from the map because their stanza threw and was skipped.
      expect(result).toHaveProperty('chat_v2_trace_spans');
      expect(result).toHaveProperty('chat_v2_online_eval_samples');
      expect(result.chat_v2_online_eval_samples).toBe(1);
      expect(result).not.toHaveProperty('chat_v2_memory_items');
    });
  });

  describe('recordChatV2TraceSpan populates expires_at from retention_policy', () => {
    it('sets expires_at = startedAt + window for 30d/90d/1y and leaves legal_required NULL', () => {
      ensureChatCoreV2TraceTables(db);
      recordChatV2TraceSpan(baseSpan({ traceSpanId: 's30', retentionPolicy: '30d', startedAt: NOW }), db);
      recordChatV2TraceSpan(baseSpan({ traceSpanId: 's90', retentionPolicy: '90d', startedAt: NOW }), db);
      recordChatV2TraceSpan(baseSpan({ traceSpanId: 's1y', retentionPolicy: '1y', startedAt: NOW }), db);
      recordChatV2TraceSpan(baseSpan({ traceSpanId: 'sleg', retentionPolicy: 'legal_required', startedAt: NOW }), db);

      expect(getChatV2TraceSpanById('s30', db)?.expiresAt).toBe(isoDaysFromNow(30));
      expect(getChatV2TraceSpanById('s90', db)?.expiresAt).toBe(isoDaysFromNow(90));
      expect(getChatV2TraceSpanById('s1y', db)?.expiresAt).toBe(isoDaysFromNow(365));
      expect(getChatV2TraceSpanById('sleg', db)?.expiresAt).toBeUndefined();
    });

    it('resolveTraceSpanExpiresAt returns null for legal_required and a dated value otherwise', () => {
      expect(resolveTraceSpanExpiresAt(NOW, 'legal_required')).toBeNull();
      expect(resolveTraceSpanExpiresAt(NOW, '30d')).toBe(isoDaysFromNow(30));
      expect(resolveTraceSpanExpiresAt(NOW, '90d')).toBe(isoDaysFromNow(90));
      expect(resolveTraceSpanExpiresAt(NOW, '1y')).toBe(isoDaysFromNow(365));
    });
  });
});
