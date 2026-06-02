// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Missed-session sweep — slice C1 of the Week-Level Adaptability +
 * Periodization plan (v2.1).
 *
 * Reconstructs concrete session dates from
 * `plan.start_date + week.week_number + session.day_of_week`
 * interpreted in the plan's timezone, then identifies sessions
 * whose deadlines have passed without a matching completion.
 *
 * Hard rules (per v2.1 critique):
 *
 *   - Local timezone: dates use the user's local time, not UTC
 *     midnight. We model this with a per-plan `timezoneOffsetHours`
 *     (caller provides; we fall back to 0 = UTC).
 *
 *   - Grace period: a session is NOT marked missed until its
 *     deadline has passed. Default 12h for key sessions, 24h for
 *     easy aerobic. Configurable.
 *
 *   - External-training exclusion: if the matching completion has
 *     `external_training_declared = 1`, do NOT mark the session
 *     missed (athlete did it but didn't follow the prescribed
 *     pattern).
 *
 *   - Preview-active exclusion: if a session has been auto-moved
 *     by an active preview (ledger row with scope='preview' that
 *     mentions this session), do NOT mark missed.
 */

import { getDb } from './database';
import { logger } from '../utils/logger';
import { actionableStatusesSqlList } from './coach-kernel/session-status';

// R4 P2 fix — single source of truth for "candidate for adaptive
// mutation." Replaces a hand-rolled `IN ('pending', 'scheduled')`
// literal that could drift away from the canonical allowlist in
// session-status.ts.
const ACTIONABLE_SQL_LIST = actionableStatusesSqlList();

export type MissedSessionSeverity = 'minor' | 'standard' | 'key';

export interface MissedSessionSignal {
  userId: number;
  planId: number;
  sessionId: number;
  sessionTitle: string;
  scheduledDate: string;
  daysSinceMissed: number;
  sessionType: string;
  severity: MissedSessionSeverity;
  isKeySession: boolean;
}

export interface DetectMissedSessionsInput {
  userId: number;
  /** ISO date "now" — caller-controllable for tests + replay. */
  asOfISODate: string;
  /** Plan timezone offset in hours (e.g., -8 for PST). Default 0 = UTC. */
  timezoneOffsetHours?: number;
  /** Grace hours for key sessions (default 12). */
  gracePeriodHoursKey?: number;
  /** Grace hours for easy/aerobic sessions (default 24). */
  gracePeriodHoursEasy?: number;
}

const DAY_TO_INDEX: Record<string, number> = {
  monday: 0,
  tuesday: 1,
  wednesday: 2,
  thursday: 3,
  friday: 4,
  saturday: 5,
  sunday: 6,
};

/**
 * Compute the concrete date a session was scheduled for.
 *
 * Returns null when day_of_week is not a recognized name.
 */
export function computeSessionScheduledDate(
  planStartDate: string,
  weekNumber: number,
  dayOfWeek: string,
): string | null {
  const dayIndex = DAY_TO_INDEX[dayOfWeek.toLowerCase()];
  if (dayIndex === undefined) return null;
  const start = Date.parse(planStartDate);
  if (!Number.isFinite(start)) return null;
  const weekOffset = (weekNumber - 1) * 7 * 24 * 3600 * 1000;
  const dayOffset = dayIndex * 24 * 3600 * 1000;
  return new Date(start + weekOffset + dayOffset).toISOString().slice(0, 10);
}

/**
 * Has the deadline passed for a session scheduled on `scheduledDate`
 * relative to `asOfISODate`, given the grace period?
 */
function deadlinePassed(
  scheduledDate: string,
  asOfISODate: string,
  graceHours: number,
  timezoneOffsetHours: number,
): { passed: boolean; daysSince: number } {
  const scheduledLocal = Date.parse(scheduledDate + 'T23:59:59Z');
  const tzAdjusted = scheduledLocal - timezoneOffsetHours * 3600 * 1000;
  const deadlineMs = tzAdjusted + graceHours * 3600 * 1000;
  const now = Date.parse(asOfISODate);
  if (!Number.isFinite(now) || !Number.isFinite(deadlineMs)) {
    return { passed: false, daysSince: 0 };
  }
  const daysSince = Math.max(0, Math.floor((now - deadlineMs) / (24 * 3600 * 1000)));
  return { passed: now > deadlineMs, daysSince };
}

/**
 * Detect missed sessions for a user. Returns one MissedSessionSignal
 * per session whose deadline passed without a completion AND that
 * isn't excluded by an external-training-declared completion or an
 * active preview adaptation.
 */
