/**
 * Tests for src/services/apple-token-revocation.ts
 *
 * App Store Review Guideline 5.1.1(v): an app offering Sign in with Apple must
 * revoke the user's Apple token on account deletion.
 *
 * Validates:
 * - the authorization code is optional (older clients keep working)
 * - the feature is inert when the Apple env vars are unset
 * - a captured refresh token is stored ENCRYPTED, never in plaintext
 * - the ES256 client-secret JWT carries the shape Apple requires
 * - revoke posts the stored refresh token before any local erase
 * - Apple failures never escape as exceptions from the store path
 *
 * All Apple HTTP calls are mocked — this suite makes no network requests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

let testDb: Database.Database;

const TEST_MASTER_KEY = 'apple-revocation-master-key-for-tests!';

const { privateKey: TEST_P8_PEM } = (() => {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
})();

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

// The literal is repeated here because vi.mock factories are hoisted above
// every top-level binding; TEST_MASTER_KEY asserts they stay in sync.
vi.mock('../../src/config', () => ({
  config: {
    financeEncryption: { enabled: true, masterKey: 'apple-revocation-master-key-for-tests!' },
    appleSignIn: { teamId: '', keyId: '', privateKey: '', clientId: 'me.nexushub.app' },
  },
}));

import { config } from '../../src/config';
import { decryptValue, encryptValue } from '../../src/utils/encryption';
import {
  appleSignInIdentityExistsForUser,
  appleSignInRevocationConfigured,
  buildAppleClientSecret,
  revokeAppleSignInTokenForUser,
  storeAppleRefreshTokenForUser,
} from '../../src/services/apple-token-revocation';

function configureAppleCredentials(): void {
  config.appleSignIn.teamId = 'TEAM123456';
  config.appleSignIn.keyId = 'KEY7890123';
  config.appleSignIn.privateKey = TEST_P8_PEM;
  config.appleSignIn.clientId = 'me.nexushub.app';
}

function clearAppleCredentials(): void {
  config.appleSignIn.teamId = '';
  config.appleSignIn.keyId = '';
  config.appleSignIn.privateKey = '';
}

function seedAppleUser(userId: number, appleUserId = 'apple-sub-1'): void {
  testDb.prepare(`
    INSERT INTO users (telegram_id, username, first_name, language, timezone, tier, status, apple_user_id)
    VALUES (?, 'appleuser', 'Apple', 'en-US', 'Europe/Lisbon', 'free', 'active', ?)
  `).run(userId, appleUserId);
}

function storedRow(userId: number) {
  return testDb.prepare(
    'SELECT user_id, apple_user_id, client_id, encrypted_refresh_token FROM apple_sign_in_refresh_tokens WHERE user_id = ?',
  ).get(userId) as
    | { user_id: number; apple_user_id: string; client_id: string; encrypted_refresh_token: string }
    | undefined;
}

describe('Apple sign-in refresh token capture', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
    clearAppleCredentials();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    testDb.close();
  });

  it('uses the same master key the hoisted config mock installs', () => {
    expect(config.financeEncryption.masterKey).toBe(TEST_MASTER_KEY);
  });

  it('is a no-op when the client sends no authorization code', async () => {
    configureAppleCredentials();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(storeAppleRefreshTokenForUser({ userId: 1, appleUserId: 'apple-sub-1' }))
      .resolves.toBe('no_authorization_code');
    await expect(storeAppleRefreshTokenForUser({ userId: 1, appleUserId: 'apple-sub-1', authorizationCode: '   ' }))
      .resolves.toBe('no_authorization_code');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(storedRow(1)).toBeUndefined();
  });

  it('does not call Apple when the revocation env vars are unset', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(storeAppleRefreshTokenForUser({
      userId: 1,
      appleUserId: 'apple-sub-1',
      authorizationCode: 'c-123',
    })).resolves.toBe('not_configured');

    expect(appleSignInRevocationConfigured()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storedRow(1)).toBeUndefined();
  });

  it('exchanges the authorization code and stores the refresh token encrypted at rest', async () => {
    configureAppleCredentials();
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ access_token: 'apple-access', refresh_token: 'apple-refresh-secret' }),
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(storeAppleRefreshTokenForUser({
      userId: 7,
      appleUserId: 'apple-sub-7',
      authorizationCode: 'c-abc',
    })).resolves.toBe('stored');

    expect(String(fetchMock.mock.calls[0][0])).toBe('https://appleid.apple.com/auth/token');
    const body = new URLSearchParams(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('c-abc');
    expect(body.get('client_id')).toBe('me.nexushub.app');
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBeInstanceOf(AbortSignal);

    const row = storedRow(7)!;
    expect(row.apple_user_id).toBe('apple-sub-7');
    expect(row.client_id).toBe('me.nexushub.app');
    expect(row.encrypted_refresh_token).not.toContain('apple-refresh-secret');
    expect(decryptValue(row.encrypted_refresh_token, TEST_MASTER_KEY, 7)).toBe('apple-refresh-secret');
  });

  it('signs an ES256 client secret with the audience, issuer, and subject Apple requires', async () => {
    configureAppleCredentials();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ refresh_token: 'r' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await storeAppleRefreshTokenForUser({ userId: 3, appleUserId: 'apple-sub-3', authorizationCode: 'c' });

    const clientSecret = new URLSearchParams(
      String((fetchMock.mock.calls[0][1] as RequestInit).body),
    ).get('client_secret')!;
    const [header, payload] = clientSecret.split('.').slice(0, 2)
      .map((part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')));

    expect(header).toMatchObject({ alg: 'ES256', kid: 'KEY7890123' });
    expect(payload).toMatchObject({
      iss: 'TEAM123456',
      aud: 'https://appleid.apple.com',
      sub: 'me.nexushub.app',
    });
    expect(payload.exp).toBeGreaterThan(payload.iat);
  });

  it('refuses to build a client secret when credentials are unset', () => {
    expect(() => buildAppleClientSecret('me.nexushub.app')).toThrow(/not configured/i);
  });

  it('records failure without throwing when Apple rejects the code or the network dies', async () => {
    configureAppleCredentials();

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"invalid_grant"}', { status: 400 })));
    await expect(storeAppleRefreshTokenForUser({
      userId: 5, appleUserId: 'apple-sub-5', authorizationCode: 'c',
    })).resolves.toBe('failed');

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    await expect(storeAppleRefreshTokenForUser({
      userId: 5, appleUserId: 'apple-sub-5', authorizationCode: 'c',
    })).resolves.toBe('failed');

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"access_token":"a"}', { status: 200 })));
    await expect(storeAppleRefreshTokenForUser({
      userId: 5, appleUserId: 'apple-sub-5', authorizationCode: 'c',
    })).resolves.toBe('failed');

    expect(storedRow(5)).toBeUndefined();
  });

  it('overwrites the stored token when the same user signs in again', async () => {
    configureAppleCredentials();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ refresh_token: 'first' }), { status: 200 })));
    await storeAppleRefreshTokenForUser({ userId: 9, appleUserId: 'apple-sub-9', authorizationCode: 'c1' });

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ refresh_token: 'second' }), { status: 200 })));
    await storeAppleRefreshTokenForUser({ userId: 9, appleUserId: 'apple-sub-9', authorizationCode: 'c2' });

    const rows = testDb.prepare('SELECT encrypted_refresh_token FROM apple_sign_in_refresh_tokens WHERE user_id = 9')
      .all() as Array<{ encrypted_refresh_token: string }>;
    expect(rows).toHaveLength(1);
    expect(decryptValue(rows[0].encrypted_refresh_token, TEST_MASTER_KEY, 9)).toBe('second');
  });
});

describe('Apple sign-in token revocation', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
    clearAppleCredentials();
    testDb.prepare(`
      INSERT INTO apple_sign_in_refresh_tokens (user_id, apple_user_id, client_id, encrypted_refresh_token)
      VALUES (1, 'apple-sub-1', 'me.nexushub.app', ?)
    `).run(encryptValue('stored-apple-refresh', TEST_MASTER_KEY, 1));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    testDb.close();
  });

  it('posts the decrypted refresh token to Apple revoke with a bounded timeout', async () => {
    configureAppleCredentials();
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(revokeAppleSignInTokenForUser(1)).resolves.toEqual({
      attempted: true,
      status: 'revoked',
      statusCode: 200,
    });

    expect(String(fetchMock.mock.calls[0][0])).toBe('https://appleid.apple.com/auth/revoke');
    const body = new URLSearchParams(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.get('token')).toBe('stored-apple-refresh');
    expect(body.get('token_type_hint')).toBe('refresh_token');
    expect(body.get('client_id')).toBe('me.nexushub.app');
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it('treats a 4xx as already revoked', async () => {
    configureAppleCredentials();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 400 })));

    await expect(revokeAppleSignInTokenForUser(1)).resolves.toEqual({
      attempted: true,
      status: 'already_revoked',
      statusCode: 400,
    });
  });

  it('reports failed on a 5xx so the caller can record it', async () => {
    configureAppleCredentials();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));

    await expect(revokeAppleSignInTokenForUser(1)).resolves.toEqual({
      attempted: true,
      status: 'failed',
      statusCode: 503,
    });
  });

  it('records local_only without calling Apple when the env vars are unset', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(revokeAppleSignInTokenForUser(1)).resolves.toEqual({
      attempted: false,
      status: 'local_only',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('records local_only for a user with no captured refresh token', async () => {
    configureAppleCredentials();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(revokeAppleSignInTokenForUser(2)).resolves.toEqual({
      attempted: false,
      status: 'local_only',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('recognises an Apple identity from either the token store or the user record', () => {
    expect(appleSignInIdentityExistsForUser(1)).toBe(true);
    expect(appleSignInIdentityExistsForUser(2)).toBe(false);

    seedAppleUser(2, 'apple-sub-2');
    expect(appleSignInIdentityExistsForUser(2)).toBe(true);
  });
});
