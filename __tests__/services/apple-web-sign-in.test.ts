import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;

beforeEach(() => {
  testDb = new Database(':memory:');
  vi.resetModules();
  vi.doMock('../../src/services/database', () => ({
    getDb: () => testDb,
  }));
});

afterEach(() => {
  testDb?.close();
  vi.resetModules();
});

describe('apple web sign-in session store', () => {
  it('hashes web nonce values with SHA-256 before storing them', async () => {
    const { hashAppleWebNonce } = await import('../../src/services/apple-web-sign-in');

    expect(hashAppleWebNonce('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('stores only nonce hashes and consumes pending sessions exactly once', async () => {
    const { createAppleWebAuthPendingSession, consumeAppleWebAuthPendingSession } =
      await import('../../src/services/apple-web-sign-in');

    const session = createAppleWebAuthPendingSession(
      'web-device',
      'Nexus Web',
      'state-nonce',
      'raw-nonce-with-enough-entropy',
    );

    expect(session.state).toBe('web-apple:state-nonce');

    const columns = testDb
      .prepare(`PRAGMA table_info(apple_web_auth_pending_sessions)`)
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain('nonce_hash');
    expect(columns.map((column) => column.name)).not.toContain('raw_nonce');

    const row = testDb
      .prepare('SELECT nonce_hash, device_id, device_name FROM apple_web_auth_pending_sessions WHERE state_nonce = ?')
      .get('state-nonce') as { nonce_hash: string; device_id: string; device_name: string };
    expect(row.device_id).toBe('web-device');
    expect(row.device_name).toBe('Nexus Web');
    expect(row.nonce_hash).toBe(session.nonceHash);
    expect(JSON.stringify(row)).not.toContain('raw-nonce-with-enough-entropy');

    expect(consumeAppleWebAuthPendingSession('state-nonce')).toEqual({
      nonceHash: session.nonceHash,
      deviceId: 'web-device',
      deviceName: 'Nexus Web',
    });
    expect(consumeAppleWebAuthPendingSession('state-nonce')).toBeNull();
  });

  it('stores and consumes completion payloads exactly once', async () => {
    const { storeAppleWebAuthCompletion, consumeAppleWebAuthCompletion } =
      await import('../../src/services/apple-web-sign-in');

    const authCode = storeAppleWebAuthCompletion({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresIn: 604800,
      user: { id: 5, firstName: 'Apple', language: 'en', authProvider: 'apple' },
    }, 'apple-code');

    expect(authCode).toBe('apple-code');
    expect(consumeAppleWebAuthCompletion('apple-code')?.user.authProvider).toBe('apple');
    expect(consumeAppleWebAuthCompletion('apple-code')).toBeNull();
  });

  it('parses only web-apple callback state values', async () => {
    const { isWebAppleAuthState, parseWebAppleAuthState } =
      await import('../../src/services/apple-web-sign-in');

    expect(isWebAppleAuthState('web-apple:abc')).toBe(true);
    expect(parseWebAppleAuthState('web-apple:abc')).toEqual({ nonce: 'abc' });
    expect(isWebAppleAuthState('ios-auth:abc')).toBe(false);
    expect(parseWebAppleAuthState('ios-auth:abc')).toBeNull();
  });
});
