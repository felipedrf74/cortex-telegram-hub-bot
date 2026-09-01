// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Adherence Signals Orchestrator — Phase 4 Slice C
 *
 * Composes session-analytics + training-signals into a single
 * entry-point that computes weekly adherence for a user and publishes
 * the appropriate cross-skill signal (or does nothing if the user is
 * in the normal band).
 *
 * Thresholds (locked by tests):
 *
 *   adherence < 60%              → low_adherence (urgent)
 *   adherence = 100% AND planned >= 3 → high_adherence (normal)
 *   everything in between        → no signal
 *
 * The 100% threshold includes a planned >= 3 gate so a trivial week
 * (1/1 sessions, or worse 0/0) never triggers a false "crushing it"
 * signal. A 0/0 week isn't "perfect adherence" — it's "no plan".
 *
 * Idempotency: re-running this function on the same user while a
 * signal for the same weekly adherence snapshot is already active
 * is a no-op. Active rows from an older plan/week/session-count are
 * replaced in one transaction, so a rejected fresh write cannot retire the
 * last valid signal observed by the UI or coaches.
 */

import { DateTime } from 'luxon';
import {
  computeWeeklyAdherence,
  type WeeklyAdherence,
  getWeeklyActivitySummary,
  type SportKey,
} from './session-analytics';
import {
  publishLowAdherence,
  publishHighAdherence,
  publishPlanDrift,
} from './training-signals';
import { logger } from '../utils/logger';
import { getDb } from './database';
import { now } from '../utils/date-parser';
import { requireTenantIdParam } from './tenant-scope';

// ─── Thresholds ─────────────────────────────────────────────────

/** Adherence fraction below which we publish `low_adherence`. */
export const LOW_ADHERENCE_THRESHOLD = 0.60;

/**
 * Minimum planned sessions in a week before `high_adherence` is
 * eligible to fire. Prevents 1/1 weeks from generating false positives
 * when the user is just starting out or has a minimal plan.
 */
export const HIGH_ADHERENCE_MIN_PLANNED = 3;

// ─── Result type ────────────────────────────────────────────────

/**
 * What happened when the orchestrator ran. The `action` field lets
 * tests and callers know whether a new signal was written, a stale
 * signal was kept, or nothing matched the thresholds.
 */
export interface AdherenceSignalResult {
  adherence: WeeklyAdherence;
  action:
    | 'published_low'    // new low_adherence row written
    | 'published_high'   // new high_adherence row written
    | 'skipped_existing' // matching signal already active, no duplicate write
    | 'skipped_neutral'  // user is in the 60–100% band, nothing to publish
    | 'skipped_no_plan'  // no active plan, nothing to compute
    | 'skipped_no_sessions'; // plan exists but this week has zero planned sessions
}

// ─── Core orchestrator ──────────────────────────────────────────

type ActiveAdherenceSignal = {
  id: number;
  signal_type: 'low_adherence' | 'high_adherence';
  payload: Record<string, unknown>;
};

type ActivePlanDriftSignal = {
  id: number;
  payload: Record<string, unknown>;
};

