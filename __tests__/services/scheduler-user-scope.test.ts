// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';
import fs from 'fs';
import path from 'path';

const fixedNow = DateTime.fromISO('2026-04-17T08:00:00', { zone: 'Europe/Lisbon' });

const mockGetTaskProviderForUser = vi.fn();
const mockGetAllPendingTasks = vi.fn();
const mockGetCompletedTasksInRange = vi.fn();
const mockGetSharedListPendingTasks = vi.fn();
const mockIsSelfCreatedTask = vi.fn();
const mockGetEvents = vi.fn();
const mockHasConnectedCalendarForUser = vi.fn();
const mockGetUnreadCountForUser = vi.fn();
const mockIsOutlookMailConfiguredForUser = vi.fn();
const mockGetRemindersForToday = vi.fn();
const mockRunWithContext = vi.fn((_ctx, fn: () => unknown) => fn());
const mockStoreAndPushReport = vi.fn();
const mockGetDb = vi.fn();
const mockGetOwnerBootstrapTarget = vi.fn();
const mockGenerateCoachBriefing = vi.hoisted(() => vi.fn());
const mockCronSchedule = vi.hoisted(() => vi.fn());
const mockCreateNotificationIntent = vi.hoisted(() => vi.fn());
const mockRunEventBackboneOnce = vi.hoisted(() => vi.fn());
const mockRunEventBackboneCleanup = vi.hoisted(() => vi.fn());
const mockRunGarminTenantIsolationWatcher = vi.hoisted(() => vi.fn());
const mockGetActivePlan = vi.hoisted(() => vi.fn());
const mockGetCurrentWeek = vi.hoisted(() => vi.fn());
const mockGetWeeklyAdherence = vi.hoisted(() => vi.fn());
const mockComputeAdjustmentRecommendation = vi.hoisted(() => vi.fn());
const mockUpdateWeekAdjustment = vi.hoisted(() => vi.fn());
const mockGetWeeksForPlan = vi.hoisted(() => vi.fn());
const mockCalculateReadiness = vi.hoisted(() => vi.fn());
const mockPersistReadinessScore = vi.hoisted(() => vi.fn());
const mockGetEffectiveEntitlement = vi.hoisted(() => vi.fn());

vi.mock('node-cron', () => ({
  default: { schedule: (...args: unknown[]) => mockCronSchedule(...args) },
}));

vi.mock('../../src/config', () => ({
  config: {
    app: { timezone: 'Europe/Lisbon', databasePath: '/tmp/nexus-test.db' },
    todo: { digestTime: '08:00', digestEnabled: true },
    garmin: { coachTime: '21:00' },
    backup: { time: '03:00' },
    telegram: { allowedUserIds: [999001] },
  },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/state/reminders', () => ({
  getDueReminders: vi.fn(() => []),
  markReminderFired: vi.fn(),
  getRemindersForToday: (...args: unknown[]) => mockGetRemindersForToday(...args),
}));

vi.mock('../../src/services/microsoft-todo', () => ({
  isOutlookTodoConfigured: vi.fn(() => false),
  getAllPendingTasks: vi.fn(),
  getCompletedTasksInRange: vi.fn(),
}));

vi.mock('../../src/services/unified-calendar', () => ({
  getEvents: (...args: unknown[]) => mockGetEvents(...args),
  hasConnectedCalendarForUser: (...args: unknown[]) => mockHasConnectedCalendarForUser(...args),
  isAnyCalendarConfigured: vi.fn(() => false),
}));

vi.mock('../../src/services/outlook-mail', () => ({
  isOutlookMailConfigured: vi.fn(() => false),
  getUnreadCount: vi.fn(),
  isOutlookMailConfiguredForUser: (...args: unknown[]) => mockIsOutlookMailConfiguredForUser(...args),
  getUnreadCountForUser: (...args: unknown[]) => mockGetUnreadCountForUser(...args),
  sendEmail: vi.fn(),
}));

vi.mock('../../src/utils/date-parser', () => ({
  now: () => fixedNow,
  startOfDay: (value?: unknown) => (DateTime.isDateTime(value) ? value : fixedNow).startOf('day').toISO(),
  endOfDay: (value?: unknown) => (DateTime.isDateTime(value) ? value : fixedNow).endOf('day').toISO(),
  startOfWeek: (value?: unknown) => (DateTime.isDateTime(value) ? value : fixedNow).startOf('week').toISO(),
  endOfWeek: (value?: unknown) => (DateTime.isDateTime(value) ? value : fixedNow).endOf('week').toISO(),
  formatTime: (iso: string) => DateTime.fromISO(iso).toFormat('HH:mm'),
  formatDateTime: (iso: string) => DateTime.fromISO(iso).toFormat('LLL dd HH:mm'),
}));

vi.mock('../../src/utils/telegram-formatter', () => ({
  formatDailyBriefing: vi.fn((data: any) => `briefing:${data.date}:${data.events.length}:${data.dueTodayTasks.length}`),
  escapeHtml: (value: string) => value,
  splitMessage: (message: string) => [message],
}));