export function detectMissedSessions(
  input: DetectMissedSessionsInput,
): MissedSessionSignal[] {
  const db = getDb();
  const gracePeriodKey = input.gracePeriodHoursKey ?? 12;
  const gracePeriodEasy = input.gracePeriodHoursEasy ?? 24;
  const tz = input.timezoneOffsetHours ?? 0;

  // Fetch active plans for this user with their pending/missed sessions.
  // Codex R2 P2 fix — JSON-aware preview match. The previous
  // `LIKE '%"sessionId":N%'` pattern (a) matched the wrong key
  // (recordPreviewAdaptation writes `weekId` + `sessionsToPreserve`,
  // not `sessionId`), and (b) was vulnerable to substring collisions
  // (sessionId 12 matched 123). We now use SQLite's `json_each` to
  // walk the `sessionsToPreserve` array with EXACT integer equality,
  // and also tolerate the legacy `sessionId` literal field for
  // backwards compatibility with any in-flight rows.
  const rows = db.prepare(`
    SELECT
      p.id AS plan_id,
      p.start_date AS plan_start,
      w.week_number,
      s.id AS session_id,
      s.title AS session_title,
      s.day_of_week,
      s.session_type,
      s.status,
      (
        SELECT external_training_declared FROM training_completions
        WHERE session_id = s.id
        ORDER BY id DESC LIMIT 1
      ) AS external_training_declared,
      (
        SELECT COUNT(*) FROM training_completions
        WHERE session_id = s.id
      ) AS completion_count,
      (
        SELECT COUNT(*) FROM training_plan_adaptations a
        WHERE a.plan_id = p.id
          AND a.scope = 'preview'
          AND a.trigger_payload_json IS NOT NULL
          -- R3 P2 fix — json_valid guard. A single corrupt payload
          -- in the ledger would otherwise abort the whole sweep with
          -- a SQLite JSON parse error.
          AND json_valid(a.trigger_payload_json)
          AND (
            -- Match the canonical sessionsToPreserve array via json_each.
            EXISTS (
              SELECT 1 FROM json_each(
                COALESCE(json_extract(a.trigger_payload_json, '$.sessionsToPreserve'), '[]')
              ) je WHERE je.value = s.id
            )
            -- Tolerate the legacy literal sessionId field too.
            OR json_extract(a.trigger_payload_json, '$.sessionId') = s.id
          )
      ) AS preview_count
    FROM fitness_training_plans p
    JOIN training_weeks w ON w.plan_id = p.id
    JOIN training_sessions s ON s.week_id = w.id
    WHERE p.user_id = ? AND p.status = 'active'
      AND s.status IN (${ACTIONABLE_SQL_LIST})
  `).all(input.userId) as Array<{
    plan_id: number;
    plan_start: string;
    week_number: number;
    session_id: number;
    session_title: string;
    day_of_week: string;
    session_type: string;
    status: string;
    external_training_declared: number | null;
    completion_count: number;
    preview_count: number;
  }>;

  const signals: MissedSessionSignal[] = [];
  for (const r of rows) {
    // Exclude if external training was declared.
    if (r.external_training_declared === 1) continue;
    // Exclude if already completed.
    if (r.completion_count > 0) continue;
    // Exclude if an active preview moves this session.
    if (r.preview_count > 0) continue;

    const scheduledDate = computeSessionScheduledDate(
      r.plan_start,
      r.week_number,
      r.day_of_week,
    );
    if (!scheduledDate) continue;

    // Determine severity from session type.
    const isKey = /^threshold_|^interval_|^vo2_|^long_/.test(r.session_type) || /key|threshold|interval|vo2|long/i.test(r.session_title);
    const grace = isKey ? gracePeriodKey : gracePeriodEasy;

    const { passed, daysSince } = deadlinePassed(scheduledDate, input.asOfISODate, grace, tz);
    if (!passed) continue;

    signals.push({
      userId: input.userId,
      planId: r.plan_id,
      sessionId: r.session_id,
      sessionTitle: r.session_title,
      scheduledDate,
      daysSinceMissed: daysSince,
      sessionType: r.session_type,
      severity: isKey ? 'key' : daysSince <= 1 ? 'minor' : 'standard',
      isKeySession: isKey,
    });
  }

  if (signals.length > 0) {
    logger.info({ userId: input.userId, missedCount: signals.length }, 'missed_session_sweep.detected');
  }
  return signals;
}
