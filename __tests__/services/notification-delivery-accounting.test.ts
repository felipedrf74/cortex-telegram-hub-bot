/**
 * Delivery accounting and consent regressions for the notification ladder.
 *
 * Every case here reproduced a real defect before its fix and is kept as the
 * standing guard for it. They share one theme: the ladder was correct about
 * WHETHER to notify but wrong about WHO the decision applied to — a digest
 * group treated as one intent, a snoozed item treated as pre-authorised, an
 * unparseable timezone treated as "no limits".
 *
 * NOTE ON CLOCKS: these suites run on fake timers, but SQLite's `datetime('now')`
 * reads the REAL clock. Any row that has to be "due" must therefore be given an
 * explicit timestamp relative to the fake clock, never `datetime('now','-1 minute')`.
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

vi.mock('../../src/services/user-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/user-service')>()),
  getUserLanguageById: () => 'en-US',
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
  assembleDailyDigest,
  countUnreadNotificationCenterItems,
  createNotificationIntent,
  ensureNotificationTables,
  pruneNotificationRetention,
  evaluateInterruptBudget,
  getOrCreateNotificationProfile,
  listNotificationCenterItems,
  performNotificationAction,
  notificationTitleOrFallback,
  registerNotificationDeviceToken,
  releaseDueNotificationDeliveries,
  releaseDueSnoozedNotifications,
  updateNotificationProfile,
} from '../../src/services/notification-orchestrator';
import { setPushPreference } from '../../src/services/report-document-store';

const NOW = '2026-05-07T12:00:00.000Z';
const DUE = '2026-05-07T11:00:00.000Z';

/** A profile old enough not to be clamped by the new-user ramp. */
function establishedProfile(userId: number) {
  getOrCreateNotificationProfile(userId, userId);
  testDb.prepare("UPDATE notification_profiles SET created_at='2020-01-01 00:00:00' WHERE user_id=?")
    .run(userId);
}

function countInterrupts(userId: number): number {
  return (testDb.prepare(`
    SELECT COUNT(*) c FROM notification_decision_logs
     WHERE user_id = ? AND decision = 'sent_push' AND sent_at IS NOT NULL
  `).get(userId) as { c: number }).c;
}

/** `authorization_tier` is not surfaced on the mapped registration record. */
function storedTier(userId: number): string | undefined {
  return (testDb.prepare(
    'SELECT authorization_tier AS tier FROM notification_device_tokens WHERE user_id = ?',
  ).get(userId) as { tier: string } | undefined)?.tier;
}

/**
 * `requiresUserAction: false` keeps these out of `buildDecisionPushPlan`'s rank
 * gate. That gate blocks first and would mask whichever consent check each test
 * is actually about.
 */
function reminderIntent(userId: number, over: Record<string, unknown> = {}) {
  return {
    userId,
    tenantId: userId,
    sourceSkill: 'secretary' as const,
    type: 'reminder' as const,
    priority: 'active' as const,
    relatedEntityId: `entity-${userId}`,
    relatedEntityType: 'reminder',
    title: 'Reminder',
    body: 'Body',
    deeplink: 'nexus://notifications',
    actionButtons: [
      { id: 'open_detail', label: 'Open', style: 'primary' as const },
      { id: 'snooze', label: 'Snooze', style: 'secondary' as const },
    ],
    requiresUserAction: false,
    ...over,
  };
}

