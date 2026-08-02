/**
 * APNs sender tests.
 *
 * Strategy:
 *   - config.apns is mocked per-test via vi.mock('../../src/config')
 *   - node:http2 is mocked so we never hit a real network
 *   - better-sqlite3 is mocked for the push-token lookup helper
 *   - jsonwebtoken is mocked so we don't need a real ES256 key
 *
 * Coverage:
 *   - isApnsConfigured() gating (all 4 env vars must be present)
 *   - sendPushNotification() no-ops when gating fails, logs warn once
 *   - sendPushNotification() returns zero counts when user has no devices
 *   - sendPushNotification() dispatches to each device and tallies outcomes
 *   - 410 Gone tokens are cleared from the ios_devices table
 *   - 429/500 are counted as retriable (not failed)
 *   - getProviderJwt() caches — second call returns the same token
 *   - APNS_ENVIRONMENT flips the host between production and sandbox
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// ── Mock the config module ─────────────────────────────────────────
// We re-configure per test by mutating `mockedApnsConfig`. Declared
// as a `let` so individual tests can flip flags without re-importing.
let mockedApnsConfig = {
  enabled: true,
  teamId: 'TESTTEAMID',
  keyId: 'TESTKEYID',
  bundleId: 'me.nexushub.test',
  authKey: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----',
  environment: 'sandbox' as 'sandbox' | 'production',
};

vi.mock('../../src/config', () => ({
  config: {
    get apns() {
      return mockedApnsConfig;
    },
  },
}));

// ── Mock the logger so warn/error don't pollute test output ────────
vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

// ── Mock better-sqlite3 / database module ───────────────────────────
// The push-token lookup queries ios_devices; we stub the prepare().all()
// chain so tests can set their own return value per-test.
type MockPushTokenRow = string | { token: string; environment?: 'sandbox' | 'production'; deviceId?: string | null };
const mockPushTokensForUser: Record<number, MockPushTokenRow[]> = {};
const mockPushTokenDeletions: string[] = [];
let mockPushTokenSelectError: Error | null = null;

vi.mock('../../src/services/database', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      all: (...args: unknown[]) => {
        if (sql.includes('SELECT DISTINCT') && sql.includes('push_token')) {
          if (mockPushTokenSelectError) throw mockPushTokenSelectError;
          const userId = Number(args[args.length - 1]);
          return (mockPushTokensForUser[userId] || []).map((entry) => {
            if (typeof entry === 'string') {
              return {
                push_token: entry,
                device_id: `device-${entry}`,
                environment: mockedApnsConfig.environment,
              };
            }
            return {
              push_token: entry.token,
              device_id: entry.deviceId ?? `device-${entry.token}`,
              environment: entry.environment ?? mockedApnsConfig.environment,
            };
          });
        }
        return [];
      },
      run: (...args: unknown[]) => {
        if (sql.includes('UPDATE ios_devices SET push_token = NULL WHERE push_token = ?')) {
          mockPushTokenDeletions.push(args[0] as string);
        }
        return { changes: 1 };
      },
    }),
  }),
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

// ── Mock jsonwebtoken so we don't need a real ES256 key ─────────────
let jwtSignCallCount = 0;
vi.mock('jsonwebtoken', () => ({
  default: {
    sign: vi.fn((_payload: unknown, _secret: string, _opts: unknown) => {
      jwtSignCallCount += 1;
      return `fake.jwt.token.${jwtSignCallCount}`;
    }),
  },
}));

// ── Mock node:http2 so every request outcome is scripted ────────────
//
// Tests set `mockHttp2Response` to script the next request's response.
// Multiple requests in one test consume from `mockHttp2Responses` (FIFO).
interface ScriptedResponse {
  status: number;
  body?: string;
  networkError?: string;
}

let mockHttp2Responses: ScriptedResponse[] = [];
const mockHttp2Requests: Array<{ headers: Record<string, string>; body: string }> = [];
const mockHttp2Hosts: string[] = [];
let mockHttp2Connected = false;
const mockRecordOperatorAlert = vi.fn();

vi.mock('node:http2', () => ({
  default: {
    connect: (host: string) => {
      mockHttp2Connected = true;
      mockHttp2Hosts.push(host);
      const session = {
        host,
        closed: false,
        destroyed: false,
        request(headers: Record<string, string>) {
          const scripted = mockHttp2Responses.shift() || { status: 200 };
          const requestState = { capturedBody: '' };
          const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

          const req = {
            on(event: string, cb: (...args: unknown[]) => void) {
              listeners[event] = listeners[event] || [];
              listeners[event].push(cb);
              return req;
            },
            setEncoding() {
              /* no-op */
            },
            end(body: string) {
              requestState.capturedBody = body;
              mockHttp2Requests.push({ headers, body });
              // Simulate async response delivery
              setImmediate(() => {
                if (scripted.networkError) {
                  (listeners.error || []).forEach((cb) => cb(new Error(scripted.networkError!)));
                  return;
                }
                (listeners.response || []).forEach((cb) =>
                  cb({ ':status': scripted.status }),
                );
                if (scripted.body) {
                  (listeners.data || []).forEach((cb) => cb(Buffer.from(scripted.body!)));
                }
                (listeners.end || []).forEach((cb) => cb());
              });
            },
            close() {
              /* no-op */
            },
          };
          return req;
        },
        on() {
          return session;
        },
        close() {
          mockHttp2Connected = false;
        },
      };
      return session;
    },
  },
}));

