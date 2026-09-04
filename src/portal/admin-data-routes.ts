// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Express, Request, Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { extractClientIp } from '../api/rate-limiter';
import { requirePortalAdminToken } from '../api/secret-guards';
import { getDb } from '../services/database';
import { countUserFinanceData } from '../services/user-data-export';
import { requireOperatorTargetUser } from './admin-target-user';
import { sendPortalInternalError } from './http';

function parsePositiveInteger(value: unknown): number | null {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseAuditLimit(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? '50'), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 50;
  return Math.min(parsed, 500);
}

export interface AuditTrailEntry {
  id: number;
  ts: string;
  user_id: number;
  actor_id: number;
  action: string;
  resource: string;
  details: string | null;
  ip_address: string | null;
}

export interface AuditTrailFilters {
  userId: number | null;
  actorId: number | null;
  action: string | null;
  resource: string | null;
  q: string | null;
  since: string | null;
  until: string | null;
  beforeId: number | null;
  limit: number;
  format: 'json' | 'csv';
}

const AUDIT_TOKEN_PATTERN = /^[A-Za-z0-9_.:/-]{1,120}$/;
const AUDIT_QUERY_MAX_CHARS = 120;

function optionalAuditToken(value: unknown): string | null {
  return typeof value === 'string' && value !== '' && AUDIT_TOKEN_PATTERN.test(value) ? value : null;
}

/** Normalizes ISO-8601 or SQLite text to "YYYY-MM-DD HH:MM:SS" (UTC) so it compares with `datetime('now')` rows. */
export function normalizeAuditTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const trimmed = value.trim();
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed);
  const iso = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
  const parsed = Date.parse(hasZone ? iso : `${iso}Z`);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 19).replace('T', ' ');
}

