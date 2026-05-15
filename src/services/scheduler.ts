// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import path from 'path';
import { createHash } from 'crypto';
import cron from 'node-cron';
import { Bot } from 'grammy';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getDueReminders, markReminderFired, getRemindersForToday } from '../state/reminders';
import * as msTodo from './microsoft-todo';
import type { TodoTask } from './microsoft-todo';
import { getEvents, hasConnectedCalendarForUser, isAnyCalendarConfigured } from './unified-calendar';
import { getUnreadCountForUser, isOutlookMailConfiguredForUser, isOutlookMailConfigured, getUnreadCount, sendEmail } from './outlook-mail';
import { formatDailyBriefing, DailyBriefingData, escapeHtml, splitMessage } from '../utils/telegram-formatter';
import { now, startOfDay, endOfDay, startOfWeek, endOfWeek, formatTime, formatDateTime } from '../utils/date-parser';
// content-discovery.ts still exists for manual /discover but removed from scheduler
import { collectMonthlyInvoices, formatCollectionNotification } from './invoice-collector';
import { isInvoiceFilingConfigured } from './invoice-filer';
import { collectAmazonInvoices, formatAmazonNotification, isAmazonConfigured } from './amazon-collector';
import { collectUberInvoices, formatUberNotification, isUberConfigured } from './uber-collector';
import { getFiscalCollectionSummary, isFiscalBundleDue, sendFiscalBundleNow } from './fiscal-bundle';
import { generateCoachBriefing } from './garmin-coach';
import { isGarminConfigured, keepAlive as garminKeepAlive, ensureAuthenticated as garminEnsureAuth } from './garmin';
import { registerJob, wrapJob, recordGarminRefresh, setJobFailureNotifier, setJobEnabledChecker, getJobMap, seedJobLastRunFromHistory } from '../portal/telemetry';
import { createNotificationIntent, releaseDueNotificationDeliveries } from './notification-orchestrator';
import { isCronJobEnabled } from '../skills/skill-manager';
import { CronExpressionParser } from 'cron-parser';
import { flushQueue, getPendingCount } from './invoice-queue';
import { setLastCoachState } from '../domains/domain-handler';
import { setLastActiveDomain } from '../bot';
import { addToConversation } from '../state/conversation';
import { processAllChannelScopes, seedDefaultChannels } from './channel-learner';
import { generateAndStoreTopicCandidates, generateWeeklyPackage } from './content-workflow';
import { runPipelineAgent } from '../agents/pipeline-agent';
import { runSEOAgent, seedKeywordsIfEmpty } from '../agents/seo-agent';
import { runReactionRadar } from '../agents/reaction-radar-agent';
import { runPerformanceAgent } from '../agents/performance-agent';
import { runVoiceEvolutionAgent } from '../agents/voice-evolution-agent';
import { expireStaleSignals } from './intelligence-bus';
import { seedBooksIfEmpty } from '../commands/books';
import { runAutoresearch, getScheduledTarget } from './autoresearch';
import { getPreferredDisplayNameById, getUserLanguageById } from './user-service';
import { runDatabaseBackup, weeklyRestoreTest } from './backup';
import { getDb } from './database';
import { listActiveFiscalCollectionProfiles } from '../state/fiscal-collection-profiles';
import { runWithContext } from '../utils/request-context';
import { getOwnerBootstrapTarget, getUserById } from './user-service';
import { getTaskProviderForUser } from './task-store/task-router';
import { storeAndPushReport } from './report-document-store';
import { isTelegramLegacyDeliveryEnabled } from './runtime-flags';
import { processDueOperatorAlertDeliveries, recordOperatorAlert } from './operator-alerts';
import { runEventBackboneOnce } from './event-backbone-worker';
import { runEventBackboneCleanup } from '../tools/event-backbone-cleanup';
import { expireStaleChatActionPlans } from './chat-reasoning-engine';
import { expireStalePendingChatActionsForJob } from './chat-action-state';
import { pruneCompletedChatActionRuns, reapZombieChatActionRuns } from './chat-action-run-store';
import { runGarminTenantIsolationWatcher } from './garmin-tenant-isolation-watcher';
import { runDecisionSourceStateSupersessionJob } from './decision-center';
import { getActivePlan, getCurrentWeek, getWeeklyAdherence, computeAdjustmentRecommendation, updateWeekAdjustment, getWeeksForPlan } from './training-plans';
import { calculateReadiness, persistReadinessScore } from './readiness-scorer';

interface ActiveUserTarget {
  tenantId: number;
  telegramId: number | null;
}

let remindersJobInFlight = false;

/**
 * Distinguish the expected "users table not created yet on first boot"
 * case from real DB errors (permission denied, corruption, readonly fs).
 * Previously the tenant-id helpers below swallowed every SQLite error
 * with a silent catch, which masked genuine problems (the schema looked
 * the same whether the DB was corrupt or just fresh). Now we silently
 * ignore only the boot-time migration gap and log anything else at warn
 * level so operators see the signal during boot.
 */
function isPreBootstrapTableMissing(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return typeof message === 'string' && /no such table/i.test(message);
}

function logUnexpectedTenantQueryError(fn: string, err: unknown): void {
  if (isPreBootstrapTableMissing(err)) return;
  logger.warn({ fn, err }, 'Tenant query failed with unexpected SQLite error');
}

/**
 * Get all active canonical tenant ids from the database.
 * Falls back only to the explicit owner bootstrap target when the users table
 * is unavailable, instead of fanning out across every legacy allowed Telegram id.
 */
function getActiveUserIds(): number[] {
  try {
    const db = getDb();
    const rows = db.prepare(
      "SELECT id FROM users WHERE status = 'active'"
    ).all() as { id: number }[];
    if (rows.length > 0) return rows.map((row) => row.id);
  } catch (err) {
    logUnexpectedTenantQueryError('getActiveUserIds', err);
  }

  const ownerTarget = getOwnerBootstrapTarget();
  return ownerTarget ? [ownerTarget.tenantId] : [];
}

/**
 * Get only owner-tier Telegram IDs (for admin-only notifications).
 */
function getOwnerUserIds(): number[] {
  try {
    const db = getDb();
    const rows = db.prepare(
      "SELECT telegram_id FROM users WHERE tier = 'owner' AND status = 'active'"
    ).all() as { telegram_id: number | null }[];
    if (rows.length > 0) {
      return rows
        .map((row) => row.telegram_id)
        .filter((telegramId): telegramId is number => telegramId != null);
    }
  } catch (err) {
    logUnexpectedTenantQueryError('getOwnerUserIds', err);
  }

  const ownerTarget = getOwnerBootstrapTarget();
  return ownerTarget?.telegramId != null ? [ownerTarget.telegramId] : [];
}

export { getActiveUserIds, getOwnerUserIds };

function getOwnerTenantIds(): number[] {
  try {
    const db = getDb();
    const rows = db.prepare(
      "SELECT id FROM users WHERE tier = 'owner' AND status = 'active'"
    ).all() as { id: number }[];
    if (rows.length > 0) return rows.map((row) => row.id);
  } catch (err) {
    logUnexpectedTenantQueryError('getOwnerTenantIds', err);
  }

  const ownerTarget = getOwnerBootstrapTarget();
  return ownerTarget ? [ownerTarget.tenantId] : [];
}

function getActiveUserTargets(): ActiveUserTarget[] {
  try {
    const db = getDb();
    const rows = db.prepare(
      "SELECT id, telegram_id FROM users WHERE status = 'active'"
    ).all() as { id: number; telegram_id: number | null }[];
    if (rows.length > 0) {
      return rows.map((row) => ({
        tenantId: row.id,
        telegramId: row.telegram_id ?? null,
      }));
    }
  } catch (err) {
    logUnexpectedTenantQueryError('getActiveUserTargets', err);
  }

  const ownerTarget = getOwnerBootstrapTarget();
  return ownerTarget ? [ownerTarget] : [];
}

export async function runContentTopicCronForActiveUsers(
  format: 'reel' | 'youtube',
  sourceJob: 'tuesday_reels' | 'thursday_youtube' | string,
): Promise<void> {
  for (const target of getActiveUserTargets()) {
    try {
      await runWithContext({ source: `cron:${sourceJob}`, userId: target.tenantId }, async () => {
        await generateAndStoreTopicCandidates(target.tenantId, format, sourceJob, target.tenantId);
      });
    } catch (err) {
      logger.error({ err, userId: target.tenantId, tenantId: target.tenantId, sourceJob, format }, 'Content topic cron failed');
    }
  }
}

export async function runWeeklyContentPackageCronForActiveUsers(): Promise<void> {
  for (const target of getActiveUserTargets()) {
    try {
      await runWithContext({ source: 'cron:friday_weekly', userId: target.tenantId }, async () => {
        await generateWeeklyPackage(target.tenantId, target.tenantId);
      });
    } catch (err) {
      logger.error({ err, userId: target.tenantId, tenantId: target.tenantId }, 'Friday weekly content package failed');
    }
  }
}

function buildTrainingSectionForSessions(sessions: any[]): string {
  const todaySessions = sessions.filter((s: any) => {
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    return s.day_of_week?.toLowerCase() === dayNames[new Date().getDay()];
  });

  if (todaySessions.length === 0) return '';

  const completed = todaySessions.filter((s: any) => s.status === 'completed');
  const pending = todaySessions.filter((s: any) => s.status !== 'completed' && s.status !== 'skipped');

  if (completed.length === 0 && pending.length === 0) return '';

  let trainingSection = `\n🏋️ <b>Training</b>\n`;
  for (const s of completed) {
    trainingSection += `✅ ${s.title} — completed\n`;
  }
  for (const s of pending) {
    trainingSection += `⏳ ${s.title} — not completed\n`;
  }

  const tomorrowDay = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][(new Date().getDay() + 1) % 7];
  const tomorrowSessions = sessions.filter((s: any) => s.day_of_week?.toLowerCase() === tomorrowDay);
  if (tomorrowSessions.length > 0) {
    trainingSection += `\n📅 Tomorrow: ${tomorrowSessions.map((s: any) => s.title).join(', ')}\n`;
  }

  return trainingSection;
}

