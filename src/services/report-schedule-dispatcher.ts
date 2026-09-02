// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Windowed dispatcher for the user-facing report crons.
 *
 * The morning briefing, coach briefing, end-of-day summary, and weekly
 * review used to fire from single global crons at one server-timezone
 * moment for every active user. The scheduler now ticks each of those jobs
 * every 5 minutes and asks this module which users are due, honoring each
 * user's preferred time (notification_profiles, migration 225) in the
 * canonical users.timezone. Notification profiles own delivery times and
 * quiet-hours preferences, but their copied timezone cannot move a planning
 * report onto a different local date.
 *
 * Semantics:
 * - NULL preference → the global default (TODO_DIGEST_TIME,
 *   GARMIN_COACH_TIME, 21:00, Friday 17:00), i.e. pre-migration behavior.
 * - A user is due when their preferred instant has passed and is at most
 *   REPORT_SCHEDULE_CATCHUP_MINUTES old (default 120) — that single rule
 *   covers both the normal tick and restart catch-up. Downtime longer than
 *   the catch-up window skips that day rather than delivering a stale
 *   briefing hours late.
 * - A fenced scheduled_job_execution_state lease is scoped by tenant, user,
 *   job, and local date. Success checkpoints exactly once; failures release
 *   the claim, and a crashed process is retried after lease expiry.
 * - The Decision Center report queue remains the durable outer dispatch and
 *   completion-receipt contract. The local-date fence protects compatible
 *   direct callers and the canonical report effect itself.
 */

import { DateTime } from 'luxon';
import { getDb } from './database';
import { config } from '../config';
import { getNotificationProfileIfExists, type NotificationProfile } from './notification-orchestrator';
import { getUserTimezoneById } from './user-service';
import { logger } from '../utils/logger';
import {
  claimScheduledJobExecution,
  completeScheduledJobExecution,
  isScheduledJobExecutionLeaseActive,
  renewScheduledJobExecution,
  type ScheduledJobExecutionClaim,
} from './scheduled-job-execution-state';

export type ScheduledReportJob = 'morning_briefing' | 'coach_briefing' | 'end_of_day' | 'weekly_review';

const CATCHUP_DEFAULT_MINUTES = 120;
const REPORT_EXECUTION_LEASE_TTL_MS = 15 * 60_000;
const REPORT_EXECUTION_HEARTBEAT_MS = Math.floor(REPORT_EXECUTION_LEASE_TTL_MS / 3);
const REPORT_SUCCESS_CHECKPOINT_MS = 8 * 24 * 60 * 60_000;

// Weekly artifacts stay valuable long after their slot — a deploy restart
// landing minutes past a 2h window silently skipped the 2026-07-03 weekly
// review. Daily reports keep the tight window (a stale morning briefing at
// 14:00 is noise); the weekly review catches up for a full day.
const PER_JOB_CATCHUP_DEFAULT_MINUTES: Record<ScheduledReportJob, number> = {
  morning_briefing: CATCHUP_DEFAULT_MINUTES,
  coach_briefing: CATCHUP_DEFAULT_MINUTES,
  end_of_day: CATCHUP_DEFAULT_MINUTES,
  weekly_review: 1440,
};

// Cron day-of-week convention (0=Sunday..6=Saturday). Luxon uses 1=Mon..7=Sun.
// Exported so the preferences API reports the same effective defaults the
// dispatcher resolves (morning/coach defaults come from config directly).
export const WEEKLY_REVIEW_DEFAULT_DAY = 5; // Friday
export const WEEKLY_REVIEW_DEFAULT_TIME = '17:00';
export const END_OF_DAY_DEFAULT_TIME = '21:00';

function catchupWindowMs(job: ScheduledReportJob): number {
  // The env override applies to ALL jobs (operational escape hatch);
  // otherwise each job uses its default above.
  const raw = process.env.REPORT_SCHEDULE_CATCHUP_MINUTES;
  const parsed = raw == null || raw.trim() === '' ? NaN : Number.parseInt(raw, 10);
  const minutes = Number.isFinite(parsed) && parsed > 0
    ? parsed
    : PER_JOB_CATCHUP_DEFAULT_MINUTES[job];
  return minutes * 60_000;
}

