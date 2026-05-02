import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetGarminSession = vi.fn();
const mockResolveGarminUserId = vi.fn();
const mockMarkGarminNeedsReauth = vi.fn();
const mockTouchGarminConnection = vi.fn();
const mockUpsertGarminSession = vi.fn();
const mockMarkGarminConnectionActive = vi.fn();
const mockMigrateLegacyTokens = vi.fn();
const mockClearGarminSession = vi.fn();
const mockLoggerInfo = vi.fn();
const mockLoggerWarn = vi.fn();
const mockLoggerError = vi.fn();
const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockAxiosGet = vi.fn();
const mockAxiosPost = vi.fn();
const mockGetUserSettings = vi.fn();
const mockRefreshOauth2Token = vi.fn();
const mockFetchOauthConsumer = vi.fn();
const mockGarminGet = vi.fn();

vi.mock('../../src/services/garmin-session-store', () => ({
  getGarminSession: (...args: unknown[]) => mockGetGarminSession(...args),
  resolveGarminUserId: (...args: unknown[]) => mockResolveGarminUserId(...args),
  markGarminNeedsReauth: (...args: unknown[]) => mockMarkGarminNeedsReauth(...args),
  touchGarminConnection: (...args: unknown[]) => mockTouchGarminConnection(...args),
  upsertGarminSession: (...args: unknown[]) => mockUpsertGarminSession(...args),
  markGarminConnectionActive: (...args: unknown[]) => mockMarkGarminConnectionActive(...args),
  migrateLegacyGarminTokensToSession: (...args: unknown[]) => mockMigrateLegacyTokens(...args),
  clearGarminSession: (...args: unknown[]) => mockClearGarminSession(...args),
}));

