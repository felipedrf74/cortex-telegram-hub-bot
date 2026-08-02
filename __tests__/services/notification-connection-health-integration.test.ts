/**
 * Real persistence -> canonical integration status -> notification proof.
 *
 * This intentionally does not mock `integration-status`: a fabricated
 * `{ state: 'revoked' }` bypasses the production path and cannot prove that a
 * real Google/Outlook rejection ever becomes user-visible.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

const envBeforeTest = vi.hoisted(() => {
  const previous = {
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    outlookClientId: process.env.OUTLOOK_CLIENT_ID,
    outlookClientSecret: process.env.OUTLOOK_CLIENT_SECRET,
    notificationMode: process.env.NOTIFICATION_DELIVERY_MODE,
  };
  process.env.GOOGLE_CLIENT_ID = 'test-google-client';
  process.env.GOOGLE_CLIENT_SECRET = 'test-google-secret';
  process.env.OUTLOOK_CLIENT_ID = 'test-outlook-client';
  process.env.OUTLOOK_CLIENT_SECRET = 'test-outlook-secret';
  process.env.NOTIFICATION_DELIVERY_MODE = 'apns';
  return previous;
});

let testDb: Database.Database;
const mockSendPushNotification = vi.fn();

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
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

vi.mock('../../src/services/apns-sender', () => ({
  getPushTokensForUser: vi.fn(() => [{ token: 'tok', environment: 'production' }]),
  isApnsConfigured: vi.fn(() => true),
  sendPushNotification: (...args: unknown[]) => mockSendPushNotification(...args),
  deleteDeadPushToken: vi.fn(),
  closeApnsClient: vi.fn(),
  _resetForTests: vi.fn(),
  sendPushToUsers: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import { storeTokens, _resetDecryptCacheForTests } from '../../src/services/oauth-store';
import { markOAuthConnectionAuthFailure } from '../../src/services/oauth-connection-health';
import { getProviderStatus } from '../../src/services/integration-status';
import { runConnectionHealthNotifier } from '../../src/services/connection-health-notifier';
import {
  ensureNotificationTables,
  listNotificationCenterItems,
} from '../../src/services/notification-orchestrator';

function connect(userId: number, provider: 'google' | 'outlook'): void {
  storeTokens(userId, provider, {
    accessToken: `access-${userId}-${provider}`,
    refreshToken: `refresh-${userId}-${provider}`,
    tokenType: 'Bearer',
    expiresAt: null,
    scopes: provider === 'google'
      ? ['https://www.googleapis.com/auth/calendar']
      : ['Calendars.ReadWrite'],
  });
}

describe('notification connection-health persistence integration', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-05-07T12:00:00.000Z'));
    process.env.OAUTH_ENCRYPTION_KEY = 'test-key-deterministic-for-vitest-32chars';
    testDb = createMigratedTestDatabase();
    _resetDecryptCacheForTests();
    mockSendPushNotification.mockReset();
    mockSendPushNotification.mockResolvedValue({
      sent: 1, failed: 0, skipped: 0, retriable: 0, unregistered: [],
    });
    ensureNotificationTables();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetDecryptCacheForTests();
    testDb?.close();
  });

  it('notifies only the user whose current Google grant is durably rejected', async () => {
    connect(101, 'google');
    connect(202, 'google');
    markOAuthConnectionAuthFailure(101, 'google', 'invalid_grant');

    expect(getProviderStatus(101, 'google')).toMatchObject({
      state: 'revoked',
      reasonCode: 'NEEDS_REAUTH',
    });
    expect(getProviderStatus(202, 'google').state).toBe('connected');

    const summary = await runConnectionHealthNotifier([101, 202]);

    expect(summary).toEqual({ usersChecked: 2, notified: 1, failed: 0 });
    const item = listNotificationCenterItems(101, 101)[0];
    expect(item.title).toContain('Google Calendar');
    expect(item.body).toContain('old data');
    expect(item.actions.map((action) => action.id)).toContain('reconnect');
    expect(listNotificationCenterItems(202, 202)).toHaveLength(0);
    expect(mockSendPushNotification).toHaveBeenCalledWith(
      101,
      expect.objectContaining({ category: 'DECISION_RECONNECT' }),
    );
  });

  it('dedupes repeated sweeps from the same persisted Outlook rejection', async () => {
    connect(303, 'outlook');
    markOAuthConnectionAuthFailure(303, 'outlook', 'token_expired');

    await runConnectionHealthNotifier([303]);
    const second = await runConnectionHealthNotifier([303]);

    expect(second.notified).toBe(0);
    expect(listNotificationCenterItems(303, 303)).toHaveLength(1);
  });
});

afterAll(() => {
  const restore = (key: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore('GOOGLE_CLIENT_ID', envBeforeTest.googleClientId);
  restore('GOOGLE_CLIENT_SECRET', envBeforeTest.googleClientSecret);
  restore('OUTLOOK_CLIENT_ID', envBeforeTest.outlookClientId);
  restore('OUTLOOK_CLIENT_SECRET', envBeforeTest.outlookClientSecret);
  restore('NOTIFICATION_DELIVERY_MODE', envBeforeTest.notificationMode);
  delete process.env.OAUTH_ENCRYPTION_KEY;
});
