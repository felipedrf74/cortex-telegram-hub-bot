/**
 * Error-recovery notifications and marketing consent.
 *
 * Two unrelated gaps that share a theme: the product knew something the user
 * needed to be told, and told nobody.
 *
 *   - Four decision lifecycle events (half-applied, rolled back, reconciled,
 *     unblocked) wrote to an audit table with no consumer, so a partially
 *     applied change was silent.
 *   - Lifecycle/retention pushes are promotional under App Store 4.5.4 and had
 *     no consent of their own; they would have inherited the operational
 *     push toggle.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;
const mockSendPushNotification = vi.fn();

vi.mock('../../src/services/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/database')>()),
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
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

import {
  createNotificationIntent,
  ensureNotificationTables,
  getOrCreateNotificationProfile,
  countUnreadNotificationCenterItems,
  listNotificationCenterItems,
  updateNotificationProfile,
} from '../../src/services/notification-orchestrator';
import { runDecisionRecoveryNotices } from '../../src/services/decision-recovery-notifier';

function createLifecycleTable(): void {
  testDb.exec(`
    CREATE TABLE IF NOT EXISTS decision_lifecycle_events (
      event_id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      event TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      action_id TEXT,
      reason TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function addLifecycleEvent(o: { id: string; userId: number; event: string; minutesAgo?: number }): void {
  testDb.prepare(`
    INSERT INTO decision_lifecycle_events (event_id, decision_id, user_id, tenant_id, event, created_at)
    -- Anchored to FIXED_NOW, not datetime('now'): SQLite reads the REAL clock
    -- even under fake timers, so 'N minutes ago' would land months in the
    -- FUTURE relative to the pinned app clock and the lookback window would
    -- admit an event this test needs it to reject.
    VALUES (?, ?, ?, ?, ?, datetime('2026-05-07 12:00:00', ?))
  `).run(o.id, `dec-${o.id}`, o.userId, o.userId, o.event, `-${o.minutesAgo ?? 1} minutes`);
}

function decisionFor(intentId: string): { decision: string; reason: string } {
  return testDb.prepare('SELECT decision, reason FROM notification_decision_logs WHERE intent_id = ?')
    .get(intentId) as { decision: string; reason: string };
}

/**
 * Pinned clock. These suites ran on the real wall clock, and the default
 * profile quiet hours are 22:00-07:00 — so every push became
 * `quiet_hours_delayed` whenever the suite happened to run at night, and they
 * passed only between 07:00 and 22:00 local. 12:00Z is 13:00 in the default
 * Europe/Lisbon zone: inside waking hours, clear of any DST edge.
 */
const FIXED_NOW = new Date('2026-05-07T12:00:00.000Z');

