import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { NormalizedTask } from '../../src/services/task-store/types';

let testDb: Database.Database;

const mocks = vi.hoisted(() => ({
  listTasksForUser: vi.fn(),
  getUserTimezoneById: vi.fn(),
  getUserLanguageById: vi.fn(),
}));

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/services/apns-sender', () => ({
  getPushTokensForUser: vi.fn(() => []),
  isApnsConfigured: vi.fn(() => false),
  sendPushNotification: vi.fn(),
  deleteDeadPushToken: vi.fn(),
  closeApnsClient: vi.fn(),
  _resetForTests: vi.fn(),
  sendPushToUsers: vi.fn(),
}));

vi.mock('../../src/services/task-store/task-service', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/task-store/task-service')>('../../src/services/task-store/task-service');
  return {
    ...actual,
    listTasksForUser: (...args: unknown[]) => mocks.listTasksForUser(...args),
  };
});

vi.mock('../../src/services/user-service', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/user-service')>('../../src/services/user-service');
  return {
    ...actual,
    getUserTimezoneById: (...args: unknown[]) => mocks.getUserTimezoneById(...args),
    getUserLanguageById: (...args: unknown[]) => mocks.getUserLanguageById(...args),
  };
});

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  dismissDecision,
  ensureDecisionCenterTables,
  snoozeDecision,
} from '../../src/services/decision-center';
import { ensureNotificationTables } from '../../src/services/notification-orchestrator';
import { materializeDecisionCenterDailyAttention } from '../../src/services/decision-center-daily-attention';
import { initializeDecisionCenterSchemaForTests } from '../../src/testing/decision-center-test-schema';

function task(overrides: Partial<NormalizedTask> = {}): NormalizedTask {
  return {
    id: 1,
    provider: 'nexus',
    externalId: 'task-1',
    title: 'Private task title',
    status: 'pending',
    priority: 3,
    dueDate: '2026-06-16',
    ...overrides,
  };
}

function dailyAttentionCenterRowCount(userId: number, dedupeKey: string): number {
  return (testDb.prepare(`
    SELECT COUNT(*) AS count
      FROM notification_center_items
     WHERE user_id = ?
       AND tenant_id = ?
       AND source_skill = 'secretary'
       AND dedupe_key = ?
  `).get(userId, userId, dedupeKey) as { count: number }).count;
}

describe('Decision Center daily attention integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-17T10:00:00.000Z'));
    testDb = new Database(':memory:');
    process.env.NOTIFICATION_DELIVERY_MODE = 'mock';
    mocks.listTasksForUser.mockReset();
    mocks.getUserTimezoneById.mockReset();
    mocks.getUserTimezoneById.mockReturnValue('Europe/Lisbon');
    mocks.getUserLanguageById.mockReset();
    mocks.getUserLanguageById.mockReturnValue('en');
    ensureNotificationTables();
    initializeDecisionCenterSchemaForTests();
    ensureDecisionCenterTables();
  });

  afterEach(() => {
    delete process.env.NOTIFICATION_DELIVERY_MODE;
    vi.useRealTimers();
    testDb.close();
  });

  it('does not create a second daily attention card after the first card is dismissed', async () => {
    mocks.listTasksForUser.mockReturnValue([
      task({ id: 10, dueDate: '2026-06-16', priority: 3 }),
    ]);

    const first = await materializeDecisionCenterDailyAttention({
      userId: 61,
      tenantId: 61,
      now: new Date('2026-06-17T10:00:00.000Z'),
    });
    expect(first.status).toBe('materialized');
    expect(first.decisionId).toEqual(expect.any(String));
    dismissDecision(first.decisionId!, 61, 61, 'duplicate');

    const second = await materializeDecisionCenterDailyAttention({
      userId: 61,
      tenantId: 61,
      now: new Date('2026-06-17T12:00:00.000Z'),
    });

    expect(second).toMatchObject({
      status: 'skipped',
      reason: 'already_materialized',
      dedupeKey: 'secretary:daily-attention:tasks:61:61:2026-06-17',
      decisionId: null,
    });
    expect(dailyAttentionCenterRowCount(61, 'secretary:daily-attention:tasks:61:61:2026-06-17')).toBe(1);
  });

  it('does not create a second daily attention card after the first card is snoozed', async () => {
    mocks.listTasksForUser.mockReturnValue([
      task({ id: 11, dueDate: '2026-06-16', priority: 3 }),
    ]);

    const first = await materializeDecisionCenterDailyAttention({
      userId: 62,
      tenantId: 62,
      now: new Date('2026-06-17T10:00:00.000Z'),
    });
    expect(first.status).toBe('materialized');
    expect(first.decisionId).toEqual(expect.any(String));
    snoozeDecision(first.decisionId!, 62, 62, 60);

    const second = await materializeDecisionCenterDailyAttention({
      userId: 62,
      tenantId: 62,
      now: new Date('2026-06-17T12:00:00.000Z'),
    });

    expect(second).toMatchObject({
      status: 'skipped',
      reason: 'already_materialized',
      dedupeKey: 'secretary:daily-attention:tasks:62:62:2026-06-17',
      decisionId: null,
    });
    expect(dailyAttentionCenterRowCount(62, 'secretary:daily-attention:tasks:62:62:2026-06-17')).toBe(1);
  });
});
