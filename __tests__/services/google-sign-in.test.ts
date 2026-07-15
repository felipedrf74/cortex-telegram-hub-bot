import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
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
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/config', () => ({
  config: {
    google: { clientId: 'google-web-client', iosClientId: 'google-ios-client', clientSecret: 'secret' },
    app: { timezone: 'Europe/Lisbon' },
  },
}));


function googlePayload(overrides: Record<string, unknown> = {}) {
  return {
    iss: 'https://accounts.google.com',
    aud: 'google-ios-client',
    sub: 'google-sub-1',
    email: 'verified@example.com',
    emailVerified: true,
    name: 'Verified User',
    picture: 'https://example.com/avatar.png',
    ...overrides,
  };
}

function seedEmailUser(email: string, verified: boolean): number {
  return Number(testDb.prepare(`
    INSERT INTO users (email, password_hash, first_name, email_verified, auth_provider, daily_cost_limit_usd)
    VALUES (?, ?, ?, ?, 'email', 0.05)
  `).run(email, 'bcrypt-hash', 'Existing', verified ? 1 : 0).lastInsertRowid);
}

describe('google-sign-in identity resolution', () => {
  beforeEach(async () => {
    testDb = createMigratedTestDatabase();
    vi.resetModules();
  });

  afterEach(() => {
    testDb?.close();
    vi.resetModules();
  });

  it('rejects Google sign-in when Google email_verified is false', async () => {
    const { resolveGoogleIdentityUser, GoogleEmailNotVerifiedError } = await import('../../src/services/google-sign-in');

    expect(() => resolveGoogleIdentityUser(googlePayload({ emailVerified: false }))).toThrow(GoogleEmailNotVerifiedError);
    const users = testDb.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };
    expect(users.count).toBe(0);
  });

  it('does not link Google to an existing unverified email/password account', async () => {
    const userId = seedEmailUser('verified@example.com', false);
    const { resolveGoogleIdentityUser, GoogleAccountLinkRequiresVerificationError } = await import('../../src/services/google-sign-in');

    expect(() => resolveGoogleIdentityUser(googlePayload())).toThrow(GoogleAccountLinkRequiresVerificationError);
    const row = testDb.prepare('SELECT google_user_id FROM users WHERE id = ?').get(userId) as { google_user_id: string | null };
    expect(row.google_user_id).toBeNull();
  });

  it('links Google only when the existing email/password account is verified', async () => {
    const userId = seedEmailUser('verified@example.com', true);
    const { resolveGoogleIdentityUser } = await import('../../src/services/google-sign-in');

    const user = resolveGoogleIdentityUser(googlePayload({ sub: 'google-sub-verified' }));

    expect(user.id).toBe(userId);
    const row = testDb.prepare('SELECT google_user_id FROM users WHERE id = ?').get(userId) as { google_user_id: string | null };
    expect(row.google_user_id).toBe('google-sub-verified');
  });

  it('creates a public Google user without an invite code', async () => {
    const { resolveGoogleIdentityUser } = await import('../../src/services/google-sign-in');

    const user = resolveGoogleIdentityUser(googlePayload({ sub: 'google-sub-public' }));

    expect(user.google_user_id).toBe('google-sub-public');
    expect(user.email).toBe('verified@example.com');
    expect(user.tier).toBe('free');
  });
});
