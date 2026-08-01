import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `persistTokens` writes OAuth material under a resolved user id. Historically
 * it read that material from a process-wide `_client` singleton holding
 * whichever account last authenticated, so without a guard it copied one
 * athlete's Garmin tokens into another's `garmin_sessions` row — the exact
 * shape `scripts/cleanup-tainted-garmin-sessions.mjs` hunts for, and the class
 * behind the 2026-05 P0 tenant leak.
 *
 * The singleton is now a pool keyed by user, so the wrong client is
 * unreachable rather than merely rejected. These cases pin that outcome.
 *
 * Scope note: `resolveGarminUserId` is mocked here, so these cases prove how
 * `persistTokens` behaves for a given resolution — including `null`. They do
 * NOT prove that the resolver itself fails closed; that invariant lives in
 * `__tests__/services/garmin-session-store.test.ts`.
 */

const mockUpsertGarminSession = vi.fn();
const mockTouchGarminConnection = vi.fn();
const mockResolveGarminUserId = vi.fn();
const mockLoggerWarn = vi.fn();

const USER_A = 4001;
const USER_B = 4002;

vi.mock('../../src/config', () => ({
  config: {
    garmin: {
      email: 'owner@example.invalid',
      password: 'secret',
      tokenPath: '/tmp/garmin-tenant-guard-tests',
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
  getCurrentContext: vi.fn(() => undefined),
  runWithContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

vi.mock('../../src/services/garmin-session-store', () => ({
  resolveGarminUserId: (...args: unknown[]) => mockResolveGarminUserId(...args),
  upsertGarminSession: (...args: unknown[]) => mockUpsertGarminSession(...args),
  touchGarminConnection: (...args: unknown[]) => mockTouchGarminConnection(...args),
  getGarminSession: vi.fn(),
  markGarminNeedsReauth: vi.fn(),
  markGarminConnectionActive: vi.fn(),
  migrateLegacyGarminTokensToSession: vi.fn(),
  clearGarminSession: vi.fn(),
  isOwnerGarminUserId: vi.fn(() => false),
  hasActiveGarminConnection: vi.fn(() => true),
  listGarminConnectedUserIds: vi.fn(() => []),
}));

vi.mock('fs', () => {
  const noop = vi.fn();
  return {
    default: { existsSync: vi.fn(() => false), readFileSync: noop, writeFileSync: noop, mkdirSync: noop },
    existsSync: vi.fn(() => false),
    readFileSync: noop,
    writeFileSync: noop,
    mkdirSync: noop,
  };
});

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

/** A stand-in for an authenticated client holding one account's tokens. */
function clientHoldingTokensFor(label: string) {
  return { client: { oauth1Token: { token: `oauth1-${label}` }, oauth2Token: { token: `oauth2-${label}` } } };
}

async function importGarmin() {
  vi.resetModules();
  return import('../../src/services/garmin');
}

describe('Garmin token persistence tenant guard', () => {
  beforeEach(() => {
    mockUpsertGarminSession.mockReset();
    mockTouchGarminConnection.mockReset();
    mockResolveGarminUserId.mockReset();
    mockLoggerWarn.mockReset();
  });

  it('refuses to write one user tokens into another user session row', async () => {
    const garmin = await importGarmin();
    // The live client belongs to user A...
    garmin._garminTokenPersistenceForTests.setActiveClient(clientHoldingTokensFor('user-a'), USER_A);
    // ...but the request in flight resolves to user B.
    mockResolveGarminUserId.mockReturnValue(USER_B);

    garmin._garminTokenPersistenceForTests.persist();

    expect(mockUpsertGarminSession).not.toHaveBeenCalled();
    expect(mockTouchGarminConnection).not.toHaveBeenCalled();
  });

  it('persists normally when the live client belongs to the resolved user', async () => {
    const garmin = await importGarmin();
    garmin._garminTokenPersistenceForTests.setActiveClient(clientHoldingTokensFor('user-a'), USER_A);
    mockResolveGarminUserId.mockReturnValue(USER_A);

    garmin._garminTokenPersistenceForTests.persist();

    expect(mockUpsertGarminSession).toHaveBeenCalledWith(USER_A, {
      oauth1: { token: 'oauth1-user-a' },
      oauth2: { token: 'oauth2-user-a' },
    });
    expect(mockTouchGarminConnection).toHaveBeenCalledWith(USER_A);
  });

  it('writes nothing when no user is in scope', async () => {
    const garmin = await importGarmin();
    garmin._garminTokenPersistenceForTests.setActiveClient(clientHoldingTokensFor('user-a'), USER_A);
    // Simulates the fail-closed resolver's output. That the resolver actually
    // returns null with no context is proven in garmin-session-store.test.ts;
    // here the resolver is mocked, so this only pins that `persistTokens`
    // writes nothing when handed no user.
    mockResolveGarminUserId.mockReturnValue(null);

    garmin._garminTokenPersistenceForTests.persist();

    expect(mockUpsertGarminSession).not.toHaveBeenCalled();
  });

  it('writes nothing when no client has authenticated yet', async () => {
    const garmin = await importGarmin();
    garmin._garminTokenPersistenceForTests.setActiveClient(null, null);
    mockResolveGarminUserId.mockReturnValue(USER_A);

    garmin._garminTokenPersistenceForTests.persist();

    expect(mockUpsertGarminSession).not.toHaveBeenCalled();
  });

  // The client used to be a process-wide singleton, torn down and rebuilt on
  // every user switch. The keep-alive fan-out interleaves users by
  // construction, so that meant a full teardown per user per tick — and it
  // left `persistTokens` responsible for noticing that the live client
  // belonged to someone else. Keying by user makes the wrong client
  // unreachable rather than merely rejected.
  describe('per-user client pool', () => {
    it('keeps both users authenticated instead of evicting on switch', async () => {
      const garmin = await importGarmin();
      garmin._garminTokenPersistenceForTests.setActiveClient(clientHoldingTokensFor('user-a'), USER_A);
      garmin._garminTokenPersistenceForTests.adoptClient(clientHoldingTokensFor('user-b'), USER_B);

      expect(garmin._garminTokenPersistenceForTests.pooledUserIds()).toEqual([USER_A, USER_B]);
    });

    it('persists each user from their own client after a switch', async () => {
      const garmin = await importGarmin();
      garmin._garminTokenPersistenceForTests.setActiveClient(clientHoldingTokensFor('user-a'), USER_A);
      garmin._garminTokenPersistenceForTests.adoptClient(clientHoldingTokensFor('user-b'), USER_B);

      // User B authenticated most recently. User A must still persist its own
      // tokens rather than being treated as evicted.
      mockResolveGarminUserId.mockReturnValue(USER_A);
      garmin._garminTokenPersistenceForTests.persist();

      expect(mockUpsertGarminSession).toHaveBeenCalledWith(USER_A, {
        oauth1: { token: 'oauth1-user-a' },
        oauth2: { token: 'oauth2-user-a' },
      });
    });

    it('bounds the pool and evicts the coldest entry, never the hottest', async () => {
      const garmin = await importGarmin();
      // 17 users through a pool bounded at 16.
      for (let userId = 1; userId <= 17; userId += 1) {
        garmin._garminTokenPersistenceForTests.adoptClient(clientHoldingTokensFor(`u${userId}`), userId);
      }

      const pooled = garmin._garminTokenPersistenceForTests.pooledUserIds();
      expect(pooled.length).toBeLessThanOrEqual(16);
      // User 1 was coldest; user 17 was just adopted.
      expect(pooled).not.toContain(1);
      expect(pooled).toContain(17);
    });

    it('an evicted user simply re-hydrates rather than persisting stale tokens', async () => {
      const garmin = await importGarmin();
      for (let userId = 1; userId <= 17; userId += 1) {
        garmin._garminTokenPersistenceForTests.adoptClient(clientHoldingTokensFor(`u${userId}`), userId);
      }

      // User 1 was evicted, so there is nothing of theirs to write.
      mockResolveGarminUserId.mockReturnValue(1);
      garmin._garminTokenPersistenceForTests.persist();

      expect(mockUpsertGarminSession).not.toHaveBeenCalled();
    });

    it('keeps the unscoped legacy client separate from every real user', async () => {
      const garmin = await importGarmin();
      // The owner credential path has no user id and parks under key 0.
      garmin._garminTokenPersistenceForTests.adoptClient(clientHoldingTokensFor('legacy'), null);
      garmin._garminTokenPersistenceForTests.adoptClient(clientHoldingTokensFor('user-a'), USER_A);

      expect(garmin._garminTokenPersistenceForTests.pooledUserIds()).toEqual([0, USER_A]);

      // A real user must never be served the unscoped client's tokens.
      mockResolveGarminUserId.mockReturnValue(USER_B);
      garmin._garminTokenPersistenceForTests.persist();
      expect(mockUpsertGarminSession).not.toHaveBeenCalled();
    });

    it('never writes one user tokens under another id while both are pooled', async () => {
      const garmin = await importGarmin();
      garmin._garminTokenPersistenceForTests.setActiveClient(clientHoldingTokensFor('user-a'), USER_A);
      garmin._garminTokenPersistenceForTests.adoptClient(clientHoldingTokensFor('user-b'), USER_B);

      mockResolveGarminUserId.mockReturnValue(USER_B);
      garmin._garminTokenPersistenceForTests.persist();

      expect(mockUpsertGarminSession).toHaveBeenCalledWith(USER_B, {
        oauth1: { token: 'oauth1-user-b' },
        oauth2: { token: 'oauth2-user-b' },
      });
      expect(mockUpsertGarminSession).not.toHaveBeenCalledWith(USER_B, {
        oauth1: { token: 'oauth1-user-a' },
        oauth2: { token: 'oauth2-user-a' },
      });
    });
  });
});
