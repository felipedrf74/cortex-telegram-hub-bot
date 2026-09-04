import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  db: null as null | InstanceType<typeof import('better-sqlite3')>,
  recordOperatorAlert: vi.fn(() => ({ ok: true })),
}));

vi.mock('../../src/services/database', () => ({ getDb: () => { if (!hoisted.db) throw new Error('db'); return hoisted.db; } }));
vi.mock('../../src/services/operator-alerts', () => ({ recordOperatorAlert: hoisted.recordOperatorAlert }));

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