function parseTimeOfDay(value: string | null | undefined, fallback: string): { hour: number; minute: number } {
  for (const candidate of [value, fallback, '06:00']) {
    if (!candidate) continue;
    const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(candidate).trim());
    if (match) return { hour: Number(match[1]), minute: Number(match[2]) };
  }
  return { hour: 6, minute: 0 };
}

// Schedule preferences relevant to dispatch. When a user has no profile row
// yet, resolution runs read-only against the canonical user timezone
// (users.timezone) with all-default times — no profile row is created (QA
// finding: the previous get-or-create attempted an INSERT per user/job/tick,
// and a fresh row would also have pinned the schema-default Lisbon timezone
// for non-Lisbon users).
type ReportSchedulePreferences = Pick<
  NotificationProfile,
  'morningBriefingTime' | 'coachBriefingTime' | 'endOfDayTime' | 'weeklyReviewReportDay' | 'weeklyReviewReportTime'
> & { timezone: string };

function loadSchedulePreferences(userId: number, tenantId: number): ReportSchedulePreferences {
  const profile = getNotificationProfileIfExists(userId, tenantId);
  // users.timezone is the authoritative planning clock. The notification row
  // carries delivery preferences, but its copied timezone may predate the
  // routine/profile synchronization migration and must not move a report to
  // a different local date than its canonical snapshot.
  if (profile) {
    return {
      ...profile,
      timezone: getUserTimezoneById(userId),
    };
  }
  return {
    timezone: getUserTimezoneById(userId),
    morningBriefingTime: null,
    coachBriefingTime: null,
    endOfDayTime: null,
    weeklyReviewReportDay: null,
    weeklyReviewReportTime: null,
  };
}

function resolveZone(profile: ReportSchedulePreferences): string {
  for (const candidate of [profile.timezone, config.app.timezone, 'Europe/Lisbon']) {
    if (!candidate) continue;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: candidate });
      return candidate;
    } catch { /* try next */ }
  }
  return 'UTC';
}

function preferredScheduleFor(
  job: ScheduledReportJob,
  profile: ReportSchedulePreferences,
): { time: string; day: number | null } {
  switch (job) {
    case 'morning_briefing':
      return { time: profile.morningBriefingTime ?? config.todo.digestTime, day: null };
    case 'coach_briefing':
      return { time: profile.coachBriefingTime ?? config.garmin.coachTime, day: null };
    case 'end_of_day':
      return { time: profile.endOfDayTime ?? END_OF_DAY_DEFAULT_TIME, day: null };
    case 'weekly_review':
      return {
        time: profile.weeklyReviewReportTime ?? WEEKLY_REVIEW_DEFAULT_TIME,
        day: profile.weeklyReviewReportDay ?? WEEKLY_REVIEW_DEFAULT_DAY,
      };
  }
}

type ClaimedReportExecution = Extract<ScheduledJobExecutionClaim, { kind: 'claimed' }>;
const activeReportExecutionClaims = new Map<string, ClaimedReportExecution>();
const activeReportExecutionHeartbeats = new Map<string, {
  timer: NodeJS.Timeout;
  leaseLost: boolean;
}>();

function activeClaimKey(
  userId: number,
  job: ScheduledReportJob,
  tenantId: number = userId,
): string {
  return `${tenantId}:${userId}:${job}`;
}

export interface ReportScheduleExecutionIdentity {
  executionKey: string;
  localDate: string;
}

/**
 * Stable identity for the currently fenced dispatcher run. A restarted
 * process reclaims the same job/scope row and therefore derives the same key.
 * Manual report triggers have no active claim and intentionally return null.
 */
export function getActiveReportScheduleExecutionIdentity(
  userId: number,
  job: ScheduledReportJob,
): ReportScheduleExecutionIdentity | null {
  const claim = activeReportExecutionClaims.get(activeClaimKey(userId, job));
  if (!claim || claim.jobName !== `report:${job}`) return null;
  const match = /^tenant:(\d+):user:(\d+):local-date:(\d{4}-\d{2}-\d{2})$/.exec(claim.scopeKey);
  if (!match || Number(match[1]) !== userId || Number(match[2]) !== userId) return null;
  return {
    executionKey: `${claim.jobName}:${claim.scopeKey}`,
    localDate: match[3],
  };
}

