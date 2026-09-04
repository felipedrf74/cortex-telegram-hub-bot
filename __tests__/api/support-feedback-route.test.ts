import Database from 'better-sqlite3';
import express from 'express';
import http from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

const hoisted = vi.hoisted(() => ({
  db: null as null | InstanceType<typeof import('better-sqlite3')>,
  recordOperatorAlert: vi.fn(() => ({ ok: true })),
}));

vi.mock('../../src/services/database', () => ({ getDb: () => hoisted.db,
  applyMigrationFileForTest: vi.fn(),
  closeDatabase: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn(),
  initializeDatabaseCore: vi.fn(),
  runMigrationsForTest: vi.fn(),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
  withReleaseMaintenanceDatabase: vi.fn(),
}));
vi.mock('../../src/api/tenant-route-scope', () => ({ ensureValidTenantRouteScope: () => true }));
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
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

import { FEEDBACK_MAX_PER_HOUR, pickFeedbackContext, supportRoutes } from '../../src/api/routes/support';

let server: http.Server;
let port = 0;

beforeEach(async () => {
  hoisted.recordOperatorAlert.mockClear();
  hoisted.db = createMigratedTestDatabase();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).userId = 42; (req as any).tenantId = 42; (req as any).deviceId = 'dev-1'; next(); });
  app.use('/api/v1/support', supportRoutes());
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  hoisted.db?.close();
  hoisted.db = null;
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/support${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

describe('iOS support feedback intake', () => {
  it('creates a ticket with allowlisted diagnostics and returns the reference', async () => {
    const res = await call('POST', '/feedback', {
      kind: 'bug', title: 'Tasks screen crashes', message: 'It crashes when I tap a task. my token=abcdef123456',
      requestId: 'req-77', context: { screen: 'TaskList', appVersion: '1.5.1', osVersion: 'iOS 19.0', lastClientErrorId: 3 },
    });
    expect(res.status).toBe(201);
    expect(res.json.data.ref).toMatch(/^NH-T-\d{4}$/);
    const row = hoisted.db!.prepare('SELECT kind, source, priority, user_id, tenant_id, device_id, app_version, os_version, screen, req_id, client_error_id, body FROM support_tickets').get() as Record<string, unknown>;
    expect(row).toMatchObject({ kind: 'bug', source: 'ios_feedback', priority: 'p2', user_id: 42, tenant_id: 42, device_id: 'dev-1', app_version: '1.5.1', os_version: 'iOS 19.0', screen: 'TaskList', req_id: 'req-77', client_error_id: 3 });
    expect(String(row.body)).not.toContain('abcdef123456');
    expect(hoisted.recordOperatorAlert).toHaveBeenCalledTimes(1);
  });

  it('rejects unexpected context keys and empty messages', async () => {
    expect((await call('POST', '/feedback', { message: 'x', context: { chatHistory: ['secret'] } })).status).toBe(400);
    expect((await call('POST', '/feedback', { message: '   ' })).status).toBe(400);
    expect(hoisted.db!.prepare('SELECT COUNT(*) AS c FROM support_tickets').get()).toEqual({ c: 0 });
    expect(pickFeedbackContext({ screen: 'X', messages: [] }).rejectedKeys).toEqual(['messages']);
  });

  it('rate limits to five tickets per user per hour', async () => {
    for (let i = 0; i < FEEDBACK_MAX_PER_HOUR; i += 1) {
      expect((await call('POST', '/feedback', { message: `report ${i}` })).status).toBe(201);
    }
    const limited = await call('POST', '/feedback', { message: 'one too many' });
    expect(limited.status).toBe(429);
    expect(limited.json.error.code).toBe('RATE_LIMITED');
  });

  it('lists the caller\'s own tickets without operator-only fields', async () => {
    await call('POST', '/feedback', { message: 'hello', kind: 'question' });
    hoisted.db!.prepare("INSERT INTO support_tickets (ref, kind, source, title, user_id, created_by) VALUES ('NH-T-9999', 'task', 'operator', 'other user', 43, 'o')").run();
    const res = await call('GET', '/feedback/mine');
    expect(res.status).toBe(200);
    expect(res.json.data.tickets).toHaveLength(1);
    expect(res.json.data.tickets[0]).toMatchObject({ kind: 'question', status: 'new' });
    expect(res.json.data.tickets[0]).not.toHaveProperty('assignee');
    expect(res.json.data.tickets[0]).not.toHaveProperty('body');
  });
});
