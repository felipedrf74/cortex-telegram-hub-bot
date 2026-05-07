// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * RAMEN-lite REST delta sync.
 *
 * The cursor is the monotonic event_outbox.sequence. The response exposes only
 * app-safe summaries, not raw event payloads. WebSockets/push can wake clients
 * later, but this endpoint remains the durable source for changes.
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from './database';
import { ensureEventOutboxTables, getEventSequenceBounds, listEventsForScope } from './event-outbox';
import { isValidTenantUserId, recordTenantScopeAnomaly } from './tenant-scope-observability';
import { sanitizePrivacyObject } from '../utils/privacy-sanitizer';

export interface DeltaSyncChange {
  changeId: string;
  eventId: string;
  skill: string;
  type: string;
  entityType: string;
  entityId: string;
  entityVersion: number;
  action: 'created' | 'updated' | 'deleted' | 'superseded';
  summary: Record<string, unknown>;
  occurredAt: string;
}

export interface DeltaSyncResponse {
  cursor: string;
  serverTime: string;
  changes: DeltaSyncChange[];
  hasMore: boolean;
  resetRequired: boolean;
  reason?: string;
}

export function ensureDeltaSyncTables(db: Database.Database = getDb()): void {
  ensureEventOutboxTables(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_cursors (
      cursor_id TEXT PRIMARY KEY,
      tenant_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      device_id TEXT NOT NULL,
      cursor_value INTEGER NOT NULL DEFAULT 0,
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, user_id, device_id)
    );
    CREATE INDEX IF NOT EXISTS idx_sync_cursors_scope
      ON sync_cursors(tenant_id, user_id, device_id);
  `);
}

export function listDeltaChanges(input: {
  tenantId: number;
  userId: number;
  since?: string | number | null;
  deviceId?: string | null;
  limit?: number;
  skill?: string | null;
  db?: Database.Database;
}): DeltaSyncResponse {
  const db = input.db ?? getDb();
  assertSyncScope(input.userId, input.tenantId);
  ensureDeltaSyncTables(db);
  const bounds = getEventSequenceBounds(db);
  const parsed = parseCursor(input.since);
  const deviceId = normalizeDeviceId(input.deviceId);
  const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 100), 200));

  if (!parsed.valid) {
    return {
      cursor: String(bounds.max),
      serverTime: new Date().toISOString(),
      changes: [],
      hasMore: false,
      resetRequired: true,
      reason: 'invalid_cursor',
    };
  }

  if (bounds.min > 0 && parsed.value > 0 && parsed.value < bounds.min) {
    return {
      cursor: String(bounds.max),
      serverTime: new Date().toISOString(),
      changes: [],
      hasMore: false,
      resetRequired: true,
      reason: 'cursor_too_old',
    };
  }

  const events = listEventsForScope({
    tenantId: input.tenantId,
    userId: input.userId,
    sinceSequence: parsed.value,
    limit: limit + 1,
    skill: input.skill,
    includeTenantEvents: true,
  }, db);
  const page = events.slice(0, limit);
  const hasMore = events.length > limit;
  const cursor = page.length > 0 ? page[page.length - 1].sequence : parsed.value;
  upsertCursor(db, input.tenantId, input.userId, deviceId, cursor);

  return {
    cursor: String(cursor),
    serverTime: new Date().toISOString(),
    changes: page.map((event) => ({
      changeId: String(event.sequence),
      eventId: event.eventId,
      skill: event.sourceSkill,
      type: event.eventType,
      entityType: event.entityType,
      entityId: event.entityId,
      entityVersion: event.entityVersion,
      action: actionForEvent(event.eventType, event.payload),
      summary: appSafeSummary(event.payload, event.eventType),
      occurredAt: event.createdAt,
    })),
    hasMore,
    resetRequired: false,
  };
}

function upsertCursor(db: Database.Database, tenantId: number, userId: number, deviceId: string, cursor: number): void {
  const cursorId = randomUUID();
  db.prepare(`
    INSERT INTO sync_cursors (cursor_id, tenant_id, user_id, device_id, cursor_value, last_seen_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(tenant_id, user_id, device_id) DO UPDATE SET
      cursor_value = excluded.cursor_value,
      last_seen_at = datetime('now')
  `).run(cursorId, tenantId, userId, deviceId, cursor);
}

function parseCursor(value: string | number | null | undefined): { valid: true; value: number } | { valid: false; value: 0 } {
  if (value == null || value === '') return { valid: true, value: 0 };
  const raw = typeof value === 'number' ? String(value) : value;
  if (!/^\d+$/.test(raw)) return { valid: false, value: 0 };
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return { valid: false, value: 0 };
  return { valid: true, value: parsed };
}

function normalizeDeviceId(value: string | null | undefined): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('deviceId required for delta sync cursor');
  }
  return value.trim().replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 128);
}

function actionForEvent(eventType: string, payload: Record<string, unknown>): DeltaSyncChange['action'] {
  const payloadAction = typeof payload.action === 'string' ? payload.action : '';
  const raw = `${eventType}:${payloadAction}`.toLowerCase();
  if (/delete|deleted|removed|tombstone/.test(raw)) return 'deleted';
  if (/superseded|replaced/.test(raw)) return 'superseded';
  if (/created|logged_in/.test(raw)) return 'created';
  return 'updated';
}

function appSafeSummary(payload: Record<string, unknown>, eventType: string): Record<string, unknown> {
  const summary = payload.summary;
  if (summary && typeof summary === 'object' && !Array.isArray(summary)) {
    return sanitizePrivacyObject(summary as Record<string, unknown>, { maxDepth: 4, maxStringLength: 160 });
  }
  if (typeof summary === 'string') {
    return { text: summary.slice(0, 160) };
  }
  return { text: eventType.replace(/[._]/g, ' ') };
}

function assertSyncScope(userId: number, tenantId: number): void {
  if (isValidTenantUserId(userId) && isValidTenantUserId(tenantId)) return;
  recordTenantScopeAnomaly({
    layer: 'delivery',
    operation: 'delta_sync',
    reason: 'invalid_user_scope',
    userId: typeof userId === 'number' ? userId : null,
  });
  throw new Error('valid userId and tenantId required');
}
