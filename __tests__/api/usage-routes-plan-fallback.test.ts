// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * GET /api/v1/usage — billing identity under a failed-closed quota read.
 *
 * `GET /billing/status` was fixed so a transient entitlement/metering failure
 * cannot report `plan: 'none'` to a paying subscriber. This route spreads
 * `buildQuotaUsagePayload` verbatim and the iOS client assigns `plan`
 * unconditionally, so the same guarantee has to hold here or the very next
 * usage poll re-downgrades the account.
 *
 * The real cost-guardrail and stripe-service run against an in-memory database
 * that is deliberately missing `api_usage`, which is what drives the quota read
 * into its fail-closed branch.
 */

import type { Request } from 'express';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let testDb: Database.Database;

vi.mock('../../src/config', async () => {
  const actual = await vi.importActual<typeof import('../../src/config')>('../../src/config');
  return {
    ...actual,
    config: {
      ...actual.config,
      ios: { ...actual.config.ios, jwtSecret: 'test-ios-jwt-secret-at-least-32-bytes-long' },
    },
  };
});

vi.mock('../../src/services/database', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/database')>('../../src/services/database');
  return {
    ...actual,
    getDb: () => testDb,
    initDatabase: vi.fn(),
    closeDatabase: vi.fn(),
    findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
    assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
    withDatabaseForTest: vi.fn(),
    withDatabaseForTestAsync: vi.fn(),
  };
});

vi.mock('../../src/services/usage-metering', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/usage-metering')>('../../src/services/usage-metering');
  return {
    ...actual,
    getDailyUsage: vi.fn(() => ({
      date: '2026-07-27',
      messageCount: 3,
      totalTokens: 120,
      inputTokens: 80,
      outputTokens: 40,
      apiCalls: 3,
    })),
    getUsageRange: vi.fn(() => []),
  };
});

vi.mock('../../src/api/tenant-route-scope', () => ({
  ensureValidTenantRouteScope: vi.fn(() => true),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

import { usageRoutes } from '../../src/api/routes/usage';

interface MockResponse {
  statusCode: number;
  body: any;
  headers: Record<string, string>;
  status(code: number): MockResponse;
  json(body: any): MockResponse;
  setHeader(name: string, value: string): MockResponse;
  end(): MockResponse;
}

function response(): MockResponse {
  const res: MockResponse = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { res.statusCode = code; return res; },
    json(body) { res.body = body; return res; },
    setHeader(name, value) { res.headers[name] = value; return res; },
    end() { return res; },
  };
  return res;
}

async function getUsage(userId: number): Promise<MockResponse> {
  const req = {
    method: 'GET',
    url: '/',
    originalUrl: '/',
    baseUrl: '',
    path: '/',
    query: {},
    params: {},
    headers: {},
    userId,
  } as unknown as Request;
  const res = response();
  const router = usageRoutes();
  await new Promise<void>((resolve, reject) => {
    (router as any).handle(req, res, (err: unknown) => err ? reject(err) : resolve());
    setTimeout(resolve, 20);
  });
  return res;
}

describe('GET /api/v1/usage billing identity when the quota read fails closed', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    // `api_usage` is intentionally absent: the quota read throws and takes its
    // fail-closed branch, exactly as a transient metering/entitlement fault does.
    testDb.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT,
        first_name TEXT,
        email_verified INTEGER NOT NULL DEFAULT 0,
        tier TEXT NOT NULL DEFAULT 'free'
      );

      CREATE TABLE subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL UNIQUE,
        plan TEXT NOT NULL DEFAULT 'free',
        period TEXT NOT NULL DEFAULT 'monthly',
        status TEXT NOT NULL DEFAULT 'inactive',
        provider TEXT NOT NULL DEFAULT 'none',
        provider_subscription_id TEXT,
        provider_customer_id TEXT,
        current_period_start TEXT,
        current_period_end TEXT,
        environment TEXT,
        cancel_at_period_end INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);
  });

  afterEach(() => {
    testDb.close();
  });

  it('never reports plan "none" for a user with an active paid subscription row', async () => {
    testDb.prepare('INSERT INTO users (id, email, email_verified) VALUES (51, ?, 1)').run('paying@example.com');
    testDb.prepare(`
      INSERT INTO subscriptions (user_id, plan, period, status, provider, provider_subscription_id, current_period_end)
      VALUES (51, 'max', 'monthly', 'active', 'apple', '2000000300000001', ?)
    `).run(new Date(Date.now() + 30 * 86400000).toISOString());

    const res = await getUsage(51);

    expect(res.statusCode).toBe(200);
    // Pins the fail-closed branch: only that branch sets this block reason.
    expect(res.body.data.blockReason).toBe('entitlement_error');
    expect(res.body.data.plan).toBe('max');
    expect(res.body.data.plan).not.toBe('none');
    // Billing identity survives; AI spend stays blocked.
    expect(res.body.data.aiAccessAllowed).toBe(false);
  });

  it('keeps reporting "none" when there is no active paid subscription to fall back to', async () => {
    testDb.prepare('INSERT INTO users (id, email, email_verified) VALUES (52, ?, 1)').run('free@example.com');
    testDb.prepare(`
      INSERT INTO subscriptions (user_id, plan, period, status, provider, current_period_end)
      VALUES (52, 'max', 'monthly', 'active', 'apple', ?)
    `).run(new Date(Date.now() - 86400000).toISOString());

    const expired = await getUsage(52);
    expect(expired.body.data.blockReason).toBe('entitlement_error');
    expect(expired.body.data.plan).toBe('none');

    // No subscription row at all.
    const unknown = await getUsage(53);
    expect(unknown.body.data.blockReason).toBe('entitlement_error');
    expect(unknown.body.data.plan).toBe('none');
  });
});
