import crypto from 'crypto';
import express from 'express';
import http from 'http';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let testDb: Database.Database;
const mockCaptureMessage = vi.fn();

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
}));

vi.mock('../../src/services/error-tracker', () => ({
  init: vi.fn(),
  isEnabled: vi.fn(() => true),
  getStatus: vi.fn((environment: string) => ({ enabled: true, environment })),
  captureException: vi.fn(),
  captureMessage: (...args: unknown[]) => mockCaptureMessage(...args),
  flush: vi.fn(async () => undefined),
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
        cancel_at_period_end INTEGER DEFAULT 0,
        updated_at TEXT
      );
    `);
    mockCaptureMessage.mockReset();
  });

  afterEach(() => {
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
});
