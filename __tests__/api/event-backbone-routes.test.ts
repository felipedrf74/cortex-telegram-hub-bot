import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import Database from 'better-sqlite3';

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
}));

vi.mock('../../src/services/operator-alerts', () => ({
  _setOperatorAlertDeliveryConfigForTests: vi.fn(),
  _setOperatorAlertDeliverySenderForTests: vi.fn(),
  acknowledgeOperatorAlert: vi.fn(),
  deliverOperatorAlert: vi.fn(),
  getOperatorAlertDeliverySummary: vi.fn(),
  listOperatorAlerts: vi.fn(),
  processDueOperatorAlertDeliveries: vi.fn(),
  recordOperatorAlert: vi.fn(),
  resolveOperatorAlert: vi.fn(),
  retryOperatorAlertDelivery: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import { summaryRoutes } from '../../src/api/routes/summaries';
import { syncRoutes } from '../../src/api/routes/sync';
import { emitDomainEvent } from '../../src/services/event-outbox';

interface MockRes {
  statusCode: number;
  body: any;
  headers: Record<string, string>;
  status(code: number): MockRes;
  setHeader(name: string, value: string): MockRes;
  json(body: any): MockRes;
}

function mockRes(onSend: () => void): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code: number) { res.statusCode = code; return res; },
    setHeader(name: string, value: string) { res.headers[name.toLowerCase()] = value; return res; },
    json(body: any) { res.body = body; onSend(); return res; },
  };
  return res;
}

function req(path: string, userId?: number, query: Record<string, unknown> = {}): Request {
  return {
    method: 'GET',
    url: path,
    originalUrl: path,
    baseUrl: '',
    path,
    params: {},
    query,
    body: {},
    headers: {},
    header() { return undefined; },
    userId,
    tenantId: userId,
    deviceId: 'iphone-test',
  } as any;
}

async function dispatch(router: any, request: Request): Promise<MockRes> {
  let done!: () => void;
  const responseDone = new Promise<void>((resolve) => { done = resolve; });
  const res = mockRes(done);
  router.handle(request, res, done);
  await responseDone;
  return res;
}

describe('event backbone API routes', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
  });

  afterEach(() => {
    testDb.close();
  });

  it('serves authenticated home summary and rejects missing route scope', async () => {
    const ok = await dispatch(summaryRoutes(), req('/home', 7));
    expect(ok.statusCode).toBe(200);
    expect(ok.body.data.summaryType).toBe('home');
    expect(ok.body.data.payload.kind).toBe('home');

    const rejected = await dispatch(summaryRoutes(), req('/home', undefined));
    expect(rejected.statusCode).toBe(401);
    expect(rejected.body.error.code).toBe('UNAUTHORIZED');
  });

  it('sync route returns only authenticated user changes and rate-limit metadata on excess', async () => {
    emitDomainEvent({
      tenantId: 7,
      userId: 7,
      sourceSkill: 'training',
      eventType: 'training.session.updated',
      entityType: 'training_session',
      entityId: 'a',
      payload: { summary: { text: 'Training changed' } },
      privacyClassification: 'health',
      idempotencyKey: 'training-a',
    });
    emitDomainEvent({
      tenantId: 8,
      userId: 8,
      sourceSkill: 'finance',
      eventType: 'finance.expense.created',
      entityType: 'finance_transaction',
      entityId: 'b',
      payload: { summary: { text: 'Other tenant' } },
      privacyClassification: 'financial',
      idempotencyKey: 'finance-b',
    });

    const ok = await dispatch(syncRoutes(), req('/changes', 7, { since: '0', limit: '10' }));
    expect(ok.statusCode).toBe(200);
    expect(ok.body.data.changes).toHaveLength(1);
    expect(ok.body.data.changes[0].skill).toBe('training');
    expect(JSON.stringify(ok.body)).not.toContain('Other tenant');

    const invalid = await dispatch(syncRoutes(), req('/changes', 7, { since: 'abc' }));
    expect(invalid.body.data.resetRequired).toBe(true);

    let limited: MockRes | null = null;
    for (let i = 0; i < 121; i += 1) {
      const response = await dispatch(syncRoutes(), req('/changes', 7, { since: '0' }));
      if (response.statusCode === 429) {
        limited = response;
        break;
      }
    }
    expect(limited).not.toBeNull();
    expect(limited!.statusCode).toBe(429);
    expect(limited!.headers['retry-after']).toBeDefined();
    expect(limited!.body.error.code).toBe('RATE_LIMITED');
    expect(limited!.body.error.details.resetAt).toBeDefined();
    expect(limited!.body.error.details.budgetKey).toBe('sync_changes');
  });

  it('sync route ignores forged query device ids and requires authenticated device scope', async () => {
    emitDomainEvent({
      tenantId: 7,
      userId: 7,
      sourceSkill: 'training',
      eventType: 'training.session.updated',
      entityType: 'training_session',
      entityId: 'device-a',
      payload: { summary: { text: 'Training changed' } },
      privacyClassification: 'health',
      idempotencyKey: 'training-device-a',
    });

    const ok = await dispatch(syncRoutes(), req('/changes', 7, { since: '0', deviceId: 'foreign-device' }));
    expect(ok.statusCode).toBe(200);
    const cursors = testDb.prepare('SELECT device_id FROM sync_cursors').all() as Array<{ device_id: string }>;
    expect(cursors.map((row) => row.device_id)).toEqual(['iphone-test']);

    const missingDevice = req('/changes', 7, { since: '0' }) as any;
    missingDevice.deviceId = undefined;
    const rejected = await dispatch(syncRoutes(), missingDevice);
    expect(rejected.statusCode).toBe(400);
    expect(rejected.body.error.code).toBe('MISSING_DEVICE_ID');
  });
});