vi.mock('../../src/config', () => ({
  config: {
    garmin: {
      email: 'athlete@example.com',
      password: 'secret',
      tokenPath: '/tmp/garmin-tests',
      coachEnabled: true,
      coachTime: '07:00',
    },
    telegram: {
      allowedUserIds: [1],
    },
    app: {
      timezone: 'Europe/Lisbon',
    },
  },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock('fs', () => ({
  default: {
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  },
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
}));

vi.mock('axios', () => ({
  default: {
    create: () => ({
      get: (...args: unknown[]) => mockAxiosGet(...args),
      post: (...args: unknown[]) => mockAxiosPost(...args),
      interceptors: {
        response: { use: vi.fn() },
        request: { use: vi.fn() },
      },
    }),
  },
}));

vi.mock('garmin-connect', () => ({
  GarminConnect: class MockGarminConnect {
    client = {
      oauth1Token: { token: 'oauth1-live' },
      oauth2Token: { token: 'oauth2-live' },
      refreshOauth2Token: (...args: unknown[]) => mockRefreshOauth2Token(...args),
      fetchOauthConsumer: (...args: unknown[]) => mockFetchOauthConsumer(...args),
    };

    loadToken = vi.fn();
    loadTokenByFile = vi.fn();
    getUserSettings = (...args: unknown[]) => mockGetUserSettings(...args);
    get = (...args: unknown[]) => mockGarminGet(...args);
  },
}));

describe('garmin passive auth safety', () => {
  beforeEach(() => {
    vi.resetModules();
    mockGetGarminSession.mockReset();
    mockResolveGarminUserId.mockReset();
    mockMarkGarminNeedsReauth.mockReset();
    mockTouchGarminConnection.mockReset();
    mockUpsertGarminSession.mockReset();
    mockMarkGarminConnectionActive.mockReset();
    mockMigrateLegacyTokens.mockReset();
    mockClearGarminSession.mockReset();
    mockLoggerInfo.mockReset();
    mockLoggerWarn.mockReset();
    mockLoggerError.mockReset();
    mockExistsSync.mockReset();
    mockReadFileSync.mockReset();
    mockWriteFileSync.mockReset();
    mockMkdirSync.mockReset();
    mockAxiosGet.mockReset();
    mockAxiosPost.mockReset();
    mockGetUserSettings.mockReset();
    mockRefreshOauth2Token.mockReset();
    mockFetchOauthConsumer.mockReset();
    mockGarminGet.mockReset();

    mockResolveGarminUserId.mockReturnValue(12);
    mockGetGarminSession.mockReturnValue({
      userId: 12,
      oauth1TokenJson: JSON.stringify({ token: 'oauth1-stored' }),
      oauth2TokenJson: JSON.stringify({ token: 'oauth2-stored' }),
      lastRefreshedAt: '2026-04-15T20:00:00Z',
      createdAt: '2026-04-15T20:00:00Z',
      updatedAt: '2026-04-15T20:00:00Z',
    });
    mockMigrateLegacyTokens.mockReturnValue(false);
    mockExistsSync.mockReturnValue(false);
    mockMarkGarminNeedsReauth.mockResolvedValue(undefined);
    mockRefreshOauth2Token.mockRejectedValue(new Error('refresh failed'));
    mockGetUserSettings.mockRejectedValue(new Error('stored tokens expired'));
  });

  it('keepAlive never falls back to a fresh Garmin login when stored tokens are stale', async () => {
    const { keepAlive } = await import('../../src/services/garmin');

    const ok = await keepAlive();

    expect(ok).toBe(false);
    expect(mockFetchOauthConsumer).not.toHaveBeenCalled();
    expect(mockMarkGarminNeedsReauth).toHaveBeenCalled();
  });

  it('ensureAuthenticated silent mode never triggers a fresh Garmin login', async () => {
    const { ensureAuthenticated } = await import('../../src/services/garmin');

    const ok = await ensureAuthenticated({ silent: true });

    expect(ok).toBe(false);
    expect(mockFetchOauthConsumer).not.toHaveBeenCalled();
    expect(mockMarkGarminNeedsReauth).toHaveBeenCalled();
  });

  it('silent data reads return null instead of starting a new Garmin MFA flow', async () => {
    const { getDailySummary, setSilentMode } = await import('../../src/services/garmin');
    setSilentMode(true);

    const summary = await getDailySummary('2026-04-15');

    expect(summary).toBeNull();
    expect(mockFetchOauthConsumer).not.toHaveBeenCalled();
    expect(mockMarkGarminNeedsReauth).toHaveBeenCalled();
  });

  it('request-scoped data reads do not import legacy filesystem tokens into the user connection', async () => {
    mockGetGarminSession.mockReturnValue(null);
    mockExistsSync.mockReturnValue(true);
    const { getDailySummary, setSilentMode } = await import('../../src/services/garmin');
    setSilentMode(true);

    const summary = await getDailySummary('2026-04-15');

    expect(summary).toBeNull();
    const legacyTokenChecks = mockExistsSync.mock.calls.filter(([filePath]) =>
      String(filePath).includes('oauth1_token.json') || String(filePath).includes('oauth2_token.json')
    );
    expect(legacyTokenChecks).toEqual([]);
    expect(mockMigrateLegacyTokens).toHaveBeenCalledWith(12);
    expect(mockMarkGarminConnectionActive).not.toHaveBeenCalled();
    expect(mockFetchOauthConsumer).not.toHaveBeenCalled();
  });

  it('treats daily summary 403 as missing data instead of starting auth recovery', async () => {
    mockGetUserSettings.mockResolvedValue({ displayName: 'Athlete' });
    mockGarminGet.mockRejectedValue(new Error('ERROR: (403), Forbidden, {"message":null,"error":"ForbiddenException"}'));

    const { getDailySummary } = await import('../../src/services/garmin');

    const summary = await getDailySummary('2026-05-01');

    expect(summary).toBeNull();
    expect(mockRefreshOauth2Token).not.toHaveBeenCalled();
    expect(mockMarkGarminNeedsReauth).not.toHaveBeenCalled();
    expect(mockFetchOauthConsumer).not.toHaveBeenCalled();
  });
});
