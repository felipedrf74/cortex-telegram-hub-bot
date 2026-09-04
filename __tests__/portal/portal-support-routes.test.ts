import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

const hoisted = vi.hoisted(() => ({
  db: null as null | InstanceType<typeof import('better-sqlite3')>,
  requirePortalAdminToken: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  logPortalAdminMutation: vi.fn(),
  sendPortalInternalError: vi.fn(),
  listOperatorAlerts: vi.fn(() => [] as unknown[]),
  recordOperatorAlert: vi.fn(() => ({ ok: true })),
}));

vi.mock('../../src/services/database', () => ({ getDb: () => hoisted.db }));
vi.mock('../../src/api/secret-guards', () => ({
  requirePortalAdminToken: hoisted.requirePortalAdminToken,
  getPortalAuthContext: () => ({ actorHint: 'felipe' }),
  extractPortalActorHint: () => undefined,
}));
vi.mock('../../src/portal/admin-audit', () => ({ logPortalAdminMutation: hoisted.logPortalAdminMutation }));
vi.mock('../../src/portal/http', () => ({ sendPortalInternalError: hoisted.sendPortalInternalError }));
vi.mock('../../src/services/operator-alerts', () => ({
  listOperatorAlerts: hoisted.listOperatorAlerts,
  recordOperatorAlert: hoisted.recordOperatorAlert,
}));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

import { registerPortalSupportRoutes } from '../../src/portal/support-routes';
import { upsertIssue } from '../../src/services/issue-tracker';

type Handler = (req: any, res: any) => void;

function makeApp() {
  const routes = new Map<string, Handler[]>();
  const reg = (method: string) => vi.fn((p: string, ...h: Handler[]) => { routes.set(`${method} ${p}`, h); });
  const app = { get: reg('GET'), post: reg('POST'), patch: reg('PATCH'), put: reg('PUT'), delete: reg('DELETE') };
  registerPortalSupportRoutes(app as any);
  return { routes };
}

function call(routes: Map<string, Handler[]>, key: string, req: any = {}) {
  const handlers = routes.get(key);
  if (!handlers) throw new Error(`route ${key} not registered`);
  const payload: { statusCode: number; body?: any } = { statusCode: 200 };
  const res: any = { status: (c: number) => { payload.statusCode = c; return res; }, json: (b: unknown) => { payload.body = b; return res; } };
  handlers[handlers.length - 1]({ query: {}, params: {}, body: {}, ...req }, res);
  return payload;
}

beforeEach(() => {
  hoisted.db = createMigratedTestDatabase();
  hoisted.logPortalAdminMutation.mockClear();
  hoisted.sendPortalInternalError.mockClear();
});

afterEach(() => {
  hoisted.db?.close();
  hoisted.db = null;
});

