import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;

const mockState = vi.hoisted(() => ({
  confidentialAcquire: vi.fn(),
  publicAcquire: vi.fn(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  },
  ownerRefs: [111111],
  config: {
    outlook: {
      clientId: 'outlook-client-id',
      clientSecret: 'outlook-client-secret',
      tenantId: 'consumers',
      refreshToken: 'owner-refresh-token',
    },
    telegram: {
      allowedUserIds: [111111],
    },
    financeEncryption: { masterKey: '' },
    app: { timezone: 'Europe/Lisbon' },
  },
}));

mockState.logger.child.mockReturnValue(mockState.logger);

vi.mock('@azure/msal-node', () => ({
  PublicClientApplication: vi.fn().mockImplementation(() => ({
    acquireTokenByRefreshToken: mockState.publicAcquire,
  })),
  ConfidentialClientApplication: vi.fn().mockImplementation(() => ({
    acquireTokenByRefreshToken: mockState.confidentialAcquire,
  })),
}));

vi.mock('../../src/config', () => ({
  config: mockState.config,
}));

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

vi.mock('../../src/services/user-service', () => ({
  getOwnerBootstrapUserRefs: () => mockState.ownerRefs,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: mockState.logger,
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/services/audit-trail', () => ({
  logAudit: vi.fn(),
}));

vi.mock('../../src/services/integration-cache-invalidator', () => ({
  invalidateIntegrationDerivedCaches: vi.fn(),
}));

function createOAuthSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE user_oauth_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      token_type TEXT NOT NULL DEFAULT 'Bearer',
      expires_at TEXT,
      scopes TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, provider)
    );
  `);
}

async function loadModules() {
  const microsoftAuth = await import('../../src/services/microsoft-auth');
  const oauthStore = await import('../../src/services/oauth-store');
  return { microsoftAuth, oauthStore };
}

async function loadModulesWithMsalClients() {
  const modules = await loadModules();
  modules.microsoftAuth.resetMicrosoftClients();
  modules.microsoftAuth.__testing.setMsalClientsForTests({
    confidential: { acquireTokenByRefreshToken: mockState.confidentialAcquire },
    public: { acquireTokenByRefreshToken: mockState.publicAcquire } as any,
  });
  return modules;
}

function storeOutlookTokens(oauthStore: typeof import('../../src/services/oauth-store'), userId: number, refreshToken: string): void {
  oauthStore.storeTokens(userId, 'outlook', {
    accessToken: `stored-access-${refreshToken}`,
    refreshToken,
    tokenType: 'Bearer',
    expiresAt: null,
    scopes: ['Tasks.ReadWrite'],
  });
}

describe('microsoft-auth access token cache', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useRealTimers();
    testDb = new Database(':memory:');
    createOAuthSchema(testDb);
    process.env.OAUTH_ENCRYPTION_KEY = 'test-key-deterministic-for-vitest-32chars';
    delete process.env.FINANCE_ENCRYPTION_KEY;
    mockState.confidentialAcquire.mockReset();
    mockState.publicAcquire.mockReset();
    mockState.logger.info.mockClear();
    mockState.logger.warn.mockClear();
    mockState.logger.error.mockClear();
    mockState.logger.debug.mockClear();
    mockState.logger.trace.mockClear();
    mockState.ownerRefs = [111111];
    mockState.config.outlook.clientSecret = 'outlook-client-secret';
    mockState.config.outlook.refreshToken = 'owner-refresh-token';
  });

  afterEach(() => {
    vi.useRealTimers();
    testDb?.close();
  });

  it('retries with a public MSAL client when Microsoft rejects the client secret for that refresh token', async () => {
    mockState.confidentialAcquire.mockRejectedValue(
      new Error("AADSTS90023: Public clients can't send a client secret"),
    );
    mockState.publicAcquire.mockResolvedValue({ accessToken: 'public-token' });

    const { microsoftAuth } = await loadModulesWithMsalClients();
    const token = await microsoftAuth.__testing.acquireAccessTokenFromRefreshToken('refresh-token');

    expect(token).toBe('public-token');
    expect(mockState.confidentialAcquire).toHaveBeenCalledTimes(1);
    expect(mockState.publicAcquire).toHaveBeenCalledTimes(1);
  });

  it('does not hide non-mismatch refresh token failures', async () => {
    mockState.confidentialAcquire.mockRejectedValue(
      new Error('AADSTS70000: refresh token expired'),
    );

    const { microsoftAuth } = await loadModulesWithMsalClients();

    await expect(microsoftAuth.__testing.acquireAccessTokenFromRefreshToken('refresh-token')).rejects.toThrow('AADSTS70000');
    expect(mockState.publicAcquire).not.toHaveBeenCalled();
  });

  it('detects the exact public-client mismatch error text we saw in live Outlook validation', async () => {
    const { microsoftAuth } = await loadModules();

    expect(
      microsoftAuth.__testing.isPublicClientRefreshTokenMismatch(
        new Error("AADSTS90023: Public clients can't send a client secret"),
      ),
    ).toBe(true);
    expect(microsoftAuth.__testing.isPublicClientRefreshTokenMismatch(new Error('AADSTS70000: refresh token expired'))).toBe(
      false,
    );
  });

  it('serves consecutive per-user calls from the access token cache within the TTL', async () => {
    const { microsoftAuth, oauthStore } = await loadModulesWithMsalClients();
    storeOutlookTokens(oauthStore, 25, 'refresh-user-25');
    mockState.confidentialAcquire.mockResolvedValue({ accessToken: 'access-user-25' });

    await expect(microsoftAuth.getAccessTokenForUser(25)).resolves.toBe('access-user-25');
    await expect(microsoftAuth.getAccessTokenForUser(25)).resolves.toBe('access-user-25');

    expect(mockState.confidentialAcquire).toHaveBeenCalledTimes(1);
    expect(microsoftAuth.__testing.getTokenCacheStatsForTests()).toMatchObject({ hits: 1, misses: 1 });
  });

  it('re-acquires after the cached access token TTL expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-08T12:00:00Z'));
    const { microsoftAuth, oauthStore } = await loadModulesWithMsalClients();
    storeOutlookTokens(oauthStore, 25, 'refresh-user-25');
    mockState.confidentialAcquire
      .mockResolvedValueOnce({ accessToken: 'access-user-25-a' })
      .mockResolvedValueOnce({ accessToken: 'access-user-25-b' });

    await expect(microsoftAuth.getAccessTokenForUser(25)).resolves.toBe('access-user-25-a');
    vi.advanceTimersByTime(microsoftAuth.__testing.ACCESS_TOKEN_CACHE_TTL_MS + 1);
    await expect(microsoftAuth.getAccessTokenForUser(25)).resolves.toBe('access-user-25-b');

    expect(mockState.confidentialAcquire).toHaveBeenCalledTimes(2);
  });

  it('memoizes public-client refresh-token flow and skips the failing confidential attempt after cache expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-08T12:00:00Z'));
    const { microsoftAuth, oauthStore } = await loadModulesWithMsalClients();
    storeOutlookTokens(oauthStore, 25, 'refresh-user-25');
    mockState.confidentialAcquire.mockRejectedValue(
      new Error("AADSTS90023: Public clients can't send a client secret"),
    );
    mockState.publicAcquire
      .mockResolvedValueOnce({ accessToken: 'public-access-a' })
      .mockResolvedValueOnce({ accessToken: 'public-access-b' });

    await expect(microsoftAuth.getAccessTokenForUser(25)).resolves.toBe('public-access-a');
    vi.advanceTimersByTime(microsoftAuth.__testing.ACCESS_TOKEN_CACHE_TTL_MS + 1);
    await expect(microsoftAuth.getAccessTokenForUser(25)).resolves.toBe('public-access-b');

    expect(mockState.confidentialAcquire).toHaveBeenCalledTimes(1);
    expect(mockState.publicAcquire).toHaveBeenCalledTimes(2);
    expect(mockState.logger.warn).toHaveBeenCalledTimes(1);
  });

  it('evicts only the affected user cache entry when new Outlook tokens are stored', async () => {
    const { microsoftAuth, oauthStore } = await loadModulesWithMsalClients();
    storeOutlookTokens(oauthStore, 25, 'refresh-user-25-a');
    storeOutlookTokens(oauthStore, 28, 'refresh-user-28-a');
    mockState.confidentialAcquire.mockImplementation(async ({ refreshToken }) => ({
      accessToken: `access-for-${refreshToken}`,
    }));

    await expect(microsoftAuth.getAccessTokenForUser(25)).resolves.toBe('access-for-refresh-user-25-a');
    await expect(microsoftAuth.getAccessTokenForUser(28)).resolves.toBe('access-for-refresh-user-28-a');

    oauthStore.storeTokens(25, 'outlook', {
      accessToken: 'stored-access-refresh-user-25-b',
      refreshToken: 'refresh-user-25-b',
      tokenType: 'Bearer',
      expiresAt: null,
      scopes: ['Tasks.ReadWrite'],
    });

    await expect(microsoftAuth.getAccessTokenForUser(25)).resolves.toBe('access-for-refresh-user-25-b');
    await expect(microsoftAuth.getAccessTokenForUser(28)).resolves.toBe('access-for-refresh-user-28-a');

    expect(mockState.confidentialAcquire).toHaveBeenCalledTimes(3);
  });

  it('evicts the disconnected user cache entry without disturbing another user', async () => {
    const { microsoftAuth, oauthStore } = await loadModulesWithMsalClients();
    storeOutlookTokens(oauthStore, 25, 'refresh-user-25-a');
    storeOutlookTokens(oauthStore, 28, 'refresh-user-28-a');
    mockState.confidentialAcquire.mockImplementation(async ({ refreshToken }) => ({
      accessToken: `access-for-${refreshToken}`,
    }));

    await expect(microsoftAuth.getAccessTokenForUser(25)).resolves.toBe('access-for-refresh-user-25-a');
    await expect(microsoftAuth.getAccessTokenForUser(28)).resolves.toBe('access-for-refresh-user-28-a');

    oauthStore.disconnectProvider(25, 'outlook');

    await expect(microsoftAuth.getAccessTokenForUser(25)).rejects.toThrow('Outlook not connected for user 25');
    await expect(microsoftAuth.getAccessTokenForUser(28)).resolves.toBe('access-for-refresh-user-28-a');

    expect(mockState.confidentialAcquire).toHaveBeenCalledTimes(2);
  });

  it('keeps access token cache entries isolated across users', async () => {
    const { microsoftAuth, oauthStore } = await loadModulesWithMsalClients();
    storeOutlookTokens(oauthStore, 25, 'refresh-user-25');
    storeOutlookTokens(oauthStore, 28, 'refresh-user-28');
    mockState.confidentialAcquire.mockImplementation(async ({ refreshToken }) => ({
      accessToken: `access-for-${refreshToken}`,
    }));

    await expect(microsoftAuth.getAccessTokenForUser(25)).resolves.toBe('access-for-refresh-user-25');
    await expect(microsoftAuth.getAccessTokenForUser(28)).resolves.toBe('access-for-refresh-user-28');
    await expect(microsoftAuth.getAccessTokenForUser(25)).resolves.toBe('access-for-refresh-user-25');
    await expect(microsoftAuth.getAccessTokenForUser(28)).resolves.toBe('access-for-refresh-user-28');

    expect(mockState.confidentialAcquire).toHaveBeenCalledTimes(2);
    expect(microsoftAuth.__testing.getTokenCacheStatsForTests()).toMatchObject({ hits: 2, misses: 2 });
  });

  it('uses an owner-scoped cache for the fallback owner token path', async () => {
    mockState.ownerRefs = [];
    mockState.config.outlook.refreshToken = 'owner-env-refresh';
    mockState.confidentialAcquire.mockResolvedValue({ accessToken: 'owner-access' });

    const { microsoftAuth } = await loadModulesWithMsalClients();

    await expect(microsoftAuth.__testing.getAccessTokenForOwner()).resolves.toBe('owner-access');
    await expect(microsoftAuth.__testing.getAccessTokenForOwner()).resolves.toBe('owner-access');

    expect(mockState.confidentialAcquire).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent cache misses so cold-launch fan-out pays one MSAL refresh', async () => {
    const { microsoftAuth, oauthStore } = await loadModulesWithMsalClients();
    storeOutlookTokens(oauthStore, 25, 'refresh-user-25');
    let resolveAcquire: ((value: { accessToken: string }) => void) | undefined;
    mockState.confidentialAcquire.mockImplementation(() => new Promise((resolve) => {
      resolveAcquire = resolve;
    }));

    const first = microsoftAuth.getAccessTokenForUser(25);
    const second = microsoftAuth.getAccessTokenForUser(25);

    resolveAcquire?.({ accessToken: 'coalesced-access' });

    await expect(first).resolves.toBe('coalesced-access');
    await expect(second).resolves.toBe('coalesced-access');
    expect(mockState.confidentialAcquire).toHaveBeenCalledTimes(1);
    expect(microsoftAuth.__testing.getTokenCacheStatsForTests()).toMatchObject({ misses: 1, coalesced: 1 });
  });
});
