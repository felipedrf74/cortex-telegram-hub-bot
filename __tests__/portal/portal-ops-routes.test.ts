import Database from 'better-sqlite3';
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

const hoisted = vi.hoisted(() => ({
  db: null as null | InstanceType<typeof import('better-sqlite3')>,
  requirePortalAdminToken: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  logPortalAdminMutation: vi.fn(),
  sendPortalInternalError: vi.fn(),
  listOperatorAlerts: vi.fn(() => [] as unknown[]),
  getOperatorAlertDeliverySummary: vi.fn(() => ({ pending: 0 })),
  recordOperatorAlert: vi.fn(() => ({ ok: true })),
}));

vi.mock('../../src/services/database', () => ({ getDb: () => hoisted.db }));
vi.mock('../../src/api/secret-guards', () => ({
  requirePortalAdminToken: hoisted.requirePortalAdminToken,
  getPortalAuthContext: () => ({ actorHint: 'operator@nexushub.me' }),
  extractPortalActorHint: () => undefined,
}));
vi.mock('../../src/portal/admin-audit', () => ({ logPortalAdminMutation: hoisted.logPortalAdminMutation }));
vi.mock('../../src/portal/http', () => ({ sendPortalInternalError: hoisted.sendPortalInternalError }));
vi.mock('../../src/services/operator-alerts', () => ({
  listOperatorAlerts: hoisted.listOperatorAlerts,
  getOperatorAlertDeliverySummary: hoisted.getOperatorAlertDeliverySummary,
  recordOperatorAlert: hoisted.recordOperatorAlert,
}));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

import { registerPortalOpsRoutes, parseLogLevel } from '../../src/portal/ops-routes';
import { _resetLogStoreForTests, attachLogStoreDb, flushLogStore, ingestLogObject } from '../../src/utils/log-store';
import { _resetHttpRequestLogForTests, attachHttpRequestLogDb, flushHttpRequestLog, recordHttpRequest } from '../../src/api/http-request-log';
import { upsertIssue } from '../../src/services/issue-tracker';
import { _resetSseForTests } from '../../src/portal/sse';

type Handler = (req: any, res: any) => void;

function makeApp() {
  const routes = new Map<string, Handler[]>();
  const app = {
    get: vi.fn((p: string, ...h: Handler[]) => { routes.set(`GET ${p}`, h); }),
    post: vi.fn((p: string, ...h: Handler[]) => { routes.set(`POST ${p}`, h); }),
  };
  registerPortalOpsRoutes(app as any);
  return { app, routes };
}

function makeRes() {
  const payload: { statusCode: number; body?: any; headers: Record<string, string> } = { statusCode: 200, headers: {} };
  const res: any = new EventEmitter();
  res.status = (c: number) => { payload.statusCode = c; return res; };
  res.json = (b: unknown) => { payload.body = b; return res; };
  res.setHeader = (k: string, v: string) => { payload.headers[k.toLowerCase()] = v; };
  res.flushHeaders = vi.fn();
  res.chunks = [] as string[];
  res.write = (c: string) => { res.chunks.push(c); return true; };
  res.end = vi.fn();
  return { res, payload };
}

function call(routes: Map<string, Handler[]>, key: string, req: any = {}) {
  const handlers = routes.get(key);
  if (!handlers) throw new Error(`route ${key} not registered`);
  const { res, payload } = makeRes();
  const request = Object.assign(new EventEmitter(), { query: {}, params: {}, body: {}, method: key.split(' ')[0] }, req);
  handlers[handlers.length - 1](request, res);
  return { payload, res, request };
}

beforeEach(() => {
  _resetLogStoreForTests();
  _resetHttpRequestLogForTests();
  _resetSseForTests();
  hoisted.db = createMigratedTestDatabase();
  attachLogStoreDb(() => hoisted.db!);
  attachHttpRequestLogDb(() => hoisted.db!);
  hoisted.logPortalAdminMutation.mockClear();
  hoisted.sendPortalInternalError.mockClear();
});

