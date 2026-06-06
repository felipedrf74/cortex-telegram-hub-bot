import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

describe('oauth-state-store', () => {
  beforeEach(() => {
    vi.resetModules();
    testDb = new Database(':memory:');
  });

  afterEach(async () => {
    const store = await import('../../src/services/oauth-state-store');
    store._resetOAuthNonceStoreForTests();
    testDb?.close();
  });

  it('stores nonce sessions in sqlite and consumes them once', async () => {
    const store = await import('../../src/services/oauth-state-store');

    const nonce = store.createOAuthNonceSession(42, 'google', 'nonce-123');

    expect(nonce).toBe('nonce-123');
    expect(
      testDb.prepare('SELECT user_id, provider FROM oauth_ios_nonce_sessions WHERE nonce = ?').get('nonce-123'),
    ).toEqual({ user_id: 42, provider: 'google' });

    expect(store.consumeOAuthNonceSession('nonce-123')).toEqual({ userId: 42, provider: 'google' });
    expect(store.consumeOAuthNonceSession('nonce-123')).toBeNull();
  });

  it('persists nonce sessions across module reloads when sqlite is available', async () => {
    let store = await import('../../src/services/oauth-state-store');
    store.createOAuthNonceSession(77, 'outlook', 'nonce-456');

    vi.resetModules();
    store = await import('../../src/services/oauth-state-store');

    expect(store.consumeOAuthNonceSession('nonce-456')).toEqual({ userId: 77, provider: 'outlook' });
  });
});
