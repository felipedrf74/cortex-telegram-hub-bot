import Database from 'better-sqlite3';
import express from 'express';
import http from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

const hoisted = vi.hoisted(() => ({ db: null as null | InstanceType<typeof import('better-sqlite3')> }));

vi.mock('../../src/services/database', () => ({ getDb: () => hoisted.db }));
vi.mock('../../src/api/tenant-route-scope', () => ({ ensureValidTenantRouteScope: () => true }));
vi.mock('../../src/services/operator-alerts', () => ({ recordOperatorAlert: vi.fn(() => ({ ok: true })) }));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

import { clientErrorsRoutes } from '../../src/api/routes/client-errors';

let server: http.Server;
let port = 0;

beforeEach(async () => {
  hoisted.db = createMigratedTestDatabase();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).userId = 42; next(); });
  app.use('/api/v1/client-errors', clientErrorsRoutes());
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  hoisted.db?.close();
  hoisted.db = null;
});

async function post(body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/client-errors`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

describe('client error reports link to issues and request ids', () => {
  it('groups repeated reports into one issue and stores the request id', async () => {
    const first = await post({ message: 'Crash in TaskListView row 12', stack: 'Foo\n  at bar (TaskListView.swift:10:2)', appVersion: '1.5.1', requestId: 'req-abc' });
    const second = await post({ message: 'Crash in TaskListView row 99', stack: 'Foo\n  at bar (TaskListView.swift:44:9)', appVersion: '1.5.2' });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const rows = hoisted.db!.prepare('SELECT id, req_id, issue_id, user_id FROM client_errors ORDER BY id').all() as Array<{ id: number; req_id: string | null; issue_id: number; user_id: number }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].req_id).toBe('req-abc');
    expect(rows[1].req_id).toBeNull();
    expect(rows[0].issue_id).toBe(rows[1].issue_id);
    expect(rows[0].user_id).toBe(42);

    const issue = hoisted.db!.prepare('SELECT kind, source, occurrence_count, last_app_version, last_req_id, last_user_id FROM issues').get() as Record<string, unknown>;
    expect(issue).toEqual({ kind: 'client', source: 'ios', occurrence_count: 2, last_app_version: '1.5.2', last_req_id: 'req-abc', last_user_id: 42 });
  });

  it('ignores an oversized request id and still persists the report', async () => {
    const res = await post({ message: 'x', requestId: 'r'.repeat(80) });
    expect(res.status).toBe(200);
    const row = hoisted.db!.prepare('SELECT req_id FROM client_errors').get() as { req_id: string | null };
    expect(row.req_id).toHaveLength(64);
  });
});
