// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from './database';
import { logger } from '../utils/logger';
import { pushEvent } from '../portal/telemetry';

export type OperatorAlertSeverity = 'info' | 'warning' | 'critical';
export type OperatorAlertStatus = 'open' | 'acknowledged' | 'resolved';
export type OperatorAlertDeliveryStatus = 'pending' | 'delivered' | 'failed' | 'dead_letter' | 'not_configured';

export interface OperatorAlert {
  id: number;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  status: OperatorAlertStatus;
  deliveryStatus: OperatorAlertDeliveryStatus;
  deliveredAt: string | null;
  lastDeliveryAttemptAt: string | null;
  nextDeliveryAttemptAt: string | null;
  deliveryAttemptCount: number;
  lastDeliveryError: string | null;
  deadLetteredAt: string | null;
  severity: OperatorAlertSeverity;
  source: string;
  dedupeKey: string;
  title: string;
  detail: string | null;
  metadata: Record<string, unknown> | null;
  occurrenceCount: number;
  owner: string;
  suspectedArea: string;
  userImpact: string;
  runbookUrl: string;
}

export interface RecordOperatorAlertInput {
  severity: OperatorAlertSeverity;
  source: string;
  dedupeKey: string;
  title: string;
  detail?: string | null;
  metadata?: Record<string, unknown> | null;
  owner?: string | null;
  suspectedArea?: string | null;
  userImpact?: string | null;
  runbookUrl?: string | null;
}

export interface RecordOperatorAlertResult {
  ok: boolean;
  action?: 'created' | 'updated';
  alert?: OperatorAlert;
  reason?: 'validation_failed' | 'persist_failed';
}

export interface DeliverOperatorAlertResult {
  ok: boolean;
  status: OperatorAlertDeliveryStatus;
  alert?: OperatorAlert;
  reason?: 'not_found' | 'not_due' | 'not_configured' | 'delivery_failed' | 'persist_failed';
  nextAttemptAt?: string | null;
}

export type OperatorAlertDeliverySender = (alert: OperatorAlert) => Promise<{
  ok: boolean;
  statusCode?: number;
  detail?: string;
}>;

const MAX_SOURCE_LENGTH = 80;
const MAX_DEDUPE_LENGTH = 180;
const MAX_TITLE_LENGTH = 180;
const MAX_DETAIL_LENGTH = 1000;
const MAX_ACTOR_LENGTH = 160;
const MAX_METADATA_LENGTH = 4000;
const MAX_OWNER_LENGTH = 80;
const MAX_AREA_LENGTH = 120;
const MAX_IMPACT_LENGTH = 240;
const MAX_RUNBOOK_LENGTH = 500;
const MAX_DELIVERY_ERROR_LENGTH = 500;
const DEFAULT_RUNBOOK_URL = 'docs/OBSERVABILITY-ONCALL.md';
const DEFAULT_OWNER = 'ops';
const DEFAULT_MAX_DELIVERY_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 60_000;
const DEFAULT_DELIVERY_TIMEOUT_MS = 5_000;

let deliverySenderOverride: OperatorAlertDeliverySender | null = null;
let deliveryConfigOverride: {
  maxAttempts?: number;
  retryBaseMs?: number;
  timeoutMs?: number;
} | null = null;

function sanitizeText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .replace(/\b(access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|cookie|secret|password|api[_-]?key)=?[A-Za-z0-9._~+/=-]+/gi, '$1=[redacted]')
    .replace(/\b(sk-[A-Za-z0-9._-]{12,}|ya29\.[A-Za-z0-9._-]{12,})\b/g, '[token]');
}

function sanitizeAlertText(value: unknown, maxLength: number): string {
  return redactSensitiveText(sanitizeText(value, maxLength));
}

function isSeverity(value: unknown): value is OperatorAlertSeverity {
  return value === 'info' || value === 'warning' || value === 'critical';
}

function isStatus(value: unknown): value is OperatorAlertStatus {
  return value === 'open' || value === 'acknowledged' || value === 'resolved';
}

function isDeliveryStatus(value: unknown): value is OperatorAlertDeliveryStatus {
  return value === 'pending'
    || value === 'delivered'
    || value === 'failed'
    || value === 'dead_letter'
    || value === 'not_configured';
}

