// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Issue tracker — groups server errors (`error_log`) and client errors
 * (`client_errors`) into `issues` rows keyed by a stable fingerprint so the
 * portal can show "what is broken" with counts, first/last seen and an
 * ack/resolve/mute lifecycle instead of a raw error stream.
 *
 * Fingerprint = sha1(kind | source | normalised message | first stack frame).
 * Normalisation strips digits, uuids, long hex, quoted strings and
 * whitespace so ids, paths and timestamps do not fan out into new issues.
 *
 * A resolved issue that recurs is reopened, `regressed_at` is set and a
 * warning operator alert is recorded (deduped per fingerprint).
 */

import crypto from 'crypto';
import { getDb } from './database';
import { recordOperatorAlert } from './operator-alerts';
import { sanitizeLogText } from '../utils/log-sanitizer';

export type IssueKind = 'server' | 'client';
export type IssueStatus = 'open' | 'acked' | 'resolved' | 'muted';

export interface IssueRecord {
  id: number;
  fingerprint: string;
  kind: IssueKind;
  source: string;
  title: string;
  level: string;
  status: IssueStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrenceCount: number;
  regressedAt: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  notes: string | null;
  sampleStack: string | null;
  lastReqId: string | null;
  lastUserId: number | null;
  lastAppVersion: string | null;
  lastAlertId: number | null;
}

export interface IssueOccurrence {
  table: 'error_log' | 'client_errors';
  id: number;
  ts: string;
  level: string;
  source: string;
  message: string;
  reqId: string | null;
  userId: number | null;
  appVersion: string | null;
}

export interface UpsertIssueInput {
  kind: IssueKind;
  source: string;
  level: string;
  message: string;
  stack?: string | null;
  reqId?: string | null;
  userId?: number | null;
  appVersion?: string | null;
  /** Override the "now" used for first/last seen (tests). */
  nowIso?: string;
}

export interface UpsertIssueResult {
  issueId: number;
  fingerprint: string;
  created: boolean;
  regressed: boolean;
}

export interface IssueListFilter {
  status?: IssueStatus | 'all';
  kind?: IssueKind;
  source?: string;
  q?: string;
  limit?: number;
}

const TITLE_MAX = 200;
const STACK_MAX = 8000;
export const ISSUE_STATUSES: readonly IssueStatus[] = ['open', 'acked', 'resolved', 'muted'];

export function normalizeIssueMessage(message: string): string {
  return sanitizeLogText(message)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<hex>')
    .replace(/"[^"\n]*"/g, '"…"')
    .replace(/'[^'\n]*'/g, "'…'")
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

export function firstStackFrame(stack: string | null | undefined): string {
  if (!stack) return '';
  const frame = stack
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('at ') || /\(.+:\d+:\d+\)/.test(line) || /:\d+:\d+$/.test(line));
  if (!frame) return '';
  // Keep function + file, drop line/column so recompiles do not fan out.
  return frame.replace(/:\d+:\d+\)?$/, '').replace(/^at\s+/, '').slice(0, 200);
}

export function computeIssueFingerprint(kind: IssueKind, source: string, message: string, stack?: string | null): string {
  const material = `${kind}|${source}|${normalizeIssueMessage(message)}|${firstStackFrame(stack)}`;
  return crypto.createHash('sha1').update(material).digest('hex');
}