describe('decision recovery notices', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    testDb = new Database(':memory:');
    ensureNotificationTables();
    createLifecycleTable();
    mockSendPushNotification.mockReset();
    mockSendPushNotification.mockResolvedValue({ sent: 1, failed: 0, skipped: 0, retriable: 0, unregistered: [] });
    process.env.NOTIFICATION_DELIVERY_MODE = 'apns';
  });
  afterEach(() => {
    delete process.env.NOTIFICATION_DELIVERY_MODE;
    vi.useRealTimers();
    testDb?.close();
  });

  it('tells the user when only part of a change went through', async () => {
    getOrCreateNotificationProfile(80, 80);
    addLifecycleEvent({ id: 'e1', userId: 80, event: 'action_partially_failed' });

    const summary = await runDecisionRecoveryNotices();
    expect(summary.notified).toBe(1);

    expect(listNotificationCenterItems(80, 80)[0].title).toBe('Only part of that change went through');
    // The half-applied case needs a human, so it badges as an open decision.
    expect(countUnreadNotificationCenterItems(80, 80)).toBe(1);
  });

  it('reports a silent rollback — Nexus undoing an approved change', async () => {
    getOrCreateNotificationProfile(81, 81);
    addLifecycleEvent({ id: 'e2', userId: 81, event: 'rolled_back' });

    expect((await runDecisionRecoveryNotices()).notified).toBe(1);
    expect(listNotificationCenterItems(81, 81)[0].title).toBe('Nexus undid a change');
  });

  it('treats "ready again" as information, not a decision', async () => {
    getOrCreateNotificationProfile(82, 82);
    addLifecycleEvent({ id: 'e3', userId: 82, event: 'unblocked' });

    expect((await runDecisionRecoveryNotices()).notified).toBe(1);
    expect(listNotificationCenterItems(82, 82)[0].title).toBe('A decision is ready again');
    // Good news must not badge as an outstanding decision.
    expect(countUnreadNotificationCenterItems(82, 82)).toBe(0);
  });

  it('ignores lifecycle events that are not recovery states', async () => {
    getOrCreateNotificationProfile(83, 83);
    for (const event of ['created', 'surfaced', 'viewed', 'approved', 'expired']) {
      addLifecycleEvent({ id: `ok-${event}`, userId: 83, event });
    }
    expect((await runDecisionRecoveryNotices()).notified).toBe(0);
  });

  it('does not re-notify the same lifecycle event on a later sweep', async () => {
    getOrCreateNotificationProfile(84, 84);
    addLifecycleEvent({ id: 'e4', userId: 84, event: 'action_partially_failed' });

    expect((await runDecisionRecoveryNotices()).notified).toBe(1);
    expect((await runDecisionRecoveryNotices()).notified).toBe(0);
  });

  it('advances past the first 20 processed events instead of starving the rest of a burst', async () => {
    for (let index = 0; index < 25; index += 1) {
      const userId = 200 + index;
      getOrCreateNotificationProfile(userId, userId);
      addLifecycleEvent({ id: `burst-${index.toString().padStart(2, '0')}`, userId, event: 'rolled_back' });
    }

    const first = await runDecisionRecoveryNotices();
    const second = await runDecisionRecoveryNotices();

    expect(first.inspected).toBe(20);
    expect(second.inspected).toBe(5);
    expect(first.notified + second.notified).toBe(25);
    const stored = testDb.prepare(
      "SELECT COUNT(*) AS count FROM notification_intents WHERE dedupe_key LIKE 'system:decision_recovery:burst-%'",
    ).get() as { count: number };
    expect(stored.count).toBe(25);
  });

  it('notifies separately for two different failures on one decision', async () => {
    getOrCreateNotificationProfile(85, 85);
    addLifecycleEvent({ id: 'e5', userId: 85, event: 'action_partially_failed' });
    addLifecycleEvent({ id: 'e6', userId: 85, event: 'rolled_back' });

    expect((await runDecisionRecoveryNotices()).notified).toBe(2);
  });

  it('ignores events older than the lookback window', async () => {
    getOrCreateNotificationProfile(86, 86);
    addLifecycleEvent({ id: 'e7', userId: 86, event: 'rolled_back', minutesAgo: 180 });
    expect((await runDecisionRecoveryNotices()).notified).toBe(0);
  });

  it('skips users who have never opened notification settings', async () => {
    addLifecycleEvent({ id: 'e8', userId: 87, event: 'rolled_back' });
    expect((await runDecisionRecoveryNotices()).notified).toBe(0);
  });

  it('survives the lifecycle table not existing yet', async () => {
    testDb.exec('DROP TABLE decision_lifecycle_events');
    const summary = await runDecisionRecoveryNotices();
    expect(summary.failed).toBe(1);
    expect(summary.notified).toBe(0);
  });
});

