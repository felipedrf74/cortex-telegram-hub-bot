import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  db: null as null | InstanceType<typeof import('better-sqlite3')>,
  recordOperatorAlert: vi.fn(() => ({ ok: true })),
}));

vi.mock('../../src/services/database', () => ({ getDb: () => { if (!hoisted.db) throw new Error('db'); return hoisted.db; },
  applyMigrationFileForTest: vi.fn(),
  closeDatabase: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn(),
  initializeDatabaseCore: vi.fn(),
  runMigrationsForTest: vi.fn(),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
  withReleaseMaintenanceDatabase: vi.fn(),
}));
vi.mock('../../src/services/operator-alerts', () => ({ recordOperatorAlert: hoisted.recordOperatorAlert,
  _setOperatorAlertDeliveryConfigForTests: vi.fn(),
  _setOperatorAlertDeliverySenderForTests: vi.fn(),
  acknowledgeOperatorAlert: vi.fn(),
  deliverOperatorAlert: vi.fn(),
  getOperatorAlertDeliverySummary: vi.fn(),
  listOperatorAlerts: vi.fn(),
  processDueOperatorAlertDeliveries: vi.fn(),
  resolveOperatorAlert: vi.fn(),
  retryOperatorAlertDelivery: vi.fn(),
}));

import {
  addTicketComment,
  countUserTicketsSince,
  createTicket,
  formatTicketRef,
  getSupportSummary,
  getTicket,
  linkTicket,
  listTickets,
  listTicketsForUser,
  updateTicket,
} from '../../src/services/support-tickets';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

beforeEach(() => {
  hoisted.recordOperatorAlert.mockClear();
  hoisted.db = createMigratedTestDatabase();
});

afterEach(() => {
  hoisted.db?.close();
  hoisted.db = null;
});