export async function buildEndOfDaySummaryForUser(userId: number): Promise<{
  message: string;
  summary: string;
  documentJson: Record<string, any>;
} | null> {
  const taskProvider = getTaskProviderForUser(userId);
  const pendingResult = await runWithContext({ source: 'cron:end_of_day', userId }, async () =>
    taskProvider.getAllPendingTasks(),
  );
  if (!pendingResult.success) return null;

  const tasks = pendingResult.data;
  const todayStart = new Date(startOfDay()).getTime();
  const todayEnd = new Date(endOfDay()).getTime();

  const dueToday = tasks.filter((t: TodoTask) => {
    if (!t.dueDateTime) return false;
    const due = new Date(t.dueDateTime).getTime();
    return due >= todayStart && due <= todayEnd;
  });

  const overdue = tasks.filter((t: TodoTask) => t.dueDateTime && new Date(t.dueDateTime).getTime() < todayStart);

  let trainingSection = '';
  try {
    const tp = require('./training-plans');
    const plans = tp.getActivePlans?.(userId) || [];
    const plan = plans[0] || tp.getActivePlan(userId);
    if (plan) {
      const week = tp.getCurrentWeek(plan.id);
      if (week) {
        const sessions = tp.getSessionsForWeek(week.id);
        trainingSection = buildTrainingSectionForSessions(sessions);
      }
    }
  } catch { /* training not available — non-fatal */ }

  if (dueToday.length === 0 && overdue.length === 0 && !trainingSection) {
    return null;
  }

  let message = `🌙 <b>End-of-Day Summary</b>\n\n`;

  if (dueToday.length > 0) {
    message += `📅 <b>Due today (${dueToday.length}):</b>\n`;
    for (const t of dueToday) {
      message += `• ${escapeHtml(t.title)} <i>[${escapeHtml(t.listName)}]</i>\n`;
    }
    message += '\n';
  }

  if (overdue.length > 0) {
    message += `⚠️ <b>Overdue (${overdue.length}):</b>\n`;
    for (const t of overdue) {
      const daysLate = Math.ceil((todayStart - new Date(t.dueDateTime!).getTime()) / (1000 * 60 * 60 * 24));
      message += `• ${escapeHtml(t.title)} — ${daysLate}d late <i>[${escapeHtml(t.listName)}]</i>\n`;
    }
  }

  if (trainingSection) {
    message += trainingSection + '\n';
  }

  const summary =
    dueToday.length > 0 && overdue.length > 0
      ? `${dueToday.length} due today · ${overdue.length} overdue`
      : dueToday.length > 0
        ? `${dueToday.length} task${dueToday.length === 1 ? '' : 's'} due today`
        : overdue.length > 0
          ? `${overdue.length} overdue task${overdue.length === 1 ? '' : 's'}`
          : 'Training check-in ready';

  return {
    message: message.trim(),
    summary,
    documentJson: {
      dueToday: dueToday.map((t: TodoTask) => ({ id: t.id, title: t.title, importance: t.importance })),
      overdue: overdue.map((t: TodoTask) => ({ id: t.id, title: t.title, importance: t.importance })),
      trainingSummary: trainingSection ? trainingSection.trim() : null,
    },
  };
}

export async function buildDailyBriefingDataForUser(userId: number): Promise<DailyBriefingData> {
  const today = now();
  const data: DailyBriefingData = {
    date: today.toFormat('cccc, LLLL dd'),
    events: [],
    highPriorityTasks: [],
    dueTodayTasks: [],
    overdueTasks: [],
    reminders: [],
    unreadEmails: 0,
    yesterdayCompleted: 0,
  };

  if (hasConnectedCalendarForUser(userId)) {
    try {
      const events = await getEvents(startOfDay(), endOfDay(), userId);
      data.events = events.map((e) => ({
        summary: e.summary,
        start: e.start,
        end: e.end,
      }));
      const training = events.find((e) =>
        /gym|train|run|bike|cycling|workout|strength/i.test(e.summary)
      );
      if (training) {
        data.training = `${training.summary} at ${formatTime(training.start)}`;
      }
    } catch (err) {
      logger.error({ err, userId }, 'Failed to fetch events for briefing');
    }
  }

  try {
    const taskProvider = getTaskProviderForUser(userId);
    const [pendingResult, yesterdayResult] = await runWithContext({ source: 'cron:daily_briefing', userId }, async () =>
      Promise.all([
        taskProvider.getAllPendingTasks(),
        taskProvider.getCompletedTasksInRange(
          startOfDay(now().minus({ days: 1 })),
          endOfDay(now().minus({ days: 1 }))
        ),
      ]),
    );

    if (pendingResult.success) {
      const tasks = pendingResult.data;
      const todayStart = new Date(startOfDay()).getTime();
      const todayEnd = new Date(endOfDay()).getTime();

      data.highPriorityTasks = tasks
        .filter((t: TodoTask) => t.importance === 'high')
        .map((t: TodoTask) => ({ title: t.title, listName: t.listName, dueDateTime: t.dueDateTime, importance: t.importance }));

      data.dueTodayTasks = tasks
        .filter((t: TodoTask) => {
          if (!t.dueDateTime) return false;
          const due = new Date(t.dueDateTime).getTime();
          return due >= todayStart && due <= todayEnd;
        })
        .map((t: TodoTask) => ({ title: t.title, listName: t.listName, dueDateTime: t.dueDateTime, importance: t.importance }));

      const MAX_OVERDUE_DISPLAY = 20;
      const allOverdue = tasks
        .filter((t: TodoTask) => t.dueDateTime && new Date(t.dueDateTime).getTime() < todayStart)
        .map((t: TodoTask) => {
          const daysLate = Math.ceil((todayStart - new Date(t.dueDateTime!).getTime()) / (1000 * 60 * 60 * 24));
          return { title: t.title, listName: t.listName, dueDateTime: t.dueDateTime, importance: t.importance, daysLate };
        })
        .sort((a: { daysLate: number }, b: { daysLate: number }) => a.daysLate - b.daysLate);
      data.overdueTasks = allOverdue.slice(0, MAX_OVERDUE_DISPLAY);
      if (allOverdue.length > MAX_OVERDUE_DISPLAY) {
        data.overdueExtra = allOverdue.length - MAX_OVERDUE_DISPLAY;
      }
    }

    if (yesterdayResult.success) {
      data.yesterdayCompleted = yesterdayResult.data.length;
    }
  } catch (err) {
    logger.error({ err, userId }, 'Failed to fetch tasks for briefing');
  }

  const reminders = getRemindersForToday(userId);
  data.reminders = reminders.map((r) => ({
    message: r.message,
    time: formatTime(r.remind_at),
  }));

  if (isOutlookMailConfiguredForUser(userId)) {
    try {
      data.unreadEmails = await getUnreadCountForUser(userId);
    } catch (err) {
      logger.warn({ err, userId }, 'Daily briefing: failed to fetch Outlook unread count');
    }
  }

  if (todayNotifications.length > 0) {
    data.automatedNotifications = [...todayNotifications];
  }

  return data;
}

export async function buildWeeklyReviewPayloadForUser(userId: number): Promise<{
  message: string;
  summary: string;
  documentJson: Record<string, any>;
}> {
  let message = `<b>📊 Week in Review</b>\n`;
  message += `${now().startOf('week').toFormat('LLL dd')} - ${now().endOf('week').toFormat('LLL dd yyyy')}\n\n`;

  const taskProvider = getTaskProviderForUser(userId);
  const [todoData, calendarEvents] = await Promise.all([
    Promise.resolve(runWithContext({ source: 'cron:weekly_review', userId }, async () =>
      Promise.all([
        taskProvider.getCompletedTasksInRange(startOfWeek(), endOfWeek()),
        taskProvider.getAllPendingTasks(),
      ]),
    )).catch((err: unknown) => {
      logger.error({ err, userId }, 'Failed to fetch task data for weekly review');
      return null;
    }),
    hasConnectedCalendarForUser(userId)
      ? getEvents(startOfWeek(), endOfWeek(), userId).catch((err) => {
          logger.warn({ err, userId }, 'Weekly review: failed to fetch calendar events');
          return [] as any[];
        })
      : Promise.resolve([] as any[]),
  ]);

  if (todoData) {
    const [completedResult, pendingResult] = todoData;
    const completedCount = completedResult.success ? completedResult.data.length : 0;
    message += `✅ Completed: ${completedCount} tasks\n`;

    if (pendingResult.success) {
      message += `📋 Still pending: ${pendingResult.data.length} tasks\n`;

      const nowDate = new Date();
      const overdue = pendingResult.data.filter((t: TodoTask) => t.dueDateTime && new Date(t.dueDateTime) < nowDate);
      if (overdue.length > 0) {
        message += `\n⚠️ Overdue tasks (${overdue.length}):\n`;
        for (const t of overdue) {
          message += `- ${escapeHtml(t.title)}`;
          if (t.dueDateTime) message += ` (was due: ${formatDateTime(t.dueDateTime)})`;
          message += '\n';
        }
        message += '\nWant to reschedule or drop these?';
      }
    }
  }

  if (calendarEvents.length > 0) {
    message += `\n📅 Meetings this week: ${calendarEvents.length}\n`;
  }

  const documentJson: Record<string, any> = {
    weekStart: now().startOf('week').toISO(),
    weekEnd: now().endOf('week').toISO(),
    meetingsCount: calendarEvents.length,
  };
  if (todoData) {
    const [completedResult, pendingResult] = todoData;
    documentJson.completedCount = completedResult.success ? completedResult.data.length : 0;
    documentJson.pendingCount = pendingResult.success ? pendingResult.data.length : 0;
    if (pendingResult.success) {
      const nowDate = new Date();
      const overdue = pendingResult.data.filter((t: TodoTask) => t.dueDateTime && new Date(t.dueDateTime) < nowDate);
      documentJson.overdueCount = overdue.length;
      documentJson.overdueTasks = overdue.slice(0, 10).map((t: TodoTask) => ({
        title: t.title,
        dueDateTime: t.dueDateTime,
      }));
    }
  }

  return {
    message: message.trim(),
    summary: `${now().startOf('week').toFormat('LLL dd')} - ${now().endOf('week').toFormat('LLL dd')}`,
    documentJson,
  };
}

// Track known shared list task IDs per tenant — seeded on first run, new IDs trigger notifications
const knownSharedTaskIdsByUser = new Map<number, Set<string>>();
const sharedListSeededUsers = new Set<number>();

// Track automated notifications for the morning briefing (cleared daily at midnight)
const todayNotifications: string[] = [];
export function getTodayNotifications(): string[] { return todayNotifications; }

export function _resetSchedulerTenantStateForTesting(): void {
  knownSharedTaskIdsByUser.clear();
  sharedListSeededUsers.clear();
  todayNotifications.length = 0;
}

function getKnownSharedTaskIds(userId: number): Set<string> {
  const existing = knownSharedTaskIdsByUser.get(userId);
  if (existing) return existing;
  const created = new Set<string>();
  knownSharedTaskIdsByUser.set(userId, created);
  return created;
}

export async function buildSharedListNotificationForUser(userId: number): Promise<string | null> {
  const taskProvider = getTaskProviderForUser(userId) as {
    getSharedListPendingTasks?: () => Promise<{ success: boolean; data: TodoTask[] }>;
    isSelfCreatedTask?: (taskId: string) => boolean;
  };

  if (typeof taskProvider.getSharedListPendingTasks !== 'function') {
    return null;
  }

  const result = await runWithContext({ source: 'cron:shared_list', userId }, async () =>
    taskProvider.getSharedListPendingTasks!(),
  );
  if (!result.success) return null;

  const knownSharedTaskIds = getKnownSharedTaskIds(userId);
  const currentIds = new Set(result.data.map((t) => t.id));

  if (!sharedListSeededUsers.has(userId)) {
    for (const id of currentIds) knownSharedTaskIds.add(id);
    sharedListSeededUsers.add(userId);
    logger.info({ seededCount: currentIds.size, userId }, 'Shared list checker seeded');
    return null;
  }

  const newTasks = result.data.filter((t) => {
    if (knownSharedTaskIds.has(t.id)) return false;
    if (typeof taskProvider.isSelfCreatedTask === 'function' && taskProvider.isSelfCreatedTask(t.id)) return false;
    return true;
  });

  for (const id of currentIds) knownSharedTaskIds.add(id);
  for (const id of [...knownSharedTaskIds]) {
    if (!currentIds.has(id)) knownSharedTaskIds.delete(id);
  }

  if (newTasks.length === 0) return null;

  const todayStr = new Date().toISOString().slice(0, 10);
  const dueToday = newTasks.filter((t) => t.dueDateTime && t.dueDateTime.slice(0, 10) === todayStr);
  const otherNew = newTasks.filter((t) => !t.dueDateTime || t.dueDateTime.slice(0, 10) !== todayStr);

  let message = '';

  if (dueToday.length > 0) {
    message += `📋 <b>Due today</b> (shared)\n`;
    for (const t of dueToday) {
      message += `  ▸ ${escapeHtml(t.title)} <i>[${escapeHtml(t.listName)}]</i>\n`;
    }
  }

  if (otherNew.length > 0) {
    if (message) message += '\n';
    message += `🆕 <b>New tasks assigned</b>\n`;
    for (const t of otherNew.slice(0, 8)) {
      const due = t.dueDateTime ? ` 📅 ${t.dueDateTime.slice(0, 10)}` : '';
      message += `  ▸ ${escapeHtml(t.title)}${due} <i>[${escapeHtml(t.listName)}]</i>\n`;
    }
    if (otherNew.length > 8) message += `  ... +${otherNew.length - 8} more\n`;
  }

  return message || null;
}

