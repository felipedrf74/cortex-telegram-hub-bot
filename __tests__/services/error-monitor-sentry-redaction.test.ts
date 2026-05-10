import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;
const mockCaptureException = vi.fn();

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

vi.mock('../../src/services/error-tracker', () => ({
  captureException: mockCaptureException,
  isEnabled: () => true,
}));

vi.mock('../../src/services/operator-alerts', () => ({
  recordOperatorAlert: vi.fn(),
}));

vi.mock('../../src/portal/telemetry', () => ({
  pushEvent: vi.fn(),
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