vi.mock('../../src/services/operator-alerts', () => ({
  recordOperatorAlert: (...args: unknown[]) => mockRecordOperatorAlert(...args),
}));

// ── Import the module under test AFTER mocks are set up ────────────
import {
  isApnsConfigured,
  sendPushNotification,
  getPushTokensForUser,
  closeApnsClient,
  _resetForTests,
} from '../../src/services/apns-sender';
import { logger } from '../../src/utils/logger';
import { clearTenantScopeAnomaliesForTests, getTenantScopeAnomalies } from '../../src/services/tenant-scope-observability';

// ── Shared setup/teardown ──────────────────────────────────────────

beforeEach(() => {
  // Reset all test-scoped mutable state
  mockedApnsConfig = {
    enabled: true,
    teamId: 'TESTTEAMID',
    keyId: 'TESTKEYID',
    bundleId: 'me.nexushub.test',
    authKey: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----',
    environment: 'sandbox',
  };
  mockHttp2Responses = [];
  mockHttp2Requests.length = 0;
  mockHttp2Hosts.length = 0;
  mockHttp2Connected = false;
  jwtSignCallCount = 0;
  for (const k of Object.keys(mockPushTokensForUser)) {
    delete mockPushTokensForUser[Number(k)];
  }
  mockPushTokenDeletions.length = 0;
  mockPushTokenSelectError = null;
  mockRecordOperatorAlert.mockReset();
  vi.mocked(logger.warn).mockClear();
  vi.mocked(logger.error).mockClear();
  vi.mocked(logger.info).mockClear();
  clearTenantScopeAnomaliesForTests();
  // CRITICAL: reset module-level singletons in the sender — without this,
  // cachedJwt and warnedMissingConfig leak across tests.
  _resetForTests();
});

afterEach(() => {
  closeApnsClient();
});

// ═══════════════════════════════════════════════════════════════════
// isApnsConfigured() gating
// ═══════════════════════════════════════════════════════════════════

