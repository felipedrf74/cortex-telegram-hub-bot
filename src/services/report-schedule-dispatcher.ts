// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Windowed dispatcher for the user-facing report crons.
 *
 * The morning briefing, coach briefing, end-of-day summary, and weekly
 * review used to fire from single global crons at one server-timezone
 * moment for every active user. The scheduler now ticks each of those jobs
 * every 5 minutes and asks this module which users are due, honoring each
 * user's preferred time (notification_profiles, migration 225) in the
 * profile timezone — the same timezone quiet hours already use, so a
 * briefing never schedules itself into its own quiet window by disagreeing
 * about the clock.
 *
 * Semantics:
 * - NULL preference → the global default (TODO_DIGEST_TIME,
 *   GARMIN_COACH_TIME, 21:00, Friday 17:00), i.e. pre-migration behavior.
 * - A user is due when their preferred instant has passed and is at most
 *   REPORT_SCHEDULE_CATCHUP_MINUTES old (default 120) — that single rule
 *   covers both the normal tick and restart catch-up. Downtime longer than
 *   the catch-up window skips that day rather than delivering a stale
 *   briefing hours late.
 * - The compatibility resolver can still claim the legacy fire ledger. New
 *   scheduler callers use report-schedule-jobs, where generation is leased,
 *   retryable, and acknowledged by a scoped completion receipt.
 */

import { DateTime } from 'luxon';
import { getDb } from './database';
import { config } from '../config';
import { createDecisionPlanningContext } from './decision-planning-context';
import { getNotificationProfileIfExists, type NotificationProfile } from './notification-orchestrator';
import { getUserTimezoneById } from './user-service';
import { logger } from '../utils/logger';

export type ScheduledReportJob = 'morning_briefing' | 'coach_briefing' | 'end_of_day' | 'weekly_review';

const CATCHUP_DEFAULT_MINUTES = 120;

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
  if (profile) return profile;
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

function assertLedgerTableReady(db: ReturnType<typeof getDb>): void {
  // Migration 304 owns this schema. Runtime dispatch must never repair schema
  // or run DDL on a request/job path; absence is a readiness failure.
  db.prepare(`
    SELECT user_id, tenant_id, job_type, fired_for_local_date, fired_at
      FROM report_schedule_ledger_scoped
     LIMIT 0
  `).all();
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
  const planningContext = createDecisionPlanningContext({
    userId,
    tenantId: target.tenantId,
    timezone: zone,
    locale: 'und',
    now: nowUtc.toJSDate(),
  });
  const localNow = DateTime.fromISO(planningContext.nowUtc, { zone: 'utc' }).setZone(planningContext.timezone);
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
      timezone: planningContext.timezone,
      capturedAt: planningContext.nowUtc,
    };
  }

  return null;
}

/**
 * Filter `targets` down to the users due for `job` right now, claiming the
 * user-local date in the ledger as a side effect (at-most-once per day).
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
  assertLedgerTableReady(db);
  const claim = db.prepare(`
    INSERT OR IGNORE INTO report_schedule_ledger_scoped (user_id, tenant_id, job_type, fired_for_local_date)
    VALUES (?, ?, ?, ?)
  `);
  const due: T[] = [];

  for (const target of targets) {
    try {
      const schedule = resolveDueReportSchedule(job, target, nowUtc, options);
      if (!schedule) continue;
      const claimed = claim.run(schedule.userId, schedule.tenantId, job, schedule.localDate);
      if (Number(claimed.changes) === 1) due.push(target);
    } catch (err) {
      logger.warn({ err, userId: target.userId ?? target.tenantId, tenantId: target.tenantId, job }, 'Report schedule resolution failed for user (skipped this tick)');
    }
  }
  return due;
}

/**
 * Release only the fresh claim created by the current dispatch tick. Used for
 * transient provider-budget lock contention so the same local-date report can
 * retry on the next five-minute tick instead of being lost for the day.
 */
export function releaseFreshReportScheduleClaim(
  userId: number,
  job: ScheduledReportJob,
  maxAgeMinutes = 10,
  tenantId: number = userId,
): boolean {
  try {
    const db = getDb();
    assertLedgerTableReady(db);
    const result = db.prepare(`
      DELETE FROM report_schedule_ledger_scoped
       WHERE rowid = (
         SELECT rowid FROM report_schedule_ledger_scoped
          WHERE user_id = ? AND tenant_id = ? AND job_type = ?
            AND fired_at >= datetime('now', ?)
          ORDER BY fired_at DESC
          LIMIT 1
       )
    `).run(userId, tenantId, job, `-${Math.max(1, Math.floor(maxAgeMinutes))} minutes`);
    return Number(result.changes) === 1;
  } catch (err) {
    logger.warn({ err, userId, tenantId, job }, 'Fresh report schedule claim release failed');
    return false;
  }
}
