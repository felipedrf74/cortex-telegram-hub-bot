import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

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
}));

describe('apple-sign-in nonce guard', () => {
  beforeEach(() => {
    vi.resetModules();
    testDb = new Database(':memory:');
  });

  afterEach(() => {
    testDb?.close();
    vi.resetModules();
  });

  it('hashes the raw nonce with SHA-256 for Apple request binding', async () => {
    const { hashAppleRawNonce } = await import('../../src/services/apple-sign-in-nonce');

    expect(hashAppleRawNonce('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('consumes a valid raw nonce exactly once', async () => {
    const { consumeAppleSignInNonce, hashAppleRawNonce, AppleSignInNonceError } =
      await import('../../src/services/apple-sign-in-nonce');
    const rawNonce = 'nonce-with-enough-entropy';
    const tokenNonce = hashAppleRawNonce(rawNonce);

    expect(() =>
      consumeAppleSignInNonce({
        rawNonce,
        tokenNonce,
        appleUserId: 'apple-sub-1',
        nowMs: 1_762_000_000_000,
      }),
    ).not.toThrow();

    expect(() =>
      consumeAppleSignInNonce({
        rawNonce,
        tokenNonce,
        appleUserId: 'apple-sub-1',
        nowMs: 1_762_000_000_100,
      }),
    ).toThrow(AppleSignInNonceError);
  });

  it('rejects a token nonce that does not match the submitted raw nonce', async () => {
    const { consumeAppleSignInNonce, hashAppleRawNonce, AppleSignInNonceError } =
      await import('../../src/services/apple-sign-in-nonce');

    expect(() =>
      consumeAppleSignInNonce({
        rawNonce: 'nonce-with-enough-entropy',
        tokenNonce: hashAppleRawNonce('different-raw-nonce'),
        appleUserId: 'apple-sub-2',
      }),
    ).toThrow(AppleSignInNonceError);
  });
});
