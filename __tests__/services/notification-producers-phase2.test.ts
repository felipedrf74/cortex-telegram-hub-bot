/**
 * Phase 2 producers.
 *
 * Two notifications the product should always have sent: a user is told when
 * one of THEIR connections stops working, and a training session honours the
 * lead time they configured. Both are backed by state that already existed and
 * was simply never delivered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

let testDb: Database.Database;
const mockSendPushNotification = vi.fn();
let integrationSummary: { providers: Array<Record<string, unknown>> } = { providers: [] };

vi.mock('../../src/services/database', () => ({
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

/** Set to make the provider-state read throw, exercising the failure path. */
let integrationSummaryError: Error | null = null;

vi.mock('../../src/services/integration-status', () => ({
  getIntegrationSummary: vi.fn(() => {
    if (integrationSummaryError) throw integrationSummaryError;
    return integrationSummary;
  }),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import { ensureNotificationTables, updateNotificationProfile, listNotificationCenterItems } from '../../src/services/notification-orchestrator';
import { setPushPreference } from '../../src/services/report-document-store';
import { runConnectionHealthNotifier } from '../../src/services/connection-health-notifier';
import { runTrainingSessionReminders } from '../../src/services/training-session-reminder';

function seedAgendaTable(): void {
  testDb.exec(readFileSync('migrations/083_secretary_agenda_ledger.sql', 'utf8'));
}

function insertTrainingAgendaItem(opts: {
  id: string; userId: number; startAt: string; title?: string; lifecycleState?: string;
}): void {
  testDb.prepare(`
    INSERT INTO secretary_agenda_items
      (agenda_item_id, owner_user_id, tenant_id, source_skill, source_intent_id,
       version, lifecycle_state, provider_sync_state, title, decision_action,
       source_shape_hash, created_at, updated_at, start_at)
    VALUES (?, ?, ?, 'training', ?, 1, ?, 'synced', ?, 'scheduled', ?, ?, ?, ?)
  `).run(
    opts.id, opts.userId, String(opts.userId), `intent-${opts.id}`,
    opts.lifecycleState ?? 'scheduled', opts.title ?? 'Threshold run',
    `shape-${opts.id}`, '2026-05-07T10:00:00.000Z', '2026-05-07T10:00:00.000Z', opts.startAt,
  );
}

describe('Phase 2 — notification producers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-07T12:00:00.000Z'));
    testDb = new Database(':memory:');
    mockSendPushNotification.mockReset();
    mockSendPushNotification.mockResolvedValue({ sent: 1, failed: 0, skipped: 0, retriable: 0, unregistered: [] });
    process.env.NOTIFICATION_DELIVERY_MODE = 'apns';
    integrationSummary = { providers: [] };
    integrationSummaryError = null;
    ensureNotificationTables();
  });

  afterEach(() => {
    delete process.env.NOTIFICATION_DELIVERY_MODE;
    vi.useRealTimers();
    testDb?.close();
  });

  describe('broken connection notices', () => {
    it('reports a failure when the provider-state read throws', async () => {
      integrationSummaryError = new Error('integration read exploded');

      const summary = await runConnectionHealthNotifier([201, 202, 203]);

      // This catch used to `return { notified: 0, failed: 0 }`, and nothing
      // escapes the function — so the outer sweep's own catch could never fire
      // and a total outage reported {usersChecked:3, notified:0, failed:0}.
      // The scheduler only throws when failed > 0, so the job went green.
      expect(summary.usersChecked).toBe(3);
      expect(summary.failed).toBe(3);
      expect(summary.notified).toBe(0);
    });

    it('stays silent for a healthy or merely degraded connection', async () => {
      integrationSummary = {
        providers: [
          { provider: 'google', state: 'connected' },
          // degraded is usually a transient probe failure — notifying on it
          // would turn every hiccup into an interrupt.
          { provider: 'outlook', state: 'degraded' },
        ],
      };

      const summary = await runConnectionHealthNotifier([102]);

      expect(summary.notified).toBe(0);
      expect(listNotificationCenterItems(102, 102)).toHaveLength(0);
    });

    it('ignores providers that have their own producer', async () => {
      integrationSummary = { providers: [{ provider: 'garmin', state: 'revoked' }] };
      const summary = await runConnectionHealthNotifier([104]);
      expect(summary.notified).toBe(0);
    });
  });

  describe('training session reminders', () => {
    beforeEach(() => {
      seedAgendaTable();
    });

    it('honours the user-configured lead time', async () => {
      updateNotificationProfile(201, 201, { workoutReminderMinutes: 60 } as never);
      // 60 minutes out — inside the window.
      insertTrainingAgendaItem({ id: 'ag-201', userId: 201, startAt: '2026-05-07T13:02:00.000Z' });

      const summary = await runTrainingSessionReminders([201]);

      expect(summary.notified).toBe(1);
      const item = listNotificationCenterItems(201, 201)[0];
      expect(item.title).toBe('Threshold run');
      expect(item.body).toContain('60 minutes');
    });

    it('does not fire outside the lead-time window', async () => {
      updateNotificationProfile(202, 202, { workoutReminderMinutes: 60 } as never);
      // 4 hours out — far outside a 60-minute lead time.
      insertTrainingAgendaItem({ id: 'ag-202', userId: 202, startAt: '2026-05-07T16:00:00.000Z' });

      expect((await runTrainingSessionReminders([202])).notified).toBe(0);
    });

    it('respects a different lead time for a different user', async () => {
      updateNotificationProfile(203, 203, { workoutReminderMinutes: 30 } as never);
      insertTrainingAgendaItem({ id: 'ag-203a', userId: 203, startAt: '2026-05-07T12:31:00.000Z' });
      // Would have matched a 60-minute lead time, but this user chose 30.
      insertTrainingAgendaItem({ id: 'ag-203b', userId: 203, startAt: '2026-05-07T13:02:00.000Z' });

      const summary = await runTrainingSessionReminders([203]);

      expect(summary.notified).toBe(1);
      expect(listNotificationCenterItems(203, 203)[0].title).toBe('Threshold run');
    });

    it('skips a cancelled session', async () => {
      updateNotificationProfile(204, 204, { workoutReminderMinutes: 60 } as never);
      insertTrainingAgendaItem({
        id: 'ag-204', userId: 204, startAt: '2026-05-07T13:02:00.000Z', lifecycleState: 'canceled',
      });

      expect((await runTrainingSessionReminders([204])).notified).toBe(0);
    });

    it('stays silent when the user muted training', async () => {
      updateNotificationProfile(205, 205, {
        workoutReminderMinutes: 60,
        skillPreferences: { training: false },
      } as never);
      insertTrainingAgendaItem({ id: 'ag-205', userId: 205, startAt: '2026-05-07T13:02:00.000Z' });

      expect((await runTrainingSessionReminders([205])).notified).toBe(0);
    });

    it('honours the legacy Reminders push toggle without hiding the inbox item', async () => {
      updateNotificationProfile(208, 208, { workoutReminderMinutes: 60 } as never);
      setPushPreference(208, 'reminders', false);
      insertTrainingAgendaItem({ id: 'ag-208', userId: 208, startAt: '2026-05-07T13:02:00.000Z' });
      mockSendPushNotification.mockClear();

      const summary = await runTrainingSessionReminders([208]);

      expect(summary.notified).toBe(1);
      expect(listNotificationCenterItems(208, 208)).toHaveLength(1);
      expect(mockSendPushNotification).not.toHaveBeenCalled();
      expect(testDb.prepare(`
        SELECT decision, reason
          FROM notification_decision_logs
         WHERE user_id = 208
         ORDER BY created_at DESC
         LIMIT 1
      `).get()).toMatchObject({
        decision: 'in_app_only',
        reason: 'push disabled by reminders category preference',
      });
    });

    it('does not send the same reminder twice', async () => {
      updateNotificationProfile(206, 206, { workoutReminderMinutes: 60 } as never);
      insertTrainingAgendaItem({ id: 'ag-206', userId: 206, startAt: '2026-05-07T13:02:00.000Z' });

      await runTrainingSessionReminders([206]);
      // The sweep runs every 5 minutes; the window is 5 minutes wide, so a
      // boundary tick must not re-mint the same reminder.
      const second = await runTrainingSessionReminders([206]);

      expect(second.notified).toBe(0);
      expect(listNotificationCenterItems(206, 206)).toHaveLength(1);
    });

    it('does nothing for a user who never opened notification settings', async () => {
      insertTrainingAgendaItem({ id: 'ag-207', userId: 207, startAt: '2026-05-07T13:02:00.000Z' });
      expect((await runTrainingSessionReminders([207])).notified).toBe(0);
    });
  });
});