describe('support tickets', () => {
  it('creates a ticket with a stable ref, sanitized text, a created event and an operator alert', () => {
    const ticket = createTicket({
      kind: 'bug', source: 'ios_feedback', title: 'Crash when opening tasks token=abcdef123456',
      body: 'Steps: open app. Contact me at felipe@example.com', userId: 7, appVersion: '1.5.1', createdBy: 'user:7',
    });
    expect(ticket.ref).toBe(formatTicketRef(ticket.id));
    expect(ticket.ref).toMatch(/^NH-T-\d{4}$/);
    expect(ticket.status).toBe('new');
    expect(ticket.priority).toBe('p3');
    expect(ticket.title).not.toContain('abcdef123456');
    expect(ticket.body).not.toContain('felipe@example.com');
    expect(ticket.tenantId).toBe(7);
    const detail = getTicket(ticket.id)!;
    expect(detail.events).toHaveLength(1);
    expect(detail.events[0]).toMatchObject({ type: 'created', actor: 'user:7', meta: { source: 'ios_feedback', kind: 'bug' } });
    expect(hoisted.recordOperatorAlert).toHaveBeenCalledWith(expect.objectContaining({ source: 'support', severity: 'info', dedupeKey: `support:ticket:${ticket.id}` }));
  });

  it('records one timeline event per changed field and stamps resolved/closed timestamps', () => {
    const t = createTicket({ kind: 'task', source: 'operator', title: 'Rotate tokens', createdBy: 'operator:felipe', quiet: true });
    expect(hoisted.recordOperatorAlert).not.toHaveBeenCalled();
    const updated = updateTicket(t.id, { status: 'open', priority: 'p1', assignee: 'felipe' }, 'operator:felipe')!;
    expect(updated).toMatchObject({ status: 'open', priority: 'p1', assignee: 'felipe', resolvedAt: null });
    const resolved = updateTicket(t.id, { status: 'resolved' }, 'operator:felipe')!;
    expect(resolved.resolvedAt).not.toBeNull();
    const reopened = updateTicket(t.id, { status: 'open' }, 'operator:felipe')!;
    expect(reopened.resolvedAt).toBeNull();
    const types = getTicket(t.id)!.events.map((e) => e.type);
    expect(types).toEqual(['created', 'status', 'priority', 'assignee', 'status', 'status']);
    expect(() => updateTicket(t.id, { status: 'bogus' as any }, 'x')).toThrow();
    expect(updateTicket(999, { status: 'open' }, 'x')).toBeNull();
  });

  it('adds comments and links, and lists with filters and priority ordering', () => {
    const low = createTicket({ kind: 'feedback', source: 'ios_feedback', title: 'Nice app', userId: 3, createdBy: 'user:3', quiet: true });
    const high = createTicket({ kind: 'incident', source: 'alert', title: 'APNs failing', priority: 'p0', alertId: 12, createdBy: 'system', quiet: true });
    expect(addTicketComment(low.id, 'operator:felipe', 'Thanks! secret=abc')!.body).toBe('Thanks! secret=[Redacted]');
    expect(addTicketComment(999, 'x', 'y')).toBeNull();
    const linked = linkTicket(low.id, { issueId: 5, reqId: 'req-1' }, 'operator:felipe')!;
    expect(linked).toMatchObject({ issueId: 5, reqId: 'req-1' });

    expect(listTickets().map((t) => t.id)).toEqual([high.id, low.id]);
    expect(listTickets({ kind: 'feedback' })).toHaveLength(1);
    expect(listTickets({ userId: 3 })[0].id).toBe(low.id);
    expect(listTickets({ q: 'apns' })[0].id).toBe(high.id);
    expect(listTickets({ q: high.ref })[0].id).toBe(high.id);
    updateTicket(high.id, { status: 'closed' }, 'x');
    expect(listTickets()).toHaveLength(1);
    expect(listTickets({ status: 'all' })).toHaveLength(2);
    expect(listTickets({ status: 'closed' })).toHaveLength(1);
  });

  it('exposes only status fields to the owning user and counts recent tickets for rate limiting', () => {
    createTicket({ kind: 'bug', source: 'ios_feedback', title: 'A', body: 'private body', userId: 9, createdBy: 'user:9', quiet: true });
    createTicket({ kind: 'bug', source: 'ios_feedback', title: 'B', userId: 9, createdBy: 'user:9', quiet: true });
    createTicket({ kind: 'bug', source: 'ios_feedback', title: 'C', userId: 10, createdBy: 'user:10', quiet: true });
    const mine = listTicketsForUser(9);
    expect(mine).toHaveLength(2);
    expect(Object.keys(mine[0]).sort()).toEqual(['createdAt', 'id', 'kind', 'ref', 'status', 'title', 'updatedAt']);
    expect(countUserTicketsSince(9, 60_000)).toBe(2);
    expect(countUserTicketsSince(11, 60_000)).toBe(0);
  });

  it('summarises the queue and tolerates a missing table', () => {
    createTicket({ kind: 'bug', source: 'operator', title: 'x', priority: 'p1', createdBy: 'o', quiet: true });
    hoisted.db!.prepare("UPDATE support_tickets SET created_at = ?").run(new Date(Date.now() - 3 * 86_400_000).toISOString());
    const summary = getSupportSummary();
    expect(summary.byStatus.new).toBe(1);
    expect(summary.byPriority.p1).toBe(1);
    expect(summary.newOlderThan48h).toBe(1);
    hoisted.db!.exec('DROP TABLE support_ticket_events; DROP TABLE support_tickets');
    expect(getSupportSummary().byStatus.new).toBe(0);
  });
});

import { getTicketByRef } from '../../src/services/support-tickets';

function eventCount(ticketId: number): number {
  return Number((hoisted.db!.prepare('SELECT COUNT(*) AS c FROM support_ticket_events WHERE ticket_id = ?').get(ticketId) as { c: number }).c);
}

