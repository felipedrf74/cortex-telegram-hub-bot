// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Support tickets — the operator queue for everything a human reported or
 * must act on: in-app feedback, bugs, incidents, beta access requests, data
 * requests, and plain tasks.
 *
 * Privacy boundary (docs/release/portal-scope-policy.md §3): titles and
 * bodies pass through the log sanitizer; the iOS intake only accepts an
 * allowlisted diagnostics context (screen, app/OS version, last client
 * error id, last request id) and never chat content.
 *
 * Every state-changing call writes a `support_ticket_events` row so the
 * ticket timeline is replayable. New tickets also record an `info` operator
 * alert so the existing webhook delivery path notifies the on-call.
 */

import { getDb } from './database';
import { recordOperatorAlert } from './operator-alerts';
import { sanitizeLogText } from '../utils/log-sanitizer';

export type TicketKind = 'feedback' | 'bug' | 'question' | 'incident' | 'access_request' | 'data_request' | 'task';
export type TicketStatus = 'new' | 'open' | 'waiting_user' | 'resolved' | 'closed';
export type TicketPriority = 'p0' | 'p1' | 'p2' | 'p3';
export type TicketSource = 'operator' | 'ios_feedback' | 'issue' | 'alert' | 'email' | 'waitlist';
export type TicketEventType = 'created' | 'comment' | 'status' | 'priority' | 'kind' | 'assignee' | 'link' | 'user_reply' | 'system';

export const TICKET_KINDS: readonly TicketKind[] = ['feedback', 'bug', 'question', 'incident', 'access_request', 'data_request', 'task'];
export const TICKET_STATUSES: readonly TicketStatus[] = ['new', 'open', 'waiting_user', 'resolved', 'closed'];
export const TICKET_PRIORITIES: readonly TicketPriority[] = ['p0', 'p1', 'p2', 'p3'];
export const TICKET_SOURCES: readonly TicketSource[] = ['operator', 'ios_feedback', 'issue', 'alert', 'email', 'waitlist'];

export const TICKET_TITLE_MAX = 200;
export const TICKET_BODY_MAX = 8000;
export const TICKET_EVENT_BODY_MAX = 4000;

export interface SupportTicket {
  id: number;
  ref: string;
  kind: TicketKind;
  status: TicketStatus;
  priority: TicketPriority;
  source: TicketSource;
  title: string;
  body: string | null;
  userId: number | null;
  tenantId: number | null;
  deviceId: string | null;
  appVersion: string | null;
  osVersion: string | null;
  screen: string | null;
  issueId: number | null;
  alertId: number | null;
  reqId: string | null;
  clientErrorId: number | null;
  externalRef: string | null;
  createdBy: string;
  assignee: string | null;
  createdAt: string;
  updatedAt: string;
  lastEventAt: string;
  resolvedAt: string | null;
  closedAt: string | null;
  dueAt: string | null;
}

export interface SupportTicketEvent {
  id: number;
  ticketId: number;
  ts: string;
  actor: string;
  type: TicketEventType;
  body: string | null;
  meta: Record<string, unknown> | null;
}

export interface CreateTicketInput {
  kind: TicketKind;
  source: TicketSource;
  title: string;
  body?: string | null;
  priority?: TicketPriority;
  userId?: number | null;
  tenantId?: number | null;
  deviceId?: string | null;
  appVersion?: string | null;
  osVersion?: string | null;
  screen?: string | null;
  issueId?: number | null;
  alertId?: number | null;
  reqId?: string | null;
  clientErrorId?: number | null;
  externalRef?: string | null;
  assignee?: string | null;
  createdBy: string;
  /** Skip the operator alert (bulk imports, tests). */
  quiet?: boolean;
}

export interface UpdateTicketInput {
  status?: TicketStatus;
  priority?: TicketPriority;
  kind?: TicketKind;
  title?: string;
  assignee?: string | null;
  externalRef?: string | null;
  dueAt?: string | null;
}

