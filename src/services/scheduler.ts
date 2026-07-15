// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import path from 'path';
import { createHash } from 'crypto';
import type Database from 'better-sqlite3';
import cron from 'node-cron';
import { DateTime } from 'luxon';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getDueReminders, markReminderFired, getRemindersForToday } from '../state/reminders';
import * as msTodo from './microsoft-todo';
import type { TodoTask } from './microsoft-todo';
import { getEvents, getEventsWithDiagnostics, hasConnectedCalendarForUser, isAnyCalendarConfigured, type UnifiedCalendarEvent, type UnifiedCalendarFetchStatus } from './unified-calendar';
import { getUnreadCountForUser, isOutlookMailConfiguredForUser, isOutlookMailConfigured, getUnreadCount, sendEmail } from './outlook-mail';
import { DailyBriefingData, escapeHtml } from '../utils/telegram-formatter';
import { now, startOfDay, endOfDay, startOfWeek, endOfWeek, formatTime, formatDateTime } from '../utils/date-parser';
// content-discovery.ts still exists for manual /discover but removed from scheduler
import { collectMonthlyInvoices, formatCollectionNotification } from './invoice-collector';
import { isInvoiceFilingConfigured } from './invoice-filer';
import { collectAmazonInvoices, formatAmazonNotification, isAmazonConfigured } from './amazon-collector';
import { collectUberInvoices, formatUberNotification, isUberConfigured } from './uber-collector';
import { createScraperMfaInteractiveCallbacks } from './scraper-mfa-reply';
import { getFiscalCollectionSummary, isFiscalBundleDue, sendFiscalBundleNow } from './fiscal-bundle';
import { generateCoachBriefing } from './garmin-coach';
import { isGarminConfigured, keepAlive as garminKeepAlive, ensureAuthenticated as garminEnsureAuth } from './garmin';
import { registerJob as registerTelemetryJob, wrapJob, recordGarminRefresh, setJobFailureNotifier, setJobEnabledChecker, getJobMap, seedJobLastRunFromHistory, type JobDomain } from '../portal/telemetry';
import { assertAgentJobRuntimeRegistration } from './agent-job-manifest';
import { createNotificationIntent, releaseDueNotificationDeliveries } from './notification-orchestrator';
import { isCronJobEnabled } from '../skills/skill-manager';
import { CronExpressionParser } from 'cron-parser';
import { flushQueue, getPendingCount } from './invoice-queue';
import { setLastCoachState } from '../domains/domain-handler';
import { setLastActiveDomain } from '../api/routes/chat-message-context';
import { addToConversation } from '../state/conversation';
import { seedDefaultChannels } from './channel-learner';
import {
  runContentTopicCronForActiveUsers,
  runScheduledChannelRelearn,
  runScheduledAutoresearch,
  runWeeklyContentPackageCronForActiveUsers,
} from './scheduled-agent-jobs';
export {
  runContentTopicCronForActiveUsers,
  runWeeklyContentPackageCronForActiveUsers,
} from './scheduled-agent-jobs';
import {
  listActiveAgentJobTenantTargets as getActiveUserTargets,
  type AgentJobTenantTarget,
} from './agent-job-targets';
import { runPipelineAgent } from '../agents/pipeline-agent';
import { runSEOAgent, seedKeywordsIfEmpty } from '../agents/seo-agent';
import { runReactionRadar } from '../agents/reaction-radar-agent';
import { runPerformanceAgent } from '../agents/performance-agent';
import { runScheduledVoiceEvolutionAgent } from '../agents/voice-evolution-agent';
import { expireStaleSignals } from './intelligence-bus';
import { seedBooksIfEmpty } from '../commands/books';
import {
  releaseFreshReportScheduleClaim,
  resolveDueReportTargets,
} from './report-schedule-dispatcher';
import { getUserTimezoneById, isOwnerUserRef } from './user-service';
import { runDatabaseBackup, weeklyRestoreTest } from './backup';
import { getDb } from './database';
import { listActiveFiscalCollectionProfiles } from '../state/fiscal-collection-profiles';
import { runWithContext } from '../utils/request-context';
import { getOwnerBootstrapTarget } from './user-service';
import { getTaskProviderForUser } from './task-store/task-router';
import { storeAndPushReport } from './report-document-store';
import { processDueOperatorAlertDeliveries, recordOperatorAlert } from './operator-alerts';
import { runEventBackboneOnce } from './event-backbone-worker';
import { runEventBackboneCleanup } from '../tools/event-backbone-cleanup';
import { expireStalePendingChatActionsForJob } from './chat-action-state';
import { pruneCompletedChatActionRuns, reapZombieChatActionRuns } from './chat-action-run-store';
import { runScheduledChatActionFixerJobs } from './chat-action-fixer-worker';
import { runGarminTenantIsolationWatcher } from './garmin-tenant-isolation-watcher';
import {
  AgentJobOutputValidationError,
  runGovernedAgentJob,
  type AgentJobOutcome,
  type GovernedAgentJobAdapter,
} from './agent-job-runner';
import {
  runDecisionCenterSmokeCleanupJob,
  createDecisionIntent,
  runDecisionExpiryJob,
  runDecisionHandledHistoryBackfillJob,
  runDecisionLedgerRetentionPruneJob,
  runDecisionMetricsRollupJob,
  runDecisionSourceStateSupersessionJob,
} from './decision-center';
import { findCalendarConflictPairs, conflictPairKey, type CalendarConflictPair } from './calendar-conflict-analysis';
import { listSecretaryAgendaItems, type SecretaryAgendaItem } from './secretary-scheduling-arbitrator';
import { buildNormalizedDecisionAction } from './decision-action-contract';
import { evaluateDecisionConflicts, type ConflictComparisonAction } from './decision-conflict-evaluator';
import { secretaryAgendaStateRevision } from './secretary-agenda-state-revision';
import { getDecisionConflictPolicyV1Mode } from './runtime-flags';
import { hmacTenantScopedEvidenceFingerprint } from './chat-core-v2/cloud-allowlist-packet';
import { materializeDecisionCenterDailyAttention } from './decision-center-daily-attention';
import { resolveChatCoreV2ActivationConfig } from './chat-core-v2/activation-flags';
import {
  computeChatCoreV2AutoRevertMetrics,
  getActiveChatCoreV2TenantIds,
} from './chat-core-v2/metrics-aggregator';
import { evaluateChatCoreV2AutoRevertPolicy } from './chat-core-v2/auto-revert-policy';
import { applyAutoRevertDecision } from './chat-core-v2/auto-revert-executor';
import { recordChatCoreV2GateCheck } from './chat-core-v2/gate-metrics-store';
import { expireOldNexusPointCredits } from './nexus-points';
import { getActivePlan, getCurrentWeek, getWeeklyAdherence, computeAdjustmentRecommendation, updateWeekAdjustment, getWeeksForPlan } from './training-plans';
import { calculateReadiness, persistReadinessScore } from './readiness-scorer';
import {
  isAiAutomationAllowedForRuntime,
  isCoachBriefingEntitlementEligible,
  isPaidAiCostControlsEnforcementEnabled,
} from './entitlement';
import {
  recordAiAutomationEligibilitySkip,
  resolveAiAutomationEligibility,
} from './ai-automation-policy';
import { AiBudgetError } from './cost-guardrail';
import { TrainingPlanRevisionError } from './training-plan-revision-errors';

type ActiveUserTarget = Pick<AgentJobTenantTarget, 'tenantId' | 'telegramId'>;

function registerJob(
  id: string,
  name: string,
  runtimeSchedule: string,
  domain: JobDomain = 'system',
  declaredSchedule: string = runtimeSchedule,
): void {
  assertAgentJobRuntimeRegistration({ id, name, runtimeSchedule, declaredSchedule, domain });
  registerTelemetryJob(id, name, runtimeSchedule, domain);
}

let remindersJobInFlight = false;

export function decisionMetricsRollupDateForScheduler(now = new Date(), timezone = config.app.timezone): string {
  return DateTime.fromJSDate(now).setZone(timezone).minus({ days: 1 }).toISODate() ?? '1970-01-01';
}

/**
 * Opaque, non-reversible token for a tenant id, used only in the Chat Core v2
 * auto-revert eval log line so operators can correlate without leaking raw ids.
 */
function opaqueChatV2TenantToken(tenantId: string): string {
  const salt =
    process.env.CHAT_CORE_V2_SHADOW_ROUTE_HMAC_SECRET ||
    process.env.CHAT_CORE_V2_WRITE_INTENT_HASH_SECRET ||
    process.env.CLASSIFY_SHADOW_HASH_SECRET ||
    'chat_core_v2_auto_revert_eval_token_salt@1';
  return createHash('sha256').update(`${salt}:tenant:${tenantId}`).digest('hex').slice(0, 16);
}

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

type TaskSyncScope = { tenantId: number; userId: number; importProviders: boolean };

export function getActiveTaskSyncScopes(userIds: number[]): TaskSyncScope[] {
  const scopes = new Map<string, TaskSyncScope>();
  for (const userId of userIds) {
    scopes.set(`${userId}:${userId}`, { tenantId: userId, userId, importProviders: true });
  }

  try {
    const rows = getDb().prepare(
      `SELECT DISTINCT tenant_id, user_id
       FROM task_mutations
       WHERE status IN ('queued', 'accepted_local', 'syncing', 'failed', 'conflict')
       UNION
       SELECT DISTINCT tenant_id, user_id
       FROM task_provider_links
       WHERE provider != 'nexus_local'
         AND link_state IN ('linked', 'stale', 'provider_missing', 'conflict', 'disconnected')`,
    ).all() as Array<{ tenant_id: number | null; user_id: number | null }>;

    for (const row of rows) {
      const tenantId = Number(row.tenant_id);
      const userId = Number(row.user_id);
      if (!Number.isSafeInteger(tenantId) || tenantId <= 0) continue;
      if (!Number.isSafeInteger(userId) || userId <= 0) continue;
      const key = `${tenantId}:${userId}`;
      if (!scopes.has(key)) {
        scopes.set(key, { tenantId, userId, importProviders: tenantId === userId });
      }
    }
  } catch (err) {
    logUnexpectedTenantQueryError('getActiveTaskSyncScopes', err);
  }

  return Array.from(scopes.values());
}

/**
 * Get only owner-tier Telegram IDs (for admin-only notifications).
 */
function getOwnerUserIds(): number[] {
  const ownerTarget = getOwnerBootstrapTarget();
  return ownerTarget?.telegramId != null ? [ownerTarget.telegramId] : [];
}

export { getActiveUserIds, getOwnerUserIds };

function getOwnerTenantIds(): number[] {
  const ownerTarget = getOwnerBootstrapTarget();
  return ownerTarget ? [ownerTarget.tenantId] : [];
}

/**
 * Chat Core v2 shadow data-retention sweep.
 *
 * Each table is swept independently so a missing migration/table never blocks
 * the rest of the cleanup. Logs contain counts only, never row contents.
 */