function safeHtmlNotificationBody(message: string): string {
  return message
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

export async function buildConflictAlertForUser(userId: number): Promise<string | null> {
  if (!hasConnectedCalendarForUser(userId)) return null;

  const tomorrow = now().plus({ days: 1 });
  const events = await getEvents(
    tomorrow.startOf('day').toISO()!,
    tomorrow.endOf('day').toISO()!,
    userId,
  );

  if (events.length < 2) return null;

  const sorted = [...events].sort((a, b) =>
    new Date(a.start).getTime() - new Date(b.start).getTime()
  );

  const conflicts: { a: typeof sorted[0]; b: typeof sorted[0] }[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const endA = new Date(sorted[i].end).getTime();
    const startB = new Date(sorted[i + 1].start).getTime();
    if (endA > startB) {
      conflicts.push({ a: sorted[i], b: sorted[i + 1] });
    }
  }

  if (conflicts.length === 0) return null;

  let message = `⚠️ <b>Calendar Conflicts Tomorrow</b> (${tomorrow.toFormat('cccc, LLL dd')})\n\n`;
  for (const { a, b } of conflicts) {
    message += `🔴 <b>${escapeHtml(a.summary)}</b> (${formatTime(a.start)}-${formatTime(a.end)})\n`;
    message += `   overlaps with <b>${escapeHtml(b.summary)}</b> (${formatTime(b.start)}-${formatTime(b.end)})\n\n`;
  }
  message += 'Consider rescheduling one of these events.';

  return message;
}

export function startScheduler(bot?: any): void {
  // Register sub-skill gating so disabled sub-skills skip their cron jobs
  setJobEnabledChecker(isCronJobEnabled);

  // Telegram delivery is deprecated. All safeSend calls below
  // are gated: they only fire if TELEGRAM_LEGACY_DELIVERY=true AND a bot
  // instance is provided. The replacement delivery path is:
  //   - durable reports (report-document-store)
  //   - durable notifications (content-notification-store)
  //   - APNs push
  //   - portal events / telemetry
  const telegramEnabled = isTelegramLegacyDeliveryEnabled() && bot;
  const safeSend = async (userId: number, message: string, opts?: any) => {
    if (!telegramEnabled) return;
    try { await bot.api.sendMessage(userId, message, opts); } catch {}
  };

  // Register failure notifier — logs to portal telemetry (always) + Telegram (if enabled)
  setJobFailureNotifier(async (jobLabel, errorMessage) => {
    const short = errorMessage.slice(0, 120);
    recordOperatorAlert({
      severity: 'critical',
      source: 'scheduler',
      dedupeKey: `job:${jobLabel}:failed`,
      title: `${jobLabel} failed`,
      detail: short,
      owner: 'ops',
      suspectedArea: 'scheduled_jobs',
      userImpact: 'A scheduled backend workflow failed and may leave app data stale or undelivered.',
      runbookUrl: 'docs/OBSERVABILITY-ONCALL.md#scheduled-job-failures',
      metadata: {
        jobLabel,
        errorMessage: short,
      },
    });
    for (const userId of getOwnerUserIds()) {
      await safeSend(userId,
        `⚠️ <b>${escapeHtml(jobLabel)} failed</b>\n\n<code>${escapeHtml(short)}</code>\n\n<i>Check logs for details.</i>`,
        { parse_mode: 'HTML' });
    }
  });

  const tz = config.app.timezone;

  // Telegram legacy delivery gate. When TELEGRAM_LEGACY_DELIVERY is not
  // set to "true", Telegram safeSend calls are skipped for
  // report flows. The durable report + APNs path is the primary delivery.
  // Set TELEGRAM_LEGACY_DELIVERY=true to keep Telegram delivery active
  // (e.g., during beta while some users still use Telegram).
  const telegramLegacyEnabled = isTelegramLegacyDeliveryEnabled();
  const dailyCron = (() => {
    const [h, m] = config.todo.digestTime.split(':').map(Number);
    return `${m ?? 0} ${h ?? 8} * * *`;
  })();
  const coachCron = (() => {
    const [h, m] = config.garmin.coachTime.split(':').map(Number);
    return `${m ?? 0} ${h ?? 21} * * *`;
  })();
  const backupCron = (() => {
    const [h, m] = config.backup.time.split(':').map(Number);
    return `${m ?? 0} ${h ?? 3} * * *`;
  })();

  // ── Register all jobs for portal tracking ──────────────────────────
  registerJob('reminders',          'Reminders',             '* * * * *',       'secretary');
  registerJob('end_of_day',         'End-of-Day Summary',    '0 21 * * *',      'secretary');
  registerJob('daily_briefing',     'Morning Briefing',      dailyCron,         'secretary');
  registerJob('weekly_review',      'Weekly Review',         '0 17 * * 5',      'secretary');
  registerJob('shared_list',        'Shared List Check',     '*/5 * * * *',     'secretary');
  registerJob('midnight_cleanup',   'Midnight Cleanup',      '0 0 * * *',       'system');
  // content_discovery removed — replaced by content-workflow (tue/thu/fri topic candidates)
  registerJob('invoice_collection', 'Invoice Collection',    '0 9 1 * *',       'invoices');
  registerJob('fiscal_bundle',      'Fiscal Bundle Delivery','10 8 * * *',      'invoices');
  registerJob('amazon_collection',  'Amazon Collection',     '15 9 1 * *',      'invoices');
  registerJob('uber_collection',    'Uber Collection',       '30 9 1 * *',      'invoices');
  registerJob('fossa_email',        'Fossa Email',           '30 7 * * 1',      'secretary');
  registerJob('conflict_detection', 'Conflict Detection',    '30 19 * * *',     'secretary');
  registerJob('secretary_agenda_sync', 'Secretary Agenda → Calendar Sync', '*/5 * * * *', 'secretary');
  registerJob('garmin_keepalive',   'Garmin Keep-Alive',     '*/30 * * * *',    'triathlon');
  registerJob('garmin_coach',       'Garmin Coach',          coachCron,         'triathlon');
  registerJob('garmin_tenant_isolation_watcher', 'Garmin Tenant Isolation Watcher', '45 6 * * *', 'triathlon');
  registerJob('invoice_queue',      'Invoice Queue Flush',   '*/15 * * * *',    'invoices');
  registerJob('channel_relearn',   'Channel Re-Learn',      '0 3 * * 0',       'content');
  registerJob('tuesday_reels',     'Tuesday Reel Topics',   '0 9 * * 2',       'content');
  registerJob('thursday_youtube',  'Thursday YT Topic',     '0 9 * * 4',       'content');
  registerJob('friday_weekly',     'Friday Weekly Package',  '30 18 * * 5',     'content');
  registerJob('pipeline_agent',   'Pipeline Tracker',       '0 20 * * *',      'content');
  registerJob('performance_agent','Performance Intel',        '0 6 * * 0',       'content');
  registerJob('voice_evolution', 'Voice Evolution',          '0 4 1 * *',       'content');
  registerJob('reaction_radar',   'Reaction Radar',          '0 8,14,20 * * *', 'content');
  registerJob('seo_agent',        'SEO Tracking',           '0 6 * * 1',       'content');
  registerJob('expire_signals',   'Signal Cleanup',         '0 * * * *',       'content');
  registerJob('integration_health', 'Integration Health Probes', '*/5 * * * *', 'system');
  registerJob('training_plan_adjust', 'Training Plan Auto-Adjust', '0 19 * * 0', 'triathlon');
  registerJob('autoresearch',     'Autoresearch',           '0 1 * * 0',       'system');
  registerJob('db_backup',        'Database Backup',        backupCron,        'system');
  registerJob('db_restore_test', 'Weekly Restore Test',   '0 4 * * 0',       'system');
  registerJob('task_sync',        'Task Provider Sync',     '*/15 * * * *',    'system');
  registerJob('daily_context',    'Daily Context Builder',  '0 5 * * *',       'system');
  registerJob('operator_alert_delivery', 'Operator Alert Delivery', '* * * * *', 'system');
  registerJob('decision_source_supersession', 'Decision Source Supersession', '*/15 * * * *', 'system');
  registerJob('chat_action_plan_expiry', 'Chat Action Plan Expiry', '15 * * * *', 'system');
  registerJob('event_backbone_worker', 'Event Backbone Worker', '* * * * *', 'system');
  registerJob('event_backbone_cleanup', 'Event Backbone Cleanup', '10 0 * * *', 'system');

  // Seed lastRunAt from DB so the DST watchdog doesn't re-fire jobs after a restart
  seedJobLastRunFromHistory();

  // ── Reminder checker (every minute) ────────────────────────────────
  // Fast-path: getDueReminders() is a single indexed SELECT. If it returns
  // an empty array (the common case when there are no active reminders),
  // we return 'skipped' so wrapJob does NOT persist a job_history row.
  // This eliminates ~6,700 wasted rows/week observed in production at 1
  // active user — see audit P0-2.
  cron.schedule('* * * * *', wrapJob('reminders', async () => {
    if (remindersJobInFlight) {
      logger.warn({ job: 'reminders' }, 'Skipping reminder cron tick because previous tick is still running');
      return 'skipped';
    }

    remindersJobInFlight = true;
    try {
      const dueReminders = getDueReminders();
      if (dueReminders.length === 0) return 'skipped';
      for (const reminder of dueReminders) {
        const targetUserId = (reminder as any).user_id as number;
        try {
          let msg = `⏰ <b>Reminder:</b> ${escapeHtml(reminder.message)}`;
          if (reminder.recurring) msg += `\n<i>(Recurring: ${reminder.recurring})</i>`;
          await safeSend(targetUserId, msg, { parse_mode: 'HTML' });
        } catch (err) {
          logger.error({ err, userId: targetUserId }, 'Failed to send reminder');
        }
        // Parallel iOS notification. The Secretary Notification Orchestrator
        // decides push vs in-app vs quiet-hours/digest; scheduler only emits
        // the intent.
        await createNotificationIntent({
          userId: targetUserId,
          tenantId: targetUserId,
          sourceSkill: 'secretary',
          type: 'reminder',
          priority: 'active',
          relatedEntityId: reminder.id,
          relatedEntityType: 'reminder',
          title: 'Reminder',
          body: reminder.message,
          sensitiveBody: reminder.message,
          actionButtons: [
            { id: 'mark_done', label: 'Done', style: 'primary' },
            { id: 'snooze', label: 'Snooze', style: 'secondary' },
          ],
          deeplink: `nexus://notifications/reminder-${reminder.id}`,
          dedupeKey: `secretary:reminder:${targetUserId}:${reminder.id}`,
          privacyPolicy: 'sensitive',
        });
        markReminderFired(reminder.id);
      }
    } finally {
      remindersJobInFlight = false;
    }
  }));

  // ── End-of-day task summary (21:00) ────────────────────────────────
  cron.schedule('0 21 * * *', wrapJob('end_of_day', async () => {
    for (const target of getActiveUserTargets()) {
      const report = await buildEndOfDaySummaryForUser(target.tenantId);
      if (!report) continue;

      // Store durable evening report
      try {
        await storeAndPushReport({
          userId: target.tenantId,
          type: 'evening_summary' as const,
          title: 'End-of-day summary',
          summary: report.summary,
          documentJson: report.documentJson,
          sourceJob: 'end_of_day',
          pushCategory: 'evening_summary',
        });
      } catch (err) {
        logger.debug({ err, userId: target.tenantId }, 'Failed to store evening summary report (non-fatal)');
      }

      // Legacy Telegram delivery (gated by TELEGRAM_LEGACY_DELIVERY env)
      if (telegramLegacyEnabled && target.telegramId) {
        try {
          await safeSend(target.telegramId, report.message, { parse_mode: 'HTML' });
        } catch (err) {
          logger.error({ err, userId: target.telegramId, tenantId: target.tenantId }, 'Failed to send end-of-day summary');
        }
      }
    }
  }), { timezone: tz });

  // ── Daily briefing (configurable time) ─────────────────────────────
  //
  // sendDailyBriefing internally calls storeAndPushReport, which stores
  // the durable report AND sends a push whose payload carries the
  // routable `reportId`. iOS uses that id to deep-link into the
  // briefing detail on notification tap. A prior terse push was sent
  // here as a second notification — that path emitted a duplicate
  // without reportId, so the tap landed on Home instead of the
  // briefing. Removed to leave a single, deep-linkable push per run.
  cron.schedule(dailyCron, wrapJob('daily_briefing', async () => {
    if (!config.todo.digestEnabled) return;
    await sendDailyBriefing(bot);
  }), { timezone: tz });

  // ── Weekly review (Friday 17:00) ───────────────────────────────────
  //
  // Same shape as daily_briefing: sendWeeklyReview already pushes via
  // storeAndPushReport with the reportId. The duplicate terse push
  // that used to live here has been removed.
  cron.schedule('0 17 * * 5', wrapJob('weekly_review', async () => {
    await sendWeeklyReview(bot);
  }), { timezone: tz });

  // ── Shared list task notifications (every 5 min) ───────────────────
  cron.schedule('*/5 * * * *', wrapJob('shared_list', async () => {
    const { hour: currentHour, minute: currentMinute } = now();
    if ((currentHour >= 22 || currentHour < 7) && currentMinute % 15 !== 0) return;

    for (const target of getActiveUserTargets()) {
      const message = await buildSharedListNotificationForUser(target.tenantId);
      if (!message) continue;

      const signature = createHash('sha256').update(message).digest('hex').slice(0, 16);
      try {
        await createNotificationIntent({
          userId: target.tenantId,
          tenantId: target.tenantId,
          sourceSkill: 'secretary',
          type: 'missed_item',
          priority: 'active',
          relatedEntityId: `shared-list:${target.tenantId}:${signature}`,
          relatedEntityType: 'shared_task_list',
          title: 'Shared list update',
          body: 'New shared tasks need your attention.',
          sensitiveBody: safeHtmlNotificationBody(message),
          actionButtons: [{ id: 'open_detail', label: 'Open tasks', style: 'primary' }],
          deeplink: 'nexus://notifications/shared-list',
          quietHoursPolicy: 'respect',
          dedupeKey: `secretary:shared_list:${target.tenantId}:${startOfDay(now())}:${signature}`,
          requiresUserAction: false,
          deliveryPolicy: 'auto',
          privacyPolicy: 'sensitive',
        });
      } catch (err) {
        logger.error({ err, tenantId: target.tenantId }, 'Failed to create shared list notification intent');
      }

      if (target.telegramId) {
        try {
          await safeSend(target.telegramId, message, { parse_mode: 'HTML' });
        } catch (err) {
          logger.error({ err, userId: target.telegramId, tenantId: target.tenantId }, 'Failed to send shared list notification');
        }
      }
    }
  }), { timezone: tz });

  // ── Midnight cleanup ───────────────────────────────────────────────
  // Also runs the audit-recommended retention policies (Weeks 2-4):
  //   - video_transcripts > 90 days  (was 57% of DB size; uncapped growth)
  //   - job_history > 30 days        (35K+ rows at 1 user; ~5K/day)
  //   - error_log > 60 days          (small but bounded for safety)
  //   - client_errors > 90 days      (mirror of error_log retention)
  // Each DELETE runs in its own try/catch so a failure on one table
  // doesn't block the others. Row counts are logged for visibility.
  cron.schedule('0 0 * * *', wrapJob('midnight_cleanup', async () => {
    msTodo.clearSelfCreatedTasks();
    todayNotifications.length = 0;
    logger.info('Cleared self-created task cache and daily notifications');

    const retentionTargets: Array<{ table: string; days: number; tsCol: string }> = [
      { table: 'video_transcripts', days: 90, tsCol: 'created_at' },
      { table: 'job_history',       days: 30, tsCol: 'ts' },
      { table: 'error_log',         days: 60, tsCol: 'ts' },
      { table: 'client_errors',     days: 90, tsCol: 'ts' },
      { table: 'api_usage',         days: 180, tsCol: 'ts' },
      { table: 'email_log',         days: 60, tsCol: 'ts' },
    ];
    for (const { table, days, tsCol } of retentionTargets) {
      try {
        const { getDb } = require('./database');
        const db = getDb();
        const result = db
          .prepare(`DELETE FROM ${table} WHERE ${tsCol} < datetime('now', '-' || ? || ' days')`)
          .run(days);
        if (result.changes > 0) {
          logger.info({ table, days, deleted: result.changes }, 'Retention cleanup');
        }
      } catch (err) {
        // Table may not exist yet (older deploys); also catches column-name
        // typos so they show up in logs instead of silently dropping rows.
        logger.warn({ err, table }, 'Retention cleanup failed for table');
      }
    }

    // ── audit_trail: partial retention (Phase 0.C) ─────────────────
    // User-meaningful audit rows (action='export','delete','login', etc)
    // are kept for 180 days for GDPR compliance. The noisy machine-generated
    // decrypt rows (from oauth-store.getTokens) are trimmed aggressively
    // at 30 days because they're high-volume and low forensic value beyond
    // "something accessed this token". The partial index from migration
    // 044 makes the DELETE fast. See migrations/044_audit_trail_retention.sql
    // for the full rationale.
    try {
      const { getDb } = require('./database');
      const db = getDb();
      const decryptResult = db
        .prepare(`DELETE FROM audit_trail WHERE action = 'decrypt' AND resource LIKE 'oauth.%' AND ts < datetime('now', '-30 days')`)
        .run();
      if (decryptResult.changes > 0) {
        logger.info({ deleted: decryptResult.changes }, 'Retention cleanup: audit_trail decrypt rows');
      }
      const otherResult = db
        .prepare(`DELETE FROM audit_trail WHERE action != 'decrypt' AND ts < datetime('now', '-180 days')`)
        .run();
      if (otherResult.changes > 0) {
        logger.info({ deleted: otherResult.changes }, 'Retention cleanup: audit_trail non-decrypt rows');
      }
    } catch (err) {
      logger.warn({ err }, 'Retention cleanup failed for audit_trail');
    }
  }), { timezone: tz });

  // ── Unified task store: per-provider sync (every 15 min) ───────────
  // Pulls from all registered TaskProviderAdapters for every active user.
  // Webhook-enabled providers (Todoist) trigger immediate syncs on their
  // own; this 15-min cron is the catchup safety net for missed webhooks
  // and the sole sync mechanism for polling providers (Notion, MS To Do).
  // The sync engine itself short-circuits disconnected adapters cheaply,
  // so this is safe even when most users have zero providers connected.
  cron.schedule('*/15 * * * *', wrapJob('task_sync', async () => {
    try {
      const { syncAllProviders } = require('./task-store/sync-engine');
      const users = getActiveUserIds();
      if (users.length === 0) return 'skipped';

      // Parallelize per-user sync with a concurrency bound. The previous
      // sequential loop (for...of + await) was O(N × per-user-latency) —
      // at 100 users × ~5s/sync × 96 runs/day = 13 hours/day of bot time
      // just on task_sync. Promise.allSettled with a 5-wide semaphore
      // collapses that to O(N/5 × per-user-latency) while avoiding the
      // "all 100 users hammer Todoist/Notion simultaneously" failure mode
      // that pure Promise.all would produce. Each user's failure is
      // isolated by the inner try/catch — allSettled confirms none of
      // them throw out of the settled result. Audit Month 2 #2.
      const CONCURRENCY = 5;
      let upsertedTotal = 0;
      for (let i = 0; i < users.length; i += CONCURRENCY) {
        const batch = users.slice(i, i + CONCURRENCY);
        const settled = await Promise.allSettled(
          batch.map(async (userId) => {
            try {
              const results = await syncAllProviders(userId);
              const upserted = results.reduce((s: number, r: any) => s + (r.tasksUpserted || 0), 0);
              return { userId, upserted, providers: results.length };
            } catch (err) {
              logger.warn({ err, userId }, 'Task sync failed for user');
              return { userId, upserted: 0, providers: 0 };
            }
          }),
        );
        for (const s of settled) {
          if (s.status === 'fulfilled') {
            upsertedTotal += s.value.upserted;
            if (s.value.upserted > 0) {
              logger.debug(s.value, 'Task sync completed');
            }
          }
          // Rejected results are impossible because the inner try/catch
          // converts all throws to { upserted: 0 } — but log defensively.
          else {
            logger.warn({ reason: s.reason }, 'Task sync batch rejection');
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Task sync cron failed (sync engine may not be loaded yet)');
    }
  }), { timezone: tz });

  // ── Secretary agenda → calendar sync (every 5 min) ────────────────
  // Closes the orphaned-selectedSlot gap: arbitrator persists an agenda item
  // with selectedSlot but no cron previously pushed it to Google/Outlook.
  // Per-user fan-out picks the user's connected calendar source(s) via
  // hasConnectedCalendarForUser; runs the unified-calendar adapter against
  // the agenda store. Wave 1 batch cap is 50 items/user/run with the
  // existing provider_sync_state state machine (see
  // secretary-agenda-provider-sync.ts:97 for the state enum). Outlook
  // rate limits aggressively, so retry budget is per-item not per-tick.
  // Wave 2 escalation: raise to */15 + isCronJobEnabled gate if 429s spike.
  cron.schedule('*/5 * * * *', wrapJob('secretary_agenda_sync', async () => {
    try {
      const { syncSecretaryAgendaItemsToProvider } = require('./secretary-agenda-provider-sync');
      const { createUnifiedCalendarSecretaryProviderAdapter } = require('./secretary-unified-calendar-provider-adapter');
      const googleCal = require('./google-calendar');
      const outlookCal = require('./outlook-calendar');
      const users = getActiveUserIds();
      if (users.length === 0) return 'skipped';

      const PER_USER_CAP = 50;
      const CONCURRENCY = 4;
      let syncedTotal = 0;
      let readbackFailedTotal = 0;

      // Per-user fan-out with bounded concurrency. Outlook + Google rate-limit
      // at the request layer (429 with Retry-After), so we keep concurrency low.
      // Each user's failure is isolated by the inner try/catch.
      for (let i = 0; i < users.length; i += CONCURRENCY) {
        const batch = users.slice(i, i + CONCURRENCY);
        const settled = await Promise.allSettled(
          batch.map(async (userId) => {
            const sources: Array<'google' | 'outlook'> = [];
            if (googleCal.isGoogleCalendarConfigured(userId)) sources.push('google');
            if (outlookCal.isOutlookCalendarConfigured(userId)) sources.push('outlook');
            if (sources.length === 0) return { userId, synced: 0, readbackFailed: 0, skipped: true };

            let userSynced = 0;
            let userReadbackFailed = 0;
            for (const source of sources) {
              try {
                const adapter = createUnifiedCalendarSecretaryProviderAdapter(source);
                const results = await syncSecretaryAgendaItemsToProvider(
                  { ownerUserId: userId, tenantId: userId, includeInactive: false },
                  adapter,
                );
                // Bound the work this tick: take at most PER_USER_CAP results.
                // Remaining items will be picked up next tick because
                // `provider_sync_state` filtering inside the sync function
                // already short-circuits already-synced rows.
                const bounded = results.slice(0, PER_USER_CAP);
                for (const r of bounded) {
                  if (r.providerSyncState === 'synced') userSynced += 1;
                  if (r.providerSyncState === 'readback_failed') userReadbackFailed += 1;
                }
              } catch (err) {
                logger.warn({ err, userId, source }, '[scheduler] secretary_agenda_sync per-user/source failure');
              }
            }
            return { userId, synced: userSynced, readbackFailed: userReadbackFailed };
          }),
        );
        for (const s of settled) {
          if (s.status === 'fulfilled' && !s.value.skipped) {
            syncedTotal += s.value.synced;
            readbackFailedTotal += s.value.readbackFailed;
          } else if (s.status === 'rejected') {
            logger.warn({ reason: s.reason }, '[scheduler] secretary_agenda_sync batch rejection');
          }
        }
      }
      if (syncedTotal > 0 || readbackFailedTotal > 0) {
        logger.info({ syncedTotal, readbackFailedTotal, userCount: users.length }, '[scheduler] secretary_agenda_sync complete');
      }
    } catch (err) {
      logger.warn({ err }, '[scheduler] secretary_agenda_sync cron failed');
    }
  }), { timezone: tz });

  // ── Daily cross-domain context builder (5 AM local) ────────────────
  // Pre-builds the ~500-token cross-domain summary that gets injected into
  // every AI call as system context. Running at 5 AM means the morning
  // briefing (which fires at config.todo.digestTime, usually 6-7 AM) and
  // every subsequent message that day reads from a freshly-built cache,
  // saving ~1300 tokens of speculative tool calls per AI message.
  cron.schedule('0 5 * * *', wrapJob('daily_context', async () => {
    try {
      const { buildContextForAllUsers } = require('./context-engine');
      const userIds = getActiveUserIds();
      const stats = await buildContextForAllUsers(userIds);
      logger.info({ ...stats, total: userIds.length }, 'Daily context build complete');
    } catch (err) {
      logger.warn({ err }, 'Daily context cron failed');
    }
  }), { timezone: tz });

  // Old content_discovery (16:43) removed — replaced by content-workflow (Tue/Thu/Fri)

  // ── Monthly invoice collection (1st at 09:00) ─────────────────────
  cron.schedule('0 9 1 * *', wrapJob('invoice_collection', async () => {
    if (!config.invoices.monthlyCollectionEnabled || !isInvoiceFilingConfigured()) return;

    const prev = now().minus({ months: 1 });
    const ownerTenantIds = getOwnerTenantIds();
    for (const tenantId of ownerTenantIds) {
      const result = await collectMonthlyInvoices(tenantId, prev.year, prev.month);
      const notification = formatCollectionNotification(result);
      const ownerTelegramId = getUserById(tenantId)?.telegram_id;
      if (!ownerTelegramId) continue;
      try {
        await safeSend(ownerTelegramId, notification, { parse_mode: 'HTML' });
      } catch (err) {
        logger.error({ err, userId: ownerTelegramId, tenantId }, 'Failed to send invoice collection notification');
      }
    }
  }), { timezone: tz });

  // ── Fiscal bundle delivery (daily 08:10, per-user due-day check) ──
  cron.schedule('10 8 * * *', wrapJob('fiscal_bundle', async () => {
    const profiles = listActiveFiscalCollectionProfiles();
    if (profiles.length === 0) return 'skipped';

    let dueCount = 0;
    const failures: Array<{ userId: number; message: string }> = [];

    for (const profile of profiles) {
      if (!isFiscalBundleDue(profile)) continue;
      dueCount += 1;

      const summary = getFiscalCollectionSummary(profile.user_id);
      const blockingWarnings = new Set([
        'DESTINATION_EMAIL_MISSING',
        'NO_MAIL_PROVIDER_CONNECTED',
        'BUNDLE_DELIVERY_NOT_CONFIGURED',
      ]);
      if (summary.warnings.some((warning) => blockingWarnings.has(warning))) {
        logger.info(
          { userId: profile.user_id, warnings: summary.warnings },
          'Skipping fiscal bundle cron — profile is not deliverable yet',
        );
        continue;
      }

      try {
        const result = await runWithContext(
          { source: 'cron:fiscal_bundle', userId: profile.user_id },
          () => sendFiscalBundleNow(profile.user_id),
        );
        logger.info({
          userId: profile.user_id,
          destinationEmail: result.destinationEmail,
          totalDocuments: result.totalDocuments,
          totalMatchedEmails: result.totalMatchedEmails,
        }, 'Fiscal bundle sent from scheduled cron');
      } catch (err: any) {
        const message = err?.message || 'unknown error';
        failures.push({ userId: profile.user_id, message });
        logger.error({ err, userId: profile.user_id }, 'Fiscal bundle cron failed');
      }
    }

    if (dueCount === 0) return 'skipped';
    if (failures.length > 0) {
      const detail = failures.map((failure) => `${failure.userId}:${failure.message}`).join('; ');
      throw new Error(`Fiscal bundle delivery failed for ${failures.length} user(s): ${detail}`);
    }
  }), { timezone: tz });

  // ── Amazon collection (1st at 09:15) ──────────────────────────────
  cron.schedule('15 9 1 * *', wrapJob('amazon_collection', async () => {
    if (!config.invoices.amazonEnabled || !isAmazonConfigured() || !isInvoiceFilingConfigured()) return;

    const prev = now().minus({ months: 1 });
    const ownerTenantIds = getOwnerTenantIds();
    for (const tenantId of ownerTenantIds) {
      const result = await collectAmazonInvoices(tenantId, prev.year, prev.month);
      const notification = formatAmazonNotification(result);
      const ownerTelegramId = getUserById(tenantId)?.telegram_id;
      if (!ownerTelegramId) continue;
      try {
        await safeSend(ownerTelegramId, notification, { parse_mode: 'HTML' });
      } catch (err) {
        logger.error({ err, userId: ownerTelegramId, tenantId }, 'Failed to send Amazon collection notification');
      }
    }
  }), { timezone: tz });

  // ── Uber collection (1st at 09:30) ────────────────────────────────
  cron.schedule('30 9 1 * *', wrapJob('uber_collection', async () => {
    if (!config.invoices.uberEnabled || !isUberConfigured() || !isInvoiceFilingConfigured()) return;

    const prev = now().minus({ months: 1 });
    const ownerTenantIds = getOwnerTenantIds();
    for (const tenantId of ownerTenantIds) {
      const result = await collectUberInvoices(tenantId, prev.year, prev.month);
      const notification = formatUberNotification(result);
      const ownerTelegramId = getUserById(tenantId)?.telegram_id;
      if (!ownerTelegramId) continue;
      try {
        await safeSend(ownerTelegramId, notification, { parse_mode: 'HTML' });
      } catch (err) {
        logger.error({ err, userId: ownerTelegramId, tenantId }, 'Failed to send Uber collection notification');
      }
    }
  }), { timezone: tz });

  // ── Bi-weekly fossa email (Monday 07:30) ───────────────────────────
  // Identity-safety: this cron sends a single-tenant home-services request
  // with literal owner PII (full name, address, phone, account number).
  // Gate behind an explicit FOSSA_EMAIL_ENABLED=1 env flag in addition to
  // OUTLOOK availability so a different tenant configuring Outlook does
  // NOT inherit this owner-specific automation.
  const fossaTo = process.env.FOSSA_EMAIL_TO || 'smas.fossas@mun-montijo.pt';
  const fossaEnabled = (process.env.FOSSA_EMAIL_ENABLED || '').trim() === '1';
  if (fossaEnabled && isOutlookMailConfigured()) {
    cron.schedule('30 7 * * 1', wrapJob('fossa_email', async () => {
      const today = now();
      const refDate = today.set({ year: 2026, month: 3, day: 23, hour: 0, minute: 0, second: 0, millisecond: 0 });
      const daysDiff = Math.round(today.diff(refDate, 'days').days);
      const weeksDiff = Math.floor(daysDiff / 7);
      if (weeksDiff % 2 !== 0) {
        logger.info({ weeksDiff }, 'Fossa email: skipping — not a send week');
        return;
      }

      await sendEmail({
        to: fossaTo,
        subject: 'Limpeza Fossa Septica',
        body: `Exmos. Senhores,\nVenho por este meio solicitar a limpeza da fossa séptica do seguinte imóvel:\n\nMorada: Rua José Quendera Miranda L4, 2870-684 Alto-Estanqueiro/Jardia\nNome: Felipe Dominguez Rodriguez Ferreira\nNúmero de Cliente: 3895417\nTelefone: 912 874 680\n\nAgradeço, por favor, que me informem sobre a disponibilidade para a realização do serviço.\n\nCom os melhores cumprimentos,\nFelipe Dominguez`,
        source: 'fossa_email',
      });

      todayNotifications.push(`📧 Email automático "Limpeza Fossa Séptica" enviado para ${fossaTo}`);
      logger.info({ to: fossaTo }, 'Fossa email sent successfully');

      for (const userId of getOwnerUserIds()) {
        try {
          await safeSend(userId,
            `📧 <b>Email automático enviado</b>\n\n<b>Para:</b> ${fossaTo}\n<b>Assunto:</b> Limpeza Fossa Septica\n\n<i>Próximo envio em 2 semanas.</i>`,
            { parse_mode: 'HTML' });
        } catch (err) {
          logger.error({ err, userId }, 'Failed to send fossa email notification');
        }
      }
    }), { timezone: tz });
  }

  // ── Conflict detection (19:30) ─────────────────────────────────────
  cron.schedule('30 19 * * *', wrapJob('conflict_detection', async () => {
    for (const target of getActiveUserTargets()) {
      const message = await buildConflictAlertForUser(target.tenantId);
      if (!message) continue;

      const conflictSignature = createHash('sha256')
        .update(message.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
        .digest('hex')
        .slice(0, 16);

      try {
        await createNotificationIntent({
          userId: target.tenantId,
          tenantId: target.tenantId,
          sourceSkill: 'secretary',
          type: 'conflict_detected',
          priority: 'time_sensitive',
          relatedEntityId: `conflict-detection-${startOfDay()}-${conflictSignature}`,
          relatedEntityType: 'calendar_conflict',
          title: 'Schedule conflict detected',
          body: 'Schedule conflict needs review.',
          sensitiveBody: message.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
          actionButtons: [
            { id: 'open_detail', label: 'Review', style: 'primary' },
          ],
          deeplink: 'nexus://secretary/conflict/daily',
          dedupeKey: `secretary:conflict_detection:${target.tenantId}:${startOfDay()}:${conflictSignature}`,
          requiresUserAction: true,
          quietHoursPolicy: 'allow_time_sensitive',
          privacyPolicy: 'sensitive',
        });
      } catch (err) {
        logger.warn({ err, tenantId: target.tenantId }, 'Conflict notification intent emit failed');
      }

      if (!target.telegramId) continue;
      try {
        await safeSend(target.telegramId, message, { parse_mode: 'HTML' });
      } catch (err) {
        logger.error({ err, userId: target.telegramId, tenantId: target.tenantId }, 'Failed to send conflict alert');
      }
    }
  }), { timezone: tz });

  // ── Garmin keep-alive (every 30 min) ───────────────────────────────
  if (isGarminConfigured()) {
    cron.schedule('5,35 * * * *', wrapJob('garmin_keepalive', async () => {
      const ok = await garminKeepAlive();
      recordGarminRefresh(ok);
      if (!ok) {
        throw new Error('All refresh attempts failed — session may be dead');
      }
    }), { timezone: tz });

    // Immediate keepalive on startup — closes the 30-minute gap between
    // server restart and the first cron tick. Without this, a cron job
    // (coach briefing, training plan adjust) could fire during the gap
    // with expired tokens, triggering a full re-login → MFA email.
    // Runs in silent mode so a dead session doesn't send an MFA email.
    setTimeout(async () => {
      try {
        // Set silent mode so even if keepAlive somehow triggers a
        // recovery path, it won't send an MFA email.
        const { setSilentMode } = require('./garmin');
        setSilentMode(true);
        logger.info('Garmin: startup keepalive — refreshing tokens immediately (silent mode)');
        const ok = await garminKeepAlive();
        recordGarminRefresh(ok);
        if (ok) {
          logger.info('Garmin: startup keepalive successful — session is live');
        } else {
          logger.warn('Garmin: startup keepalive failed — session may be dead (no MFA triggered, silent mode)');
        }
      } catch (err) {
        logger.warn({ err }, 'Garmin: startup keepalive error (non-fatal)');
      } finally {
        const { setSilentMode } = require('./garmin');
        setSilentMode(false);
      }
    }, 5000); // 5s delay to let other services initialize first
  }

  // ── Garmin coach briefing (configurable time) ──────────────────────
  if (config.garmin.coachEnabled) {
    cron.schedule(coachCron, wrapJob('garmin_coach', async () => {
      if (isGarminConfigured()) {
        logger.info('Daily coach briefing starting — pre-authenticating Garmin (silent mode — no MFA email if session is dead)');
        // Silent mode: cron has no interactive user to answer an MFA
        // code, so the recovery path must skip full re-login. If tokens
        // are too stale even for OAuth2 refresh, the briefing runs with
        // data gaps (logged as a warning) and the next user-initiated
        // call will recover interactively. Fixes the daily Garmin
        // passcode email that was landing in Felipe's inbox.
        const authed = await garminEnsureAuth({ silent: true });
        if (!authed) {
          logger.warn('Coach briefing: Garmin session unrecoverable in silent mode — proceeding with whatever cached/partial data the briefing can assemble');
        }
      } else {
        logger.info('Daily coach briefing starting without global Garmin; users with Apple Health or other wearable data can still receive scoped briefings');
      }
      await sendCoachBriefings(bot);
    }), { timezone: tz });
  }

  // ── Training Plan weekly auto-adjust (Sunday 19:00) ─────────────────
  cron.schedule('0 19 * * 0', wrapJob('training_plan_adjust', async () => {
    // ── Pre-authenticate Garmin silently BEFORE touching any Garmin API ──
    //
    // The cron has no interactive user to answer an MFA code, so the
    // recovery path inside `ensureAuthenticated` must skip full re-login
    // — otherwise the garth library triggers `loginWithMfa` which sends
    // a security passcode email to Felipe's inbox every Sunday at 19:00.
    // This mirrors the fix in the `garmin_coach` cron above (see the
    // matching block on the daily coach briefing — same reasoning, same
    // pattern).
    //
    // When silent auth fails we DO NOT early-return the whole cron. The
    // weekly plan adjustment has two inputs:
    //   1. Adherence (pure SQL, no Garmin needed)
    //   2. Readiness score (Garmin-backed, optional enhancement)
    // Adherence-only adjustments are still valuable and preserve the
    // cron's primary purpose on weeks where Garmin is down. The
    // `garminAvailable` flag below gates ONLY the readiness call.
    let garminAvailable = false;
    if (isGarminConfigured()) {
      logger.info('Training plan adjust starting — pre-authenticating Garmin (silent mode — no MFA email if session is dead)');
      garminAvailable = await garminEnsureAuth({ silent: true });
      if (!garminAvailable) {
        logger.warn('Training plan adjust: Garmin session unrecoverable in silent mode — adherence-only adjustments this week (no MFA email triggered)');
      }
    }

    for (const userId of getActiveUserIds()) {
      // Hardening 2026-04-21: wrap the per-user iteration in a
      // request context so Garmin's per-user client resolution via
      // `getCurrentContext()?.userId` actually sees the iterating
      // user. Without this, `garmin-session-store.resolveGarminUserId`
      // falls back to `getOwnerBootstrapUser()?.id` — every user's
      // readiness would be computed from the OWNER'S Garmin data and
      // then persisted as their own. Pure cross-tenant data poisoning
      // in a scheduled job. runWithContext scopes the AsyncLocalStorage
      // so all downstream reads see the correct userId.
      await runWithContext({ source: 'cron:training_plan_adjust', userId }, async () => {
      const plan = getActivePlan(userId);
      if (!plan) return;

      const currentWeek = getCurrentWeek(plan.id);
      if (!currentWeek) return;

      const stats = getWeeklyAdherence(plan.id, currentWeek.id);
      if (stats.completedSessions === 0 && stats.skippedSessions === 0) return; // no data yet

      // Calculate and persist readiness score (only when Garmin session
      // is confirmed available — prevents cascading 5× raw Garmin calls
      // against a dead session, each of which would independently retry
      // and could re-trigger the MFA login path we just bypassed).
      let readinessScore: number | null = null;
      let readinessRec = '';
      if (garminAvailable) {
        try {
          const readiness = await calculateReadiness(userId, { garminSilent: true });
          persistReadinessScore(userId, readiness);
          readinessScore = readiness.score;
          readinessRec = readiness.recommendation;
        } catch (err) {
          logger.warn({ err, userId }, 'Readiness calculation failed — using adherence only');
        }
      }

      const recommendation = computeAdjustmentRecommendation(stats);

      // Factor readiness into adjustment:
      // Low readiness + good adherence = fatigue, not laziness → force deload
      if (readinessScore != null && readinessScore < 50 && stats.adherenceRate > 70) {
        recommendation.adjustIntensity = Math.min(recommendation.adjustIntensity, 70);
        recommendation.reason += ` + Low readiness (${readinessScore}/100): ${readinessRec}`;
      }

      // Find next week and apply adjustment if needed
      const allWeeks = getWeeksForPlan(plan.id);
      const nextWeek = allWeeks.find((w: any) => w.week_number === currentWeek.week_number + 1);

      if (nextWeek && recommendation.adjustIntensity !== 100) {
        updateWeekAdjustment(nextWeek.id, recommendation.adjustIntensity, recommendation.reason);

        const emoji = recommendation.adjustIntensity < 100 ? '📉' : '📈';
        let msg = `${emoji} <b>Training Plan Auto-Adjust</b>\n\n`;
        msg += `<b>${plan.name}</b> — Week ${currentWeek.week_number} review:\n`;
        msg += `• Adherence: ${stats.adherenceRate}%  (${stats.completedSessions}/${stats.totalSessions})\n`;
        if (stats.avgRpe != null) msg += `• Avg RPE: ${stats.avgRpe}\n`;
        if (stats.avgSoreness != null) msg += `• Avg Soreness: ${stats.avgSoreness}/10\n`;
        if (stats.avgEnergy != null) msg += `• Avg Energy: ${stats.avgEnergy}/10\n`;
        if (readinessScore != null) msg += `• Readiness: ${readinessScore}/100 (${readinessRec})\n`;
        msg += `\n<b>Week ${currentWeek.week_number + 1} adjusted:</b> ${recommendation.adjustIntensity}% intensity\n`;
        msg += `<i>Reason: ${recommendation.reason}</i>`;

        try {
          await safeSend(userId, msg, { parse_mode: 'HTML' });
        } catch (err) {
          logger.error({ err, userId }, 'Failed to send training adjustment notification');
        }

        try {
          await createNotificationIntent({
            userId,
            tenantId: userId,
            sourceSkill: 'training',
            type: 'schedule_changed',
            priority: 'active',
            relatedEntityId: `training-plan-adjust:${plan.id}:${nextWeek.id}`,
            relatedEntityType: 'training_week_adjustment',
            title: 'Training week adjusted',
            body: 'Nexus adjusted your next training week.',
            sensitiveBody: safeHtmlNotificationBody(msg),
            actionButtons: [{ id: 'open_detail', label: 'Open training', style: 'primary' }],
            deeplink: `nexus://training/plan/${plan.id}`,
            dedupeKey: `training:plan_adjust:${userId}:${plan.id}:${nextWeek.id}:${recommendation.adjustIntensity}`,
            requiresUserAction: false,
            deliveryPolicy: 'auto',
            privacyPolicy: 'health',
          });
        } catch (err) {
          logger.warn({ err, userId, planId: plan.id, weekId: nextWeek.id }, 'Training adjustment notification intent emit failed');
        }
      }

      // ── Plan renewal check ───────────────────────────────────
      // If this is the LAST week of the plan, notify the user to
      // create a new cycle. Include adherence summary + readiness
      // so they can decide whether to increase or maintain.
      if (!nextWeek && currentWeek.week_number >= (plan.duration_weeks || 4)) {
        let renewMsg = `🔄 <b>Plan Complete!</b>\n\n`;
        renewMsg += `<b>${plan.name}</b> — ${plan.duration_weeks} weeks finished.\n`;
        renewMsg += `• Overall adherence: ${stats.adherenceRate}%\n`;
        if (readinessScore != null) renewMsg += `• Current readiness: ${readinessScore}/100\n`;
        renewMsg += `\n💡 Time for a new 4-week cycle! `;
        renewMsg += readinessScore != null && readinessScore > 70
          ? `Your readiness is strong — consider increasing intensity.`
          : `Consider maintaining or slightly reducing intensity.`;
        renewMsg += `\n\nGo to <b>Training → Create Plan</b> to generate your next cycle.`;

        try {
          await safeSend(userId, renewMsg, { parse_mode: 'HTML' });
        } catch (err) {
          logger.error({ err, userId }, 'Failed to send plan renewal Telegram notification');
        }

        try {
          await createNotificationIntent({
            userId,
            tenantId: userId,
            sourceSkill: 'training',
            type: 'reminder',
            priority: 'active',
            relatedEntityId: `training-plan-renewal:${plan.id}`,
            relatedEntityType: 'training_plan',
            title: 'Training plan complete',
            body: 'Your training plan is complete. Open Nexus to choose what comes next.',
            sensitiveBody: safeHtmlNotificationBody(renewMsg),
            actionButtons: [{ id: 'open_detail', label: 'Open training', style: 'primary' }],
            deeplink: `nexus://training/plan/${plan.id}`,
            dedupeKey: `training:plan_renewal:${userId}:${plan.id}`,
            requiresUserAction: false,
            deliveryPolicy: 'auto',
            privacyPolicy: 'health',
          });
        } catch (err) {
          logger.warn({ err, userId, planId: plan.id }, 'Training renewal notification intent emit failed');
        }
      }
      }); // runWithContext per-user scope end
    }
  }), { timezone: tz });

  // ── Invoice queue flush (every 15 min) ──────────────────────────────
  cron.schedule('*/15 * * * *', wrapJob('invoice_queue', async () => {
    const pending = getPendingCount();
    if (pending === 0) return; // nothing to flush — skip silently

    const result = await flushQueue();

    if (result.flushed > 0) {
      // Notify user that queued invoices were filed
      let msg = `📤 <b>Fila de faturas processada!</b>\n\n`;
      msg += `✅ ${result.flushed} fatura${result.flushed > 1 ? 's' : ''} arquivada${result.flushed > 1 ? 's' : ''} com sucesso`;
      if (result.failed > 0) msg += `\n❌ ${result.failed} falharam permanentemente`;
      if (result.remaining > 0) msg += `\n🔄 ${result.remaining} ainda na fila`;
      msg += `\n\n<i>O Mac voltou a estar disponível.</i>`;

      for (const userId of getOwnerUserIds()) {
        try {
          await safeSend(userId, msg, { parse_mode: 'HTML' });
        } catch (err) {
          logger.error({ err, userId }, 'Failed to send invoice queue flush notification');
        }
      }
    }
  }), { timezone: tz });

  // ── Weekly channel re-analysis (Sunday 03:00) ─────────────────
  cron.schedule('0 3 * * 0', wrapJob('channel_relearn', async () => {
    const result = await processAllChannelScopes();
    if (result.analyzed > 0 || result.failed > 0) {
      const msg = `📚 <b>Weekly Channel Re-Learn</b>\n\n` +
        `✅ ${result.analyzed} analyzed · ❌ ${result.failed} failed · 🧠 ${result.synthesized ? 'Knowledge updated' : 'No changes'}`;
      for (const userId of getOwnerUserIds()) {
        try {
          await safeSend(userId, msg, { parse_mode: 'HTML' });
        } catch (err) {
          logger.error({ err, userId }, 'Failed to send channel relearn notification');
        }
        await createNotificationIntent({
          userId,
          tenantId: userId,
          sourceSkill: 'content',
          type: result.failed > 0 ? 'sync_failure' : 'insight',
          priority: result.failed > 0 ? 'active' : 'passive',
          relatedEntityId: 'channel_relearn',
          relatedEntityType: 'content_channel_relearn',
          title: 'Channel Re-Learn',
          body: `${result.analyzed} channels analyzed${result.failed > 0 ? `, ${result.failed} failed` : ''}${result.synthesized ? ' — knowledge updated' : ''}`,
          actionButtons: [{ id: 'open_detail', label: 'Open', style: 'primary' }],
          deeplink: 'nexus://notifications/channel-relearn',
          dedupeKey: `content:channel_relearn:${userId}:${startOfDay()}`,
          privacyPolicy: 'private_content',
        });
      }
    }
  }), { timezone: tz });

  // ── Content Workflow: Tuesday Reel Topics (09:00) ──────────────────
  cron.schedule('0 9 * * 2', wrapJob('tuesday_reels', async () => {
    await runContentTopicCronForActiveUsers('reel', 'tuesday_reels');
  }), { timezone: tz });

  // ── Content Workflow: Thursday YT Topic (09:00) ───────────────────
  cron.schedule('0 9 * * 4', wrapJob('thursday_youtube', async () => {
    await runContentTopicCronForActiveUsers('youtube', 'thursday_youtube');
  }), { timezone: tz });

  // ── Content Workflow: Friday Weekly Package (18:30) ────────────────
  cron.schedule('30 18 * * 5', wrapJob('friday_weekly', async () => {
    await runWeeklyContentPackageCronForActiveUsers();
  }), { timezone: tz });

  // ── Pipeline Agent (daily 20:00) ───────────────────────────────────
  cron.schedule('0 20 * * *', wrapJob('pipeline_agent', async () => {
    await runPipelineAgent();
  }), { timezone: tz });

  // ── Performance Agent (Sunday 06:00, after channel relearn) ──────
  cron.schedule('0 6 * * 0', wrapJob('performance_agent', async () => {
    await runPerformanceAgent();
  }), { timezone: tz });

  // ── Voice Evolution Agent (1st of month, 04:00) ─────────────────
  cron.schedule('0 4 1 * *', wrapJob('voice_evolution', async () => {
    await runVoiceEvolutionAgent();
  }), { timezone: tz });

  // ── Reaction Radar Agent (every 4 hours) ─────────────────────────
  cron.schedule('0 8,14,20 * * *', wrapJob('reaction_radar', async () => {
    await runReactionRadar();
  }), { timezone: tz });

  // ── SEO Tracking Agent (Monday 06:00) ────────────────────────────
  cron.schedule('0 6 * * 1', wrapJob('seo_agent', async () => {
    await runSEOAgent();
    const msg = '🔍 <b>SEO Agent</b> — weekly keyword rank check complete. Use <code>/seorank</code> to see results.';
    for (const userId of getOwnerUserIds()) {
      try { await safeSend(userId, msg, { parse_mode: 'HTML' }); } catch {}
    }
  }), { timezone: tz });

  // ── Autoresearch (Sunday 01:00 — rotates through targets) ────────
  cron.schedule('0 1 * * 0', wrapJob('autoresearch', async () => {
    const targetId = getScheduledTarget();
    const onProgress = async (msg: string) => {
      for (const userId of getOwnerUserIds()) {
        try { await safeSend(userId, msg, { parse_mode: 'HTML' }); } catch {}
      }
    };
    try {
      const result = await runAutoresearch(targetId, 3, false, onProgress);
      const kept = result.rounds.filter(r => r.decision === 'kept').length;
      const summary = `🔬 <b>Autoresearch: ${targetId}</b>\n\n` +
        `Score: <b>${(result.finalScore * 100).toFixed(1)}%</b>\n` +
        `Kept ${kept}/${result.rounds.length} mutations\n` +
        `Duration: ${(result.totalDurationMs / 1000).toFixed(0)}s`;
      for (const userId of getOwnerUserIds()) {
        try { await safeSend(userId, summary, { parse_mode: 'HTML' }); } catch {}
      }
    } catch (err) {
      logger.error({ err, targetId }, 'Scheduled autoresearch failed');
    }
  }), { timezone: tz });

  // ── Database Backup (daily, configurable — default 03:00) ─────────
  if (config.backup.enabled) {
    cron.schedule(backupCron, wrapJob('db_backup', async () => {
      const backupPath = await runDatabaseBackup();
      const short = path.basename(backupPath);
      for (const userId of getOwnerUserIds()) {
        try {
          await safeSend(userId,
            `💾 <b>Database Backup</b>\n\nBackup complete: <code>${escapeHtml(short)}</code>`,
            { parse_mode: 'HTML' });
        } catch {
          // swallow — notification is best-effort
        }
      }
    }), { timezone: tz });

    // ── Weekly Restore Test (Sunday 04:00) ─────────────────────────
    cron.schedule('0 4 * * 0', wrapJob('db_restore_test', async () => {
      const result = await weeklyRestoreTest();
      if (!result.success) {
        logger.error({ details: result.details }, 'Weekly restore test FAILED');
        for (const userId of getOwnerUserIds()) {
          try {
            await safeSend(userId,
              `🚨 <b>Weekly Restore Test FAILED</b>\n\n<code>${escapeHtml(result.details.slice(0, 200))}</code>`,
              { parse_mode: 'HTML' });
          } catch {}
        }
      } else {
        logger.info({ details: result.details }, 'Weekly restore test passed');
      }
    }), { timezone: tz });
  }

  // ── Signal Expiry Cleanup (hourly) ────────────────────────────────
  cron.schedule('0 * * * *', wrapJob('expire_signals', async () => {
    const expired = expireStaleSignals();
    if (expired > 0) logger.info({ expired }, 'Expired stale intelligence bus signals');
  }), { timezone: tz });

  // Run signal expiry on startup
  expireStaleSignals();

  // ── Integration Health Probes (every 5 min) ─────────────────────
  // Audit Weeks 2-4. Synthetic checks against Garmin / Google / Outlook
  // refresh tokens — proves the credentials are still valid before any
  // user-facing flow needs them. Persisted to integration_health (60-day
  // retention via midnight_cleanup). The portal can render a status grid
  // from this table.
  cron.schedule('*/5 * * * *', wrapJob('integration_health', async () => {
    const { runHealthProbes } = require('./integration-health');
    await runHealthProbes();
  }), { timezone: tz });

  cron.schedule('45 6 * * *', wrapJob('garmin_tenant_isolation_watcher', async () => {
    await runGarminTenantIsolationWatcher();
  }), { timezone: tz });

  cron.schedule('* * * * *', wrapJob('operator_alert_delivery', async () => {
    const results = await processDueOperatorAlertDeliveries(25);
    if (results.length === 0) return 'skipped';
    logger.info(
      {
        attempted: results.length,
        delivered: results.filter((result) => result.status === 'delivered').length,
        failed: results.filter((result) => result.status === 'failed').length,
        deadLetter: results.filter((result) => result.status === 'dead_letter').length,
        notConfigured: results.filter((result) => result.status === 'not_configured').length,
      },
      'Operator alert delivery cycle complete',
    );
  }), { timezone: tz });

  // Seed SEO keywords (only if table is empty)
  try {
    seedKeywordsIfEmpty();
  } catch (err) {
    logger.warn({ err }, 'Failed to seed SEO keywords');
  }

  // Seed default reference channels (only if table is empty)
  try {
    seedDefaultChannels();
  } catch (err) {
    logger.warn({ err }, 'Failed to seed default content reference channels');
  }

  // Seed book library (only if table is empty)
  try {
    seedBooksIfEmpty(async (msg) => {
      for (const userId of getOwnerUserIds()) {
        try { await safeSend(userId, msg, { parse_mode: 'HTML' }); } catch {}
      }
    });
  } catch (err) {
    logger.warn({ err }, 'Failed to seed book library');
  }

  // ── DST Watchdog (every 15 min) — recovers jobs missed during clock changes ──
  // Runs at minute 2/17/32/47 to avoid racing with normal crons that fire at :00/:15/:30/:45.
  const DST_SKIP_JOBS = new Set([
    'reminders', 'shared_list', 'garmin_keepalive', 'invoice_queue', 'expire_signals',
  ]);
  cron.schedule('2,17,32,47 * * * *', wrapJob('dst_watchdog', async () => {
    const jobMap = getJobMap();
    const nowMs = Date.now();
    for (const [name, status] of jobMap) {
      if (DST_SKIP_JOBS.has(name)) continue;     // interval jobs don't need recovery
      if (!status.wrappedFn) continue;            // no callback stored
      if (status.lastResult === 'running') continue;

      try {
        const expr = CronExpressionParser.parse(status.cronExpression, { tz });
        const expectedPrev = expr.prev().toDate().getTime();
        const lastRan = status.lastRunAt ? new Date(status.lastRunAt).getTime() : 0;

        // Job was expected to run since last execution but didn't — fire it now
        // Min 2 min overdue: avoids racing with the normal cron that should fire the job
        // Max 3 hour window: avoids re-firing stale jobs after a restart
        const overdueMs = nowMs - expectedPrev;
        if (expectedPrev > lastRan && overdueMs >= 2 * 60 * 1000 && overdueMs < 3 * 60 * 60 * 1000) {
          logger.warn({ job: name, label: status.label, expectedAt: new Date(expectedPrev).toISOString() },
            'DST watchdog: recovering missed job');
          status.wrappedFn().catch((err) => {
            logger.error({ err, job: name }, 'DST watchdog: recovered job failed');
          });
        }
      } catch {
        // ignore parse errors for unusual cron expressions
      }
    }
  }), { timezone: tz });

  registerJob('notification_release', 'Notification delayed/digest release', '*/15 * * * *', 'system');
  cron.schedule('*/15 * * * *', wrapJob('notification_release', async () => {
    const result = await releaseDueNotificationDeliveries();
    if (result.inspected > 0) {
      logger.info(result, 'Notification delayed/digest release completed');
    }
  }), { timezone: tz });

  cron.schedule('*/15 * * * *', wrapJob('decision_source_supersession', async () => {
    const result = runDecisionSourceStateSupersessionJob();
    if (result.supersededCount === 0) return 'skipped';
    logger.info(result, 'Decision source-state supersession completed');
  }), { timezone: tz });

  cron.schedule('*/2 * * * *', wrapJob('chat_action_plan_expiry', async () => {
    const expired = expireStaleChatActionPlans();
    const expiredPendingActions = expireStalePendingChatActionsForJob();
    const totalExpired = expired + expiredPendingActions;
    if (totalExpired === 0) return 'skipped';
    logger.info({ expired, expiredPendingActions }, 'Expired stale chat action plans');
  }), { timezone: tz });

  cron.schedule('*/5 * * * *', wrapJob('chat_action_run_zombie_reaper', async () => {
    const reaped = reapZombieChatActionRuns();
    if (reaped === 0) return 'skipped';
    logger.warn({ reaped }, 'Reaped orphaned chat action runs stuck in executing status');
  }), { timezone: tz });

  cron.schedule('20 0 * * *', wrapJob('chat_action_run_retention', async () => {
    const deleted = pruneCompletedChatActionRuns();
    if (deleted === 0) return 'skipped';
    logger.info({ deleted, retentionDays: 90 }, 'Pruned retained chat action run summaries');
  }), { timezone: tz });

  cron.schedule('* * * * *', wrapJob('event_backbone_worker', async () => {
    if (process.env.EVENT_BACKBONE_WORKER_DISABLED === '1') {
      return 'skipped';
    }

    const result = await runEventBackboneOnce({
      eventLimit: intEnv('EVENT_BACKBONE_EVENT_BATCH_LIMIT', 25, 1, 100),
      jobLimit: intEnv('EVENT_BACKBONE_JOB_BATCH_LIMIT', 10, 1, 50),
      lockOwner: `scheduler:${process.pid}`,
    });
    const touched =
      result.events.processed +
      result.events.failed +
      result.events.deadLetter +
      result.jobs.completed +
      result.jobs.failed +
      result.jobs.deadLetter;

    if (result.events.deadLetter > 0 || result.jobs.deadLetter > 0) {
      logger.warn(result, 'Event backbone worker produced dead-letter rows');
    }
    if (touched === 0) return 'skipped';
    logger.info(result, 'Event backbone worker processed pending work');
  }), { timezone: tz });

  cron.schedule('10 0 * * *', wrapJob('event_backbone_cleanup', async () => {
    if (process.env.EVENT_BACKBONE_CLEANUP_DISABLED === '1') {
      return 'skipped';
    }

    const apply = process.env.EVENT_BACKBONE_CLEANUP_APPLY === '1';
    const report = runEventBackboneCleanup({
      dbPath: config.app.databasePath,
      apply,
      retentionDays: intEnv('EVENT_BACKBONE_RETENTION_DAYS', 30, 1, 3650),
      protectNewest: intEnv('EVENT_BACKBONE_RETENTION_PROTECT_NEWEST', 500, 0, 100000),
    });
    const candidates = report.targets.reduce((sum, target) => sum + target.candidates, 0);
    const deleted = report.targets.reduce((sum, target) => sum + target.deleted, 0);
    if (candidates === 0 && deleted === 0) return 'skipped';
    logger.info(
      {
        apply,
        retentionDays: report.retentionDays,
        candidates,
        deleted,
        targets: report.targets.map(({ table, candidates, deleted }) => ({ table, candidates, deleted })),
      },
      'Event backbone retention cleanup completed',
    );
  }), { timezone: tz });

  logger.info(
    `Scheduler started: reminders, daily briefing (${config.todo.digestTime}), end-of-day (21:00), weekly (Fri 17:00), shared list (*/5), content (16:43), invoices (1st 09:00/09:15/09:30), fiscal-bundle (daily 08:10 due-check), conflict (19:30), fossa (bi-weekly Mon 07:30), garmin-keepalive (*/30), coach (${config.garmin.coachTime}), invoice-queue (*/15), channel-relearn (Sun 03:00), tue-reels (Tue 09:00), thu-youtube (Thu 09:00), fri-weekly (Fri 18:30), pipeline-agent (20:00), notification-release (*/15), decision-source-supersession (*/15), chat-action-plan-expiry (*/2), chat-action-run-zombie-reaper (*/5), chat-action-run-retention (00:20), event-backbone-worker (* * * * *), event-backbone-cleanup (00:10), expire-signals (hourly), db-backup (${config.backup.time}), dst-watchdog (*/15)`
  );
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

// ── Exported for portal quick actions ─────────────────────────────────

export async function sendCoachBriefings(bot?: any): Promise<void> {
  const telegramEnabled = isTelegramLegacyDeliveryEnabled() && bot;
  const safeSend = async (userId: number, msg: string, opts?: any) => {
    if (!telegramEnabled) return;
    try { await bot.api.sendMessage(userId, msg, opts); } catch {}
  };

  for (const target of getActiveUserTargets()) {
    await runWithContext({ source: 'cron:garmin_coach', userId: target.tenantId }, async () => {
      let result;
      try {
        result = await generateCoachBriefing(target.tenantId, { garminSilent: true });
      } catch (err) {
        logger.warn({ err, userId: target.tenantId }, 'Coach briefing skipped for user');
        return;
      }

      if (result.errors.length > 0) {
        logger.warn({ userId: target.tenantId, errors: result.errors }, 'Coach briefing completed with data gaps');
      }

      // Store recommendations so Training follow-up actions can reference
      // the correct tenant-scoped coach state.
      if (result.recommendations.length > 0) {
        setLastCoachState(target.tenantId, result.recommendations, result.message.substring(0, 500));
      }

      addToConversation(target.tenantId, 'triathlon', 'assistant', result.message);
      setLastActiveDomain(target.tenantId, 'triathlon');

      // Durable report + APNs push for the native app.
      try {
        let readinessData: any = null;
        try {
          const { calculateReadiness } = require('./readiness-scorer');
          readinessData = await calculateReadiness(target.tenantId, { garminSilent: true });
        } catch { /* non-fatal */ }

        await storeAndPushReport({
          userId: target.tenantId,
          type: 'coach_briefing' as const,
          title: '🏋️ Coach Report',
          summary: `${result.recommendations.length} recommendations`,
          documentJson: {
            message: result.message,
            recommendations: result.recommendations,
            errors: result.errors,
            dataCollectionMs: result.dataCollectionMs,
            analysisMs: result.analysisMs,
            readiness: readinessData ? {
              score: readinessData.score,
              recommendation: readinessData.recommendation,
              reasoning: readinessData.reasoning,
              factors: {
                hrv: readinessData.factors?.hrv,
                sleep: readinessData.factors?.sleep,
                bodyBattery: readinessData.factors?.bodyBattery,
                trainingLoad: readinessData.factors?.trainingLoad,
              },
            } : null,
          },
          sourceJob: 'garmin_coach',
          pushCategory: 'coach_briefing',
        });
      } catch (err) {
        logger.debug({ err, userId: target.tenantId }, 'Failed to store coach report (non-fatal)');
      }

      if (telegramEnabled && target.telegramId) {
        try {
          for (const chunk of splitMessage(result.message)) {
            await safeSend(target.telegramId, chunk, { parse_mode: 'HTML' });
          }
        } catch (err) {
          logger.error({ err, userId: target.telegramId, tenantId: target.tenantId }, 'Failed to send coach briefing');
        }
      }

      logger.info(
        {
          userId: target.tenantId,
          dataMs: result.dataCollectionMs,
          analysisMs: result.analysisMs,
          errors: result.errors.length,
        },
        'Daily coach briefing completed'
      );
    });
  }
}

export async function sendDailyBriefing(bot?: any): Promise<void> {
  const _telegramEnabled = isTelegramLegacyDeliveryEnabled() && bot;
  const safeSend = async (userId: number, msg: string, opts?: any) => {
    if (!_telegramEnabled) return;
    try { await bot.api.sendMessage(userId, msg, opts); } catch {}
  };
  for (const target of getActiveUserTargets()) {
    const data = await buildDailyBriefingDataForUser(target.tenantId);
    // Identity-safety: resolve display name via the strict by-id helper so
    // the briefing greets the actual recipient and never the legacy founder
    // default. Empty string falls through to a name-less greeting.
    const recipientDisplayName = getPreferredDisplayNameById(target.tenantId);
    const msg = formatDailyBriefing(data, getUserLanguageById(target.tenantId), recipientDisplayName);
    const chunks = splitMessage(msg);

    // ── Store durable report + push (April 2026) ────────────────────
    try {
      await storeAndPushReport({
        userId: target.tenantId,
        type: 'morning_briefing' as const,
        title: `☀️ ${data.date}`,
        summary: `${data.events.length} events, ${data.dueTodayTasks.length + data.overdueTasks.length} tasks`,
        documentJson: data,
        sourceJob: 'daily_briefing',
        pushCategory: 'morning_briefing',
      });
    } catch (err) {
      logger.debug({ err, userId: target.tenantId }, 'Failed to store morning briefing report (non-fatal)');
    }

    // Legacy Telegram delivery (gated by TELEGRAM_LEGACY_DELIVERY env)
    if (isTelegramLegacyDeliveryEnabled() && target.telegramId) {
      try {
        for (const chunk of chunks) {
          await safeSend(target.telegramId, chunk, { parse_mode: 'HTML' });
        }
      } catch (err) {
        logger.error({ err, userId: target.telegramId, tenantId: target.tenantId }, 'Failed to send daily briefing');
      }
    }
  }
}

async function sendWeeklyReview(bot?: any): Promise<void> {
  const _telegramEnabled = isTelegramLegacyDeliveryEnabled() && bot;
  const safeSend = async (userId: number, msg: string, opts?: any) => {
    if (!_telegramEnabled) return;
    try { await bot.api.sendMessage(userId, msg, opts); } catch {}
  };
  for (const target of getActiveUserTargets()) {
    const payload = await buildWeeklyReviewPayloadForUser(target.tenantId);
    // Store durable report + push
    try {
      await storeAndPushReport({
        userId: target.tenantId,
        type: 'weekly_review' as const,
        title: '📊 Week in Review',
        summary: payload.summary,
        documentJson: payload.documentJson,
        sourceJob: 'weekly_review',
        pushCategory: 'weekly_review',
      });
    } catch (err) {
      logger.debug({ err, userId: target.tenantId }, 'Failed to store weekly review report (non-fatal)');
    }

    // Legacy Telegram delivery (gated)
    if (isTelegramLegacyDeliveryEnabled() && target.telegramId) try {
      await safeSend(target.telegramId, payload.message, { parse_mode: 'HTML' });
    } catch (err) {
      logger.error({ err, userId: target.telegramId, tenantId: target.tenantId }, 'Failed to send weekly review');
    }
  }
}
