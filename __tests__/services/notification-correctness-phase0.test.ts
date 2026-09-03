/**
 * Phase 0 notification correctness.
 *
 * Each block here pins a case where the system previously told the user
 * something untrue: snooze that never returned, a per-type mute that did not
 * stop the push, and queued deliveries that ignored preference changes made
 * after they were queued. These are regression tests for user-visible false
 * statements, not for new features.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;
let pushTokens: Array<{ token: string; environment: string }> = [];
let apnsConfigured = false;
const mockSendPushNotification = vi.fn();

vi.mock('../../src/services/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/database')>()),
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
}));

// These suites assert redaction and routing, not translation. Lock-screen copy
// is now resolved from the account language (users.language, default pt-BR), so
// pin English here and let notification-localization.test.ts own the language
// behaviour. Only the language resolver is overridden — every other
// user-service export stays real.
vi.mock('../../src/services/user-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/user-service')>()),
  getUserLanguageById: () => 'en-US',
}));

vi.mock('../../src/services/apns-sender', () => ({
  getPushTokensForUser: vi.fn(() => pushTokens),
  isApnsConfigured: vi.fn(() => apnsConfigured),
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
  SNOOZE_MAX_COUNT,
  assembleDailyDigest,
  buildSkillNotificationFixtureIntent,
  countUnreadNotificationCenterItems,
  createNotificationIntent,
  ensureNotificationTables,
  getNotificationCenterItem,
  isNotificationPushableForProfile,
  listNotificationCenterItems,
  performNotificationAction,
  releaseDueNotificationDeliveries,
  releaseDueSnoozedNotifications,
  pruneNotificationRetention,
  resolveSnoozeUntil,
  stripTitleEmoji,
  updateNotificationProfile,
  getOrCreateNotificationProfile,
} from '../../src/services/notification-orchestrator';

/**
 * decision_type_suppressions is owned by decision-center. The orchestrator
 * reads it directly (importing decision-center would close a cycle), so the
 * table is created here rather than pulled in via that module.
 */
function ensureSuppressionFixtureTable(): void {
  testDb.exec(`
    CREATE TABLE IF NOT EXISTS decision_type_suppressions (
      user_id INTEGER NOT NULL, tenant_id INTEGER NOT NULL,
      source_skill TEXT NOT NULL, type TEXT NOT NULL,
      mode TEXT NOT NULL, until TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, tenant_id, source_skill, type)
    );
    CREATE TABLE IF NOT EXISTS decision_recipe_suppressions (
      user_id INTEGER NOT NULL, tenant_id INTEGER NOT NULL,
      source_skill TEXT NOT NULL, type TEXT NOT NULL, recipe TEXT NOT NULL,
      mode TEXT NOT NULL, until TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, tenant_id, source_skill, type, recipe)
    );
  `);
}

function muteType(userId: number, sourceSkill: string, type: string): void {
  testDb.prepare(`
    INSERT OR REPLACE INTO decision_type_suppressions (user_id, tenant_id, source_skill, type, mode, until)
    VALUES (?, ?, ?, ?, 'dont_show_type', NULL)
  `).run(userId, userId, sourceSkill, type);
}

function muteRecipe(userId: number, sourceSkill: string, type: string, recipe: string): void {
  testDb.prepare(`
    INSERT OR REPLACE INTO decision_recipe_suppressions
      (user_id, tenant_id, source_skill, type, recipe, mode, until)
    VALUES (?, ?, ?, ?, ?, 'dont_show_type', NULL)
  `).run(userId, userId, sourceSkill, type, recipe);
}

function decisionFor(intentId: string): { decision: string; reason: string } {
  return testDb.prepare('SELECT decision, reason FROM notification_decision_logs WHERE intent_id = ?')
    .get(intentId) as { decision: string; reason: string };
}

/**
 * A user-authored reminder: the archetype that actually offers snooze/dismiss
 * on the lock screen. The shared skill fixtures only carry `open_detail`, and
 * `enforceNotificationActionContract` drops anything the contract does not
 * support, so snooze coverage has to start from a type that supports it.
 */
function buildReminderIntent(userId: number, overrides: Record<string, unknown> = {}) {
  return {
    userId,
    tenantId: userId,
    sourceSkill: 'secretary' as const,
    type: 'reminder' as const,
    priority: 'active' as const,
    relatedEntityId: `reminder-${userId}`,
    relatedEntityType: 'reminder',
    title: 'Call the clinic',
    body: 'Reminder is due.',
    actionButtons: [
      { id: 'open_detail', label: 'Open', style: 'primary' as const },
      { id: 'snooze', label: 'Snooze', style: 'secondary' as const },
      { id: 'dismiss', label: 'Done', style: 'secondary' as const },
    ],
    deeplink: 'nexus://notifications',
    dedupeKey: `secretary:reminder:${userId}`,
    requiresUserAction: true,
    ...overrides,
  };
}