export function runChatCoreV2ShadowDataRetention(
  db: Database.Database = getDb(),
  nowIso: string = new Date().toISOString(),
): Record<string, number> {
  const deleted: Record<string, number> = {};

  const stanza = (table: string, run: () => number): void => {
    try {
      const changes = run();
      deleted[table] = changes;
      if (changes > 0) {
        logger.info({ table, deleted: changes }, 'Chat Core v2 retention cleanup');
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), table },
        'Chat Core v2 retention cleanup failed for table (skipped)',
      );
    }
  };

  stanza('chat_v2_replay_bundles', () =>
    db.prepare(
      `DELETE FROM chat_v2_replay_bundles WHERE expires_at IS NOT NULL AND expires_at < ?`,
    ).run(nowIso).changes,
  );

  stanza('chat_v2_canary_turn_log', () =>
    db.prepare(
      `DELETE FROM chat_v2_canary_turn_log WHERE expires_at IS NOT NULL AND expires_at < ?`,
    ).run(nowIso).changes,
  );

  stanza('chat_v2_command_events', () =>
    db.prepare(
      `DELETE FROM chat_v2_command_events WHERE created_at < datetime(?, '-90 days')`,
    ).run(nowIso).changes,
  );

  stanza('chat_v2_trace_spans', () =>
    db.prepare(
      `DELETE FROM chat_v2_trace_spans
       WHERE expires_at IS NOT NULL
         AND expires_at < ?
         AND retention_policy NOT IN ('legal_required')`,
    ).run(nowIso).changes,
  );

  stanza('chat_v2_online_eval_samples', () =>
    db.prepare(
      `DELETE FROM chat_v2_online_eval_samples WHERE created_at < datetime(?, '-90 days')`,
    ).run(nowIso).changes,
  );

  stanza('chat_v2_auto_revert_decisions', () =>
    db.prepare(
      `DELETE FROM chat_v2_auto_revert_decisions WHERE decided_at < datetime(?, '-365 days')`,
    ).run(nowIso).changes,
  );

  stanza('chat_v2_memory_items', () =>
    db.prepare(
      `DELETE FROM chat_v2_memory_items WHERE expires_at IS NOT NULL AND expires_at < ?`,
    ).run(nowIso).changes,
  );

  stanza('chat_v2_human_reviews', () =>
    db.prepare(
      `DELETE FROM chat_v2_human_reviews
       WHERE status IN ('approved', 'denied', 'changes_requested', 'cancelled', 'expired')
         AND COALESCE(decided_at, requested_at) < datetime(?, '-90 days')`,
    ).run(nowIso).changes,
  );

  return deleted;
}

/**
 * Chat Core v2 automated shadow gate-check. Read-only beyond one safe audit
 * row; never mutates runtime flags or routes.
 */
