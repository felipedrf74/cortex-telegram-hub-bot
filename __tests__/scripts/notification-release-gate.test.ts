import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;

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
  __setNotificationApnsCategoryActionOverridesForTests,
} from '../../src/services/notification-contracts';
import {
  buildSkillDecisionFixtureIntent,
  createDecisionIntent,
  ensureDecisionCenterTables,
  getDecisionReleaseGateStatus,
  runDecisionExpiryJob,
} from '../../src/services/decision-center';
import { ensureNotificationTables } from '../../src/services/notification-orchestrator';

describe('notification release gate fixture', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    process.env.NOTIFICATION_DELIVERY_MODE = 'mock';
    ensureNotificationTables();
    ensureDecisionCenterTables();
  });

  afterEach(() => {
    delete process.env.NOTIFICATION_DELIVERY_MODE;
    delete process.env.DECISION_CENTER_DEBUG_EVIDENCE;
    __setNotificationApnsCategoryActionOverridesForTests(null);
    testDb?.close();
  });

  it('passes for a clean seeded tenant fixture', async () => {
    await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 91001, {
      tenantId: 91001,
      dedupeKey: 'release-gate:clean',
    }));

    expect(getDecisionReleaseGateStatus(91001, 91001)).toMatchObject({
      expiredButVisible: 0,
      unimplementedActionableCtas: 0,
      unsupportedNotificationActions: 0,
      deadDeeplinks: 0,
      genericMutatingActionSuccesses: 0,
      apnsMutatingActionsExposed: 0,
      staleSourceVisibleInInbox: 0,
      pass: true,
    });
  });

  it('detects APNs category fixtures exposing mutating actions', async () => {
    __setNotificationApnsCategoryActionOverridesForTests({
      FINANCE_PAYMENT: ['open_detail', 'mark_paid'],
    });

    const failing = getDecisionReleaseGateStatus(91003, 91003);
    expect(failing.apnsMutatingActionsExposed).toBe(1);
    expect(failing.pass).toBe(false);
  });

  it('detects stale source decisions that remain visible in the inbox', async () => {
    process.env.DECISION_CENTER_DEBUG_EVIDENCE = '1';
    const staleSyncUpdatedAt = new Date(Date.now() - 30 * 60_000).toISOString();
    await createDecisionIntent(buildSkillDecisionFixtureIntent('secretary', 91004, {
      tenantId: 91004,
      dedupeKey: 'release-gate:stale-visible',
      decisionContext: {
        entityTitle: 'Stale provider state',
        sourceState: 'conflict_detected',
        currentStartAt: '2026-05-10T10:00:00.000Z',
        currentEndAt: '2026-05-10T10:30:00.000Z',
        recommendedStartAt: '2026-05-10T11:00:00.000Z',
        recommendedEndAt: '2026-05-10T11:30:00.000Z',
        providerSyncState: 'not_synced',
        providerSyncUpdatedAt: staleSyncUpdatedAt,
      },
    }));

    const failing = getDecisionReleaseGateStatus(91004, 91004);
    expect(failing.staleSourceVisibleInInbox).toBe(1);
    expect(failing.pass).toBe(false);
  });

  it('detects seeded expired-visible rows and passes after expiry reconciliation', async () => {
    const seeded = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 91002, {
      tenantId: 91002,
      dedupeKey: 'release-gate:expired-visible',
    }));
    testDb.prepare('UPDATE notification_center_items SET expires_at = ? WHERE item_id = ?')
      .run('2020-01-01T00:00:00.000Z', seeded.item!.decisionId);

    const failing = getDecisionReleaseGateStatus(91002, 91002);
    expect(failing.expiredButVisible).toBe(1);
    expect(failing.pass).toBe(false);

    runDecisionExpiryJob();
    expect(getDecisionReleaseGateStatus(91002, 91002).pass).toBe(true);
  });
});
