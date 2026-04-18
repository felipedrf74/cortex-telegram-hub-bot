import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRun = vi.fn();
const mockClearCache = vi.fn();
const mockClearCacheByPrefix = vi.fn();
const mockCreateAndPushNotification = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/services/database', () => ({
  getDb: () => ({
    prepare: () => ({
      run: (...args: unknown[]) => mockRun(...args),
      get: vi.fn(),
    }),
  }),
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
  });

  it('clears readiness and dashboard caches when Garmin needs reauth', async () => {
    const { markGarminNeedsReauth } = await import('../../src/services/garmin-session-store');

    await markGarminNeedsReauth(86, 'silent_token_load_failed');

    expect(mockClearCache).toHaveBeenCalledWith('readiness:86');
    expect(mockClearCache).toHaveBeenCalledWith('training-summary:86');
    expect(mockClearCacheByPrefix).toHaveBeenCalledWith('dashboard:86:');
    expect(mockCreateAndPushNotification).toHaveBeenCalled();
  });

  it('clears readiness and dashboard caches when Garmin disconnects', async () => {
    const { clearGarminSession } = await import('../../src/services/garmin-session-store');

    clearGarminSession(86);

    expect(mockClearCache).toHaveBeenCalledWith('readiness:86');
    expect(mockClearCache).toHaveBeenCalledWith('training-summary:86');
    expect(mockClearCacheByPrefix).toHaveBeenCalledWith('dashboard:86:');
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
});
