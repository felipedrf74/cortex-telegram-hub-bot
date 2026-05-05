import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRun = vi.fn();
const mockGet = vi.fn();
const mockClearCache = vi.fn();
const mockClearCacheByPrefix = vi.fn();
const mockCreateAndPushNotification = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/services/database', () => ({
  getDb: () => ({
    prepare: () => ({
      run: (...args: unknown[]) => mockRun(...args),
      get: (...args: unknown[]) => mockGet(...args),
    }),
  }),
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

vi.mock('../../src/services/cache-store', () => ({
  clearCache: (...args: unknown[]) => mockClearCache(...args),
  clearCacheByPrefix: (...args: unknown[]) => mockClearCacheByPrefix(...args),
}));

vi.mock('../../src/services/content-notification-store', () => ({
  createAndPushNotification: (...args: unknown[]) => mockCreateAndPushNotification(...args),
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
    mockCreateAndPushNotification.mockClear();
  });

  it('clears readiness and dashboard caches when Garmin becomes active', async () => {
    const { markGarminConnectionActive } = await import('../../src/services/garmin-session-store');

    markGarminConnectionActive(86, 'athlete@example.com');

    expect(mockClearCache).toHaveBeenCalledWith('readiness:86');
    expect(mockClearCache).toHaveBeenCalledWith('training-summary:86');
    expect(mockClearCacheByPrefix).toHaveBeenCalledWith('dashboard:86:');
    expect(mockClearCacheByPrefix).toHaveBeenCalledWith('dashboard-home:86:');
  });

  it('clears readiness and dashboard caches when Garmin needs reauth', async () => {
    const { markGarminNeedsReauth } = await import('../../src/services/garmin-session-store');

    await markGarminNeedsReauth(86, 'silent_token_load_failed');

    expect(mockClearCache).toHaveBeenCalledWith('readiness:86');
    expect(mockClearCache).toHaveBeenCalledWith('training-summary:86');
    expect(mockClearCacheByPrefix).toHaveBeenCalledWith('dashboard:86:');
    expect(mockClearCacheByPrefix).toHaveBeenCalledWith('dashboard-home:86:');
    expect(mockCreateAndPushNotification).toHaveBeenCalled();
  });

  it('clears readiness and dashboard caches when Garmin disconnects', async () => {
    const { clearGarminSession } = await import('../../src/services/garmin-session-store');

    clearGarminSession(86);

    expect(mockClearCache).toHaveBeenCalledWith('readiness:86');
    expect(mockClearCache).toHaveBeenCalledWith('training-summary:86');
    expect(mockClearCacheByPrefix).toHaveBeenCalledWith('dashboard:86:');
    expect(mockClearCacheByPrefix).toHaveBeenCalledWith('dashboard-home:86:');
  });

  it('falls back to the canonical owner bootstrap user when no request user is present', async () => {
    const { getCurrentContext } = await import('../../src/utils/request-context');
    const { getOwnerBootstrapUser } = await import('../../src/services/user-service');
    vi.mocked(getCurrentContext).mockReturnValue(undefined as any);
    vi.mocked(getOwnerBootstrapUser).mockReturnValue({
      id: 42,
      telegram_id: 111111,
    } as any);

    const { resolveGarminUserId } = await import('../../src/services/garmin-session-store');

    expect(resolveGarminUserId()).toBe(42);
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
