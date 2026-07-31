import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Garmin rate-limits per ACCOUNT, not per IP. Backoff state must therefore be
 * scoped to the user who tripped it.
 *
 * Before this was fixed, `_rateLimitedUntil` was a single module-level scalar
 * hydrated at import time — before any request context exists — so the process
 * booted holding the owner's backoff and applied it to every user for two
 * hours. One athlete's failed sync silently froze everyone else's.
 */

const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockGetCurrentContext = vi.fn();
const mockResolveGarminUserId = vi.fn();
const mockLoggerWarn = vi.fn();

const OWNER = 1000001;
const OTHER = 1000002;

vi.mock('../../src/config', () => ({
  config: {
    garmin: {
      email: 'athlete@example.invalid',
      password: 'secret',
      tokenPath: '/tmp/garmin-rate-limit-tests',
      coachEnabled: false,
      coachTime: '07:00',
    },
    telegram: { allowedUserIds: [1] },
    app: { timezone: 'Europe/Lisbon' },
  },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/utils/request-context', () => ({
  getCurrentContext: (...args: unknown[]) => mockGetCurrentContext(...args),
  runWithContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

vi.mock('../../src/services/garmin-session-store', () => ({
  resolveGarminUserId: (...args: unknown[]) => mockResolveGarminUserId(...args),
  getGarminSession: vi.fn(),
  markGarminNeedsReauth: vi.fn(),
  touchGarminConnection: vi.fn(),
  upsertGarminSession: vi.fn(),
  markGarminConnectionActive: vi.fn(),
  migrateLegacyGarminTokensToSession: vi.fn(),
  clearGarminSession: vi.fn(),
  isOwnerGarminUserId: vi.fn(),
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
      get: vi.fn(),
      post: vi.fn(),
      interceptors: { response: { use: vi.fn() }, request: { use: vi.fn() } },
    }),
  },
}));

vi.mock('garmin-connect', () => ({
  GarminConnect: class MockGarminConnect {
    client = { oauth1Token: null, oauth2Token: null };
    loadToken = vi.fn();
    loadTokenByFile = vi.fn();
  },
}));

async function importGarmin() {
  vi.resetModules();
  const mod = await import('../../src/services/garmin');
  mod._resetGarminRateLimitCacheForTests();
  return mod;
}

describe('Garmin rate-limit backoff is scoped per user', () => {
  beforeEach(() => {
    mockExistsSync.mockReset().mockReturnValue(false);
    mockReadFileSync.mockReset();
    mockWriteFileSync.mockReset();
    mockMkdirSync.mockReset();
    mockLoggerWarn.mockReset();
    mockGetCurrentContext.mockReset().mockReturnValue(undefined);
    mockResolveGarminUserId.mockReset().mockReturnValue(OWNER);
    vi.clearAllMocks();
  });

  it('does not block a second user when the first is rate-limited', async () => {
    const garmin = await importGarmin();

    garmin._garminRateLimitForTests.set(OWNER);

    expect(garmin._garminRateLimitForTests.isLimited(OWNER)).toBe(true);
    expect(garmin._garminRateLimitForTests.isLimited(OTHER)).toBe(false);
  });

  it('persists backoff to the tripping user own file, not a shared one', async () => {
    const garmin = await importGarmin();

    garmin._garminRateLimitForTests.set(OTHER);

    const written = mockWriteFileSync.mock.calls.map((c) => String(c[0]));
    expect(written.some((p) => p.includes(String(OTHER)))).toBe(true);
    expect(written.some((p) => p.includes(String(OWNER)))).toBe(false);
    // The legacy process-wide file must never be written again.
    expect(written.some((p) => p.endsWith('rate_limit_until.txt'))).toBe(false);
  });

  it('expires independently per user', async () => {
    const garmin = await importGarmin();

    // Owner backs off for an hour; the other user for a millisecond.
    garmin._garminRateLimitForTests.set(OWNER, 60 * 60 * 1000);
    garmin._garminRateLimitForTests.set(OTHER, 1);

    await new Promise((r) => setTimeout(r, 5));

    expect(garmin._garminRateLimitForTests.isLimited(OWNER)).toBe(true);
    expect(garmin._garminRateLimitForTests.isLimited(OTHER)).toBe(false);
  });

  it('hydrates a user backoff from that user own file on first read', async () => {
    const future = Date.now() + 60 * 60 * 1000;
    mockExistsSync.mockImplementation((p: string) => String(p).includes(String(OTHER)));
    mockReadFileSync.mockReturnValue(JSON.stringify({ rateLimitedUntil: future }));

    const garmin = await importGarmin();

    expect(garmin._garminRateLimitForTests.isLimited(OTHER)).toBe(true);
    // OWNER has no file, so it must not inherit OTHER's deadline.
    expect(garmin._garminRateLimitForTests.isLimited(OWNER)).toBe(false);
  });
});