export interface TicketListFilter {
  status?: TicketStatus | 'all' | 'active';
  kind?: TicketKind;
  priority?: TicketPriority;
  source?: TicketSource;
  userId?: number;
  q?: string;
  limit?: number;
}

export interface SupportSummary {
  byStatus: Record<TicketStatus, number>;
  byPriority: Record<TicketPriority, number>;
  newOlderThan48h: number;
  createdLast7d: number;
}

function clean(value: string | null | undefined, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = sanitizeLogText(value).trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function short(value: string | null | undefined, max = 128): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

export function formatTicketRef(id: number): string {
  return `NH-T-${String(id).padStart(4, '0')}`;
}

function rowToTicket(row: Record<string, unknown>): SupportTicket {
  const n = (v: unknown) => (v == null ? null : Number(v));
  const s = (v: unknown) => (v == null ? null : String(v));
  return {
    id: Number(row.id),
    ref: String(row.ref),
    kind: row.kind as TicketKind,
    status: row.status as TicketStatus,
    priority: row.priority as TicketPriority,
    source: row.source as TicketSource,
    title: String(row.title),
    body: s(row.body),
    userId: n(row.user_id),
    tenantId: n(row.tenant_id),
    deviceId: s(row.device_id),
    appVersion: s(row.app_version),
    osVersion: s(row.os_version),
    screen: s(row.screen),
    issueId: n(row.issue_id),
    alertId: n(row.alert_id),
    reqId: s(row.req_id),
    clientErrorId: n(row.client_error_id),
    externalRef: s(row.external_ref),
    createdBy: String(row.created_by),
    assignee: s(row.assignee),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastEventAt: String(row.last_event_at),
    resolvedAt: s(row.resolved_at),
    closedAt: s(row.closed_at),
    dueAt: s(row.due_at),
  };
}

function rowToEvent(row: Record<string, unknown>): SupportTicketEvent {
  let meta: Record<string, unknown> | null = null;
  if (typeof row.meta_json === 'string') {
    try { meta = JSON.parse(row.meta_json); } catch { meta = null; }
  }
  return {
    id: Number(row.id),
    ticketId: Number(row.ticket_id),
    ts: String(row.ts),
    actor: String(row.actor),
    type: row.type as TicketEventType,
    body: row.body == null ? null : String(row.body),
    meta,
  };
}

function insertEvent(ticketId: number, actor: string, type: TicketEventType, body: string | null, meta?: Record<string, unknown>): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO support_ticket_events (ticket_id, ts, actor, type, body, meta_json) VALUES (?, ?, ?, ?, ?, ?)')
    .run(ticketId, now, actor, type, body, meta ? JSON.stringify(meta) : null);
  db.prepare('UPDATE support_tickets SET last_event_at = ?, updated_at = ? WHERE id = ?').run(now, now, ticketId);
}

