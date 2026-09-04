// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Operate surfaces for the operator portal: queues, runtime flags, provider
 * health history, and notification delivery.
 *
 *   GET  /api/ops/queues                              depth by status for background_jobs + event_outbox
 *   GET  /api/ops/queues/dead-letter?kind=&limit=     cross-tenant dead-letter listing
 *   POST /api/ops/queues/:kind/:id/replay             admin, audited
 *   POST /api/ops/queues/:kind/:id/cancel             admin, audited
 *   GET  /api/ops/flags                               runtime flag catalog readings + DB kill switches
 *   POST /api/ops/flags/kill-switches/:key            admin, audited — engage/release a hybrid kill switch
 *   GET  /api/ops/provider-health-history?provider=&hours=
 *   GET  /api/ops/notification-delivery?hours=&status=&channel=&provider=&limit=   admin
 *
 * Flag readings carry parsed values only (never raw env strings), and env
 * flags stay read-only; the only mutable switches are the DB-backed hybrid
 * kill switches, which reuse the same service the iOS admin route uses.
 */

import type { Express, Request, Response } from 'express';
import { requirePortalAdminToken } from '../api/secret-guards';
import { getDb } from '../services/database';
import { cancelJob, replayJob } from '../services/background-job-queue';
import { cancelEvent, replayEvent } from '../services/event-outbox';
import {
  HYBRID_KILL_SWITCH_KEYS,
  listHybridKillSwitches,
  setHybridKillSwitch,
  type HybridKillSwitchKey,
} from '../services/hybrid-runtime-kill-switches';
import {
  findDeadLetterTenant,
  getQueueSummary,
  isDeadLetterKind,
  listDeadLetterItems,
  parseSqliteTimestamp,
} from '../services/queue-observability';
import { readRuntimeFlagCatalog } from '../services/runtime-flags-catalog';
import { getOwnerBootstrapTarget } from '../services/user-service';
import { logger } from '../utils/logger';
import { logPortalAdminMutation } from './admin-audit';
import { sendPortalInternalError } from './http';

const ID_PATTERN = /^[A-Za-z0-9_:.-]{1,128}$/;
const PROVIDER_PATTERN = /^[a-z0-9_-]{1,40}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const HISTORY_DEFAULT_HOURS = 24;
const HISTORY_MAX_HOURS = 24 * 14;
const HISTORY_ROW_CAP = 20_000;
const DELIVERY_DEFAULT_LIMIT = 100;
const DELIVERY_MAX_LIMIT = 500;
const ERROR_MESSAGE_MAX_CHARS = 200;
const REASON_MAX_CHARS = 500;