function toSqlUtc(date = new Date()): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function parseSqlUtc(value: string): number {
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  return new Date(normalized).getTime();
}

function getPositiveIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getMaxDeliveryAttempts(): number {
  return Math.max(1, deliveryConfigOverride?.maxAttempts ?? getPositiveIntEnv('OPERATOR_ALERT_MAX_DELIVERY_ATTEMPTS', DEFAULT_MAX_DELIVERY_ATTEMPTS));
}

function getRetryBaseMs(): number {
  return Math.max(1, deliveryConfigOverride?.retryBaseMs ?? getPositiveIntEnv('OPERATOR_ALERT_RETRY_BASE_MS', DEFAULT_RETRY_BASE_MS));
}

function getDeliveryTimeoutMs(): number {
  return Math.max(1, deliveryConfigOverride?.timeoutMs ?? getPositiveIntEnv('OPERATOR_ALERT_WEBHOOK_TIMEOUT_MS', DEFAULT_DELIVERY_TIMEOUT_MS));
}

function normalizeRunbookUrl(value: unknown): string {
  return sanitizeText(value, MAX_RUNBOOK_LENGTH) || sanitizeText(process.env.OPERATOR_ALERT_DEFAULT_RUNBOOK_URL, MAX_RUNBOOK_LENGTH) || DEFAULT_RUNBOOK_URL;
}

function defaultSuspectedArea(source: string): string {
  return source.replace(/[^a-zA-Z0-9_.:-]+/g, '_').slice(0, MAX_AREA_LENGTH) || 'unknown';
}

const SENSITIVE_METADATA_KEY = /(token|secret|password|credential|authorization|cookie|email|message|body|payload|health|amount|price|vendor|invoice|receipt|fiscal|access[_-]?key|refresh)/i;

function sanitizeMetadataValue(value: unknown, key = '', depth = 0): unknown {
  if (SENSITIVE_METADATA_KEY.test(key)) return '[redacted]';
  if (value == null) return value;
  if (typeof value === 'string') {
    return sanitizeAlertText(value, 300);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    if (depth >= 2) return `[array:${value.length}]`;
    return value.slice(0, 20).map((entry) => sanitizeMetadataValue(entry, key, depth + 1));
  }
  if (typeof value === 'object') {
    if (depth >= 2) return '[object]';
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      out[sanitizeText(childKey, 80) || 'field'] = sanitizeMetadataValue(childValue, childKey, depth + 1);
    }
    return out;
  }
  return String(value);
}

function sanitizeMetadata(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!metadata || typeof metadata !== 'object') return null;
  return sanitizeMetadataValue(metadata) as Record<string, unknown>;
}