export function runChatCoreV2GateCheck(db: Database.Database = getDb()): {
  gateMet: boolean;
  shadowRowCount: number;
  logRowId: number;
} | null {
  try {
    const { report, logRowId } = recordChatCoreV2GateCheck(db);
    logger.info(
      {
        event: 'chat_core_v2_gate_check',
        gateMet: report.gateCanPromote,
        meetsMinRows: report.shadow.meetsMinRows,
        meetsSchemaValidity: report.shadow.meetsSchemaValidity,
        meetsSafeShape: report.shadow.meetsSafeShape,
        shadowRowCount: report.shadow.rowCount,
        recallMeetsTarget: report.recallMeetsTarget,
        recallBoundToSyntheticSeed: report.recallBoundToSyntheticSeed,
        logRowId,
      },
      'Chat Core v2 shadow gate check',
    );
    return { gateMet: report.gateCanPromote, shadowRowCount: report.shadow.rowCount, logRowId };
  } catch (err) {
    logger.warn(
      { event: 'chat_core_v2_gate_check_failed', err: err instanceof Error ? err.message : String(err) },
      'Chat Core v2 shadow gate check failed (skipped)',
    );
    return null;
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
    const plans = tp.getActivePlans?.(userId, userId) || [];
    const plan = plans[0] || tp.getActivePlan(userId, userId);
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

export async function buildDailyBriefingDataForUser(userId: number, tenantId = userId): Promise<DailyBriefingData> {
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
    const [pendingResult, yesterdayResult] = await runWithContext({ source: 'cron:daily_briefing', userId, tenantId }, async () =>
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

  const reminders = getRemindersForToday(userId, tenantId, getUserTimezoneById(userId));
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

export interface CalendarConflictAnalysis {
  date: string;
  dateLabel: string;
  timezone?: string;
  sourceStatus: UnifiedCalendarFetchStatus;
  sourceWarningCodes: string[];
  events: UnifiedCalendarEvent[];
  conflicts: CalendarConflictPair[];
  message: string;
}

export async function buildCalendarConflictAnalysisForUser(userId: number): Promise<CalendarConflictAnalysis | null> {
  if (!hasConnectedCalendarForUser(userId)) return null;

  const timezone = getUserTimezoneById(userId) || config.app.timezone;
  const tomorrow = now().setZone(timezone).plus({ days: 1 });
  const calendarResult = await getEventsWithDiagnostics(
    tomorrow.startOf('day').toISO()!,
    tomorrow.endOf('day').toISO()!,
    userId,
  );
  if (calendarResult.status === 'unavailable') {
    logger.warn({
      userId,
      warningCodes: calendarResult.warningCodes,
    }, 'Calendar conflict analysis skipped because all configured sources were unavailable');
    return null;
  }
  const events = calendarResult.events;

  if (events.length < 2) return null;

  const conflicts = findCalendarConflictPairs(events);

  if (conflicts.length === 0) return null;

  return {
    date: tomorrow.toISODate()!,
    dateLabel: tomorrow.toFormat('cccc, LLL dd'),
    timezone,
    sourceStatus: calendarResult.status,
    sourceWarningCodes: calendarResult.warningCodes
      .map((code) => code.trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, '_').slice(0, 80))
      .filter(Boolean)
      .slice(0, 8),
    events,
    conflicts,
    message: formatCalendarConflictMessage(conflicts, tomorrow.toFormat('cccc, LLL dd'), timezone),
  };
}

export async function buildConflictAlertForUser(userId: number): Promise<string | null> {
  return (await buildCalendarConflictAnalysisForUser(userId))?.message ?? null;
}

export function formatCalendarConflictMessage(
  conflicts: CalendarConflictPair[],
  dateLabel: string,
  timezone = config.app.timezone,
): string {
  let message = `⚠️ <b>Calendar Conflicts Tomorrow</b> (${dateLabel})\n\n`;
  for (const { first, second } of conflicts) {
    message += `🔴 <b>${escapeHtml(first.summary)}</b> (${formatCalendarConflictTime(first.start, timezone)}-${formatCalendarConflictTime(first.end, timezone)})\n`;
    message += `   overlaps with <b>${escapeHtml(second.summary)}</b> (${formatCalendarConflictTime(second.start, timezone)}-${formatCalendarConflictTime(second.end, timezone)})\n\n`;
  }
  message += 'Consider rescheduling one of these events.';
  return message;
}

const MAX_SECRETARY_CONFLICT_COMPARISONS = 24;

interface SecretaryCalendarConflictGroupEntry {
  pair: CalendarConflictPair;
  otherEvent: UnifiedCalendarEvent;
}

interface SecretaryCalendarConflictGroup {
  agenda: SecretaryAgendaItem;
  ownedEvent: UnifiedCalendarEvent;
  entries: Map<string, SecretaryCalendarConflictGroupEntry>;
}

export interface SecretaryCalendarConflictDecisionPlan {
  agenda: SecretaryAgendaItem;
  ownedEvent: UnifiedCalendarEvent;
  conflictPairs: CalendarConflictPair[];
  representedPairKeys: string[];
  candidate: ReturnType<typeof buildNormalizedDecisionAction>;
  conflictComparisons: ConflictComparisonAction[];
  evaluation: ReturnType<typeof evaluateDecisionConflicts>;
  contextVersion: string;
  deadlineAt: string;
  expiresAt: string;
}

/**
 * Build one bounded proposal per Secretary agenda item. The plan contains only
 * opaque provider references and normalized action metadata; human event copy
 * is retained solely in the authenticated sensitive body assembled by the
 * caller. Pair keys are returned explicitly so the cron can suppress the
 * generic notification for every conflict represented by the proposal.
 */
export function buildSecretaryCalendarConflictDecisionPlans(input: {
  tenantId: number;
  analysis: CalendarConflictAnalysis;
  agendaItems: SecretaryAgendaItem[];
  timezone: string;
  evaluatedAt?: Date;
}): SecretaryCalendarConflictDecisionPlan[] {
  const groups = new Map<string, SecretaryCalendarConflictGroup>();

  for (const pair of input.analysis.conflicts) {
    const matches = [
      { agenda: agendaForCalendarEvent(pair.first, input.agendaItems), event: pair.first, otherEvent: pair.second },
      { agenda: agendaForCalendarEvent(pair.second, input.agendaItems), event: pair.second, otherEvent: pair.first },
    ]
      .filter((match): match is { agenda: SecretaryAgendaItem; event: UnifiedCalendarEvent; otherEvent: UnifiedCalendarEvent } => !!match.agenda)
      .sort((left, right) => left.agenda.agendaItemId.localeCompare(right.agenda.agendaItemId)
        || opaqueCalendarEventRef(left.event, input.tenantId).localeCompare(opaqueCalendarEventRef(right.event, input.tenantId)));
    const selected = matches[0];
    if (!selected) continue;

    const pairKey = conflictPairKey(pair.first, pair.second);
    const existing = groups.get(selected.agenda.agendaItemId) ?? {
      agenda: selected.agenda,
      ownedEvent: selected.event,
      entries: new Map<string, SecretaryCalendarConflictGroupEntry>(),
    };
    existing.entries.set(pairKey, { pair, otherEvent: selected.otherEvent });
    groups.set(selected.agenda.agendaItemId, existing);
  }

  return [...groups.values()]
    .sort((left, right) => left.agenda.agendaItemId.localeCompare(right.agenda.agendaItemId))
    .flatMap((group): SecretaryCalendarConflictDecisionPlan[] => {
      const entries = [...group.entries.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, MAX_SECRETARY_CONFLICT_COMPARISONS);
      if (entries.length === 0) return [];
      const otherEvents = entries.map(([, entry]) => entry.otherEvent);
      const contextVersion = calendarConflictContextVersion(
        group.agenda,
        group.ownedEvent,
        otherEvents,
        input.analysis.sourceStatus,
        input.analysis.sourceWarningCodes,
      );
      const localDay = calendarConflictLocalDay(group.ownedEvent.start, input.timezone);
      const calendarResourceId = `primary:${localDay}`;
      const executionExclusivityKey = `calendar_timeline:${input.tenantId}:${localDay}`;
      const candidate = buildNormalizedDecisionAction({
        intent: 'review_calendar_conflict',
        targetEntities: [{
          type: 'secretary_agenda_item',
          id: group.agenda.agendaItemId,
          version: String(group.agenda.version),
        }],
        affectedResources: [{ type: 'calendar_day', id: calendarResourceId }],
        requestedWindow: { start: group.ownedEvent.start, end: group.ownedEvent.end, timezone: input.timezone },
        preconditions: [{
          type: 'agenda_state',
          ref: group.agenda.agendaItemId,
          expectedVersion: secretaryAgendaStateRevision(group.agenda),
          required: true,
        }],
        expectedEffects: [{ type: 'review_required', targetRef: `secretary_agenda_item:${group.agenda.agendaItemId}` }],
        prohibitedEffects: [{ type: 'automatic_calendar_mutation', targetRef: `secretary_agenda_item:${group.agenda.agendaItemId}` }],
        dependencies: [],
        // This is an execution-serialization key, not a semantic identity. It
        // is tenant and local-day scoped so unrelated dates never compete.
        exclusivityKeys: [executionExclusivityKey],
        authorizationScope: ['decision_center:read'],
        risk: 'medium',
        reversibility: 'reversible',
        contextVersion,
      });
      const conflictComparisons: ConflictComparisonAction[] = otherEvents.map((otherEvent) => ({
        action: buildNormalizedDecisionAction({
          intent: 'preserve_confirmed_calendar_commitment',
          targetEntities: [{ type: 'calendar_event', id: opaqueCalendarEventRef(otherEvent, input.tenantId) }],
          affectedResources: [{ type: 'calendar_day', id: calendarResourceId }],
          requestedWindow: { start: otherEvent.start, end: otherEvent.end, timezone: input.timezone },
          preconditions: [],
          expectedEffects: [{ type: 'preserve_commitment', targetRef: opaqueCalendarEventRef(otherEvent, input.tenantId) }],
          prohibitedEffects: [],
          dependencies: [],
          exclusivityKeys: [executionExclusivityKey],
          authorizationScope: ['calendar:read'],
          risk: 'medium',
          // Replacing a confirmed external commitment has no registered
          // compensation adapter; precedence must treat it conservatively.
          reversibility: 'irreversible',
          contextVersion,
        }),
        authority: 'approved_commitment',
        approved: true,
        // Comparison freshness is when this authoritative calendar snapshot
        // was observed, not the future start time of the commitment itself.
        createdAt: (input.evaluatedAt ?? new Date()).toISOString(),
        validUntil: otherEvent.end,
      }));
      const evaluation = evaluateDecisionConflicts({
        candidate,
        existing: conflictComparisons,
        now: input.evaluatedAt ?? new Date(),
        confidence: input.analysis.sourceStatus === 'degraded'
          ? 'medium'
          : group.agenda.providerSyncState === 'synced' ? 'high' : 'medium',
        authorizationAllowed: true,
      });
      const relevantTimes = [group.ownedEvent, ...otherEvents];
      return [{
        agenda: group.agenda,
        ownedEvent: group.ownedEvent,
        conflictPairs: entries.map(([, entry]) => entry.pair),
        representedPairKeys: entries.map(([pairKey]) => pairKey),
        candidate,
        conflictComparisons,
        evaluation,
        contextVersion,
        deadlineAt: new Date(Math.min(...relevantTimes.map((event) => Date.parse(event.start)))).toISOString(),
        expiresAt: new Date(Math.max(...relevantTimes.map((event) => Date.parse(event.end)))).toISOString(),
      }];
    });
}

async function emitSecretaryOwnedCalendarConflictDecisions(
  target: ActiveUserTarget,
  analysis: CalendarConflictAnalysis,
  persist = true,
): Promise<Set<string>> {
  const handledPairs = new Set<string>();
  let agendaItems: SecretaryAgendaItem[];
  try {
    agendaItems = listSecretaryAgendaItems({
      ownerUserId: target.tenantId,
      tenantId: target.tenantId,
      includeInactive: false,
    });
  } catch (err) {
    // Runtime self-healing can briefly expose a notification schema before the
    // Secretary agenda schema is available. Fail back to the existing generic,
    // informational conflict notification instead of aborting the whole cron.
    logger.warn({ err, tenantId: target.tenantId }, 'Secretary agenda unavailable for calendar conflict classification');
    return handledPairs;
  }
  const timezone = getUserTimezoneById(target.tenantId) || config.app.timezone;
  const plans = buildSecretaryCalendarConflictDecisionPlans({
    tenantId: target.tenantId,
    analysis,
    agendaItems,
    timezone,
    evaluatedAt: now().toJSDate(),
  });

  for (const plan of plans) {
    const pairMessage = formatCalendarConflictMessage(plan.conflictPairs, analysis.dateLabel, timezone);

    if (!persist) {
      logger.info({
        event: 'decision.conflict_evaluated',
        mode: 'shadow',
        tenantId: target.tenantId,
        disposition: plan.evaluation.disposition,
        conflictClasses: plan.evaluation.findings.map((finding) => finding.class),
        representedConflictCount: plan.representedPairKeys.length,
      }, 'Secretary calendar conflict shadow evaluation completed');
      continue;
    }

    try {
      const result = await createDecisionIntent({
        userId: target.tenantId,
        tenantId: target.tenantId,
        sourceSkill: 'secretary',
        type: 'conflict_detected',
        priority: 'active',
        relatedEntityId: plan.agenda.agendaItemId,
        relatedEntityType: 'secretary_agenda_item',
        title: 'Calendar commitments overlap',
        body: `${plan.conflictComparisons.length === 1
          ? 'A Secretary-owned agenda item overlaps a confirmed calendar commitment.'
          : `A Secretary-owned agenda item overlaps ${plan.conflictComparisons.length} confirmed calendar commitments.`}${analysis.sourceStatus === 'degraded'
          ? ' One connected calendar was unavailable, so review the full calendar before acting.'
          : ''}`,
        sensitiveBody: pairMessage.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
        actionButtons: [{ id: 'open_detail', label: 'Review commitments', style: 'primary' }],
        deeplink: `nexus://secretary/conflict/${plan.agenda.agendaItemId}`,
        expiresAt: plan.expiresAt,
        dedupeKey: `secretary:calendar-conflict-preview:${plan.agenda.agendaItemId}:${plan.contextVersion}`,
        requiresUserAction: true,
        decisionDeadline: plan.deadlineAt,
        decisionContext: {
          // Keep user-authored agenda copy out of the structured policy/audit
          // context. The authenticated sensitive body remains the presentation
          // surface; policy works only with opaque agenda/event identifiers.
          entityTitle: 'Secretary agenda item',
          currentStartAt: plan.ownedEvent.start,
          currentEndAt: plan.ownedEvent.end,
          reasonCodes: [
            'calendar_time_overlap',
            'approved_commitment_requires_review',
            'preview_only',
            ...(analysis.sourceStatus === 'degraded' ? ['calendar_partial_provider_failure'] : []),
          ],
          sourceState: analysis.sourceStatus === 'degraded'
            ? 'conflict_detected_partial_context'
            : 'conflict_detected',
          providerName: plan.agenda.providerSource,
          providerSyncState: plan.agenda.providerSyncState,
          providerSyncUpdatedAt: plan.agenda.updatedAt,
          contextObservedAt: plan.agenda.updatedAt,
          contextExpiresAt: plan.deadlineAt,
          timezone,
          recipe: 'calendar_conflict_preview_v1',
          normalizedAction: plan.candidate,
          conflictComparisons: plan.conflictComparisons,
          conflictEvaluation: plan.evaluation,
        },
        quietHoursPolicy: 'respect',
        deliveryPolicy: 'in_app_only',
        privacyPolicy: 'sensitive',
      });
      const safelyHandledWithoutNewItem = (result.eligibility.reasons ?? []).some((reason) =>
        reason === 'conflict_policy:duplicate' || reason === 'candidate_rejection_cooldown');
      if (result.item || safelyHandledWithoutNewItem) {
        for (const pairKey of plan.representedPairKeys) handledPairs.add(pairKey);
        logger.info({
          tenantId: target.tenantId,
          disposition: plan.evaluation.disposition,
          conflictClasses: plan.evaluation.findings.map((finding) => finding.class),
          representedConflictCount: plan.representedPairKeys.length,
          suppressedWithoutNewItem: safelyHandledWithoutNewItem,
        }, safelyHandledWithoutNewItem
          ? 'Secretary calendar conflict was already represented; generic fallback suppressed'
          : 'Secretary calendar conflict evaluated and persisted for Decision Center review');
      }
    } catch (err) {
      logger.warn({ err, tenantId: target.tenantId }, 'Secretary-owned calendar conflict decision emit failed');
    }
  }

  return handledPairs;
}

async function emitGenericCalendarConflictNotification(
  target: ActiveUserTarget,
  conflicts: CalendarConflictPair[],
  dateLabel: string,
  localDate: string,
  sourceStatus: UnifiedCalendarFetchStatus,
  timezone = config.app.timezone,
): Promise<void> {
  if (conflicts.length === 0) return;
  const message = formatCalendarConflictMessage(conflicts, dateLabel, timezone);
  const conflictSignature = createHash('sha256')
    .update(message.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    .digest('hex')
    .slice(0, 16);

  await createNotificationIntent({
    userId: target.tenantId,
    tenantId: target.tenantId,
    sourceSkill: 'secretary',
    type: 'conflict_detected',
    priority: 'time_sensitive',
    relatedEntityId: `conflict-detection-${localDate}-${conflictSignature}`,
    relatedEntityType: 'calendar_conflict',
    title: 'Schedule conflict detected',
    body: sourceStatus === 'degraded'
      ? 'Schedule conflict needs review. One connected calendar was unavailable, so this is a partial view.'
      : 'Schedule conflict needs review.',
    sensitiveBody: message.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    actionButtons: [{ id: 'open_detail', label: 'Review', style: 'primary' }],
    deeplink: 'nexus://secretary/conflict/daily',
    dedupeKey: `secretary:conflict_detection:${target.tenantId}:${localDate}:${conflictSignature}`,
    // External-only conflicts are informational because Nexus cannot prove
    // ownership or safely offer a mutation. Secretary-owned conflicts use the
    // Decision Center proposal funnel above and do require review.
    requiresUserAction: false,
    decisionDeadline: new Date(Date.now() + 3 * 3_600_000).toISOString(),
    decisionContext: {
      entityTitle: 'Daily schedule conflict',
      sourceState: sourceStatus === 'degraded'
        ? 'conflict_detected_partial_context'
        : 'conflict_detected',
      reasonCodes: sourceStatus === 'degraded' ? ['calendar_partial_provider_failure'] : [],
      deadlineAt: new Date(Date.now() + 3 * 3_600_000).toISOString(),
      explicitNoRelatedEntityReason: null,
    },
    quietHoursPolicy: 'allow_time_sensitive',
    privacyPolicy: 'sensitive',
  });
}

function agendaForCalendarEvent(
  event: UnifiedCalendarEvent,
  agendaItems: SecretaryAgendaItem[],
): SecretaryAgendaItem | null {
  return agendaItems.find((agenda) => agenda.providerEventId === event.id
    && (!agenda.providerSource || agenda.providerSource === event.source)) ?? null;
}

function calendarConflictContextVersion(
  agenda: SecretaryAgendaItem,
  ownedEvent: UnifiedCalendarEvent,
  otherEvents: UnifiedCalendarEvent[],
  sourceStatus: UnifiedCalendarFetchStatus,
  sourceWarningCodes: string[],
): string {
  const orderedOthers = otherEvents
    .map((event) => [event.source, event.id, event.start, event.end])
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return `ctx_${createHash('sha256').update(JSON.stringify({
    agendaItemId: agenda.agendaItemId,
    agendaVersion: agenda.version,
    sourceShapeHash: agenda.sourceShapeHash,
    owned: [ownedEvent.source, ownedEvent.id, ownedEvent.start, ownedEvent.end],
    others: orderedOthers,
    sourceStatus,
    sourceWarningCodes: [...sourceWarningCodes].sort(),
  })).digest('hex').slice(0, 24)}`;
}

function calendarConflictLocalDay(startAt: string, timezone: string): string {
  const local = DateTime.fromISO(startAt, { setZone: true }).setZone(timezone);
  if (local.isValid && local.toISODate()) return local.toISODate()!;
  const utcFallback = DateTime.fromISO(startAt, { zone: 'utc' }).toISODate();
  // Calendar conflict analysis has already rejected invalid windows. Keep a
  // stable final fallback so a bad profile timezone cannot create one global
  // serialization key shared by unrelated dates.
  return utcFallback ?? startAt.slice(0, 10);
}

function formatCalendarConflictTime(value: string, timezone: string): string {
  const instant = DateTime.fromISO(value, { setZone: true }).setZone(timezone);
  if (instant.isValid) return instant.toFormat('HH:mm');
  return formatTime(value);
}

function opaqueCalendarEventRef(event: UnifiedCalendarEvent, tenantId: number): string {
  const hmacSecret = process.env.CHAT_CORE_V2_DECISION_EVIDENCE_HMAC_SECRET?.trim() ?? '';
  if (!hmacSecret) throw new Error('SECRETARY_DECISION_PREVIEW_HMAC_SECRET_REQUIRED');
  return hmacTenantScopedEvidenceFingerprint({
    tenantId: String(tenantId),
    hmacSecret,
    sourceType: 'calendar_event',
    sourceValue: `${event.source}:${event.id}`,
  });
}

export function startScheduler(): void {
  // Register sub-skill gating so disabled sub-skills skip their cron jobs
  setJobEnabledChecker(isCronJobEnabled);

  // Delivery paths (Telegram legacy delivery removed 2026-07):
  //   - durable reports (report-document-store)
  //   - durable notifications (content-notification-store)
  //   - APNs push
  //   - portal events / telemetry

  // Register failure notifier — records a critical operator alert
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
  });

  const tz = config.app.timezone;

  // dailyCron/coachCron expression builders removed 2026-07-03: the four
  // user-facing report jobs run on 5-minute dispatch ticks and fire per user
  // at the profile-preferred time (report-schedule-dispatcher.ts).
  // config.todo.digestTime / config.garmin.coachTime remain the defaults.
  const backupCron = (() => {
    const [h, m] = config.backup.time.split(':').map(Number);
    return `${m ?? 0} ${h ?? 3} * * *`;
  })();

  // ── Register all jobs for portal tracking ──────────────────────────
  registerJob('reminders',          'Reminders',             '* * * * *',       'secretary');
  registerJob('end_of_day',         'End-of-Day Summary',    '*/5 * * * *',     'secretary');
  registerJob('daily_briefing',     'Morning Briefing',      '*/5 * * * *',     'secretary');
  registerJob('weekly_review',      'Weekly Review',         '*/5 * * * *',     'secretary');
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
  registerJob('garmin_keepalive',   'Garmin Keep-Alive',     '5,35 * * * *',    'triathlon');
  registerJob('garmin_coach',       'Garmin Coach',          '*/5 * * * *',     'triathlon');
  registerJob('garmin_tenant_isolation_watcher', 'Garmin Tenant Isolation Watcher', '45 6 * * *', 'triathlon');
  registerJob('invoice_queue',      'Invoice Queue Flush',   '*/15 * * * *',    'invoices');
  registerJob('channel_relearn',   'Channel Re-Learn',      '37 3 * * 0',       'content');
  registerJob('tuesday_reels',     'Tuesday Reel Topics',   '17 9 * * 2',       'content');
  registerJob('thursday_youtube',  'Thursday YT Topic',     '23 9 * * 4',       'content');
  registerJob('friday_weekly',     'Friday Weekly Package',  '41 18 * * 5',     'content');
  registerJob('pipeline_agent',   'Pipeline Tracker',       '0 20 * * *',      'content');
  registerJob('performance_agent','Performance Intel',        '0 6 * * 0',       'content');
  registerJob('voice_evolution', 'Voice Evolution',          '0 4 1 * *',       'content');
  registerJob('reaction_radar',   'Reaction Radar',          '0 8,14,20 * * *', 'content');
  registerJob('seo_agent',        'SEO Tracking',           '0 6 * * 1',       'content');
  registerJob('expire_signals',   'Signal Cleanup',         '0 * * * *',       'content');
  registerJob('integration_health', 'Integration Health Probes', '*/15 * * * *', 'system');
  registerJob('training_plan_adjust', 'Training Plan Auto-Adjust', '0 19 * * 0', 'triathlon');
  registerJob('autoresearch',     'Autoresearch',           '19 1 * * 0',       'system');
  registerJob('db_backup',        'Database Backup',        backupCron,        'system', 'backupCron');
  registerJob('db_restore_test', 'Weekly Restore Test',   '0 4 * * 0',       'system');
  registerJob('task_sync',        'Task Provider Sync',     '*/15 * * * *',    'system');
  registerJob('operator_alert_delivery', 'Operator Alert Delivery', '* * * * *', 'system');
  registerJob('decision_source_supersession', 'Decision Source Supersession', '*/15 * * * *', 'system');
  registerJob('decision_daily_attention', 'Decision Daily Attention Materialization', '12 * * * *', 'system');
  registerJob('decision_handled_history_backfill', 'Decision Handled History Backfill', '22,52 * * * *', 'system');
  registerJob('decision_expiry', 'Decision Expiry Sweep', '*/10 * * * *', 'system');
  registerJob('decision_metrics_rollup', 'Decision Metrics Daily Rollup', '15 0 * * *', 'system');
  registerJob('decision_ledger_retention_prune', 'Decision Ledger Retention Prune', '40 4 * * *', 'system');
  registerJob('chat_action_plan_expiry', 'Chat Action Plan Expiry', '*/2 * * * *', 'system');
  registerJob('chat_action_run_zombie_reaper', 'Chat Action Run Zombie Reaper', '*/5 * * * *', 'system');
  registerJob('chat_action_fixer_worker', 'Chat Action Fixer Worker', '* * * * *', 'system');
  registerJob('chat_action_run_retention', 'Chat Action Run Retention', '20 0 * * *', 'system');
  registerJob('event_backbone_worker', 'Event Backbone Worker', '* * * * *', 'system');
  registerJob('event_backbone_cleanup', 'Event Backbone Cleanup', '10 0 * * *', 'system');
  registerJob('nexus_points_expiry', 'Nexus Points Expiry Sweep', '0 4 * * *', 'system');
  if (resolveChatCoreV2ActivationConfig(process.env).mode !== 'off' && isChatCoreV2AutoRevertEvalCronEnabled(process.env)) {
    registerJob('chat_v2_auto_revert_eval', 'Chat Core v2 Auto-Revert Eval', '*/5 * * * *', 'system');
  }
  if (resolveChatCoreV2ActivationConfig(process.env).mode !== 'off') {
    registerJob('chat_v2_gate_check', 'Chat Core v2 Shadow Gate Check', '37 * * * *', 'system');
  }
  registerJob('classify_shadow_prune', 'Classify Shadow Retention Prune', '17 4 * * *', 'system');
  registerJob('dst_watchdog', 'DST Watchdog', '2,17,32,47 * * * *', 'system');
  registerJob('notification_release', 'Notification delayed/digest release', '*/15 * * * *', 'system');
  registerJob('decision_center_smoke_cleanup', 'Decision Center Smoke Cleanup', '7,37 * * * *', 'system');

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
        const targetTenantId = Number((reminder as any).tenant_id) || targetUserId;
        const reminderOccurrence = (() => {
          const remindAt = String((reminder as any).remind_at || '');
          const parsed = DateTime.fromISO(remindAt, { setZone: true });
          if (parsed.isValid) return String(parsed.toUTC().toMillis());
          const fallback = Date.parse(remindAt);
          return Number.isFinite(fallback) ? String(fallback) : (remindAt || 'unknown');
        })();
        let delivered = false;
        try {
          // iOS notification. The Secretary Notification Orchestrator
          // decides push vs in-app vs quiet-hours/digest; scheduler only emits
          // the intent.
          try {
            await createNotificationIntent({
              userId: targetUserId,
              tenantId: targetTenantId,
              sourceSkill: 'secretary',
              type: 'reminder',
              priority: 'active',
              relatedEntityId: reminder.id,
              relatedEntityType: 'reminder',
              title: 'Reminder',
              body: reminder.message,
              sensitiveBody: reminder.message,
              actionButtons: [
                { id: 'open_detail', label: 'Open', style: 'primary' },
                { id: 'snooze', label: 'Snooze', style: 'secondary' },
                { id: 'dismiss', label: 'Dismiss', style: 'secondary' },
              ],
              deeplink: `nexus://notifications/reminder-${reminder.id}`,
              dedupeKey: `secretary:reminder:${targetTenantId}:${targetUserId}:${reminder.id}:${reminderOccurrence}`,
              privacyPolicy: 'sensitive',
            });
            delivered = true;
          } catch (err) {
            logger.error({
              err,
              userId: targetUserId,
              tenantId: targetTenantId,
              reminderId: reminder.id,
            }, 'Reminder notification orchestration failed');
          }
        } catch (err) {
          logger.error({
            err,
            userId: targetUserId,
            tenantId: targetTenantId,
            reminderId: reminder.id,
          }, 'Reminder delivery failed');
        }
        if (delivered) {
          try {
            markReminderFired(reminder.id);
          } catch (err) {
            logger.error({
              err,
              userId: targetUserId,
              tenantId: targetTenantId,
              reminderId: reminder.id,
            }, 'Failed to mark reminder fired after delivery attempt');
          }
        } else {
          logger.warn({
            userId: targetUserId,
            tenantId: targetTenantId,
            reminderId: reminder.id,
          }, 'Reminder delivery failed on all channels; not marking fired');
        }
      }
    } finally {
      remindersJobInFlight = false;
    }
  }));

  // ── End-of-day task summary (21:00) ────────────────────────────────
  // Per-user schedule (migration 225): a 5-minute dispatch tick fires each
  // user at their preferred end-of-day time in their own timezone (default
  // 21:00). Idle ticks return 'skipped' so job_history stays quiet.
  cron.schedule('*/5 * * * *', wrapJob('end_of_day', async () => {
    const due = resolveDueReportTargets('end_of_day', getActiveUserTargets());
    if (due.length === 0) return 'skipped';
    for (const target of due) {
      try {
        await runEndOfDaySummaryForTarget(target);
      } catch (err) {
        logger.error({ err, userId: target.tenantId }, 'End-of-day summary failed for user; continuing');
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
  // Per-user schedule (migration 225): default remains TODO_DIGEST_TIME
  // until a user picks their own morning time.
  cron.schedule('*/5 * * * *', wrapJob('daily_briefing', async () => {
    if (!config.todo.digestEnabled) return 'skipped';
    const due = resolveDueReportTargets('morning_briefing', getActiveUserTargets());
    if (due.length === 0) return 'skipped';
    for (const target of due) {
      try {
        await sendDailyBriefingForTarget(target);
      } catch (err) {
        logger.error({ err, userId: target.tenantId }, 'Morning briefing failed for user; continuing');
      }
    }
  }), { timezone: tz });

  // ── Weekly review (Friday 17:00) ───────────────────────────────────
  //
  // Same shape as daily_briefing: sendWeeklyReview already pushes via
  // storeAndPushReport with the reportId. The duplicate terse push
  // that used to live here has been removed.
  // Per-user schedule (migration 225): default remains Friday 17:00; the
  // profile can move both the day (cron 0=Sun..6=Sat) and the time.
  cron.schedule('*/5 * * * *', wrapJob('weekly_review', async () => {
    const due = resolveDueReportTargets('weekly_review', getActiveUserTargets());
    if (due.length === 0) return 'skipped';
    for (const target of due) {
      try {
        await sendWeeklyReviewForTarget(target);
      } catch (err) {
        logger.error({ err, userId: target.tenantId }, 'Weekly review failed for user; continuing');
      }
    }
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
    // Revoke device tokens with no activity signal in 90 days (registration
    // or successful APNs delivery both refresh last_seen_at). 2026-07-04
    // APNs round; NOTIFICATION_TOKEN_STALE_DAYS=0 disables.
    try {
      const { pruneStaleDeviceTokens } = require('./notification-orchestrator');
      pruneStaleDeviceTokens();
    } catch (err) {
      logger.warn({ err }, '[scheduler] stale device token pruning failed');
    }

    msTodo.clearSelfCreatedTasks();
    todayNotifications.length = 0;
    logger.info('Cleared self-created task cache and daily notifications');

    const retentionTargets: Array<{ table: string; days: number; tsCol: string }> = [
      { table: 'video_transcripts', days: 90, tsCol: 'created_at' },
      { table: 'job_history',       days: 30, tsCol: 'ts' },
      { table: 'report_schedule_ledger', days: 30, tsCol: 'fired_at' },
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

    runChatCoreV2ShadowDataRetention();
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
      const { runTaskMutationSyncBatch } = require('./task-store/task-mutation-sync-worker');
      const { runTaskProviderLinkReconciliation } = require('./task-store/task-reconciliation-job');
      const users = getActiveUserIds();
      const taskSyncScopes = getActiveTaskSyncScopes(users);
      if (taskSyncScopes.length === 0) return 'skipped';

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
      let mutationProcessedTotal = 0;
      let reconciledTotal = 0;
      for (let i = 0; i < taskSyncScopes.length; i += CONCURRENCY) {
        const batch = taskSyncScopes.slice(i, i + CONCURRENCY);
        const settled = await Promise.allSettled(
          batch.map(async (scope) => {
            try {
              const mutationResult = await runTaskMutationSyncBatch({
                tenantId: scope.tenantId,
                userId: scope.userId,
                limit: 25,
              });
              const results = scope.importProviders ? await syncAllProviders(scope.userId) : [];
              const reconciliationResult = await runTaskProviderLinkReconciliation({
                tenantId: scope.tenantId,
                userId: scope.userId,
                limit: 50,
              });
              const upserted = results.reduce((s: number, r: any) => s + (r.tasksUpserted || 0), 0);
              return {
                userId: scope.userId,
                tenantId: scope.tenantId,
                upserted,
                providers: results.length,
                mutationsProcessed: mutationResult.processed,
                reconciledLinks: reconciliationResult.scannedLinks,
              };
            } catch (err) {
              logger.warn({ err, userId: scope.userId, tenantId: scope.tenantId }, 'Task sync failed for user scope');
              return { userId: scope.userId, tenantId: scope.tenantId, upserted: 0, providers: 0, mutationsProcessed: 0, reconciledLinks: 0 };
            }
          }),
        );
        for (const s of settled) {
          if (s.status === 'fulfilled') {
            upsertedTotal += s.value.upserted;
            mutationProcessedTotal += s.value.mutationsProcessed;
            reconciledTotal += s.value.reconciledLinks;
            if (s.value.upserted > 0 || s.value.mutationsProcessed > 0 || s.value.reconciledLinks > 0) {
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
      if (upsertedTotal > 0 || mutationProcessedTotal > 0 || reconciledTotal > 0) {
        logger.info({ upsertedTotal, mutationProcessedTotal, reconciledTotal }, 'Task sync cron completed');
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
      const { syncSecretaryAgendaItemsToProvider, markCompletedSecretaryAgendaItems } = require('./secretary-agenda-provider-sync');
      const { createUnifiedCalendarSecretaryProviderAdapter } = require('./secretary-unified-calendar-provider-adapter');
      const { reconcileOrphanedTrainingAgendaEvents } = require('./training-agenda-reconciliation');
      const googleCal = require('./google-calendar');
      const outlookCal = require('./outlook-calendar');
      const users = getActiveUserIds();
      if (users.length === 0) return 'skipped';

      // Sweep past items out of the active set first. Without this the
      // active set grows without bound and every past item keeps costing
      // sync-eligibility checks each tick (the sweep existed since the
      // provider-sync service shipped but was never wired into the cron).
      const completedSwept = markCompletedSecretaryAgendaItems();
      if (completedSwept > 0) {
        logger.info({ completedSwept }, '[scheduler] secretary_agenda_sync marked past agenda items completed');
      }

      const PER_USER_CAP = 50;
      const CONCURRENCY = 4;
      let syncedTotal = 0;
      let readbackFailedTotal = 0;
      let reconciledTrainingAgendaTotal = 0;

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
            let userReconciledTrainingAgenda = 0;
            try {
              const reconciliation = await reconcileOrphanedTrainingAgendaEvents(userId, userId);
              userReconciledTrainingAgenda = reconciliation.deleted;
              if (reconciliation.attempted > 0) {
                logger.info(
                  {
                    userId,
                    attempted: reconciliation.attempted,
                    deleted: reconciliation.deleted,
                    failed: reconciliation.failed,
                  },
                  '[scheduler] secretary_agenda_sync reconciled stale Training calendar events',
                );
              }
            } catch (err) {
              logger.warn({ err, userId }, '[scheduler] secretary_agenda_sync training reconciliation failure');
            }
            for (const source of sources) {
              try {
                const adapter = createUnifiedCalendarSecretaryProviderAdapter(source);
                const results = await syncSecretaryAgendaItemsToProvider(
                  { ownerUserId: userId, tenantId: userId, includeInactive: false },
                  adapter,
                );
                // Bound the work this tick: take at most PER_USER_CAP results.
                // Remaining items are picked up next tick. Unchanged 'synced'
                // rows are short-circuited by the last_synced_fingerprint
                // check inside the sync function (migration 224) and re-
                // verified against the provider every
                // SECRETARY_SYNC_VERIFY_INTERVAL_MINUTES (default 6h).
                const bounded = results.slice(0, PER_USER_CAP);
                for (const r of bounded) {
                  if (r.providerSyncState === 'synced') userSynced += 1;
                  if (r.providerSyncState === 'readback_failed') userReadbackFailed += 1;
                }
              } catch (err) {
                logger.warn({ err, userId, source }, '[scheduler] secretary_agenda_sync per-user/source failure');
              }
            }
            return { userId, synced: userSynced, readbackFailed: userReadbackFailed, reconciledTrainingAgenda: userReconciledTrainingAgenda };
          }),
        );
        for (const s of settled) {
          if (s.status === 'fulfilled' && !s.value.skipped) {
            syncedTotal += s.value.synced;
            readbackFailedTotal += s.value.readbackFailed;
            reconciledTrainingAgendaTotal += s.value.reconciledTrainingAgenda ?? 0;
          } else if (s.status === 'rejected') {
            logger.warn({ reason: s.reason }, '[scheduler] secretary_agenda_sync batch rejection');
          }
        }
      }
      if (syncedTotal > 0 || readbackFailedTotal > 0 || reconciledTrainingAgendaTotal > 0) {
        logger.info(
          { syncedTotal, readbackFailedTotal, reconciledTrainingAgendaTotal, userCount: users.length },
          '[scheduler] secretary_agenda_sync complete',
        );
      }
    } catch (err) {
      logger.warn({ err }, '[scheduler] secretary_agenda_sync cron failed');
    }
  }), { timezone: tz });

  // Daily cross-domain context cron removed 2026-07-03: nothing consumed the
  // 5 AM pre-build (the morning briefing never read this cache, contrary to
  // the old comment here), and mid-day cache invalidations left chat without
  // context until the next rebuild. Chat read sites now lazy-build via
  // context-engine getOrBuildDailyContext on first use.

  // Old content_discovery (16:43) removed — replaced by content-workflow (Tue/Thu/Fri)

  // ── Monthly invoice collection (1st at 09:00) ─────────────────────
  cron.schedule('0 9 1 * *', wrapJob('invoice_collection', async () => {
    if (!config.invoices.monthlyCollectionEnabled || !isInvoiceFilingConfigured()) return;

    const prev = now().minus({ months: 1 });
    const ownerTenantIds = getOwnerTenantIds();
    for (const tenantId of ownerTenantIds) {
      try {
        const result = await collectMonthlyInvoices(tenantId, prev.year, prev.month);
        const notification = formatCollectionNotification(result);
        // GAP-CAL-1 fix: durable in-app notification; Telegram was a no-op.
        try {
          await createNotificationIntent({
            userId: tenantId,
            tenantId,
            sourceSkill: 'finance',
            type: 'insight',
            priority: 'passive',
            relatedEntityId: `invoice_collection:${prev.year}-${prev.month}`,
            relatedEntityType: 'finance_collection_run',
            title: 'Invoice collection finished',
            body: `Monthly invoice collection for ${prev.month}/${prev.year} finished.`,
            sensitiveBody: safeHtmlNotificationBody(notification),
            deeplink: 'nexus://finance/invoices',
            dedupeKey: `finance:invoice_collection:${tenantId}:${prev.year}-${prev.month}`,
            privacyPolicy: 'financial',
          });
        } catch (err) {
          logger.warn({ err, tenantId }, 'Failed to create finance collection notification intent');
        }
      } catch (err) {
        logger.error({ err, tenantId }, 'Invoice collection failed for tenant; continuing scheduler run');
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
      try {
        const callbacks = createScraperMfaInteractiveCallbacks({
          userId: tenantId,
          tenantId,
          source: 'amazon',
        });
        const result = await collectAmazonInvoices(
          tenantId,
          prev.year,
          prev.month,
          callbacks.sendMessage,
          callbacks.sendScreenshot,
          callbacks.waitForReply,
        );
        const notification = formatAmazonNotification(result);
        // GAP-CAL-1 fix: durable in-app notification; Telegram was a no-op.
        try {
          await createNotificationIntent({
            userId: tenantId,
            tenantId,
            sourceSkill: 'finance',
            type: 'insight',
            priority: 'passive',
            relatedEntityId: `amazon_collection:${prev.year}-${prev.month}`,
            relatedEntityType: 'finance_collection_run',
            title: 'Amazon invoice collection finished',
            body: `Amazon invoice collection for ${prev.month}/${prev.year} finished.`,
            sensitiveBody: safeHtmlNotificationBody(notification),
            deeplink: 'nexus://finance/invoices',
            dedupeKey: `finance:amazon_collection:${tenantId}:${prev.year}-${prev.month}`,
            privacyPolicy: 'financial',
          });
        } catch (err) {
          logger.warn({ err, tenantId }, 'Failed to create finance collection notification intent');
        }
      } catch (err) {
        logger.error({ err, tenantId }, 'Amazon collection failed for tenant; continuing scheduler run');
      }
    }
  }), { timezone: tz });

  // ── Uber collection (1st at 09:30) ────────────────────────────────
  cron.schedule('30 9 1 * *', wrapJob('uber_collection', async () => {
    if (!config.invoices.uberEnabled || !isUberConfigured() || !isInvoiceFilingConfigured()) return;

    const prev = now().minus({ months: 1 });
    const ownerTenantIds = getOwnerTenantIds();
    for (const tenantId of ownerTenantIds) {
      try {
        const callbacks = createScraperMfaInteractiveCallbacks({
          userId: tenantId,
          tenantId,
          source: 'uber',
        });
        const result = await collectUberInvoices(
          tenantId,
          prev.year,
          prev.month,
          callbacks.sendMessage,
          callbacks.sendScreenshot,
          callbacks.waitForReply,
        );
        const notification = formatUberNotification(result);
        // GAP-CAL-1 fix: durable in-app notification; Telegram was a no-op.
        try {
          await createNotificationIntent({
            userId: tenantId,
            tenantId,
            sourceSkill: 'finance',
            type: 'insight',
            priority: 'passive',
            relatedEntityId: `uber_collection:${prev.year}-${prev.month}`,
            relatedEntityType: 'finance_collection_run',
            title: 'Uber receipt collection finished',
            body: `Uber receipt collection for ${prev.month}/${prev.year} finished.`,
            sensitiveBody: safeHtmlNotificationBody(notification),
            deeplink: 'nexus://finance/invoices',
            dedupeKey: `finance:uber_collection:${tenantId}:${prev.year}-${prev.month}`,
            privacyPolicy: 'financial',
          });
        } catch (err) {
          logger.warn({ err, tenantId }, 'Failed to create finance collection notification intent');
        }
      } catch (err) {
        logger.error({ err, tenantId }, 'Uber collection failed for tenant; continuing scheduler run');
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

      // GAP-CAL-1 fix: durable in-app notification; Telegram was a no-op.
      for (const userId of getOwnerUserIds()) {
        try {
          await createNotificationIntent({
            userId,
            tenantId: userId,
            sourceSkill: 'secretary',
            type: 'insight',
            priority: 'passive',
            relatedEntityId: `fossa_email:${new Date().toISOString().slice(0, 10)}`,
            relatedEntityType: 'secretary_automated_email',
            title: 'Automated email sent',
            body: `Fossa septica cleaning request emailed to ${fossaTo}. Next send in 2 weeks.`,
            deeplink: 'nexus://secretary/agenda',
            dedupeKey: `secretary:fossa_email:${userId}:${new Date().toISOString().slice(0, 10)}`,
            privacyPolicy: 'standard',
          });
        } catch (err) {
          logger.warn({ err, userId }, 'Failed to create fossa email notification intent');
        }
      }
    }), { timezone: tz });
  }

  // ── Conflict detection (19:30) ─────────────────────────────────────
  cron.schedule('30 19 * * *', wrapJob('conflict_detection', async () => {
    for (const target of getActiveUserTargets()) {
      try {
        const analysis = await buildCalendarConflictAnalysisForUser(target.tenantId);
        if (!analysis) continue;

        let genericConflicts = analysis.conflicts;
        const conflictMode = getDecisionConflictPolicyV1Mode(process.env, {
          userId: target.tenantId,
          tenantId: target.tenantId,
        });
        if (conflictMode !== 'off') {
          const handledPairs = await emitSecretaryOwnedCalendarConflictDecisions(target, analysis, conflictMode === 'active');
          genericConflicts = analysis.conflicts.filter(
            (pair) => !handledPairs.has(conflictPairKey(pair.first, pair.second)),
          );
        }

        await emitGenericCalendarConflictNotification(
          target,
          genericConflicts,
          analysis.dateLabel,
          analysis.date,
          analysis.sourceStatus,
          analysis.timezone ?? getUserTimezoneById(target.tenantId) ?? config.app.timezone,
        );
      } catch (err) {
        logger.warn({ err, tenantId: target.tenantId }, 'Conflict detection failed for one user; continuing remaining users');
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
    // Per-user schedule (migration 225): default remains GARMIN_COACH_TIME
    // until a user picks their own coach time. Garmin pre-auth runs only on
    // ticks where at least one user is actually due.
    cron.schedule('*/5 * * * *', wrapJob('garmin_coach', async () => {
      // Eligibility runs BEFORE the ledger claim: a user with no health data
      // yet is left unclaimed and re-checked on
      // every tick inside the catch-up window, so a late Apple Health sync
      // still gets that day's briefing instead of losing it to a consumed
      // claim (QA finding 3). The same gates remain inside
      // sendCoachBriefingForTarget as the backstop for manual triggers.
      const due = resolveDueReportTargets('coach_briefing', getActiveUserTargets(), undefined, {
        eligible: (target) =>
          hasPaidCoachBriefingEntitlement(target.tenantId)
          && hasActiveCoachWorkoutPlan(target.tenantId)
          && hasCoachableHealthDataForUser(target.tenantId),
      });
      if (due.length === 0) return 'skipped';
      if (isGarminConfigured()) {
        logger.info('Coach briefing dispatch — pre-authenticating Garmin (silent mode — no MFA email if session is dead)');
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
        logger.info('Coach briefing dispatch without global Garmin; users with Apple Health or other wearable data can still receive scoped briefings');
      }
      for (const target of due) {
        try {
          await runScheduledCoachBriefingForTarget(target);
        } catch (err) {
          logger.error({ err, userId: target.tenantId }, 'Coach briefing failed for user; continuing');
        }
      }
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
      const plan = getActivePlan(userId, userId);
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
          const readiness = await calculateReadiness(userId, { tenantId: userId, garminSilent: true });
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
        try {
          updateWeekAdjustment(nextWeek.id, recommendation.adjustIntensity, recommendation.reason);
        } catch (err) {
          if (err instanceof TrainingPlanRevisionError
              && err.code === 'TRAINING_REVISION_MANAGED_LEGACY_MUTATION_BLOCKED') {
            logger.info(
              { userId, planId: plan.id, weekId: nextWeek.id },
              'Skipped legacy weekly auto-adjust for a revision-owned Training week',
            );
            return;
          }
          throw err;
        }

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
    // Empty queue is the overwhelmingly common case (~2,830 no-op rows/month
    // observed in prod) — return 'skipped' so wrapJob does not persist a
    // job_history row, mirroring the reminders fast-path.
    if (pending === 0) return 'skipped';

    const result = await flushQueue();

    if (result.flushed > 0) {
      // Notify user that queued invoices were filed
      let msg = `📤 <b>Fila de faturas processada!</b>\n\n`;
      msg += `✅ ${result.flushed} fatura${result.flushed > 1 ? 's' : ''} arquivada${result.flushed > 1 ? 's' : ''} com sucesso`;
      if (result.failed > 0) msg += `\n❌ ${result.failed} falharam permanentemente`;
      if (result.remaining > 0) msg += `\n🔄 ${result.remaining} ainda na fila`;
      msg += `\n\n<i>O Mac voltou a estar disponível.</i>`;

      for (const userId of getOwnerUserIds()) {
        // GAP-CAL-1 fix: durable in-app notification; Telegram was a no-op.
        try {
          await createNotificationIntent({
            userId,
            tenantId: userId,
            sourceSkill: 'finance',
            type: result.failed > 0 ? 'sync_failure' : 'insight',
            priority: result.failed > 0 ? 'active' : 'passive',
            relatedEntityId: `invoice_queue_flush:${new Date().toISOString().slice(0, 10)}`,
            relatedEntityType: 'finance_queue_flush',
            title: 'Invoice queue processed',
            body: `${result.flushed} queued invoice${result.flushed === 1 ? '' : 's'} filed${result.failed > 0 ? `, ${result.failed} failed permanently` : ''}.`,
            sensitiveBody: safeHtmlNotificationBody(msg),
            deeplink: 'nexus://finance/invoices',
            dedupeKey: `finance:invoice_queue_flush:${userId}:${new Date().toISOString().slice(0, 10)}`,
            privacyPolicy: 'financial',
          });
        } catch (err) {
          logger.warn({ err, userId }, 'Failed to create invoice queue notification intent');
        }
      }
    }
  }), { timezone: tz });

  // ── Weekly channel re-analysis (Sunday 03:37) ─────────────────
  // Off-minute schedule is deliberate: Gemini returns 503 UNAVAILABLE at
  // top-of-hour global cron bursts, which was driving the expensive
  // OpenAI-fallback storm (2026-07-03 audit). Same for the content and
  // autoresearch crons below.
  cron.schedule('37 3 * * 0', wrapJob('channel_relearn', async () => {
    const result = await runScheduledChannelRelearn();
    if (result.analyzed > 0 || result.failed > 0) {
      const msg = `📚 <b>Weekly Channel Re-Learn</b>\n\n` +
        `✅ ${result.analyzed} analyzed · ❌ ${result.failed} failed · 🧠 ${result.synthesized ? 'Knowledge updated' : 'No changes'}`;
      for (const userId of getOwnerUserIds()) {
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

  // ── Content Workflow: Tuesday Reel Topics (09:17) ──────────────────
  cron.schedule('17 9 * * 2', wrapJob('tuesday_reels', async () => {
    await runContentTopicCronForActiveUsers('reel', 'tuesday_reels');
  }), { timezone: tz });

  // ── Content Workflow: Thursday YT Topic (09:23) ───────────────────
  cron.schedule('23 9 * * 4', wrapJob('thursday_youtube', async () => {
    await runContentTopicCronForActiveUsers('youtube', 'thursday_youtube');
  }), { timezone: tz });

  // ── Content Workflow: Friday Weekly Package (18:41) ────────────────
  cron.schedule('41 18 * * 5', wrapJob('friday_weekly', async () => {
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
    await runScheduledVoiceEvolutionAgent();
  }), { timezone: tz });

  // ── Reaction Radar Agent (every 4 hours) ─────────────────────────
  cron.schedule('0 8,14,20 * * *', wrapJob('reaction_radar', async () => {
    await runReactionRadar();
  }), { timezone: tz });

  // ── SEO Tracking Agent (Monday 06:00) ────────────────────────────
  cron.schedule('0 6 * * 1', wrapJob('seo_agent', async () => {
    await runSEOAgent();
    // Completion messaging removed: the agent is fail-closed paused and the
    // old Telegram note was a no-op with legacy delivery disabled.
  }), { timezone: tz });

  // ── Autoresearch (Sunday 01:19 — rotates through targets) ────────
  cron.schedule('19 1 * * 0', wrapJob('autoresearch', async () => {
    await runScheduledAutoresearch();
  }), { timezone: tz });

  // ── Database Backup (daily, configurable — default 03:00) ─────────
  if (config.backup.enabled) {
    cron.schedule(backupCron, wrapJob('db_backup', async () => {
      const backupPath = await runDatabaseBackup();
      // Success confirmation is visible in job_history + the portal; the old
      // Telegram note was a no-op with legacy delivery disabled (GAP-CAL-1).
      logger.info({ backup: path.basename(backupPath) }, 'Database backup complete');
    }), { timezone: tz });

    // ── Weekly Restore Test (Sunday 04:00) ─────────────────────────
    cron.schedule('0 4 * * 0', wrapJob('db_restore_test', async () => {
      const result = await weeklyRestoreTest();
      if (!result.success) {
        logger.error({ details: result.details }, 'Weekly restore test FAILED');
        // GAP-CAL-1 fix: a failed restore test used to be log-only.
        // Throwing routes through the wrapJob failure notifier, which
        // records a critical operator alert.
        throw new Error(`Weekly restore test failed: ${result.details.slice(0, 300)}`);
      }
      logger.info({ details: result.details }, 'Weekly restore test passed');
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
  cron.schedule('*/15 * * * *', wrapJob('integration_health', async () => {
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

  cron.schedule('0 4 * * *', wrapJob('nexus_points_expiry', async () => {
    expireOldNexusPointCredits();
  }), { timezone: 'UTC' });

  // ── Option 3 (O3-A23): classify_shadow_runs retention prune ────────
  // Deletes shadow-eval rows older than CLASSIFY_SHADOW_RETENTION_DAYS
  // (default 30), but preserves any row the operator manually reviewed
  // (manually_reviewed=1) — those carry training-data value indefinitely.
  // Runs daily at 04:17 UTC, after the nexus_points_expiry tick.
  cron.schedule('17 4 * * *', wrapJob('classify_shadow_prune', async () => {
    const raw = process.env.CLASSIFY_SHADOW_RETENTION_DAYS;
    const days = (() => {
      const n = raw ? parseInt(raw, 10) : NaN;
      return Number.isFinite(n) && n >= 1 && n <= 365 ? n : 30;
    })();
    try {
      const db = getDb();
      const result = db.prepare(`
        DELETE FROM classify_shadow_runs
        WHERE ts < datetime('now', '-' || ? || ' days')
          AND manually_reviewed = 0
      `).run(days);
      logger.info(
        { deletedRows: result.changes, retentionDays: days },
        'classify_shadow_runs pruned',
      );
    } catch (err) {
      // Table may not exist on a brand-new DB before migration 171 runs.
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), retentionDays: days },
        'classify_shadow_prune: skipped (table missing or query failed)',
      );
    }
  }), { timezone: 'UTC' });

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
      logger.info({ msg }, '[scheduler] book library seed progress');
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

  // Decision production belongs to the scheduler/event path, never a GET.
  // The materializer is scoped and daily-idempotent, so hourly execution also
  // handles users who become active after the first local morning window.
  cron.schedule('12 * * * *', wrapJob('decision_daily_attention', async () => {
    let materialized = 0;
    let failed = 0;
    for (const target of getActiveUserTargets()) {
      const result = await materializeDecisionCenterDailyAttention({
        userId: target.tenantId,
        tenantId: target.tenantId,
      });
      if (result.status === 'materialized') materialized += 1;
      if (result.status === 'failed') failed += 1;
    }
    if (materialized === 0 && failed === 0) return 'skipped';
    logger.info({ materialized, failed }, 'Decision daily attention materialization completed');
  }), { timezone: tz });

  cron.schedule('22,52 * * * *', wrapJob('decision_handled_history_backfill', async () => {
    const result = runDecisionHandledHistoryBackfillJob({ limit: 100 });
    if (result.backfilled === 0 && result.failed === 0) return 'skipped';
    logger.info(result, 'Decision handled-history backfill completed');
  }), { timezone: tz });

  cron.schedule('7,37 * * * *', wrapJob('decision_center_smoke_cleanup', async () => {
    const result = runDecisionCenterSmokeCleanupJob({ olderThanHours: 24, limit: 100 });
    if (result.expired === 0) return 'skipped';
    logger.info(result, 'Decision Center smoke cleanup completed');
  }), { timezone: tz });

  cron.schedule('*/10 * * * *', wrapJob('decision_expiry', async () => {
    const result = runDecisionExpiryJob({ batchSize: 500, maxBatches: 20 });
    if (result.expired === 0) return 'skipped';
    logger.info(result, 'Decision expiry sweep completed');
  }), { timezone: tz });

  cron.schedule('15 0 * * *', wrapJob('decision_metrics_rollup', async () => {
    const yesterday = decisionMetricsRollupDateForScheduler(new Date(), tz);
    const result = runDecisionMetricsRollupJob({ date: yesterday });
    logger.info(result, 'Decision metrics daily rollup completed');
  }), { timezone: tz });

  cron.schedule('40 4 * * *', wrapJob('decision_ledger_retention_prune', async () => {
    const result = runDecisionLedgerRetentionPruneJob({ batchSize: 500, maxBatches: 200 });
    if (result.outcomeLedgerPruned === 0
        && result.qualityGateEventsPruned === 0
        && result.conflictEvaluationsPruned === 0
        && result.terminalExclusivityClaimsPruned === 0) return 'skipped';
    logger.info(result, 'Decision ledger retention prune completed');
  }), { timezone: tz });

  cron.schedule('*/2 * * * *', wrapJob('chat_action_plan_expiry', async () => {
    const expiredPendingActions = expireStalePendingChatActionsForJob();
    if (expiredPendingActions === 0) return 'skipped';
    logger.info({ expiredPendingActions }, 'Expired stale pending chat actions');
  }), { timezone: tz });

  cron.schedule('*/5 * * * *', wrapJob('chat_action_run_zombie_reaper', async () => {
    const reaped = reapZombieChatActionRuns();
    if (reaped === 0) return 'skipped';
    logger.warn({ reaped }, 'Reaped orphaned chat action runs stuck in executing status');
  }), { timezone: tz });

  cron.schedule('* * * * *', wrapJob('chat_action_fixer_worker', async () => {
    const result = await runScheduledChatActionFixerJobs({
      limit: intEnv('CHAT_ACTION_FIXER_JOB_BATCH_LIMIT', 5, 1, 25),
      lockOwner: `chat-action-fixer:${process.pid}`,
    });
    const touched = result.completed + result.failed + result.deadLetter;
    if (result.deadLetter > 0) {
      logger.warn(result, 'Chat action fixer worker produced dead-letter rows');
    }
    if (touched === 0) return 'skipped';
    logger.info(result, 'Chat action fixer worker completed');
  }), { timezone: tz });

  cron.schedule('20 0 * * *', wrapJob('chat_action_run_retention', async () => {
    const deleted = pruneCompletedChatActionRuns();
    if (deleted === 0) return 'skipped';
    logger.info({ deleted, retentionDays: 90 }, 'Pruned retained chat action run summaries');
  }), { timezone: tz });

  if (resolveChatCoreV2ActivationConfig(process.env).mode !== 'off' && isChatCoreV2AutoRevertEvalCronEnabled(process.env)) {
    cron.schedule('*/5 * * * *', wrapJob('chat_v2_auto_revert_eval', async () => {
      let evaluated = 0;
      let wouldRevert = 0;
      try {
        const db = getDb();
        const tenantIds = getActiveChatCoreV2TenantIds(db);
        if (tenantIds.length === 0) return 'skipped';

        for (const tenantId of tenantIds) {
          try {
            const metrics = await computeChatCoreV2AutoRevertMetrics(db, { tenantId });
            const decision = evaluateChatCoreV2AutoRevertPolicy(metrics);
            evaluated += 1;
            const isRevert = !(decision.actions.length === 1 && decision.actions[0] === 'keep_current_mode');
            if (isRevert) wouldRevert += 1;
            logger.info(
              {
                event: 'chat_core_v2_auto_revert_eval',
                tenantToken: opaqueChatV2TenantToken(tenantId),
                metrics: {
                  legacyFallbackRate24h: metrics.legacyFallbackRate24h,
                  ollamaHealthy: metrics.ollamaHealthy,
                  schemaComplianceRate1h: metrics.schemaComplianceRate1h,
                  perLanguageArmActive: false,
                },
                decision: {
                  actions: decision.actions,
                  reasonCodes: decision.reasonCodes,
                  affectedLanguageCount: decision.affectedLanguages.length,
                },
              },
              'Chat Core v2 auto-revert evaluation (decision applied below)',
            );
            await applyAutoRevertDecision(tenantId, decision, metrics, db);
          } catch (err) {
            logger.warn(
              {
                event: 'chat_core_v2_auto_revert_eval_tenant_failed',
                tenantToken: opaqueChatV2TenantToken(tenantId),
                err: err instanceof Error ? err.message : String(err),
              },
              'Chat Core v2 auto-revert evaluation failed for one tenant (loop continues)',
            );
          }
        }
        logger.info(
          { event: 'chat_core_v2_auto_revert_eval_cycle', evaluated, wouldRevert },
          'Chat Core v2 auto-revert evaluation cycle complete',
        );
      } catch (err) {
        logger.warn(
          { event: 'chat_core_v2_auto_revert_eval_cycle_failed', err: err instanceof Error ? err.message : String(err) },
          'Chat Core v2 auto-revert evaluation cycle failed',
        );
      }
    }), { timezone: 'UTC' });
  }

  if (resolveChatCoreV2ActivationConfig(process.env).mode !== 'off') {
    cron.schedule('37 * * * *', wrapJob('chat_v2_gate_check', async () => {
      runChatCoreV2GateCheck();
    }), { timezone: 'UTC' });
  }

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
    `Scheduler started: reminders, daily briefing (${config.todo.digestTime}), end-of-day (21:00), weekly (Fri 17:00), shared list (*/5), content topics (Tue 09:17/Thu 09:23/Fri 18:41), invoices (1st 09:00/09:15/09:30), fiscal-bundle (daily 08:10 due-check), conflict (19:30), fossa (bi-weekly Mon 07:30), garmin-keepalive (*/30), coach (${config.garmin.coachTime}), invoice-queue (*/15), channel-relearn (Sun 03:00), pipeline-agent (20:00), notification-release (*/15), decision-source-supersession (*/15), chat-action-plan-expiry (*/2), chat-action-run-zombie-reaper (*/5), chat-action-run-retention (00:20), event-backbone-worker (* * * * *), event-backbone-cleanup (00:10), nexus-points-expiry (04:00 UTC), expire-signals (hourly), db-backup (${config.backup.time}), dst-watchdog (*/15)`
  );
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

// ── Exported for portal quick actions ─────────────────────────────────

function hasCoachableHealthDataForUser(userId: number): boolean {
  try {
    if (isGarminConfigured() && isOwnerUserRef(userId, {
      allowPersistedTier: false,
      requireConfiguredIdentity: true,
    })) return true;
    const row = getDb().prepare(
      "SELECT EXISTS(SELECT 1 FROM apple_health_data WHERE user_id = ? AND date = date('now')) AS present",
    ).get(userId) as { present: number };
    return !!row.present;
  } catch (err) {
    logger.warn({ err, userId }, '[scheduler] coach briefing skipped: health-data eligibility check failed closed');
    return false;
  }
}

function hasPaidCoachBriefingEntitlement(userId: number): boolean {
  const automationEligibility = resolveAiAutomationEligibility(userId, 'triathlon');
  const entitlement = automationEligibility.entitlement;
  const allowed = isPaidAiCostControlsEnforcementEnabled()
    ? automationEligibility.allowed && isAiAutomationAllowedForRuntime(entitlement)
    : automationEligibility.allowed && isCoachBriefingEntitlementEligible(entitlement);
  if (!allowed) {
    if (!automationEligibility.allowed) {
      recordAiAutomationEligibilitySkip(userId, automationEligibility, {
        jobName: 'garmin_coach',
        baseCategory: 'coach_analysis',
      });
    }
    logger.debug(
      {
        userId,
        plan: entitlement.plan,
        entitlementSource: entitlement.source,
        automationReason: automationEligibility.reason,
      },
      '[scheduler] coach briefing skipped: Pro or Max plan required',
    );
  }
  return allowed;
}

function hasActiveCoachWorkoutPlan(userId: number): boolean {
  try {
    const plan = getActivePlan(userId, userId);
    const allowed = !!plan;
    if (!allowed) {
      logger.debug({ userId }, '[scheduler] coach briefing skipped: active workout plan required');
    }
    return allowed;
  } catch (err) {
    logger.warn({ err, userId }, '[scheduler] coach briefing skipped: active workout plan check failed');
    return false;
  }
}

export interface CoachBriefingDispatchResult {
  status: 'generated' | 'skipped' | 'deferred' | 'failed';
  recommendations: number;
  errors: number;
}

export async function sendCoachBriefingForTarget(
  target: ActiveUserTarget,
  options: { runId?: string | null } = {},
): Promise<CoachBriefingDispatchResult> {
  // Deliberate pre-flight replacing the old accidental gate (users without
  // health data used to throw inside generateCoachBriefing AFTER burning
  // calendar fetches). The serialized daily/monthly budget reservation wraps
  // the provider boundary below.
  if (!hasPaidCoachBriefingEntitlement(target.tenantId)) {
    return { status: 'skipped', recommendations: 0, errors: 0 };
  }
  if (!hasActiveCoachWorkoutPlan(target.tenantId)) {
    return { status: 'skipped', recommendations: 0, errors: 0 };
  }
  if (!hasCoachableHealthDataForUser(target.tenantId)) {
    logger.debug({ userId: target.tenantId }, '[scheduler] coach briefing skipped: no health data source for user');
    return { status: 'skipped', recommendations: 0, errors: 0 };
  }
  return runWithContext({ source: 'cron:garmin_coach', userId: target.tenantId }, async () => {
      let result;
      try {
        result = await generateCoachBriefing(target.tenantId, {
          tenantId: target.tenantId,
          meteringUserId: target.tenantId,
          garminSilent: true,
          budgetRequestSource: 'automation',
          budgetJobName: 'garmin_coach',
          ...(options.runId ? { budgetRunId: options.runId } : {}),
        });
      } catch (err) {
        if (err instanceof AiBudgetError) {
          // No report/state writes occur on deferral, so the latest valid
          // Coach report remains the durable read model.
          const lockUnavailable = err.decision.internalReason === 'lock_unavailable';
          if (lockUnavailable) {
            // The report dispatcher claimed this local date before starting
            // the job. Transient lock contention must release only that fresh
            // claim so the next scheduler tick can retry the same report.
            releaseFreshReportScheduleClaim(target.tenantId, 'coach_briefing');
          }
          const resetKey = err.decision.unblocksAt?.replace(/[^0-9]/g, '').slice(0, 12)
            || new Date().toISOString().slice(0, 10);
          try {
            await createNotificationIntent({
              userId: target.tenantId,
              tenantId: target.tenantId,
              sourceSkill: 'training',
              type: 'insight',
              priority: 'active',
              relatedEntityId: `coach-budget-${err.decision.code}-${resetKey}`,
              relatedEntityType: 'coach_briefing_budget',
              title: 'Coach report deferred',
              body: err.decision.window === 'global'
                ? 'Your next Coach report will retry automatically after a temporary service delay.'
                : err.decision.window === 'monthly' || err.decision.window === 'automation_monthly'
                  ? 'Your next Coach report will resume when the monthly AI allowance resets.'
                  : 'Your next Coach report will resume when the daily AI allowance resets.',
              deeplink: 'nexus://training/coach',
              expiresAt: err.decision.unblocksAt,
              dedupeKey: `training:coach_budget:${target.tenantId}:${err.decision.code}:${resetKey}`,
              privacyPolicy: 'health',
            });
          } catch (notificationErr) {
            logger.warn({ err: notificationErr, userId: target.tenantId }, 'Coach budget deferral notice failed');
          }
          logger.info(
            { userId: target.tenantId, code: err.decision.code, window: err.decision.window },
            'Coach briefing deferred by AI budget; latest valid report retained',
          );
          return { status: 'deferred', recommendations: 0, errors: 0 } as const;
        }
        logger.warn({ err, userId: target.tenantId }, 'Coach briefing skipped for user');
        return { status: 'failed', recommendations: 0, errors: 1 } as const;
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
          readinessData = await calculateReadiness(target.tenantId, {
            tenantId: target.tenantId,
            garminSilent: true,
          });
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

      logger.info(
        {
          userId: target.tenantId,
          dataMs: result.dataCollectionMs,
          analysisMs: result.analysisMs,
          errors: result.errors.length,
        },
        'Daily coach briefing completed'
      );
      return {
        status: 'generated',
        recommendations: result.recommendations.length,
        errors: result.errors.length,
      } as const;
    });
}

class CoachBriefingDispatchError extends Error {
  constructor(readonly result: CoachBriefingDispatchResult) {
    super('Coach briefing generation failed before a valid report was produced');
    this.name = 'CoachBriefingDispatchError';
  }
}

function scheduledCoachBriefingAdapter(
  target: ActiveUserTarget,
): GovernedAgentJobAdapter<{ tenantId: number }, CoachBriefingDispatchResult> {
  return {
    jobId: 'garmin_coach',
    providerRouting: 'gemini-primary-openai-fallback-anthropic-gated-last-resort',
    prepare: () => ({
      kind: 'ready',
      input: { tenantId: target.tenantId },
      fingerprintMaterial: { tenantId: target.tenantId, gate: 'report_schedule_ledger' },
    }),
    async execute({ runId }) {
      const result = await sendCoachBriefingForTarget(target, { runId });
      if (result.status === 'failed') throw new CoachBriefingDispatchError(result);
      return result;
    },
    validateOutput(output, input) {
      if (input.tenantId !== target.tenantId
          || !['generated', 'skipped', 'deferred'].includes(output.status)
          || !Number.isSafeInteger(output.recommendations)
          || output.recommendations < 0
          || !Number.isSafeInteger(output.errors)
          || output.errors < 0) {
        throw new AgentJobOutputValidationError('Coach briefing dispatch output failed validation');
      }
    },
    classifyOutput: (output) => output.status === 'generated' ? 'success' : 'skipped_no_work',
  };
}

export async function runScheduledCoachBriefingForTarget(
  target: ActiveUserTarget,
): Promise<AgentJobOutcome<CoachBriefingDispatchResult>> {
  return runGovernedAgentJob(
    scheduledCoachBriefingAdapter(target),
    { tenantId: target.tenantId, userId: target.tenantId },
  );
}

export async function sendCoachBriefings(): Promise<void> {
  for (const target of getActiveUserTargets()) {
    await sendCoachBriefingForTarget(target);
  }
}

export async function runEndOfDaySummaryForTarget(target: ActiveUserTarget): Promise<void> {
  const report = await buildEndOfDaySummaryForUser(target.tenantId);
  if (!report) return;

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
}

export async function sendDailyBriefingForTarget(target: ActiveUserTarget): Promise<void> {
  const data = await buildDailyBriefingDataForUser(target.tenantId, target.tenantId);

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
}

// Loops every active user regardless of per-user schedule — used by the
// portal manual trigger and tests. Scheduled delivery goes through the
// report-schedule dispatcher, which calls the ForTarget variant per due user.
export async function sendDailyBriefing(): Promise<void> {
  for (const target of getActiveUserTargets()) {
    await sendDailyBriefingForTarget(target);
  }
}

function isChatCoreV2AutoRevertEvalCronEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.CHAT_CORE_V2_AUTO_REVERT_EVAL ?? 'true').trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'off' && raw !== 'no';
}

async function sendWeeklyReviewForTarget(target: ActiveUserTarget): Promise<void> {
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
}

async function sendWeeklyReview(): Promise<void> {
  for (const target of getActiveUserTargets()) {
    await sendWeeklyReviewForTarget(target);
  }
}