vi.mock('../../src/services/invoice-collector', () => ({
  collectMonthlyInvoices: vi.fn(),
  formatCollectionNotification: vi.fn(),
}));
vi.mock('../../src/services/invoice-filer', () => ({ isInvoiceFilingConfigured: vi.fn(() => false) }));
vi.mock('../../src/services/amazon-collector', () => ({
  collectAmazonInvoices: vi.fn(),
  formatAmazonNotification: vi.fn(),
  isAmazonConfigured: vi.fn(() => false),
}));
vi.mock('../../src/services/uber-collector', () => ({
  collectUberInvoices: vi.fn(),
  formatUberNotification: vi.fn(),
  isUberConfigured: vi.fn(() => false),
}));
vi.mock('../../src/services/fiscal-bundle', () => ({
  getFiscalCollectionSummary: vi.fn(),
  isFiscalBundleDue: vi.fn(() => false),
  sendFiscalBundleNow: vi.fn(),
}));
vi.mock('../../src/services/garmin-coach', () => ({
  generateCoachBriefing: (...args: unknown[]) => mockGenerateCoachBriefing(...args),
}));
vi.mock('../../src/services/garmin', () => ({
  isGarminConfigured: vi.fn(() => false),
  keepAlive: vi.fn(),
  ensureAuthenticated: vi.fn(),
}));
vi.mock('../../src/services/garmin-tenant-isolation-watcher', () => ({
  runGarminTenantIsolationWatcher: (...args: unknown[]) => mockRunGarminTenantIsolationWatcher(...args),
}));
vi.mock('../../src/portal/telemetry', () => ({
  registerJob: vi.fn(),
  wrapJob: (name: string, fn: () => unknown) => Object.assign(fn, { jobName: name }),
  recordGarminRefresh: vi.fn(),
  setJobFailureNotifier: vi.fn(),
  setJobEnabledChecker: vi.fn(),
  getJobMap: vi.fn(() => new Map()),
  seedJobLastRunFromHistory: vi.fn(),
}));
vi.mock('../../src/services/apns-sender', () => ({ sendPushNotification: vi.fn() }));
vi.mock('../../src/skills/skill-manager', () => ({ isCronJobEnabled: vi.fn(() => true) }));
vi.mock('../../src/services/invoice-queue', () => ({ flushQueue: vi.fn(), getPendingCount: vi.fn(() => 0) }));
vi.mock('../../src/domains/domain-handler', () => ({ setLastCoachState: vi.fn() }));
vi.mock('../../src/api/routes/chat-message-context', () => ({ setLastActiveDomain: vi.fn() }));
vi.mock('../../src/state/conversation', () => ({ addToConversation: vi.fn() }));
vi.mock('../../src/services/channel-learner', () => ({ processAllChannelScopes: vi.fn(), seedDefaultChannels: vi.fn() }));
vi.mock('../../src/services/content-workflow', () => ({ sendTopicCandidates: vi.fn(), sendWeeklyPackage: vi.fn() }));
vi.mock('../../src/agents/pipeline-agent', () => ({ runPipelineAgent: vi.fn() }));
vi.mock('../../src/agents/seo-agent', () => ({ runSEOAgent: vi.fn(), seedKeywordsIfEmpty: vi.fn() }));
vi.mock('../../src/agents/reaction-radar-agent', () => ({ runReactionRadar: vi.fn() }));
vi.mock('../../src/agents/performance-agent', () => ({ runPerformanceAgent: vi.fn() }));
vi.mock('../../src/agents/voice-evolution-agent', () => ({ runVoiceEvolutionAgent: vi.fn() }));
vi.mock('../../src/services/intelligence-bus', () => ({ expireStaleSignals: vi.fn() }));
vi.mock('../../src/commands/books', () => ({ seedBooksIfEmpty: vi.fn() }));
vi.mock('../../src/services/autoresearch', () => ({ runAutoresearch: vi.fn(), getScheduledTarget: vi.fn() }));
vi.mock('../../src/services/backup', () => ({ runDatabaseBackup: vi.fn(), weeklyRestoreTest: vi.fn() }));
vi.mock('../../src/state/fiscal-collection-profiles', () => ({ listActiveFiscalCollectionProfiles: vi.fn(() => []) }));
vi.mock('../../src/utils/request-context', () => ({
  runWithContext: (...args: unknown[]) => mockRunWithContext(...args),
}));
vi.mock('../../src/services/user-service', () => ({
  getUserById: vi.fn((id: number) => ({ id, telegram_id: id + 1000 })),
  resolveCanonicalUserId: vi.fn((ref: number) => ref + 10),
  // Identity-safety: scheduler now uses the strict by-id helpers post-audit.
  getUserLanguage: vi.fn(() => 'en'),
  getUserLanguageById: vi.fn(() => 'en'),
  getPreferredDisplayName: vi.fn(() => 'Test User'),
  getPreferredDisplayNameById: vi.fn(() => 'Test User'),
  getUserTimezone: vi.fn(() => 'Europe/Lisbon'),
  getUserTimezoneById: vi.fn(() => 'Europe/Lisbon'),
  getOwnerBootstrapTarget: (...args: unknown[]) => mockGetOwnerBootstrapTarget(...args),
}));
vi.mock('../../src/services/task-store/task-router', () => ({
  resolveTaskProvider: vi.fn(() => 'nexus'),
  getTaskProviderForUser: (...args: unknown[]) => mockGetTaskProviderForUser(...args),
}));
vi.mock('../../src/services/database', () => ({
  getDb: (...args: unknown[]) => mockGetDb(...args),
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));
vi.mock('../../src/services/report-document-store', () => ({
  storeAndPushReport: (...args: unknown[]) => mockStoreAndPushReport(...args),
}));
// The four report crons now run on */5 dispatch ticks (same expression as
// shared_list), so expression-driven callback invocation reaches them in
// this suite. Dispatch timing has its own suite
// (report-schedule-dispatcher.test.ts); here nobody is ever "due" so the
// scoping tests stay isolated.
vi.mock('../../src/services/report-schedule-dispatcher', () => ({
  resolveDueReportTargets: vi.fn(() => []),
}));
vi.mock('../../src/services/notification-orchestrator', () => ({
  createNotificationIntent: (...args: unknown[]) => mockCreateNotificationIntent(...args),
  releaseDueNotificationDeliveries: vi.fn(),
}));
vi.mock('../../src/services/event-backbone-worker', () => ({
  runEventBackboneOnce: (...args: unknown[]) => mockRunEventBackboneOnce(...args),
}));
vi.mock('../../src/tools/event-backbone-cleanup', () => ({
  runEventBackboneCleanup: (...args: unknown[]) => mockRunEventBackboneCleanup(...args),
}));
vi.mock('../../src/services/training-plans', () => ({
  getActivePlans: vi.fn(() => []),
  getActivePlan: (...args: unknown[]) => mockGetActivePlan(...args),
  getCurrentWeek: (...args: unknown[]) => mockGetCurrentWeek(...args),
  getWeeklyAdherence: (...args: unknown[]) => mockGetWeeklyAdherence(...args),
  computeAdjustmentRecommendation: (...args: unknown[]) => mockComputeAdjustmentRecommendation(...args),
  updateWeekAdjustment: (...args: unknown[]) => mockUpdateWeekAdjustment(...args),
  getWeeksForPlan: (...args: unknown[]) => mockGetWeeksForPlan(...args),
  getSessionsForWeek: vi.fn(() => []),
}));
vi.mock('../../src/services/readiness-scorer', () => ({
  calculateReadiness: (...args: unknown[]) => mockCalculateReadiness(...args),
  persistReadinessScore: (...args: unknown[]) => mockPersistReadinessScore(...args),
}));
vi.mock('../../src/services/entitlement', () => ({
  getEffectiveEntitlement: (...args: unknown[]) => mockGetEffectiveEntitlement(...args),
  isCoachBriefingEntitlementEligible: (entitlement: { plan: string; source: string }) =>
    (entitlement.plan === 'pro' || entitlement.plan === 'max') && entitlement.source !== 'beta',
}));

import * as globalMail from '../../src/services/outlook-mail';
import * as globalTodo from '../../src/services/microsoft-todo';
import {
  _resetSchedulerTenantStateForTesting,
  buildConflictAlertForUser,
  buildDailyBriefingDataForUser,
  buildEndOfDaySummaryForUser,
  buildSharedListNotificationForUser,
  buildWeeklyReviewPayloadForUser,
  decisionMetricsRollupDateForScheduler,
  getActiveUserIds,
  getOwnerUserIds,
  startScheduler,
  sendCoachBriefings,
  sendDailyBriefing,
} from '../../src/services/scheduler';
import { setLastCoachState } from '../../src/domains/domain-handler';
import { setLastActiveDomain } from '../../src/api/routes/chat-message-context';
import { addToConversation } from '../../src/state/conversation';
import { getDueReminders, markReminderFired } from '../../src/state/reminders';

describe('scheduler tenant scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetSchedulerTenantStateForTesting();

    mockGetTaskProviderForUser.mockReturnValue({
      getAllPendingTasks: mockGetAllPendingTasks,
      getCompletedTasksInRange: mockGetCompletedTasksInRange,
      getSharedListPendingTasks: mockGetSharedListPendingTasks,
      isSelfCreatedTask: mockIsSelfCreatedTask,
    });
    mockHasConnectedCalendarForUser.mockReturnValue(true);
    mockGetEvents.mockResolvedValue([]);
    mockIsOutlookMailConfiguredForUser.mockReturnValue(true);
    mockGetUnreadCountForUser.mockResolvedValue(0);
    mockGetRemindersForToday.mockReturnValue([]);
    mockGetAllPendingTasks.mockResolvedValue({ success: true, data: [] });
    mockGetCompletedTasksInRange.mockResolvedValue({ success: true, data: [] });
    mockGetSharedListPendingTasks.mockResolvedValue({ success: true, data: [] });
    mockIsSelfCreatedTask.mockReturnValue(false);
    mockGetDb.mockReturnValue({
      prepare: vi.fn(() => ({
        all: vi.fn(() => [
          { id: 11, telegram_id: 1011 },
          { id: 22, telegram_id: null },
        ]),
      })),
    });
    mockGetOwnerBootstrapTarget.mockReturnValue({ tenantId: 99, telegramId: 1999 });
    mockCreateNotificationIntent.mockResolvedValue({ decision: 'in_app_only' });
    mockRunEventBackboneOnce.mockResolvedValue({
      events: { processed: 0, failed: 0, deadLetter: 0 },
      jobs: { completed: 0, failed: 0, deadLetter: 0, skipped: 0 },
    });
    mockRunEventBackboneCleanup.mockReturnValue({
      apply: false,
      databasePath: '/tmp/nexus-test.db',
      retentionDays: 30,
      cutoff: '2026-04-01T00:00:00.000Z',
      targets: [],
    });
    mockGenerateCoachBriefing.mockResolvedValue({
      message: 'coach briefing',
      recommendations: [],
      errors: [],
      dataCollectionMs: 1,
      analysisMs: 2,
    });
    mockGetEffectiveEntitlement.mockReturnValue({ plan: 'pro', source: 'stripe' });
    mockGetActivePlan.mockReturnValue(null);
    mockGetCurrentWeek.mockReturnValue(null);
    mockGetWeeklyAdherence.mockReturnValue({ completedSessions: 0, skippedSessions: 0 });
    mockComputeAdjustmentRecommendation.mockReturnValue({ adjustIntensity: 100, reason: 'No adjustment' });
    mockUpdateWeekAdjustment.mockReturnValue(true);
    mockGetWeeksForPlan.mockReturnValue([]);
    mockCalculateReadiness.mockResolvedValue({ score: 80, recommendation: 'Ready', factors: {} });
    mockPersistReadinessScore.mockReturnValue(undefined);
  });

  it('computes Decision Metrics rollup date in the scheduler timezone across Lisbon DST', () => {
    const summerMidnight = DateTime.fromISO('2026-06-03T00:15:00', { zone: 'Europe/Lisbon' }).toJSDate();
    expect(decisionMetricsRollupDateForScheduler(summerMidnight, 'Europe/Lisbon')).toBe('2026-06-02');

    const winterMidnight = DateTime.fromISO('2026-01-03T00:15:00', { zone: 'Europe/Lisbon' }).toJSDate();
    expect(decisionMetricsRollupDateForScheduler(winterMidnight, 'Europe/Lisbon')).toBe('2026-01-02');
  });

  it('source-pins reminder cron as per-reminder fault isolated and tenant deduped', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/services/scheduler.ts'), 'utf8');
    const loopIndex = source.indexOf('for (const reminder of dueReminders)');
    const orchestrationFailureIndex = source.indexOf('Reminder notification orchestration failed');
    const deliveredCheckIndex = source.indexOf('if (delivered)', loopIndex);
    const markFiredIndex = source.indexOf('markReminderFired(reminder.id)', loopIndex);

    expect(loopIndex).toBeGreaterThan(-1);
    expect(orchestrationFailureIndex).toBeGreaterThan(loopIndex);
    expect(deliveredCheckIndex).toBeGreaterThan(orchestrationFailureIndex);
    expect(markFiredIndex).toBeGreaterThan(deliveredCheckIndex);
    expect(source).toContain('Reminder delivery failed on all channels; not marking fired');
    expect(source).toContain('dedupeKey: `secretary:reminder:${targetTenantId}:${targetUserId}:${reminder.id}:${reminderOccurrence}`');
    expect(source).toContain('tenantId: targetTenantId');
  });

  it('continues processing later reminders when one reminder delivery fails', async () => {
    vi.mocked(getDueReminders).mockReturnValue([
      { id: 2, user_id: 42, tenant_id: 42, message: 'First reminder fails', remind_at: '2026-04-17T08:00:00.000Z', recurring: null },
      { id: 3, user_id: 42, tenant_id: 42, message: 'Second reminder succeeds', remind_at: '2026-04-17T08:01:00.000Z', recurring: null },
    ] as any);
    mockCreateNotificationIntent
      .mockRejectedValueOnce(new Error('push unavailable'))
      .mockResolvedValueOnce({ decision: 'in_app_only' });

    startScheduler();
    const reminderJob = mockCronSchedule.mock.calls.find((call) => call[0] === '* * * * *' && String(call[1]).includes('getDueReminders'))?.[1] as (() => Promise<unknown>) | undefined;
    expect(reminderJob).toBeTypeOf('function');

    await reminderJob!();

    expect(mockCreateNotificationIntent).toHaveBeenCalledTimes(2);
    expect(markReminderFired).toHaveBeenCalledTimes(1);
    expect(markReminderFired).toHaveBeenCalledWith(3);
  });

  it('does not mark one-shot reminders fired when all delivery channels fail', async () => {
    vi.mocked(getDueReminders).mockReturnValue([
      { id: 4, user_id: 42, tenant_id: 42, message: 'Do not lose me', remind_at: '2026-04-17T08:00:00.000Z', recurring: null },
    ] as any);
    mockCreateNotificationIntent.mockRejectedValueOnce(new Error('notification store down'));

    startScheduler();
    const reminderJob = mockCronSchedule.mock.calls.find((call) => call[0] === '* * * * *' && String(call[1]).includes('getDueReminders'))?.[1] as (() => Promise<unknown>) | undefined;
    expect(reminderJob).toBeTypeOf('function');

    await reminderJob!();

    expect(markReminderFired).not.toHaveBeenCalled();
  });

  it('uses per-occurrence dedupe keys for recurring reminder notifications', async () => {
    vi.mocked(getDueReminders)
      .mockReturnValueOnce([
        { id: 5, user_id: 42, tenant_id: 42, message: 'Repeat me', remind_at: '2026-04-17T08:00:00.000Z', recurring: 'daily' },
      ] as any)
      .mockReturnValueOnce([
        { id: 5, user_id: 42, tenant_id: 42, message: 'Repeat me', remind_at: '2026-04-18T08:00:00.000Z', recurring: 'daily' },
      ] as any);
    mockCreateNotificationIntent.mockResolvedValue({ decision: 'in_app_only' });

    startScheduler();
    const reminderJob = mockCronSchedule.mock.calls.find((call) => call[0] === '* * * * *' && String(call[1]).includes('getDueReminders'))?.[1] as (() => Promise<unknown>) | undefined;
    expect(reminderJob).toBeTypeOf('function');

    await reminderJob!();
    await reminderJob!();

    const dedupeKeys = mockCreateNotificationIntent.mock.calls.map((call) => call[0]?.dedupeKey);
    expect(dedupeKeys).toEqual([
      'secretary:reminder:42:42:5:1776412800000',
      'secretary:reminder:42:42:5:1776499200000',
    ]);
    expect(new Set(dedupeKeys).size).toBe(2);
  });

  it('getActiveUserIds returns canonical tenant ids from the users table', () => {
    expect(getActiveUserIds()).toEqual([11, 22]);
  });

  it('getActiveUserIds and getOwnerUserIds fall back to the owner bootstrap target', () => {
    mockGetDb.mockImplementation(() => {
      throw new Error('no users table');
    });

    expect(getActiveUserIds()).toEqual([99]);
    expect(getOwnerUserIds()).toEqual([1999]);
  });

  it('buildDailyBriefingDataForUser uses scoped task, calendar, mail, and reminder reads', async () => {
    mockGetEvents.mockResolvedValue([
      { summary: 'Strength workout', start: '2026-04-17T09:00:00.000Z', end: '2026-04-17T10:00:00.000Z' },
    ]);
    mockGetAllPendingTasks.mockResolvedValue({
      success: true,
      data: [
        { id: 'hp', title: 'Priority', listName: 'Inbox', importance: 'high', dueDateTime: null },
        { id: 'today', title: 'Today task', listName: 'Inbox', importance: 'normal', dueDateTime: '2026-04-17T12:00:00.000Z' },
        { id: 'late', title: 'Late task', listName: 'Inbox', importance: 'normal', dueDateTime: '2026-04-16T12:00:00.000Z' },
      ],
    });
    mockGetCompletedTasksInRange.mockResolvedValue({
      success: true,
      data: [{ id: 'done1' }, { id: 'done2' }],
    });
    mockGetRemindersForToday.mockReturnValue([
      { message: 'Take supplements', remind_at: '2026-04-17T07:30:00.000Z' },
    ]);
    mockGetUnreadCountForUser.mockResolvedValue(5);

    const result = await buildDailyBriefingDataForUser(42);

    expect(mockGetTaskProviderForUser).toHaveBeenCalledWith(42);
    expect(mockRunWithContext).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'cron:daily_briefing', userId: 42 }),
      expect.any(Function),
    );
    expect(mockHasConnectedCalendarForUser).toHaveBeenCalledWith(42);
    expect(mockGetEvents).toHaveBeenCalledWith(expect.any(String), expect.any(String), 42);
    expect(mockGetRemindersForToday).toHaveBeenCalledWith(42, 42, 'Europe/Lisbon');
    expect(mockIsOutlookMailConfiguredForUser).toHaveBeenCalledWith(42);
    expect(mockGetUnreadCountForUser).toHaveBeenCalledWith(42);
    expect(vi.mocked(globalTodo.getAllPendingTasks)).not.toHaveBeenCalled();
    expect(vi.mocked(globalMail.getUnreadCount)).not.toHaveBeenCalled();

    expect(result.highPriorityTasks).toHaveLength(1);
    expect(result.dueTodayTasks).toHaveLength(1);
    expect(result.overdueTasks).toHaveLength(1);
    expect(result.yesterdayCompleted).toBe(2);
    expect(result.unreadEmails).toBe(5);
    expect(result.training).toContain('Strength workout');
    expect(result.reminders).toHaveLength(1);
  });

  it('buildWeeklyReviewPayloadForUser uses scoped provider and calendar reads', async () => {
    mockGetEvents.mockResolvedValue([
      { summary: 'Team sync', start: '2026-04-15T09:00:00.000Z', end: '2026-04-15T10:00:00.000Z' },
    ]);
    mockGetCompletedTasksInRange.mockResolvedValue({
      success: true,
      data: [{ id: 'done1' }, { id: 'done2' }, { id: 'done3' }],
    });
    mockGetAllPendingTasks.mockResolvedValue({
      success: true,
      data: [
        { id: 'late', title: 'Late task', listName: 'Inbox', importance: 'normal', dueDateTime: '2026-04-10T12:00:00.000Z' },
        { id: 'open', title: 'Open task', listName: 'Inbox', importance: 'normal', dueDateTime: null },
      ],
    });

    const payload = await buildWeeklyReviewPayloadForUser(42);

    expect(mockRunWithContext).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'cron:weekly_review', userId: 42 }),
      expect.any(Function),
    );
    expect(mockGetEvents).toHaveBeenCalledWith(expect.any(String), expect.any(String), 42);
    expect(payload.message).toContain('Completed: 3 tasks');
    expect(payload.message).toContain('Still pending: 2 tasks');
    expect(payload.documentJson.meetingsCount).toBe(1);
    expect(payload.documentJson.completedCount).toBe(3);
    expect(payload.documentJson.pendingCount).toBe(2);
    expect(payload.documentJson.overdueCount).toBe(1);
    expect(vi.mocked(globalTodo.getAllPendingTasks)).not.toHaveBeenCalled();
  });

  it('buildEndOfDaySummaryForUser uses scoped task reads instead of the global todo singleton', async () => {
    mockGetAllPendingTasks.mockResolvedValue({
      success: true,
      data: [
        { id: 'today', title: 'Today task', listName: 'Inbox', importance: 'normal', dueDateTime: '2026-04-17T16:00:00.000Z' },
        { id: 'late', title: 'Late task', listName: 'Inbox', importance: 'normal', dueDateTime: '2026-04-16T12:00:00.000Z' },
      ],
    });

    const payload = await buildEndOfDaySummaryForUser(42);

    expect(mockRunWithContext).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'cron:end_of_day', userId: 42 }),
      expect.any(Function),
    );
    expect(payload?.summary).toContain('due today');
    expect(payload?.summary).toContain('overdue');
    expect(payload?.documentJson.dueToday).toHaveLength(1);
    expect(payload?.documentJson.overdue).toHaveLength(1);
    expect(vi.mocked(globalTodo.getAllPendingTasks)).not.toHaveBeenCalled();
  });

  it('buildSharedListNotificationForUser seeds per-user state and then only reports new shared tasks for that tenant', async () => {
    const todayStr = new Date().toISOString().slice(0, 10);

    mockGetSharedListPendingTasks
      .mockResolvedValueOnce({
        success: true,
        data: [
          { id: 'existing', title: 'Existing shared', listName: 'Shared', dueDateTime: null },
        ],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [
          { id: 'existing', title: 'Existing shared', listName: 'Shared', dueDateTime: null },
          { id: 'self', title: 'Self-created shared', listName: 'Shared', dueDateTime: null },
          { id: 'new', title: 'New shared', listName: 'Shared', dueDateTime: `${todayStr}T10:00:00.000Z` },
        ],
      });
    mockIsSelfCreatedTask.mockImplementation((taskId: string) => taskId === 'self');

    const seeded = await buildSharedListNotificationForUser(42);
    const message = await buildSharedListNotificationForUser(42);

    expect(seeded).toBeNull();
    expect(message).toContain('Due today');
    expect(message).toContain('New shared');
    expect(message).not.toContain('Self-created shared');
    expect(mockRunWithContext).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'cron:shared_list', userId: 42 }),
      expect.any(Function),
    );
  });

  it('shared list cron creates NotificationIntent for active users without requiring Telegram', async () => {
    const todayStr = new Date().toISOString().slice(0, 10);
    const existing = { id: 'existing', title: 'Existing shared', listName: 'Shared', dueDateTime: null };
    const newTask = { id: 'new-for-ios', title: 'New shared task', listName: 'Shared', dueDateTime: `${todayStr}T10:00:00.000Z` };

    mockGetSharedListPendingTasks.mockResolvedValue({
      success: true,
      data: [existing],
    });
    await buildSharedListNotificationForUser(11);
    await buildSharedListNotificationForUser(22);

    mockGetSharedListPendingTasks.mockResolvedValue({
      success: true,
      data: [existing, newTask],
    });
    mockCreateNotificationIntent.mockClear();

    startScheduler();
    const sharedListJob = mockCronSchedule.mock.calls.find(
      (call) => (call[1] as { jobName?: string }).jobName === 'shared_list',
    )?.[1] as (() => Promise<void>) | undefined;
    expect(sharedListJob).toBeTypeOf('function');

    await sharedListJob!();

    expect(mockCreateNotificationIntent).toHaveBeenCalledWith(expect.objectContaining({
      userId: 11,
      tenantId: 11,
      sourceSkill: 'secretary',
      type: 'missed_item',
      priority: 'active',
      relatedEntityType: 'shared_task_list',
      title: 'Shared list update',
      body: 'New shared tasks need your attention.',
      sensitiveBody: expect.stringContaining('New shared task'),
      privacyPolicy: 'sensitive',
      requiresUserAction: false,
    }));
    expect(mockCreateNotificationIntent).toHaveBeenCalledWith(expect.objectContaining({
      userId: 22,
      tenantId: 22,
      sourceSkill: 'secretary',
      type: 'missed_item',
      relatedEntityType: 'shared_task_list',
    }));
  });

  it('buildConflictAlertForUser uses scoped calendar reads and only reports overlapping events', async () => {
    mockGetEvents.mockResolvedValue([
      { summary: 'Event A', start: '2026-04-18T09:00:00.000Z', end: '2026-04-18T10:00:00.000Z' },
      { summary: 'Event B', start: '2026-04-18T09:30:00.000Z', end: '2026-04-18T11:00:00.000Z' },
      { summary: 'Event C', start: '2026-04-18T12:00:00.000Z', end: '2026-04-18T13:00:00.000Z' },
    ]);

    const message = await buildConflictAlertForUser(42);

    expect(mockHasConnectedCalendarForUser).toHaveBeenCalledWith(42);
    expect(mockGetEvents).toHaveBeenCalledWith(expect.any(String), expect.any(String), 42);
    expect(message).toContain('Calendar Conflicts Tomorrow');
    expect(message).toContain('Event A');
    expect(message).toContain('Event B');
    expect(message).not.toContain('Event C');
  });

  it('conflict detection cron emits Secretary NotificationIntent even when Telegram is unavailable', async () => {
    mockGetEvents.mockResolvedValue([
      { summary: 'Event A', start: '2026-04-18T09:00:00.000Z', end: '2026-04-18T10:00:00.000Z' },
      { summary: 'Event B', start: '2026-04-18T09:30:00.000Z', end: '2026-04-18T11:00:00.000Z' },
    ]);

    startScheduler();
    const conflictJob = mockCronSchedule.mock.calls.find((call) => call[0] === '30 19 * * *')?.[1] as (() => Promise<void>) | undefined;
    expect(conflictJob).toBeTypeOf('function');

    await conflictJob!();

    expect(mockCreateNotificationIntent).toHaveBeenCalledWith(expect.objectContaining({
      userId: 11,
      tenantId: 11,
      sourceSkill: 'secretary',
      type: 'conflict_detected',
      priority: 'time_sensitive',
      privacyPolicy: 'sensitive',
      decisionDeadline: expect.any(String),
    }));
    expect(mockCreateNotificationIntent).toHaveBeenCalledWith(expect.objectContaining({
      userId: 22,
      tenantId: 22,
      sourceSkill: 'secretary',
      type: 'conflict_detected',
    }));
  });

  it('training plan adjust cron emits NotificationIntent for native users after weekly adjustment', async () => {
    mockGetActivePlan.mockReturnValue({ id: 501, name: 'Base plan', duration_weeks: 4 });
    mockGetCurrentWeek.mockReturnValue({ id: 601, week_number: 2 });
    mockGetWeeklyAdherence.mockReturnValue({
      completedSessions: 3,
      skippedSessions: 1,
      totalSessions: 4,
      adherenceRate: 75,
      avgRpe: 6,
      avgSoreness: 3,
      avgEnergy: 7,
    });
    mockComputeAdjustmentRecommendation.mockReturnValue({ adjustIntensity: 80, reason: 'Adherence dipped this week' });
    mockGetWeeksForPlan.mockReturnValue([{ id: 602, week_number: 3 }]);

    startScheduler();
    const trainingJob = mockCronSchedule.mock.calls.find((call) => call[0] === '0 19 * * 0')?.[1] as (() => Promise<void>) | undefined;
    expect(trainingJob).toBeTypeOf('function');

    await trainingJob!();

    expect(mockUpdateWeekAdjustment).toHaveBeenCalledWith(602, 80, 'Adherence dipped this week');
    expect(mockCreateNotificationIntent).toHaveBeenCalledWith(expect.objectContaining({
      userId: 22,
      tenantId: 22,
      sourceSkill: 'training',
      type: 'schedule_changed',
      priority: 'active',
      relatedEntityId: 'training-plan-adjust:501:602',
      relatedEntityType: 'training_week_adjustment',
      title: 'Training week adjusted',
      body: 'Nexus adjusted your next training week.',
      sensitiveBody: expect.stringContaining('Base plan'),
      privacyPolicy: 'health',
      requiresUserAction: false,
    }));
  });

  it('training plan renewal cron emits NotificationIntent through the orchestrator instead of direct push only', async () => {
    mockGetActivePlan.mockReturnValue({ id: 701, name: 'Race block', duration_weeks: 4 });
    mockGetCurrentWeek.mockReturnValue({ id: 801, week_number: 4 });
    mockGetWeeklyAdherence.mockReturnValue({
      completedSessions: 4,
      skippedSessions: 0,
      totalSessions: 4,
      adherenceRate: 100,
      avgRpe: 5,
      avgSoreness: 2,
      avgEnergy: 8,
    });
    mockComputeAdjustmentRecommendation.mockReturnValue({ adjustIntensity: 100, reason: 'Maintain' });
    mockGetWeeksForPlan.mockReturnValue([{ id: 801, week_number: 4 }]);

    startScheduler();
    const trainingJob = mockCronSchedule.mock.calls.find((call) => call[0] === '0 19 * * 0')?.[1] as (() => Promise<void>) | undefined;
    expect(trainingJob).toBeTypeOf('function');

    await trainingJob!();

    expect(mockCreateNotificationIntent).toHaveBeenCalledWith(expect.objectContaining({
      userId: 22,
      tenantId: 22,
      sourceSkill: 'training',
      type: 'reminder',
      priority: 'active',
      relatedEntityId: 'training-plan-renewal:701',
      relatedEntityType: 'training_plan',
      title: 'Training plan complete',
      body: 'Your training plan is complete. Open Nexus to choose what comes next.',
      sensitiveBody: expect.stringContaining('Race block'),
      privacyPolicy: 'health',
      requiresUserAction: false,
    }));
  });

  it('event backbone cron is wired through the scheduler with bounded batches and no-op skips', async () => {
    startScheduler();
    const backboneJob = mockCronSchedule.mock.calls.find((call) => call[0] === '* * * * *' && String(call[1]).includes('runEventBackboneOnce'))?.[1] as (() => Promise<unknown>) | undefined;
    expect(backboneJob).toBeTypeOf('function');

    const result = await backboneJob!();

    expect(result).toBe('skipped');
    expect(mockRunEventBackboneOnce).toHaveBeenCalledWith(expect.objectContaining({
      eventLimit: 25,
      jobLimit: 10,
      lockOwner: expect.stringMatching(/^scheduler:/),
    }));
  });

  it('event backbone cleanup runs in dry-run mode by default with configured retention', async () => {
    mockRunEventBackboneCleanup.mockReturnValue({
      apply: false,
      databasePath: '/tmp/nexus-test.db',
      retentionDays: 30,
      cutoff: '2026-04-01T00:00:00.000Z',
      targets: [{ table: 'event_outbox', exists: true, candidates: 2, protectedNewest: 0, deleted: 0 }],
    });

    startScheduler();
    const cleanupJob = mockCronSchedule.mock.calls.find((call) => call[0] === '10 0 * * *')?.[1] as (() => Promise<unknown>) | undefined;
    expect(cleanupJob).toBeTypeOf('function');

    await cleanupJob!();

    expect(mockRunEventBackboneCleanup).toHaveBeenCalledWith(expect.objectContaining({
      dbPath: '/tmp/nexus-test.db',
      apply: false,
      retentionDays: 30,
      protectNewest: 500,
    }));
  });

  it('pending chat action expiry is wired through the scheduler and skips no-op runs', async () => {
    startScheduler();
    const expiryJob = mockCronSchedule.mock.calls.find((call) => call[0] === '*/2 * * * *')?.[1] as (() => Promise<unknown>) | undefined;
    expect(expiryJob).toBeTypeOf('function');

    const result = await expiryJob!();

    expect(result).toBe('skipped');
  });

  it('sendDailyBriefing stores report documents under canonical tenant ids', async () => {
    await sendDailyBriefing();

    expect(mockStoreAndPushReport).toHaveBeenCalledTimes(2);
    expect(mockStoreAndPushReport).toHaveBeenNthCalledWith(1, expect.objectContaining({ userId: 11 }));
    expect(mockStoreAndPushReport).toHaveBeenNthCalledWith(2, expect.objectContaining({ userId: 22 }));
    expect(mockStoreAndPushReport).not.toHaveBeenCalledWith(expect.objectContaining({ userId: 1011 }));
  });

  it('sendDailyBriefing falls back to the owner bootstrap target when active users cannot be queried', async () => {
    mockGetDb.mockImplementation(() => {
      throw new Error('no users table');
    });

    await sendDailyBriefing();

    expect(mockStoreAndPushReport).toHaveBeenCalledTimes(1);
    expect(mockStoreAndPushReport).toHaveBeenCalledWith(expect.objectContaining({ userId: 99 }));
  });

  it('sendCoachBriefings generates, stores, and scopes coach state for every paid active tenant', async () => {
    mockGetActivePlan.mockReturnValue({
      id: 701,
      user_id: 11,
      tenant_id: 11,
      name: 'Coach plan',
      sport: 'gym',
      status: 'active',
    });
    mockGenerateCoachBriefing.mockResolvedValue({
      message: 'coach briefing',
      recommendations: [{
        eventId: 'event-1',
        source: 'outlook',
        action: 'MODIFY',
        originalTitle: 'Run',
        newTitle: 'Easy run',
        newStart: null,
        newEnd: null,
        summary: 'Reduce intensity',
        reason: 'Low readiness',
      }],
      errors: [],
      dataCollectionMs: 11,
      analysisMs: 22,
    });

    await sendCoachBriefings();

    expect(mockGenerateCoachBriefing).toHaveBeenCalledTimes(2);
    expect(mockGenerateCoachBriefing).toHaveBeenNthCalledWith(1, 11, {
      garminSilent: true,
      tenantId: 11,
      meteringUserId: 11,
    });
    expect(mockGenerateCoachBriefing).toHaveBeenNthCalledWith(2, 22, {
      garminSilent: true,
      tenantId: 22,
      meteringUserId: 22,
    });
    expect(mockRunWithContext).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'cron:garmin_coach', userId: 11 }),
      expect.any(Function),
    );
    expect(mockRunWithContext).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'cron:garmin_coach', userId: 22 }),
      expect.any(Function),
    );
    expect(setLastCoachState).toHaveBeenCalledWith(11, expect.any(Array), expect.any(String));
    expect(setLastCoachState).toHaveBeenCalledWith(22, expect.any(Array), expect.any(String));
    expect(addToConversation).toHaveBeenCalledWith(11, 'triathlon', 'assistant', 'coach briefing');
    expect(addToConversation).toHaveBeenCalledWith(22, 'triathlon', 'assistant', 'coach briefing');
    expect(setLastActiveDomain).toHaveBeenCalledWith(11, 'triathlon');
    expect(setLastActiveDomain).toHaveBeenCalledWith(22, 'triathlon');
    expect(mockStoreAndPushReport).toHaveBeenCalledWith(expect.objectContaining({ userId: 11, type: 'coach_briefing' }));
    expect(mockStoreAndPushReport).toHaveBeenCalledWith(expect.objectContaining({ userId: 22, type: 'coach_briefing' }));
    expect(mockStoreAndPushReport).not.toHaveBeenCalledWith(expect.objectContaining({ userId: 1011 }));
  });

  it('sendCoachBriefings skips free-plan users before generating or pushing coach reports', async () => {
    mockGetActivePlan.mockReturnValue({
      id: 701,
      user_id: 11,
      tenant_id: 11,
      name: 'Coach plan',
      sport: 'gym',
      status: 'active',
    });
    mockGetEffectiveEntitlement.mockImplementation((userId: number) => (
      userId === 22
        ? { plan: 'free', source: 'free' }
        : { plan: 'pro', source: 'stripe' }
    ));

    await sendCoachBriefings();

    expect(mockGetEffectiveEntitlement).toHaveBeenCalledWith(11);
    expect(mockGetEffectiveEntitlement).toHaveBeenCalledWith(22);
    expect(mockGenerateCoachBriefing).toHaveBeenCalledTimes(1);
    expect(mockGenerateCoachBriefing).toHaveBeenCalledWith(11, {
      garminSilent: true,
      tenantId: 11,
      meteringUserId: 11,
    });
    expect(mockGenerateCoachBriefing).not.toHaveBeenCalledWith(22, expect.anything());
    expect(mockGetActivePlan).not.toHaveBeenCalledWith(22, 22);
    expect(mockStoreAndPushReport).toHaveBeenCalledTimes(1);
    expect(mockStoreAndPushReport).toHaveBeenCalledWith(expect.objectContaining({ userId: 11, type: 'coach_briefing' }));
    expect(mockStoreAndPushReport).not.toHaveBeenCalledWith(expect.objectContaining({ userId: 22 }));
    expect(setLastCoachState).not.toHaveBeenCalledWith(22, expect.anything(), expect.anything());
    expect(addToConversation).not.toHaveBeenCalledWith(22, expect.anything(), expect.anything(), expect.anything());
    expect(setLastActiveDomain).not.toHaveBeenCalledWith(22, expect.anything());
    expect(mockCalculateReadiness).not.toHaveBeenCalledWith(22, expect.anything());
  });

  it('sendCoachBriefings requires an actual pro or max plan, not owner-only entitlement', async () => {
    mockGetActivePlan.mockReturnValue({
      id: 701,
      user_id: 11,
      tenant_id: 11,
      name: 'Coach plan',
      sport: 'gym',
      status: 'active',
    });
    mockGetEffectiveEntitlement.mockImplementation((userId: number) => (
      userId === 22
        ? { plan: 'owner', source: 'owner' }
        : { plan: 'max', source: 'apple' }
    ));

    await sendCoachBriefings();

    expect(mockGetEffectiveEntitlement).toHaveBeenCalledWith(11);
    expect(mockGetEffectiveEntitlement).toHaveBeenCalledWith(22);
    expect(mockGenerateCoachBriefing).toHaveBeenCalledTimes(1);
    expect(mockGenerateCoachBriefing).toHaveBeenCalledWith(11, {
      garminSilent: true,
      tenantId: 11,
      meteringUserId: 11,
    });
    expect(mockGenerateCoachBriefing).not.toHaveBeenCalledWith(22, expect.anything());
    expect(mockStoreAndPushReport).toHaveBeenCalledTimes(1);
    expect(mockStoreAndPushReport).toHaveBeenCalledWith(expect.objectContaining({ userId: 11, type: 'coach_briefing' }));
    expect(mockStoreAndPushReport).not.toHaveBeenCalledWith(expect.objectContaining({ userId: 22 }));
  });

  it('sendCoachBriefings does not treat a beta Max trial as a paid coach entitlement', async () => {
    mockGetActivePlan.mockReturnValue({
      id: 701,
      user_id: 11,
      tenant_id: 11,
      name: 'Coach plan',
      sport: 'gym',
      status: 'active',
    });
    mockGetEffectiveEntitlement.mockImplementation((userId: number) => (
      userId === 22
        ? { plan: 'max', source: 'beta' }
        : { plan: 'max', source: 'founder' }
    ));

    await sendCoachBriefings();

    expect(mockGenerateCoachBriefing).toHaveBeenCalledTimes(1);
    expect(mockGenerateCoachBriefing).toHaveBeenCalledWith(11, expect.objectContaining({ tenantId: 11 }));
    expect(mockGenerateCoachBriefing).not.toHaveBeenCalledWith(22, expect.anything());
    expect(mockGetActivePlan).not.toHaveBeenCalledWith(22, 22);
    expect(mockStoreAndPushReport).not.toHaveBeenCalledWith(expect.objectContaining({ userId: 22 }));
  });

  it('sendCoachBriefings skips paid users without an active workout plan before generating or pushing reports', async () => {
    mockGetEffectiveEntitlement.mockReturnValue({ plan: 'pro', source: 'stripe' });
    mockGetActivePlan.mockImplementation((userId: number) => (
      userId === 11
        ? { id: 701, user_id: 11, tenant_id: 11, name: 'Coach plan', sport: 'gym', status: 'active' }
        : null
    ));

    await sendCoachBriefings();

    expect(mockGetActivePlan).toHaveBeenCalledWith(11, 11);
    expect(mockGetActivePlan).toHaveBeenCalledWith(22, 22);
    expect(mockGenerateCoachBriefing).toHaveBeenCalledTimes(1);
    expect(mockGenerateCoachBriefing).toHaveBeenCalledWith(11, {
      garminSilent: true,
      tenantId: 11,
      meteringUserId: 11,
    });
    expect(mockGenerateCoachBriefing).not.toHaveBeenCalledWith(22, expect.anything());
    expect(mockStoreAndPushReport).toHaveBeenCalledTimes(1);
    expect(mockStoreAndPushReport).toHaveBeenCalledWith(expect.objectContaining({ userId: 11, type: 'coach_briefing' }));
    expect(mockStoreAndPushReport).not.toHaveBeenCalledWith(expect.objectContaining({ userId: 22 }));
  });
});