function encodeMetadata(metadata: Record<string, unknown> | null | undefined): string | null {
  const sanitized = sanitizeMetadata(metadata);
  if (!sanitized) return null;
  try {
    const json = JSON.stringify(sanitized);
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
  const deliveryStatus = isDeliveryStatus(row.delivery_status) ? row.delivery_status : 'pending';
  const source = String(row.source);
  return {
    id: Number(row.id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastSeenAt: String(row.last_seen_at),
    acknowledgedAt: row.acknowledged_at ?? null,
    acknowledgedBy: row.acknowledged_by ?? null,
    status: row.status as OperatorAlertStatus,
    deliveryStatus,
    deliveredAt: row.delivered_at ?? null,
    lastDeliveryAttemptAt: row.last_delivery_attempt_at ?? null,
    nextDeliveryAttemptAt: row.next_delivery_attempt_at ?? null,
    deliveryAttemptCount: Number(row.delivery_attempt_count ?? 0),
    lastDeliveryError: row.last_delivery_error ?? null,
    deadLetteredAt: row.dead_lettered_at ?? null,
    severity: row.severity as OperatorAlertSeverity,
    source,
    dedupeKey: String(row.dedupe_key),
    title: String(row.title),
    detail: row.detail ?? null,
    metadata: decodeMetadata(row.metadata_json ?? null),
    occurrenceCount: Number(row.occurrence_count ?? 1),
    owner: sanitizeText(row.owner, MAX_OWNER_LENGTH) || DEFAULT_OWNER,
    suspectedArea: sanitizeText(row.suspected_area, MAX_AREA_LENGTH) || defaultSuspectedArea(source),
    userImpact: sanitizeText(row.user_impact, MAX_IMPACT_LENGTH) || 'unknown',
    runbookUrl: sanitizeText(row.runbook_url, MAX_RUNBOOK_LENGTH) || DEFAULT_RUNBOOK_URL,
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
  const detail = input.detail ? sanitizeAlertText(input.detail, MAX_DETAIL_LENGTH) : null;
  const metadataJson = encodeMetadata(input.metadata ?? null);
  const owner = sanitizeText(input.owner, MAX_OWNER_LENGTH) || DEFAULT_OWNER;
  const suspectedArea = sanitizeText(input.suspectedArea, MAX_AREA_LENGTH) || defaultSuspectedArea(source);
  const userImpact = sanitizeText(input.userImpact, MAX_IMPACT_LENGTH) || title;
  const runbookUrl = normalizeRunbookUrl(input.runbookUrl);

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
        owner = ?,
        suspected_area = ?,
        user_impact = ?,
        runbook_url = ?,
        delivery_status = CASE WHEN delivery_status = 'dead_letter' THEN 'pending' ELSE delivery_status END,
        next_delivery_attempt_at = CASE WHEN delivery_status = 'dead_letter' THEN datetime('now') ELSE next_delivery_attempt_at END,
        dead_lettered_at = CASE WHEN delivery_status = 'dead_letter' THEN NULL ELSE dead_lettered_at END,
        occurrence_count = occurrence_count + 1,
        last_seen_at = datetime('now'),
        updated_at = datetime('now')
      WHERE dedupe_key = ? AND status = 'open'
    `).run(severity, title, detail, metadataJson, owner, suspectedArea, userImpact, runbookUrl, dedupeKey);

    if (update.changes > 0) {
      const alert = getOpenAlertByDedupeKey(dedupeKey) ?? undefined;
      if (alert) {
        logger.warn(
          {
            alertId: alert.id,
            severity: alert.severity,
            source: alert.source,
            dedupeKey: alert.dedupeKey,
            occurrenceCount: alert.occurrenceCount,
            deliveryStatus: alert.deliveryStatus,
          },
          'Operator alert updated',
        );
      }
      return {
        ok: true,
        action: 'updated',
        alert,
      };
    }

    const insert = getDb().prepare(`
      INSERT INTO operator_alerts (
        severity,
        source,
        dedupe_key,
        title,
        detail,
        metadata_json,
        owner,
        suspected_area,
        user_impact,
        runbook_url
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(severity, source, dedupeKey, title, detail, metadataJson, owner, suspectedArea, userImpact, runbookUrl);

    const row = getDb().prepare('SELECT * FROM operator_alerts WHERE id = ?').get(insert.lastInsertRowid);
    const alert = row ? mapAlert(row) : undefined;
    if (alert) {
      logger.warn(
        {
          alertId: alert.id,
          severity: alert.severity,
          source: alert.source,
          dedupeKey: alert.dedupeKey,
          owner: alert.owner,
          suspectedArea: alert.suspectedArea,
          deliveryStatus: alert.deliveryStatus,
        },
        'Operator alert created',
      );
      pushEvent({
        ts: new Date().toISOString(),
        type: 'error',
        summary: `Operator alert: ${alert.title}`,
        detail: `${alert.severity} · ${alert.source} · ${alert.userImpact}`,
      });
    }
    return {
      ok: true,
      action: 'created',
      alert,
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

export function retryOperatorAlertDelivery(id: number): boolean {
  if (!Number.isInteger(id) || id <= 0) return false;
  try {
    const result = getDb().prepare(`
      UPDATE operator_alerts
      SET
        delivery_status = 'pending',
        next_delivery_attempt_at = datetime('now'),
        last_delivery_error = NULL,
        dead_lettered_at = NULL,
        updated_at = datetime('now')
      WHERE id = ?
        AND status IN ('open', 'acknowledged')
        AND delivery_status IN ('failed', 'dead_letter', 'not_configured')
    `).run(id);
    return result.changes > 0;
  } catch (err) {
    logger.warn({ err, id }, 'Failed to retry operator alert delivery');
    return false;
  }
}

function getAlertById(id: number): OperatorAlert | null {
  const row = getDb().prepare('SELECT * FROM operator_alerts WHERE id = ?').get(id);
  return row ? mapAlert(row) : null;
}

function getDefaultDeliverySender(): OperatorAlertDeliverySender | null {
  const url = sanitizeText(process.env.OPERATOR_ALERT_WEBHOOK_URL, 1000);
  if (!url) return null;
  return async (alert: OperatorAlert) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), getDeliveryTimeoutMs());
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'nexushub-operator-alerts/1',
      };
      const token = process.env.OPERATOR_ALERT_WEBHOOK_TOKEN;
      if (token) headers.Authorization = `Bearer ${token}`;

      const response = await fetch(url, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          id: alert.id,
          createdAt: alert.createdAt,
          severity: alert.severity,
          source: alert.source,
          title: alert.title,
          detail: alert.detail,
          owner: alert.owner,
          suspectedArea: alert.suspectedArea,
          userImpact: alert.userImpact,
          runbookUrl: alert.runbookUrl,
          occurrenceCount: alert.occurrenceCount,
          metadata: alert.metadata,
        }),
      });
      return {
        ok: response.ok,
        statusCode: response.status,
        detail: response.ok ? 'delivered' : `HTTP ${response.status}`,
      };
    } catch (err: any) {
      return {
        ok: false,
        detail: err?.name === 'AbortError' ? 'delivery timeout' : (err?.message ?? String(err)),
      };
    } finally {
      clearTimeout(timeout);
    }
  };
}

