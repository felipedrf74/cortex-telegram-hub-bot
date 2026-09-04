// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Operator observability routes — Logs, Requests, Issues.
 *
 *   GET  /api/ops/logs                 query runtime_logs (level/src/reqId/user/q/since/until/beforeId)
 *   GET  /api/ops/logs/stream          SSE live tail from the in-memory ring
 *   GET  /api/ops/logs/status          store health (ring, pending, dropped, row count)
 *   GET  /api/ops/requests             query http_request_log
 *   GET  /api/ops/requests/:reqId      one request + correlated logs and errors
 *   GET  /api/ops/latency              per-route latency percentiles from the ledger (+ in-memory iOS ring)
 *   GET  /api/ops/rate-limits          throttle counters and bucket sizes
 *   GET  /api/ops/issues               grouped issues (status/kind/source/q)
 *   GET  /api/ops/issues/summary       counts for badges
 *   GET  /api/ops/issues/:id           issue + recent occurrences
 *   POST /api/ops/issues/:id/{ack|resolve|mute|reopen}   admin, audited
 *   GET  /api/ops/client-errors        raw iOS/client error rows (first read API)
 *   GET  /api/ops/alerts/stream        SSE deltas of the operator alert queue
 *
 * Reads are portal read-scoped through the /api middleware; mutations chain
 * requirePortalAdminToken + admin audit. Payloads never include unredacted
 * secrets: every stored row already passed pino redaction or the log
 * sanitizer on the way in.
 */

import type { Express, Request, Response } from 'express';
import { getDb } from '../services/database';
import {
  extractPortalActorHint,
  getPortalAuthContext,
  requirePortalAdminToken,
} from '../api/secret-guards';
import {
  getLatencyFromLog,
  getHttpRequestLogStatus,
  queryHttpRequests,
  type HttpRequestQuery,
  type HttpSurface,
} from '../api/http-request-log';
import { getRateLimitStats } from '../api/rate-limiter';
import { getLatencySummary } from '../api/request-timer';
import {
  getIssue,
  getIssueSummary,
  listIssues,
  setIssueStatus,
  type IssueKind,
  type IssueStatus,
} from '../services/issue-tracker';
import { listOperatorAlerts, getOperatorAlertDeliverySummary } from '../services/operator-alerts';
import {
  getLogStoreStatus,
  getRecentRingLines,
  lineMatchesFilter,
  queryRuntimeLogs,
  subscribeLogLines,
  type RuntimeLogFilter,
} from '../utils/log-store';
import { logPortalAdminMutation } from './admin-audit';
import { getSupportSummary } from '../services/support-tickets';
import { sendPortalInternalError } from './http';
import { openSse } from './sse';

const LEVEL_NAMES: Record<string, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const SURFACES = new Set<HttpSurface>(['ios', 'portal', 'webhook', 'health', 'oauth', 'public', 'static']);
const ISSUE_ACTIONS: Record<string, IssueStatus> = { ack: 'acked', resolve: 'resolved', mute: 'muted', reopen: 'open' };
const ALERT_STREAM_POLL_MS = 5000;

function readSupportSummary(): ReturnType<typeof getSupportSummary> | null {
  try {
    return getSupportSummary();
  } catch {
    return null;
  }
}

function str(value: unknown, max = 200): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function int(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
}