/**
 * Keep a due report's fenced local-date lease alive while canonical planning,
 * document persistence, and notification intent creation are in progress.
 * Manual report calls have no active dispatcher claim and run unchanged.
 *
 * A worker that loses its fence cannot checkpoint success. Stable report and
 * notification identities make the subsequent lease owner's retry a replay
 * rather than a second user-visible report.
 */
export async function runWithReportScheduleHeartbeat<T>(
  userId: number,
  job: ScheduledReportJob,
  work: () => Promise<T>,
): Promise<T> {
  const claim = activeReportExecutionClaims.get(activeClaimKey(userId, job));
  if (!claim) return work();
  const result = await work();
  const heartbeat = activeReportExecutionHeartbeats.get(activeClaimKey(userId, job));
  const stillCurrent = activeReportExecutionClaims.get(activeClaimKey(userId, job));
  if (
    heartbeat?.leaseLost === true
    || stillCurrent?.leaseToken !== claim.leaseToken
    || !isScheduledJobExecutionLeaseActive(claim, getDb())
  ) {
    throw new Error('REPORT_SCHEDULE_EXECUTION_LEASE_LOST');
  }
  return result;
}

function startReportScheduleHeartbeat(key: string, claim: ClaimedReportExecution): void {
  const previous = activeReportExecutionHeartbeats.get(key);
  if (previous) clearInterval(previous.timer);
  let state: { timer: NodeJS.Timeout; leaseLost: boolean };
  const timer = setInterval(() => {
    if (state.leaseLost) return;
    try {
      state.leaseLost = !renewScheduledJobExecution(
        claim,
        getDb(),
        new Date(),
        REPORT_EXECUTION_LEASE_TTL_MS,
      );
    } catch {
      state.leaseLost = true;
    }
  }, REPORT_EXECUTION_HEARTBEAT_MS);
  state = { timer, leaseLost: false };
  timer.unref();
  activeReportExecutionHeartbeats.set(key, state);
}

function stopReportScheduleHeartbeat(key: string): void {
  const heartbeat = activeReportExecutionHeartbeats.get(key);
  if (heartbeat) clearInterval(heartbeat.timer);
  activeReportExecutionHeartbeats.delete(key);
}

export interface ResolveDueReportOptions<T> {
  /**
   * Gate checked AFTER a user's preferred instant is due but BEFORE the
   * ledger claim. An ineligible user is NOT claimed, so they are
   * re-evaluated on every subsequent tick and still fire if they become
   * eligible inside the catch-up window (e.g. the coach job when Apple
   * Health data syncs at 21:40 for a 21:00 preference). Once the window
   * expires the day simply passes unclaimed. Eligibility errors count as
   * eligible — the send path keeps its own gates as the backstop.
   */
  eligible?: (target: T) => boolean;
}

export interface DueReportSchedule {
  userId: number;
  tenantId: number;
  localDate: string;
  timezone: string;
  capturedAt: string;
}

/** Resolve a due local-date without consuming either a ledger row or a job. */
export function resolveDueReportSchedule<T extends { tenantId: number; userId?: number }>(
  job: ScheduledReportJob,
  target: T,
  nowUtc: DateTime = DateTime.utc(),
  options: ResolveDueReportOptions<T> = {},
): DueReportSchedule | null {
  const userId = target.userId ?? target.tenantId;
  const profile = loadSchedulePreferences(userId, target.tenantId);
  const zone = resolveZone(profile);
  const schedule = preferredScheduleFor(job, profile);
  const { hour, minute } = parseTimeOfDay(schedule.time, schedule.time);
  const localNow = nowUtc.setZone(zone);
  const windowMs = catchupWindowMs(job);

  for (const dayOffset of [0, 1]) {
    const candidateDay = localNow.minus({ days: dayOffset }).startOf('day');
    if (schedule.day != null && candidateDay.weekday % 7 !== schedule.day) continue;
    const instant = candidateDay.set({ hour, minute });
    if (!instant.isValid) continue;
    const ageMs = nowUtc.toMillis() - instant.toUTC().toMillis();
    if (ageMs < 0 || ageMs > windowMs) continue;
    if (options.eligible) {
      let userEligible = true;
      try {
        userEligible = options.eligible(target);
      } catch (err) {
        logger.debug({ err, userId, tenantId: target.tenantId, job }, 'Report schedule eligibility check failed (treating as eligible)');
      }
      if (!userEligible) return null;
    }
    return {
      userId,
      tenantId: target.tenantId,
      localDate: candidateDay.toISODate()!,
      timezone: zone,
      capturedAt: nowUtc.toUTC().toISO()!,
    };
  }

  return null;
}

