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
    telegram: { allowedUserIds: [111111] },
    google: { clientId: 'gid', clientSecret: 'gsec', refreshToken: null },
    outlook: { clientId: 'oid', clientSecret: null, tenantId: 'common', refreshToken: null },
    financeEncryption: { masterKey: '' },
    app: { timezone: 'Europe/Lisbon' },
  },
}));


import { storeTokens, _resetDecryptCacheForTests } from '../../src/services/oauth-store';
import {
  buildGoogleOAuth2ClientForUser,
  getOwnerGoogleRefreshToken,
} from '../../src/services/google-auth';
import { isMicrosoftConfigured } from '../../src/services/microsoft-auth';
import {
  getOAuthConnectionAuthFailure,
  markOAuthConnectionAuthFailure,
} from '../../src/services/oauth-connection-health';

describe('owner integration bootstrap token resolution', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
    vi.unstubAllEnvs();
    vi.stubEnv('OWNER_TELEGRAM_ID', '');
    process.env.OAUTH_ENCRYPTION_KEY = 'test-key-deterministic-for-vitest-32chars';
    _resetDecryptCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    testDb?.close();
  });

  it('prefers the canonical owner users.id when reading Google owner tokens', () => {
    testDb.prepare(`
      INSERT INTO users (telegram_id, first_name, tier, status, daily_message_limit, daily_token_limit, daily_cost_limit_usd)
      VALUES (111111, 'Owner', 'owner', 'active', 0, 0, 0)
    `).run();
    const owner = testDb.prepare('SELECT id FROM users WHERE telegram_id = 111111').get() as { id: number };

    storeTokens(owner.id, 'google', {
      accessToken: '',
      refreshToken: 'canonical-google-token',
      tokenType: 'Bearer',
      expiresAt: null,
      scopes: [],
    });

    expect(getOwnerGoogleRefreshToken()).toBe('canonical-google-token');
  });

  it('falls back to legacy telegram-keyed Google owner tokens when canonical rows are absent', () => {
    testDb.prepare(`
      INSERT INTO users (telegram_id, first_name, tier, status, daily_message_limit, daily_token_limit, daily_cost_limit_usd)
      VALUES (111111, 'Owner', 'owner', 'active', 0, 0, 0)
    `).run();

    storeTokens(111111, 'google', {
      accessToken: '',
      refreshToken: 'legacy-google-token',
      tokenType: 'Bearer',
      expiresAt: null,
      scopes: [],
    });

    expect(getOwnerGoogleRefreshToken()).toBe('legacy-google-token');
  });

  it('treats legacy telegram-keyed Outlook owner tokens as configured when canonical rows are absent', () => {
    testDb.prepare(`
      INSERT INTO users (telegram_id, first_name, tier, status, daily_message_limit, daily_token_limit, daily_cost_limit_usd)
      VALUES (111111, 'Owner', 'owner', 'active', 0, 0, 0)
    `).run();

    storeTokens(111111, 'outlook', {
      accessToken: '',
      refreshToken: 'legacy-outlook-token',
      tokenType: 'Bearer',
      expiresAt: null,
      scopes: [],
    });

    expect(isMicrosoftConfigured()).toBe(true);
  });

  it('marks a deterministic per-user Google refresh rejection', async () => {
    storeTokens(25, 'google', {
      accessToken: '',
      refreshToken: 'refresh-user-25',
      tokenType: 'Bearer',
      expiresAt: null,
      scopes: [],
    });
    const client = buildGoogleOAuth2ClientForUser(25);
    vi.spyOn(client.transporter, 'request').mockRejectedValue(Object.assign(
      new Error('invalid_grant'),
      { response: { data: { error: 'invalid_grant' } } },
    ));

    await expect(client.getAccessToken()).rejects.toThrow('invalid_grant');

    expect(getOAuthConnectionAuthFailure(25, 'google')).toMatchObject({
      state: 'auth_rejected',
      reasonCode: 'invalid_grant',
    });
  });

  it('does not mark transient Google refresh failures as revoked', async () => {
    storeTokens(26, 'google', {
      accessToken: '',
      refreshToken: 'refresh-user-26',
      tokenType: 'Bearer',
      expiresAt: null,
      scopes: [],
    });
    const client = buildGoogleOAuth2ClientForUser(26);
    vi.spyOn(client.transporter, 'request').mockRejectedValue(new Error('ECONNRESET'));

    await expect(client.getAccessToken()).rejects.toThrow('ECONNRESET');
    expect(getOAuthConnectionAuthFailure(26, 'google')).toBeNull();
  });

  it('clears the user-scoped failure after a successful Google refresh', async () => {
    storeTokens(27, 'google', {
      accessToken: '',
      refreshToken: 'refresh-user-27',
      tokenType: 'Bearer',
      expiresAt: null,
      scopes: [],
    });
    markOAuthConnectionAuthFailure(27, 'google', 'invalid_token');
    const client = buildGoogleOAuth2ClientForUser(27);
    vi.spyOn(client.transporter, 'request').mockResolvedValue({
      data: { access_token: 'fresh-access-27', expires_in: 3600 },
    } as never);

    await expect(client.getAccessToken()).resolves.toMatchObject({ token: 'fresh-access-27' });
    expect(getOAuthConnectionAuthFailure(27, 'google')).toBeNull();
  });

  it('does not let an old in-flight Google refresh revoke a newly reauthed token', async () => {
    storeTokens(28, 'google', {
      accessToken: '',
      refreshToken: 'old-refresh-user-28',
      tokenType: 'Bearer',
      expiresAt: null,
      scopes: [],
    });
    const staleClient = buildGoogleOAuth2ClientForUser(28);
    storeTokens(28, 'google', {
      accessToken: '',
      refreshToken: 'new-refresh-user-28',
      tokenType: 'Bearer',
      expiresAt: null,
      scopes: [],
    });
    vi.spyOn(staleClient.transporter, 'request').mockRejectedValue(
      new Error('invalid_grant'),
    );

    await expect(staleClient.getAccessToken()).rejects.toThrow('invalid_grant');
    expect(getOAuthConnectionAuthFailure(28, 'google')).toBeNull();
  });
});