function scheduleNextAttempt(attemptCount: number): string | null {
  if (attemptCount >= getMaxDeliveryAttempts()) return null;
  const delayMs = getRetryBaseMs() * Math.pow(2, Math.max(0, attemptCount - 1));
  return toSqlUtc(new Date(Date.now() + delayMs));
}

export async function deliverOperatorAlert(id: number): Promise<DeliverOperatorAlertResult> {
  if (!Number.isInteger(id) || id <= 0) return { ok: false, status: 'failed', reason: 'not_found' };

  let alert: OperatorAlert | null;
  try {
    alert = getAlertById(id);
  } catch (err) {
    logger.warn({ err, id }, 'Failed to load operator alert for delivery');
    return { ok: false, status: 'failed', reason: 'persist_failed' };
  }

  if (!alert || alert.status === 'resolved') {
    return { ok: false, status: 'failed', reason: 'not_found' };
  }
  if (alert.deliveryStatus === 'delivered' || alert.deliveryStatus === 'dead_letter' || alert.deliveryStatus === 'not_configured') {
    return { ok: alert.deliveryStatus === 'delivered', status: alert.deliveryStatus, alert, reason: 'not_due' };
  }
  if (alert.nextDeliveryAttemptAt && parseSqlUtc(alert.nextDeliveryAttemptAt) > Date.now()) {
    return { ok: false, status: alert.deliveryStatus, alert, reason: 'not_due', nextAttemptAt: alert.nextDeliveryAttemptAt };
  }

  const sender = deliverySenderOverride ?? getDefaultDeliverySender();
  const attemptNumber = alert.deliveryAttemptCount + 1;
  const attemptAt = toSqlUtc();

  if (!sender) {
    try {
      getDb().prepare(`
        UPDATE operator_alerts
        SET
          delivery_status = 'not_configured',
          last_delivery_attempt_at = ?,
          delivery_attempt_count = delivery_attempt_count + 1,
          last_delivery_error = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(attemptAt, 'OPERATOR_ALERT_WEBHOOK_URL not configured', id);
      const updated = getAlertById(id) ?? alert;
      logger.warn(
        { alertId: id, source: alert.source, dedupeKey: alert.dedupeKey },
        'Operator alert delivery not configured',
      );
      return { ok: false, status: 'not_configured', alert: updated, reason: 'not_configured' };
    } catch (err) {
      logger.warn({ err, alertId: id }, 'Failed to mark operator alert delivery as not configured');
      return { ok: false, status: 'failed', alert, reason: 'persist_failed' };
    }
  }

  const result = await sender(alert);
  const safeError = sanitizeAlertText(result.detail ?? 'delivery failed', MAX_DELIVERY_ERROR_LENGTH);

  try {
    if (result.ok) {
      getDb().prepare(`
        UPDATE operator_alerts
        SET
          delivery_status = 'delivered',
          delivered_at = ?,
          last_delivery_attempt_at = ?,
          next_delivery_attempt_at = NULL,
          delivery_attempt_count = delivery_attempt_count + 1,
          last_delivery_error = NULL,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(attemptAt, attemptAt, id);
      const updated = getAlertById(id) ?? alert;
      logger.info(
        { alertId: id, source: alert.source, dedupeKey: alert.dedupeKey, attempt: attemptNumber },
        'Operator alert delivered',
      );
      return { ok: true, status: 'delivered', alert: updated };
    }

    const nextAttemptAt = scheduleNextAttempt(attemptNumber);
    const deliveryStatus: OperatorAlertDeliveryStatus = nextAttemptAt ? 'failed' : 'dead_letter';
    getDb().prepare(`
      UPDATE operator_alerts
      SET
        delivery_status = ?,
        last_delivery_attempt_at = ?,
        next_delivery_attempt_at = ?,
        delivery_attempt_count = delivery_attempt_count + 1,
        last_delivery_error = ?,
        dead_lettered_at = CASE WHEN ? = 'dead_letter' THEN ? ELSE dead_lettered_at END,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(deliveryStatus, attemptAt, nextAttemptAt, safeError, deliveryStatus, deliveryStatus === 'dead_letter' ? attemptAt : null, id);
    const updated = getAlertById(id) ?? alert;
    logger.warn(
      {
        alertId: id,
        source: alert.source,
        dedupeKey: alert.dedupeKey,
        attempt: attemptNumber,
        deliveryStatus,
        nextAttemptAt,
        statusCode: result.statusCode,
      },
      deliveryStatus === 'dead_letter'
        ? 'Operator alert delivery dead-lettered'
        : 'Operator alert delivery failed; retry scheduled',
    );
    pushEvent({
      ts: new Date().toISOString(),
      type: 'error',
      summary: deliveryStatus === 'dead_letter'
        ? `Alert delivery dead-lettered: ${alert.title}`
        : `Alert delivery retry: ${alert.title}`,
      detail: safeError,
    });
    return {
      ok: false,
      status: deliveryStatus,
      alert: updated,
      reason: 'delivery_failed',
      nextAttemptAt,
    };
  } catch (err) {
    logger.warn({ err, alertId: id }, 'Failed to update operator alert delivery state');
    return { ok: false, status: 'failed', alert, reason: 'persist_failed' };
  }
}

export async function processDueOperatorAlertDeliveries(limit = 20): Promise<DeliverOperatorAlertResult[]> {
  const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  let rows: Array<{ id: number }> = [];
  try {
    rows = getDb().prepare(`
      SELECT id
      FROM operator_alerts
      WHERE status IN ('open', 'acknowledged')
        AND delivery_status IN ('pending', 'failed')
        AND (next_delivery_attempt_at IS NULL OR datetime(next_delivery_attempt_at) <= datetime('now'))
      ORDER BY
        CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
        created_at ASC
      LIMIT ?
    `).all(boundedLimit) as Array<{ id: number }>;
  } catch (err) {
    logger.warn({ err }, 'Failed to load due operator alert deliveries');
    return [];
  }

  const results: DeliverOperatorAlertResult[] = [];
  for (const row of rows) {
    results.push(await deliverOperatorAlert(Number(row.id)));
  }
  return results;
}

export function getOperatorAlertDeliverySummary(): Record<OperatorAlertDeliveryStatus, number> {
  const summary: Record<OperatorAlertDeliveryStatus, number> = {
    pending: 0,
    delivered: 0,
    failed: 0,
    dead_letter: 0,
    not_configured: 0,
  };
  try {
    const rows = getDb().prepare(`
      SELECT delivery_status as status, COUNT(*) as count
      FROM operator_alerts
      WHERE status != 'resolved'
      GROUP BY delivery_status
    `).all() as Array<{ status: OperatorAlertDeliveryStatus; count: number }>;
    for (const row of rows) {
      if (isDeliveryStatus(row.status)) summary[row.status] = Number(row.count ?? 0);
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to build operator alert delivery summary');
  }
  return summary;
}

export function _setOperatorAlertDeliverySenderForTests(sender: OperatorAlertDeliverySender | null): void {
  deliverySenderOverride = sender;
}

export function _setOperatorAlertDeliveryConfigForTests(config: {
  maxAttempts?: number;
  retryBaseMs?: number;
  timeoutMs?: number;
} | null): void {
  deliveryConfigOverride = config;
}
