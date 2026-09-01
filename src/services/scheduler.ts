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
import { DailyBriefingData, escapeHtml } from '../utils/chat-html-formatter';
import { now, startOfDay, endOfDay, startOfWeek, endOfWeek, formatTime, formatDateTime } from '../utils/date-parser';
// content-discovery.ts still exists for manual /discover but removed from scheduler
import { collectMonthlyInvoices, formatCollectionNotification } from './invoice-collector';
import { isInvoiceFilingConfigured } from './invoice-filer';
import { collectAmazonInvoices, formatAmazonNotification, isAmazonConfigured } from './amazon-collector';
import { collectUberInvoices, formatUberNotification, isUberConfigured } from './uber-collector';
import { createScraperMfaInteractiveCallbacks } from './scraper-mfa-reply';
import { getFiscalCollectionSummary, isFiscalBundleDue, sendFiscalBundleNow } from './fiscal-bundle';
import {
  generateCoachBriefing,
  runWithCoachBriefingAccountAdmissions,
} from './garmin-coach';
import {
  isGarminConfigured,
  keepAlive as garminKeepAlive,
  ensureAuthenticated as garminEnsureAuth,
} from './garmin';
import { listGarminConnectedUserIds, hasActiveGarminConnection } from './garmin-session-store';
import { registerJob as registerTelemetryJob, wrapJob, recordGarminRefresh, setJobFailureNotifier, setJobEnabledChecker, getJobMap, seedJobLastRunFromHistory, type JobDomain, type ScheduledJobExecutionContext } from '../portal/telemetry';
import { assertAgentJobRuntimeRegistration } from './agent-job-manifest';
import { requestTaskSync } from './task-store/task-sync-coordinator';
import { isTaskMsDeltaSyncEnabled } from './task-store/task-sync-flags';
import { createNotificationIntent, releaseDueNotificationDeliveries } from './notification-orchestrator';
import { isCronJobEnabled } from '../skills/skill-manager';
import { CronExpressionParser } from 'cron-parser';
import { flushQueue } from './invoice-queue';
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
import { sweepExpiredStructuredHealthData } from './health-data-lifecycle';
import { isTrainingCoachV2Enabled } from './training-coach-v2-rollout';
import { seedBooksIfEmpty } from '../commands/books';
import type { ResolveDueReportOptions, ScheduledReportJob } from './report-schedule-dispatcher';
import {
  claimDueScheduledReportLeaseBatch,
  completeScheduledReportLease,
  failScheduledReportLease,
  startScheduledReportLeaseHeartbeat,
  type ScheduledReportLease,
} from './report-schedule-jobs';
import { getUserTimezoneById, isOwnerUserRef } from './user-service';
import { runDatabaseBackup, weeklyRestoreTest } from './backup';
import { getDb } from './database';
import { listActiveFiscalCollectionProfiles } from '../state/fiscal-collection-profiles';
import { runWithContext, type RequestSource } from '../utils/request-context';
import { getOwnerBootstrapTarget } from './user-service';
import { getTaskProviderForUser } from './task-store/task-router';
import { storeAndPushReport } from './report-document-store';
import { composeDailyBrief, type DailyBriefResponse } from './daily-brief-orchestrator';
import { composeWeeklyPlan, type WeeklyPlanResponse } from './weekly-plan-orchestrator';
import { processDueOperatorAlertDeliveries, recordOperatorAlert } from './operator-alerts';
import { runEventBackboneOnce } from './event-backbone-worker';
import { runEventBackboneCleanup } from '../tools/event-backbone-cleanup';
import { expireStalePendingChatActionsForJob } from './chat-action-state';
import { pruneCompletedChatActionRuns, reapZombieChatActionRuns } from './chat-action-run-store';
import { runScheduledChatActionFixerJobs } from './chat-action-fixer-worker';
import { runScheduledTrainingPlanCalendarSyncJobs } from './training-plan-calendar-sync-worker';
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
  listHandledByNexusItems,
  runDecisionMetricsRollupJob,
  runDecisionRankSnapshotBackfillJob,
  runDecisionSourceStateSupersessionJob,
} from './decision-center';
import { runTaskLedgerRetentionJob } from './task-store/task-ledger-retention';
import {
  CONTENT_SCRIPT_JOB_RETENTION_DAYS,
  LOCAL_INFERENCE_SAFETY_INCIDENT_RETENTION_DAYS,
  SECURITY_ADMIN_AUDIT_RETENTION_MONTHS,
  SKILL_INFERENCE_TELEMETRY_RETENTION_DAYS,
  drainExpiredContentScriptJobPrivateMaterial,
  drainExpiredLocalInferenceSafetyIncidents,
  drainExpiredSecurityAdminAuditTrail,
  drainExpiredSkillInferenceTelemetry,
} from './private-data-retention';
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
import {
  computeAdjustmentRecommendation,
  getActivePlan,
  getActivePlans,
  getCurrentWeek,
  getSessionsForWeek,
  getWeeklyAdherence,
  getWeeksForPlan,
  updateWeekAdjustment,
} from './training-plans';
import {
  bindTrainingCoachV2ProposalDecision,
  createTrainingCoachV2Proposal,
} from './training-coach-v2-proposals';
import { loadCoachKnowledge } from './coach-kernel/knowledge-loader';
import { getSciencePolicyVersion } from './coach-kernel/training-principles';
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

function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

type ActiveUserTarget = Pick<AgentJobTenantTarget, 'tenantId' | 'telegramId'>
  & Partial<Pick<AgentJobTenantTarget, 'userId'>>;

type ActiveTrainingTarget = Pick<AgentJobTenantTarget, 'tenantId' | 'userId' | 'telegramId'>;

function getActiveTrainingTargets(): ActiveTrainingTarget[] {
  const users = getActiveUserTargets();
  const telegramByUser = new Map(users.map((target) => [target.userId, target.telegramId]));
  return getActiveTrainingScopes(users.map((target) => target.userId)).map((scope) => ({
    ...scope,
    telegramId: telegramByUser.get(scope.userId) ?? null,
  }));
}

export interface ScheduledReportTargetResult {
  /** Report was delivered, but its content had explicitly reported data gaps. */
  degraded?: boolean;
}

export class ScheduledReportFanOutError extends Error {
  constructor(
    readonly job: ScheduledReportJob,
    readonly failedTargets: number,
    readonly degradedTargets: number,
  ) {
    super(`Scheduled report fan-out incomplete (${job}; failed=${failedTargets}; degraded=${degradedTargets})`);
    this.name = 'ScheduledReportFanOutError';
  }
}

/**
 * Drain every healthy per-user lease before reporting a partial fan-out.
 * A failed target remains retryable in background_jobs; a degraded but
 * delivered target receives its completion receipt and makes the parent cron
 * fail observably without duplicating that user's report on the next tick.
 */
export async function executeScheduledReportLeaseBatch<T extends { tenantId: number; userId?: number }>(
  job: ScheduledReportJob,
  targets: T[],
  execution: Pick<ScheduledJobExecutionContext, 'assertLeaseActive'>,
  execute: (lease: ScheduledReportLease<T>) => Promise<ScheduledReportTargetResult | void>,
  options: ResolveDueReportOptions<T> = {},
): Promise<void | 'skipped'> {
  const batch = claimDueScheduledReportLeaseBatch(job, targets, DateTime.utc(), options);
  let failedTargets = batch.failures.length;
  let degradedTargets = 0;
  let completedTargets = 0;
  // Every claimed row starts heartbeating immediately so a later lease in a
  // fan-out batch cannot expire while an earlier user's report is generated.
  const heartbeats = new Map(batch.leases.map((lease) => [
    lease.jobRecord.jobId,
    startScheduledReportLeaseHeartbeat(lease),
  ]));

  try {
    for (const lease of batch.leases) {
      const heartbeat = heartbeats.get(lease.jobRecord.jobId)!;
      try {
        heartbeat.assertActive();
        execution.assertLeaseActive();
        const result = await execute(lease);
        heartbeat.assertActive();
        execution.assertLeaseActive();
        if (!completeScheduledReportLease(lease)) {
          throw new Error('SCHEDULED_REPORT_COMPLETION_NOT_WRITTEN');
        }
        completedTargets += 1;
        if (result?.degraded) {
          degradedTargets += 1;
          logger.warn({
            job,
            userId: lease.schedule.userId,
            tenantId: lease.schedule.tenantId,
          }, 'Scheduled report completed with degraded source data');
        }
      } catch (error) {
        failedTargets += 1;
        let retryStatus: string = 'lease_error';
        try {
          retryStatus = failScheduledReportLease(lease, error);
        } catch (leaseError) {
          retryStatus = safeErrorName(leaseError);
        }
        logger.error({
          errorName: safeErrorName(error),
          job,
          retryStatus,
          userId: lease.schedule.userId,
          tenantId: lease.schedule.tenantId,
        }, 'Scheduled report failed for user; continuing remaining leases');
      } finally {
        heartbeat.stop();
      }
    }
  } finally {
    for (const heartbeat of heartbeats.values()) heartbeat.stop();
  }

  if (failedTargets > 0 || degradedTargets > 0) {
    throw new ScheduledReportFanOutError(job, failedTargets, degradedTargets);
  }
  if (completedTargets === 0) return 'skipped';
}

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

export interface DecisionMetricsRollupFanOutSummary {
  scopes: number;
  rollups: number;
  failedScopes: number;
}

/**
 * Refresh each active account's current local-day row and, just after that
 * account crosses midnight, finalize its previous day too. The hourly job is
 * idempotent and keeps the dashboard's "today" row current without mixing two
 * users that happen to share a tenant or the scheduler's timezone.
 */
