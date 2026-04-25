// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';

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

vi.mock('node-cron', () => ({
  default: { schedule: vi.fn() },
}));

vi.mock('../../src/config', () => ({
  config: {
    app: { timezone: 'Europe/Lisbon' },
    todo: { digestTime: '08:00', digestEnabled: true },
    garmin: { coachTime: '21:00' },
    backup: { time: '03:00' },
    telegram: { allowedUserIds: [999001] },
  },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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
vi.mock('../../src/portal/telemetry', () => ({
  registerJob: vi.fn(),
  wrapJob: (_name: string, fn: () => unknown) => fn,
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
vi.mock('../../src/bot', () => ({ setLastActiveDomain: vi.fn() }));
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
  getUserLanguage: vi.fn(() => 'en'),
  getOwnerBootstrapTarget: (...args: unknown[]) => mockGetOwnerBootstrapTarget(...args),
}));
vi.mock('../../src/services/task-store/task-router', () => ({
  getTaskProviderForUser: (...args: unknown[]) => mockGetTaskProviderForUser(...args),
}));
vi.mock('../../src/services/database', () => ({
  getDb: (...args: unknown[]) => mockGetDb(...args),
}));
vi.mock('../../src/services/report-document-store', () => ({
  storeAndPushReport: (...args: unknown[]) => mockStoreAndPushReport(...args),
}));
vi.mock('../../src/services/training-plans', () => ({
  getActivePlans: vi.fn(() => []),
  getActivePlan: vi.fn(() => null),
  getCurrentWeek: vi.fn(),
  getSessionsForWeek: vi.fn(() => []),
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
  getActiveUserIds,
  getOwnerUserIds,
  sendCoachBriefings,
  sendDailyBriefing,
} from '../../src/services/scheduler';
import { setLastCoachState } from '../../src/domains/domain-handler';
import { setLastActiveDomain } from '../../src/bot';
import { addToConversation } from '../../src/state/conversation';

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
    mockGenerateCoachBriefing.mockResolvedValue({
      message: 'coach briefing',
      recommendations: [],
      errors: [],
      dataCollectionMs: 1,
      analysisMs: 2,
    });
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
    expect(mockGetRemindersForToday).toHaveBeenCalledWith(42);
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

  it('sendCoachBriefings generates, stores, and scopes coach state for every active tenant', async () => {
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
    expect(mockGenerateCoachBriefing).toHaveBeenNthCalledWith(1, 11);
    expect(mockGenerateCoachBriefing).toHaveBeenNthCalledWith(2, 22);
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
});
