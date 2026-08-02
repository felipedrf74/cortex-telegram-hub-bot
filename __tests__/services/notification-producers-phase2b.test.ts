/**
 * Phase 2 producers, second batch: commitment lead time and tax deadlines.
 *
 * Both honour a stored preference that previously had no reader
 * (`default_reminder_minutes`, `finance_reminder_days`), so the tests pin the
 * preference actually driving the timing — not just that a notification fires.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;
const mockSendPushNotification = vi.fn(async () => ({ sent: 1, failed: 0, skipped: 0, retriable: 0, unregistered: [] }));

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

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  ensureNotificationTables,
  getOrCreateNotificationProfile,
  updateNotificationProfile,
  listNotificationCenterItems,
} from '../../src/services/notification-orchestrator';
import { runCommitmentStartReminders } from '../../src/services/commitment-start-reminder';
import { setPushPreference } from '../../src/services/report-document-store';
import {
  financeTaxDueAt,
  resolveTaxDeadlineStage,
  runFinanceTaxDeadlineNotices,
} from '../../src/services/finance-tax-deadline-notifier';

function createAgendaTable(): void {
  testDb.exec(`
    CREATE TABLE IF NOT EXISTS secretary_agenda_items (
      agenda_item_id TEXT PRIMARY KEY,
      source_skill TEXT NOT NULL,
      owner_user_id INTEGER NOT NULL,
      tenant_id TEXT NOT NULL,
      lifecycle_state TEXT NOT NULL,
      title TEXT NOT NULL,
      start_at TEXT,
      end_at TEXT
    );
  `);
}

function createTaxTable(): void {
  testDb.exec(`
    CREATE TABLE IF NOT EXISTS finance_tax_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      month TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      tax_due REAL NOT NULL DEFAULT 0,
      inss_due REAL NOT NULL DEFAULT 0,
      UNIQUE(user_id, month)
    );
  `);
}

function addAgendaItem(o: {
  id: string; userId: number; sourceSkill: string; startAt: string; state?: string; title?: string;
}): void {
  testDb.prepare(`
    INSERT INTO secretary_agenda_items
      (agenda_item_id, source_skill, owner_user_id, tenant_id, lifecycle_state, title, start_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(o.id, o.sourceSkill, o.userId, String(o.userId), o.state ?? 'scheduled', o.title ?? 'Client call', o.startAt);
}

describe('commitment start reminders (SEC-02)', () => {
  const NOW = new Date('2026-05-07T09:00:00.000Z');

  beforeEach(() => {
    // The producer takes `now` explicitly, but the orchestrator reads the real
    // clock for expiry filtering. Without pinning the system time, every item
    // these tests create is already expired and never appears in the inbox.
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    testDb = new Database(':memory:');
    mockSendPushNotification.mockClear();
    ensureNotificationTables();
    createAgendaTable();
  });
  afterEach(() => { vi.useRealTimers(); testDb?.close(); });

  it('fires at the stored default_reminder_minutes lead time', async () => {
    getOrCreateNotificationProfile(60, 60);
    updateNotificationProfile(60, 60, { defaultReminderMinutes: 30 });
    // 30 minutes out → inside the window.
    addAgendaItem({ id: 'ag-1', userId: 60, sourceSkill: 'secretary', startAt: '2026-05-07T09:30:00.000Z' });

    const summary = await runCommitmentStartReminders([60], NOW);
    expect(summary.notified).toBe(1);

    const item = listNotificationCenterItems(60, 60).find((i) => i.type === 'reminder');
    expect(item?.body).toContain('30 minutes');
    // Time-sensitive: being late is not recoverable.
    expect(item?.priority).toBe('time_sensitive');
  });

  it('uses the commitment start as the quiet-hours deadline and respects the user time-sensitive switch', async () => {
    const early = new Date('2026-05-07T06:00:00.000Z');
    vi.setSystemTime(early);

    getOrCreateNotificationProfile(66, 66);
    updateNotificationProfile(66, 66, {
      defaultReminderMinutes: 30,
      timezone: 'UTC',
      quietHours: { start: '22:00', end: '07:00' },
      allowTimeSensitive: true,
    });
    addAgendaItem({ id: 'ag-early-allowed', userId: 66, sourceSkill: 'secretary', startAt: '2026-05-07T06:30:00.000Z' });

    getOrCreateNotificationProfile(67, 67);
    updateNotificationProfile(67, 67, {
      defaultReminderMinutes: 30,
      timezone: 'UTC',
      quietHours: { start: '22:00', end: '07:00' },
      allowTimeSensitive: false,
    });
    addAgendaItem({ id: 'ag-early-disabled', userId: 67, sourceSkill: 'secretary', startAt: '2026-05-07T06:30:00.000Z' });

    await runCommitmentStartReminders([66, 67], early);

    const allowed = testDb.prepare(
      "SELECT decision FROM notification_decision_logs WHERE user_id = 66 ORDER BY created_at DESC LIMIT 1",
    ).get() as { decision: string };
    const disabled = testDb.prepare(
      "SELECT decision FROM notification_decision_logs WHERE user_id = 67 ORDER BY created_at DESC LIMIT 1",
    ).get() as { decision: string };
    expect(allowed.decision).not.toBe('quiet_hours_delayed');
    expect(disabled.decision).toBe('quiet_hours_delayed');
  });

  it('honours a changed lead time rather than a hardcoded 30 minutes', async () => {
    getOrCreateNotificationProfile(61, 61);
    updateNotificationProfile(61, 61, { defaultReminderMinutes: 120 });
    // 30 minutes out — would fire on the default, must NOT fire on 120.
    addAgendaItem({ id: 'ag-2', userId: 61, sourceSkill: 'secretary', startAt: '2026-05-07T09:30:00.000Z' });
    expect((await runCommitmentStartReminders([61], NOW)).notified).toBe(0);

    // 120 minutes out — fires.
    addAgendaItem({ id: 'ag-3', userId: 61, sourceSkill: 'secretary', startAt: '2026-05-07T11:00:00.000Z' });
    expect((await runCommitmentStartReminders([61], NOW)).notified).toBe(1);
  });

  it('leaves training sessions to the training reminder so one session is not pushed twice', async () => {
    getOrCreateNotificationProfile(62, 62);
    updateNotificationProfile(62, 62, { defaultReminderMinutes: 30 });
    addAgendaItem({ id: 'ag-4', userId: 62, sourceSkill: 'training', startAt: '2026-05-07T09:30:00.000Z' });

    expect((await runCommitmentStartReminders([62], NOW)).notified).toBe(0);
  });

  it('ignores commitments that are cancelled or already past', async () => {
    getOrCreateNotificationProfile(63, 63);
    updateNotificationProfile(63, 63, { defaultReminderMinutes: 30 });
    addAgendaItem({ id: 'ag-5', userId: 63, sourceSkill: 'secretary', startAt: '2026-05-07T09:30:00.000Z', state: 'canceled' });
    addAgendaItem({ id: 'ag-6', userId: 63, sourceSkill: 'secretary', startAt: '2026-05-07T08:00:00.000Z' });

    expect((await runCommitmentStartReminders([63], NOW)).notified).toBe(0);
  });

  it('does not re-notify for the same commitment on a later sweep tick', async () => {
    getOrCreateNotificationProfile(64, 64);
    updateNotificationProfile(64, 64, { defaultReminderMinutes: 30 });
    addAgendaItem({ id: 'ag-7', userId: 64, sourceSkill: 'secretary', startAt: '2026-05-07T09:30:00.000Z' });

    expect((await runCommitmentStartReminders([64], NOW)).notified).toBe(1);
    // Boundary tick a minute later still matches the window.
    const again = await runCommitmentStartReminders([64], new Date('2026-05-07T09:01:00.000Z'));
    expect(again.notified).toBe(0);
  });

  it('stays silent when the user muted the secretary skill', async () => {
    getOrCreateNotificationProfile(65, 65);
    updateNotificationProfile(65, 65, { defaultReminderMinutes: 30, skillPreferences: { secretary: false } });
    addAgendaItem({ id: 'ag-8', userId: 65, sourceSkill: 'secretary', startAt: '2026-05-07T09:30:00.000Z' });

    expect((await runCommitmentStartReminders([65], NOW)).notified).toBe(0);
  });

  it('honours the legacy Reminders push toggle without hiding the inbox item', async () => {
    getOrCreateNotificationProfile(67, 67);
    updateNotificationProfile(67, 67, { defaultReminderMinutes: 30 });
    setPushPreference(67, 'reminders', false);
    addAgendaItem({ id: 'ag-10', userId: 67, sourceSkill: 'secretary', startAt: '2026-05-07T09:30:00.000Z' });

    const summary = await runCommitmentStartReminders([67], NOW);

    expect(summary.notified).toBe(1);
    expect(listNotificationCenterItems(67, 67)).toHaveLength(1);
    expect(mockSendPushNotification).not.toHaveBeenCalled();
    expect(testDb.prepare(`
      SELECT decision, reason
        FROM notification_decision_logs
       WHERE user_id = 67
       ORDER BY created_at DESC
       LIMIT 1
    `).get()).toMatchObject({
      decision: 'in_app_only',
      reason: 'push disabled by reminders category preference',
    });
  });

  it('skips users who have never opened notification settings', async () => {
    addAgendaItem({ id: 'ag-9', userId: 66, sourceSkill: 'secretary', startAt: '2026-05-07T09:30:00.000Z' });
    expect((await runCommitmentStartReminders([66], NOW)).notified).toBe(0);
  });
});

describe('tax deadline notices (FIN-01/02)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-19T09:10:00.000Z'));
    testDb = new Database(':memory:');
    ensureNotificationTables();
    createTaxTable();
  });
  afterEach(() => { vi.useRealTimers(); testDb?.close(); });

  it('derives the due date as the 20th at 09:00 UTC', () => {
    expect(financeTaxDueAt('2026-05')?.toISOString()).toBe('2026-05-20T09:00:00.000Z');
    expect(financeTaxDueAt('nonsense')).toBeNull();
    expect(financeTaxDueAt('2026-13')).toBeNull();
  });

  it('resolves the stage from the due date and the user lead time', () => {
    const due = new Date('2026-05-20T09:00:00.000Z');
    expect(resolveTaxDeadlineStage(due, new Date('2026-05-20T06:00:00.000Z'), 1)).toBe('due_today');
    expect(resolveTaxDeadlineStage(due, new Date('2026-05-19T06:00:00.000Z'), 1)).toBe('due_soon');
    // Outside the lead window.
    expect(resolveTaxDeadlineStage(due, new Date('2026-05-17T06:00:00.000Z'), 1)).toBeNull();
    // A longer lead time reaches further back.
    expect(resolveTaxDeadlineStage(due, new Date('2026-05-17T06:00:00.000Z'), 5)).toBe('due_soon');
    // Already past — a notification after the deadline is not the fix.
    expect(resolveTaxDeadlineStage(due, new Date('2026-05-21T06:00:00.000Z'), 1)).toBeNull();
  });

  it('escalates due-soon then due-today instead of collapsing into one', async () => {
    getOrCreateNotificationProfile(70, 70);
    testDb.prepare("INSERT INTO finance_tax_events (user_id, month, status, tax_due) VALUES (70, '2026-05', 'pending', 100)").run();

    vi.setSystemTime(new Date('2026-05-19T09:10:00.000Z'));
    const soon = await runFinanceTaxDeadlineNotices([70], new Date('2026-05-19T09:10:00.000Z'));
    expect(soon.notified).toBe(1);

    // The catalog suggested one shared dedupe key. That would let the still-open
    // due-soon item swallow this escalation, so the stages are keyed separately.
    expect(listNotificationCenterItems(70, 70).map((i) => i.title)).toContain('Tax payment due soon');

    // The catalog suggested one shared dedupe key. That would let the still-open
    // due-soon item swallow this escalation, so the stages are keyed separately.
    vi.setSystemTime(new Date('2026-05-20T08:10:00.000Z'));
    const today = await runFinanceTaxDeadlineNotices([70], new Date('2026-05-20T08:10:00.000Z'));
    expect(today.notified).toBe(1);

    // Separate keys, but the inbox does not accumulate two rows for one
    // deadline: due-soon expires at the start of the due day, so it retires
    // exactly as the escalation arrives.
    const live = listNotificationCenterItems(70, 70).map((i) => i.title);
    expect(live).toContain('Tax payment due today');
    expect(live).not.toContain('Tax payment due soon');

    const escalation = listNotificationCenterItems(70, 70).find((i) => i.title === 'Tax payment due today');
    expect(escalation?.priority).toBe('time_sensitive');
  });

  it('keeps amounts and references out of the notification body', async () => {
    getOrCreateNotificationProfile(71, 71);
    testDb.prepare("INSERT INTO finance_tax_events (user_id, month, status, tax_due) VALUES (71, '2026-05', 'pending', 100)").run();
    vi.setSystemTime(new Date('2026-05-20T08:10:00.000Z'));
    await runFinanceTaxDeadlineNotices([71], new Date('2026-05-20T08:10:00.000Z'));

    const item = listNotificationCenterItems(71, 71)[0];
    expect(item.body).not.toMatch(/\d+[.,]\d{2}/);
    expect(item.title).not.toMatch(/\d+[.,]\d{2}/);
  });

  it('ignores paid events', async () => {
    getOrCreateNotificationProfile(72, 72);
    testDb.prepare("INSERT INTO finance_tax_events (user_id, month, status) VALUES (72, '2026-05', 'paid')").run();
    expect((await runFinanceTaxDeadlineNotices([72], new Date('2026-05-20T08:10:00.000Z'))).notified).toBe(0);
  });

  it('does not call a zero-liability month a payment deadline', async () => {
    getOrCreateNotificationProfile(75, 75);
    testDb.prepare("INSERT INTO finance_tax_events (user_id, month, status) VALUES (75, '2026-05', 'pending')").run();

    const summary = await runFinanceTaxDeadlineNotices([75], new Date('2026-05-20T08:10:00.000Z'));

    expect(summary.inspected).toBe(0);
    expect(summary.notified).toBe(0);
    expect(listNotificationCenterItems(75, 75)).toHaveLength(0);
  });

  it('honours a longer finance_reminder_days lead time', async () => {
    getOrCreateNotificationProfile(73, 73);
    updateNotificationProfile(73, 73, { financeReminderDays: 5 });
    testDb.prepare("INSERT INTO finance_tax_events (user_id, month, status, inss_due) VALUES (73, '2026-05', 'pending', 50)").run();

    // 4 days out — silent on the default of 1, fires on 5.
    vi.setSystemTime(new Date('2026-05-16T09:10:00.000Z'));
    expect((await runFinanceTaxDeadlineNotices([73], new Date('2026-05-16T09:10:00.000Z'))).notified).toBe(1);
  });

  it('stays silent when the user muted finance', async () => {
    getOrCreateNotificationProfile(74, 74);
    updateNotificationProfile(74, 74, { skillPreferences: { finance: false } });
    testDb.prepare("INSERT INTO finance_tax_events (user_id, month, status, tax_due) VALUES (74, '2026-05', 'pending', 100)").run();
    expect((await runFinanceTaxDeadlineNotices([74], new Date('2026-05-20T08:10:00.000Z'))).notified).toBe(0);
  });
});