describe('Phase 0 — notification correctness', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-07T12:00:00.000Z'));
    testDb = new Database(':memory:');
    pushTokens = [{ token: 'tok-default', environment: 'production' }];
    apnsConfigured = true;
    mockSendPushNotification.mockReset();
    mockSendPushNotification.mockResolvedValue({ sent: 1, failed: 0, skipped: 0, retriable: 0, unregistered: [] });
    process.env.NOTIFICATION_DELIVERY_MODE = 'apns';
    ensureNotificationTables();
    ensureSuppressionFixtureTable();
  });

  afterEach(() => {
    delete process.env.NOTIFICATION_DELIVERY_MODE;
    delete process.env.DECISION_TYPE_SUPPRESSION_ENABLED;
    vi.useRealTimers();
    testDb?.close();
  });

  // ───────────────────────── P0.1 · snooze ─────────────────────────

  describe('snooze', () => {
    it('clamps a snooze target into [5 minutes, 7 days]', () => {
      const now = new Date('2026-05-07T12:00:00.000Z');
      // Too soon → floored to +5m.
      expect(resolveSnoozeUntil('2026-05-07T12:00:30.000Z', now)).toBe('2026-05-07T12:05:00.000Z');
      // Too far → capped at +7d.
      expect(resolveSnoozeUntil('2027-01-01T00:00:00.000Z', now)).toBe('2026-05-14T12:00:00.000Z');
      // In range → honoured exactly.
      expect(resolveSnoozeUntil('2026-05-07T16:00:00.000Z', now)).toBe('2026-05-07T16:00:00.000Z');
      // Unparseable → default hour, never a throw (the lock screen cannot show an error).
      expect(resolveSnoozeUntil('not-a-date', now)).toBe('2026-05-07T13:00:00.000Z');
      expect(resolveSnoozeUntil(null, now)).toBe('2026-05-07T13:00:00.000Z');
    });

    it('hides a snoozed item from the inbox until it is due, then shows it again', async () => {
      const created = await createNotificationIntent(buildReminderIntent(11));
      const itemId = created.item!.itemId;

      performNotificationAction(itemId, 'snooze', 11, 11, { snoozedUntil: '2026-05-07T16:00:00.000Z' });
      expect(listNotificationCenterItems(11, 11).map((i) => i.itemId)).not.toContain(itemId);

      // Past the snooze target the row is visible again even before the sweep
      // runs: a stalled sweep must degrade to "shows early", never "vanishes".
      vi.setSystemTime(new Date('2026-05-07T16:30:00.000Z'));
      expect(listNotificationCenterItems(11, 11).map((i) => i.itemId)).toContain(itemId);
    });

    it('hides a snoozed item from status:all but honours an explicit includeSnoozed view', async () => {
      const created = await createNotificationIntent(buildReminderIntent(17));
      performNotificationAction(created.item!.itemId, 'snooze', 17, 17, { snoozedUntil: '2026-05-07T16:00:00.000Z' });

      // The default inbox hides it. An explicit includeSnoozed view — what
      // chat uses to confirm a snooze landed — must still return it.
      // Deliberately NOT tied to status:'all': the primary inbox route passes
      // 'all' to mean "every status", so overloading it left snoozed items
      // visible on the one surface that matters.
      expect(listNotificationCenterItems(17, 17, { status: 'all' })
        .find((i) => i.itemId === created.item!.itemId)).toBeUndefined();
      const all = listNotificationCenterItems(17, 17, { includeSnoozed: true, status: 'all' });
      expect(all.find((i) => i.itemId === created.item!.itemId)?.status).toBe('snoozed');
    });

    it('returns a due snoozed item to unread and re-delivers it', async () => {
      const created = await createNotificationIntent(buildReminderIntent(12, { requiresUserAction: false }));
      const itemId = created.item!.itemId;
      performNotificationAction(itemId, 'snooze', 12, 12, { snoozedUntil: '2026-05-07T16:00:00.000Z' });
      expect(getNotificationCenterItem(itemId, 12, 12)!.status).toBe('snoozed');

      mockSendPushNotification.mockClear();
      vi.setSystemTime(new Date('2026-05-07T16:01:00.000Z'));
      const summary = await releaseDueSnoozedNotifications(new Date('2026-05-07T16:01:00.000Z'));

      expect(summary.released).toBe(1);
      expect(getNotificationCenterItem(itemId, 12, 12)!.status).toBe('unread');
      expect(mockSendPushNotification).toHaveBeenCalledTimes(1);
    });

    it('defers a snooze that comes due inside quiet hours, and reports it as deferred', async () => {
      // Found by running the real backend: a snooze lapsing at 23:24 local was
      // correctly re-parked until quiet hours ended, but the sweep summary
      // reported inspected:1 / released:0 / blocked:0 — indistinguishable from
      // an item the sweep silently dropped.
      const created = await createNotificationIntent(buildReminderIntent(18, { requiresUserAction: false }));
      performNotificationAction(created.item!.itemId, 'snooze', 18, 18, { snoozedUntil: '2026-05-07T22:30:00.000Z' });

      mockSendPushNotification.mockClear();
      const inQuietHours = new Date('2026-05-07T23:30:00.000Z');
      vi.setSystemTime(inQuietHours);
      const summary = await releaseDueSnoozedNotifications(inQuietHours);

      expect(summary.deferredQuietHours).toBe(1);
      expect(summary.released).toBe(0);
      expect(summary.blocked).toBe(0);
      expect(mockSendPushNotification).not.toHaveBeenCalled();
      // Visible, not re-parked. This assertion originally required 'snoozed',
      // which is how the item disappeared: the inbox hides snoozed rows, so a
      // reminder the user had asked to see again at 22:30 stayed invisible
      // until quiet hours ended the next morning. Only the interrupt defers —
      // the deferral is carried by a `quiet_hours_delayed` decision log that
      // the regular release sweep picks up.
      expect(getNotificationCenterItem(created.item!.itemId, 18, 18)!.status).toBe('unread');
      const deferred = testDb.prepare(`
        SELECT decision, scheduled_for FROM notification_decision_logs
         WHERE notification_id = ? AND decision = 'quiet_hours_delayed'
      `).get(created.item!.itemId) as { decision: string; scheduled_for: string } | undefined;
      expect(deferred?.decision).toBe('quiet_hours_delayed');
      expect(deferred?.scheduled_for).toBeTruthy();
    });

    it('does not re-deliver a snoozed item before it is due', async () => {
      const created = await createNotificationIntent(buildReminderIntent(13));
      performNotificationAction(created.item!.itemId, 'snooze', 13, 13, { snoozedUntil: '2026-05-07T18:00:00.000Z' });

      mockSendPushNotification.mockClear();
      const summary = await releaseDueSnoozedNotifications(new Date('2026-05-07T13:00:00.000Z'));

      expect(summary.inspected).toBe(0);
      expect(mockSendPushNotification).not.toHaveBeenCalled();
      expect(getNotificationCenterItem(created.item!.itemId, 13, 13)!.status).toBe('snoozed');
    });

    it('stops re-interrupting after SNOOZE_MAX_COUNT snoozes and routes to the digest instead', async () => {
      const created = await createNotificationIntent(buildReminderIntent(14));
      const itemId = created.item!.itemId;

      let clock = new Date('2026-05-07T12:00:00.000Z');
      for (let n = 0; n < SNOOZE_MAX_COUNT; n += 1) {
        vi.setSystemTime(clock);
        performNotificationAction(itemId, 'snooze', 14, 14, { snoozedUntil: new Date(clock.getTime() + 3_600_000).toISOString() });
        clock = new Date(clock.getTime() + 7_200_000);
        vi.setSystemTime(clock);
        if (n < SNOOZE_MAX_COUNT - 1) await releaseDueSnoozedNotifications(clock);
      }

      mockSendPushNotification.mockClear();
      const summary = await releaseDueSnoozedNotifications(clock);

      expect(summary.demotedToDigest).toBe(1);
      expect(summary.released).toBe(0);
      expect(mockSendPushNotification).not.toHaveBeenCalled();
      // Still returned to the inbox — bounded snoozing must not delete the item.
      expect(getNotificationCenterItem(itemId, 14, 14)!.status).toBe('unread');
    });

    it('does not let snooze route around the decision quality gate', async () => {
      // requiresUserAction routes a secretary item through the decision push
      // plan, which refuses a push when the recommendation is missing. Snooze
      // must not become a way to acquire the push the gate already denied.
      const created = await createNotificationIntent(buildReminderIntent(16, { requiresUserAction: true }));
      expect(decisionFor(created.intent.intentId).decision).toBe('in_app_only');

      performNotificationAction(created.item!.itemId, 'snooze', 16, 16, { snoozedUntil: '2026-05-07T16:00:00.000Z' });
      mockSendPushNotification.mockClear();
      vi.setSystemTime(new Date('2026-05-07T16:01:00.000Z'));
      const summary = await releaseDueSnoozedNotifications(new Date('2026-05-07T16:01:00.000Z'));

      expect(mockSendPushNotification).not.toHaveBeenCalled();
      expect(summary.released).toBe(0);
      // Still returned to the inbox — the gate withholds the interrupt, not the item.
      expect(getNotificationCenterItem(created.item!.itemId, 16, 16)!.status).toBe('unread');
    });

    it('withholds re-delivery when the user disabled the skill while it was snoozed', async () => {
      const created = await createNotificationIntent(buildReminderIntent(15, { requiresUserAction: false }));
      performNotificationAction(created.item!.itemId, 'snooze', 15, 15, { snoozedUntil: '2026-05-07T16:00:00.000Z' });

      updateNotificationProfile(15, 15, { skillPreferences: { secretary: false } } as never);
      mockSendPushNotification.mockClear();
      vi.setSystemTime(new Date('2026-05-07T16:01:00.000Z'));
      const summary = await releaseDueSnoozedNotifications(new Date('2026-05-07T16:01:00.000Z'));

      expect(summary.released).toBe(0);
      expect(summary.blocked).toBe(1);
      expect(mockSendPushNotification).not.toHaveBeenCalled();
    });
  });

  // ──────────────────── P0.2 · per-type suppression ────────────────────

  describe('per-type suppression', () => {
    beforeEach(() => {
      process.env.DECISION_TYPE_SUPPRESSION_ENABLED = 'true';
    });

    it('stops the push when the user muted that (skill, type)', async () => {
      const control = await createNotificationIntent(buildSkillNotificationFixtureIntent('finance', 21));
      expect(decisionFor(control.intent.intentId).decision).toBe('sent_push');

      muteType(22, 'finance', control.intent.type);
      mockSendPushNotification.mockClear();
      const muted = await createNotificationIntent(buildSkillNotificationFixtureIntent('finance', 22));

      const log = decisionFor(muted.intent.intentId);
      expect(log.decision).toBe('suppressed');
      expect(log.reason).toContain('muted');
      expect(mockSendPushNotification).not.toHaveBeenCalled();
      // The durable item survives so unmuting brings it back.
      expect(muted.item).not.toBeNull();
    });

    it('never lets a mute silence a security_account alert', async () => {
      const intent = buildSkillNotificationFixtureIntent('security', 23);
      muteType(23, 'security', 'security_account');
      mockSendPushNotification.mockClear();

      const result = await createNotificationIntent({ ...intent, type: 'security_account', priority: 'time_sensitive' });

      expect(decisionFor(result.intent.intentId).decision).not.toBe('suppressed');
    });

    it('keeps the badge in step with the list for a muted type', async () => {
      const created = await createNotificationIntent({
        ...buildSkillNotificationFixtureIntent('finance', 24),
        requiresUserAction: true,
      });
      expect(created.item).not.toBeNull();
      const badgeableRows = () => listNotificationCenterItems(24, 24, { status: 'unread' })
        .filter((item) => item.requiresUserAction).length;

      const before = countUnreadNotificationCenterItems(24, 24);
      // The name of this test promised badge/list agreement, but it only ever
      // asserted that the badge MOVED — it never called the list at all, which
      // is how divergence in both directions shipped green.
      expect(before).toBe(badgeableRows());

      muteType(24, 'finance', created.intent.type);

      // A badge pointing at rows the list hides is a badge that lies; a list
      // showing rows the badge has zeroed is the same lie reversed.
      const after = countUnreadNotificationCenterItems(24, 24);
      expect(after).toBeLessThan(Math.max(before, 1));
      expect(after).toBe(badgeableRows());
    });

    it('does nothing when the suppression flag is off', async () => {
      delete process.env.DECISION_TYPE_SUPPRESSION_ENABLED;
      const intent = buildSkillNotificationFixtureIntent('finance', 25);
      muteType(25, 'finance', intent.type);

      const result = await createNotificationIntent(intent);
      expect(decisionFor(result.intent.intentId).decision).toBe('sent_push');
    });

    it('withholds the push when the suppression table cannot be read (fail-closed)', async () => {
      testDb.exec('DROP TABLE decision_type_suppressions');
      mockSendPushNotification.mockClear();

      const result = await createNotificationIntent(buildSkillNotificationFixtureIntent('finance', 26));

      // An unwanted interrupt costs trust that cannot be won back; the item
      // still exists, so only the interrupt is lost.
      expect(decisionFor(result.intent.intentId).decision).toBe('suppressed');
      expect(mockSendPushNotification).not.toHaveBeenCalled();
      // ...but the log must not claim the USER muted this. No suppression
      // record exists here — the table is gone. Recording a preference the user
      // never expressed corrupts the audit trail that explains deliveries.
      expect(decisionFor(result.intent.intentId).reason).not.toContain('user muted');
      expect(decisionFor(result.intent.intentId).reason).toContain('unreadable');
      expect(result.item).not.toBeNull();
    });
  });

  // ──────────────────── P0.3 · reconnect replaces retry ────────────────────

  describe('broken-connection action', () => {
    it('rewrites a legacy retry request into an executable reconnect', async () => {
      // Five producers still pass `retry`. Rewriting at the contract boundary
      // fixes all of them without editing each one.
      const created = await createNotificationIntent({
        userId: 51,
        tenantId: 51,
        sourceSkill: 'training',
        type: 'sync_failure',
        priority: 'active',
        relatedEntityId: 'garmin-51',
        relatedEntityType: 'garmin_session',
        title: 'Garmin disconnected',
        body: 'Reconnect to restore training data.',
        actionButtons: [{ id: 'retry', label: 'Retry', style: 'primary', mutating: true }],
        deeplink: 'nexus://connections',
        dedupeKey: 'training:sync:51',
      } as never);

      const ids = created.item!.actions.map((a) => a.id);
      expect(ids).toContain('reconnect');
      expect(ids).not.toContain('retry');
      // Navigation, so it must not be flagged as a domain mutation.
      expect(created.item!.actions.find((a) => a.id === 'reconnect')?.mutating).toBeUndefined();
      expect(mockSendPushNotification).toHaveBeenCalledWith(
        51,
        expect.objectContaining({ category: 'DECISION_RECONNECT' }),
      );
    });

    it('does not infer reconnect from the broad sync_failure type', async () => {
      const created = await createNotificationIntent({
        userId: 52,
        tenantId: 52,
        sourceSkill: 'finance',
        type: 'sync_failure',
        priority: 'active',
        relatedEntityId: 'invoice-flush-52',
        relatedEntityType: 'finance_queue_flush',
        title: 'Invoices failed to file',
        body: 'Open Finance to review the queue.',
        deeplink: 'nexus://finance/invoices',
        dedupeKey: 'finance:sync:52',
      } as never);

      expect(created.item!.actions.map((action) => action.id)).toEqual(['open_detail']);
      expect(mockSendPushNotification).toHaveBeenCalledWith(
        52,
        expect.objectContaining({ category: 'DECISION_SYNC_ISSUE' }),
      );
    });

    it('allows reconnect from the lock screen without allowing a mutation', async () => {
      const {
        isSafeGenericNotificationAction,
        isNotificationActionMutating,
        listNotificationApnsActionExposures,
        resolveNotificationContract,
      } =
        await import('../../src/services/notification-contracts');
      expect(isSafeGenericNotificationAction('reconnect')).toBe(true);
      expect(isNotificationActionMutating('reconnect')).toBe(false);
      // The action it replaces stays mutating and stays off the lock screen.
      expect(isSafeGenericNotificationAction('retry')).toBe(false);
      expect(resolveNotificationContract({
        sourceSkill: 'system', type: 'sync_failure', actionId: 'reconnect', deeplink: 'nexus://connections',
      }).apnsCategory).toBe('DECISION_RECONNECT');
      expect(resolveNotificationContract({
        sourceSkill: 'system', type: 'sync_failure', actionId: 'reconnect', deeplink: 'nexus://finance/invoices',
      }).apnsCategory).toBe('DECISION_SYNC_ISSUE');
      expect(resolveNotificationContract({
        sourceSkill: 'system', type: 'sync_failure', actionId: 'open_detail', deeplink: 'nexus://connections',
      }).apnsCategory).toBe('DECISION_SYNC_ISSUE');
      expect(listNotificationApnsActionExposures()).toContainEqual({
        apnsCategory: 'DECISION_RECONNECT',
        actionId: 'reconnect',
      });
    });
  });

  // ─────────────── P0.5/P0.6 · release-time re-evaluation ───────────────

  describe('queued release', () => {
    it('drops a queued push when the user turned push off before release', async () => {
      // Quiet hours (22:00–07:00 default) park this one instead of sending.
      vi.setSystemTime(new Date('2026-05-07T23:00:00.000Z'));
      const created = await createNotificationIntent(buildReminderIntent(31, { requiresUserAction: false }));
      expect(decisionFor(created.intent.intentId).decision).toBe('quiet_hours_delayed');

      updateNotificationProfile(31, 31, { pushEnabled: false } as never);
      mockSendPushNotification.mockClear();

      vi.setSystemTime(new Date('2026-05-08T08:00:00.000Z'));
      await releaseDueNotificationDeliveries(new Date('2026-05-08T08:00:00.000Z'));

      expect(mockSendPushNotification).not.toHaveBeenCalled();
      // The reason now names the ACTUAL cause. It used to be a single generic
      // "user preferences changed before release" for every block, including
      // "the suppression table could not be read" — which was not a preference
      // and not a change.
      expect(decisionFor(created.intent.intentId).decision).toBe('in_app_only');
      expect(decisionFor(created.intent.intentId).reason)
        .toBe('delayed notification withheld: push disabled by user preference');
    });

    it('carries the interruption level onto the release payload', async () => {
      vi.setSystemTime(new Date('2026-05-07T23:00:00.000Z'));
      await createNotificationIntent(buildReminderIntent(32, { requiresUserAction: false }));
      mockSendPushNotification.mockClear();

      vi.setSystemTime(new Date('2026-05-08T08:00:00.000Z'));
      await releaseDueNotificationDeliveries(new Date('2026-05-08T08:00:00.000Z'));

      expect(mockSendPushNotification).toHaveBeenCalled();
      const payload = mockSendPushNotification.mock.calls[0]?.[1] as Record<string, unknown>;
      // Without this the sender falls back to apns-expiration '0' (now-or-drop)
      // and an offline device loses the notification permanently.
      expect(payload.interruptionLevel).toBeDefined();
    });

    it('isNotificationPushableForProfile refuses a muted skill', async () => {
      const created = await createNotificationIntent(buildSkillNotificationFixtureIntent('training', 33));
      updateNotificationProfile(33, 33, { skillPreferences: { training: false } } as never);
      const profile = getOrCreateNotificationProfile(33, 33);

      expect(isNotificationPushableForProfile(created.intent, profile)).toBe(false);
    });
  });

  // ──────────────────── P1.1 · insight never pushes ────────────────────

  describe('insight delivery', () => {
    it('holds an insight for the digest even at active priority', async () => {
      // Background jobs announcing their own success were reaching the lock
      // screen because the policy resolver returned 'auto' for a contract that
      // explicitly excludes push.
      const created = await createNotificationIntent({
        userId: 71,
        tenantId: 71,
        sourceSkill: 'finance',
        type: 'insight',
        priority: 'active',
        relatedEntityId: 'run-71',
        relatedEntityType: 'finance_collection_run',
        title: 'Invoice collection finished',
        body: '42 invoices, 2 sources, 0 failures.',
        deeplink: 'nexus://notifications',
        dedupeKey: 'finance:collection:71',
      } as never);

      expect(created.intent.deliveryPolicy).toBe('digest_only');
      expect(decisionFor(created.intent.intentId).decision).toBe('digest');
      expect(mockSendPushNotification).not.toHaveBeenCalled();
    });

    it('still lets a reminder push, whose contract also omits push', async () => {
      // Guards against over-correcting: defaultDelivery lists guaranteed
      // channels, not the full permitted set, for every type but `insight`.
      const created = await createNotificationIntent(buildReminderIntent(72, { requiresUserAction: false }));
      expect(decisionFor(created.intent.intentId).decision).toBe('sent_push');
    });
  });

  // ──────────────────── P1.2 · digest composition ────────────────────

  describe('digest composition', () => {
    it('does not advertise a broadly muted item in an unrelated digest', async () => {
      process.env.DECISION_TYPE_SUPPRESSION_ENABLED = 'true';
      muteType(80, 'system', 'sync_failure');
      await createNotificationIntent({
        ...buildReminderIntent(80, { requiresUserAction: false, priority: 'passive' }),
        sourceSkill: 'system',
        type: 'sync_failure',
        relatedEntityId: 'outlook-80',
        relatedEntityType: 'provider_connection',
        title: 'Outlook disconnected',
        deeplink: 'nexus://connections',
        dedupeKey: 'system:sync:80',
      } as never);
      await createNotificationIntent(buildReminderIntent(80, {
        requiresUserAction: false,
        priority: 'passive',
        dedupeKey: 'secretary:reminder:80:visible',
      }));

      const digest = assembleDailyDigest(80, 80, 2, new Date('2026-05-07T12:00:00.000Z'));

      expect(digest.body).toContain('reminder');
      expect(digest.body).not.toContain('connection needs attention');
      expect(digest.totalOpen).toBe(1);
    });

    it('does not count a recipe-muted item beside an allowed recipe of the same type', async () => {
      process.env.DECISION_TYPE_SUPPRESSION_ENABLED = 'true';
      muteRecipe(86, 'secretary', 'reminder', 'muted_recipe');
      await createNotificationIntent(buildReminderIntent(86, {
        requiresUserAction: false,
        priority: 'passive',
        decisionContext: { recipe: 'muted_recipe' },
        dedupeKey: 'secretary:reminder:86:muted',
      }));
      await createNotificationIntent(buildReminderIntent(86, {
        requiresUserAction: false,
        priority: 'passive',
        decisionContext: { recipe: 'allowed_recipe' },
        dedupeKey: 'secretary:reminder:86:allowed',
      }));

      const digest = assembleDailyDigest(86, 86, 2, new Date('2026-05-07T12:00:00.000Z'));

      expect(digest.body).toContain('1 reminder');
      expect(digest.body).not.toContain('2 reminders');
      expect(digest.totalOpen).toBe(1);
    });

    it('states what is waiting instead of only how many', async () => {
      await createNotificationIntent(buildReminderIntent(81, { requiresUserAction: false }));
      await createNotificationIntent({
        ...buildReminderIntent(81, { requiresUserAction: false }),
        type: 'sync_failure',
        relatedEntityType: 'provider_connection',
        dedupeKey: 'secretary:sync:81',
        title: 'Outlook disconnected',
      } as never);
      // Digest-routed items are ones that were never pushed. These fixtures
      // push on creation, so clear the stamp to model the real digest case.
      testDb.prepare('UPDATE notification_center_items SET last_pushed_at = NULL').run();

      const digest = assembleDailyDigest(81, 81, 2, new Date('2026-05-07T12:00:00.000Z'));

      // Deadline-ish classes rank ahead of plain reminders.
      expect(digest.body).toContain('connection needs attention');
      expect(digest.body).toContain('reminder');
      expect(digest.body).not.toContain('Nexus updates are ready');
      expect(digest.hasContent).toBe(true);
    });

    it('does not give a slot to something already pushed within the surfaced window', async () => {
      const created = await createNotificationIntent(buildReminderIntent(82, { requiresUserAction: false }));
      // Delivered 30 minutes ago — re-stating it is telling the user the same
      // sentence twice.
      testDb.prepare('UPDATE notification_center_items SET last_pushed_at = ? WHERE item_id = ?')
        .run('2026-05-07T11:30:00.000Z', created.item!.itemId);

      const digest = assembleDailyDigest(82, 82, 1, new Date('2026-05-07T12:00:00.000Z'));

      expect(digest.slots).toHaveLength(0);
      expect(digest.hasContent).toBe(false);
      // ...but it still counts toward queue depth, so the total stays honest.
      expect(digest.totalOpen).toBe(1);
    });

    it('gives a slot back once the surfaced window has passed', async () => {
      const created = await createNotificationIntent(buildReminderIntent(83, { requiresUserAction: false }));
      testDb.prepare('UPDATE notification_center_items SET last_pushed_at = ? WHERE item_id = ?')
        .run('2026-05-06T10:00:00.000Z', created.item!.itemId);

      const digest = assembleDailyDigest(83, 83, 1, new Date('2026-05-07T12:00:00.000Z'));

      // Stale-and-ignored is worth re-raising the next morning.
      expect(digest.slots).toHaveLength(1);
    });

    it('prefers the brief headline over a type breakdown', async () => {
      await createNotificationIntent(buildReminderIntent(84, { requiresUserAction: false }));
      const digest = assembleDailyDigest(84, 84, 1, new Date('2026-05-07T12:00:00.000Z'), '4 events, 6 tasks. First: Standup 09:00.');
      expect(digest.body).toBe('4 events, 6 tasks. First: Standup 09:00.');
    });

    it('lets only explicitly public composed digest copy reach the lock screen unrewritten', async () => {
      const created = await createNotificationIntent({
        ...buildReminderIntent(85, { requiresUserAction: false }),
        type: 'daily_digest',
        priority: 'passive',
        privacyPolicy: 'public',
        title: 'Your brief',
        body: '1 decision waiting · Standup 09:30',
        dedupeKey: 'secretary:digest:85',
      } as never);
      // Public is an explicit producer assertion that the composed copy contains
      // no private title, amount, health fact, or other authenticated detail.
      expect(created.item!.safeBody).toContain('Standup 09:30');
    });

    it('keeps private report headlines off the lock screen', async () => {
      const created = await createNotificationIntent({
        ...buildReminderIntent(87, { requiresUserAction: false }),
        type: 'daily_digest',
        priority: 'passive',
        privacyPolicy: 'sensitive',
        title: 'Your brief',
        body: 'Keep private oncology recovery run on track.',
        sensitiveBody: 'Keep private oncology recovery run on track.',
        dedupeKey: 'secretary:digest:87',
      } as never);

      expect(created.item!.safeBody).not.toContain('oncology');
      expect(created.item!.safeBody).not.toContain('recovery run');
      expect(created.item!.safeBody).toContain('open Nexus');
    });
  });

  // ──────────────────── P1.3 · weekly review clock ────────────────────

  describe('weekly review scheduling', () => {
    it('schedules a weekly review on its own day rather than the daily digest clock', async () => {
      // 2026-05-07 is a Thursday. Ask for Monday.
      updateNotificationProfile(86, 86, { weeklyReviewDay: 1, weeklyReviewTime: '09:00' } as never);
      const weekly = await createNotificationIntent({
        ...buildReminderIntent(86, { requiresUserAction: false }),
        type: 'weekly_review',
        priority: 'passive',
        title: 'Week in review',
        body: '9 decisions handled, 1 missed.',
        dedupeKey: 'secretary:weekly:86',
      } as never);

      const log = testDb.prepare('SELECT scheduled_for AS scheduledFor FROM notification_decision_logs WHERE intent_id = ?')
        .get(weekly.intent.intentId) as { scheduledFor: string };

      // Previously this landed on the NEXT DAILY digest slot — a retrospective
      // delivered every morning.
      const scheduled = new Date(log.scheduledFor);
      expect(scheduled.getUTCDay()).toBe(1);
      expect(scheduled.getTime()).toBeGreaterThan(new Date('2026-05-08T00:00:00.000Z').getTime());
    });
  });

  // ──────────────────── P0.8 · retention ────────────────────

  describe('retention', () => {
    it('ages out terminal history but never an unresolved item', async () => {
      const resolved = await createNotificationIntent(buildReminderIntent(61, { requiresUserAction: false }));
      const openItem = await createNotificationIntent(buildReminderIntent(62, { requiresUserAction: false }));
      performNotificationAction(resolved.item!.itemId, 'dismiss', 61, 61);

      // Age both rows well past the terminal-item window.
      const old = '2020-01-01T00:00:00.000Z';
      testDb.prepare('UPDATE notification_center_items SET created_at = ?').run(old);
      testDb.prepare('UPDATE notification_delivery_attempts SET created_at = ?').run(old);
      testDb.prepare('UPDATE notification_engagement_events SET created_at = ?').run(old);

      const summary = pruneNotificationRetention(new Date('2026-05-07T12:00:00.000Z'));

      expect(summary.centerItems).toBe(1);
      expect(summary.deliveryAttempts).toBeGreaterThan(0);
      // An old-but-unresolved item is still waiting on the user: deleting it
      // would silently drop something they never saw.
      expect(getNotificationCenterItem(openItem.item!.itemId, 62, 62)).not.toBeNull();
      expect(getNotificationCenterItem(resolved.item!.itemId, 61, 61)).toBeNull();
    });

    it('keeps recent history', async () => {
      await createNotificationIntent(buildReminderIntent(63, { requiresUserAction: false }));
      const summary = pruneNotificationRetention(new Date('2026-05-07T12:00:00.000Z'));
      expect(summary.centerItems).toBe(0);
      expect(summary.engagementEvents).toBe(0);
    });
  });

  // ──────────────────── P0.9 · accessibility ────────────────────

  describe('titles', () => {
    it('strips emoji so VoiceOver does not announce decoration', () => {
      expect(stripTitleEmoji('☀️ Thursday 12 May')).toBe('Thursday 12 May');
      expect(stripTitleEmoji('📊 Week in Review')).toBe('Week in Review');
      expect(stripTitleEmoji('🏋️ Coach Report')).toBe('Coach Report');
      expect(stripTitleEmoji('Schedule conflict needs review')).toBe('Schedule conflict needs review');
      // Matching on Extended_Pictographic also deleted legal and prose symbols
      // from the user's own text, mid-word. What predicts VoiceOver announcing
      // an emoji NAME is emoji presentation, not pictographic-ness.
      expect(stripTitleEmoji('CrossFit® Open 26.1')).toBe('CrossFit® Open 26.1');
      expect(stripTitleEmoji('Nexus™ weekly')).toBe('Nexus™ weekly');
      expect(stripTitleEmoji('Corrida ♀ 5km')).toBe('Corrida ♀ 5km');
      expect(stripTitleEmoji('Copyright © 2026')).toBe('Copyright © 2026');
      // Still stripped: intrinsic emoji presentation, and text symbols that a
      // VS16 selector forces into emoji presentation.
      expect(stripTitleEmoji('✅ Done')).toBe('Done');
      expect(stripTitleEmoji('🇵🇹 Lisboa')).toBe('Lisboa');
      // Whole sequences, not just their first code point: a keycap used to
      // leave an orphan combining mark, and ZWJ-joined emoji left their joiner.
      expect(stripTitleEmoji('1️⃣ Primeiro')).toBe('Primeiro');
      expect(stripTitleEmoji('👨‍👩‍👧 Family')).toBe('Family');
      expect(stripTitleEmoji('🏳️‍🌈 Pride')).toBe('Pride');
      expect(stripTitleEmoji('👍🏽 Boa')).toBe('Boa');
      // U+200D is a meaningful letter-joiner outside emoji. Removing it
      // unconditionally corrupted Devanagari and Persian text.
      expect(stripTitleEmoji('क्‍ष paragraph')).toBe('क्‍ष paragraph');
      expect(stripTitleEmoji('می‌رود')).toBe('می‌رود');
    });

    it('rejects an emoji-only title rather than storing a title that reads as nothing', async () => {
      await expect(createNotificationIntent(buildReminderIntent(64, { title: '🎉' })))
        .rejects.toThrow(/title required/);
    });

    it('stores the stripped title on the item', async () => {
      const created = await createNotificationIntent(buildReminderIntent(65, { title: '📊 Week in Review' }));
      expect(created.item!.title).toBe('Week in Review');
    });
  });

  // ──────────────────── P0.7 · engagement instrumentation ────────────────────

  describe('engagement instrumentation', () => {
    it('records surfaced, pushed and the resolving action', async () => {
      const created = await createNotificationIntent(buildReminderIntent(41, { requiresUserAction: false }));
      performNotificationAction(created.item!.itemId, 'dismiss', 41, 41);

      const events = testDb.prepare(
        'SELECT event_type FROM notification_engagement_events WHERE user_id = ? ORDER BY rowid',
      ).all(41) as Array<{ event_type: string }>;
      const types = events.map((e) => e.event_type);

      expect(types).toContain('surfaced');
      expect(types).toContain('pushed');
      expect(types).toContain('dismissed');
    });

    it('never fails a delivery when the engagement table is missing', async () => {
      testDb.exec('DROP TABLE notification_engagement_events');
      // ensureNotificationTables would recreate it, so assert the delivery
      // itself survives rather than that the table stays dropped.
      await expect(createNotificationIntent(buildReminderIntent(42)))
        .resolves.toBeDefined();
    });
  });
});