describe('support tickets: validation and filter branches', () => {
  it('rejects invalid kinds, sources, titles, statuses and comments, and defaults unknown priorities', () => {
    expect(() => createTicket({ kind: 'nope' as any, source: 'operator', title: 'x', createdBy: 'op', quiet: true })).toThrow('invalid ticket kind');
    expect(() => createTicket({ kind: 'task', source: 'nope' as any, title: 'x', createdBy: 'op', quiet: true })).toThrow('invalid ticket source');
    expect(() => createTicket({ kind: 'task', source: 'operator', title: '   ', createdBy: 'op', quiet: true })).toThrow('ticket title is required');
    const ticket = createTicket({ kind: 'task', source: 'operator', title: 'Defaults', priority: 'p9' as any, createdBy: '', quiet: true });
    expect(ticket.priority).toBe('p3');
    expect(ticket.createdBy).toBe('system');
    expect(() => addTicketComment(ticket.id, 'op', '   ')).toThrow('comment body is required');
    expect(addTicketComment(999, 'op', 'hello')).toBeNull();
    expect(linkTicket(999, { issueId: 1 }, 'op')).toBeNull();
    expect(linkTicket(ticket.id, {}, 'op')?.id).toBe(ticket.id);
    expect(updateTicket(999, { status: 'open' }, 'op')).toBeNull();
    expect(() => updateTicket(ticket.id, { status: 'bogus' as any }, 'op')).toThrow('invalid ticket status');
    expect(() => updateTicket(ticket.id, { priority: 'p9' as any }, 'op')).toThrow('invalid ticket priority');
    expect(() => updateTicket(ticket.id, { kind: 'nope' as any }, 'op')).toThrow('invalid ticket kind');
  });

  it('raises a critical alert for p0 tickets and names the user in the detail', () => {
    createTicket({ kind: 'incident', source: 'alert', title: 'Outage', priority: 'p0', userId: 42, createdBy: 'op' });
    expect(hoisted.recordOperatorAlert).toHaveBeenLastCalledWith(expect.objectContaining({ severity: 'critical', detail: expect.stringContaining('for user 42') }));
    createTicket({ kind: 'task', source: 'operator', title: 'Routine', createdBy: 'op' });
    expect(hoisted.recordOperatorAlert).toHaveBeenLastCalledWith(expect.objectContaining({ severity: 'info', detail: expect.not.stringContaining('for user') }));
  });

  it('updates only what changed, normalizes due dates, and stamps lifecycle timestamps', () => {
    const t = createTicket({ kind: 'task', source: 'operator', title: 'Same', createdBy: 'op', assignee: 'ops', quiet: true });
    const before = eventCount(t.id);
    const unchanged = updateTicket(t.id, { status: 'new', priority: 'p3', kind: 'task', title: '   ', assignee: 'ops' }, 'op')!;
    expect(eventCount(t.id)).toBe(before);
    expect(unchanged.title).toBe('Same');
    const changed = updateTicket(t.id, { title: 'Renamed', externalRef: 'ext', dueAt: 'not a date' }, '')!;
    expect(changed).toMatchObject({ title: 'Renamed', externalRef: 'ext', dueAt: null });
    const due = updateTicket(t.id, { dueAt: '2026-09-10T10:00:00Z', assignee: null }, 'op')!;
    expect(due.dueAt).toBe('2026-09-10T10:00:00.000Z');
    expect(due.assignee).toBeNull();
    expect(updateTicket(t.id, { status: 'resolved' }, 'op')!.resolvedAt).not.toBeNull();
    expect(updateTicket(t.id, { status: 'open' }, 'op')!.resolvedAt).toBeNull();
    expect(updateTicket(t.id, { status: 'closed' }, 'op')!.closedAt).not.toBeNull();
    const linked = linkTicket(t.id, { userId: 9, reqId: 'req-1', clientErrorId: 3, alertId: 4, issueId: 5 }, '')!;
    expect(linked).toMatchObject({ userId: 9, tenantId: 9, reqId: 'req-1', clientErrorId: 3, alertId: 4, issueId: 5 });
  });

  it('filters lists by every dimension and escapes LIKE wildcards', () => {
    const a = createTicket({ kind: 'bug', source: 'email', title: '100% broken', priority: 'p1', userId: 1, createdBy: 'op', quiet: true });
    const b = createTicket({ kind: 'task', source: 'operator', title: 'Routine', priority: 'p3', userId: 2, createdBy: 'op', quiet: true });
    updateTicket(b.id, { status: 'closed' }, 'op');
    expect(listTickets().map((t) => t.id)).toEqual([a.id]);
    expect(listTickets({ status: 'all' }).map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
    expect(listTickets({ status: 'closed' }).map((t) => t.id)).toEqual([b.id]);
    expect(listTickets({ status: 'all', kind: 'bug' }).map((t) => t.id)).toEqual([a.id]);
    expect(listTickets({ status: 'all', priority: 'p3' }).map((t) => t.id)).toEqual([b.id]);
    expect(listTickets({ status: 'all', source: 'email' }).map((t) => t.id)).toEqual([a.id]);
    expect(listTickets({ status: 'all', userId: 2 }).map((t) => t.id)).toEqual([b.id]);
    expect(listTickets({ status: 'all', q: '100%' }).map((t) => t.id)).toEqual([a.id]);
    expect(listTickets({ status: 'all', q: '_' })).toEqual([]);
    expect(listTickets({ status: 'all', limit: 1 })).toHaveLength(1);
    expect(getTicketByRef(a.ref)?.id).toBe(a.id);
    expect(getTicketByRef('NH-T-9999')).toBeNull();
    expect(listTicketsForUser(1)).toHaveLength(1);
    expect(countUserTicketsSince(1, 60_000)).toBe(1);
  });
});