function rowToIssue(row: Record<string, unknown>): IssueRecord {
  return {
    id: Number(row.id),
    fingerprint: String(row.fingerprint),
    kind: row.kind as IssueKind,
    source: String(row.source),
    title: String(row.title),
    level: String(row.level),
    status: row.status as IssueStatus,
    firstSeenAt: String(row.first_seen_at),
    lastSeenAt: String(row.last_seen_at),
    occurrenceCount: Number(row.occurrence_count),
    regressedAt: (row.regressed_at as string | null) ?? null,
    resolvedAt: (row.resolved_at as string | null) ?? null,
    resolvedBy: (row.resolved_by as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    sampleStack: (row.sample_stack as string | null) ?? null,
    lastReqId: (row.last_req_id as string | null) ?? null,
    lastUserId: row.last_user_id == null ? null : Number(row.last_user_id),
    lastAppVersion: (row.last_app_version as string | null) ?? null,
    lastAlertId: row.last_alert_id == null ? null : Number(row.last_alert_id),
  };
}

/**
 * Insert-or-bump the issue for this occurrence. Never throws: a missing
 * table (migration pending) yields `null` so error capture keeps working.
 */
export function upsertIssue(input: UpsertIssueInput): UpsertIssueResult | null {
  try {
    const db = getDb();
    const fingerprint = computeIssueFingerprint(input.kind, input.source, input.message, input.stack);
    const now = input.nowIso ?? new Date().toISOString();
    const title = normalizeIssueMessage(input.message).slice(0, TITLE_MAX) || '(empty message)';
    const stack = input.stack ? sanitizeLogText(input.stack).slice(0, STACK_MAX) : null;
    const existing = db.prepare('SELECT * FROM issues WHERE fingerprint = ?').get(fingerprint) as Record<string, unknown> | undefined;

    if (!existing) {
      const result = db.prepare(`
        INSERT INTO issues (fingerprint, kind, source, title, level, status, first_seen_at, last_seen_at,
          occurrence_count, sample_stack, last_req_id, last_user_id, last_app_version)
        VALUES (?, ?, ?, ?, ?, 'open', ?, ?, 1, ?, ?, ?, ?)
      `).run(fingerprint, input.kind, input.source, title, input.level, now, now, stack,
        input.reqId ?? null, input.userId ?? null, input.appVersion ?? null);
      return { issueId: Number(result.lastInsertRowid), fingerprint, created: true, regressed: false };
    }

    const issue = rowToIssue(existing);
    const regressed = issue.status === 'resolved';
    db.prepare(`
      UPDATE issues SET
        last_seen_at = ?, occurrence_count = occurrence_count + 1, level = ?,
        sample_stack = COALESCE(?, sample_stack),
        last_req_id = COALESCE(?, last_req_id), last_user_id = COALESCE(?, last_user_id),
        last_app_version = COALESCE(?, last_app_version),
        status = CASE WHEN status = 'resolved' THEN 'open' ELSE status END,
        regressed_at = CASE WHEN status = 'resolved' THEN ? ELSE regressed_at END
      WHERE id = ?
    `).run(now, input.level, stack, input.reqId ?? null, input.userId ?? null, input.appVersion ?? null, now, issue.id);

    if (regressed) {
      recordOperatorAlert({
        severity: 'warning',
        source: 'issue_tracker',
        dedupeKey: `issue:regressed:${fingerprint}`,
        title: `Regression: ${title.slice(0, 120)}`,
        detail: `Issue #${issue.id} (${input.kind}/${input.source}) was resolved${issue.resolvedAt ? ` at ${issue.resolvedAt}` : ''} and recurred.`,
        owner: 'ops',
        suspectedArea: input.source,
        runbookUrl: 'docs/OBSERVABILITY-ONCALL.md#errors-and-issues',
        metadata: { issueId: issue.id, fingerprint, kind: input.kind, source: input.source },
      });
    }
    return { issueId: issue.id, fingerprint, created: false, regressed };
  } catch {
    return null;
  }
}

export function linkIssueAlert(issueId: number, alertId: number): void {
  try {
    getDb().prepare('UPDATE issues SET last_alert_id = ? WHERE id = ?').run(alertId, issueId);
  } catch {
    // best-effort
  }
}

export function listIssues(filter: IssueListFilter = {}): IssueRecord[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const status = filter.status ?? 'open';
  if (status !== 'all') { clauses.push('status = ?'); params.push(status); }
  if (filter.kind) { clauses.push('kind = ?'); params.push(filter.kind); }
  if (filter.source) { clauses.push('source = ?'); params.push(filter.source); }
  if (filter.q) { clauses.push("title LIKE ? ESCAPE '\\'"); params.push(`%${filter.q.replace(/[%_]/g, (c) => `\\${c}`)}%`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(500, Math.floor(filter.limit ?? 100)));
  const rows = getDb().prepare(`SELECT * FROM issues ${where} ORDER BY last_seen_at DESC LIMIT ?`).all(...params, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToIssue);
}

export function getIssue(id: number, occurrenceLimit = 20): { issue: IssueRecord; occurrences: IssueOccurrence[] } | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM issues WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  const issue = rowToIssue(row);
  const occurrences: IssueOccurrence[] = [];
  const limit = Math.max(1, Math.min(200, occurrenceLimit));
  if (issue.kind === 'server') {
    const rows = db.prepare(
      'SELECT id, ts, level, source, message, req_id, user_id FROM error_log WHERE issue_id = ? ORDER BY id DESC LIMIT ?',
    ).all(id, limit) as Array<Record<string, unknown>>;
    for (const r of rows) {
      occurrences.push({
        table: 'error_log', id: Number(r.id), ts: String(r.ts), level: String(r.level), source: String(r.source),
        message: String(r.message), reqId: (r.req_id as string | null) ?? null,
        userId: r.user_id == null ? null : Number(r.user_id), appVersion: null,
      });
    }
  } else {
    const rows = db.prepare(
      'SELECT id, ts, level, source, message, req_id, user_id, app_version FROM client_errors WHERE issue_id = ? ORDER BY id DESC LIMIT ?',
    ).all(id, limit) as Array<Record<string, unknown>>;
    for (const r of rows) {
      occurrences.push({
        table: 'client_errors', id: Number(r.id), ts: String(r.ts), level: String(r.level), source: String(r.source),
        message: String(r.message), reqId: (r.req_id as string | null) ?? null,
        userId: r.user_id == null ? null : Number(r.user_id), appVersion: (r.app_version as string | null) ?? null,
      });
    }
  }
  return { issue, occurrences };
}

export function setIssueStatus(id: number, status: IssueStatus, actor?: string | null, notes?: string | null): boolean {
  if (!ISSUE_STATUSES.includes(status)) return false;
  const db = getDb();
  const now = new Date().toISOString();
  const resolvedAt = status === 'resolved' ? now : null;
  const resolvedBy = status === 'resolved' ? (actor ?? null) : null;
  const result = db.prepare(`
    UPDATE issues SET status = ?,
      resolved_at = CASE WHEN ? = 'resolved' THEN ? ELSE resolved_at END,
      resolved_by = CASE WHEN ? = 'resolved' THEN ? ELSE resolved_by END,
      regressed_at = CASE WHEN ? = 'resolved' THEN NULL ELSE regressed_at END,
      notes = COALESCE(?, notes)
    WHERE id = ?
  `).run(status, status, resolvedAt, status, resolvedBy, status, notes ?? null, id);
  return Number((result as { changes?: number }).changes ?? 0) > 0;
}

export function getIssueSummary(): { byStatus: Record<IssueStatus, number>; byKind: Record<IssueKind, number>; openLast24h: number } {
  const byStatus: Record<IssueStatus, number> = { open: 0, acked: 0, resolved: 0, muted: 0 };
  const byKind: Record<IssueKind, number> = { server: 0, client: 0 };
  let openLast24h = 0;
  try {
    const db = getDb();
    for (const row of db.prepare('SELECT status, COUNT(*) AS c FROM issues GROUP BY status').all() as Array<{ status: IssueStatus; c: number }>) {
      byStatus[row.status] = Number(row.c);
    }
    for (const row of db.prepare("SELECT kind, COUNT(*) AS c FROM issues WHERE status IN ('open','acked') GROUP BY kind").all() as Array<{ kind: IssueKind; c: number }>) {
      byKind[row.kind] = Number(row.c);
    }
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const recent = db.prepare("SELECT COUNT(*) AS c FROM issues WHERE status = 'open' AND last_seen_at >= ?").get(since) as { c?: number } | undefined;
    openLast24h = Number(recent?.c ?? 0);
  } catch {
    // table missing
  }
  return { byStatus, byKind, openLast24h };
}

/**
 * One-time backfill: group historical rows that predate the issues table.
 * Bounded so a large error_log cannot stall boot. Idempotent (skips rows
 * that already carry an issue_id).
 */
export function backfillIssues(options: { maxRows?: number; sinceDays?: number } = {}): { server: number; client: number } {
  const maxRows = options.maxRows ?? 10_000;
  const since = new Date(Date.now() - (options.sinceDays ?? 60) * 86_400_000).toISOString();
  const out = { server: 0, client: 0 };
  try {
    const db = getDb();
    const serverRows = db.prepare(
      'SELECT id, ts, level, source, message, stack, req_id, user_id FROM error_log WHERE issue_id IS NULL AND ts >= ? ORDER BY id ASC LIMIT ?',
    ).all(since, maxRows) as Array<Record<string, unknown>>;
    for (const r of serverRows) {
      const result = upsertIssue({
        kind: 'server', source: String(r.source), level: String(r.level), message: String(r.message),
        stack: (r.stack as string | null) ?? null, reqId: (r.req_id as string | null) ?? null,
        userId: r.user_id == null ? null : Number(r.user_id), nowIso: String(r.ts),
      });
      if (result) { db.prepare('UPDATE error_log SET issue_id = ? WHERE id = ?').run(result.issueId, r.id); out.server += 1; }
    }
    const clientRows = db.prepare(
      'SELECT id, ts, level, source, message, stack, req_id, user_id, app_version FROM client_errors WHERE issue_id IS NULL AND ts >= ? ORDER BY id ASC LIMIT ?',
    ).all(since, Math.max(0, maxRows - out.server)) as Array<Record<string, unknown>>;
    for (const r of clientRows) {
      const result = upsertIssue({
        kind: 'client', source: String(r.source), level: String(r.level), message: String(r.message),
        stack: (r.stack as string | null) ?? null, reqId: (r.req_id as string | null) ?? null,
        userId: r.user_id == null ? null : Number(r.user_id), appVersion: (r.app_version as string | null) ?? null,
        nowIso: String(r.ts),
      });
      if (result) { db.prepare('UPDATE client_errors SET issue_id = ? WHERE id = ?').run(result.issueId, r.id); out.client += 1; }
    }
  } catch {
    // tables missing — nothing to backfill
  }
  return out;
}