export function runDecisionMetricsRollupForActiveUsers(
  at = new Date(),
  targets: readonly ActiveUserTarget[] = getActiveUserTargets(),
): DecisionMetricsRollupFanOutSummary {
  let rollups = 0;
  let failedScopes = 0;
  for (const target of targets) {
    const userId = target.userId ?? target.tenantId;
    const tenantId = target.tenantId;
    try {
      const timezone = getUserTimezoneById(userId) || config.app.timezone;
      const local = DateTime.fromJSDate(at).setZone(timezone);
      if (!local.isValid) throw new Error('active user has an invalid metrics timezone');
      const currentDate = local.toISODate();
      if (!currentDate) throw new Error('active user local metrics date is unavailable');
      const dates = local.hour === 0
        ? [currentDate, local.minus({ days: 1 }).toISODate()].filter((date): date is string => Boolean(date))
        : [currentDate];
      for (const date of dates) {
        runDecisionMetricsRollupJob({ userId, tenantId, timezone, date, now: at });
        rollups += 1;
      }
    } catch (error) {
      failedScopes += 1;
      logger.error({
        errorName: error instanceof Error ? error.name : typeof error,
        userId,
        tenantId,
      }, 'Decision metrics rollup failed for active scope');
    }
  }
  return { scopes: targets.length, rollups, failedScopes };
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
export interface GarminRefreshFanOutResult {
  total: number;
  refreshed: number;
  failed: number[];
}

/**
 * Refresh every connected user's Garmin session, one scoped context each.
 *
 * `resolveGarminUserId` fails closed, so a caller that invokes `keepAlive()`
 * without establishing a user gets a silent no-op — which is exactly what
 * happened to the startup keep-alive and the portal refresh action when the
 * resolver changed. Callers use this helper instead of calling `keepAlive()`
 * bare so the user scope cannot be forgotten.
 *
 * Failures are isolated per user: one dead session must not stop the fan-out.
 */
export async function refreshConnectedGarminUsers(
  source: RequestSource,
  execution?: Pick<ScheduledJobExecutionContext, 'signal' | 'assertLeaseActive'>,
): Promise<GarminRefreshFanOutResult> {
  execution?.assertLeaseActive();
  const userIds = listGarminConnectedUserIds();
  const failed: number[] = [];
  let refreshed = 0;

  for (const userId of userIds) {
    execution?.assertLeaseActive();
    try {
      const ok = await runWithContext(
        {
          source,
          tenantId: userId,
          userId,
          // Keepalive is always passive token maintenance. Scope no-MFA safety
          // to this tenant/user invocation instead of racing a process-global
          // flag against unrelated interactive requests.
          garminSilent: true,
        },
        async () => garminKeepAlive(),
      );
      // A provider call may have been in flight when another process replaced
      // the token. Fence before recording it or moving to the next tenant.
      execution?.assertLeaseActive();
      if (ok) refreshed += 1;
      else failed.push(userId);
    } catch (err) {
      // Ordinary per-user provider failures remain isolated. Lease loss is a
      // job-level safety failure and must stop the fan-out immediately.
      execution?.assertLeaseActive();
      failed.push(userId);
      logger.warn({ err, userId, source }, 'Garmin keep-alive failed for user');
    }
  }

  execution?.assertLeaseActive();
  return { total: userIds.length, refreshed, failed };
}

class GarminKeepaliveIncompleteError extends Error {
  readonly outcome: GarminRefreshFanOutResult;

  constructor(outcome: GarminRefreshFanOutResult) {
    super(`Garmin keep-alive incomplete: ${outcome.refreshed}/${outcome.total} refreshed`);
    this.name = 'GarminKeepaliveIncompleteError';
    this.outcome = outcome;
  }
}

function recordAndValidateGarminKeepaliveOutcome(
  source: RequestSource,
  outcome: GarminRefreshFanOutResult,
): void {
  recordGarminRefresh(outcome.total === 0 || outcome.failed.length === 0);
  if (outcome.total === 0) {
    if (source === 'startup') logger.info('Garmin: startup keepalive — no connected users');
    return;
  }
  if (outcome.failed.length > 0) {
    throw new GarminKeepaliveIncompleteError(outcome);
  }
  if (source === 'startup') {
    logger.info({ refreshed: outcome.refreshed }, 'Garmin: startup keepalive successful — sessions are live');
  }
}

async function runGarminKeepaliveJob(
  source: RequestSource,
  execution: ScheduledJobExecutionContext,
): Promise<void> {
  const outcome = await refreshConnectedGarminUsers(source, execution);
  recordAndValidateGarminKeepaliveOutcome(source, outcome);
}

export type GuardedGarminRefreshResult =
  | { status: 'completed'; outcome: GarminRefreshFanOutResult }
  | { status: 'not_executed'; outcome: null };

/**
 * Run an operator-triggered refresh under the same global durable lease used
 * by cron and startup. `not_executed` means another holder owns the fence (or
 * the Training job is disabled); callers must never fall back to an unfenced
 * direct fan-out.
 */
export async function refreshConnectedGarminUsersWithLease(
  source: RequestSource,
): Promise<GuardedGarminRefreshResult> {
  let outcome: GarminRefreshFanOutResult | null = null;
  const guarded = wrapJob('garmin_keepalive', async (execution) => {
    outcome = await refreshConnectedGarminUsers(source, execution);
    recordAndValidateGarminKeepaliveOutcome(source, outcome);
  }, { requestSource: source, storeForRecovery: false });

  try {
    await guarded();
  } catch (err) {
    // Partial/all-user provider failures are truthful completed fan-outs. The
    // durable wrapper has already recorded a failed job; the portal still
    // needs the bounded aggregate to tell the operator what happened.
    if (err instanceof GarminKeepaliveIncompleteError) {
      return { status: 'completed', outcome: err.outcome };
    }
    throw err;
  }

  return outcome
    ? { status: 'completed', outcome }
    : { status: 'not_executed', outcome: null };
}

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
export type TrainingSchedulerScope = { tenantId: number; userId: number };

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
 * Enumerate every live Training scope explicitly from Training-owned state.
 * A user may appear in multiple tenants; tenant identity is never inferred
 * from the user id.
 */
export function getActiveTrainingScopes(userIds: number[]): TrainingSchedulerScope[] {
  const scopes = new Map<string, TrainingSchedulerScope>();
  const add = (tenantValue: unknown, userValue: unknown): void => {
    const tenantId = Number(tenantValue);
    const userId = Number(userValue);
    if (!Number.isSafeInteger(tenantId) || tenantId <= 0) return;
    if (!Number.isSafeInteger(userId) || userId <= 0) return;
    scopes.set(`${tenantId}:${userId}`, { tenantId, userId });
  };

  // `users` has no tenant membership column. Treating an active user id as a
  // tenant id recreates the exact identity assumption this enumerator exists
  // to remove. Live Training-owned rows below are the authoritative scope
  // source; a user with no scoped Training state has no Training job to run.
  void userIds;

  const queries = [
    `SELECT DISTINCT tenant_id, user_id
       FROM fitness_training_plans
      WHERE status IN ('active', 'paused')`,
    `SELECT DISTINCT tenant_id, user_id
       FROM training_active_plan_references`,
    `SELECT DISTINCT tenant_id, owner_user_id AS user_id
       FROM secretary_agenda_items
      WHERE source_skill = 'training'
        AND lifecycle_state IN ('proposed', 'scheduled', 'synced', 'reflowed', 'compressed', 'deferred')`,
  ];

  try {
    const db = getDb();
    for (const sql of queries) {
      try {
        const rows = db.prepare(sql).all() as Array<{ tenant_id: unknown; user_id: unknown }>;
        for (const row of rows) add(row.tenant_id, row.user_id);
      } catch (err) {
        logUnexpectedTenantQueryError('getActiveTrainingScopes', err);
      }
    }
  } catch (err) {
    logUnexpectedTenantQueryError('getActiveTrainingScopes', err);
  }

  return [...scopes.values()].sort((left, right) =>
    left.tenantId - right.tenantId || left.userId - right.userId);
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

export async function buildEndOfDaySummaryForUser(userId: number, tenantId = userId): Promise<{
  message: string;
  summary: string;
  documentJson: Record<string, any>;
} | null> {
  const taskProvider = getTaskProviderForUser(userId);
  const pendingResult = await runWithContext({ source: 'cron:end_of_day', userId, tenantId }, async () =>
    taskProvider.getAllPendingTasks(),
  );
  if (!pendingResult.success) {
    throw new Error('END_OF_DAY_TASK_SOURCE_UNAVAILABLE');
  }

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
  const degradationReasons: string[] = [];
  try {
    const plans = getActivePlans(userId, tenantId) || [];
    const plan = plans[0] || getActivePlan(userId, tenantId);
    if (plan) {
      const week = getCurrentWeek(plan.id);
      if (week) {
        const sessions = getSessionsForWeek(week.id);
        trainingSection = buildTrainingSectionForSessions(sessions);
      }
    }
  } catch (error) {
    degradationReasons.push('training_source_unavailable');
    logger.warn({ errorName: safeErrorName(error), userId, tenantId }, 'End-of-day Training source unavailable');
  }

  if (dueToday.length === 0 && overdue.length === 0 && !trainingSection) {
    if (degradationReasons.includes('training_source_unavailable')) {
      // There is no usable report to receipt as delivered. Keep the leased
      // job retryable instead of turning a missing Training read into a green
      // no-op completion.
      throw new Error('END_OF_DAY_TRAINING_SOURCE_UNAVAILABLE');
    }
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
      degradationReasons,
    },
  };
}

export type ScheduledDailyBriefingData = DailyBriefingData & {
  /** Stable, privacy-safe source-health codes used by scheduler telemetry. */
  sourceDegradationReasons?: string[];
  /** Canonical Cooking slice from `/plan/today`, stored only in the authenticated report document. */
  planToday?: {
    date: string;
    degraded: boolean;
    cookingGated: boolean;
    dayHeadline: string;
    cooking: {
      headline: string;
      status: NonNullable<DailyBriefResponse['day']['cooking']>['status'];
      warningCodes: string[];
      meals: DailyBriefResponse['day']['meals'];
    };
  };
};

export async function buildDailyBriefingDataForUser(
  userId: number,
  tenantId = userId,
): Promise<ScheduledDailyBriefingData> {
  const userTimezone = getUserTimezoneById(userId) || config.app.timezone;
  const today = now().setZone(userTimezone);
  const todayStart = startOfDay(today);
  const todayEnd = endOfDay(today);
  const yesterday = today.minus({ days: 1 });
  const data: ScheduledDailyBriefingData = {
    date: today.toFormat('cccc, LLLL dd'),
    events: [],
    highPriorityTasks: [],
    dueTodayTasks: [],
    overdueTasks: [],
    reminders: [],
    unreadEmails: 0,
    yesterdayCompleted: 0,
    sourceDegradationReasons: [],
  };

  if (hasConnectedCalendarForUser(userId)) {
    try {
      const events = await getEvents(todayStart, todayEnd, userId);
      data.events = events.map((e) => ({
        summary: e.summary,
        start: e.start,
        end: e.end,
      }));
      const training = events.find((e) =>
        /gym|train|run|bike|cycling|workout|strength/i.test(e.summary)
      );
      if (training) {
        data.training = `${training.summary} at ${formatTimeInZone(training.start, userTimezone)}`;
      }
    } catch (err) {
      data.sourceDegradationReasons!.push('calendar_source_unavailable');
      logger.error({ err, userId }, 'Failed to fetch events for briefing');
    }
  }

  try {
    const taskProvider = getTaskProviderForUser(userId);
    const [pendingResult, yesterdayResult] = await runWithContext({ source: 'cron:daily_briefing', userId, tenantId }, async () =>
      Promise.all([
        taskProvider.getAllPendingTasks(),
        taskProvider.getCompletedTasksInRange(
          startOfDay(yesterday),
          endOfDay(yesterday),
        ),
      ]),
    );

    if (pendingResult.success) {
      const tasks = pendingResult.data;
      const todayStartMs = new Date(todayStart).getTime();
      const todayEndMs = new Date(todayEnd).getTime();

      data.highPriorityTasks = tasks
        .filter((t: TodoTask) => t.importance === 'high')
        .map((t: TodoTask) => ({ title: t.title, listName: t.listName, dueDateTime: t.dueDateTime, importance: t.importance }));

      data.dueTodayTasks = tasks
        .filter((t: TodoTask) => {
          if (!t.dueDateTime) return false;
          const due = new Date(t.dueDateTime).getTime();
          return due >= todayStartMs && due <= todayEndMs;
        })
        .map((t: TodoTask) => ({ title: t.title, listName: t.listName, dueDateTime: t.dueDateTime, importance: t.importance }));

      const MAX_OVERDUE_DISPLAY = 20;
      const allOverdue = tasks
        .filter((t: TodoTask) => t.dueDateTime && new Date(t.dueDateTime).getTime() < todayStartMs)
        .map((t: TodoTask) => {
          const daysLate = Math.ceil((todayStartMs - new Date(t.dueDateTime!).getTime()) / (1000 * 60 * 60 * 24));
          return { title: t.title, listName: t.listName, dueDateTime: t.dueDateTime, importance: t.importance, daysLate };
        })
        .sort((a: { daysLate: number }, b: { daysLate: number }) => a.daysLate - b.daysLate);
      data.overdueTasks = allOverdue.slice(0, MAX_OVERDUE_DISPLAY);
      if (allOverdue.length > MAX_OVERDUE_DISPLAY) {
        data.overdueExtra = allOverdue.length - MAX_OVERDUE_DISPLAY;
      }
    } else {
      data.sourceDegradationReasons!.push('task_pending_source_unavailable');
    }

    if (yesterdayResult.success) {
      data.yesterdayCompleted = yesterdayResult.data.length;
    } else {
      data.sourceDegradationReasons!.push('task_completion_source_unavailable');
    }
  } catch (err) {
    data.sourceDegradationReasons!.push('task_source_unavailable');
    logger.error({ err, userId }, 'Failed to fetch tasks for briefing');
  }

  const reminders = getRemindersForToday(userId, tenantId, userTimezone);
  data.reminders = reminders.map((r) => ({
    message: r.message,
    time: formatTimeInZone(r.remind_at, userTimezone),
  }));

  if (isOutlookMailConfiguredForUser(userId)) {
    try {
      data.unreadEmails = await getUnreadCountForUser(userId);
    } catch (err) {
      data.sourceDegradationReasons!.push('mail_source_unavailable');
      logger.warn({ err, userId }, 'Daily briefing: failed to fetch Outlook unread count');
    }
  }

  if (todayNotifications.length > 0) {
    data.automatedNotifications = [...todayNotifications];
  }

  try {
    const localDate = today.toISODate()!;
    const canonicalBrief = await composeDailyBrief({
      userId,
      tenantId,
      date: localDate,
    });
    data.planToday = {
      date: canonicalBrief.date,
      degraded: canonicalBrief.degraded,
      cookingGated: canonicalBrief.gated.skills.includes('cooking'),
      dayHeadline: canonicalBrief.day.headline,
      cooking: {
        headline: canonicalBrief.day.cooking?.headline
          ?? scheduledCookingHeadline(
            canonicalBrief.day.meals,
            canonicalBrief.degraded,
            canonicalBrief.gated.skills.includes('cooking'),
          ),
        status: canonicalBrief.day.cooking?.status
          ?? (canonicalBrief.gated.skills.includes('cooking') ? 'gated' : canonicalBrief.degraded ? 'unavailable' : canonicalBrief.day.meals.length > 0 ? 'ready' : 'empty'),
        warningCodes: canonicalBrief.day.cooking?.warningCodes ?? [],
        meals: canonicalBrief.day.meals,
      },
    };
  } catch (err) {
    // The legacy briefing remains deliverable if planning reads fail. This
    // additive document field never changes notification copy or policy.
    data.sourceDegradationReasons!.push('planning_source_unavailable');
    logger.warn({ err, userId, tenantId }, 'Daily briefing: canonical Cooking day unavailable');
  }

  return data;
}

function scheduledCookingHeadline(
  meals: DailyBriefResponse['day']['meals'],
  degraded = false,
  gated = false,
): string {
  if (gated) return 'Cooking coordination is gated for this account.';
  if (meals.length === 0 && degraded) return 'Cooking plan unavailable or incomplete for this day; an empty plan is not assumed.';
  if (meals.length === 0) return 'No meals planned for this day.';
  if (meals.length === 1) {
    const meal = meals[0];
    const mealType = meal.mealType ? `${meal.mealType.charAt(0).toUpperCase()}${meal.mealType.slice(1)}` : 'Meal';
    return `${mealType}: ${meal.title}`;
  }
  return `${meals.length} meals planned for this day.`;
}

function formatTimeInZone(value: string, timezone: string): string {
  const parsed = DateTime.fromISO(value, { setZone: true });
  return parsed.isValid ? parsed.setZone(timezone).toFormat('HH:mm') : formatTime(value);
}

/**
 * Decisions Nexus resolved on the user's behalf during the current week.
 *
 * Read-only over `handled_by_nexus_items`, which is written whenever a decision
 * auto-resolves. Titles come from the ledger's own privacy-classified summary
 * rows and go into a report document behind authenticated access — never onto
 * a lock screen.
 *
 * Fails soft: a weekly review that loses this section is worth far more than
 * one that fails to build.
 */
function handledByNexusThisWeek(userId: number, tenantId = userId): {
  count: number;
  highlights: string[];
  degradationReason: string | null;
} {
  try {
    const weekStart = now().startOf('week').toISO();
    const items = (listHandledByNexusItems(userId, tenantId, 25) as Array<{ title: string; createdAt: string }>)
      .filter((item) => !weekStart || item.createdAt >= weekStart);
    return {
      count: items.length,
      // Three is enough to make the point; a full list turns a retrospective
      // into a second inbox.
      highlights: items.slice(0, 3).map((item) => item.title),
      degradationReason: null,
    };
  } catch (err) {
    logger.warn({ errorName: safeErrorName(err), userId, tenantId }, 'weekly review: handled-by-Nexus section unavailable');
    return {
      count: 0,
      highlights: [],
      degradationReason: 'decision_history_source_unavailable',
    };
  }
}

export async function buildWeeklyReviewPayloadForUser(userId: number, tenantId = userId): Promise<{
  message: string;
  summary: string;
  documentJson: Record<string, any>;
}> {
  const degradationReasons: string[] = [];
  let message = `<b>📊 Week in Review</b>\n`;
  message += `${now().startOf('week').toFormat('LLL dd')} - ${now().endOf('week').toFormat('LLL dd yyyy')}\n\n`;

  const taskProvider = getTaskProviderForUser(userId);
  const timezone = getUserTimezoneById(userId);
  const weekStart = now().setZone(timezone).startOf('week').toISODate()!;
  const [todoData, calendarEvents, cookingPlan] = await Promise.all([
    Promise.resolve(runWithContext({ source: 'cron:weekly_review', userId, tenantId }, async () =>
      Promise.all([
        taskProvider.getCompletedTasksInRange(startOfWeek(), endOfWeek()),
        taskProvider.getAllPendingTasks(),
      ]),
    )).catch((err: unknown) => {
      degradationReasons.push('task_source_unavailable');
      logger.error({ err, userId }, 'Failed to fetch task data for weekly review');
      return null;
    }),
    hasConnectedCalendarForUser(userId)
      ? getEvents(startOfWeek(), endOfWeek(), userId).catch((err) => {
          degradationReasons.push('calendar_source_unavailable');
          logger.warn({ err, userId }, 'Weekly review: failed to fetch calendar events');
          return [] as any[];
        })
      : Promise.resolve([] as any[]),
    composeWeeklyPlan({ userId, tenantId, weekStart }).catch((err) => {
      degradationReasons.push('planning_source_unavailable');
      logger.warn({ err, userId, tenantId }, 'Weekly review: canonical Cooking plan unavailable');
      return null;
    }),
  ]);

  if (todoData) {
    const [completedResult, pendingResult] = todoData;
    if (!completedResult.success) degradationReasons.push('task_completion_source_unavailable');
    if (!pendingResult.success) degradationReasons.push('task_pending_source_unavailable');
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

  if (cookingPlan) {
    const cookingGated = cookingPlan.gated.skills.includes('cooking');
    message += cookingGated
      ? '\n🍳 Cooking coordination is gated for this account.\n'
      : `\n🍳 Meals planned: ${cookingPlan.summary.mealCount}\n`;
  }

  // "What Nexus handled without you" — the only slot in the product that
  // demonstrates value without asking for anything. Costs no new producer:
  // the handled-by-Nexus ledger is already written on every auto-resolved
  // decision and, until now, was read only by the Decision Center overview.
  const handled = handledByNexusThisWeek(userId, tenantId);
  if (handled.degradationReason) degradationReasons.push(handled.degradationReason);
  if (handled.count > 0) {
    message += `\n🤖 Handled without you: ${handled.count}\n`;
    for (const line of handled.highlights) message += `- ${escapeHtml(line)}\n`;
  }

  const documentJson: Record<string, any> = {
    weekStart: now().startOf('week').toISO(),
    weekEnd: now().endOf('week').toISO(),
    meetingsCount: calendarEvents.length,
    handledByNexusCount: handled.count,
    handledByNexusHighlights: handled.highlights,
    cooking: cookingPlan ? weeklyCookingReviewProjection(cookingPlan) : null,
    degradationReasons: Array.from(new Set(degradationReasons)),
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

function weeklyCookingReviewProjection(plan: WeeklyPlanResponse): Record<string, unknown> {
  return {
    weekStart: plan.weekStart,
    weekEnd: plan.weekEnd,
    degraded: plan.degraded,
    gated: plan.gated.skills.includes('cooking'),
    mealCount: plan.summary.mealCount,
    days: plan.days.map((day) => ({
      date: day.date,
      status: day.cooking?.status ?? 'unavailable',
      headline: day.cooking?.headline ?? 'Cooking plan unavailable for this day.',
      warningCodes: day.cooking?.warningCodes ?? [],
      meals: day.meals,
    })),
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
        idempotencyKey: `scheduler-calendar-conflict:${target.tenantId}:${plan.agenda.agendaItemId}:${plan.contextVersion}`,
        channel: 'automation',
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
  registerJob('apple_inbox_retry',  'Apple Inbox Reconciliation', '*/15 * * * *', 'system');
  registerJob('apple_transaction_reconciliation', 'App Store Transaction Reconciliation', '45 6 * * *', 'system');
  registerJob('ai_credit_sweeper',  'Stale AI-Credit Reservation Sweep', '30 * * * *', 'system');
  registerJob('device_inference_admission_sweeper', 'Device Inference Admission Sweep', '*/5 * * * *', 'system');
  registerJob('content_script_batch_file_cleanup', 'Content Script Batch File Cleanup', '20 2 * * *', 'system');
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
  registerJob('task_sync_delta',  'Task Provider Delta Sync', '*/5 * * * *',   'system');
  registerJob('connection_health_notify', 'Broken Connection Notices', '25 9,18 * * *', 'system');
  registerJob('travel_window_notify', 'Travel Window Notices', '40 8 * * *', 'secretary');
  registerJob('decision_recovery_notify', 'Decision Recovery Notices', '*/10 * * * *', 'system');
  registerJob('commitment_start_reminder', 'Commitment Start Reminders', '*/5 * * * *', 'secretary');
  registerJob('finance_tax_deadline', 'Tax Deadline Notices', '10 9 * * *', 'invoices');
  registerJob('training_session_reminder', 'Training Session Reminders', '*/5 * * * *', 'triathlon');
  registerJob('training_plan_calendar_sync_worker', 'Training Plan Calendar Sync Worker', '* * * * *', 'triathlon');
  registerJob('operator_alert_delivery', 'Operator Alert Delivery', '* * * * *', 'system');
  registerJob('decision_source_supersession', 'Decision Source Supersession', '*/15 * * * *', 'system');
  registerJob('decision_daily_attention', 'Decision Daily Attention Materialization', '12 * * * *', 'system');
  registerJob('decision_rank_snapshot_backfill', 'Decision Rank Snapshot Backfill', '17,47 * * * *', 'system');
  registerJob('decision_handled_history_backfill', 'Decision Handled History Backfill', '22,52 * * * *', 'system');
  registerJob('decision_expiry', 'Decision Expiry Sweep', '*/10 * * * *', 'system');
  registerJob('decision_metrics_rollup', 'Decision Metrics Local-Day Rollup', '15 * * * *', 'system');
  registerJob('decision_ledger_retention_prune', 'Decision Ledger Retention Prune', '40 4 * * *', 'system');
  registerJob('task_ledger_retention', 'Task Ledger Retention Prune', '50 4 * * *', 'system');
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
  registerJob('chat_quality_regression_monitor', 'Chat Quality Regression Monitor', '*/5 * * * *', 'system');
  registerJob('chat_quality_weekly_digest', 'Chat Quality Weekly Digest', '30 7 * * 1', 'system');
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
  // Plan §3 scheduled App Store reconciliation: retry pending/failed inbox
  // rows so a processing fault (or the pack kill switch flipping on) never
  // loses a paid notification. Inert when the inbox is empty.
  cron.schedule('*/15 * * * *', wrapJob('apple_inbox_retry', async () => {
    const { processPendingAppleNotifications } = require('./apple-notification-inbox');
    const counts = processPendingAppleNotifications();
    // stuckExhausted is a gauge of rows parked at the retry ceiling: a pass
    // with nothing else to do still deserves a log line while money is stuck.
    if (counts.processed + counts.failed + counts.exhausted
      + counts.deferred + counts.stuckExhausted === 0) return 'skipped';
    logger.info(counts, 'Apple notification inbox reconciliation pass');
  }));

  // Plan §3 (NH-0041): daily independent check behind the notification inbox.
  // Credential-gated — inert until the App Store Server API key exists.
  cron.schedule('45 6 * * *', wrapJob('apple_transaction_reconciliation', async () => {
    const { runAppleTransactionReconciliation } = require('./apple-transaction-reconciliation');
    const result = await runAppleTransactionReconciliation();
    if (result.kind !== 'completed') return 'skipped';
    logger.info(result, 'App Store transaction reconciliation pass');
  }));

  // Release AI-credit reservations that never settled (crashed worker, lost
  // process). 24h is far beyond any legitimate operation; purchase-linked
  // admissions are excluded by design because none exist as reservations.
  cron.schedule('30 * * * *', wrapJob('ai_credit_sweeper', async () => {
    const { expireStaleAiCreditReservations } = require('./ai-credit-ledger');
    const expired = expireStaleAiCreditReservations({
      olderThan: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });
    if (expired === 0) return 'skipped';
    logger.warn({ expired }, 'Expired stale AI-credit reservations');
  }));

  cron.schedule('*/5 * * * *', wrapJob('device_inference_admission_sweeper', async () => {
    const { expireStaleDeviceInferenceAdmissions } = require('./device-inference-policy');
    const expired = expireStaleDeviceInferenceAdmissions();
    if (expired === 0) return 'skipped';
    logger.info({ expired }, 'Expired stale device-inference admissions');
  }));

  cron.schedule('20 2 * * *', wrapJob('content_script_batch_file_cleanup', async () => {
    const { getDb } = require('./database');
    const { drainExpiredContentScriptBatchFiles } = require('./content-script-provider-batches');
    const db = getDb();
    const providerFiles = await drainExpiredContentScriptBatchFiles(db);
    // The provider deletion proof can make the same job immediately eligible
    // for local tombstoning. Do not leave its private fields until the next
    // midnight pass merely because the two cleanup schedules are staggered.
    const localPrivateMaterial = drainExpiredContentScriptJobPrivateMaterial(db);
    if (providerFiles.deleted + providerFiles.failed
      + localPrivateMaterial.pruned.jobsPruned === 0
      && providerFiles.backlog.eligible + providerFiles.backlog.blockedActive
        + localPrivateMaterial.backlog.eligible === 0) return 'skipped';
    if (providerFiles.backlog.eligible + providerFiles.backlog.blockedActive
      + localPrivateMaterial.backlog.eligible > 0) {
      logger.warn({ providerFiles, localPrivateMaterial },
        'Content Script private-material retention backlog remains after bounded sweep');
      return;
    }
    logger.info({ providerFiles, localPrivateMaterial },
      'Content Script private-material retention cleanup completed');
  }));

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
  cron.schedule('*/5 * * * *', wrapJob('end_of_day', async (execution) => {
    return executeScheduledReportLeaseBatch(
      'end_of_day',
      getActiveUserTargets(),
      execution,
      async (lease) => runEndOfDaySummaryForTarget(lease.target, {
        dispatchKey: `${lease.schedule.job}:${lease.schedule.localDate}`,
        requireNotificationIntent: true,
      }),
    );
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
  cron.schedule('*/5 * * * *', wrapJob('daily_briefing', async (execution) => {
    if (!config.todo.digestEnabled) return 'skipped';
    return executeScheduledReportLeaseBatch(
      'morning_briefing',
      getActiveUserTargets(),
      execution,
      async (lease) => sendDailyBriefingForTarget(lease.target, {
        dispatchKey: `${lease.schedule.job}:${lease.schedule.localDate}`,
        requireNotificationIntent: true,
      }),
    );
  }), { timezone: tz });

  // ── Weekly review (Friday 17:00) ───────────────────────────────────
  //
  // Same shape as daily_briefing: sendWeeklyReview already pushes via
  // storeAndPushReport with the reportId. The duplicate terse push
  // that used to live here has been removed.
  // Per-user schedule (migration 225): default remains Friday 17:00; the
  // profile can move both the day (cron 0=Sun..6=Sat) and the time.
  cron.schedule('*/5 * * * *', wrapJob('weekly_review', async (execution) => {
    return executeScheduledReportLeaseBatch(
      'weekly_review',
      getActiveUserTargets(),
      execution,
      async (lease) => sendWeeklyReviewForTarget(lease.target, {
        dispatchKey: `${lease.schedule.job}:${lease.schedule.localDate}`,
        requireNotificationIntent: true,
      }),
    );
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
          // K6: someone else editing a shared list is worth a line in the
          // morning brief, not an interrupt.
          priority: 'passive',
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
      { table: 'report_schedule_ledger_scoped', days: 30, tsCol: 'fired_at' },
      { table: 'error_log',         days: 60, tsCol: 'ts' },
      { table: 'client_errors',     days: 90, tsCol: 'ts' },
      { table: 'api_usage',         days: 180, tsCol: 'ts' },
      { table: 'email_log',         days: 60, tsCol: 'ts' },
      // Plan §4: content-free inference telemetry has a 90-day ceiling.
      // Evidence must be removed first because it references the admission.
      { table: 'device_inference_evidence', days: 90, tsCol: 'created_at' },
      { table: 'device_inference_admissions', days: 90, tsCol: 'issued_at' },
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

    // ── notification history: status-aware retention ───────────────
    // Kept out of the generic table loop above because an unresolved item must
    // survive regardless of age; only terminal rows age out. Before this,
    // nothing ever deleted a notification body, so event titles, task names
    // and invoice references accumulated indefinitely.
    try {
      const { pruneNotificationRetention } = require('./notification-orchestrator');
      const pruned = pruneNotificationRetention();
      const total = Object.values(pruned).reduce((sum: number, n) => sum + (n as number), 0);
      if (total > 0) logger.info(pruned, 'Retention cleanup: notification history');
    } catch (err) {
      logger.warn({ err }, 'Notification retention cleanup failed');
    }

    // ── bounded private-data retention (plan §4) ───────────────────
    // Terminal encrypted script material ages out only after provider-file
    // deletion is proven; checkpoints and encrypted fields leave in the same
    // transaction while content-free job and Batch metadata remain. Terminal
    // inference telemetry has a separate 90-day window. Safety incidents expire
    // after 365 days; governed security/admin audit evidence after 12 calendar
    // months. Active work
    // is never pruned, and statutory fiscal/billing evidence is excluded.
    try {
      const result = drainExpiredContentScriptJobPrivateMaterial(getDb());
      if (result.backlog.eligible > 0) {
        logger.warn({ ...result, days: CONTENT_SCRIPT_JOB_RETENTION_DAYS },
          'Retention backlog: terminal Content script private material');
      } else if (result.pruned.jobsPruned > 0) {
        logger.info({ ...result, days: CONTENT_SCRIPT_JOB_RETENTION_DAYS },
          'Retention cleanup: terminal Content script private material');
      }
    } catch (err) {
      logger.warn({ errorName: safeErrorName(err) }, 'Retention cleanup failed for Content script private material');
    }
    try {
      const result = drainExpiredSkillInferenceTelemetry(getDb());
      if (result.backlog.eligible > 0) {
        logger.warn({ ...result, days: SKILL_INFERENCE_TELEMETRY_RETENTION_DAYS },
          'Retention backlog: skill inference telemetry');
      } else if (result.pruned.runs > 0) {
        logger.info({ ...result, days: SKILL_INFERENCE_TELEMETRY_RETENTION_DAYS },
          'Retention cleanup: skill inference telemetry');
      }
    } catch (err) {
      logger.warn({ errorName: safeErrorName(err) }, 'Retention cleanup failed for skill inference telemetry');
    }
    try {
      const result = drainExpiredLocalInferenceSafetyIncidents(getDb());
      if (result.backlog.eligible > 0) {
        logger.warn({ ...result, days: LOCAL_INFERENCE_SAFETY_INCIDENT_RETENTION_DAYS },
          'Retention backlog: local inference safety incidents');
      } else if (result.pruned.deleted > 0) {
        logger.info({ ...result, days: LOCAL_INFERENCE_SAFETY_INCIDENT_RETENTION_DAYS },
          'Retention cleanup: local inference safety incidents');
      }
    } catch (err) {
      logger.warn({ errorName: safeErrorName(err) }, 'Retention cleanup failed for local inference safety incidents');
    }

    // Explicitly classified security/admin audit rows are kept for 12 calendar months.
    // Statutory fiscal/billing and unknown future actions fail closed outside
    // this generic pruner. Current policy supersedes migration 044's historical
    // 30-day OAuth-decrypt cleanup: decrypt access evidence is now governed by
    // the canonical 12-calendar-month security/admin boundary.
    try {
      const { getDb } = require('./database');
      const db = getDb();
      const governed = drainExpiredSecurityAdminAuditTrail(db);
      if (governed.backlog.eligible > 0) {
        logger.warn({ ...governed, months: SECURITY_ADMIN_AUDIT_RETENTION_MONTHS },
          'Retention backlog: governed audit_trail security/admin rows');
      } else if (governed.pruned.deleted > 0) {
        logger.info({ ...governed, months: SECURITY_ADMIN_AUDIT_RETENTION_MONTHS },
          'Retention cleanup: governed audit_trail security/admin rows');
      }
    } catch (err) {
      logger.warn({ errorName: safeErrorName(err) }, 'Retention cleanup failed for audit_trail');
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
  // ── Training session lead-time reminders (every 5 min) ─────────────
  // The sweep window matches the cron interval; each user's lead time comes
  // from their own workout_reminder_minutes preference.
  cron.schedule('*/5 * * * *', wrapJob('training_session_reminder', async () => {
    const { runTrainingSessionReminders } = require('./training-session-reminder');
    const scopes = getActiveTrainingScopes(getActiveUserIds());
    if (scopes.length === 0) return 'skipped';
    const summary = await runTrainingSessionReminders(scopes);
    // A sweep that failed every send must not report as healthy. `notified === 0`
    // alone returned 'skipped', which wrapJob records as success with no
    // job_history row and no activity event — so a total push outage was
    // indistinguishable from a quiet tick, and time-to-detect was unbounded.
    if (summary.failed > 0) {
      throw new Error(`training session reminders: ${summary.failed} send(s) failed`);
    }
    if (summary.notified === 0) return 'skipped';
    logger.info(summary, 'Training session reminders sent');
  }), { timezone: tz });

  // ── Commitment lead-time reminders (every 5 min) ───────────────────
  // Sibling of the training sweep above, on default_reminder_minutes.
  // Covers Nexus-owned agenda commitments only — provider-only events are
  // not cached anywhere, and reading them live per user per tick is a
  // rate-limit problem. See the module note.
  cron.schedule('*/5 * * * *', wrapJob('commitment_start_reminder', async () => {
    const { runCommitmentStartReminders } = require('./commitment-start-reminder');
    const users = getActiveUserIds();
    if (users.length === 0) return 'skipped';
    const summary = await runCommitmentStartReminders(users);
    // A sweep that failed every send must not report as healthy. `notified === 0`
    // alone returned 'skipped', which wrapJob records as success with no
    // job_history row and no activity event — so a total push outage was
    // indistinguishable from a quiet tick, and time-to-detect was unbounded.
    if (summary.failed > 0) {
      throw new Error(`commitment start reminders: ${summary.failed} send(s) failed`);
    }
    if (summary.notified === 0) return 'skipped';
    logger.info(summary, 'Commitment start reminders sent');
  }), { timezone: tz });

  // ── Tax deadline notices (09:10 daily) ─────────────────────────────
  // Once a day inside waking hours. The two stages (due-soon, due-today)
  // are resolved per user from finance_reminder_days, so a single daily
  // tick covers both without a second schedule.
  cron.schedule('10 9 * * *', wrapJob('finance_tax_deadline', async () => {
    const { runFinanceTaxDeadlineNotices } = require('./finance-tax-deadline-notifier');
    const users = getActiveUserIds();
    if (users.length === 0) return 'skipped';
    const summary = await runFinanceTaxDeadlineNotices(users);
    // A sweep that failed every send must not report as healthy. `notified === 0`
    // alone returned 'skipped', which wrapJob records as success with no
    // job_history row and no activity event — so a total push outage was
    // indistinguishable from a quiet tick, and time-to-detect was unbounded.
    if (summary.failed > 0) {
      throw new Error(`tax deadline notices: ${summary.failed} send(s) failed`);
    }
    if (summary.notified === 0) return 'skipped';
    logger.info(summary, 'Tax deadline notices sent');
  }), { timezone: tz });

  // ── Decision recovery notices (every 10 min) ───────────────────────
  // Half-applied and rolled-back executions are correctness notifications: the
  // world is changed and the user does not know. Swept rather than emitted
  // inline because emitDecisionLifecycleEvent runs mid-transaction in places.
  cron.schedule('*/10 * * * *', wrapJob('decision_recovery_notify', async () => {
    const { runDecisionRecoveryNotices } = require('./decision-recovery-notifier');
    const summary = await runDecisionRecoveryNotices();
    // A sweep that failed every send must not report as healthy. `notified === 0`
    // alone returned 'skipped', which wrapJob records as success with no
    // job_history row and no activity event — so a total push outage was
    // indistinguishable from a quiet tick, and time-to-detect was unbounded.
    if (summary.failed > 0) {
      throw new Error(`decision recovery notices: ${summary.failed} send(s) failed`);
    }
    if (summary.notified === 0) return 'skipped';
    logger.info(summary, 'Decision recovery notices sent');
  }), { timezone: tz });

  // ── Travel window notices (08:40 daily) ────────────────────────────
  // The first cross-skill producer: one trip, one decision, spanning every
  // skill that scheduled something inside the window.
  cron.schedule('40 8 * * *', wrapJob('travel_window_notify', async () => {
    const { runTravelWindowNotices } = require('./travel-window-notifier');
    const users = getActiveUserIds();
    if (users.length === 0) return 'skipped';
    const summary = await runTravelWindowNotices(users);
    // A sweep that failed every send must not report as healthy. `notified === 0`
    // alone returned 'skipped', which wrapJob records as success with no
    // job_history row and no activity event — so a total push outage was
    // indistinguishable from a quiet tick, and time-to-detect was unbounded.
    if (summary.failed > 0) {
      throw new Error(`travel window notices: ${summary.failed} send(s) failed`);
    }
    if (summary.notified === 0) return 'skipped';
    logger.info(summary, 'Travel window notices sent');
  }), { timezone: tz });

  // ── Broken connection notices (09:25 and 18:25) ────────────────────
  // Twice daily, not per-sync: a revoked authorisation does not resolve
  // itself, so probing it every 15 minutes would only add interrupt pressure.
  // Both slots sit inside waking hours so quiet hours never defers them into
  // a pile the next morning.
  cron.schedule('25 9,18 * * *', wrapJob('connection_health_notify', async () => {
    const { runConnectionHealthNotifier } = require('./connection-health-notifier');
    const users = getActiveUserIds();
    if (users.length === 0) return 'skipped';
    const summary = await runConnectionHealthNotifier(users);
    // A sweep that failed every send must not report as healthy. `notified === 0`
    // alone returned 'skipped', which wrapJob records as success with no
    // job_history row and no activity event — so a total push outage was
    // indistinguishable from a quiet tick, and time-to-detect was unbounded.
    if (summary.failed > 0) {
      throw new Error(`broken connection notices: ${summary.failed} send(s) failed`);
    }
    if (summary.notified === 0) return 'skipped';
    logger.info(summary, 'Broken connection notices sent');
  }), { timezone: tz });

  cron.schedule('*/15 * * * *', wrapJob('task_sync', async () => {
    try {
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
      //
      // M6: each per-scope run flows through the task-sync coordinator so
      // the cron can never interleave with an OAuth-connect pull, a push
      // kick, or a force-sync for the same scope (single-flight + coalesce).
      // Step order is unchanged: mutation push → provider pull →
      // link reconciliation.
      const CONCURRENCY = 5;
      let upsertedTotal = 0;
      let mutationProcessedTotal = 0;
      let reconciledTotal = 0;
      for (let i = 0; i < taskSyncScopes.length; i += CONCURRENCY) {
        const batch = taskSyncScopes.slice(i, i + CONCURRENCY);
        const settled = await Promise.allSettled(
          batch.map(async (scope) => {
            try {
              const request = requestTaskSync(
                { tenantId: scope.tenantId, userId: scope.userId },
                'cron',
                {
                  push: true,
                  pull: scope.importProviders ? 'all' : 'none',
                  reconcile: true,
                  mutationLimit: 25,
                },
              );
              const summary = await request.completion;
              const upserted = summary.pull.reduce((s: number, r: any) => s + (r.tasksUpserted || 0), 0);
              return {
                userId: scope.userId,
                tenantId: scope.tenantId,
                upserted,
                providers: summary.pull.length,
                mutationsProcessed: summary.push?.processed || 0,
                reconciledLinks: summary.reconciledLinks,
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

  // ── Unified task store: delta pull tick (every 5 min, M6) ──────────
  // Pulls ONLY delta-capable providers (adapter.capabilities.hasIncrementalSync)
  // for active import scopes while TASK_MS_DELTA_SYNC is on — this is what
  // drops inbound latency from the 45–60-min full-pull cadence to ≤5 min.
  // The */15 task_sync cron keeps the mutation batch, reconciliation, and
  // full-pull providers unchanged. Skips (no job_history noise) when the
  // flag is off or there are no scopes; runs go through the coordinator so
  // a tick can never overlap the cron/full pull for the same scope.
  cron.schedule('*/5 * * * *', wrapJob('task_sync_delta', async () => {
    try {
      if (!isTaskMsDeltaSyncEnabled()) return 'skipped';
      const users = getActiveUserIds();
      const deltaScopes = getActiveTaskSyncScopes(users).filter((scope) => scope.importProviders);
      if (deltaScopes.length === 0) return 'skipped';

      const CONCURRENCY = 5;
      let providersPulled = 0;
      let upsertedTotal = 0;
      for (let i = 0; i < deltaScopes.length; i += CONCURRENCY) {
        const batch = deltaScopes.slice(i, i + CONCURRENCY);
        const settled = await Promise.allSettled(
          batch.map(async (scope) => {
            try {
              const request = requestTaskSync(
                { tenantId: scope.tenantId, userId: scope.userId },
                'delta_tick',
                { push: false, pull: 'all', deltaOnly: true },
              );
              const summary = await request.completion;
              return {
                providers: summary.pull.length,
                upserted: summary.pull.reduce((s: number, r: any) => s + (r.tasksUpserted || 0), 0),
              };
            } catch (err) {
              logger.warn({ err, userId: scope.userId, tenantId: scope.tenantId }, 'Task delta tick failed for user scope');
              return { providers: 0, upserted: 0 };
            }
          }),
        );
        for (const s of settled) {
          if (s.status === 'fulfilled') {
            providersPulled += s.value.providers;
            upsertedTotal += s.value.upserted;
          } else {
            logger.warn({ reason: s.reason }, 'Task delta tick batch rejection');
          }
        }
      }
      if (providersPulled === 0) return 'skipped';
      logger.info({ providersPulled, upsertedTotal }, 'Task delta tick completed');
    } catch (err) {
      logger.warn({ err }, 'Task delta tick failed (sync engine may not be loaded yet)');
    }
  }), { timezone: tz });

  // ── Secretary agenda → calendar sync (every 5 min) ────────────────
  // Closes the orphaned-selectedSlot gap: arbitrator persists an agenda item
  // with selectedSlot but no cron previously pushed it to Google/Outlook.
  // Durable owner+tenant+provider-target scopes select one adapter without
  // re-deriving the user's current preference. Wave 1 batch cap is 50
  // items/scope/run with the
  // existing provider_sync_state state machine (see
  // secretary-agenda-provider-sync.ts:97 for the state enum). Outlook
  // rate limits aggressively, so retry budget is per-item not per-tick.
  // Wave 2 escalation: raise to */15 + isCronJobEnabled gate if 429s spike.
  cron.schedule('*/5 * * * *', wrapJob('secretary_agenda_sync', async () => {
    try {
      const {
        syncSecretaryAgendaItemsToProvider,
        markCompletedSecretaryAgendaItems,
        listPendingSecretaryAgendaProviderScopes,
      } = require('./secretary-agenda-provider-sync');
      const { createUnifiedCalendarSecretaryProviderAdapter } = require('./secretary-unified-calendar-provider-adapter');
      const { reconcileOrphanedTrainingAgendaEvents } = require('./training-agenda-reconciliation');
      // Sweep past items out of the active set first. Without this the
      // active set grows without bound and every past item keeps costing
      // sync-eligibility checks each tick (the sweep existed since the
      // provider-sync service shipped but was never wired into the cron).
      const completedSwept = markCompletedSecretaryAgendaItems();
      if (completedSwept > 0) {
        logger.info({ completedSwept }, '[scheduler] secretary_agenda_sync marked past agenda items completed');
      }
      const scopes = listPendingSecretaryAgendaProviderScopes();
      if (scopes.length === 0) return 'skipped';

      const PER_USER_CAP = 50;
      const CONCURRENCY = 4;
      let syncedTotal = 0;
      let readbackFailedTotal = 0;
      let reconciledTrainingAgendaTotal = 0;
      const failedScopes: Array<{
        userId: number;
        tenantId: string;
        source: 'google' | 'outlook' | 'training_reconciliation';
        failed: number;
        deadLetter: number;
      }> = [];
      const reconciledScopes = new Set<string>();

      // Every unit of work comes from the durable agenda target and carries
      // its exact owner+tenant scope. Never reconstruct tenantId from userId
      // or fan one provider-agnostic intent across connected providers.
      for (let i = 0; i < scopes.length; i += CONCURRENCY) {
        const batch = scopes.slice(i, i + CONCURRENCY);
        const settled = await Promise.allSettled(
          batch.map(async (scope: { ownerUserId: number; tenantId: string; providerSource: 'google' | 'outlook' }) => {
            const userId = scope.ownerUserId;
            const tenantId = scope.tenantId;
            const source = scope.providerSource;
            let userSynced = 0;
            let userReadbackFailed = 0;
            let userReconciledTrainingAgenda = 0;
            const reconciliationScopeKey = `${userId}:${tenantId}`;
            if (!reconciledScopes.has(reconciliationScopeKey)) {
              reconciledScopes.add(reconciliationScopeKey);
              try {
                const reconciliation = await reconcileOrphanedTrainingAgendaEvents(userId, tenantId);
                userReconciledTrainingAgenda = reconciliation.deleted;
                if (reconciliation.attempted > 0) {
                  logger.info(
                    {
                      userId,
                      tenantId,
                      attempted: reconciliation.attempted,
                      deleted: reconciliation.deleted,
                      failed: reconciliation.failed,
                    },
                    '[scheduler] secretary_agenda_sync reconciled stale Training calendar events',
                  );
                }
              } catch (err) {
                logger.warn({ err, userId, tenantId }, '[scheduler] secretary_agenda_sync training reconciliation failure');
                failedScopes.push({
                  userId,
                  tenantId,
                  source: 'training_reconciliation',
                  failed: 1,
                  deadLetter: 0,
                });
              }
            }
            try {
              const adapter = createUnifiedCalendarSecretaryProviderAdapter(source);
              const results = await syncSecretaryAgendaItemsToProvider(
                { ownerUserId: userId, tenantId, includeInactive: false },
                adapter,
                { maxItems: PER_USER_CAP },
              );
              let failed = 0;
              let deadLetter = 0;
              for (const r of results) {
                if (r.action !== 'failed' && r.providerSyncState === 'synced') userSynced += 1;
                if (r.providerSyncState === 'readback_failed') userReadbackFailed += 1;
                if (r.action === 'failed') failed += 1;
                if (r.reasonCode === 'provider_sync_dead_letter') deadLetter += 1;
              }
              if (failed > 0 || deadLetter > 0) {
                failedScopes.push({ userId, tenantId, source, failed, deadLetter });
              }
            } catch (err) {
              logger.warn({ err, userId, tenantId, source }, '[scheduler] secretary_agenda_sync per-user/source failure');
              const deadLetterCount = Number(
                (err as { deadLetterCount?: unknown } | null)?.deadLetterCount ?? 0,
              );
              failedScopes.push({
                userId,
                tenantId,
                source,
                failed: deadLetterCount > 0 ? 0 : 1,
                deadLetter: Number.isFinite(deadLetterCount) ? Math.max(0, deadLetterCount) : 0,
              });
            }
            return { userId, tenantId, synced: userSynced, readbackFailed: userReadbackFailed, reconciledTrainingAgenda: userReconciledTrainingAgenda };
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
          { syncedTotal, readbackFailedTotal, reconciledTrainingAgendaTotal, scopeCount: scopes.length },
          '[scheduler] secretary_agenda_sync complete',
        );
      }
      if (failedScopes.length > 0) {
        logger.warn({
          failedScopeCount: failedScopes.length,
          failedItemCount: failedScopes.reduce((sum, scope) => sum + scope.failed, 0),
          deadLetterCount: failedScopes.reduce((sum, scope) => sum + scope.deadLetter, 0),
        }, '[scheduler] secretary_agenda_sync completed independent scopes with failures');
        // Keep durable job history truthful without placing user identifiers
        // in the persisted error message.
        throw new Error(`SECRETARY_AGENDA_SYNC_SCOPED_FAILURES:${failedScopes.length}`);
      }
    } catch (err) {
      logger.warn({ err }, '[scheduler] secretary_agenda_sync cron failed');
      throw err;
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
  //
  // NOT gated on `isGarminConfigured()`. That reads the deployment-wide
  // GARMIN_EMAIL/GARMIN_PASSWORD pair, which is the owner's legacy credential
  // fallback; gating the whole job on it meant that on a deployment without
  // owner credentials, no connected user's tokens were ever refreshed. Users
  // who linked their own account are the reason this job exists.
  cron.schedule('5,35 * * * *', wrapJob('garmin_keepalive', async (execution) => {
    // Empty fan-out still records a successful heartbeat. Partial fan-out is a
    // truthful job failure, and every next provider effect is token-fenced.
    await runGarminKeepaliveJob('cron:garmin_keepalive', execution);
  }), { timezone: tz });

  // Immediate keepalive on startup — closes the 30-minute gap between
  // server restart and the first cron tick. Without this, a cron job
  // (coach briefing, training plan adjust) could fire during the gap
  // with expired tokens, triggering a full re-login → MFA email.
  // Runs in silent mode so a dead session doesn't send an MFA email.
  // This auxiliary wrapper deliberately uses the SAME job name and durable
  // scope as cron. Multiple replicas, or a restart near minute 5/35, therefore
  // cannot run startup and scheduled refreshes concurrently. It must not
  // replace the cron callback retained for DST recovery.
  const startupGarminKeepaliveJob = wrapJob('garmin_keepalive', async (execution) => {
    logger.info('Garmin: startup keepalive — refreshing tokens immediately (silent mode)');
    await runGarminKeepaliveJob('startup', execution);
  }, { requestSource: 'startup', storeForRecovery: false });
  setTimeout(async () => {
    try {
      await startupGarminKeepaliveJob();
    } catch (err) {
      logger.warn({ err }, 'Garmin: startup keepalive error (non-fatal)');
    }
  }, 5000); // 5s delay to let other services initialize first

  // ── Garmin coach briefing (configurable time) ──────────────────────
  if (config.garmin.coachEnabled) {
    // Per-user schedule (migration 225): default remains GARMIN_COACH_TIME
    // until a user picks their own coach time. Garmin pre-auth runs only on
    // ticks where at least one user is actually due.
    cron.schedule('*/5 * * * *', wrapJob('garmin_coach', async (execution) => {
      // Eligibility runs BEFORE the durable job is enqueued: a user with no
      // health data yet is left unclaimed and re-checked on
      // every tick inside the catch-up window, so a late Apple Health sync
      // still gets that day's briefing. The same gates remain inside
      // sendCoachBriefingForTarget as the backstop for manual triggers.
      let preAuthenticated = false;
      return executeScheduledReportLeaseBatch(
        'coach_briefing',
        getActiveTrainingTargets(),
        execution,
        async (lease) => {
          if (!preAuthenticated) {
            preAuthenticated = true;
            if (isGarminConfigured()) {
              logger.info('Coach briefing dispatch — pre-authenticating Garmin (silent mode — no MFA email if session is dead)');
              const authed = await garminEnsureAuth({ silent: true });
              if (!authed) {
                logger.warn('Coach briefing: Garmin session unrecoverable in silent mode — proceeding with whatever cached/partial data the briefing can assemble');
              }
            } else {
              logger.info('Coach briefing dispatch without global Garmin; users with Apple Health or other wearable data can still receive scoped briefings');
            }
          }
          const outcome = await runScheduledCoachBriefingForTarget(lease.target, {
            dispatchKey: `${lease.schedule.job}:${lease.schedule.localDate}`,
            requireNotificationIntent: true,
          });
          if (outcome.output?.status === 'deferred' || outcome.status === 'skipped_overlap') {
            throw new Error('SCHEDULED_COACH_REPORT_RETRY_REQUIRED');
          }
          return { degraded: (outcome.output?.errors ?? 0) > 0 };
        },
        {
          eligible: (target) => {
            const userId = target.userId ?? target.tenantId;
            return hasPaidCoachBriefingEntitlement(userId)
              && hasActiveCoachWorkoutPlan(userId, target.tenantId)
              && hasCoachableHealthDataForUser(userId);
          },
        },
      );
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
    // Pre-auth happens per user, inside the scoped loop below. It used to run
    // once here, outside any request context, producing a single process-wide
    // `garminAvailable`. Once `resolveGarminUserId` stopped falling back to
    // the owner, that call resolved no user, every hydration branch in
    // `getClient` is gated on one, and the flag became permanently false —
    // silently downgrading every user to adherence-only adjustments forever.
    logger.info('Training plan adjust starting — Garmin pre-auth runs per user (silent mode — no MFA email if a session is dead)');

    for (const { userId, tenantId } of getActiveTrainingScopes(getActiveUserIds())) {
      // Hardening 2026-04-21: wrap the per-user iteration in a
      // request context so Garmin's per-user client resolution via
      // `getCurrentContext()?.userId` actually sees the iterating
      // user. Without this, `garmin-session-store.resolveGarminUserId`
      // falls back to `getOwnerBootstrapUser()?.id` — every user's
      // readiness would be computed from the OWNER'S Garmin data and
      // then persisted as their own. Pure cross-tenant data poisoning
      // in a scheduled job. runWithContext scopes the AsyncLocalStorage
      // so all downstream reads see the correct userId.
      await runWithContext({ source: 'cron:training_plan_adjust', userId, tenantId }, async () => {
      const plan = getActivePlan(userId, tenantId);
      if (!plan) return;

      const currentWeek = getCurrentWeek(plan.id);
      if (!currentWeek) return;

      const stats = getWeeklyAdherence(plan.id, currentWeek.id);
      if (
        stats.completedSessions === 0
        && (stats.partialSessions ?? 0) === 0
        && stats.skippedSessions === 0
      ) return; // no completion disposition yet

      // Calculate and persist readiness score (only when THIS user's Garmin
      // session is confirmed available — prevents cascading 5× raw Garmin
      // calls against a dead session, each of which would independently retry
      // and could re-trigger the MFA login path we just bypassed).
      //
      // Pre-auth is per user and runs inside this scoped context, so one
      // user's dead session no longer downgrades everybody else. Users with
      // no Garmin connection skip straight to adherence-only, without an
      // auth attempt.
      let readinessScore: number | null = null;
      let readinessRec = '';
      const garminAvailable = hasActiveGarminConnection(userId)
        ? await garminEnsureAuth({ silent: true })
        : false;
      if (!garminAvailable && hasActiveGarminConnection(userId)) {
        logger.warn({ userId }, 'Training plan adjust: Garmin session unrecoverable in silent mode — adherence-only for this user (no MFA email triggered)');
      }
      if (garminAvailable) {
        try {
          const readiness = await calculateReadiness(userId, { tenantId, garminSilent: true });
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

      // Find next week and create an evidence-bound proposal if needed.
      const allWeeks = getWeeksForPlan(plan.id);
      const nextWeek = allWeeks.find((w: any) => w.week_number === currentWeek.week_number + 1);

      if (nextWeek && recommendation.adjustIntensity !== 100 && isTrainingCoachV2Enabled()) {
        try {
          const version = getDb().prepare(`
            SELECT COALESCE(adaptation_revision, 0) AS adaptationRevision
            FROM fitness_training_plans
            WHERE id = ? AND user_id = ? AND tenant_id = ? AND status IN ('active', 'paused')
          `).get(plan.id, userId, tenantId) as { adaptationRevision: number } | undefined;
          if (!version) {
            logger.warn(
              { userId, tenantId, planId: plan.id },
              'Training weekly adjustment proposal skipped because scoped plan version was unavailable',
            );
            return;
          }
          const intensityPct = Math.max(60, Math.min(110, Math.round(recommendation.adjustIntensity)));
          const reason = recommendation.reason.trim().slice(0, 500);
          if (!reason) {
            logger.warn(
              { userId, tenantId, planId: plan.id, weekId: nextWeek.id },
              'Training weekly adjustment proposal skipped because its reason was empty',
            );
            return;
          }
          const proposal = createTrainingCoachV2Proposal({
            tenantId,
            userId,
            kind: 'week_reflow',
            planId: plan.id,
            weekId: nextWeek.id,
            expectedVersion: version.adaptationRevision,
            request: {
              trigger: 'scheduled_weekly_adjustment',
              schedulingTimezone: config.app.timezone,
              scheduledAdjustment: { intensityPct, reason },
            },
            evidence: {
              schemaVersion: 'training-coach-v2.2',
              sciencePolicyVersion: getSciencePolicyVersion(loadCoachKnowledge().principles),
              source: 'scheduled_adherence_review',
              currentWeekId: currentWeek.id,
              adherenceRate: stats.adherenceRate,
              reasonCodes: ['scheduled_weekly_adjustment'],
            },
            // One proposal per exact active-plan version/week. If evidence
            // changes before approval, the same key conflicts closed instead
            // of creating duplicate Decision Center cards after a crash.
            idempotencyKey: `training-weekly-adjust:${tenantId}:${userId}:${plan.id}:${nextWeek.id}:${version.adaptationRevision}`,
            ttlMinutes: 24 * 60,
          });
          const bound = await bindTrainingCoachV2ProposalDecision({
            tenantId,
            userId,
            proposalId: proposal.proposal.proposalId,
          });
          logger.info({
            userId,
            tenantId,
            planId: plan.id,
            weekId: nextWeek.id,
            proposalId: bound.proposalId,
            decisionId: bound.decisionId,
            replayed: proposal.replayed,
          }, 'Training weekly adjustment proposed for Decision Center review');
        } catch (err) {
          logger.warn(
            { err, userId, tenantId, planId: plan.id, weekId: nextWeek.id },
            'Training weekly adjustment proposal creation failed; no plan state changed',
          );
        }
      }

      // ── Plan renewal check ───────────────────────────────────
      // If this is the LAST week of the plan, notify the user to
      // create a new cycle. Include adherence summary + readiness
      // so they can decide whether to increase or maintain.
      // K9: finishing a plan is welcome but nothing decays, so it belongs in
      // the digest rather than as an interrupt.
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
            tenantId,
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
            dedupeKey: `training:plan_renewal:${tenantId}:${userId}:${plan.id}`,
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
    // flushQueue also reconciles terminal spool-deletion proof. It must run
    // even when no pending filing rows remain.
    const result = await flushQueue();

    if (result.flushed === 0 && result.failed === 0 && result.remaining === 0) {
      return 'skipped';
    }

    if (result.failed > 0) {
      // Only permanent failures are user-facing (K2); a clean flush stays in
      // job history where operators can see it.
      let msg = `<b>Faturas por arquivar</b>\n\n`;
      msg += `${result.failed} fatura${result.failed > 1 ? 's falharam' : ' falhou'} permanentemente`;
      if (result.flushed > 0) msg += `\n${result.flushed} arquivada${result.flushed > 1 ? 's' : ''} com sucesso`;
      if (result.remaining > 0) msg += `\n${result.remaining} ainda na fila`;

      for (const userId of getOwnerUserIds()) {
        // GAP-CAL-1 fix: durable in-app notification; Telegram was a no-op.
        try {
          await createNotificationIntent({
            userId,
            tenantId: userId,
            sourceSkill: 'finance',
            // Success is not news: a */15 cron reporting that a queue drained
            // is the definition of a notification nobody is glad to receive.
            // Only the failure branch reaches the user now (K2).
            type: 'sync_failure',
            priority: 'active',
            relatedEntityId: `invoice_queue_flush:${new Date().toISOString().slice(0, 10)}`,
            relatedEntityType: 'finance_queue_flush',
            title: 'Invoices failed to file',
            body: `${result.failed} invoice${result.failed === 1 ? '' : 's'} could not be filed.`,
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
    // K3: a weekly background job announcing that it worked is not news. Only
    // failures — which cost the user analysis quality until they reconnect —
    // are surfaced.
    if (result.failed > 0) {
      const msg = `<b>Channel analysis incomplete</b>\n\n` +
        `${result.failed} failed · ${result.analyzed} analyzed`;
      for (const userId of getOwnerUserIds()) {
        await createNotificationIntent({
          userId,
          tenantId: userId,
          sourceSkill: 'content',
          type: 'sync_failure',
          priority: 'active',
          relatedEntityId: 'channel_relearn',
          relatedEntityType: 'content_channel_relearn',
          title: 'Channels failed to analyse',
          body: `${result.failed} channel${result.failed === 1 ? '' : 's'} could not be analysed.`,
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
    // One isolated run per eligible canonical tenant/user. The scheduler is
    // only an orchestrator; it never aggregates private workspaces into a
    // global content recommendation or logs their identities/content.
    const targets = getActiveUserTargets();
    if (targets.length === 0) return 'skipped';
    let succeeded = 0;
    let failed = 0;
    for (const target of targets) {
      try {
        await runPipelineAgent({ tenantId: target.tenantId, userId: target.userId });
        succeeded += 1;
      } catch (error) {
        failed += 1;
        logger.warn(
          {
            operation: 'pipeline_agent_tenant_run',
            errorCode: error instanceof Error ? error.name : 'UnknownError',
          },
          'Pipeline agent tenant run failed; continuing remaining scopes',
        );
      }
    }
    if (failed > 0) {
      logger.error(
        { attempted: targets.length, succeeded, failed },
        'Pipeline agent completed with tenant failures',
      );
      throw new Error(`Pipeline agent failed for ${failed} of ${targets.length} tenant scopes`);
    }
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
    const healthSweep = sweepExpiredStructuredHealthData({ limit: 250 });
    if (healthSweep.deleted > 0 || healthSweep.hasMore) {
      logger.info({
        deletedCount: healthSweep.deleted,
        scopesProcessed: healthSweep.scopesProcessed,
        hasMore: healthSweep.hasMore,
        limit: 250,
      }, 'Expired structured Training health data');
    }
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

  // ── M22: chat quality weekly digest (Mon 07:30 UTC) ────────────────
  // Builds the weekly chat-quality digest (eval trend, sampler captures,
  // corpus labeling progress, readiness) and records it as ONE info-severity
  // operator alert; parity/fallback readiness regressions are recorded
  // immediately at their own severity. Delivery stays with the existing
  // operator_alert_delivery job. Default ON (event-backbone kill-switch
  // precedent): set CHAT_QUALITY_WEEKLY_DIGEST_DISABLED=1 to skip.
  cron.schedule('30 7 * * 1', wrapJob('chat_quality_weekly_digest', async () => {
    if (process.env.CHAT_QUALITY_WEEKLY_DIGEST_DISABLED === '1') {
      return 'skipped';
    }
    const { runChatQualityWeeklyDigest } = await import('./chat-quality-digest');
    const result = await runChatQualityWeeklyDigest();
    logger.info(
      {
        digestRecorded: result.digestRecorded,
        regressionAlertCount: result.regressionAlertCount,
        weekStart: result.digest.weekStart,
        weekEnd: result.digest.weekEnd,
        evalRunCount: result.digest.eval.current.runCount,
        sampledCount: result.digest.sampler.current.sampledCount,
      },
      'Chat quality weekly digest recorded',
    );
  }), { timezone: 'UTC' });

  // M22: rollout-independent near-real-time quality regression path. This is
  // intentionally outside every ChatV2 activation/auto-revert conditional
  // and never depends on an active-tenant list. It reads aggregate/signed
  // evidence only and records deduped operator alerts without provider calls.
  cron.schedule('*/5 * * * *', wrapJob('chat_quality_regression_monitor', async () => {
    if (process.env.CHAT_QUALITY_REGRESSION_MONITOR_DISABLED === '1') {
      return 'skipped';
    }
    const { runChatQualityRegressionMonitor } = await import('./chat-quality-regression-monitor');
    const result = await runChatQualityRegressionMonitor();
    const regressionCount = result.readinessHealthAlertCount
      + result.readinessRegressionAlertCount
      + result.behaviorRegressionAlertCount
      + result.fallbackRegressionAlertCount;
    if (regressionCount === 0) return 'skipped';
    logger.warn(
      {
        event: 'chat_quality_regression_monitor',
        readinessAvailable: result.readinessAvailable,
        readinessArtifactHealthy: result.readinessArtifactHealthy,
        readinessHealthAlertCount: result.readinessHealthAlertCount,
        readinessRegressionAlertCount: result.readinessRegressionAlertCount,
        behaviorRegressionAlertCount: result.behaviorRegressionAlertCount,
        fallbackRegressionAlertCount: result.fallbackRegressionAlertCount,
        recordedAlertCount: result.recordedAlertCount,
      },
      'Chat quality regression monitor recorded deduped operator alerts',
    );
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
    if (result.failed > 0) {
      throw new Error(`notification delayed/digest release: ${result.failed} delivery operation(s) failed`);
    }
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
      try {
        const result = await materializeDecisionCenterDailyAttention({
          userId: target.tenantId,
          tenantId: target.tenantId,
        });
        if (result.status === 'materialized') materialized += 1;
        if (result.status === 'failed') failed += 1;
      } catch (error) {
        failed += 1;
        logger.error({
          errorName: error instanceof Error ? error.name : typeof error,
          userId: target.tenantId,
          tenantId: target.tenantId,
        }, 'Decision daily attention materialization failed for scope');
      }
    }
    if (materialized === 0 && failed === 0) return 'skipped';
    logger.info({ materialized, failed }, 'Decision daily attention materialization completed');
    if (failed > 0) {
      throw new Error(`Decision daily attention failed for ${failed} active scope(s)`);
    }
  }), { timezone: tz });

  cron.schedule('17,47 * * * *', wrapJob('decision_rank_snapshot_backfill', async () => {
    const result = runDecisionRankSnapshotBackfillJob({ limit: 500 });
    if (result.materializedScopes === 0 && result.failedScopes === 0) return 'skipped';
    logger.info(result, 'Decision rank snapshot backfill completed');
    if (result.failedScopes > 0) {
      throw new Error(`Decision rank snapshot backfill failed for ${result.failedScopes} scope(s)`);
    }
  }), { timezone: tz });

  cron.schedule('22,52 * * * *', wrapJob('decision_handled_history_backfill', async () => {
    const result = runDecisionHandledHistoryBackfillJob({ limit: 100 });
    if (result.backfilled === 0 && result.failed === 0) return 'skipped';
    logger.info(result, 'Decision handled-history backfill completed');
    if (result.failed > 0) {
      throw new Error(`Decision handled-history backfill failed for ${result.failed} decision(s)`);
    }
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

  cron.schedule('15 * * * *', wrapJob('decision_metrics_rollup', async () => {
    const result = runDecisionMetricsRollupForActiveUsers(new Date());
    if (result.rollups === 0 && result.failedScopes === 0) return 'skipped';
    logger.info(result, 'Decision metrics local-day rollup completed');
    if (result.failedScopes > 0) {
      throw new Error(`Decision metrics rollup failed for ${result.failedScopes} active scope(s)`);
    }
  }), { timezone: tz });

  cron.schedule('40 4 * * *', wrapJob('decision_ledger_retention_prune', async () => {
    const result = runDecisionLedgerRetentionPruneJob({ batchSize: 500, maxBatches: 200 });
    if (result.outcomeLedgerPruned === 0
        && result.qualityGateEventsPruned === 0
        && result.conflictEvaluationsPruned === 0
        && result.terminalExclusivityClaimsPruned === 0
        && result.rankSnapshotsPruned === 0) return 'skipped';
    logger.info(result, 'Decision ledger retention prune completed');
  }), { timezone: tz });

  cron.schedule('50 4 * * *', wrapJob('task_ledger_retention', async () => {
    const result = runTaskLedgerRetentionJob({ batchSize: 500, maxBatches: 200 });
    if (result.mutationsPruned === 0
        && result.resolvedIssuesPruned === 0
        && result.observabilityEventsPruned === 0) return 'skipped';
    logger.info(result, 'Task ledger retention prune completed');
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

  cron.schedule('* * * * *', wrapJob('training_plan_calendar_sync_worker', async () => {
    const result = await runScheduledTrainingPlanCalendarSyncJobs({
      limit: intEnv('TRAINING_PLAN_CALENDAR_SYNC_JOB_BATCH_LIMIT', 5, 1, 25),
      lockOwner: `training-plan-calendar-sync:${process.pid}`,
    });
    const touched = result.completed + result.failed + result.deadLetter;
    if (result.deadLetter > 0) {
      logger.warn(result, 'Training plan calendar sync worker produced dead-letter rows');
    }
    if (touched === 0) return 'skipped';
    logger.info(result, 'Training plan calendar sync worker completed');
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
    `Scheduler started: reminders, daily briefing (${config.todo.digestTime}), end-of-day (21:00), weekly (Fri 17:00), shared list (*/5), content topics (Tue 09:17/Thu 09:23/Fri 18:41), invoices (1st 09:00/09:15/09:30), fiscal-bundle (daily 08:10 due-check), conflict (19:30), fossa (bi-weekly Mon 07:30), garmin-keepalive (5,35), coach (${config.garmin.coachTime}), invoice-queue (*/15), channel-relearn (Sun 03:00), pipeline-agent (20:00), notification-release (*/15), decision-source-supersession (*/15), chat-action-plan-expiry (*/2), chat-action-run-zombie-reaper (*/5), chat-action-run-retention (00:20), event-backbone-worker (* * * * *), event-backbone-cleanup (00:10), nexus-points-expiry (04:00 UTC), expire-signals (hourly), db-backup (${config.backup.time}), dst-watchdog (*/15)`
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
    logger.warn({ errorName: safeErrorName(err) }, '[scheduler] coach briefing skipped: health-data eligibility check failed closed');
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
        entitlementSource: entitlement.source,
        automationReason: automationEligibility.reason,
      },
      '[scheduler] coach briefing skipped: Pro or Max plan required',
    );
  }
  return allowed;
}

function hasActiveCoachWorkoutPlan(userId: number, tenantId: number): boolean {
  try {
    const plan = getActivePlan(userId, tenantId);
    const allowed = !!plan;
    if (!allowed) {
      logger.debug('[scheduler] coach briefing skipped: active workout plan required');
    }
    return allowed;
  } catch (err) {
    logger.warn({ errorName: safeErrorName(err) }, '[scheduler] coach briefing skipped: active workout plan check failed');
    return false;
  }
}

export interface CoachBriefingDispatchResult {
  status: 'generated' | 'skipped' | 'deferred' | 'failed';
  recommendations: number;
  errors: number;
}

export interface ScheduledReportPersistenceOptions {
  dispatchKey?: string;
  requireNotificationIntent?: boolean;
}

export async function sendCoachBriefingForTarget(
  target: ActiveTrainingTarget,
  options: { runId?: string | null } & ScheduledReportPersistenceOptions = {},
): Promise<CoachBriefingDispatchResult> {
  const userId = target.userId;
  const coachScopeKey = `${target.tenantId}:${userId}`;
  // Deliberate pre-flight replacing the old accidental gate (users without
  // health data used to throw inside generateCoachBriefing AFTER burning
  // calendar fetches). The serialized daily/monthly budget reservation wraps
  // the provider boundary below.
  if (!hasPaidCoachBriefingEntitlement(userId)) {
    return { status: 'skipped', recommendations: 0, errors: 0 };
  }
  if (!hasActiveCoachWorkoutPlan(userId, target.tenantId)) {
    return { status: 'skipped', recommendations: 0, errors: 0 };
  }
  if (!hasCoachableHealthDataForUser(userId)) {
    logger.debug('[scheduler] coach briefing skipped: no health data source for user');
    return { status: 'skipped', recommendations: 0, errors: 0 };
  }
  const coachOptions = {
    tenantId: target.tenantId,
    meteringUserId: userId,
    garminSilent: true,
    budgetRequestSource: 'automation' as const,
    budgetJobName: 'garmin_coach',
    ...(options.runId ? { budgetRunId: options.runId } : {}),
  };
  return runWithCoachBriefingAccountAdmissions(userId, coachOptions, async (abortSignal) => (
    runWithContext({ source: 'cron:garmin_coach', userId, tenantId: target.tenantId }, async () => {
      let result;
      try {
        result = await generateCoachBriefing(userId, {
          ...coachOptions,
          abortSignal,
        });
      } catch (err) {
        if (err instanceof AiBudgetError) {
          // No report/state writes occur on deferral, so the latest valid
          // Coach report remains the durable read model.
          const resetKey = err.decision.unblocksAt?.replace(/[^0-9]/g, '').slice(0, 12)
            || new Date().toISOString().slice(0, 10);
          try {
            await createNotificationIntent({
              userId,
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
              dedupeKey: `training:coach_budget:${coachScopeKey}:${err.decision.code}:${resetKey}`,
              privacyPolicy: 'health',
            });
          } catch (notificationErr) {
            logger.warn({ errorName: safeErrorName(notificationErr) }, 'Coach budget deferral notice failed');
          }
          logger.info(
            { code: err.decision.code, window: err.decision.window },
            'Coach briefing deferred by AI budget; latest valid report retained',
          );
          return { status: 'deferred', recommendations: 0, errors: 0 } as const;
        }
        logger.warn({ errorName: safeErrorName(err) }, 'Coach briefing skipped for user');
        return { status: 'failed', recommendations: 0, errors: 1 } as const;
      }

      if (result.errors.length > 0) {
        logger.warn({ errorCount: result.errors.length }, 'Coach briefing completed with data gaps');
      }

      // Store recommendations so Training follow-up actions can reference
      // the correct tenant-scoped coach state.
      if (result.recommendations.length > 0) {
        setLastCoachState(
          userId,
          result.recommendations,
          result.message.substring(0, 500),
          target.tenantId,
        );
      }

      addToConversation(userId, 'triathlon', 'assistant', result.message, target.tenantId);
      setLastActiveDomain(userId, 'triathlon', target.tenantId);

      // Durable report + APNs push for the native app.
      try {
        let readinessData: any = null;
        try {
          const { calculateReadiness } = require('./readiness-scorer');
          readinessData = await calculateReadiness(userId, {
            tenantId: target.tenantId,
            garminSilent: true,
          });
        } catch { /* non-fatal */ }

        await storeAndPushReport({
          userId,
          tenantId: target.tenantId,
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
          dispatchKey: options.dispatchKey,
          requireNotificationIntent: options.requireNotificationIntent,
        });
      } catch (err) {
        if (options.requireNotificationIntent) throw err;
        logger.debug({ errorName: safeErrorName(err) }, 'Failed to store coach report (non-fatal)');
      }

      logger.info(
        {
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
    })
  ));
}

class CoachBriefingDispatchError extends Error {
  constructor(readonly result: CoachBriefingDispatchResult) {
    super('Coach briefing generation failed before a valid report was produced');
    this.name = 'CoachBriefingDispatchError';
  }
}

function scheduledCoachBriefingAdapter(
  target: ActiveTrainingTarget,
  options: ScheduledReportPersistenceOptions = {},
): GovernedAgentJobAdapter<{ tenantId: number; userId: number }, CoachBriefingDispatchResult> {
  const userId = target.userId;
  return {
    jobId: 'garmin_coach',
    providerRouting: 'gemini-primary-openai-fallback-anthropic-gated-last-resort',
    prepare: () => ({
      kind: 'ready',
      input: { tenantId: target.tenantId, userId },
      fingerprintMaterial: {
        tenantId: target.tenantId,
        userId,
        gate: 'scheduled_report_background_job',
        dispatchKey: options.dispatchKey ?? 'manual',
      },
    }),
    async execute({ runId }) {
      const result = await sendCoachBriefingForTarget(target, { runId, ...options });
      if (result.status === 'failed') throw new CoachBriefingDispatchError(result);
      return result;
    },
    validateOutput(output, input) {
      if (input.tenantId !== target.tenantId
          || input.userId !== userId
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
  target: ActiveTrainingTarget,
  options: ScheduledReportPersistenceOptions = {},
): Promise<AgentJobOutcome<CoachBriefingDispatchResult>> {
  const userId = target.userId;
  return runGovernedAgentJob(
    scheduledCoachBriefingAdapter(target, options),
    { tenantId: target.tenantId, userId },
  );
}

export async function sendCoachBriefings(): Promise<void> {
  for (const target of getActiveTrainingTargets()) {
    await sendCoachBriefingForTarget(target);
  }
}

export async function runEndOfDaySummaryForTarget(
  target: ActiveUserTarget,
  options: ScheduledReportPersistenceOptions = {},
): Promise<ScheduledReportTargetResult> {
  const userId = target.userId ?? target.tenantId;
  const report = await buildEndOfDaySummaryForUser(userId, target.tenantId);
  if (!report) return { degraded: false };

  // Store durable evening report
  try {
    await storeAndPushReport({
      userId,
      tenantId: target.tenantId,
      type: 'evening_summary' as const,
      title: 'End-of-day summary',
      summary: report.summary,
      documentJson: report.documentJson,
      sourceJob: 'end_of_day',
      pushCategory: 'evening_summary',
      dispatchKey: options.dispatchKey,
      requireNotificationIntent: options.requireNotificationIntent,
    });
  } catch (err) {
    if (options.requireNotificationIntent) throw err;
    logger.debug({ err, userId, tenantId: target.tenantId }, 'Failed to store evening summary report (non-fatal)');
  }
  return {
    degraded: Array.isArray(report.documentJson.degradationReasons)
      && report.documentJson.degradationReasons.length > 0,
  };
}

export async function sendDailyBriefingForTarget(
  target: ActiveUserTarget,
  options: ScheduledReportPersistenceOptions = {},
): Promise<ScheduledReportTargetResult> {
  const userId = target.userId ?? target.tenantId;
  const data = await buildDailyBriefingDataForUser(userId, target.tenantId);

  // ── Store durable report + push (April 2026) ────────────────────
  try {
    await storeAndPushReport({
      userId,
      tenantId: target.tenantId,
      type: 'morning_briefing' as const,
      title: `☀️ ${data.date}`,
      summary: `${data.events.length} events, ${data.dueTodayTasks.length + data.overdueTasks.length} tasks`,
      documentJson: data,
      sourceJob: 'daily_briefing',
      pushCategory: 'morning_briefing',
      dispatchKey: options.dispatchKey,
      requireNotificationIntent: options.requireNotificationIntent,
    });
  } catch (err) {
    if (options.requireNotificationIntent) throw err;
    logger.debug({ err, userId, tenantId: target.tenantId }, 'Failed to store morning briefing report (non-fatal)');
  }
  return {
    degraded: data.planToday?.degraded === true
      || (data.sourceDegradationReasons?.length ?? 0) > 0,
  };
}

// Loops every active user regardless of per-user schedule — used by the
// portal manual trigger and tests. Scheduled delivery goes through the
// leased report scheduler, which calls the ForTarget variant per due user.
export async function sendDailyBriefing(): Promise<void> {
  for (const target of getActiveUserTargets()) {
    await sendDailyBriefingForTarget(target);
  }
}

function isChatCoreV2AutoRevertEvalCronEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.CHAT_CORE_V2_AUTO_REVERT_EVAL ?? 'true').trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'off' && raw !== 'no';
}

export async function sendWeeklyReviewForTarget(
  target: ActiveUserTarget,
  options: ScheduledReportPersistenceOptions = {},
): Promise<ScheduledReportTargetResult> {
  const userId = target.userId ?? target.tenantId;
  const payload = await buildWeeklyReviewPayloadForUser(userId, target.tenantId);
  // Store durable report + push
  try {
    await storeAndPushReport({
      userId,
      tenantId: target.tenantId,
      type: 'weekly_review' as const,
      title: '📊 Week in Review',
      summary: payload.summary,
      documentJson: payload.documentJson,
      sourceJob: 'weekly_review',
      pushCategory: 'weekly_review',
      dispatchKey: options.dispatchKey,
      requireNotificationIntent: options.requireNotificationIntent,
    });
  } catch (err) {
    if (options.requireNotificationIntent) throw err;
    logger.debug({ err, userId, tenantId: target.tenantId }, 'Failed to store weekly review report (non-fatal)');
  }
  return {
    degraded: payload.documentJson.cooking == null
      || payload.documentJson.cooking.degraded === true
      || (payload.documentJson.degradationReasons?.length ?? 0) > 0,
  };
}

async function sendWeeklyReview(): Promise<void> {
  for (const target of getActiveUserTargets()) {
    await sendWeeklyReviewForTarget(target);
  }
}