function iso(value: unknown): string | undefined {
  const s = str(value, 40);
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

export function parseLogLevel(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string' && LEVEL_NAMES[value.toLowerCase()] != null) return LEVEL_NAMES[value.toLowerCase()];
  return int(value);
}

function parseLogFilter(query: Record<string, unknown>): RuntimeLogFilter {
  return {
    level: parseLogLevel(query.level),
    src: str(query.src, 64),
    reqId: str(query.reqId, 64),
    userId: int(query.userId),
    q: str(query.q, 200),
    since: iso(query.since),
    until: iso(query.until),
    beforeId: int(query.beforeId),
    limit: int(query.limit),
  };
}

function parseRequestQuery(query: Record<string, unknown>): HttpRequestQuery {
  const surface = str(query.surface, 16) as HttpSurface | undefined;
  const statusClass = int(query.statusClass);
  return {
    reqId: str(query.reqId, 64),
    userId: int(query.userId),
    path: str(query.path, 200),
    route: str(query.route, 200),
    status: int(query.status),
    statusClass: statusClass && statusClass >= 2 && statusClass <= 5 ? (statusClass as 2 | 3 | 4 | 5) : undefined,
    minDurationMs: int(query.minDurationMs),
    surface: surface && SURFACES.has(surface) ? surface : undefined,
    since: iso(query.since),
    until: iso(query.until),
    beforeId: int(query.beforeId),
    limit: int(query.limit),
  };
}

function portalActor(req: Request): string | undefined {
  return getPortalAuthContext(req)?.actorHint ?? extractPortalActorHint(req);
}

function failed(res: Response, err: unknown, what: string): void {
  sendPortalInternalError(res, err, 'Portal request failed', `Portal: ${what} request failed`);
}

export function registerPortalOpsRoutes(app: Express): void {
  // ── Logs ─────────────────────────────────────────────────────────
  app.get('/api/ops/logs', (req: Request, res: Response) => {
    try {
      const filter = parseLogFilter(req.query as Record<string, unknown>);
      const logs = queryRuntimeLogs(getDb(), filter);
      res.json({ ok: true, logs, nextBeforeId: logs.length ? logs[logs.length - 1].id : null });
    } catch (err) {
      failed(res, err, 'ops logs');
    }
  });

  app.get('/api/ops/logs/status', (_req: Request, res: Response) => {
    try {
      res.json({ ok: true, store: getLogStoreStatus(), requests: getHttpRequestLogStatus() });
    } catch (err) {
      failed(res, err, 'ops logs status');
    }
  });

  app.get('/api/ops/logs/stream', (req: Request, res: Response) => {
    const filter = parseLogFilter(req.query as Record<string, unknown>);
    const handle = openSse(req, res);
    if (!handle) return;
    // Replay the recent ring so the tail is not empty on open.
    for (const line of getRecentRingLines(50, filter)) handle.send('log', line);
    const unsubscribe = subscribeLogLines((line) => {
      if (lineMatchesFilter(line, filter)) handle.send('log', line);
    });
    req.on('close', unsubscribe);
    res.on('close', unsubscribe);
  });

  // ── Requests ────────────────────────────────────────────────────
  app.get('/api/ops/requests', (req: Request, res: Response) => {
    try {
      const requests = queryHttpRequests(getDb(), parseRequestQuery(req.query as Record<string, unknown>));
      res.json({ ok: true, requests, nextBeforeId: requests.length ? requests[requests.length - 1].id : null });
    } catch (err) {
      failed(res, err, 'ops requests');
    }
  });

  app.get('/api/ops/latency', (req: Request, res: Response) => {
    try {
      const windowRaw = str(req.query.window, 8) ?? '1h';
      const windowMinutes = windowRaw === '15m' ? 15 : windowRaw === '24h' ? 24 * 60 : 60;
      res.json({
        ok: true,
        window: windowRaw === '15m' || windowRaw === '24h' ? windowRaw : '1h',
        routes: getLatencyFromLog(getDb(), windowMinutes),
        recentIos: getLatencySummary(),
      });
    } catch (err) {
      failed(res, err, 'ops latency');
    }
  });

  app.get('/api/ops/rate-limits', (_req: Request, res: Response) => {
    try {
      res.json({ ok: true, ...getRateLimitStats() });
    } catch (err) {
      failed(res, err, 'ops rate limits');
    }
  });

  app.get('/api/ops/requests/:reqId', (req: Request, res: Response) => {
    try {
      const reqId = str(req.params.reqId, 64);
      if (!reqId) { res.status(400).json({ ok: false, message: 'Invalid request id' }); return; }
      const db = getDb();
      const requests = queryHttpRequests(db, { reqId, limit: 5 });
      const logs = queryRuntimeLogs(db, { reqId, limit: 500 }).reverse();
      let serverErrors: unknown[] = [];
      let clientErrors: unknown[] = [];
      try {
        serverErrors = db.prepare('SELECT id, ts, level, source, message, issue_id FROM error_log WHERE req_id = ? ORDER BY id DESC LIMIT 50').all(reqId);
        clientErrors = db.prepare('SELECT id, ts, level, source, message, app_version, issue_id FROM client_errors WHERE req_id = ? ORDER BY id DESC LIMIT 50').all(reqId);
      } catch {
        // columns arrive with migration 315
      }
      if (requests.length === 0 && logs.length === 0 && serverErrors.length === 0 && clientErrors.length === 0) {
        res.status(404).json({ ok: false, message: 'Request not found' });
        return;
      }
      res.json({ ok: true, request: requests[0] ?? null, requests, logs, errors: { server: serverErrors, client: clientErrors } });
    } catch (err) {
      failed(res, err, 'ops request detail');
    }
  });

  // ── Issues ──────────────────────────────────────────────────────
  app.get('/api/ops/issues', (req: Request, res: Response) => {
    try {
      const statusRaw = str(req.query.status, 16);
      const kindRaw = str(req.query.kind, 16);
      const status = statusRaw === 'all' || statusRaw === 'open' || statusRaw === 'acked' || statusRaw === 'resolved' || statusRaw === 'muted'
        ? statusRaw : undefined;
      res.json({
        ok: true,
        issues: listIssues({
          status,
          kind: kindRaw === 'server' || kindRaw === 'client' ? (kindRaw as IssueKind) : undefined,
          source: str(req.query.source, 64),
          q: str(req.query.q, 200),
          limit: int(req.query.limit),
        }),
        summary: getIssueSummary(),
      });
    } catch (err) {
      failed(res, err, 'ops issues');
    }
  });

  app.get('/api/ops/issues/summary', (_req: Request, res: Response) => {
    try {
      res.json({ ok: true, ...getIssueSummary() });
    } catch (err) {
      failed(res, err, 'ops issues summary');
    }
  });

  app.get('/api/ops/issues/:id', (req: Request, res: Response) => {
    try {
      const id = int(req.params.id);
      if (!id || id <= 0) { res.status(400).json({ ok: false, message: 'Invalid issue id' }); return; }
      const detail = getIssue(id, int(req.query.limit) ?? 20);
      if (!detail) { res.status(404).json({ ok: false, message: 'Issue not found' }); return; }
      res.json({ ok: true, ...detail });
    } catch (err) {
      failed(res, err, 'ops issue detail');
    }
  });

  const issueTransition = (action: keyof typeof ISSUE_ACTIONS) => (req: Request, res: Response): void => {
    const status = ISSUE_ACTIONS[action];
    try {
      const id = int(req.params.id);
      if (!id || id <= 0) { res.status(400).json({ ok: false, message: 'Invalid issue id' }); return; }
      const notes = str((req.body as { notes?: unknown } | undefined)?.notes, 2000) ?? null;
      const ok = setIssueStatus(id, status, portalActor(req) ?? null, notes);
      if (ok) logPortalAdminMutation(req, 0, `issue.${action}`, { issueId: id, status, notes: notes ? true : false });
      res.status(ok ? 200 : 404).json({ ok, status: ok ? status : undefined });
    } catch (err) {
      failed(res, err, `ops issue ${action}`);
    }
  };
  app.post('/api/ops/issues/:id/ack', requirePortalAdminToken, issueTransition('ack'));
  app.post('/api/ops/issues/:id/resolve', requirePortalAdminToken, issueTransition('resolve'));
  app.post('/api/ops/issues/:id/mute', requirePortalAdminToken, issueTransition('mute'));
  app.post('/api/ops/issues/:id/reopen', requirePortalAdminToken, issueTransition('reopen'));

  // ── Client errors (raw rows) ────────────────────────────────────
  app.get('/api/ops/client-errors', (req: Request, res: Response) => {
    try {
      const clauses: string[] = [];
      const params: unknown[] = [];
      const userId = int(req.query.userId);
      const appVersion = str(req.query.appVersion, 64);
      const level = str(req.query.level, 16);
      const since = iso(req.query.since);
      const beforeId = int(req.query.beforeId);
      if (userId != null) { clauses.push('user_id = ?'); params.push(userId); }
      if (appVersion) { clauses.push('app_version = ?'); params.push(appVersion); }
      if (level) { clauses.push('level = ?'); params.push(level); }
      if (since) { clauses.push('ts >= ?'); params.push(since); }
      if (beforeId != null) { clauses.push('id < ?'); params.push(beforeId); }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const limit = Math.max(1, Math.min(500, int(req.query.limit) ?? 100));
      const rows = getDb().prepare(
        `SELECT id, ts, user_id, device_id, source, level, message, app_version, os_version, issue_id, req_id
         FROM client_errors ${where} ORDER BY id DESC LIMIT ?`,
      ).all(...params, limit);
      res.json({ ok: true, errors: rows });
    } catch (err) {
      failed(res, err, 'ops client errors');
    }
  });

  // ── Alerts live stream ──────────────────────────────────────────
  app.get('/api/ops/alerts/stream', (req: Request, res: Response) => {
    const handle = openSse(req, res);
    if (!handle) return;
    let lastSignature = '';
    const tick = () => {
      if (handle.closed) return;
      try {
        const alerts = listOperatorAlerts({ status: 'open', limit: 50 });
        const delivery = getOperatorAlertDeliverySummary();
        const signature = JSON.stringify({ alerts: alerts.map((a) => [a.id, a.status, a.updatedAt, a.deliveryStatus]), delivery });
        if (signature !== lastSignature) {
          lastSignature = signature;
          handle.send('alerts', { alerts, delivery, issues: getIssueSummary(), support: readSupportSummary() });
        }
      } catch {
        // keep the stream alive; next tick retries
      }
    };
    tick();
    const timer = setInterval(tick, ALERT_STREAM_POLL_MS);
    timer.unref?.();
    const stop = () => clearInterval(timer);
    req.on('close', stop);
    res.on('close', stop);
  });
}