export function parseAuditFilters(query: Request['query']): AuditTrailFilters {
  const q = typeof query.q === 'string' ? query.q.trim().slice(0, AUDIT_QUERY_MAX_CHARS) : '';
  return {
    userId: query.userId ? parsePositiveInteger(query.userId) : null,
    actorId: query.actorId ? parsePositiveInteger(query.actorId) : null,
    action: optionalAuditToken(query.action),
    resource: optionalAuditToken(query.resource),
    q: q || null,
    since: normalizeAuditTimestamp(query.since),
    until: normalizeAuditTimestamp(query.until),
    beforeId: query.beforeId ? parsePositiveInteger(query.beforeId) : null,
    limit: parseAuditLimit(query.limit),
    format: query.format === 'csv' ? 'csv' : 'json',
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export function buildAuditWhere(filters: AuditTrailFilters): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.userId) { clauses.push('user_id = ?'); params.push(filters.userId); }
  if (filters.actorId) { clauses.push('actor_id = ?'); params.push(filters.actorId); }
  if (filters.action) { clauses.push('action = ?'); params.push(filters.action); }
  if (filters.resource) { clauses.push("resource LIKE ? ESCAPE '\\'"); params.push(`${escapeLike(filters.resource)}%`); }
  if (filters.q) {
    clauses.push("(details LIKE ? ESCAPE '\\' OR resource LIKE ? ESCAPE '\\')");
    const needle = `%${escapeLike(filters.q)}%`;
    params.push(needle, needle);
  }
  if (filters.since) { clauses.push('ts >= ?'); params.push(filters.since); }
  if (filters.until) { clauses.push('ts <= ?'); params.push(filters.until); }
  if (filters.beforeId) { clauses.push('id < ?'); params.push(filters.beforeId); }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

const AUDIT_CSV_COLUMNS: (keyof AuditTrailEntry)[] = ['id', 'ts', 'user_id', 'actor_id', 'action', 'resource', 'details', 'ip_address'];

function csvCell(value: unknown): string {
  if (value == null) return '';
  let text = String(value);
  // Neutralize spreadsheet formula injection before quoting.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function auditRowsToCsv(rows: AuditTrailEntry[]): string {
  const lines = [AUDIT_CSV_COLUMNS.join(',')];
  for (const row of rows) lines.push(AUDIT_CSV_COLUMNS.map((column) => csvCell(row[column])).join(','));
  return `${lines.join('\n')}\n`;
}

function countUserRows(db: ReturnType<typeof getDb>, table: string, userId: number): number {
  try {
    return (db.prepare(`SELECT COUNT(*) as c FROM ${table} WHERE user_id = ?`).get(userId) as { c?: number } | undefined)?.c ?? 0;
  } catch {
    return 0;
  }
}

export function registerPortalAdminDataRoutes(app: Express): void {
  const configuredLimit = Number.parseInt(process.env.PORTAL_API_RATE_LIMIT ?? '', 10);
  const authorizationRateLimitMiddleware = rateLimit({
    windowMs: 60 * 1000,
    limit: Number.isFinite(configuredLimit) && configuredLimit > 0 ? configuredLimit : 180,
    keyGenerator: (req: Request) => `ip:${ipKeyGenerator(extractClientIp(req))}`,
    legacyHeaders: false,
    standardHeaders: false,
    handler: (_req, res, _next, options) => {
      const retryAfter = Math.max(1, Math.ceil(options.windowMs / 1000));
      res.setHeader('Retry-After', retryAfter);
      res.status(options.statusCode).json({
        error: { code: 'RATE_LIMITED', message: 'Too many portal requests from this IP. Slow down.', retryAfter },
      });
    },
  });
  if (typeof app.use === 'function') {
    app.use('/api/users/:userId/data-summary', authorizationRateLimitMiddleware);
    app.use('/api/audit-trail', authorizationRateLimitMiddleware);
  }

  // GET /api/audit-trail — recent audit events (admin only).
  // Filters: userId, actorId, action (exact), resource (prefix), q (details/resource
  // substring), since/until (ISO or SQLite text), beforeId (cursor), limit ≤ 500.
  // format=csv streams the same selection as a download.
  app.get('/api/audit-trail', requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      const filters = parseAuditFilters(req.query);
      const { where, params } = buildAuditWhere(filters);
      const rows = getDb().prepare(`SELECT * FROM audit_trail ${where} ORDER BY ts DESC, id DESC LIMIT ?`)
        .all(...params, filters.limit) as AuditTrailEntry[];

      if (filters.format === 'csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="audit-trail-${new Date().toISOString().slice(0, 10)}.csv"`);
        res.setHeader('Cache-Control', 'no-store');
        res.send(auditRowsToCsv(rows));
        return;
      }

      const last = rows[rows.length - 1];
      res.json({
        entries: rows,
        filters: { ...filters, format: undefined },
        nextBeforeId: rows.length === filters.limit && last ? last.id : null,
      });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  // GET /api/audit-trail/facets — distinct actions/resources for filter dropdowns (admin only)
  app.get('/api/audit-trail/facets', requirePortalAdminToken, (_req: Request, res: Response) => {
    try {
      const db = getDb();
      const actions = db.prepare('SELECT action AS value, COUNT(*) AS count FROM audit_trail GROUP BY action ORDER BY count DESC LIMIT 50').all();
      const resources = db.prepare('SELECT resource AS value, COUNT(*) AS count FROM audit_trail GROUP BY resource ORDER BY count DESC LIMIT 50').all();
      res.json({ ok: true, actions, resources });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  // GET /api/users/:userId/data-summary — record counts per table (admin view)
  app.get('/api/users/:userId/data-summary', requirePortalAdminToken, requireOperatorTargetUser('userId'), (req: Request, res: Response) => {
    try {
      const userId = parsePositiveInteger(req.params.userId);
      if (!userId) {
        res.status(400).json({ ok: false, message: 'invalid userId' });
        return;
      }

      const financeCounts = countUserFinanceData(userId);
      const db = getDb();

      res.json({
        conversations: countUserRows(db, 'conversations', userId),
        todos: countUserRows(db, 'todos', userId),
        reminders: countUserRows(db, 'reminders', userId),
        notes: countUserRows(db, 'notes', userId),
        sharedMemory: countUserRows(db, 'shared_memory', userId),
        savedIdeas: countUserRows(db, 'saved_ideas', userId),
        financeTransactions: financeCounts.transactions,
        financeTaxEvents: financeCounts.taxEvents,
      });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });
}