export function createTicket(input: CreateTicketInput): SupportTicket {
  if (!TICKET_KINDS.includes(input.kind)) throw new Error('invalid ticket kind');
  if (!TICKET_SOURCES.includes(input.source)) throw new Error('invalid ticket source');
  const priority = input.priority && TICKET_PRIORITIES.includes(input.priority) ? input.priority : 'p3';
  const title = clean(input.title, TICKET_TITLE_MAX);
  if (!title) throw new Error('ticket title is required');
  const body = clean(input.body, TICKET_BODY_MAX);
  const db = getDb();
  const now = new Date().toISOString();
  const createdBy = short(input.createdBy, 128) || 'system';
  const externalRef = short(input.externalRef, 512) ?? null;
  if (externalRef) {
    // One ticket per external reference (waitlist:<id>, email message id): a
    // repeated request returns the ticket already filed instead of a duplicate.
    // The lookup and insert run in one synchronous better-sqlite3 turn, so two
    // concurrent requests cannot interleave between them.
    const existing = db.prepare('SELECT * FROM support_tickets WHERE external_ref = ? ORDER BY id ASC LIMIT 1')
      .get(externalRef) as Record<string, unknown> | undefined;
    if (existing) return rowToTicket(existing);
  }

  const result = db.prepare(`
    INSERT INTO support_tickets (
      ref, kind, status, priority, source, title, body, user_id, tenant_id, device_id, app_version, os_version, screen,
      issue_id, alert_id, req_id, client_error_id, external_ref, created_by, assignee, created_at, updated_at, last_event_at
    ) VALUES (?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    input.kind, priority, input.source, title, body,
    input.userId ?? null, input.tenantId ?? input.userId ?? null,
    short(input.deviceId, 256), short(input.appVersion, 64), short(input.osVersion, 64), short(input.screen, 128),
    input.issueId ?? null, input.alertId ?? null, short(input.reqId, 64), input.clientErrorId ?? null,
    externalRef, createdBy, short(input.assignee, 128),
    now, now, now,
  );
  const id = Number(result.lastInsertRowid);
  const ref = formatTicketRef(id);
  db.prepare('UPDATE support_tickets SET ref = ? WHERE id = ?').run(ref, id);
  insertEvent(id, createdBy, 'created', body, { source: input.source, kind: input.kind, priority });

  if (!input.quiet) {
    try {
      recordOperatorAlert({
        severity: priority === 'p0' ? 'critical' : 'info',
        source: 'support',
        dedupeKey: `support:ticket:${id}`,
        title: `${ref} ${input.kind}: ${title.slice(0, 120)}`,
        detail: `New ${input.kind} ticket from ${input.source}${input.userId ? ` for user ${input.userId}` : ''}.`,
        owner: 'support',
        suspectedArea: 'support',
        runbookUrl: 'docs/OBSERVABILITY-ONCALL.md#support-tickets',
        metadata: { ticketId: id, ref, kind: input.kind, priority, source: input.source },
      });
    } catch {
      // alert delivery is best-effort
    }
  }
  return getTicket(id)!.ticket;
}

export function getTicket(id: number, eventLimit = 200): { ticket: SupportTicket; events: SupportTicketEvent[] } | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  const events = (db.prepare('SELECT * FROM support_ticket_events WHERE ticket_id = ? ORDER BY id ASC LIMIT ?').all(id, Math.max(1, Math.min(1000, eventLimit))) as Array<Record<string, unknown>>).map(rowToEvent);
  return { ticket: rowToTicket(row), events };
}

export function getTicketByRef(ref: string): SupportTicket | null {
  const row = getDb().prepare('SELECT * FROM support_tickets WHERE ref = ?').get(ref) as Record<string, unknown> | undefined;
  return row ? rowToTicket(row) : null;
}

export function listTickets(filter: TicketListFilter = {}): SupportTicket[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const status = filter.status ?? 'active';
  if (status === 'active') clauses.push("status IN ('new', 'open', 'waiting_user')");
  else if (status !== 'all') { clauses.push('status = ?'); params.push(status); }
  if (filter.kind) { clauses.push('kind = ?'); params.push(filter.kind); }
  if (filter.priority) { clauses.push('priority = ?'); params.push(filter.priority); }
  if (filter.source) { clauses.push('source = ?'); params.push(filter.source); }
  if (filter.userId != null) { clauses.push('user_id = ?'); params.push(filter.userId); }
  if (filter.q) { clauses.push("(title LIKE ? ESCAPE '\\' OR ref LIKE ? ESCAPE '\\')"); const like = `%${filter.q.replace(/[%_]/g, (c) => `\\${c}`)}%`; params.push(like, like); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(500, Math.floor(filter.limit ?? 100)));
  const rows = getDb().prepare(`SELECT * FROM support_tickets ${where} ORDER BY CASE priority WHEN 'p0' THEN 0 WHEN 'p1' THEN 1 WHEN 'p2' THEN 2 ELSE 3 END, last_event_at DESC LIMIT ?`).all(...params, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToTicket);
}

/** Own tickets for the iOS app: no operator notes, no internal links. */
export function listTicketsForUser(userId: number, limit = 50): Array<Pick<SupportTicket, 'id' | 'ref' | 'kind' | 'status' | 'title' | 'createdAt' | 'updatedAt'>> {
  const rows = getDb().prepare(
    'SELECT id, ref, kind, status, title, created_at, updated_at FROM support_tickets WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
  ).all(userId, Math.max(1, Math.min(200, limit))) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: Number(r.id), ref: String(r.ref), kind: r.kind as TicketKind, status: r.status as TicketStatus,
    title: String(r.title), createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  }));
}

export function countUserTicketsSince(userId: number, sinceMs: number): number {
  const since = new Date(Date.now() - sinceMs).toISOString();
  const row = getDb().prepare('SELECT COUNT(*) AS c FROM support_tickets WHERE user_id = ? AND created_at >= ?').get(userId, since) as { c?: number } | undefined;
  return Number(row?.c ?? 0);
}

export function updateTicket(id: number, patch: UpdateTicketInput, actor: string): SupportTicket | null {
  const existing = getTicket(id, 1);
  if (!existing) return null;
  const db = getDb();
  const now = new Date().toISOString();
  const who = short(actor, 128) || 'system';
  const current = existing.ticket;

  if (patch.status && patch.status !== current.status) {
    if (!TICKET_STATUSES.includes(patch.status)) throw new Error('invalid ticket status');
    db.prepare(`
      UPDATE support_tickets SET status = ?,
        resolved_at = CASE WHEN ? = 'resolved' THEN ? WHEN ? IN ('new','open','waiting_user') THEN NULL ELSE resolved_at END,
        closed_at = CASE WHEN ? = 'closed' THEN ? WHEN ? IN ('new','open','waiting_user') THEN NULL ELSE closed_at END
      WHERE id = ?
    `).run(patch.status, patch.status, now, patch.status, patch.status, now, patch.status, id);
    insertEvent(id, who, 'status', null, { from: current.status, to: patch.status });
  }
  if (patch.priority && patch.priority !== current.priority) {
    if (!TICKET_PRIORITIES.includes(patch.priority)) throw new Error('invalid ticket priority');
    db.prepare('UPDATE support_tickets SET priority = ? WHERE id = ?').run(patch.priority, id);
    insertEvent(id, who, 'priority', null, { from: current.priority, to: patch.priority });
  }
  if (patch.kind && patch.kind !== current.kind) {
    if (!TICKET_KINDS.includes(patch.kind)) throw new Error('invalid ticket kind');
    db.prepare('UPDATE support_tickets SET kind = ? WHERE id = ?').run(patch.kind, id);
    insertEvent(id, who, 'kind', null, { from: current.kind, to: patch.kind });
  }
  if (patch.title !== undefined) {
    const title = clean(patch.title, TICKET_TITLE_MAX);
    if (title && title !== current.title) {
      db.prepare('UPDATE support_tickets SET title = ? WHERE id = ?').run(title, id);
      insertEvent(id, who, 'system', null, { field: 'title' });
    }
  }
  if (patch.assignee !== undefined) {
    const assignee = short(patch.assignee, 128);
    if (assignee !== current.assignee) {
      db.prepare('UPDATE support_tickets SET assignee = ? WHERE id = ?').run(assignee, id);
      insertEvent(id, who, 'assignee', null, { from: current.assignee, to: assignee });
    }
  }
  if (patch.externalRef !== undefined) {
    db.prepare('UPDATE support_tickets SET external_ref = ? WHERE id = ?').run(short(patch.externalRef, 512), id);
    insertEvent(id, who, 'system', null, { field: 'externalRef' });
  }
  if (patch.dueAt !== undefined) {
    const dueAt = patch.dueAt && !Number.isNaN(Date.parse(patch.dueAt)) ? new Date(patch.dueAt).toISOString() : null;
    db.prepare('UPDATE support_tickets SET due_at = ? WHERE id = ?').run(dueAt, id);
    insertEvent(id, who, 'system', null, { field: 'dueAt', to: dueAt });
  }
  db.prepare('UPDATE support_tickets SET updated_at = ? WHERE id = ?').run(now, id);
  return getTicket(id, 1)!.ticket;
}

export function addTicketComment(id: number, actor: string, body: string, type: 'comment' | 'user_reply' = 'comment'): SupportTicketEvent | null {
  if (!getTicket(id, 1)) return null;
  const text = clean(body, TICKET_EVENT_BODY_MAX);
  if (!text) throw new Error('comment body is required');
  insertEvent(id, short(actor, 128) || 'system', type, text);
  const row = getDb().prepare('SELECT * FROM support_ticket_events WHERE ticket_id = ? ORDER BY id DESC LIMIT 1').get(id) as Record<string, unknown>;
  return rowToEvent(row);
}

export function linkTicket(
  id: number,
  links: { issueId?: number | null; alertId?: number | null; reqId?: string | null; userId?: number | null; clientErrorId?: number | null },
  actor: string,
): SupportTicket | null {
  if (!getTicket(id, 1)) return null;
  const db = getDb();
  const sets: string[] = [];
  const params: unknown[] = [];
  if (links.issueId !== undefined) { sets.push('issue_id = ?'); params.push(links.issueId); }
  if (links.alertId !== undefined) { sets.push('alert_id = ?'); params.push(links.alertId); }
  if (links.reqId !== undefined) { sets.push('req_id = ?'); params.push(short(links.reqId, 64)); }
  if (links.userId !== undefined) { sets.push('user_id = ?'); params.push(links.userId); sets.push('tenant_id = COALESCE(tenant_id, ?)'); params.push(links.userId); }
  if (links.clientErrorId !== undefined) { sets.push('client_error_id = ?'); params.push(links.clientErrorId); }
  if (sets.length === 0) return getTicket(id, 1)!.ticket;
  db.prepare(`UPDATE support_tickets SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  insertEvent(id, short(actor, 128) || 'system', 'link', null, links as Record<string, unknown>);
  return getTicket(id, 1)!.ticket;
}

export function getSupportSummary(): SupportSummary {
  const byStatus: Record<TicketStatus, number> = { new: 0, open: 0, waiting_user: 0, resolved: 0, closed: 0 };
  const byPriority: Record<TicketPriority, number> = { p0: 0, p1: 0, p2: 0, p3: 0 };
  let newOlderThan48h = 0;
  let createdLast7d = 0;
  try {
    const db = getDb();
    for (const row of db.prepare('SELECT status, COUNT(*) AS c FROM support_tickets GROUP BY status').all() as Array<{ status: TicketStatus; c: number }>) {
      byStatus[row.status] = Number(row.c);
    }
    for (const row of db.prepare("SELECT priority, COUNT(*) AS c FROM support_tickets WHERE status IN ('new','open','waiting_user') GROUP BY priority").all() as Array<{ priority: TicketPriority; c: number }>) {
      byPriority[row.priority] = Number(row.c);
    }
    const stale = new Date(Date.now() - 48 * 3_600_000).toISOString();
    newOlderThan48h = Number((db.prepare("SELECT COUNT(*) AS c FROM support_tickets WHERE status = 'new' AND created_at < ?").get(stale) as { c?: number }).c ?? 0);
    const week = new Date(Date.now() - 7 * 86_400_000).toISOString();
    createdLast7d = Number((db.prepare('SELECT COUNT(*) AS c FROM support_tickets WHERE created_at >= ?').get(week) as { c?: number }).c ?? 0);
  } catch {
    // table missing
  }
  return { byStatus, byPriority, newOlderThan48h, createdLast7d };
}
