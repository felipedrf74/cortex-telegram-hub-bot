import crypto from 'crypto';
import express from 'express';
import http from 'http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let testDb: Database.Database;
const mockCaptureMessage = vi.fn();
const mockRecordOperatorAlert = vi.fn();

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/services/error-tracker', () => ({
  init: vi.fn(),
  isEnabled: vi.fn(() => true),
  getStatus: vi.fn((environment: string) => ({ enabled: true, environment })),
  captureException: vi.fn(),
  captureMessage: (...args: unknown[]) => mockCaptureMessage(...args),
  flush: vi.fn(async () => undefined),
}));

vi.mock('../../src/services/operator-alerts', () => ({
  recordOperatorAlert: (...args: unknown[]) => mockRecordOperatorAlert(...args),
  listOperatorAlerts: vi.fn(() => []),
  acknowledgeOperatorAlert: vi.fn(() => true),
  resolveOperatorAlert: vi.fn(() => true),
  retryOperatorAlertDelivery: vi.fn(() => true),
  deliverOperatorAlert: vi.fn(async () => ({ ok: true, status: 'not_configured' })),
  processDueOperatorAlertDeliveries: vi.fn(async () => []),
  getOperatorAlertDeliverySummary: vi.fn(() => ({
    pending: 0,
    delivered: 0,
    failed: 0,
    dead_letter: 0,
    not_configured: 0,
  })),
  _setOperatorAlertDeliverySenderForTests: vi.fn(),
  _setOperatorAlertDeliveryConfigForTests: vi.fn(),
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

import { createApiRouter } from '../../src/api/router';

const TEST_PRIVATE_KEY = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIDZI3ek/mxC/IgvB8aaT5qN+pmhkjYHVepK7SqIgpYGEoAoGCCqGSM49
AwEHoUQDQgAEL0e17hakzfDppYuAEMnSVYTXAFVb4XbS8LRsIrdrPMO/47dSjV9V
ii8/E8trqU5tbOMZjLDNKIsEi0RBpMTKQw==
-----END EC PRIVATE KEY-----`;

const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBlDCCATmgAwIBAgIUf1VFq+akd1t7HBC3RVy3gbVFu1wwCgYIKoZIzj0EAwIw
HzEdMBsGA1UEAwwUTmV4dXMgVGVzdCBBcHBsZSBKV1MwHhcNMjYwNTA4MjIxNzEw
WhcNMzYwNTA1MjIxNzEwWjAfMR0wGwYDVQQDDBROZXh1cyBUZXN0IEFwcGxlIEpX
UzBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABC9Hte4WpM3w6aWLgBDJ0lWE1wBV
W+F20vC0bCK3azzDv+O3Uo1fVYovPxPLa6lObWzjGYywzSiLBItEQaTEykOjUzBR
MB0GA1UdDgQWBBRicbLILuQ7lucMuZYpR5Vi2/vTTzAfBgNVHSMEGDAWgBRicbLI
LuQ7lucMuZYpR5Vi2/vTTzAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0kA
MEYCIQC0nMB+TnCrKHMIFv5Jv8bQ0ZPnc1QLLfZu+v/049ZSaAIhAK1GmpOwTAaw
1b4Hjfx2J+n9Dtm7Noen9pzXXyqXEctN
-----END CERTIFICATE-----`;

const ORIGINAL_APPLE_JWS_TEST_ROOT_CERT_PEM = process.env.APPLE_JWS_TEST_ROOT_CERT_PEM;

function certToX5c(certPem: string): string {
  return certPem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
}

function signJws(payload: Record<string, unknown>, headerOverrides: Record<string, unknown> = {}): string {
  const header = {
    alg: 'ES256',
    x5c: [certToX5c(TEST_CERT)],
    ...headerOverrides,
  };
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signedData = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto.sign(
    'SHA256',
    Buffer.from(signedData),
    { key: TEST_PRIVATE_KEY, dsaEncoding: 'ieee-p1363' },
  );
  return `${signedData}.${signature.toString('base64url')}`;
}

function tamperPayload(jws: string, patch: Record<string, unknown>): string {
  const parts = jws.split('.');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  parts[1] = Buffer.from(JSON.stringify({ ...payload, ...patch })).toString('base64url');
  return parts.join('.');
}

function unsignedJws(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.${Buffer.from('fake').toString('base64url')}`;
}

function appleNotification(notificationType: string, innerJws: string): string {
  return signJws({
    notificationType,
    data: {
      signedTransactionInfo: innerJws,
    },
  });
}

function appleNotificationWithUuid(
  notificationType: string,
  innerJws: string,
  notificationUUID: string,
): string {
  return signJws({
    notificationType,
    notificationUUID,
    data: {
      signedTransactionInfo: innerJws,
      environment: 'Production',
    },
  });
}

function inboxRow(uuid: string): { state: string; attempts: number; last_error: string | null } | undefined {
  return testDb.prepare(
    'SELECT state, attempts, last_error FROM apple_notification_inbox WHERE notification_uuid = ?',
  ).get(uuid) as { state: string; attempts: number; last_error: string | null } | undefined;
}

function seedSubscription(transactionId = '2000000123456789'): void {
  testDb.prepare(`
    INSERT INTO subscriptions (
      user_id, plan, period, status, provider, provider_subscription_id, current_period_end, updated_at
    ) VALUES (?, 'pro', 'monthly', 'active', 'apple', ?, ?, datetime('now'))
  `).run(31, transactionId, '2026-06-01T00:00:00.000Z');
}

function subscriptionRow(transactionId = '2000000123456789'): any {
  return testDb
    .prepare('SELECT status, current_period_end FROM subscriptions WHERE provider_subscription_id = ?')
    .get(transactionId);
}

async function postAppleNotification(signedPayload: string): Promise<{ status: number; body: any }> {
  const app = express();
  app.use('/api/v1', createApiRouter());
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');

  try {
    return await new Promise((resolve, reject) => {
      const payload = JSON.stringify({ signedPayload });
      const req = http.request({
        hostname: '127.0.0.1',
        port: address.port,
        method: 'POST',
        path: '/api/v1/billing/apple-notifications',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          body: data ? JSON.parse(data) : null,
        }));
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('Apple App Store Server Notifications JWS verification', () => {
  beforeEach(() => {
    process.env.APPLE_JWS_TEST_ROOT_CERT_PEM = TEST_CERT;
    testDb = new Database(':memory:');
    testDb.exec(`
      CREATE TABLE subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        plan TEXT,
        period TEXT,
        status TEXT,
        provider TEXT,
        provider_subscription_id TEXT,
        provider_customer_id TEXT,
        current_period_start TEXT,
        current_period_end TEXT,
        environment TEXT,
        cancel_at_period_end INTEGER DEFAULT 0,
        updated_at TEXT
      );
      CREATE TABLE apple_webhook_events (
        notification_uuid TEXT PRIMARY KEY,
        notification_type TEXT NOT NULL,
        subtype            TEXT,
        environment        TEXT,
        processed_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );
      -- Real migration SQL, so these route tests face the actual append-only
      -- and state-transition triggers rather than a permissive hand-rolled
      -- table (a suite that passes with the guards deleted proves nothing).
      CREATE TABLE nexus_point_credits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT 'purchase',
        provider TEXT NOT NULL,
        product_id TEXT NOT NULL,
        provider_transaction_id TEXT NOT NULL,
        points_granted REAL NOT NULL,
        points_remaining REAL NOT NULL,
        usd_allowance_granted REAL NOT NULL,
        usd_allowance_remaining REAL NOT NULL,
        purchased_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(provider, provider_transaction_id)
      );
    `);
    testDb.exec(readFileSync(
      resolve(__dirname, '../../migrations/286_apple_notification_inbox.sql'),
      'utf8',
    ));
    mockCaptureMessage.mockReset();
    mockRecordOperatorAlert.mockReset();
  });

  afterEach(() => {
    if (ORIGINAL_APPLE_JWS_TEST_ROOT_CERT_PEM === undefined) {
      delete process.env.APPLE_JWS_TEST_ROOT_CERT_PEM;
    } else {
      process.env.APPLE_JWS_TEST_ROOT_CERT_PEM = ORIGINAL_APPLE_JWS_TEST_ROOT_CERT_PEM;
    }
    testDb.close();
  });

  it('rejects forged notifications without x5c and does not mutate subscriptions', async () => {
    seedSubscription();
    const inner = unsignedJws({
      bundleId: 'me.nexushub.app',
      originalTransactionId: '2000000123456789',
      expiresDate: Date.now() + 30 * 86400000,
    });
    const forgedOuter = unsignedJws({ notificationType: 'DID_RENEW', data: { signedTransactionInfo: inner } });

    const response = await postAppleNotification(forgedOuter);

    expect(response).toEqual({ status: 200, body: { handled: false, reason: 'invalid signature' } });
    expect(subscriptionRow().current_period_end).toBe('2026-06-01T00:00:00.000Z');
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'APPLE_NOTIFICATION_FORGED_OR_INVALID',
      'warning',
      expect.objectContaining({ error_code: 'APPLE_NOTIFICATION_FORGED_OR_INVALID' }),
    );
  });

  it('rejects a tampered inner transaction payload and does not mutate subscriptions', async () => {
    seedSubscription();
    const signedInner = signJws({
      bundleId: 'me.nexushub.app',
      originalTransactionId: '2000000123456789',
      expiresDate: Date.now() + 30 * 86400000,
    });
    const tamperedInner = tamperPayload(signedInner, { expiresDate: Date.now() + 365 * 86400000 });
    const outer = appleNotification('DID_RENEW', tamperedInner);

    const response = await postAppleNotification(outer);

    expect(response).toEqual({ status: 200, body: { handled: false, reason: 'invalid signature' } });
    expect(subscriptionRow().current_period_end).toBe('2026-06-01T00:00:00.000Z');
  });

  it('processes a signed renewal notification and updates the subscription period', async () => {
    seedSubscription();
    const renewedUntil = '2026-07-15T12:00:00.000Z';
    const inner = signJws({
      bundleId: 'me.nexushub.app',
      originalTransactionId: '2000000123456789',
      expiresDate: renewedUntil,
    });

    const response = await postAppleNotification(appleNotification('DID_RENEW', inner));

    expect(response).toEqual({ status: 200, body: { handled: true } });
    expect(subscriptionRow()).toEqual({
      status: 'active',
      current_period_end: renewedUntil,
    });
  });

  it('processes a signed cancel/expiry notification and marks the row expired', async () => {
    seedSubscription();
    const inner = signJws({
      bundleId: 'me.nexushub.app',
      originalTransactionId: '2000000123456789',
    });

    const response = await postAppleNotification(appleNotification('EXPIRED', inner));

    expect(response).toEqual({ status: 200, body: { handled: true } });
    expect(subscriptionRow()).toEqual({
      status: 'expired',
      current_period_end: '2026-06-01T00:00:00.000Z',
    });
  });

  it('processes a signed Nexus Points refund notification and revokes remaining credit', async () => {
    testDb.prepare(`
      INSERT INTO nexus_point_credits (
        user_id, source, provider, product_id, provider_transaction_id,
        points_granted, points_remaining, usd_allowance_granted,
        usd_allowance_remaining, purchased_at, expires_at, status
      ) VALUES (
        31, 'apple_iap', 'apple', 'me.nexushub.points.small', '2000000123456799',
        300, 275, 0.30, 0.275, datetime('now'), '2026-06-19T12:00:00.000Z', 'active'
      )
    `).run();
    const inner = signJws({
      bundleId: 'me.nexushub.app',
      productId: 'me.nexushub.points.small',
      transactionId: '2000000123456799',
      originalTransactionId: '2000000123456799',
    });

    const response = await postAppleNotification(appleNotification('REFUND', inner));

    expect(response).toEqual({ status: 200, body: { handled: true } });
    expect(testDb.prepare(`
      SELECT status, points_remaining, usd_allowance_remaining
      FROM nexus_point_credits
      WHERE provider_transaction_id = '2000000123456799'
    `).get()).toEqual({
      status: 'refunded',
      points_remaining: 0,
      usd_allowance_remaining: 0,
    });
  });

  it('alerts operators when an Apple Nexus Points refund arrives after high consumption', async () => {
    testDb.prepare(`
      INSERT INTO nexus_point_credits (
        user_id, source, provider, product_id, provider_transaction_id,
        points_granted, points_remaining, usd_allowance_granted,
        usd_allowance_remaining, purchased_at, expires_at, status
      ) VALUES (
        31, 'apple_iap', 'apple', 'me.nexushub.points.small', '2000000123456800',
        300, 90, 0.30, 0.09, datetime('now'), '2026-06-19T12:00:00.000Z', 'active'
      )
    `).run();
    const inner = signJws({
      bundleId: 'me.nexushub.app',
      productId: 'me.nexushub.points.small',
      transactionId: '2000000123456800',
      originalTransactionId: '2000000123456800',
    });

    const response = await postAppleNotification(appleNotification('REFUND', inner));

    expect(response).toEqual({ status: 200, body: { handled: true } });
    expect(mockRecordOperatorAlert).toHaveBeenCalledWith(expect.objectContaining({
      source: 'nexus_points',
      severity: 'warning',
      dedupeKey: expect.stringContaining('nexus_points_high_consumption_refund:31:'),
      title: 'Nexus Points refund after 70% consumption',
      metadata: expect.objectContaining({
        userId: 31,
        pointsGranted: 300,
        pointsRemaining: 90,
        productId: 'me.nexushub.points.small',
      }),
    }));
  });

  it('persists a UUID-bearing notification durably before processing it', async () => {
    seedSubscription();
    const inner = signJws({
      bundleId: 'me.nexushub.app',
      originalTransactionId: '2000000123456789',
      expiresDate: '2026-09-15T12:00:00.000Z',
    });

    const response = await postAppleNotification(
      appleNotificationWithUuid('DID_RENEW', inner, 'uuid-durable-1'),
    );

    expect(response).toEqual({ status: 200, body: { handled: true } });
    expect(inboxRow('uuid-durable-1')).toEqual({ state: 'processed', attempts: 1, last_error: null });
    expect(subscriptionRow()).toEqual({
      status: 'active',
      current_period_end: '2026-09-15T12:00:00.000Z',
    });
  });

  it('asks Apple to redeliver when durable storage is unavailable', async () => {
    seedSubscription();
    testDb.exec('DROP TABLE apple_notification_inbox');
    const inner = signJws({
      bundleId: 'me.nexushub.app',
      originalTransactionId: '2000000123456789',
    });

    const response = await postAppleNotification(
      appleNotificationWithUuid('DID_RENEW', inner, 'uuid-storage-down'),
    );

    expect(response).toEqual({ status: 503, body: { handled: false, reason: 'storage unavailable' } });
  });

  it('retains a failed notification for internal retry instead of losing it behind a 200', async () => {
    testDb.exec('DROP TABLE subscriptions');
    const inner = signJws({
      bundleId: 'me.nexushub.app',
      originalTransactionId: '2000000123456789',
      expiresDate: '2026-09-15T12:00:00.000Z',
    });

    const response = await postAppleNotification(
      appleNotificationWithUuid('DID_RENEW', inner, 'uuid-retained'),
    );

    expect(response).toEqual({ status: 200, body: { handled: false } });
    const row = inboxRow('uuid-retained');
    expect(row?.state).toBe('failed');
    expect(row?.attempts).toBe(1);
    expect(row?.last_error).toBeTruthy();
  });

  it('deduplicates redelivered notifications by UUID without reprocessing', async () => {
    seedSubscription();
    const inner = signJws({
      bundleId: 'me.nexushub.app',
      originalTransactionId: '2000000123456789',
      expiresDate: '2026-09-15T12:00:00.000Z',
    });
    const payload = appleNotificationWithUuid('DID_RENEW', inner, 'uuid-dupe');

    expect((await postAppleNotification(payload)).status).toBe(200);
    const second = await postAppleNotification(payload);

    expect(second).toEqual({ status: 200, body: { handled: false } });
    expect(testDb.prepare(
      "SELECT COUNT(*) AS c FROM apple_notification_inbox WHERE notification_uuid = 'uuid-dupe'",
    ).get()).toEqual({ c: 1 });
    expect(inboxRow('uuid-dupe')?.state).toBe('processed');
  });
});