function parseBoundedInt(raw: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof raw === 'string' ? Number.parseInt(raw, 10) : typeof raw === 'number' ? raw : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function optionalToken(raw: unknown, pattern: RegExp): string | null {
  return typeof raw === 'string' && raw !== '' && pattern.test(raw) ? raw : null;
}

// ── Provider health history ───────────────────────────────────────────────

export interface ProviderHealthRow {
  ts: string;
  provider: string;
  status: string;
  latency_ms: number | null;
  error_message: string | null;
}

export interface ProviderHealthBucket {
  ts: string;
  probes: number;
  failures: number;
  avgLatencyMs: number | null;
}

export interface ProviderHealthSeries {
  provider: string;
  probes: number;
  failures: number;
  failureRate: number;
  lastStatus: string | null;
  lastTs: string | null;
  lastError: string | null;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  currentStreak: { status: string; count: number } | null;
  buckets: ProviderHealthBucket[];
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
}

/** Groups probe rows (ascending by ts) into per-provider hourly buckets. Pure; exported for tests. */
export function summarizeProviderHealthHistory(rows: ProviderHealthRow[]): ProviderHealthSeries[] {
  const byProvider = new Map<string, ProviderHealthRow[]>();
  for (const row of rows) {
    const list = byProvider.get(row.provider) ?? [];
    list.push(row);
    byProvider.set(row.provider, list);
  }
  const series: ProviderHealthSeries[] = [];
  for (const [provider, probes] of byProvider) {
    const buckets = new Map<string, { probes: number; failures: number; latencySum: number; latencyCount: number }>();
    const latencies: number[] = [];
    let failures = 0;
    for (const probe of probes) {
      const ms = parseSqliteTimestamp(probe.ts);
      const bucketTs = ms == null ? probe.ts : new Date(Math.floor(ms / 3_600_000) * 3_600_000).toISOString();
      const bucket = buckets.get(bucketTs) ?? { probes: 0, failures: 0, latencySum: 0, latencyCount: 0 };
      bucket.probes += 1;
      if (probe.status !== 'ok' && probe.status !== 'skipped') {
        bucket.failures += 1;
        failures += 1;
      }
      if (typeof probe.latency_ms === 'number' && Number.isFinite(probe.latency_ms)) {
        bucket.latencySum += probe.latency_ms;
        bucket.latencyCount += 1;
        latencies.push(probe.latency_ms);
      }
      buckets.set(bucketTs, bucket);
    }
    const last = probes[probes.length - 1];
    let streak: ProviderHealthSeries['currentStreak'] = null;
    if (last) {
      let count = 0;
      for (let i = probes.length - 1; i >= 0 && probes[i].status === last.status; i -= 1) count += 1;
      streak = { status: last.status, count };
    }
    const sortedLatencies = [...latencies].sort((a, b) => a - b);
    const lastError = probes.slice().reverse().find((probe) => probe.error_message)?.error_message ?? null;
    series.push({
      provider,
      probes: probes.length,
      failures,
      failureRate: probes.length === 0 ? 0 : Math.round((failures / probes.length) * 1000) / 1000,
      lastStatus: last?.status ?? null,
      lastTs: last?.ts ?? null,
      lastError: lastError == null ? null : String(lastError).slice(0, ERROR_MESSAGE_MAX_CHARS),
      avgLatencyMs: latencies.length === 0 ? null : Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
      p95LatencyMs: percentile(sortedLatencies, 0.95),
      currentStreak: streak,
      buckets: [...buckets.entries()].map(([ts, bucket]) => ({
        ts,
        probes: bucket.probes,
        failures: bucket.failures,
        avgLatencyMs: bucket.latencyCount === 0 ? null : Math.round(bucket.latencySum / bucket.latencyCount),
      })),
    });
  }
  return series.sort((a, b) => a.provider.localeCompare(b.provider));
}

// ── Notification delivery ─────────────────────────────────────────────────

interface DeliveryFilters {
  hours: number;
  status: string | null;
  channel: string | null;
  provider: string | null;
  limit: number;
}

function parseDeliveryFilters(query: Request['query']): DeliveryFilters {
  return {
    hours: parseBoundedInt(query.hours, HISTORY_DEFAULT_HOURS, 1, HISTORY_MAX_HOURS),
    status: optionalToken(query.status, TOKEN_PATTERN),
    channel: optionalToken(query.channel, TOKEN_PATTERN),
    provider: optionalToken(query.provider, TOKEN_PATTERN),
    limit: parseBoundedInt(query.limit, DELIVERY_DEFAULT_LIMIT, 1, DELIVERY_MAX_LIMIT),
  };
}

function deliveryWhere(filters: DeliveryFilters): { where: string; params: unknown[] } {
  const clauses = ["created_at >= datetime('now', ?)"];
  const params: unknown[] = [`-${filters.hours} hours`];
  if (filters.status) { clauses.push('status = ?'); params.push(filters.status); }
  if (filters.channel) { clauses.push('channel = ?'); params.push(filters.channel); }
  if (filters.provider) { clauses.push('provider = ?'); params.push(filters.provider); }
  return { where: `WHERE ${clauses.join(' AND ')}`, params };
}

function countBy(column: string, where: string, params: unknown[], limit = 10): Record<string, number> {
  const rows = getDb().prepare(`
    SELECT ${column} AS k, COUNT(*) AS c FROM notification_delivery_attempts ${where}
    GROUP BY ${column} ORDER BY c DESC LIMIT ?
  `).all(...params, limit) as { k: string | null; c: number }[];
  const out: Record<string, number> = {};
  for (const row of rows) out[row.k == null ? '(none)' : String(row.k)] = Number(row.c) || 0;
  return out;
}

// ── Routes ────────────────────────────────────────────────────────────────

export function registerPortalOperateRoutes(app: Express): void {
  app.get('/api/ops/queues', (_req: Request, res: Response) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ok: true, ...getQueueSummary() });
    } catch (err) {
      sendPortalInternalError(res, err, 'Failed to load queue summary', 'Portal: queue summary failed');
    }
  });

  app.get('/api/ops/queues/dead-letter', (req: Request, res: Response) => {
    try {
      const kind = req.query.kind ?? 'jobs';
      if (!isDeadLetterKind(kind)) {
        res.status(400).json({ ok: false, message: 'kind must be jobs or events' });
        return;
      }
      const limit = parseBoundedInt(req.query.limit, 50, 1, 200);
      res.json({ ok: true, kind, items: listDeadLetterItems({ kind, limit }) });
    } catch (err) {
      sendPortalInternalError(res, err, 'Failed to load dead-letter items', 'Portal: dead-letter list failed');
    }
  });

  const deadLetterAction = (action: 'replay' | 'cancel') => (req: Request, res: Response) => {
    try {
      const kind = req.params.kind;
      const id = req.params.id;
      if (!isDeadLetterKind(kind) || typeof id !== 'string' || !ID_PATTERN.test(id)) {
        res.status(400).json({ ok: false, message: 'invalid kind or id' });
        return;
      }
      const tenantId = findDeadLetterTenant(kind, id);
      if (tenantId == null) {
        res.status(404).json({ ok: false, message: 'dead-letter item not found' });
        return;
      }
      let changed: boolean;
      if (kind === 'jobs') changed = action === 'replay' ? replayJob(id, tenantId) : cancelJob(id, tenantId);
      else changed = action === 'replay' ? replayEvent(id, tenantId) : cancelEvent(id, tenantId);
      if (changed) logPortalAdminMutation(req, 0, `queue.${kind}.${action}`, { id, tenantId });
      res.status(changed ? 200 : 409).json({ ok: changed, kind, id, action });
    } catch (err) {
      sendPortalInternalError(res, err, `Failed to ${action} dead-letter item`, `Portal: dead-letter ${action} failed`);
    }
  };
  app.post('/api/ops/queues/:kind/:id/replay', requirePortalAdminToken, deadLetterAction('replay'));
  app.post('/api/ops/queues/:kind/:id/cancel', requirePortalAdminToken, deadLetterAction('cancel'));

  app.get('/api/ops/flags', (_req: Request, res: Response) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      let killSwitches: ReturnType<typeof listHybridKillSwitches> = [];
      let killSwitchError: string | undefined;
      try {
        killSwitches = listHybridKillSwitches();
      } catch (err) {
        killSwitchError = 'unavailable';
        logger.warn({ err }, 'Portal flags: hybrid kill switches unavailable');
      }
      res.json({
        ok: true,
        generatedAt: new Date().toISOString(),
        flags: readRuntimeFlagCatalog(),
        killSwitches,
        ...(killSwitchError ? { killSwitchError } : {}),
      });
    } catch (err) {
      sendPortalInternalError(res, err, 'Failed to load flags', 'Portal: flags request failed');
    }
  });

  app.post('/api/ops/flags/kill-switches/:key', requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      const key = req.params.key;
      if (typeof key !== 'string' || !(HYBRID_KILL_SWITCH_KEYS as readonly string[]).includes(key)) {
        res.status(404).json({ ok: false, message: 'unknown kill switch' });
        return;
      }
      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { engaged?: unknown; reason?: unknown };
      const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, REASON_MAX_CHARS) : '';
      if (typeof body.engaged !== 'boolean' || !reason) {
        res.status(400).json({ ok: false, message: 'body must carry engaged (boolean) and a non-empty reason' });
        return;
      }
      const owner = getOwnerBootstrapTarget();
      if (!owner?.tenantId) {
        res.status(503).json({ ok: false, message: 'owner bootstrap identity unavailable' });
        return;
      }
      const result = setHybridKillSwitch({
        controlKey: key as HybridKillSwitchKey,
        engaged: body.engaged,
        actorUserId: owner.tenantId,
        reason,
      });
      if (result.kind === 'rejected') {
        res.status(400).json({ ok: false, message: result.reason });
        return;
      }
      if (result.kind === 'updated') {
        logPortalAdminMutation(req, owner.tenantId, `hybrid_kill_switch.${key}`, { engaged: body.engaged, reason });
      }
      res.json({ ok: true, killSwitch: result.state, changed: result.kind === 'updated' });
    } catch (err) {
      sendPortalInternalError(res, err, 'Failed to update kill switch', 'Portal: kill switch update failed');
    }
  });

  app.get('/api/ops/provider-health-history', (req: Request, res: Response) => {
    try {
      const hours = parseBoundedInt(req.query.hours, HISTORY_DEFAULT_HOURS, 1, HISTORY_MAX_HOURS);
      const provider = optionalToken(req.query.provider, PROVIDER_PATTERN);
      const params: unknown[] = [`-${hours} hours`];
      let where = "WHERE ts >= datetime('now', ?)";
      if (provider) { where += ' AND provider = ?'; params.push(provider); }
      const rows = getDb().prepare(`
        SELECT ts, provider, status, latency_ms, error_message
        FROM integration_health ${where}
        ORDER BY ts ASC, id ASC
        LIMIT ?
      `).all(...params, HISTORY_ROW_CAP) as ProviderHealthRow[];
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ok: true, hours, provider, truncated: rows.length >= HISTORY_ROW_CAP, providers: summarizeProviderHealthHistory(rows) });
    } catch (err) {
      sendPortalInternalError(res, err, 'Failed to load provider health history', 'Portal: provider history failed');
    }
  });

  app.get('/api/ops/notification-delivery', requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      const filters = parseDeliveryFilters(req.query);
      const { where, params } = deliveryWhere(filters);
      const attempts = getDb().prepare(`
        SELECT attempt_id AS attemptId, notification_id AS notificationId, intent_id AS intentId,
               user_id AS userId, tenant_id AS tenantId, channel, provider, status,
               provider_response_code AS providerResponseCode, error_code AS errorCode,
               created_at AS createdAt, sent_at AS sentAt
        FROM notification_delivery_attempts ${where}
        ORDER BY created_at DESC, attempt_id DESC
        LIMIT ?
      `).all(...params, filters.limit);
      const total = getDb().prepare(`SELECT COUNT(*) AS c FROM notification_delivery_attempts ${where}`).get(...params) as { c: number } | undefined;
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        ok: true,
        filters,
        summary: {
          total: Number(total?.c) || 0,
          byStatus: countBy('status', where, params),
          byChannel: countBy('channel', where, params),
          byProvider: countBy('provider', where, params),
          byResponseCode: countBy('provider_response_code', where, params),
          byErrorCode: countBy('error_code', where, params),
        },
        attempts,
      });
    } catch (err) {
      sendPortalInternalError(res, err, 'Failed to load notification delivery', 'Portal: notification delivery failed');
    }
  });
}
