import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import Database from 'better-sqlite3';

let testDb: Database.Database;
let pushTokens: string[] = [];
const mockSendPushNotification = vi.fn();

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

vi.mock('../../src/services/apns-sender', () => ({
  getPushTokensForUser: vi.fn(() => pushTokens),
  isApnsConfigured: vi.fn(() => false),
  sendPushNotification: (...args: unknown[]) => mockSendPushNotification(...args),
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

import { notificationRoutes } from '../../src/api/routes/notifications';
import {
  buildSkillNotificationFixtureIntent,
  createNotificationIntent,
  ensureNotificationTables,
  listNotificationCenterItems,
  registerNotificationDeviceToken,
} from '../../src/services/notification-orchestrator';

interface MockRes {
  statusCode: number;
  body: any;
  headers: Record<string, string>;
  status(code: number): MockRes;
  json(body: any): MockRes;
  setHeader(name: string, value: string): MockRes;
  end(): MockRes;
}

function mockRes(onSend?: () => void): MockRes {
  const r: MockRes = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code: number) { r.statusCode = code; return r; },
    json(body: any) { r.body = body; onSend?.(); return r; },
    setHeader(name: string, value: string) { r.headers[name] = value; return r; },
    end() { onSend?.(); return r; },
  };
  return r;
}

function mockReq(
  method: string,
  path: string,
  userId = 7,
  body: Record<string, any> = {},
  headers: Record<string, string> = {},
): Request {
  return {
    method,
    url: path,
    originalUrl: path,
    baseUrl: '',
    path,
    query: {},
    params: {},
    body,
    headers,
    header(name: string) {
      return headers[name.toLowerCase()] ?? headers[name];
    },
    userId,
  } as any;
}

async function dispatch(
  method: string,
  path: string,
  userId = 7,
  body: Record<string, any> = {},
  headers: Record<string, string> = {},
): Promise<MockRes> {
  const router = notificationRoutes();
  const req = mockReq(method, path, userId, body, headers);
  let resolveResponse!: () => void;
  let rejectResponse!: (err: Error) => void;
  const responseDone = new Promise<void>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const res = mockRes(resolveResponse);

  (router as any).handle(req, res, (err: any) => {
    if (err) rejectResponse(err);
  });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    responseDone,
    new Promise<void>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`${method} ${path} did not send a response`)), 1_000);
    }),
  ]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });

  return res;
}

describe('notification orchestrator security behavior', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    pushTokens = ['sandbox-token'];
    mockSendPushNotification.mockReset();
    process.env.NOTIFICATION_DELIVERY_MODE = 'mock';
    delete process.env.INTERNAL_API_SECRET;
    ensureNotificationTables();
  });

  afterEach(() => {
    delete process.env.NOTIFICATION_DELIVERY_MODE;
    delete process.env.INTERNAL_API_SECRET;
    testDb?.close();
  });

  it('rejects arbitrary client-created notification intents without internal skill context', async () => {
    const res = await dispatch('POST', '/intents', 7, {
      userId: 999,
      tenantId: 999,
      sourceSkill: 'security',
      type: 'security_account',
      priority: 'critical',
      title: 'Fake security alert',
      body: 'Fake alert',
    });

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatchObject({
      code: 'FORBIDDEN',
      message: 'Notification intent creation requires an internal skill context',
    });
    expect(listNotificationCenterItems(7, 7, { status: 'all' })).toHaveLength(0);
    expect(listNotificationCenterItems(999, 999, { status: 'all' })).toHaveLength(0);
  });

  it('uses authenticated route scope for internal intents instead of forged body scope', async () => {
    process.env.INTERNAL_API_SECRET = 'test-internal-secret';

    const res = await dispatch(
      'POST',
      '/intents',
      7,
      {
        userId: 999,
        tenantId: 999,
        sourceSkill: 'finance',
        type: 'reminder',
        priority: 'time_sensitive',
        title: 'Finance reminder',
        body: 'Your invoice from Vendor X for $2,400 is overdue.',
        sensitiveBody: 'Your invoice from Vendor X for $2,400 is overdue.',
        privacyPolicy: 'public',
        dedupeKey: 'security-route-scope',
      },
      { 'x-internal-secret': 'test-internal-secret' },
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.data.intent.sourceSkill).toBe('finance');
    expect(listNotificationCenterItems(999, 999, { status: 'all' })).toHaveLength(0);
    const items = listNotificationCenterItems(7, 7, { status: 'all' });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      userId: 7,
      tenantId: 7,
      sourceSkill: 'finance',
      safeBody: 'Finance reminder needs review.',
      sensitiveBody: 'Your invoice from Vendor X for $2,400 is overdue.',
    });
  });

  it('redacts lock-screen bodies while retaining authenticated detail', async () => {
    const cases = [
      {
        sourceSkill: 'secretary' as const,
        body: 'Meeting with John Doe about Acme acquisition.',
        expectedSafeBody: 'Secretary needs your attention — open Nexus to view details.',
        leaked: 'John Doe',
      },
      {
        sourceSkill: 'security' as const,
        body: 'New login from 192.0.2.5 near Lisbon.',
        expectedSafeBody: 'Account activity — open Nexus to view details.',
        leaked: '192.0.2.5',
      },
      {
        sourceSkill: 'chat' as const,
        body: 'Private chat answer includes tomorrow’s legal call.',
        expectedSafeBody: 'Nexus needs your attention — open Nexus to view details.',
        leaked: 'legal call',
      },
      {
        sourceSkill: 'finance' as const,
        body: 'Your invoice from Vendor X for $2,400 is overdue.',
        expectedSafeBody: 'Finance reminder needs review.',
        leaked: '$2,400',
      },
    ];

    for (const item of cases) {
      const result = await createNotificationIntent(buildSkillNotificationFixtureIntent(item.sourceSkill, 10, {
        body: item.body,
        sensitiveBody: item.body,
        privacyPolicy: 'public',
        dedupeKey: `privacy:${item.sourceSkill}`,
      }));

      expect(result.pushPayload?.body).toBe(item.expectedSafeBody);
      expect(result.pushPayload?.body).not.toContain(item.leaked);
      expect(result.item?.safeBody).toBe(item.expectedSafeBody);
      expect(result.item?.sensitiveBody).toBe(item.body);
    }
  });

  it('stores notification device token metadata by hash without raw token leakage', () => {
    const rawToken = 'raw-apns-token-secret-abcdef1234567890';
    const registration = registerNotificationDeviceToken({
      userId: 11,
      tenantId: 11,
      token: rawToken,
      deviceId: 'iphone-11',
      environment: 'sandbox',
      appVersion: '1.2.3',
    });

    const tokenRow = testDb.prepare(`
      SELECT token_id, token_hash, token_suffix, device_id
      FROM notification_device_tokens
      WHERE token_id = ?
    `).get(registration.tokenId) as any;

    expect(tokenRow.token_hash).toBeTruthy();
    expect(tokenRow.token_hash).not.toBe(rawToken);
    expect(tokenRow.token_hash).not.toContain(rawToken);
    expect(tokenRow.token_suffix).toBe('34567890');
    expect(tokenRow.device_id).toBe('iphone-11');
  });
});