describe('marketing consent (App Store 4.5.4)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    testDb = new Database(':memory:');
    ensureNotificationTables();
    mockSendPushNotification.mockReset();
    mockSendPushNotification.mockResolvedValue({ sent: 1, failed: 0, skipped: 0, retriable: 0, unregistered: [] });
    process.env.NOTIFICATION_DELIVERY_MODE = 'apns';
  });
  afterEach(() => {
    delete process.env.NOTIFICATION_DELIVERY_MODE;
    vi.useRealTimers();
    testDb?.close();
  });

  function promoIntent(userId: number, promotional: boolean) {
    return {
      userId,
      tenantId: userId,
      sourceSkill: 'system' as const,
      type: 'reminder' as const,
      priority: 'active' as const,
      relatedEntityId: `lifecycle-${userId}`,
      relatedEntityType: 'lifecycle_campaign',
      title: 'Connect a calendar to finish setup',
      body: 'Conflict detection needs it.',
      deeplink: 'nexus://notifications',
      dedupeKey: `lifecycle:activation:${userId}`,
      promotional,
    };
  }

  it('defaults marketing consent to off', () => {
    expect(getOrCreateNotificationProfile(90, 90).marketingPushEnabled).toBe(false);
  });

  it('withholds a promotional push when only operational consent is given', async () => {
    const profile = getOrCreateNotificationProfile(91, 91);
    expect(profile.pushEnabled).toBe(true); // operational consent IS present

    const result = await createNotificationIntent(promoIntent(91, true));

    expect(decisionFor(result.intent.intentId).decision).toBe('in_app_only');
    expect(decisionFor(result.intent.intentId).reason).toContain('marketing consent');
    expect(mockSendPushNotification).not.toHaveBeenCalled();
    // The message is not lost — only the interrupt.
    expect(listNotificationCenterItems(91, 91)).toHaveLength(1);
  });

  it('pushes a promotional notification once marketing consent is granted', async () => {
    getOrCreateNotificationProfile(92, 92);
    updateNotificationProfile(92, 92, { marketingPushEnabled: true });

    const result = await createNotificationIntent(promoIntent(92, true));
    expect(decisionFor(result.intent.intentId).decision).toBe('sent_push');
    expect(mockSendPushNotification).toHaveBeenCalled();
  });

  it('never gates an operational notification on marketing consent', async () => {
    getOrCreateNotificationProfile(93, 93);
    // Same shape, promotional NOT set — a schedule reminder must not be
    // silenced because the user declined marketing.
    const result = await createNotificationIntent(promoIntent(93, false));
    expect(decisionFor(result.intent.intentId).decision).toBe('sent_push');
  });

  it('stops a queued promotional push when consent is withdrawn before release', async () => {
    getOrCreateNotificationProfile(94, 94);
    updateNotificationProfile(94, 94, { marketingPushEnabled: true, quietHours: { start: '00:00', end: '23:59' } });

    const queued = await createNotificationIntent(promoIntent(94, true));
    expect(decisionFor(queued.intent.intentId).decision).toBe('quiet_hours_delayed');

    updateNotificationProfile(94, 94, { marketingPushEnabled: false });
    mockSendPushNotification.mockClear();

    const { releaseDueNotificationDeliveries } = await import('../../src/services/notification-orchestrator');
    // Force the queued row due.
    testDb.prepare("UPDATE notification_decision_logs SET scheduled_for = '2026-05-07T11:59:00.000Z'").run();
    await releaseDueNotificationDeliveries();

    expect(mockSendPushNotification).not.toHaveBeenCalled();
  });

  it('exposes marketing consent through the preference contract', async () => {
    const { applyNotificationProfilePatch } = await import('../../src/services/notification-orchestrator');
    getOrCreateNotificationProfile(95, 95);
    const result = applyNotificationProfilePatch(95, 95, { marketingPushEnabled: true });
    expect(result.applied).toContain('marketingPushEnabled');
    expect(result.rejected).toEqual([]);
    expect(result.profile.marketingPushEnabled).toBe(true);
  });
});