describe('portal support routes', () => {
  it('guards every mutation with the admin token', () => {
    const { routes } = makeApp();
    const mutations = Array.from(routes.keys()).filter((k) => !k.startsWith('GET'));
    expect(mutations).toEqual(expect.arrayContaining([
      'POST /api/support/tickets', 'PATCH /api/support/tickets/:id', 'POST /api/support/tickets/:id/events',
      'POST /api/support/tickets/:id/link', 'POST /api/ops/issues/:id/ticket', 'POST /api/operator-alerts/:id/ticket',
    ]));
    for (const key of mutations) expect(routes.get(key)![0]).toBe(hoisted.requirePortalAdminToken);
  });

  it('creates, lists, updates, comments on and links tickets with audit rows', () => {
    const { routes } = makeApp();
    const created = call(routes, 'POST /api/support/tickets', { body: { title: 'Rotate staging token', kind: 'task', priority: 'p2', userId: '4' } });
    expect(created.statusCode).toBe(201);
    const id = created.body.ticket.id;
    expect(created.body.ticket).toMatchObject({ kind: 'task', priority: 'p2', userId: 4, createdBy: 'operator:felipe' });
    expect(hoisted.logPortalAdminMutation).toHaveBeenCalledWith(expect.anything(), 4, 'support_ticket.create', expect.objectContaining({ ticketId: id }));
    expect(call(routes, 'POST /api/support/tickets', { body: {} }).statusCode).toBe(400);

    const list = call(routes, 'GET /api/support/tickets', { query: { status: 'active', kind: 'task' } }).body;
    expect(list.tickets).toHaveLength(1);
    expect(list.summary.byStatus.new).toBe(1);
    expect(call(routes, 'GET /api/support/summary').body.byStatus.new).toBe(1);

    expect(call(routes, 'PATCH /api/support/tickets/:id', { params: { id: String(id) }, body: { status: 'bogus' } }).statusCode).toBe(400);
    const patched = call(routes, 'PATCH /api/support/tickets/:id', { params: { id: String(id) }, body: { status: 'open', assignee: 'felipe' } });
    expect(patched.body.ticket).toMatchObject({ status: 'open', assignee: 'felipe' });
    expect(call(routes, 'PATCH /api/support/tickets/:id', { params: { id: '999' }, body: { status: 'open' } }).statusCode).toBe(404);

    const commented = call(routes, 'POST /api/support/tickets/:id/events', { params: { id: String(id) }, body: { body: 'Working on it' } });
    expect(commented.statusCode).toBe(201);
    expect(commented.body.event).toMatchObject({ type: 'comment', body: 'Working on it', actor: 'operator:felipe' });
    expect(call(routes, 'POST /api/support/tickets/:id/events', { params: { id: String(id) }, body: {} }).statusCode).toBe(400);

    const linked = call(routes, 'POST /api/support/tickets/:id/link', { params: { id: String(id) }, body: { reqId: 'req-1', alertId: '8' } });
    expect(linked.body.ticket).toMatchObject({ reqId: 'req-1', alertId: 8 });

    const detail = call(routes, 'GET /api/support/tickets/:id', { params: { id: String(id) } }).body;
    expect(detail.events.map((e: any) => e.type)).toEqual(['created', 'status', 'assignee', 'comment', 'link']);
    expect(call(routes, 'GET /api/support/tickets/:id', { params: { id: 'x' } }).statusCode).toBe(400);
  });

  it('promotes an issue and an alert into tickets', () => {
    const issue = upsertIssue({ kind: 'client', source: 'ios', level: 'fatal', message: 'Crash', userId: 6, appVersion: '1.2', reqId: 'r9' })!;
    hoisted.listOperatorAlerts.mockReturnValue([{ id: 21, severity: 'critical', title: 'APNs dead letter', detail: 'Delivery failed 3x' }]);
    const { routes } = makeApp();

    const fromIssue = call(routes, 'POST /api/ops/issues/:id/ticket', { params: { id: String(issue.issueId) }, body: {} });
    expect(fromIssue.statusCode).toBe(201);
    expect(fromIssue.body.ticket).toMatchObject({ kind: 'bug', source: 'issue', priority: 'p1', issueId: issue.issueId, userId: 6, reqId: 'r9', appVersion: '1.2' });
    expect(call(routes, 'POST /api/ops/issues/:id/ticket', { params: { id: '999' } }).statusCode).toBe(404);

    const fromAlert = call(routes, 'POST /api/operator-alerts/:id/ticket', { params: { id: '21' } });
    expect(fromAlert.statusCode).toBe(201);
    expect(fromAlert.body.ticket).toMatchObject({ kind: 'incident', source: 'alert', priority: 'p1', alertId: 21, body: 'Delivery failed 3x' });
    expect(call(routes, 'POST /api/operator-alerts/:id/ticket', { params: { id: '22' } }).statusCode).toBe(404);
  });

  it('routes failures through the shared sanitized error helper', () => {
    hoisted.db!.exec('DROP TABLE support_ticket_events; DROP TABLE support_tickets');
    const { routes } = makeApp();
    call(routes, 'GET /api/support/tickets');
    expect(hoisted.sendPortalInternalError).toHaveBeenCalledWith(expect.anything(), expect.any(Error), 'Portal request failed', 'Portal: support tickets request failed');
  });
});