/**
 * Filter `targets` down to the users due for `job` right now, claiming the
 * user-local date with a durable fenced lease as a side effect.
 * Resolution is read-only per user except for the ledger claim itself.
 * Per-user failures are logged and skipped so one bad profile can never
 * stall the whole dispatch tick.
 */
export function resolveDueReportTargets<T extends { tenantId: number; userId?: number }>(
  job: ScheduledReportJob,
  targets: T[],
  nowUtc: DateTime = DateTime.utc(),
  options: ResolveDueReportOptions<T> = {},
): T[] {
  if (targets.length === 0) return [];
  const db = getDb();
  const due: T[] = [];

  for (const target of targets) {
    try {
      const schedule = resolveDueReportSchedule(job, target, nowUtc, options);
      if (!schedule) continue;
      const claimed = claimScheduledJobExecution({
        jobName: `report:${job}`,
        scopeKey: `tenant:${schedule.tenantId}:user:${schedule.userId}:local-date:${schedule.localDate}`,
        leaseTtlMs: REPORT_EXECUTION_LEASE_TTL_MS,
        minimumSuccessIntervalMs: REPORT_SUCCESS_CHECKPOINT_MS,
        now: nowUtc.toJSDate(),
      }, db);
      if (claimed.kind === 'claimed') {
        const key = activeClaimKey(schedule.userId, job, schedule.tenantId);
        activeReportExecutionClaims.set(key, claimed);
        startReportScheduleHeartbeat(key, claimed);
        due.push(target);
      }
    } catch (err) {
      logger.warn({ err, userId: target.userId ?? target.tenantId, tenantId: target.tenantId, job }, 'Report schedule resolution failed for user (skipped this tick)');
    }
  }
  return due;
}

/**
 * Complete the current process's fenced report claim. A failed result releases
 * the lease without advancing the success checkpoint, so the next scheduler
 * tick can retry the same local-date report.
 */
export function completeReportScheduleTarget(
  userId: number,
  job: ScheduledReportJob,
  result: 'success' | 'skipped' | 'failed',
  now: Date = new Date(),
): boolean {
  const key = activeClaimKey(userId, job);
  const claim = activeReportExecutionClaims.get(key);
  if (!claim) return false;
  stopReportScheduleHeartbeat(key);
  try {
    return completeScheduledJobExecution(claim, result, getDb(), now);
  } finally {
    // This process must stop advertising the execution identity after any
    // terminal attempt. A false result means the durable fence was replaced;
    // retaining the old claim would let later work attach to an execution the
    // process no longer owns. A thrown database error is crash-equivalent and
    // the durable lease remains retryable after expiry.
    activeReportExecutionClaims.delete(key);
  }
}

/** @deprecated Use completeReportScheduleTarget(..., 'failed'). */
export function releaseFreshReportScheduleClaim(
  userId: number,
  job: ScheduledReportJob,
  _maxAgeMinutes = 10,
): boolean {
  try {
    return completeReportScheduleTarget(userId, job, 'failed');
  } catch (err) {
    logger.warn({ err, userId, job }, 'Fresh report schedule claim release failed');
    return false;
  }
}

export function _resetReportScheduleDispatcherForTests(): void {
  for (const key of activeReportExecutionHeartbeats.keys()) {
    stopReportScheduleHeartbeat(key);
  }
  activeReportExecutionClaims.clear();
}
