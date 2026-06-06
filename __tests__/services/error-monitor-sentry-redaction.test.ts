import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;
const mockCaptureException = vi.fn();

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
}));

vi.mock('../../src/services/error-tracker', () => ({
  sanitizeSentryEvent: vi.fn((event) => event),
  init: vi.fn(),
  captureException: mockCaptureException,
  isEnabled: () => true,
  getStatus: vi.fn(() => ({ enabled: true, environment: 'test' })),
  captureMessage: vi.fn(),
  flush: vi.fn(async () => undefined),
}));

vi.mock('../../src/services/operator-alerts', () => ({
  recordOperatorAlert: vi.fn(),
  listOperatorAlerts: vi.fn(() => []),
  acknowledgeOperatorAlert: vi.fn(() => false),
  resolveOperatorAlert: vi.fn(() => false),
  retryOperatorAlertDelivery: vi.fn(() => false),
  deliverOperatorAlert: vi.fn(async () => ({ status: 'not_configured' })),
  processDueOperatorAlertDeliveries: vi.fn(async () => []),
  getOperatorAlertDeliverySummary: vi.fn(() => ({
    pending: 0,
    delivered: 0,
    failed: 0,
    dead_letter: 0,
    not_configured: 0,
  })),
  _setOperatorAlertDeliverySenderForTests: vi.fn(),
  _setOperatorAlertDeliveryConfigForTests: vi.fn(),
}));

vi.mock('../../src/portal/telemetry', () => ({
  pushEvent: vi.fn(),
  getRecentEvents: vi.fn(() => []),
  registerJob: vi.fn(),
  setJobEnabledChecker: vi.fn(),
  isJobEnabled: vi.fn(() => true),
  setJobFailureNotifier: vi.fn(),
  wrapJob: vi.fn((_name: string, fn: () => Promise<void>) => fn),
  getJobStatuses: vi.fn(() => []),
  getJobMap: vi.fn(() => new Map()),
  setBotRef: vi.fn(),
  getBotRef: vi.fn(() => null),
  isRestarting: vi.fn(() => false),
  setIsRestarting: vi.fn(),
  setBotPollingActive: vi.fn(),
  isBotPollingActive: vi.fn(() => false),
  recordMessageProcessed: vi.fn(),
  getLastMessageAt: vi.fn(() => null),
  recordGarminRefresh: vi.fn(),
  getGarminRefreshStatus: vi.fn(() => ({ at: null, ok: false })),
  setDbProvider: vi.fn(),
  _resetTelemetryForTests: vi.fn(),
  seedJobLastRunFromHistory: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

describe('error-monitor Sentry forwarding redaction', () => {
  beforeEach(async () => {
    vi.resetModules();
    mockCaptureException.mockReset();
    testDb = new Database(':memory:');
    testDb.exec(`
      CREATE TABLE error_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT DEFAULT (datetime('now')),
        level TEXT NOT NULL,
        source TEXT NOT NULL,
        message TEXT NOT NULL,
        stack TEXT,
        context TEXT,
        alerted INTEGER DEFAULT 0
      );
    `);
  });

  it('forwards sanitized context to Sentry without auth headers or body tokens', async () => {
    const { setDbProvider, captureError } = await import('../../src/services/error-monitor');
    setDbProvider(() => testDb);

    captureError({
      level: 'error',
      source: 'api',
      message: 'route failed',
      context: {
        request: {
          headers: {
            authorization: 'Bearer sentry-token-secret',
            cookie: 'sid=private-cookie',
          },
          data: {
            access_token: 'request-body-token',
            safe: 'ok',
          },
        },
      },
    }, false);

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const [, sentryContext] = mockCaptureException.mock.calls[0];
    const serialized = JSON.stringify(sentryContext);
    expect(serialized).not.toContain('sentry-token-secret');
    expect(serialized).not.toContain('private-cookie');
    expect(serialized).not.toContain('request-body-token');
    expect(sentryContext.extra.request.headers.authorization).toBe('[Redacted]');
    expect(sentryContext.extra.request.headers.cookie).toBe('[Redacted]');
    expect(sentryContext.extra.request.data.access_token).toBe('[Redacted]');
    expect(sentryContext.extra.request.data.safe).toBe('ok');
  });
});
