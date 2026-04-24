// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from './database';
import { logger } from '../utils/logger';

export type OperatorAlertSeverity = 'info' | 'warning' | 'critical';
export type OperatorAlertStatus = 'open' | 'acknowledged' | 'resolved';

export interface OperatorAlert {
  id: number;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  status: OperatorAlertStatus;
  severity: OperatorAlertSeverity;
  source: string;
  dedupeKey: string;
  title: string;
  detail: string | null;
  metadata: Record<string, unknown> | null;
  occurrenceCount: number;
}

export interface RecordOperatorAlertInput {
  severity: OperatorAlertSeverity;
  source: string;
  dedupeKey: string;
  title: string;
  detail?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface RecordOperatorAlertResult {
  ok: boolean;
  action?: 'created' | 'updated';
  alert?: OperatorAlert;
  reason?: 'validation_failed' | 'persist_failed';
}

const MAX_SOURCE_LENGTH = 80;
const MAX_DEDUPE_LENGTH = 180;
const MAX_TITLE_LENGTH = 180;
const MAX_DETAIL_LENGTH = 1000;
const MAX_ACTOR_LENGTH = 160;
const MAX_METADATA_LENGTH = 4000;

function sanitizeText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function isSeverity(value: unknown): value is OperatorAlertSeverity {
  return value === 'info' || value === 'warning' || value === 'critical';
}

function isStatus(value: unknown): value is OperatorAlertStatus {
  return value === 'open' || value === 'acknowledged' || value === 'resolved';
}

function encodeMetadata(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  try {
    const json = JSON.stringify(metadata);
    return json.length <= MAX_METADATA_LENGTH ? json : json.slice(0, MAX_METADATA_LENGTH);
  } catch {
    return JSON.stringify({ serializationError: true });
  }
}

function decodeMetadata(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return { parseError: true };
  }
}

function mapAlert(row: any): OperatorAlert {
  return {
    id: Number(row.id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastSeenAt: String(row.last_seen_at),
    acknowledgedAt: row.acknowledged_at ?? null,
    acknowledgedBy: row.acknowledged_by ?? null,
    status: row.status as OperatorAlertStatus,
    severity: row.severity as OperatorAlertSeverity,
    source: String(row.source),
    dedupeKey: String(row.dedupe_key),
    title: String(row.title),
    detail: row.detail ?? null,
    metadata: decodeMetadata(row.metadata_json ?? null),
    occurrenceCount: Number(row.occurrence_count ?? 1),
  };
}

function getOpenAlertByDedupeKey(dedupeKey: string): OperatorAlert | null {
  const row = getDb().prepare(`
    SELECT *
    FROM operator_alerts
    WHERE dedupe_key = ? AND status = 'open'
    LIMIT 1
  `).get(dedupeKey);
  return row ? mapAlert(row) : null;
}

export function recordOperatorAlert(input: RecordOperatorAlertInput): RecordOperatorAlertResult {
  const severity = input.severity;
  const source = sanitizeText(input.source, MAX_SOURCE_LENGTH);
  const dedupeKey = sanitizeText(input.dedupeKey, MAX_DEDUPE_LENGTH);
  const title = sanitizeText(input.title, MAX_TITLE_LENGTH);
  const detail = input.detail ? sanitizeText(input.detail, MAX_DETAIL_LENGTH) : null;
  const metadataJson = encodeMetadata(input.metadata ?? null);

  if (!isSeverity(severity) || !source || !dedupeKey || !title) {
    return { ok: false, reason: 'validation_failed' };
  }

  try {
    const update = getDb().prepare(`
      UPDATE operator_alerts
      SET
        severity = ?,
        title = ?,
        detail = ?,
        metadata_json = ?,
        occurrence_count = occurrence_count + 1,
        last_seen_at = datetime('now'),
        updated_at = datetime('now')
      WHERE dedupe_key = ? AND status = 'open'
    `).run(severity, title, detail, metadataJson, dedupeKey);

    if (update.changes > 0) {
      return {
        ok: true,
        action: 'updated',
        alert: getOpenAlertByDedupeKey(dedupeKey) ?? undefined,
      };
    }

    const insert = getDb().prepare(`
      INSERT INTO operator_alerts (
        severity,
        source,
        dedupe_key,
        title,
        detail,
        metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(severity, source, dedupeKey, title, detail, metadataJson);

    const row = getDb().prepare('SELECT * FROM operator_alerts WHERE id = ?').get(insert.lastInsertRowid);
    return {
      ok: true,
      action: 'created',
      alert: row ? mapAlert(row) : undefined,
    };
  } catch (err) {
    logger.warn({ err, source, dedupeKey }, 'Failed to record operator alert');
    return { ok: false, reason: 'persist_failed' };
  }
}

export function listOperatorAlerts(options: {
  status?: OperatorAlertStatus | 'all';
  limit?: number;
} = {}): OperatorAlert[] {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 50)));
  const status = options.status ?? 'open';

  try {
    if (status === 'all') {
      const rows = getDb().prepare(`
        SELECT *
        FROM operator_alerts
        ORDER BY created_at DESC
        LIMIT ?
      `).all(limit);
      return rows.map(mapAlert);
    }
    if (!isStatus(status)) return [];
    const rows = getDb().prepare(`
      SELECT *
      FROM operator_alerts
      WHERE status = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(status, limit);
    return rows.map(mapAlert);
  } catch (err) {
    logger.warn({ err, status }, 'Failed to list operator alerts');
    return [];
  }
}

export function acknowledgeOperatorAlert(id: number, actorHint?: string | null): boolean {
  if (!Number.isInteger(id) || id <= 0) return false;
  const actor = actorHint ? sanitizeText(actorHint, MAX_ACTOR_LENGTH) || null : null;
  try {
    const result = getDb().prepare(`
      UPDATE operator_alerts
      SET
        status = 'acknowledged',
        acknowledged_at = datetime('now'),
        acknowledged_by = ?,
        updated_at = datetime('now')
      WHERE id = ? AND status = 'open'
    `).run(actor, id);
    return result.changes > 0;
  } catch (err) {
    logger.warn({ err, id }, 'Failed to acknowledge operator alert');
    return false;
  }
}

export function resolveOperatorAlert(id: number, actorHint?: string | null): boolean {
  if (!Number.isInteger(id) || id <= 0) return false;
  const actor = actorHint ? sanitizeText(actorHint, MAX_ACTOR_LENGTH) || null : null;
  try {
    const result = getDb().prepare(`
      UPDATE operator_alerts
      SET
        status = 'resolved',
        acknowledged_at = COALESCE(acknowledged_at, datetime('now')),
        acknowledged_by = COALESCE(acknowledged_by, ?),
        updated_at = datetime('now')
      WHERE id = ? AND status IN ('open', 'acknowledged')
    `).run(actor, id);
    return result.changes > 0;
  } catch (err) {
    logger.warn({ err, id }, 'Failed to resolve operator alert');
    return false;
  }
}
