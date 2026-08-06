import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRun = vi.fn();
const mockGet = vi.fn();
const mockAll = vi.fn(() => [] as unknown[]);
const mockClearCache = vi.fn();
const mockClearCacheByPrefix = vi.fn();
const mockCreateNotificationIntent = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/services/notification-orchestrator', () => ({
  createNotificationIntent: (...args: unknown[]) => mockCreateNotificationIntent(...args),
}));

function expectCachePrefixesCleared(...prefixes: string[]) {
  const cleared = mockClearCacheByPrefix.mock.calls.flatMap(([prefix]) => (
    Array.isArray(prefix) ? prefix : [prefix]
  ));
  for (const prefix of prefixes) {
    expect(cleared).toContain(prefix);
  }
}

vi.mock('../../src/services/database', () => ({
  getDb: () => ({
    prepare: () => ({
      run: (...args: unknown[]) => mockRun(...args),
      get: (...args: unknown[]) => mockGet(...args),
      all: (...args: unknown[]) => mockAll(...args),
    }),
  }),
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

vi.mock('../../src/services/cache-store', () => ({
  clearCache: (...args: unknown[]) => mockClearCache(...args),
  clearCacheByPrefix: (...args: unknown[]) => mockClearCacheByPrefix(...args),
}));

vi.mock('../../src/services/content-notification-store', () => ({
  createNotification: vi.fn(),
}));

vi.mock('../../src/services/user-service', () => ({
  getUserById: vi.fn(),
  getUserByTelegramId: vi.fn(),
  getOwnerBootstrapUser: vi.fn(),
}));

vi.mock('../../src/utils/request-context', () => ({
  getCurrentContext: vi.fn(),
}));

vi.mock('../../src/config', () => ({
  config: {
    telegram: {
      allowedUserIds: [],
    },
  },
}));

describe('garmin-session-store cache invalidation', () => {
  beforeEach(() => {
    mockRun.mockReset();
    mockGet.mockReset();
    mockClearCache.mockReset();
    mockClearCacheByPrefix.mockReset();
    mockCreateNotificationIntent.mockClear();
  });

  it('clears readiness and dashboard caches when Garmin becomes active', async () => {
    const { markGarminConnectionActive } = await import('../../src/services/garmin-session-store');

    markGarminConnectionActive(86, 'athlete@example.com');

    // Stronger F34 guarantee: Garmin state changes must evict tenant-first
    // readiness rows, not the historical non-existent exact user key.
    expect(mockClearCache).not.toHaveBeenCalledWith('readiness:86');
    expectCachePrefixesCleared('readiness:', 'training-summary:', 'dashboard:86:', 'dashboard-home:86:');
  });

  it('clears readiness and dashboard caches when Garmin needs reauth', async () => {
    const { markGarminNeedsReauth } = await import('../../src/services/garmin-session-store');

    await markGarminNeedsReauth(86, 'silent_token_load_failed');

    expect(mockClearCache).not.toHaveBeenCalledWith('readiness:86');
    expectCachePrefixesCleared('readiness:', 'training-summary:', 'dashboard:86:', 'dashboard-home:86:');
    expect(mockCreateNotificationIntent).toHaveBeenCalledWith(expect.objectContaining({
      sourceSkill: 'training',
      type: 'sync_failure',
      dedupeKey: 'training:garmin_reauth:86',
      deeplink: 'nexus://connections/garmin/reauth',
    }));
  });

  it('clears readiness and dashboard caches when Garmin disconnects', async () => {
    const { clearGarminSession } = await import('../../src/services/garmin-session-store');

    clearGarminSession(86);

    expect(mockClearCache).not.toHaveBeenCalledWith('readiness:86');
    expectCachePrefixesCleared('readiness:', 'training-summary:', 'dashboard:86:', 'dashboard-home:86:');
  });

  it('returns null instead of assuming the owner when no request user is present', async () => {
    // This used to fall back to getOwnerBootstrapUser(). Any code path that
    // forgot runWithContext then silently ran as the owner — reading the
    // owner's Garmin data and persisting it under whichever user the caller
    // wrote next. That is the 2026-05 P0 tenant-leak class, and it had to be
    // patched per call site. Failing closed removes the class.
    const { getCurrentContext } = await import('../../src/utils/request-context');
    const { getOwnerBootstrapUser } = await import('../../src/services/user-service');
    vi.mocked(getCurrentContext).mockReturnValue(undefined as any);
    vi.mocked(getOwnerBootstrapUser).mockReturnValue({
      id: 42,
      telegram_id: 111111,
    } as any);

    const { resolveGarminUserId } = await import('../../src/services/garmin-session-store');

    expect(resolveGarminUserId()).toBeNull();
  });

  it('enumerates every connected user so scheduled work is not owner-only', async () => {
    // `garmin_keepalive` had no way to list users, so it ran once with no
    // context and refreshed whoever the owner fallback produced. Other
    // users' tokens were never refreshed and decayed into needs_reauth.
    const { getOwnerBootstrapUser } = await import('../../src/services/user-service');
    vi.mocked(getOwnerBootstrapUser).mockReturnValue({ id: 1, telegram_id: 111 } as any);
    mockAll.mockReturnValue([{ user_id: 1 }, { user_id: 2 }, { user_id: 3 }]);
    // Every candidate has usable session material.
    mockGet.mockReturnValue({ oauth1_token_json: '{"t":1}', oauth2_token_json: '{"t":2}' });

    const { listGarminConnectedUserIds } = await import('../../src/services/garmin-session-store');

    expect(listGarminConnectedUserIds()).toEqual([1, 2, 3]);
  });

  it('appends the owner legacy session when they have no active row', async () => {
    // The owner predates the per-user tables in some environments, so they can
    // hold usable session material with no `garmin_user_tokens` row at all.
    // Both other cases here arrange that branch away — one puts the owner in
    // the query result, the other has no owner — so it was never exercised.
    const { getOwnerBootstrapUser } = await import('../../src/services/user-service');
    vi.mocked(getOwnerBootstrapUser).mockReturnValue({ id: 99, telegram_id: 999 } as any);
    mockAll.mockReturnValue([{ user_id: 7 }]);
    mockGet.mockReturnValue({ oauth1_token_json: '{"t":1}', oauth2_token_json: '{"t":2}' });

    const { listGarminConnectedUserIds } = await import('../../src/services/garmin-session-store');

    expect(listGarminConnectedUserIds()).toEqual([7, 99]);
  });

  it('does not append an owner who has no session material either', async () => {
    const { getOwnerBootstrapUser } = await import('../../src/services/user-service');
    vi.mocked(getOwnerBootstrapUser).mockReturnValue({ id: 99, telegram_id: 999 } as any);
    mockAll.mockReturnValue([{ user_id: 7 }]);
    // Only user 7 has tokens; the owner has nothing to refresh.
    mockGet.mockImplementation((userId: number) => (
      userId === 7 ? { oauth1_token_json: '{"t":1}', oauth2_token_json: '{"t":2}' } : undefined
    ));

    const { listGarminConnectedUserIds } = await import('../../src/services/garmin-session-store');

    expect(listGarminConnectedUserIds()).toEqual([7]);
  });

  it('excludes active rows whose session material is missing', async () => {
    const { getOwnerBootstrapUser } = await import('../../src/services/user-service');
    vi.mocked(getOwnerBootstrapUser).mockReturnValue(undefined as any);
    mockAll.mockReturnValue([{ user_id: 4 }, { user_id: 5 }]);
    // User 4 has tokens; user 5 is marked active but has nothing to refresh.
    mockGet.mockImplementation((userId: number) => (
      userId === 4 ? { oauth1_token_json: '{"t":1}', oauth2_token_json: '{"t":2}' } : undefined
    ));

    const { listGarminConnectedUserIds } = await import('../../src/services/garmin-session-store');

    expect(listGarminConnectedUserIds()).toEqual([4]);
  });

  it('still honours an explicit user id and a scoped request context', async () => {
    const { getCurrentContext } = await import('../../src/utils/request-context');
    const { getUserById } = await import('../../src/services/user-service');
    vi.mocked(getUserById).mockImplementation(((id: number) => ({ id })) as any);

    const { resolveGarminUserId } = await import('../../src/services/garmin-session-store');

    vi.mocked(getCurrentContext).mockReturnValue(undefined as any);
    expect(resolveGarminUserId(7)).toBe(7);

    vi.mocked(getCurrentContext).mockReturnValue({ userId: 9 } as any);
    expect(resolveGarminUserId()).toBe(9);
  });

  it('requires an active per-user token row before Garmin is considered connected', async () => {
    mockGet
      .mockReturnValueOnce({ status: 'active' })
      .mockReturnValueOnce({
        oauth1_token_json: '{"token":"oauth1"}',
        oauth2_token_json: '{"token":"oauth2"}',
        last_refreshed_at: '2026-05-02T00:00:00Z',
        created_at: '2026-05-02T00:00:00Z',
        updated_at: '2026-05-02T00:00:00Z',
        user_id: 86,
      });

    const { hasActiveGarminConnection } = await import('../../src/services/garmin-session-store');

    expect(hasActiveGarminConnection(86)).toBe(true);
    expect(mockGet).toHaveBeenCalledWith(86);
  });

  it('does not treat an active metadata row without scoped session material as connected', async () => {
    mockGet
      .mockReturnValueOnce({ status: 'active' })
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ tokens_json: '{}' });

    const { hasActiveGarminConnection } = await import('../../src/services/garmin-session-store');

    expect(hasActiveGarminConnection(86)).toBe(false);
  });

  it('does not treat legacy session rows as an active user connection', async () => {
    mockGet.mockReturnValue(undefined);

    const { hasActiveGarminConnection } = await import('../../src/services/garmin-session-store');

    expect(hasActiveGarminConnection(87)).toBe(false);
  });

  it('allows owner-only legacy session material without exposing it to other users', async () => {
    const { getOwnerBootstrapUser } = await import('../../src/services/user-service');
    vi.mocked(getOwnerBootstrapUser).mockReturnValue({
      id: 42,
      telegram_id: 111111,
    } as any);
    mockGet
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({
        oauth1_token_json: '{"token":"oauth1"}',
        oauth2_token_json: '{"token":"oauth2"}',
        last_refreshed_at: '2026-05-02T00:00:00Z',
        created_at: '2026-05-02T00:00:00Z',
        updated_at: '2026-05-02T00:00:00Z',
        user_id: 42,
      })
      .mockReturnValueOnce(undefined);

    const { hasActiveGarminConnection } = await import('../../src/services/garmin-session-store');

    expect(hasActiveGarminConnection(42)).toBe(true);
    expect(hasActiveGarminConnection(43)).toBe(false);
  });

  it('does not treat reauth or MFA states as an active Garmin connection', async () => {
    const { hasActiveGarminConnection } = await import('../../src/services/garmin-session-store');

    mockGet.mockReturnValue({ status: 'needs_reauth' });
    expect(hasActiveGarminConnection(88)).toBe(false);

    mockGet.mockReturnValue({ status: 'mfa_pending' });
    expect(hasActiveGarminConnection(88)).toBe(false);
  });
});