afterEach(() => {
  _resetLogStoreForTests();
  _resetHttpRequestLogForTests();
  hoisted.db?.close();
  hoisted.db = null;
});

describe('portal ops routes', () => {
  it('registers the observability route family with admin guards on mutations', () => {
    const { routes } = makeApp();
    const keys = Array.from(routes.keys());
    expect(keys).toEqual(expect.arrayContaining([
      'GET /api/ops/logs', 'GET /api/ops/logs/stream', 'GET /api/ops/logs/status',
      'GET /api/ops/requests', 'GET /api/ops/requests/:reqId', 'GET /api/ops/latency', 'GET /api/ops/rate-limits',
      'GET /api/ops/issues', 'GET /api/ops/issues/summary', 'GET /api/ops/issues/:id',
      'POST /api/ops/issues/:id/ack', 'POST /api/ops/issues/:id/resolve', 'POST /api/ops/issues/:id/mute', 'POST /api/ops/issues/:id/reopen',
      'GET /api/ops/client-errors', 'GET /api/ops/alerts/stream',
    ]));
    for (const key of keys.filter((k) => k.startsWith('POST'))) {
      expect(routes.get(key)![0]).toBe(hoisted.requirePortalAdminToken);
    }
    expect(parseLogLevel('warn')).toBe(40);
    expect(parseLogLevel('50')).toBe(50);
  });

  it('serves runtime logs with filters and the store status', () => {
    ingestLogObject({ level: 30, time: Date.now(), msg: 'info line', reqId: 'r1', src: 'http' });
    ingestLogObject({ level: 50, time: Date.now(), msg: 'error line', reqId: 'r1', src: 'http' });
    flushLogStore();
    const { routes } = makeApp();

    const all = call(routes, 'GET /api/ops/logs', { query: { reqId: 'r1' } }).payload.body;
    expect(all.ok).toBe(true);
    expect(all.logs.map((l: any) => l.msg)).toEqual(['error line', 'info line']);
    const errors = call(routes, 'GET /api/ops/logs', { query: { level: 'error' } }).payload.body;
    expect(errors.logs).toHaveLength(1);
    const status = call(routes, 'GET /api/ops/logs/status').payload.body;
    expect(status.store).toMatchObject({ dbAttached: true, rowCount: 2 });
  });

  it('streams the live tail over SSE with a ring replay', () => {
    ingestLogObject({ level: 40, time: Date.now(), msg: 'earlier warn' });
    const { routes } = makeApp();
    const { res, request } = call(routes, 'GET /api/ops/logs/stream', { query: { level: 'warn' } });
    expect(res.chunks[0]).toBe(': connected\n\n');
    expect(res.chunks[1]).toContain('"msg":"earlier warn"');
    ingestLogObject({ level: 20, time: Date.now(), msg: 'debug ignored' });
    ingestLogObject({ level: 50, time: Date.now(), msg: 'live error' });
    expect(res.chunks).toHaveLength(3);
    expect(res.chunks[2]).toContain('"msg":"live error"');
    request.emit('close');
    ingestLogObject({ level: 50, time: Date.now(), msg: 'after close' });
    expect(res.chunks).toHaveLength(3);
  });

  it('correlates a request id across the ledger, logs and errors', () => {
    recordHttpRequest({ ts: new Date().toISOString(), reqId: 'req-9', surface: 'ios', method: 'GET', path: '/api/v1/tasks', route: '/api/v1/tasks', status: 500, durationMs: 40, userId: 3, ipHash: 'h', userAgent: 'ua', bytesOut: 10, sampled: false });
    flushHttpRequestLog();
    ingestLogObject({ level: 50, time: Date.now(), msg: 'handler blew up', reqId: 'req-9' });
    flushLogStore();
    const issue = upsertIssue({ kind: 'server', source: 'api', level: 'error', message: 'handler blew up', reqId: 'req-9' })!;
    hoisted.db!.prepare("INSERT INTO error_log (level, source, message, req_id, issue_id) VALUES ('error', 'api', 'handler blew up', 'req-9', ?)").run(issue.issueId);
    const { routes } = makeApp();

    const detail = call(routes, 'GET /api/ops/requests/:reqId', { params: { reqId: 'req-9' } }).payload.body;
    expect(detail.request).toMatchObject({ reqId: 'req-9', status: 500, userId: 3 });
    expect(detail.logs.map((l: any) => l.msg)).toEqual(['handler blew up']);
    expect(detail.errors.server[0]).toMatchObject({ issue_id: issue.issueId });
    expect(call(routes, 'GET /api/ops/requests/:reqId', { params: { reqId: 'missing' } }).payload.statusCode).toBe(404);

    const list = call(routes, 'GET /api/ops/requests', { query: { statusClass: '5' } }).payload.body;
    expect(list.requests).toHaveLength(1);
    const latency = call(routes, 'GET /api/ops/latency', { query: { window: '15m' } }).payload.body;
    expect(latency.window).toBe('15m');
    expect(latency.routes[0]).toMatchObject({ route: '/api/v1/tasks', count: 1, errorCount: 1 });
    expect(call(routes, 'GET /api/ops/rate-limits').payload.body.ok).toBe(true);
  });

  it('lists, details and transitions issues with an admin audit row', () => {
    const created = upsertIssue({ kind: 'client', source: 'ios', level: 'error', message: 'Crash A', appVersion: '1.0' })!;
    const { routes } = makeApp();

    const list = call(routes, 'GET /api/ops/issues', { query: { status: 'open', kind: 'client' } }).payload.body;
    expect(list.issues).toHaveLength(1);
    expect(list.summary.byStatus.open).toBe(1);

    const ack = call(routes, 'POST /api/ops/issues/:id/ack', { params: { id: String(created.issueId) }, body: { notes: 'looking' } }).payload;
    expect(ack.body).toEqual({ ok: true, status: 'acked' });
    expect(hoisted.logPortalAdminMutation).toHaveBeenCalledWith(expect.anything(), 0, 'issue.ack', expect.objectContaining({ issueId: created.issueId, status: 'acked' }));

    const detail = call(routes, 'GET /api/ops/issues/:id', { params: { id: String(created.issueId) } }).payload.body;
    expect(detail.issue).toMatchObject({ status: 'acked', notes: 'looking' });
    expect(call(routes, 'POST /api/ops/issues/:id/resolve', { params: { id: '999' } }).payload.statusCode).toBe(404);
    expect(call(routes, 'GET /api/ops/issues/:id', { params: { id: 'abc' } }).payload.statusCode).toBe(400);
    expect(call(routes, 'GET /api/ops/issues/summary').payload.body.byStatus.acked).toBe(1);
  });

  it('exposes raw client error rows and pushes alert deltas over SSE', () => {
    hoisted.db!.prepare("INSERT INTO client_errors (user_id, source, level, message, app_version) VALUES (5, 'ios', 'fatal', 'Crash', '2.0')").run();
    hoisted.listOperatorAlerts.mockReturnValue([{ id: 1, status: 'open', updatedAt: 'x', deliveryStatus: 'pending' }]);
    const { routes } = makeApp();

    const errors = call(routes, 'GET /api/ops/client-errors', { query: { userId: '5' } }).payload.body;
    expect(errors.errors).toHaveLength(1);
    expect(JSON.stringify(errors)).not.toContain('stack');

    const { res, request } = call(routes, 'GET /api/ops/alerts/stream');
    expect(res.chunks[1]).toContain('event: alerts');
    expect(res.chunks[1]).toContain('"issues"');
    request.emit('close');
  });

  it('routes failures through the shared sanitized error helper', () => {
    hoisted.db!.exec('DROP TABLE runtime_logs');
    const { routes } = makeApp();
    call(routes, 'GET /api/ops/logs');
    expect(hoisted.sendPortalInternalError).toHaveBeenCalledWith(expect.anything(), expect.any(Error), 'Portal request failed', 'Portal: ops logs request failed');
  });
});
