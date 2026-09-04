import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

const hoisted = vi.hoisted(() => ({
  db: null as null | InstanceType<typeof import('better-sqlite3')>,
  sendPortalInternalError: vi.fn(),
}));

vi.mock('../../src/services/database', () => ({ getDb: () => hoisted.db }));
vi.mock('../../src/api/secret-guards', () => ({
  requirePortalAdminToken: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../src/portal/admin-target-user', () => ({
  requireOperatorTargetUser: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../src/portal/http', () => ({ sendPortalInternalError: hoisted.sendPortalInternalError }));
vi.mock('../../src/services/user-data-export', () => ({ countUserFinanceData: () => ({ transactions: 0, taxEvents: 0 }) }));

import {
  auditRowsToCsv,
  buildAuditWhere,
  normalizeAuditTimestamp,
  parseAuditFilters,
  registerPortalAdminDataRoutes,
} from '../../src/portal/admin-data-routes';

type Handler = (req: any, res: any) => void;

function makeApp() {
  const routes = new Map<string, Handler[]>();
  const app = {
    use: vi.fn(),
    get: vi.fn((p: string, ...h: Handler[]) => { routes.set(`GET ${p}`, h); }),
    post: vi.fn((p: string, ...h: Handler[]) => { routes.set(`POST ${p}`, h); }),
  };
  registerPortalAdminDataRoutes(app as any);
  return { app, routes };
}

function call(routes: Map<string, Handler[]>, key: string, req: any = {}) {
  const handlers = routes.get(key);
  if (!handlers) throw new Error(`route ${key} not registered`);
  const payload: { statusCode: number; body?: any; text?: string; headers: Record<string, string> } = { statusCode: 200, headers: {} };
  const res: any = {
    status: (c: number) => { payload.statusCode = c; return res; },
    json: (b: unknown) => { payload.body = b; return res; },
    send: (b: string) => { payload.text = b; return res; },
    setHeader: (k: string, v: string) => { payload.headers[k.toLowerCase()] = v; },
  };
  handlers[handlers.length - 1]({ query: {}, params: {}, body: {}, ...req }, res);
  return payload;
}

function db(): Database.Database {
  return hoisted.db as Database.Database;
}

function insertAudit(row: { ts: string; userId: number; actorId?: number; action: string; resource: string; details?: string | null; ip?: string | null }): void {
  db().prepare('INSERT INTO audit_trail (ts, user_id, actor_id, action, resource, details, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(row.ts, row.userId, row.actorId ?? row.userId, row.action, row.resource, row.details ?? null, row.ip ?? null);
}

beforeEach(() => {
  hoisted.db = createMigratedTestDatabase();
  hoisted.sendPortalInternalError.mockClear();
  insertAudit({ ts: '2026-09-01 10:00:00', userId: 1, action: 'admin_mutation', resource: 'issue.ack', details: '{"issueId":4}' });
  insertAudit({ ts: '2026-09-02 10:00:00', userId: 2, actorId: 1, action: 'admin_mutation', resource: 'user.status', details: '{"status":"suspended"}' });
  insertAudit({ ts: '2026-09-03 10:00:00', userId: 2, action: 'data_export', resource: 'user_data', details: '=cmd|calc' });
  insertAudit({ ts: '2026-09-04 10:00:00', userId: 3, action: 'login', resource: 'session', details: null });
});

afterEach(() => {
  db().close();
});

describe('audit filter parsing', () => {
  it('normalizes timestamps to SQLite text in UTC', () => {
    expect(normalizeAuditTimestamp('2026-09-04T12:00:00+02:00')).toBe('2026-09-04 10:00:00');
    expect(normalizeAuditTimestamp('2026-09-04 10:00:00')).toBe('2026-09-04 10:00:00');
    expect(normalizeAuditTimestamp('2026-09-04')).toBe('2026-09-04 00:00:00');
    expect(normalizeAuditTimestamp('yesterday')).toBeNull();
    expect(normalizeAuditTimestamp(undefined)).toBeNull();
  });

  it('parses and bounds every filter, dropping unsafe tokens', () => {
    const filters = parseAuditFilters({
      userId: '2', actorId: '1', action: 'admin_mutation', resource: 'issue.', q: 'x'.repeat(200),
      since: '2026-09-01', until: '2026-09-05', beforeId: '10', limit: '9999', format: 'csv',
    } as any);
    expect(filters).toEqual({
      userId: 2, actorId: 1, action: 'admin_mutation', resource: 'issue.', q: 'x'.repeat(120),
      since: '2026-09-01 00:00:00', until: '2026-09-05 00:00:00', beforeId: 10, limit: 500, format: 'csv',
    });
    expect(parseAuditFilters({ action: 'drop table;', resource: 'a b', userId: 'abc', format: 'xml' } as any))
      .toMatchObject({ action: null, resource: null, userId: null, format: 'json', limit: 50 });
  });

  it('escapes LIKE wildcards in resource and q filters', () => {
    const { where, params } = buildAuditWhere(parseAuditFilters({ resource: 'user_', q: '100%' } as any));
    expect(where).toContain("resource LIKE ? ESCAPE '\\'");
    expect(params).toEqual(['user\\_%', '%100\\%%', '%100\\%%']);
  });
});

describe('GET /api/audit-trail', () => {
  it('filters by action, resource prefix, actor, date range and free text', () => {
    const { routes } = makeApp();
    expect(call(routes, 'GET /api/audit-trail').body.entries).toHaveLength(4);
    expect(call(routes, 'GET /api/audit-trail', { query: { action: 'admin_mutation' } }).body.entries.map((e: any) => e.resource)).toEqual(['user.status', 'issue.ack']);
    expect(call(routes, 'GET /api/audit-trail', { query: { resource: 'user' } }).body.entries.map((e: any) => e.resource)).toEqual(['user_data', 'user.status']);
    expect(call(routes, 'GET /api/audit-trail', { query: { actorId: '1' } }).body.entries).toHaveLength(2);
    expect(call(routes, 'GET /api/audit-trail', { query: { userId: '2' } }).body.entries).toHaveLength(2);
    expect(call(routes, 'GET /api/audit-trail', { query: { since: '2026-09-02', until: '2026-09-03T23:59:59Z' } }).body.entries.map((e: any) => e.action)).toEqual(['data_export', 'admin_mutation']);
    expect(call(routes, 'GET /api/audit-trail', { query: { q: 'suspended' } }).body.entries.map((e: any) => e.user_id)).toEqual([2]);
  });

  it('pages with beforeId and reports the next cursor', () => {
    const { routes } = makeApp();
    const first = call(routes, 'GET /api/audit-trail', { query: { limit: '2' } });
    expect(first.body.entries.map((e: any) => e.action)).toEqual(['login', 'data_export']);
    expect(first.body.nextBeforeId).toBe(first.body.entries[1].id);
    const second = call(routes, 'GET /api/audit-trail', { query: { limit: '2', beforeId: String(first.body.nextBeforeId) } });
    expect(second.body.entries.map((e: any) => e.action)).toEqual(['admin_mutation', 'admin_mutation']);
    expect(second.body.nextBeforeId).toBe(second.body.entries[1].id);
    const third = call(routes, 'GET /api/audit-trail', { query: { limit: '2', beforeId: String(second.body.nextBeforeId) } });
    expect(third.body.entries).toEqual([]);
    expect(third.body.nextBeforeId).toBeNull();
  });

  it('exports the filtered selection as CSV with formula-injection guards', () => {
    const { routes } = makeApp();
    const payload = call(routes, 'GET /api/audit-trail', { query: { format: 'csv', userId: '2' } });
    expect(payload.statusCode).toBe(200);
    expect(payload.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(payload.headers['content-disposition']).toMatch(/^attachment; filename="audit-trail-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(payload.body).toBeUndefined();
    const lines = payload.text!.trim().split('\n');
    expect(lines[0]).toBe('id,ts,user_id,actor_id,action,resource,details,ip_address');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('"\'=cmd|calc"');
    expect(lines[2]).toContain('"{""status"":""suspended""}"');
  });

  it('serves facets for dropdowns', () => {
    const { routes } = makeApp();
    const payload = call(routes, 'GET /api/audit-trail/facets');
    expect(payload.body.actions).toEqual([
      { value: 'admin_mutation', count: 2 },
      { value: 'data_export', count: 1 },
      { value: 'login', count: 1 },
    ]);
    expect(payload.body.resources.map((r: any) => r.value)).toHaveLength(4);
  });
});

describe('auditRowsToCsv', () => {
  it('quotes every cell and escapes embedded quotes', () => {
    const csv = auditRowsToCsv([{ id: 1, ts: 't', user_id: 1, actor_id: 2, action: 'a "b"', resource: 'r', details: null, ip_address: '-1.2' }]);
    expect(csv).toBe('id,ts,user_id,actor_id,action,resource,details,ip_address\n"1","t","1","2","a ""b""","r",,"\'-1.2"\n');
  });
});