describe('notification delivery accounting', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    testDb = new Database(':memory:');
    ensureNotificationTables();
    mockSendPushNotification.mockReset();
    mockSendPushNotification.mockResolvedValue({
      sent: 1, failed: 0, skipped: 0, retriable: 0, unregistered: [],
    });
    process.env.NOTIFICATION_DELIVERY_MODE = 'apns';
  });

  afterEach(() => {
    delete process.env.NOTIFICATION_DELIVERY_MODE;
    vi.useRealTimers();
    testDb?.close();
  });

  describe('digest release', () => {
    it('charges the interrupt budget once per digest push, not once per item', async () => {
      establishedProfile(700);
      for (let i = 0; i < 9; i += 1) {
        await createNotificationIntent(reminderIntent(700, {
          priority: 'passive', dedupeKey: `digest:${i}`, relatedEntityId: `digest-${i}`,
        }));
      }
      testDb.prepare(`
        UPDATE notification_decision_logs SET scheduled_for = ?
         WHERE user_id = 700 AND decision = 'digest'
      `).run(DUE);
      mockSendPushNotification.mockClear();

      await releaseDueNotificationDeliveries();

      // One APNs call must bill exactly one interrupt. Nine would have
      // exhausted the eight-per-day global cap on the strength of a single
      // notification, silently suppressing everything later that day.
      expect(mockSendPushNotification).toHaveBeenCalledTimes(1);
      expect(countInterrupts(700)).toBe(1);
    });

    it('terminalizes every covered row when a later report row carries the digest', async () => {
      establishedProfile(732);
      const ordinary = await createNotificationIntent(reminderIntent(732, {
        priority: 'passive', dedupeKey: 'carrier-ordinary', relatedEntityId: 'carrier-ordinary',
      }));
      const report = await createNotificationIntent(reminderIntent(732, {
        type: 'daily_digest', priority: 'passive', body: 'Your day, in short',
        dedupeKey: 'carrier-report', relatedEntityId: 'carrier-report',
      }));
      // The ordinary row sorts first, while the later report row must carry the
      // wire payload because its composed body leads the digest.
      testDb.prepare('UPDATE notification_decision_logs SET scheduled_for = ? WHERE decision_log_id = ?')
        .run('2026-05-07T10:58:00.000Z', ordinary.decisionLog.decisionLogId);
      testDb.prepare('UPDATE notification_decision_logs SET scheduled_for = ? WHERE decision_log_id = ?')
        .run('2026-05-07T10:59:00.000Z', report.decisionLog.decisionLogId);
      mockSendPushNotification.mockClear();

      await releaseDueNotificationDeliveries();

      const decisions = testDb.prepare(`
        SELECT notification_id, decision FROM notification_decision_logs
         WHERE user_id = 732 ORDER BY rowid ASC
      `).all() as Array<{ notification_id: string; decision: string }>;
      expect(decisions).toEqual([
        { notification_id: ordinary.item!.itemId, decision: 'in_app_only' },
        { notification_id: report.item!.itemId, decision: 'sent_push' },
      ]);
      expect(mockSendPushNotification).toHaveBeenCalledTimes(1);

      // Leaving the first row as `digest` makes the next sweep send a second
      // push for content already covered by the report-carried digest.
      expect((await releaseDueNotificationDeliveries()).inspected).toBe(0);
      expect(mockSendPushNotification).toHaveBeenCalledTimes(1);
    });

    it('reports a failed digest provider attempt separately from policy blocks', async () => {
      establishedProfile(733);
      const digest = await createNotificationIntent(reminderIntent(733, {
        priority: 'passive', dedupeKey: 'digest-provider-failure',
        relatedEntityId: 'digest-provider-failure',
      }));
      testDb.prepare('UPDATE notification_decision_logs SET scheduled_for = ? WHERE decision_log_id = ?')
        .run(DUE, digest.decisionLog.decisionLogId);
      mockSendPushNotification.mockResolvedValueOnce({
        sent: 0, failed: 1, skipped: 0, retriable: 0, unregistered: [],
      });

      const summary = await releaseDueNotificationDeliveries();

      expect(summary).toMatchObject({ inspected: 1, released: 0, blocked: 1, failed: 1 });
    });

    it('re-checks the durable budget before APNs and terminates an over-budget digest without a retry loop', async () => {
      establishedProfile(701);
      for (let i = 0; i < 2; i += 1) {
        await createNotificationIntent(reminderIntent(701, {
          dedupeKey: `digest-budget-spend:${i}`,
          relatedEntityId: `digest-budget-spend-${i}`,
        }));
      }
      const digest = await createNotificationIntent(reminderIntent(701, {
        priority: 'passive',
        dedupeKey: 'digest-budget-due',
        relatedEntityId: 'digest-budget-due',
      }));
      testDb.prepare(`
        UPDATE notification_decision_logs SET scheduled_for = ?
         WHERE decision_log_id = ?
      `).run(DUE, digest.decisionLog.decisionLogId);
      mockSendPushNotification.mockClear();

      const firstSweep = await releaseDueNotificationDeliveries();

      expect(firstSweep.blocked).toBe(1);
      expect(mockSendPushNotification).not.toHaveBeenCalled();
      const log = testDb.prepare(`
        SELECT decision, reason FROM notification_decision_logs
         WHERE decision_log_id = ?
      `).get(digest.decisionLog.decisionLogId) as { decision: string; reason: string };
      expect(log.decision).toBe('in_app_only');
      expect(log.reason).toContain('interrupt budget');
      expect(listNotificationCenterItems(701, 701).some((item) => item.itemId === digest.item!.itemId)).toBe(true);

      // Terminal demotion: the already-due row does not wake every 15 minutes
      // and then burst as soon as another budget window opens.
      const secondSweep = await releaseDueNotificationDeliveries();
      expect(secondSweep.inspected).toBe(0);
      expect(mockSendPushNotification).not.toHaveBeenCalled();
    });

    it('withholds only the group members the user has restricted', async () => {
      establishedProfile(730);
      // Sorts first in the group, and is confined to the app.
      const restricted = await createNotificationIntent(reminderIntent(730, {
        sourceSkill: 'cooking', priority: 'passive', deliveryPolicy: 'in_app_only',
        dedupeKey: 'restricted', relatedEntityId: 'restricted',
      }));
      const ordinary = await createNotificationIntent(reminderIntent(730, {
        priority: 'passive', dedupeKey: 'ordinary', relatedEntityId: 'ordinary',
      }));
      testDb.prepare(`
        UPDATE notification_decision_logs SET scheduled_for = ?
         WHERE user_id = 730 AND decision = 'digest'
      `).run(DUE);
      mockSendPushNotification.mockClear();

      await releaseDueNotificationDeliveries();

      const decisionFor = (itemId: string) => (testDb.prepare(`
        SELECT decision FROM notification_decision_logs
         WHERE notification_id = ? ORDER BY rowid DESC LIMIT 1
      `).get(itemId) as { decision: string } | undefined)?.decision;

      // Eligibility is per intent. Deciding the whole group from group[0] both
      // withheld this ordinary reminder and, in the reverse order, pushed the
      // restricted one.
      expect(decisionFor(restricted.item!.itemId)).toBe('in_app_only');
      expect(decisionFor(ordinary.item!.itemId)).toBe('sent_push');
    });
  });

  describe('quiet-hours release budget', () => {
    it('serializes the final budget check with an in-flight immediate push and defers safely', async () => {
      establishedProfile(702);
      await createNotificationIntent(reminderIntent(702, {
        dedupeKey: 'quiet-budget-spend-1',
        relatedEntityId: 'quiet-budget-spend-1',
      }));
      updateNotificationProfile(702, 702, { quietHours: { start: '00:00', end: '23:59' } });
      const delayed = await createNotificationIntent(reminderIntent(702, {
        dedupeKey: 'quiet-budget-delayed',
        relatedEntityId: 'quiet-budget-delayed',
      }));
      expect(delayed.decisionLog.decision).toBe('quiet_hours_delayed');
      updateNotificationProfile(702, 702, { quietHours: { start: '02:00', end: '03:00' } });
      testDb.prepare(`
        UPDATE notification_decision_logs SET scheduled_for = ?
         WHERE decision_log_id = ?
      `).run(DUE, delayed.decisionLog.decisionLogId);

      let releaseImmediatePush!: () => void;
      let markImmediatePushStarted!: () => void;
      const immediatePushStarted = new Promise<void>((resolve) => { markImmediatePushStarted = resolve; });
      mockSendPushNotification.mockClear();
      mockSendPushNotification.mockImplementationOnce(() => {
        markImmediatePushStarted();
        return new Promise((resolve) => {
          releaseImmediatePush = () => resolve({
            sent: 1, failed: 0, skipped: 0, retriable: 0, unregistered: [],
          });
        });
      });

      const immediate = createNotificationIntent(reminderIntent(702, {
        dedupeKey: 'quiet-budget-spend-2',
        relatedEntityId: 'quiet-budget-spend-2',
      }));
      await immediatePushStarted;
      const sweep = releaseDueNotificationDeliveries();
      await Promise.resolve();

      // The release is waiting on the same user lock, not starting a second
      // APNs request from the stale one-interrupt count.
      expect(mockSendPushNotification).toHaveBeenCalledTimes(1);
      releaseImmediatePush();
      const [immediateResult, summary] = await Promise.all([immediate, sweep]);

      expect(immediateResult.decisionLog.decision).toBe('sent_push');
      expect(summary.blocked).toBe(1);
      expect(mockSendPushNotification).toHaveBeenCalledTimes(1);
      const log = testDb.prepare(`
        SELECT decision, reason, scheduled_for FROM notification_decision_logs
         WHERE decision_log_id = ?
      `).get(delayed.decisionLog.decisionLogId) as {
        decision: string; reason: string; scheduled_for: string;
      };
      expect(log.decision).toBe('digest');
      expect(log.reason).toContain('interrupt budget');
      expect(Date.parse(log.scheduled_for)).toBeGreaterThan(Date.parse(NOW));
      expect(listNotificationCenterItems(702, 702).some((item) => item.itemId === delayed.item!.itemId)).toBe(true);

      // scheduled_for advanced to the next digest slot, so there is no hot
      // retry on the already-due quiet-hours timestamp.
      expect((await releaseDueNotificationDeliveries()).inspected).toBe(0);
    });

    it('keeps a due T0 security release uncapped after the time-sensitive tier is full', async () => {
      establishedProfile(703);
      updateNotificationProfile(703, 703, { quietHours: { start: '00:00', end: '23:59' } });
      const security = await createNotificationIntent(reminderIntent(703, {
        sourceSkill: 'security',
        type: 'security_account',
        priority: 'time_sensitive',
        requiresUserAction: true,
        actionButtons: [{ id: 'open_detail', label: 'Review', style: 'primary' as const }],
        relatedEntityId: 'security-event-703',
        relatedEntityType: 'auth_device',
        dedupeKey: 'security-release-uncapped',
      }));
      expect(security.decisionLog.decision).toBe('quiet_hours_delayed');
      updateNotificationProfile(703, 703, { quietHours: { start: '02:00', end: '03:00' } });
      testDb.prepare(`
        UPDATE notification_decision_logs SET scheduled_for = ?
         WHERE decision_log_id = ?
      `).run(DUE, security.decisionLog.decisionLogId);

      const skills = ['secretary', 'training', 'content', 'cooking'] as const;
      for (const sourceSkill of skills) {
        const sent = await createNotificationIntent(reminderIntent(703, {
          sourceSkill,
          priority: 'time_sensitive',
          dedupeKey: `security-tier-fill:${sourceSkill}`,
          relatedEntityId: `security-tier-fill-${sourceSkill}`,
        }));
        expect(sent.decisionLog.decision).toBe('sent_push');
      }
      mockSendPushNotification.mockClear();

      const summary = await releaseDueNotificationDeliveries();

      expect(summary.released).toBe(1);
      expect(mockSendPushNotification).toHaveBeenCalledTimes(1);
      const log = testDb.prepare(`
        SELECT decision, reason FROM notification_decision_logs
         WHERE decision_log_id = ?
      `).get(security.decisionLog.decisionLogId) as { decision: string; reason: string };
      expect(log.decision).toBe('sent_push');
      expect(log.reason).toContain('released to APNs');
    });
  });

  describe('digest composition', () => {
    it('still names companion items when a report supplies the headline', async () => {
      establishedProfile(830);
      await createNotificationIntent(reminderIntent(830, {
        type: 'daily_digest', priority: 'passive', requiresUserAction: false,
        dedupeKey: 'brief', relatedEntityId: 'brief',
      }));
      await createNotificationIntent(reminderIntent(830, {
        type: 'schedule_changed', priority: 'passive', deliveryPolicy: 'digest_only',
        dedupeKey: 'trip', relatedEntityId: 'trip',
      }));

      const digest = assembleDailyDigest(830, 830, 2, new Date(NOW), '4 events, 6 tasks');

      // The report's own headline is better copy, but it describes only itself.
      // Returning it alone dropped every companion from the only push they can
      // ride — the trip sat unread in the inbox, never mentioned.
      expect(digest.body).toContain('4 events, 6 tasks');
      expect(digest.body).toContain('schedule update');
    });

    it('does not advertise the report to itself as a generic update', async () => {
      establishedProfile(831);
      await createNotificationIntent(reminderIntent(831, {
        type: 'daily_digest', priority: 'passive', requiresUserAction: false,
        dedupeKey: 'brief2', relatedEntityId: 'brief2',
      }));

      const digest = assembleDailyDigest(831, 831, 1, new Date(NOW), 'Your day, in short');

      expect(digest.body).toBe('Your day, in short');
    });
  });

  describe('snooze release', () => {
    it('honours pushEnabled=false when a snoozed item comes due', async () => {
      establishedProfile(710);
      const created = await createNotificationIntent(reminderIntent(710, { dedupeKey: 'push-off' }));
      performNotificationAction(created.item!.itemId, 'snooze', 710, 710, {
        snoozedUntil: '2026-05-07T13:00:00.000Z',
      });
      updateNotificationProfile(710, 710, {
        pushEnabled: false,
        quietHours: { start: '02:00', end: '03:00' },
      });
      testDb.prepare('UPDATE notification_center_items SET snoozed_until = ? WHERE user_id = 710').run(DUE);
      mockSendPushNotification.mockClear();

      await releaseDueSnoozedNotifications();

      // Snooze is a deferral, not a consent grant.
      expect(mockSendPushNotification).not.toHaveBeenCalled();
    });

    it('honours an in_app_only delivery policy when a snoozed item comes due', async () => {
      establishedProfile(711);
      const created = await createNotificationIntent(reminderIntent(711, {
        dedupeKey: 'in-app-only', deliveryPolicy: 'in_app_only',
      }));
      performNotificationAction(created.item!.itemId, 'snooze', 711, 711, {
        snoozedUntil: '2026-05-07T13:00:00.000Z',
      });
      updateNotificationProfile(711, 711, { quietHours: { start: '02:00', end: '03:00' } });
      testDb.prepare('UPDATE notification_center_items SET snoozed_until = ? WHERE user_id = 711').run(DUE);
      mockSendPushNotification.mockClear();

      await releaseDueSnoozedNotifications();

      expect(mockSendPushNotification).not.toHaveBeenCalled();
    });

    it('honours a withdrawn Reminders category preference when a snoozed item comes due', async () => {
      establishedProfile(712);
      const created = await createNotificationIntent(reminderIntent(712, { dedupeKey: 'reminders-category-off' }));
      performNotificationAction(created.item!.itemId, 'snooze', 712, 712, {
        snoozedUntil: '2026-05-07T13:00:00.000Z',
      });
      setPushPreference(712, 'reminders', false);
      testDb.prepare('UPDATE notification_center_items SET snoozed_until = ? WHERE user_id = 712').run(DUE);
      mockSendPushNotification.mockClear();

      const summary = await releaseDueSnoozedNotifications();

      expect(listNotificationCenterItems(712, 712)).toHaveLength(1);
      expect(mockSendPushNotification).not.toHaveBeenCalled();
      expect(summary).toMatchObject({ released: 0, blocked: 1 });
    });

    it('records a decision log so re-delivery is visible to the budget', async () => {
      establishedProfile(720);
      const created = await createNotificationIntent(reminderIntent(720, { dedupeKey: 'accounted' }));
      performNotificationAction(created.item!.itemId, 'snooze', 720, 720, {
        snoozedUntil: '2026-05-07T13:00:00.000Z',
      });
      updateNotificationProfile(720, 720, { quietHours: { start: '02:00', end: '03:00' } });
      testDb.prepare('UPDATE notification_center_items SET snoozed_until = ? WHERE user_id = 720').run(DUE);
      const before = countInterrupts(720);

      await releaseDueSnoozedNotifications();

      // Unlogged re-delivery made repeat snoozing an uncapped source of
      // interrupts that no budget could see.
      expect(countInterrupts(720)).toBe(before + 1);
    });

    it('preserves an explicit snooze request after the ambient skill cap and charges it before later traffic', async () => {
      establishedProfile(721);
      const requested = await createNotificationIntent(reminderIntent(721, {
        dedupeKey: 'snooze-explicit-1', relatedEntityId: 'snooze-explicit-1',
      }));
      await createNotificationIntent(reminderIntent(721, {
        dedupeKey: 'snooze-explicit-2', relatedEntityId: 'snooze-explicit-2',
      }));
      expect(countInterrupts(721)).toBe(2);
      performNotificationAction(requested.item!.itemId, 'snooze', 721, 721, {
        snoozedUntil: '2026-05-07T13:00:00.000Z',
      });
      testDb.prepare('UPDATE notification_center_items SET snoozed_until = ? WHERE item_id = ?')
        .run(DUE, requested.item!.itemId);
      mockSendPushNotification.mockClear();

      const summary = await releaseDueSnoozedNotifications();

      // Snooze is an explicit request for a future interrupt, not ambient
      // producer traffic. It remains exempt, but its sent_push row is durable
      // and therefore reduces what can be sent after it.
      expect(summary.released).toBe(1);
      expect(mockSendPushNotification).toHaveBeenCalledTimes(1);
      expect(countInterrupts(721)).toBe(3);
    });

    it('keeps a due item visible when its push is deferred by quiet hours', async () => {
      establishedProfile(740);
      const created = await createNotificationIntent(reminderIntent(740, { dedupeKey: 'quiet' }));
      updateNotificationProfile(740, 740, { quietHours: { start: '00:00', end: '23:59' } });
      performNotificationAction(created.item!.itemId, 'snooze', 740, 740, {
        snoozedUntil: '2026-05-07T12:30:00.000Z',
      });
      vi.setSystemTime(new Date('2026-05-07T12:35:00.000Z'));
      // Ignore the push from creation, which happened before quiet hours were set.
      mockSendPushNotification.mockClear();

      const summary = await releaseDueSnoozedNotifications();

      expect(summary.deferredQuietHours).toBe(1);
      // The user asked to see this again at 12:30. Re-parking it as `snoozed`
      // hid it from the inbox until quiet hours ended, which reads as lost
      // rather than deferred. Only the interrupt may wait.
      const visible = listNotificationCenterItems(740, 740)
        .some((item) => item.itemId === created.item!.itemId);
      expect(visible).toBe(true);
      expect(mockSendPushNotification).not.toHaveBeenCalled();
    });

    it('supersedes an existing queued delivery when the user snoozes the item', async () => {
      establishedProfile(741);
      updateNotificationProfile(741, 741, { quietHours: { start: '00:00', end: '23:59' } });
      const created = await createNotificationIntent(reminderIntent(741, {
        dedupeKey: 'snooze-supersedes-pending',
        relatedEntityId: 'snooze-supersedes-pending',
      }));
      expect(created.decisionLog.decision).toBe('quiet_hours_delayed');
      testDb.prepare('UPDATE notification_decision_logs SET scheduled_for = ? WHERE decision_log_id = ?')
        .run(DUE, created.decisionLog.decisionLogId);
      performNotificationAction(created.item!.itemId, 'snooze', 741, 741, {
        snoozedUntil: '2026-05-07T13:00:00.000Z',
      });
      testDb.prepare('UPDATE notification_center_items SET snoozed_until = ? WHERE item_id = ?')
        .run(DUE, created.item!.itemId);
      updateNotificationProfile(741, 741, { quietHours: { start: '02:00', end: '03:00' } });
      mockSendPushNotification.mockClear();

      const first = await releaseDueNotificationDeliveries();

      expect(first.released).toBe(1);
      expect(mockSendPushNotification).toHaveBeenCalledTimes(1);
      const original = testDb.prepare(`
        SELECT decision, reason, scheduled_for FROM notification_decision_logs
         WHERE decision_log_id = ?
      `).get(created.decisionLog.decisionLogId) as {
        decision: string; reason: string; scheduled_for: string | null;
      };
      expect(original).toMatchObject({
        decision: 'in_app_only',
        reason: 'pending push superseded by user snooze',
        scheduled_for: null,
      });

      // The pre-snooze queue entry must not wake on the next sweep and push the
      // same item a second time after its explicit snooze release.
      expect((await releaseDueNotificationDeliveries()).inspected).toBe(0);
      expect(mockSendPushNotification).toHaveBeenCalledTimes(1);
    });

    it('reports a failed snooze provider attempt separately from consent blocks', async () => {
      establishedProfile(744);
      const created = await createNotificationIntent(reminderIntent(744, {
        dedupeKey: 'snooze-provider-failure',
        relatedEntityId: 'snooze-provider-failure',
      }));
      performNotificationAction(created.item!.itemId, 'snooze', 744, 744, {
        snoozedUntil: '2026-05-07T13:00:00.000Z',
      });
      testDb.prepare('UPDATE notification_center_items SET snoozed_until = ? WHERE item_id = ?')
        .run(DUE, created.item!.itemId);
      mockSendPushNotification.mockResolvedValueOnce({
        sent: 0, failed: 1, skipped: 0, retriable: 0, unregistered: [],
      });

      const summary = await releaseDueSnoozedNotifications();

      expect(summary).toMatchObject({ inspected: 1, released: 0, blocked: 1, failed: 1 });
    });
  });

  describe('delivery policy', () => {
    it('bounds APNs storage by the earlier intent or decision expiry', async () => {
      establishedProfile(742);
      const expiresAt = '2026-05-07T13:00:00.000Z';
      const decisionDeadline = '2026-05-07T12:05:00.000Z';

      await createNotificationIntent(reminderIntent(742, {
        dedupeKey: 'bounded-wire-expiry',
        relatedEntityId: 'bounded-wire-expiry',
        expiresAt,
        decisionDeadline,
      }));

      expect(mockSendPushNotification).toHaveBeenCalledWith(
        742,
        expect.objectContaining({ expirationAt: decisionDeadline }),
      );
    });

    it('does not push an intent that is already expired', async () => {
      establishedProfile(743);
      mockSendPushNotification.mockClear();

      const result = await createNotificationIntent(reminderIntent(743, {
        dedupeKey: 'already-expired',
        relatedEntityId: 'already-expired',
        expiresAt: '2026-05-07T11:59:00.000Z',
      }));

      expect(result.item).not.toBeNull();
      expect(listNotificationCenterItems(743, 743)).not.toContainEqual(
        expect.objectContaining({ itemId: result.item!.itemId }),
      );
      expect(result.decisionLog).toMatchObject({
        decision: 'in_app_only',
        reason: 'notification push deadline expired before APNs dispatch',
      });
      expect(mockSendPushNotification).not.toHaveBeenCalled();
    });

    it('keeps an in_app_only intent out of the digest push channel', async () => {
      establishedProfile(760);
      const created = await createNotificationIntent(reminderIntent(760, {
        priority: 'passive', deliveryPolicy: 'in_app_only', dedupeKey: 'policy',
      }));

      // `digestPassiveItems` defaults true, and the digest branch used to be
      // tested BEFORE the delivery policy — so a contract that says "never
      // push" was routed straight into the digest push channel, with only the
      // digest group's own eligibility check standing between it and APNs.
      expect(created.decisionLog.decision).toBe('in_app_only');
    });
  });

  describe('device token registration', () => {
    it('does not promote a provisional grant when the caller reports no tier', () => {
      registerNotificationDeviceToken({
        userId: 770, tenantId: 770, token: 'provisional-token',
        environment: 'production', authorizationTier: 'provisional',
      });

      // POST /api/v1/settings/push-token sends no tier. Normalizing an absent
      // tier to 'authorized' silently promoted the grant, re-opening the quiet
      // delivery that migration 271 exists to detect.
      registerNotificationDeviceToken({
        userId: 770, tenantId: 770, token: 'provisional-token',
        environment: 'production',
      });

      expect(storedTier(770)).toBe('provisional');
    });

    it('still records a tier the caller does report', () => {
      registerNotificationDeviceToken({
        userId: 771, tenantId: 771, token: 'upgraded-token',
        environment: 'production', authorizationTier: 'provisional',
      });
      registerNotificationDeviceToken({
        userId: 771, tenantId: 771, token: 'upgraded-token',
        environment: 'production', authorizationTier: 'authorized',
      });

      expect(storedTier(771)).toBe('authorized');
    });
  });

  describe('producer titles', () => {
    it('falls back rather than rejecting an emoji-only user title', async () => {
      establishedProfile(780);

      // createNotificationIntent validates AFTER stripping, so an emoji-only
      // title threw — the producer counted a failure and the user got no
      // notification for that commitment at all.
      expect(notificationTitleOrFallback('🏋️', 'Training session')).toBe('Training session');
      expect(notificationTitleOrFallback('  ', 'Training session')).toBe('Training session');
      expect(notificationTitleOrFallback(null, 'Training session')).toBe('Training session');
      // A real title is passed through untouched.
      expect(notificationTitleOrFallback('🏋️ Treino', 'Training session')).toBe('🏋️ Treino');

      const created = await createNotificationIntent(reminderIntent(780, {
        title: notificationTitleOrFallback('🏋️', 'Training session'), dedupeKey: 'emoji-title',
      }));
      expect(created.item!.title).toBe('Training session');
    });
  });

  describe('fail-closed suppression at release', () => {
    /** Make the suppression read THROW, which is not the same as a user opting out. */
    function breakSuppressionTable() {
      process.env.DECISION_TYPE_SUPPRESSION_ENABLED = 'true';
      testDb.exec('DROP TABLE IF EXISTS decision_type_suppressions');
      testDb.exec('DROP TABLE IF EXISTS decision_recipe_suppressions');
    }

    it('defers rather than permanently dropping a push it could not evaluate', async () => {
      establishedProfile(800);
      const created = await createNotificationIntent(reminderIntent(800, {
        priority: 'passive', dedupeKey: 'failclosed',
      }));
      testDb.prepare(`
        UPDATE notification_decision_logs SET scheduled_for = ?
         WHERE user_id = 800 AND decision = 'digest'
      `).run(DUE);

      breakSuppressionTable();
      mockSendPushNotification.mockClear();
      const blocked = await releaseDueNotificationDeliveries();
      expect(blocked.blocked).toBe(1);
      expect(blocked.failed).toBe(1);
      expect(mockSendPushNotification).not.toHaveBeenCalled();

      // The row must still be claimable. Rewriting it to a terminal
      // `in_app_only` — the old behaviour — meant one transient SQLITE_BUSY
      // destroyed the push for good, and blamed a preference change that
      // never happened.
      const log = testDb.prepare(
        'SELECT decision, sent_at FROM notification_decision_logs WHERE notification_id = ?',
      ).get(created.item!.itemId) as { decision: string; sent_at: string | null };
      expect(log.decision).toBe('digest');
      expect(log.sent_at).toBeNull();

      // Table readable again -> the next sweep recovers it.
      delete process.env.DECISION_TYPE_SUPPRESSION_ENABLED;
      const recovered = await releaseDueNotificationDeliveries();
      expect(recovered.released).toBe(1);
      expect(recovered.failed).toBe(0);
      expect(mockSendPushNotification).toHaveBeenCalledTimes(1);
    });

    it('still records a genuine preference block as final, and names it', async () => {
      establishedProfile(801);
      const created = await createNotificationIntent(reminderIntent(801, {
        priority: 'passive', dedupeKey: 'genuine',
      }));
      testDb.prepare(`
        UPDATE notification_decision_logs SET scheduled_for = ?
         WHERE user_id = 801 AND decision = 'digest'
      `).run(DUE);
      updateNotificationProfile(801, 801, { pushEnabled: false });

      await releaseDueNotificationDeliveries();

      const log = testDb.prepare(
        'SELECT decision, reason FROM notification_decision_logs WHERE notification_id = ?',
      ).get(created.item!.itemId) as { decision: string; reason: string };
      expect(log.decision).toBe('in_app_only');
      expect(log.reason).toContain('push disabled by user preference');
    });
  });

  describe('promotional content', () => {
    it('never advertises a consent-blocked promotional item in the digest push', async () => {
      establishedProfile(810);
      await createNotificationIntent(reminderIntent(810, {
        priority: 'passive', promotional: true, dedupeKey: 'promo', relatedEntityId: 'promo',
      }));
      await createNotificationIntent(reminderIntent(810, {
        priority: 'passive', dedupeKey: 'operational', relatedEntityId: 'operational',
      }));

      // The ladder correctly refuses to PUSH the promotional item, and then the
      // digest body counted it anyway — announcing "2 reminders" for one
      // pushable item, leaking the existence of marketing the user never
      // consented to receive.
      const digest = assembleDailyDigest(810, 810, 2);
      expect(digest.body).toContain('1 ');
      expect(digest.body).not.toContain('2 ');
    });

    it('counts a promotional item in the digest once marketing consent is granted', async () => {
      establishedProfile(811);
      updateNotificationProfile(811, 811, { marketingPushEnabled: true });
      await createNotificationIntent(reminderIntent(811, {
        priority: 'passive', promotional: true, dedupeKey: 'promo2', relatedEntityId: 'promo2',
      }));
      await createNotificationIntent(reminderIntent(811, {
        priority: 'passive', dedupeKey: 'op2', relatedEntityId: 'op2',
      }));

      expect(assembleDailyDigest(811, 811, 2).body).toContain('2 ');
    });

    it('never badges a promotional item', async () => {
      establishedProfile(812);
      updateNotificationProfile(812, 812, { marketingPushEnabled: true });

      // Control: an identical NON-promotional item must badge, so this test
      // fails for the right reason rather than because nothing badges at all.
      await createNotificationIntent(reminderIntent(812, {
        requiresUserAction: true, dedupeKey: 'control3', relatedEntityId: 'control3',
      }));
      expect(countUnreadNotificationCenterItems(812, 812)).toBe(1);

      await createNotificationIntent(reminderIntent(812, {
        requiresUserAction: true, promotional: true, dedupeKey: 'promo3', relatedEntityId: 'promo3',
      }));

      // A badge is an outstanding ask. A re-engagement nudge is not something
      // the user can resolve, so a badge pointing at one cannot be cleared.
      expect(countUnreadNotificationCenterItems(812, 812)).toBe(1);
    });
  });

  describe('digest consent projection', () => {
    it('does not advertise a reminder after its category consent is withdrawn', async () => {
      establishedProfile(814);
      await createNotificationIntent(reminderIntent(814, {
        priority: 'passive', dedupeKey: 'category-muted-reminder',
        relatedEntityId: 'category-muted-reminder',
      }));
      await createNotificationIntent(reminderIntent(814, {
        sourceSkill: 'system', type: 'insight', priority: 'passive',
        dedupeKey: 'category-muted-companion', relatedEntityId: 'category-muted-companion',
      }));
      setPushPreference(814, 'reminders', false);

      const digest = assembleDailyDigest(814, 814, 2);

      expect(digest.body).toContain('update');
      expect(digest.body).not.toContain('reminder');
    });

    it('does not advertise an item after its skill consent is withdrawn', async () => {
      establishedProfile(815);
      await createNotificationIntent(reminderIntent(815, {
        sourceSkill: 'training', type: 'missed_item', priority: 'passive',
        dedupeKey: 'skill-muted-training', relatedEntityId: 'skill-muted-training',
      }));
      await createNotificationIntent(reminderIntent(815, {
        sourceSkill: 'system', type: 'insight', priority: 'passive',
        dedupeKey: 'skill-muted-companion', relatedEntityId: 'skill-muted-companion',
      }));
      updateNotificationProfile(815, 815, { skillPreferences: { training: false } });

      const digest = assembleDailyDigest(815, 815, 2);

      expect(digest.body).toContain('update');
      expect(digest.body).not.toContain('missed');
    });
  });

  describe('engagement retention', () => {
    it('keeps engagement history for an item the prune deliberately preserves', async () => {
      establishedProfile(820);
      const created = await createNotificationIntent(reminderIntent(820, { dedupeKey: 'retained' }));
      const itemId = created.item!.itemId;

      // Item is unresolved, so the item prune keeps it forever; its `surfaced`
      // event is older than the 180-day engagement window.
      testDb.prepare("UPDATE notification_center_items SET status = 'read' WHERE item_id = ?").run(itemId);
      testDb.prepare("UPDATE notification_engagement_events SET created_at = '2020-01-01 00:00:00' WHERE notification_id = ?")
        .run(itemId);

      pruneNotificationRetention();

      // Pruning it while the item survives split one timeline in half: a later
      // `opened` would have no `surfaced` to divide by, so any open-rate
      // computed from this table would be inflated — potentially above 1.
      const remaining = (testDb.prepare(
        'SELECT COUNT(*) c FROM notification_engagement_events WHERE notification_id = ?',
      ).get(itemId) as { c: number }).c;
      expect(remaining).toBeGreaterThan(0);
      expect(testDb.prepare('SELECT 1 FROM notification_center_items WHERE item_id = ?').get(itemId)).toBeTruthy();
    });
  });

  describe('interrupt budget', () => {
    it('binds the per-skill cap under concurrent evaluation', async () => {
      establishedProfile(790);
      // Each push resolves on a later microtask, which is exactly the window
      // the real code yields in: check budget -> await APNs -> write the row.
      mockSendPushNotification.mockImplementation(async () => {
        await Promise.resolve();
        return { sent: 1, failed: 0, skipped: 0, retriable: 0, unregistered: [] };
      });

      // Two producers on the same */5 cron evaluating the same user. wrapJob's
      // in-flight guard is keyed by job NAME, so it does not serialize them.
      await Promise.all(Array.from({ length: 6 }, (_, i) => createNotificationIntent(
        reminderIntent(790, { dedupeKey: `concurrent:${i}`, relatedEntityId: `concurrent-${i}` }),
      )));

      // Two per skill per day. Run sequentially this always held; run
      // concurrently every evaluation read the same pre-push count and all six
      // passed a cap that should have admitted two.
      expect(countInterrupts(790)).toBeLessThanOrEqual(2);
    });

    it('still enforces a daily window when the profile timezone is unparseable', () => {
      establishedProfile(750);
      // Client-reported zones are not validated on write; `GMT-3` is a real
      // value Luxon rejects.
      testDb.prepare("UPDATE notification_profiles SET timezone='GMT-3' WHERE user_id=750").run();
      const profile = getOrCreateNotificationProfile(750, 750);

      const verdict = evaluateInterruptBudget(
        {
          userId: 750, tenantId: 750, sourceSkill: 'secretary',
          type: 'reminder', promotional: false,
        } as never,
        'active',
        profile,
      );

      // An invalid zone produced a null day boundary, and the guard for that
      // allowed the interrupt — disabling the cap entirely for that user.
      expect(verdict.reason).not.toContain('unresolved');
    });
  });
});
