import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'express';
import Database from 'better-sqlite3';
import type { Request, Response } from 'express';

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

import { registerContentNotificationRoutes } from '../../src/api/routes/content-notification-routes';
import { createNotification } from '../../src/services/content-notification-store';

interface MockRes {
  statusCode: number;
  body: any;
  status(code: number): MockRes;
  json(body: any): MockRes;
}

function mockRes(): MockRes {
  const response: MockRes = {
    statusCode: 200,
    body: null,
    status(code: number) { response.statusCode = code; return response; },
    json(body: any) { response.body = body; return response; },
  };
  return response;
}

function mockReq(path: string, userId: number | undefined = 501, tenantId = 101): Request {
  return {
    userId,
    tenantId,
    method: 'GET',
    url: path,
    originalUrl: path,
    baseUrl: '',
    path,
    query: {},
    params: {},
    body: {},
    headers: {},
    header: () => undefined,
  } as any;
}

function makeEnsureValidScope() {
  return vi.fn((
    res: Response,
    userId: number | undefined,
  ): userId is number => {
    if (typeof userId === 'number' && userId > 0) return true;
    res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid authenticated user scope' } });
    return false;
  });
}

async function dispatch(
  path: string,
  userId: number | undefined = 501,
  tenantId = 101,
  ensureValidScope = makeEnsureValidScope(),
): Promise<{ response: MockRes; ensureValidScope: ReturnType<typeof makeEnsureValidScope> }> {
  const router = Router();
  registerContentNotificationRoutes(router, ensureValidScope);
  const req = mockReq(path, userId, tenantId);
  const res = mockRes();

  await new Promise<void>((resolve, reject) => {
    (router as any).handle(req, res, (err: any) => {
      if (err) reject(err);
      else resolve();
    });
    setImmediate(resolve);
  });

  return { response: res, ensureValidScope };
}

function createSchema(): void {
  testDb.exec(`
    CREATE TABLE IF NOT EXISTS content_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      data JSON DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'unread',
      push_sent INTEGER NOT NULL DEFAULT 0,
      push_sent_at TEXT,
      resolved_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

describe('content notification resolver route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testDb = new Database(':memory:');
    createSchema();
  });

  afterEach(() => {
    testDb?.close();
  });

  it('returns a scoped deep-link resolver payload for the authenticated user', async () => {
    const id = createNotification({
      userId: 501,
      type: 'script_ready',
      title: 'Script ready',
      body: 'Review draft',
      data: { scriptId: 'script_42' },
    });

    const { response, ensureValidScope } = await dispatch(`/notifications/${id}`);

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.contractVersion).toBe(1);
    expect(response.body.data.notification).toMatchObject({
      id,
      userId: 501,
      type: 'script_ready',
      status: 'unread',
    });
    expect(response.body.data.deepLink).toMatchObject({
      targetKind: 'script',
      targetId: 'script_42',
      screen: 'contentScript',
      route: 'content/scripts/script_42',
      action: 'open_script',
      canOpenConcreteTarget: true,
      markReadEndpoint: `/api/v1/notifications/${id}/read`,
      resolveEndpoint: `/api/v1/notifications/${id}/resolve`,
    });
    expect(ensureValidScope).toHaveBeenCalledWith(expect.anything(), 501, 'content_route_notification_resolve', {
      notificationId: String(id),
    });
  });

  it('does not resolve a notification owned by another user', async () => {
    const id = createNotification({
      userId: 501,
      type: 'script_ready',
      title: 'Private script',
      body: 'Do not leak',
      data: { scriptId: 'script_private' },
    });

    const { response } = await dispatch(`/notifications/${id}`, 777);

    expect(response.statusCode).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });

  it('returns a safe fallback target for unknown notification payloads', async () => {
    const id = createNotification({
      userId: 501,
      type: 'topic_candidates_ready',
      title: 'Topics ready',
      body: 'Review ideas',
      data: { count: 3 },
    });

    const { response } = await dispatch(`/notifications/${id}`);

    expect(response.statusCode).toBe(200);
    expect(response.body.data.deepLink).toMatchObject({
      targetKind: 'content_home',
      targetId: null,
      screen: 'contentHome',
      route: 'content/home',
      canOpenConcreteTarget: false,
      reasonCodes: expect.arrayContaining(['no_concrete_content_target']),
    });
  });

  it('rejects invalid ids and invalid authenticated scope', async () => {
    const invalidId = await dispatch('/notifications/not-a-number');
    expect(invalidId.response.statusCode).toBe(400);
    expect(invalidId.response.body.error.code).toBe('BAD_REQUEST');

    const invalidScope = await dispatch('/notifications/1', 0);
    expect(invalidScope.response.statusCode).toBe(401);
    expect(invalidScope.response.body.error.code).toBe('UNAUTHORIZED');
  });
});