function parseSignalPayload(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw !== 'string') {
    return typeof raw === 'object' ? raw as Record<string, unknown> : {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function readActiveAdherenceSignalsForUser(userId: number, tenantId: number): ActiveAdherenceSignal[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, signal_type, payload
    FROM agent_signals
    WHERE user_id = ? AND tenant_id = ?
      AND status = 'active'
      AND julianday(expires_at) > julianday('now')
      AND signal_type IN ('low_adherence', 'high_adherence')
    ORDER BY created_at DESC, id DESC
  `).all(userId, tenantId) as Array<{ id: number; signal_type: string; payload: unknown }>;

  return rows
    .filter((row): row is { id: number; signal_type: 'low_adherence' | 'high_adherence'; payload: unknown } =>
      row.signal_type === 'low_adherence' || row.signal_type === 'high_adherence',
    )
    .map((row) => ({
      id: row.id,
      signal_type: row.signal_type,
      payload: parseSignalPayload(row.payload),
    }));
}

function sameIsoInstant(a: unknown, b: string): boolean {
  if (typeof a !== 'string') return false;
  const left = DateTime.fromISO(a);
  const right = DateTime.fromISO(b);
  if (!left.isValid || !right.isValid) return a === b;
  return left.toUTC().toISO() === right.toUTC().toISO();
}

function signalMatchesAdherenceSnapshot(
  signal: ActiveAdherenceSignal,
  targetType: 'low_adherence' | 'high_adherence',
  adherence: WeeklyAdherence,
): boolean {
  const payload = signal.payload;
  return signal.signal_type === targetType
    && Number(payload.completed) === adherence.completed
    && Number(payload.partial ?? 0) === adherence.partial
    && Number(payload.planned) === adherence.planned
    && sameIsoInstant(payload.week_start, adherence.weekStart)
    && sameIsoInstant(payload.week_end, adherence.weekEnd);
}

function dismissStaleAdherenceSignals(
  userId: number,
  tenantId: number,
  signals: ActiveAdherenceSignal[],
  keepId?: number,
): void {
  const stale = signals.filter((signal) => signal.id !== keepId);
  const dismiss = getDb().prepare(`
    UPDATE agent_signals
       SET status = 'dismissed'
     WHERE id = ?
       AND user_id = ?
       AND tenant_id = ?
       AND status = 'active'
  `);
  for (const signal of stale) {
    dismiss.run(signal.id, userId, tenantId);
  }
  if (stale.length > 0) {
    logger.info(
      { userId, tenantId, staleIds: stale.map((signal) => signal.id), keptId: keepId ?? null },
      'stale adherence signals dismissed',
    );
  }
}

function clearAdherenceSignalsAtomically(userId: number, tenantId: number): void {
  const db = getDb();
  db.transaction(() => {
    dismissStaleAdherenceSignals(
      userId,
      tenantId,
      readActiveAdherenceSignalsForUser(userId, tenantId),
    );
  })();
}

function readActivePlanDriftSignalsForUser(userId: number, tenantId: number): ActivePlanDriftSignal[] {
  const rows = getDb().prepare(`
    SELECT id, payload
    FROM agent_signals
    WHERE user_id = ? AND tenant_id = ?
      AND status = 'active'
      AND julianday(expires_at) > julianday('now')
      AND signal_type = 'plan_drift'
    ORDER BY created_at DESC, id DESC
  `).all(userId, tenantId) as Array<{ id: number; payload: unknown }>;

  return rows.map((row) => ({ id: row.id, payload: parseSignalPayload(row.payload) }));
}

function dismissPlanDriftSignals(
  userId: number,
  tenantId: number,
  signals: ActivePlanDriftSignal[],
  keepId?: number,
): void {
  const dismiss = getDb().prepare(`
    UPDATE agent_signals
       SET status = 'dismissed'
     WHERE id = ?
       AND user_id = ?
       AND tenant_id = ?
       AND status = 'active'
  `);
  for (const signal of signals) {
    if (signal.id !== keepId) dismiss.run(signal.id, userId, tenantId);
  }
}

function clearPlanDriftSignalsAtomically(userId: number, tenantId: number): void {
  const db = getDb();
  db.transaction(() => {
    dismissPlanDriftSignals(userId, tenantId, readActivePlanDriftSignalsForUser(userId, tenantId));
  })();
}

function planDriftSignalMatchesSnapshot(
  signal: ActivePlanDriftSignal,
  snapshot: {
    planSport: string;
    dominantSport: SportKey;
    driftPct: number;
    sessionsInWindow: number;
  },
): boolean {
  return signal.payload.plan_sport === snapshot.planSport
    && signal.payload.dominant_sport === snapshot.dominantSport
    && Number(signal.payload.drift_pct) === Math.round(snapshot.driftPct)
    && Number(signal.payload.sessions_in_window) === snapshot.sessionsInWindow
    && Number(signal.payload.window_weeks) === PLAN_DRIFT_WINDOW_WEEKS;
}

function replacePlanDriftSignalAtomically(input: {
  userId: number;
  tenantId: number;
  planSport: string;
  dominantSport: SportKey;
  driftPct: number;
  sessionsInWindow: number;
}): 'published' | 'existing' {
  const db = getDb();
  return db.transaction(() => {
    const activeSignals = readActivePlanDriftSignalsForUser(input.userId, input.tenantId);
    const matchingSignal = activeSignals.find((signal) => planDriftSignalMatchesSnapshot(signal, input));
    if (matchingSignal) {
      dismissPlanDriftSignals(input.userId, input.tenantId, activeSignals, matchingSignal.id);
      return 'existing' as const;
    }

    const replacementId = publishPlanDrift({
      userId: input.userId,
      tenantId: input.tenantId,
      planSport: input.planSport,
      dominantSport: input.dominantSport,
      driftPct: input.driftPct,
      sessionsInWindow: input.sessionsInWindow,
      windowWeeks: PLAN_DRIFT_WINDOW_WEEKS,
    });
    if (!Number.isInteger(replacementId) || replacementId <= 0) {
      throw new Error('plan drift signal replacement was not persisted');
    }
    dismissPlanDriftSignals(input.userId, input.tenantId, activeSignals);
    return 'published' as const;
  })();
}

function replaceAdherenceSignalAtomically(input: {
  userId: number;
  tenantId: number;
  targetType: 'low_adherence' | 'high_adherence';
  adherence: WeeklyAdherence;
  publish: () => number;
}): 'published' | 'existing' {
  const db = getDb();
  return db.transaction(() => {
    const activeSignals = readActiveAdherenceSignalsForUser(input.userId, input.tenantId);
    const matchingSignal = activeSignals.find((signal) =>
      signalMatchesAdherenceSnapshot(signal, input.targetType, input.adherence),
    );
    if (matchingSignal) {
      dismissStaleAdherenceSignals(input.userId, input.tenantId, activeSignals, matchingSignal.id);
      return 'existing' as const;
    }

    // Persist the replacement before retiring the old projection. A rejected
    // governed write throws, and better-sqlite3 rolls the whole transaction
    // back, leaving the last valid signal active.
    const replacementId = input.publish();
    if (!Number.isInteger(replacementId) || replacementId <= 0) {
      throw new Error('adherence signal replacement was not persisted');
    }
    dismissStaleAdherenceSignals(input.userId, input.tenantId, activeSignals);
    return 'published' as const;
  })();
}

/**
 * Compute this user's weekly adherence and publish the matching
 * signal if a threshold is crossed AND no active signal of that type
 * already exists.
 *
 * Called from the /api/v1/training/activity/weekly endpoint on every
 * fetch — which means every time the iOS Training tab opens, we
 * re-evaluate and maybe publish a signal. The idempotency gate
 * means the bus never grows by more than one row per user per day
 * even under aggressive tab-bouncing.
 */
export function publishAdherenceSignalsForUser(userId: number, tenantId: number, referenceDate?: DateTime): AdherenceSignalResult {
  const scopedTenantId = requireTenantIdParam(tenantId, 'publishAdherenceSignalsForUser');
  const adherence = computeWeeklyAdherence(userId, scopedTenantId, referenceDate);

  if (!adherence.hasActivePlan) {
    clearAdherenceSignalsAtomically(userId, scopedTenantId);
    return { adherence, action: 'skipped_no_plan' };
  }
  if (adherence.planned === 0) {
    clearAdherenceSignalsAtomically(userId, scopedTenantId);
    return { adherence, action: 'skipped_no_sessions' };
  }

  // ── Decide which threshold (if any) the user hit ──
  const isLow = adherence.ratio < LOW_ADHERENCE_THRESHOLD;
  const isHigh =
    adherence.ratio >= 1.0 && adherence.planned >= HIGH_ADHERENCE_MIN_PLANNED;

  if (!isLow && !isHigh) {
    clearAdherenceSignalsAtomically(userId, scopedTenantId);
    return { adherence, action: 'skipped_neutral' };
  }

  const targetType = isLow ? 'low_adherence' : 'high_adherence';
  const replacement = replaceAdherenceSignalAtomically({
    userId,
    tenantId: scopedTenantId,
    targetType,
    adherence,
    publish: () => isLow
      ? publishLowAdherence({
        userId,
        tenantId: scopedTenantId,
        completed: adherence.completed,
        partial: adherence.partial,
        planned: adherence.planned,
        weekStart: adherence.weekStart,
        weekEnd: adherence.weekEnd,
        reason: adherence.skipped > 0
          ? `${adherence.skipped} session(s) explicitly skipped`
          : adherence.partial > 0
            ? `${adherence.partial} session(s) partially completed`
            : `${adherence.planned - adherence.completed} session(s) missed`,
      })
      : publishHighAdherence({
        userId,
        tenantId: scopedTenantId,
        completed: adherence.completed,
        partial: adherence.partial,
        planned: adherence.planned,
        weekStart: adherence.weekStart,
        weekEnd: adherence.weekEnd,
      }),
  });

  if (replacement === 'existing') {
    logger.debug(
      { userId, tenantId: scopedTenantId, targetType },
      'matching adherence signal already active — skipping duplicate publish',
    );
    return { adherence, action: 'skipped_existing' };
  }

  if (isLow) {
    logger.info(
      { userId, tenantId: scopedTenantId, completed: adherence.completed, partial: adherence.partial, planned: adherence.planned, pct: adherence.percentage },
      'low_adherence signal published',
    );
    return { adherence, action: 'published_low' };
  }

  logger.info(
    { userId, tenantId: scopedTenantId, completed: adherence.completed, planned: adherence.planned },
    'high_adherence signal published',
  );
  return { adherence, action: 'published_high' };
}

// ═══════════════════════════════════════════════════════════════
// Phase 4 Slice G — Plan drift detector
// ═══════════════════════════════════════════════════════════════
//
// Adherence answers "how many of the planned sessions is the user
// doing?". Plan drift answers the orthogonal question: "of the
// sessions the user IS doing, do they actually match the plan's
// sport?"
//
// Example: a hybrid plan schedules 2 gym + 3 run sessions per week.
// The user does 3 runs (so 60% adherence) but skips every gym day
// and adds a Saturday run instead. Adherence looks moderate — but
// the user has effectively pivoted to a running-only program
// without telling the coach. Plan drift catches that.
//
// Algorithm:
//
//   1. Resolve the user's active plan's declared sport (from
//      fitness_training_plans.sport). Normalize to a canonical
//      SportKey so the rest of the code can compare directly.
//   2. Count completions by sport over a 4-week lookback via the
//      existing session-analytics pipeline — no new SQL.
//   3. Find the DOMINANT sport (most sessions).
//   4. If the dominant sport doesn't match the plan's sport AND the
//      dominant sport's share is ≥ DRIFT_THRESHOLD_PCT of the total,
//      fire a `plan_drift` signal.
//
// Threshold choice: 60%. Below this the user is still loosely
// following the plan; above this they're clearly prioritizing a
// different sport. The threshold is exposed as a constant so the
// tests can pin it.
//
// "Hybrid" plans are a special case — they don't have a single
// target sport. We treat them as "any sport distribution is fine
// unless one sport exceeds 80%" (a higher bar than single-sport
// plans, since hybrid tolerates more variance by design).

// ─── Thresholds ─────────────────────────────────────────────────

/** Window over which we measure sport distribution. */
export const PLAN_DRIFT_WINDOW_WEEKS = 4;

/** Minimum dominant-sport share to fire drift for single-sport plans. */
export const PLAN_DRIFT_SINGLE_PCT = 0.60;

/** Minimum dominant-sport share for hybrid plans. Higher because
 *  hybrid tolerates more imbalance by design. */
export const PLAN_DRIFT_HYBRID_PCT = 0.80;

/** Minimum total sessions in the window before we bother checking
 *  drift. Below this, we don't have enough signal. */
export const PLAN_DRIFT_MIN_SESSIONS = 4;

// ─── Result type ────────────────────────────────────────────────

export interface PlanDriftResult {
  action:
    | 'published_drift'
    | 'skipped_existing'
    | 'skipped_no_plan'
    | 'skipped_not_enough_sessions'
    | 'skipped_in_band'
    | 'skipped_unknown_sport';
  planSport: string | null;
  dominantSport: SportKey | null;
  driftPct: number;
  sessionsInWindow: number;
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Normalize the raw `fitness_training_plans.sport` column to a
 * SportKey we can compare directly against the session-analytics
 * output. Hybrid plans return the sentinel string 'hybrid' since
 * no single SportKey represents them.
 */
function normalizePlanSport(raw: string | null | undefined): SportKey | 'hybrid' | null {
  if (!raw) return null;
  const s = raw.toLowerCase().trim();
  if (['strength', 'gym', 'lift', 'lifting'].includes(s)) return 'gym';
  if (['running', 'run'].includes(s)) return 'running';
  if (['cycling', 'cycle', 'bike'].includes(s)) return 'cycling';
  if (['swim', 'swimming'].includes(s)) return 'swim';
  if (['hybrid', 'multi', 'multisport', 'cross'].includes(s)) return 'hybrid';
  return null;
}

/**
 * Count sessions per sport over the last N weeks by aggregating the
 * weekly activity summaries. We rely on session-analytics' existing
 * sport normalization instead of re-querying the DB with new SQL.
 *
 * Per-week errors are swallowed and logged at `warn`: a single bad
 * week (transient DB lock, corrupt row in a historical week)
 * shouldn't take down the whole detector. Callers downstream see
 * partial counts, and the MIN_SESSIONS gate naturally handles the
 * degraded case by returning `skipped_not_enough_sessions` if too
 * much of the window was lost.
 */
function countSessionsBySportOverWindow(
  userId: number,
  tenantId: number,
  weeks: number,
): Record<SportKey, number> {
  const counts: Record<SportKey, number> = {
    gym: 0, running: 0, cycling: 0, swim: 0, other: 0,
  };
  const ref = now();
  for (let i = 0; i < weeks; i++) {
    try {
      const weekRef = ref.minus({ weeks: i });
      const summary = getWeeklyActivitySummary(userId, tenantId, weekRef);
      for (const sport of Object.keys(counts) as SportKey[]) {
        counts[sport] += summary.bySport[sport].completions;
      }
    } catch (err) {
      logger.warn(
        { err, userId, tenantId, weekOffset: i },
        'plan-drift weekly summary failed for one week — continuing with partial counts',
      );
    }
  }
  return counts;
}

/**
 * Find the active plan's declared sport. Returns null when there's
 * no active plan — the caller should skip drift detection entirely
 * in that case.
 *
 * DB errors are logged at `warn` (not `debug`) because a schema
 * failure here silently disables drift detection for every user.
 * If the `fitness_training_plans` table is missing or the `sport`
 * column is dropped in a future migration, this function starts
 * returning null for every caller — indistinguishable from "no
 * active plan" to the caller. Elevating to `warn` ensures schema
 * regressions show up in production log scrapes.
 */
function getActivePlanSport(userId: number, tenantId: number): string | null {
  const db = getDb();
  try {
    const row = db.prepare(`
      SELECT sport FROM fitness_training_plans
      WHERE user_id = ? AND tenant_id = ? AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(userId, tenantId) as { sport: string } | undefined;
    return row?.sport ?? null;
  } catch (err) {
    logger.warn({ err, userId, tenantId }, 'plan-drift active plan lookup failed — drift detection disabled for this user');
    return null;
  }
}

// ─── Core detector ──────────────────────────────────────────────

/**
 * Detect and (maybe) publish plan drift for a user. Idempotent:
 * a `plan_drift` row already active for this user is not
 * republished. Called from the same weekly-activity fetch path as
 * the adherence orchestrator so drift and adherence share the same
 * "once per tab open" rhythm.
 */
export function publishPlanDriftSignalForUser(userId: number, tenantId: number): PlanDriftResult {
  const scopedTenantId = requireTenantIdParam(tenantId, 'publishPlanDriftSignalForUser');
  const empty: PlanDriftResult = {
    action: 'skipped_no_plan',
    planSport: null,
    dominantSport: null,
    driftPct: 0,
    sessionsInWindow: 0,
  };

  const rawPlanSport = getActivePlanSport(userId, scopedTenantId);
  if (!rawPlanSport) {
    clearPlanDriftSignalsAtomically(userId, scopedTenantId);
    return empty;
  }

  const normalized = normalizePlanSport(rawPlanSport);
  if (!normalized) {
    clearPlanDriftSignalsAtomically(userId, scopedTenantId);
    return { ...empty, action: 'skipped_unknown_sport', planSport: rawPlanSport };
  }

  // Tally sessions by sport across the window
  const counts = countSessionsBySportOverWindow(userId, scopedTenantId, PLAN_DRIFT_WINDOW_WEEKS);
  const totalSessions = (Object.values(counts) as number[]).reduce((s, n) => s + n, 0);

  // "Active" sessions exclude the `other` bucket (recovery, mobility,
  // cross-training). Four stretching sessions don't tell us anything
  // about sport preference, so we shouldn't treat them as enough
  // signal to run drift detection.
  const activeSessions = totalSessions - counts.other;

  if (activeSessions < PLAN_DRIFT_MIN_SESSIONS) {
    clearPlanDriftSignalsAtomically(userId, scopedTenantId);
    return {
      action: 'skipped_not_enough_sessions',
      planSport: rawPlanSport,
      dominantSport: null,
      driftPct: 0,
      sessionsInWindow: totalSessions,
    };
  }

  // Identify the dominant sport, excluding 'other' from the winner
  // race — "other" is a catch-all for recovery/mobility and
  // shouldn't be read as the user's primary training focus.
  const sportEntries = (Object.entries(counts) as Array<[SportKey, number]>)
    .filter(([sport]) => sport !== 'other');
  sportEntries.sort((a, b) => b[1] - a[1]);

  // Defensive guard: if SportKey ever grows and every non-'other'
  // bucket is zero, `sportEntries[0]` destructure would crash. The
  // activeSessions gate above prevents this today, but the explicit
  // check is a one-liner insurance policy for future enum growth.
  const topEntry = sportEntries[0];
  if (!topEntry || topEntry[1] === 0) {
    clearPlanDriftSignalsAtomically(userId, scopedTenantId);
    return {
      action: 'skipped_not_enough_sessions',
      planSport: rawPlanSport,
      dominantSport: null,
      driftPct: 0,
      sessionsInWindow: totalSessions,
    };
  }
  const [dominantSport, dominantCount] = topEntry;
  const dominantPct = dominantCount / totalSessions;

  // Decide the drift threshold based on plan type
  const threshold = normalized === 'hybrid'
    ? PLAN_DRIFT_HYBRID_PCT
    : PLAN_DRIFT_SINGLE_PCT;

  // Is the dominant sport materially different from the plan?
  const isDriftingFromSinglePlan =
    normalized !== 'hybrid' && dominantSport !== normalized;
  const isDriftingFromHybrid =
    normalized === 'hybrid' && dominantPct >= PLAN_DRIFT_HYBRID_PCT;

  if (!isDriftingFromSinglePlan && !isDriftingFromHybrid) {
    clearPlanDriftSignalsAtomically(userId, scopedTenantId);
    return {
      action: 'skipped_in_band',
      planSport: rawPlanSport,
      dominantSport,
      driftPct: dominantPct * 100,
      sessionsInWindow: totalSessions,
    };
  }

  // Single-sport drift also needs the dominant share to cross the
  // threshold — a single extra run shouldn't trip a gym→run drift.
  if (isDriftingFromSinglePlan && dominantPct < threshold) {
    clearPlanDriftSignalsAtomically(userId, scopedTenantId);
    return {
      action: 'skipped_in_band',
      planSport: rawPlanSport,
      dominantSport,
      driftPct: dominantPct * 100,
      sessionsInWindow: totalSessions,
    };
  }

  const replacement = replacePlanDriftSignalAtomically({
    userId,
    tenantId: scopedTenantId,
    planSport: rawPlanSport,
    dominantSport,
    driftPct: dominantPct * 100,
    sessionsInWindow: totalSessions,
  });
  if (replacement === 'existing') {
    logger.debug(
      { userId, tenantId: scopedTenantId },
      'matching plan_drift snapshot already active — skipping duplicate publish',
    );
    return {
      action: 'skipped_existing',
      planSport: rawPlanSport,
      dominantSport,
      driftPct: dominantPct * 100,
      sessionsInWindow: totalSessions,
    };
  }

  logger.info(
    {
      userId,
      tenantId: scopedTenantId,
      planSport: rawPlanSport,
      dominantSport,
      driftPct: dominantPct * 100,
      sessionsInWindow: totalSessions,
    },
    'plan_drift signal published',
  );

  return {
    action: 'published_drift',
    planSport: rawPlanSport,
    dominantSport,
    driftPct: dominantPct * 100,
    sessionsInWindow: totalSessions,
  };
}