describe('isApnsConfigured', () => {
  it('returns true when all four env vars are present AND enabled', () => {
    expect(isApnsConfigured()).toBe(true);
  });

  it('returns false when APNS_ENABLED is false', () => {
    mockedApnsConfig.enabled = false;
    expect(isApnsConfigured()).toBe(false);
  });

  it('returns false when teamId is missing', () => {
    mockedApnsConfig.teamId = '';
    expect(isApnsConfigured()).toBe(false);
  });

  it('returns false when keyId is missing', () => {
    mockedApnsConfig.keyId = '';
    expect(isApnsConfigured()).toBe(false);
  });

  it('returns false when authKey is missing', () => {
    mockedApnsConfig.authKey = '';
    expect(isApnsConfigured()).toBe(false);
  });

  it('returns false when bundleId is missing', () => {
    mockedApnsConfig.bundleId = '';
    expect(isApnsConfigured()).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// getPushTokensForUser — query helper
// ═══════════════════════════════════════════════════════════════════

describe('getPushTokensForUser', () => {
  it('returns empty array when user has no registered devices', () => {
    expect(getPushTokensForUser(42)).toEqual([]);
  });

  it('returns all push tokens for a user with multiple devices', () => {
    mockPushTokensForUser[7] = ['tok-iphone', 'tok-ipad'];
    expect(getPushTokensForUser(7)).toEqual([
      { token: 'tok-iphone', environment: 'sandbox', deviceId: 'device-tok-iphone' },
      { token: 'tok-ipad', environment: 'sandbox', deviceId: 'device-tok-ipad' },
    ]);
  });

  it('returns each token with its persisted APNs environment', () => {
    mockedApnsConfig.environment = 'production';
    mockPushTokensForUser[8] = [
      { token: 'tok-sandbox', environment: 'sandbox', deviceId: 'iphone-sandbox' },
      { token: 'tok-prod', environment: 'production', deviceId: 'iphone-prod' },
    ];

    expect(getPushTokensForUser(8)).toEqual([
      { token: 'tok-sandbox', environment: 'sandbox', deviceId: 'iphone-sandbox' },
      { token: 'tok-prod', environment: 'production', deviceId: 'iphone-prod' },
    ]);
  });

  it('fails closed on invalid tenant scope and records the anomaly', () => {
    expect(getPushTokensForUser(0)).toEqual([]);
    expect(getTenantScopeAnomalies()[0]).toMatchObject({
      layer: 'delivery',
      operation: 'get_push_tokens_for_user',
      reason: 'invalid_user_scope',
      userId: 0,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// sendPushNotification — happy path
// ═══════════════════════════════════════════════════════════════════

describe('sendPushNotification (happy path)', () => {
  it('dispatches to all devices and returns sent count', async () => {
    mockPushTokensForUser[1] = ['dev-token-a', 'dev-token-b'];
    mockHttp2Responses = [{ status: 200 }, { status: 200 }];

    const result = await sendPushNotification(1, {
      title: 'Hello',
      body: 'World',
    });

    expect(result.sent).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.retriable).toBe(0);
    expect(result.unregistered).toEqual([]);
    expect(mockHttp2Requests).toHaveLength(2);
  });

  it('sends the correct APNs headers', async () => {
    mockPushTokensForUser[1] = ['tok-xyz'];
    mockHttp2Responses = [{ status: 200 }];

    await sendPushNotification(1, { title: 'T', body: 'B' });

    const req = mockHttp2Requests[0];
    expect(req.headers[':method']).toBe('POST');
    expect(req.headers[':path']).toBe('/3/device/tok-xyz');
    expect(req.headers.authorization).toMatch(/^bearer fake\.jwt\.token/);
    expect(req.headers['apns-topic']).toBe('me.nexushub.test');
    expect(req.headers['apns-push-type']).toBe('alert');
    expect(req.headers['apns-priority']).toBe('10');
  });

  it('gives every push a store-and-forward window, not just time-sensitive ones', async () => {
    mockPushTokensForUser[1] = ['tok-expiry'];
    mockHttp2Responses = [{ status: 200 }, { status: 200 }];
    const nowSeconds = Math.floor(Date.now() / 1000);

    await sendPushNotification(1, { title: 'T', body: 'B', interruptionLevel: 'time-sensitive' });
    await sendPushNotification(1, { title: 'T', body: 'B', interruptionLevel: 'passive' });

    const timeSensitive = Number(mockHttp2Requests[0].headers['apns-expiration']);
    const passive = Number(mockHttp2Requests[1].headers['apns-expiration']);

    // '0' means now-or-drop: a phone offline for a minute loses the push
    // entirely. It used to apply to everything except time-sensitive — and the
    // orchestrator downgrades EVERY push to passive for users on a provisional
    // grant, so the whole new-user population lost store-and-forward.
    expect(passive).toBeGreaterThan(nowSeconds);
    expect(timeSensitive).toBeGreaterThan(nowSeconds);
    expect(passive).toBeGreaterThan(timeSensitive);
  });

  it('never lets the APNs store-and-forward window outlive the payload expiry', async () => {
    mockPushTokensForUser[1] = ['tok-bounded-expiry'];
    mockHttp2Responses = [{ status: 200 }];
    const expiresAtSeconds = Math.floor(Date.now() / 1000) + 120;

    await sendPushNotification(1, {
      title: 'T',
      body: 'B',
      interruptionLevel: 'passive',
      expirationAt: new Date(expiresAtSeconds * 1000).toISOString(),
    });

    expect(Number(mockHttp2Requests[0].headers['apns-expiration'])).toBe(expiresAtSeconds);
  });

  it('skips an already-expired payload without opening an APNs request', async () => {
    mockPushTokensForUser[1] = ['tok-already-expired'];

    const result = await sendPushNotification(1, {
      title: 'T',
      body: 'B',
      expirationAt: new Date(Date.now() - 60_000).toISOString(),
    });

    expect(result).toMatchObject({ sent: 0, failed: 0, skipped: 1, retriable: 0 });
    expect(mockHttp2Requests).toHaveLength(0);
  });

  it('sets APNs collapse id when the payload asks for one', async () => {
    mockPushTokensForUser[1] = ['tok-collapse'];
    mockHttp2Responses = [{ status: 200 }];

    await sendPushNotification(1, { title: 'T', body: 'B', collapseId: 'decision:nc_1' });

    expect(mockHttp2Requests[0].headers['apns-collapse-id']).toBe('decision:nc_1');
  });

  it('honors each persisted token environment instead of the global config', async () => {
    mockedApnsConfig.environment = 'production';
    mockPushTokensForUser[1] = [
      { token: 'sandbox-token', environment: 'sandbox' },
      { token: 'production-token', environment: 'production' },
    ];
    mockHttp2Responses = [{ status: 200 }, { status: 200 }];

    const result = await sendPushNotification(1, { title: 'T', body: 'B' });

    expect(result.sent).toBe(2);
    expect(mockHttp2Hosts).toContain('https://api.sandbox.push.apple.com:443');
    expect(mockHttp2Hosts).toContain('https://api.push.apple.com:443');
  });

  it('serializes the aps payload with title + body', async () => {
    mockPushTokensForUser[1] = ['tok-1'];
    mockHttp2Responses = [{ status: 200 }];

    await sendPushNotification(1, {
      title: 'New reminder',
      body: 'Take out the trash',
    });

    const body = JSON.parse(mockHttp2Requests[0].body);
    expect(body.aps.alert.title).toBe('New reminder');
    expect(body.aps.alert.body).toBe('Take out the trash');
  });

  it('includes subtitle when provided', async () => {
    mockPushTokensForUser[1] = ['tok-1'];
    mockHttp2Responses = [{ status: 200 }];

    await sendPushNotification(1, {
      title: 'T',
      subtitle: 'SUB',
      body: 'B',
    });

    const body = JSON.parse(mockHttp2Requests[0].body);
    expect(body.aps.alert.subtitle).toBe('SUB');
  });

  it('includes badge, sound, threadId, category, and interruption level when provided', async () => {
    mockPushTokensForUser[1] = ['tok-1'];
    mockHttp2Responses = [{ status: 200 }];

    await sendPushNotification(1, {
      title: 'T',
      body: 'B',
      badge: 3,
      sound: 'default',
      threadId: 'reminders',
      category: 'REMINDER',
      interruptionLevel: 'time-sensitive',
    });

    const body = JSON.parse(mockHttp2Requests[0].body);
    expect(body.aps.badge).toBe(3);
    expect(body.aps.sound).toBe('default');
    expect(body.aps['thread-id']).toBe('reminders');
    expect(body.aps.category).toBe('REMINDER');
    expect(body.aps['interruption-level']).toBe('time-sensitive');
  });

  it('merges custom data alongside aps', async () => {
    mockPushTokensForUser[1] = ['tok-1'];
    mockHttp2Responses = [{ status: 200 }];

    await sendPushNotification(1, {
      title: 'T',
      body: 'B',
      data: { reminderId: 42, domain: 'training' },
    });

    const body = JSON.parse(mockHttp2Requests[0].body);
    expect(body.reminderId).toBe(42);
    expect(body.domain).toBe('training');
    expect(body.aps).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// sendPushNotification — configuration gating
// ═══════════════════════════════════════════════════════════════════

describe('sendPushNotification (gating)', () => {
  it('fails closed on invalid tenant scope before APNs lookup and records the anomaly', async () => {
    const result = await sendPushNotification(0, {
      title: 'Ignored',
      body: 'Invalid scope should short-circuit',
      category: 'coach_briefing',
    });

    expect(result).toEqual({ sent: 0, failed: 0, skipped: 0, retriable: 0, unregistered: [] });
    expect(mockHttp2Connected).toBe(false);
    expect(getTenantScopeAnomalies()[0]).toMatchObject({
      layer: 'delivery',
      operation: 'send_push_notification',
      reason: 'invalid_user_scope',
      userId: 0,
      details: { category: 'coach_briefing' },
    });
  });

  it('no-ops when APNs is not enabled and logs a warn exactly once', async () => {
    mockedApnsConfig.enabled = false;
    mockPushTokensForUser[1] = ['tok-1', 'tok-2'];

    const first = await sendPushNotification(1, { title: 'T', body: 'B' });
    const second = await sendPushNotification(1, { title: 'T', body: 'B' });

    expect(first.sent).toBe(0);
    expect(first.skipped).toBe(2);
    expect(second.sent).toBe(0);
    expect(second.skipped).toBe(2);
    expect(mockHttp2Requests).toHaveLength(0);
    // Warn logged for the first call only — subsequent calls are silent
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
  });

  it('lists which env vars are missing in the warn log', async () => {
    mockedApnsConfig.teamId = '';
    mockedApnsConfig.keyId = '';
    mockPushTokensForUser[1] = ['tok-1'];

    await sendPushNotification(1, { title: 'T', body: 'B' });

    const warnCall = vi.mocked(logger.warn).mock.calls[0];
    const warnContext = warnCall[0] as { missing: string };
    expect(warnContext.missing).toContain('APNS_TEAM_ID');
    expect(warnContext.missing).toContain('APNS_KEY_ID');
  });

  it('returns zero counts when user has no devices', async () => {
    // No entries in mockPushTokensForUser
    const result = await sendPushNotification(999, { title: 'T', body: 'B' });
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it('records an operator alert when push token loading fails', async () => {
    mockPushTokenSelectError = new Error('database unavailable');

    const result = await sendPushNotification(1, { title: 'T', body: 'B' });

    expect(result).toEqual({ sent: 0, failed: 0, skipped: 0, retriable: 0, unregistered: [] });
    expect(mockRecordOperatorAlert).toHaveBeenCalledWith(expect.objectContaining({
      source: 'apns',
      dedupeKey: 'APNS_TOKEN_LOAD_FAILED:1',
      metadata: expect.objectContaining({ code: 'APNS_TOKEN_LOAD_FAILED', userId: 1 }),
    }));
  });
});

// ═══════════════════════════════════════════════════════════════════
// sendPushNotification — error handling
// ═══════════════════════════════════════════════════════════════════

describe('sendPushNotification (error handling)', () => {
  it('never includes invalid APNs auth-key contents in propagated errors', async () => {
    const secretValue = 'private-apns-key-material-that-must-not-reach-logs';
    mockedApnsConfig.authKey = secretValue;
    mockPushTokensForUser[1] = ['configured-token'];

    await expect(sendPushNotification(1, { title: 'T', body: 'B' })).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('is neither a valid file path nor a raw .p8 string');
      expect((error as Error).message).not.toContain(secretValue);
      expect((error as Error).message).not.toContain(secretValue.slice(0, 20));
      expect((error as Error).message).not.toContain(String(secretValue.length));
      return true;
    });
  });

  it('tallies 410 Gone responses as unregistered and clears the token', async () => {
    mockPushTokensForUser[1] = ['dead-token', 'live-token'];
    mockHttp2Responses = [
      { status: 410, body: '{"reason":"Unregistered"}' },
      { status: 200 },
    ];

    const result = await sendPushNotification(1, { title: 'T', body: 'B' });

    expect(result.sent).toBe(1);
    expect(result.unregistered).toEqual(['dead-token']);
    expect(mockPushTokenDeletions).toContain('dead-token');
  });

  it('tallies 429 as retriable (not failed)', async () => {
    mockPushTokensForUser[1] = ['rate-limited'];
    mockHttp2Responses = [
      { status: 429, body: '{"reason":"TooManyProviderTokenUpdates"}' },
    ];

    const result = await sendPushNotification(1, { title: 'T', body: 'B' });
    expect(result.retriable).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('tallies 500 as retriable', async () => {
    mockPushTokensForUser[1] = ['t'];
    mockHttp2Responses = [{ status: 500 }];

    const result = await sendPushNotification(1, { title: 'T', body: 'B' });
    expect(result.retriable).toBe(1);
  });

  it('tallies 400 as failed (permanent)', async () => {
    mockPushTokensForUser[1] = ['bad-payload-tok'];
    mockHttp2Responses = [{ status: 400, body: '{"reason":"BadPriority"}' }];

    const result = await sendPushNotification(1, { title: 'T', body: 'B' });
    expect(result.failed).toBe(1);
    expect(result.retriable).toBe(0);
  });

  it('tallies network errors as retriable (status 0)', async () => {
    mockPushTokensForUser[1] = ['t'];
    mockHttp2Responses = [{ status: 0, networkError: 'ECONNRESET' }];

    const result = await sendPushNotification(1, { title: 'T', body: 'B' });
    expect(result.retriable).toBe(1);
  });

  it('retries against the alternate APNs environment on token mismatch', async () => {
    mockPushTokensForUser[1] = ['environment-mismatch-token'];
    mockedApnsConfig.environment = 'sandbox';
    mockHttp2Responses = [
      { status: 400, body: '{"reason":"BadDeviceToken"}' },
      { status: 200 },
    ];

    const result = await sendPushNotification(1, { title: 'T', body: 'B' });

    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
    expect(mockHttp2Requests).toHaveLength(2);
    expect(mockHttp2Hosts).toContain('https://api.sandbox.push.apple.com:443');
    expect(mockHttp2Hosts).toContain('https://api.push.apple.com:443');
  });
});

// ═══════════════════════════════════════════════════════════════════
// JWT caching
// ═══════════════════════════════════════════════════════════════════

describe('provider JWT caching', () => {
  it('reuses the same JWT for multiple requests within the TTL window', async () => {
    mockPushTokensForUser[1] = ['a', 'b', 'c'];
    mockHttp2Responses = [{ status: 200 }, { status: 200 }, { status: 200 }];

    await sendPushNotification(1, { title: 'T', body: 'B' });

    // 3 requests issued, but JWT signed only once (cache hit on calls 2 and 3)
    expect(mockHttp2Requests).toHaveLength(3);
    expect(jwtSignCallCount).toBe(1);

    // All three requests carry the same JWT
    const authHeaders = mockHttp2Requests.map((r) => r.headers.authorization);
    expect(new Set(authHeaders).size).toBe(1);
  });
});
