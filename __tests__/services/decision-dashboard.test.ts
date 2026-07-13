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
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

import { buildDecisionDashboardSnapshot } from '../../src/services/decision-dashboard';
import {
  buildSkillDecisionFixtureIntent,
  createDecisionIntent,
  dismissDecision,
  ensureDecisionCenterTables,
  runDecisionMetricsRollupJob,
} from '../../src/services/decision-center';
import { ensureNotificationTables } from '../../src/services/notification-orchestrator';

describe('buildDecisionDashboardSnapshot (T14)', () => {
  beforeEach(() => {
    // Real timers so the rollup's luxon date and the SQLite clock agree (mirrors the rollup test).
    vi.useRealTimers();
    testDb = new Database(':memory:');
    process.env.NOTIFICATION_DELIVERY_MODE = 'mock';
    ensureNotificationTables();
    ensureDecisionCenterTables();
  });
  afterEach(() => {
    delete process.env.NOTIFICATION_DELIVERY_MODE;
    testDb?.close();
  });

  it('composes release gate + today rollup + feedback + outcomes into one scoped snapshot', async () => {
    const a = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 70, { tenantId: 70, dedupeKey: 'dash-1' }));
    await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 70, { tenantId: 70, dedupeKey: 'dash-2' }));
    dismissDecision(a.item!.decisionId, 70, 70, 'not_relevant');

    const lifecycleRowsBeforeSnapshot = (testDb.prepare('SELECT COUNT(*) AS n FROM decision_lifecycle_events')
      .get() as { n: number }).n;
    const before = buildDecisionDashboardSnapshot(70, 70);
    const lifecycleRowsAfterSnapshot = (testDb.prepare('SELECT COUNT(*) AS n FROM decision_lifecycle_events')
      .get() as { n: number }).n;
    expect(lifecycleRowsAfterSnapshot).toBe(lifecycleRowsBeforeSnapshot);
    expect(before.userId).toBe(70);
    expect(before.tenantId).toBe(70);
    expect(before.releaseGate.pass).toBe(true);
    expect(before.today).toBeNull(); // the daily rollup has not run yet
    expect(before.feedbackBySkill.find((s) => s.sourceSkill === 'training')?.dismissed).toBe(1);
    expect(before.outcomes.totalOutcomes).toBeGreaterThanOrEqual(1); // the dismissal is in the outcome ledger

    runDecisionMetricsRollupJob();
    const after = buildDecisionDashboardSnapshot(70, 70);
    expect(after.today).not.toBeNull(); // rollup populated today's '*' row
    expect(after.today?.createdCount).toBe(2);
    expect(after.today?.dismissedCount).toBe(1);

    // active breakdowns: 1 still-active training decision (the other was dismissed -> not active).
    expect(after.activeBreakdowns.total).toBe(1);
    expect(after.activeBreakdowns.byDomain.training).toBe(1);
    expect(Object.values(after.activeBreakdowns.byStatus).reduce((a, b) => a + b, 0)).toBe(1);
  });

  it('is tenant-scoped — a snapshot reflects only its own tenant\'s feedback', async () => {
    const mine = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 71, { tenantId: 71, dedupeKey: 'dash-mine' }));
    dismissDecision(mine.item!.decisionId, 71, 71, 'not_relevant');
    const other = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 72, { tenantId: 72, dedupeKey: 'dash-other' }));
    dismissDecision(other.item!.decisionId, 72, 72, 'too_risky');

    const snap = buildDecisionDashboardSnapshot(71, 71);
    expect(snap.feedbackBySkill.reduce((n, s) => n + s.dismissed, 0)).toBe(1); // only user 71's dismissal
  });
});