describe('priority model shadow scoring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    testDb = new Database(':memory:');
    ensureNotificationTables();
    mockSendPushNotification.mockReset();
    mockSendPushNotification.mockResolvedValue({ sent: 1, failed: 0, skipped: 0, retriable: 0, unregistered: [] });
    process.env.NOTIFICATION_DELIVERY_MODE = 'apns';
  });
  afterEach(() => {
    delete process.env.NOTIFICATION_DELIVERY_MODE;
    delete process.env.NOTIFICATION_PRIORITY_SHADOW_SCORING_ENABLED;
    vi.useRealTimers();
    testDb?.close();
  });

  function anIntent(userId: number) {
    return {
      userId,
      tenantId: userId,
      sourceSkill: 'secretary' as const,
      type: 'decision_required' as const,
      priority: 'active' as const,
      relatedEntityId: `e-${userId}`,
      relatedEntityType: 'task',
      title: 'Choose today’s focus',
      body: 'A short review is needed.',
      deeplink: 'nexus://notifications',
      dedupeKey: `shadow:${userId}`,
      requiresUserAction: true,
    };
  }

  function shadowRows(userId: number) {
    return testDb.prepare('SELECT * FROM notification_priority_shadow WHERE user_id = ?').all(userId) as any[];
  }

  it('records nothing while the flag is off', async () => {
    getOrCreateNotificationProfile(100, 100);
    await createNotificationIntent(anIntent(100));
    expect(shadowRows(100)).toHaveLength(0);
  });

  it('records a verdict beside the decision the ladder actually took', async () => {
    process.env.NOTIFICATION_PRIORITY_SHADOW_SCORING_ENABLED = 'true';
    getOrCreateNotificationProfile(101, 101);
    const result = await createNotificationIntent(anIntent(101));

    const rows = shadowRows(101);
    expect(rows).toHaveLength(1);
    expect(rows[0].intent_id).toBe(result.intent.intentId);
    // Whatever the ladder decided, the shadow row must agree — that pairing is
    // the entire point of shadow mode.
    expect(rows[0].actual_decision).toBe(decisionFor(result.intent.intentId).decision);
    expect(rows[0].declared_priority).toBe('active');
    expect(['ambient', 'low', 'normal', 'high', 'critical']).toContain(rows[0].tier);
    // Stamped incomplete: risk/reversibility/confidence are not plumbed yet, so
    // nobody should read these scores as a final ranking.
    expect(rows[0].features_complete).toBe(0);
  });

  it('does not change delivery — the shadow verdict is inert', async () => {
    process.env.NOTIFICATION_PRIORITY_SHADOW_SCORING_ENABLED = 'true';
    getOrCreateNotificationProfile(102, 102);
    const withShadow = await createNotificationIntent(anIntent(102));

    delete process.env.NOTIFICATION_PRIORITY_SHADOW_SCORING_ENABLED;
    getOrCreateNotificationProfile(103, 103);
    const withoutShadow = await createNotificationIntent(anIntent(103));

    expect(decisionFor(withShadow.intent.intentId).decision)
      .toBe(decisionFor(withoutShadow.intent.intentId).decision);
  });

  it('keeps delivery safe without recreating a missing shadow table on the request path', async () => {
    process.env.NOTIFICATION_PRIORITY_SHADOW_SCORING_ENABLED = 'true';
    getOrCreateNotificationProfile(104, 104);
    testDb.exec('DROP TABLE notification_priority_shadow');

    // Migrations own runtime schema. Shadow instrumentation must remain
    // non-fatal, but a request is not allowed to run DDL to repair it.
    const result = await createNotificationIntent(anIntent(104));
    expect(decisionFor(result.intent.intentId).decision).toBeTruthy();
    expect(
      testDb.prepare('SELECT COUNT(*) AS c FROM notification_center_items WHERE user_id = 104').get(),
    ).toEqual({ c: 1 });
    expect(testDb.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'notification_priority_shadow'
    `).get()).toBeUndefined();
  });
});
