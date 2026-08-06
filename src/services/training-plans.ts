// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Fitness Training Plans Service
 *
 * Manages AI-generated periodized training plans with calendar integration
 * and weekly auto-adjustment based on completion data and wearable metrics.
 */

import { DateTime } from 'luxon';
import { getDb } from './database';
import { logger } from '../utils/logger';
import { normalizeTrainingExercisesJsonForWrite } from './training-exercise-identity';
import { getTrainingExerciseIdentityV1Mode } from './runtime-flags';
import { requireTenantIdParam } from './tenant-scope';
import { assertLegacyWeekMutationAllowed } from './training-plan-revision-legacy-guard';
import type { TrainingCompletionState } from './training-completion-contract';
import { resolveTrainingPlanTimezone } from './training-date-utils';

// ── Types ──────────────────────────────────────────────────────────

export interface TrainingPlan {
  id: number;
  user_id: number;
  tenant_id?: number | null;
  name: string;
  sport: string;
  goal: string | null;
  duration_weeks: number;
  periodization: string;
  // F6 compatibility replacement uses `pending_activation` only inside its
  // transaction and retains prior graphs as `superseded` for audit/recovery.
  // The column has no CHECK constraint (migration 023:13), so both lifecycle
  // values are additive without schema churn.
  status: 'active' | 'completed' | 'paused' | 'cancelled' | 'pending_activation' | 'superseded';
  start_date: string;
  end_date: string;
  preferences_json: string | null;
  plan_version?: number | null;
  created_at: string;
  updated_at: string;
}

export interface TrainingWeek {
  id: number;
  plan_id: number;
  week_number: number;
  focus: string | null;
  intensity_pct: number;
  volume_sessions: number | null;
  notes: string | null;
  auto_adjusted: number;
  adjustment_reason: string | null;
  created_at: string;
}

export type TrainingSessionStatus =
  | 'pending'
  | 'scheduled'
  | 'reflowed'
  | 'compressed'
  | 'capped'
  | 'completed'
  | 'partial'
  | 'skipped'
  | 'moved'
  | 'unscheduled'
  | 'deferred'
  | 'dropped'
  | 'cancelled'
  | 'superseded';

const INACTIVE_TRAINING_SESSION_STATUSES = new Set<string>([
  'rest',
  'unscheduled',
  'deferred',
  'dropped',
  'cancelled',
  'superseded',
]);

const NON_LOAD_TRAINING_SESSION_STATUSES = new Set<string>([
  ...INACTIVE_TRAINING_SESSION_STATUSES,
  'skipped',
]);

function normalizedSessionStatus(status: unknown): string {
  return String(status || '').trim().toLowerCase();
}

function isAdherenceBearingSession(status: unknown): boolean {
  return !INACTIVE_TRAINING_SESSION_STATUSES.has(normalizedSessionStatus(status));
}

function isLoadBearingSession(status: unknown): boolean {
  return !NON_LOAD_TRAINING_SESSION_STATUSES.has(normalizedSessionStatus(status));
}

export interface TrainingSession {
  id: number;
  week_id: number;
  plan_id: number;
  tenant_id?: number | null;
  day_of_week: string;
  session_type: string;
  title: string;
  description: string | null;
  /**
   * Structured description sections, JSON-encoded. Stored alongside
   * `description` so iOS can render typed sections (cards, monospace
   * progression, ⚠️ callouts) while the calendar event description /
   * email body uses the plain-text rendering. Older rows have NULL
   * here — read paths must fall back to `description`.
   */
  description_json: string | null;
  exercises_json: string | null;
  duration_minutes: number | null;
  intensity_text: string | null;
  calendar_event_id: string | null;
  calendar_source: string | null;
  /**
   * Stable logical identity for this session slot within a plan. It does
   * not include plan_version, so regeneration can compare the same
   * logical slot across versions. Added by migration 082.
   */
  session_identity_key: string | null;
  /**
   * Material coaching-shape hash for this session. Cosmetic copy changes
   * should not alter it; exercise/block/duration/role changes should.
   */
  session_shape_hash: string | null;
  /**
   * Slice 1.B (coach-engine refactor, 2026-04-27) — set to 1 by the
   * planner when it could not land the session at the user's preferred
   * time. iOS uses this to render a ⚠️ chip so the user knows the time
   * was a fallback (e.g., 06:30 because the day was fully booked) rather
   * than a deliberate planner choice. Migration 080 backfills 0.
   */
  preferred_time_unavailable: number;
  status: TrainingSessionStatus;
  /**
   * Phase 1B — finalized schedule window persisted at creation time
   * (migration 255 columns). The background calendar-sync worker rebuilds
   * provider event times from these; rows persisted before Phase 1B have
   * NULL here and are not calendar-syncable through the outbox path.
   */
  scheduled_start_at?: string | null;
  scheduled_end_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface TrainingCompletion {
  id: number;
  session_id: number;
  plan_id: number;
  completed_at: string;
  actual_exercises_json: string | null;
  rpe_overall: number | null;
  duration_minutes: number | null;
  energy_level: number | null;
  soreness_level: number | null;
  notes: string | null;
  completed_duration_sec: number | null;
  completed_distance_meters: number | null;
  completed_sets_json: string | null;
  completed_reps_json: string | null;
  completed_load_json: string | null;
  rir: number | null;
  pain_score: number | null;
  pain_location: string | null;
  technical_success_score: number | null;
  missed_reason: string | null;
  external_training_declared: number;
  completion_state: TrainingCompletionState;
  readiness_level: number | null;
  difficulty_feedback: string | null;
  duration_feedback: string | null;
  discomfort_flag: number;
  discomfort_flags_json: string;
  discomfort_locations_json: string;
  discomfort_details: string | null;
  substitutions_used_json: string;
  felt_too_hard: number;
  felt_too_easy: number;
  felt_too_long: number;
  felt_too_short: number;
  modality: string | null;
  session_role: string | null;
  created_at: string;
}

export interface CreatePlanInput {
  user_id: number;
  tenant_id: number;
  name: string;
  sport: string;
  goal?: string;
  duration_weeks: number;
  periodization?: string;
  start_date: string;
  end_date: string;
  preferences_json?: string;
  /**
   * Defaults to `'active'` so every existing caller is unchanged. Generation
   * passes `'pending_activation'` so the replacement is durable before the
   * plan it replaces is removed (F6, Phase 1A-2).
   */
  status?: TrainingPlan['status'];
}

export interface CreateWeekInput {
  plan_id: number;
  week_number: number;
  focus?: string;
  intensity_pct?: number;
  volume_sessions?: number;
  notes?: string;
}

export interface CreateSessionInput {
  week_id: number;
  plan_id: number;
  day_of_week: string;
  session_type: string;
  title: string;
  description?: string;
  /** Optional structured-sections JSON. Persisted as TEXT. */
  description_json?: string;
  exercises_json?: string;
  duration_minutes?: number;
  intensity_text?: string;
  calendar_event_id?: string;
  calendar_source?: string;
  session_identity_key?: string;
  session_shape_hash?: string;
  status?: TrainingSessionStatus;
  /**
   * Slice 1.B — set to true when the planner had to fall back from the
   * user's preferred time because the day was already booked. Persisted
   * as `preferred_time_unavailable INTEGER` (1/0). See migration 080.
   */
  preferred_time_unavailable?: boolean;
  /**
   * Phase 1B (calendar-sync outbox) — the finalized schedule window,
   * persisted so the background calendar-sync worker can rebuild provider
   * event times from the row. Columns exist since migration 255 but had no
   * writer on this path; the in-memory `calendarEvents` array used to be the
   * only holder of these times, which is incompatible with post-commit
   * provider work.
   */
  scheduled_start_at?: string | null;
  scheduled_end_at?: string | null;
}

export interface LogCompletionInput {
  session_id: number;
  plan_id: number;
  actual_exercises_json?: string;
  rpe_overall?: number;
  duration_minutes?: number;
  energy_level?: number;
  soreness_level?: number;
  notes?: string;
  // ── Slice A0c — CompletionFeedbackV2 fields. All optional;
  //    older callers continue to work unchanged.
  /** Finer-resolution duration (seconds). Engine falls back to duration_minutes × 60 when missing. */
  completed_duration_sec?: number;
  /** Distance covered in meters (running / cycling / swim). */
  completed_distance_meters?: number;
  /** JSON array of completed set counts per prescribed exercise. */
  completed_sets_json?: string;
  /** JSON array of completed reps per prescribed exercise. */
  completed_reps_json?: string;
  /** JSON array of completed loads (kg) per prescribed exercise. */
  completed_load_json?: string;
  /** Reps in reserve (Zourdos RIR scale, 0-5). */
  rir?: number;
  /** Pain score (0-10). Distinct from soreness — pain implies injury risk. */
  pain_score?: number;
  /** Free-text pain location (e.g., "left knee, medial"). Health-sensitive (A4p). */
  pain_location?: string;
  /** Technical success score (0-10) — "did I execute the movement well?". */
  technical_success_score?: number;
  /** Free-form short reason when status=skipped (illness, travel, etc.). */
  missed_reason?: string;
  /** Set true when athlete did an external (unlogged) training session. */
  external_training_declared?: boolean;
  /** Canonical state; absent preserves the released legacy-completed behavior. */
  completion_state?: TrainingCompletionState;
  readiness_level?: number;
  difficulty_feedback?: string;
  duration_feedback?: string;
  discomfort_flag?: boolean;
  discomfort_flags_json?: string;
  discomfort_locations_json?: string;
  discomfort_details?: string;
  substitutions_used_json?: string;
  felt_too_hard?: boolean;
  felt_too_easy?: boolean;
  felt_too_long?: boolean;
  felt_too_short?: boolean;
  modality?: string;
  session_role?: string;
}

const TRAINING_SESSION_UPDATE_COLUMNS = new Set([
  'day_of_week',
  'title',
  'exercises_json',
  'duration_minutes',
  'intensity_text',
  'description',
  'status',
  'calendar_event_id',
  'calendar_source',
  'session_identity_key',
  'session_shape_hash',
  'preferred_time_unavailable',
]);

const DAY_NAME_MAP: Record<string, string> = {
  monday: 'Monday',
  tuesday: 'Tuesday',
  wednesday: 'Wednesday',
  thursday: 'Thursday',
  friday: 'Friday',
  saturday: 'Saturday',
  sunday: 'Sunday',
};

function canonicalDayOfWeek(value: string): string {
  const normalized = value.trim().toLowerCase();
  return DAY_NAME_MAP[normalized] ?? value.trim();
}

// ── Plan CRUD ──────────────────────────────────────────────────────

export function createPlan(input: CreatePlanInput): TrainingPlan {
  const db = getDb();
  const tenantId = requireTenantIdParam(input.tenant_id, 'createPlan');
  const result = db.prepare(`
    INSERT INTO fitness_training_plans
      (user_id, tenant_id, name, sport, goal, duration_weeks, periodization, start_date, end_date, preferences_json, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.user_id, tenantId, input.name, input.sport, input.goal ?? null,
    input.duration_weeks, input.periodization ?? 'linear',
    input.start_date, input.end_date, input.preferences_json ?? null,
    input.status ?? 'active',
  );
  logger.info(
    { planId: result.lastInsertRowid, name: input.name, status: input.status ?? 'active' },
    'Training plan created',
  );
  return getDb().prepare('SELECT * FROM fitness_training_plans WHERE id = ?')
    .get(result.lastInsertRowid) as TrainingPlan;
}

/**
 * Promote a `pending_activation` replacement to the user's active plan
 * (F6, Phase 1A-2).
 *
 * Tenant-scoped and status-qualified: the UPDATE only matches a row that is
 * still `pending_activation` and owned by this scope, so a concurrent
 * activation or a foreign-scope id changes nothing and returns false. Callers
 * treat `false` as "do not proceed" and clean up the pending row.
 */
export function activatePendingPlan(planId: number, userId: number, tenantId: number): boolean {
  const db = getDb();
  const scopedTenantId = requireTenantIdParam(tenantId, 'activatePendingPlan');
  const result = db.prepare(`
    UPDATE fitness_training_plans
       SET status = 'active', updated_at = datetime('now')
     WHERE id = ? AND user_id = ? AND tenant_id = ? AND status = 'pending_activation'
  `).run(planId, userId, scopedTenantId);
  return result.changes === 1;
}

export class TrainingPlanReplacementConflictError extends Error {
  readonly code = 'TRAINING_PLAN_REPLACEMENT_CONFLICT';

  constructor() {
    super('The active Training plan changed while this replacement was being built');
    this.name = 'TrainingPlanReplacementConflictError';
  }
}

/**
 * F6 atomic compatibility pointer transition. The caller already owns the
 * surrounding graph/outbox transaction; this helper performs only scoped,
 * synchronous status CAS writes on that same database handle.
 */
export function activateCompatibilityPlanReplacement(input: {
  planId: number;
  userId: number;
  tenantId: number;
  expectedActivePlanIds: number[];
}): { supersededPlanIds: number[] } {
  const db = getDb();
  const tenantId = requireTenantIdParam(input.tenantId, 'activateCompatibilityPlanReplacement');
  const currentActivePlanIds = (db.prepare(`
    SELECT id FROM fitness_training_plans
     WHERE user_id = ? AND tenant_id = ? AND status = 'active'
     ORDER BY id
  `).all(input.userId, tenantId) as Array<{ id: number }>).map((row) => row.id);
  const expectedActivePlanIds = [...input.expectedActivePlanIds].sort((a, b) => a - b);
  if (
    currentActivePlanIds.length !== expectedActivePlanIds.length
    || currentActivePlanIds.some((id, index) => id !== expectedActivePlanIds[index])
  ) {
    throw new TrainingPlanReplacementConflictError();
  }

  if (currentActivePlanIds.length > 0) {
    const placeholders = currentActivePlanIds.map(() => '?').join(', ');
    const superseded = db.prepare(`
      UPDATE fitness_training_plans
         SET status = 'superseded', updated_at = datetime('now')
       WHERE user_id = ? AND tenant_id = ? AND status = 'active'
         AND id IN (${placeholders})
    `).run(input.userId, tenantId, ...currentActivePlanIds);
    if (superseded.changes !== currentActivePlanIds.length) {
      throw new TrainingPlanReplacementConflictError();
    }
  }

  const activated = db.prepare(`
    UPDATE fitness_training_plans
       SET status = 'active', updated_at = datetime('now')
     WHERE id = ? AND user_id = ? AND tenant_id = ?
       AND status = 'pending_activation'
  `).run(input.planId, input.userId, tenantId);
  if (activated.changes !== 1) throw new TrainingPlanReplacementConflictError();
  return { supersededPlanIds: currentActivePlanIds };
}

/**
 * 2026-05-18 (skill-hardening QA P0-3): both `getActivePlan` and
 * `getActivePlans` were querying `WHERE user_id = ? AND status = 'active'`
 * without filtering by tenant_id, despite migration 140 adding the column.
 * That made the tenant-id work on these tables cosmetic — cross-tenant
 * reads were silently allowed when the caller forgot to scope.
 *
 * The follow-up hardening pass removed the optional-tenant fallback.
 * Callers must now pass a validated tenantId for every production read.
 */
export function getActivePlan(userId: number, tenantId: number): TrainingPlan | null {
  const db = getDb();
  const scopedTenantId = requireTenantIdParam(tenantId, 'getActivePlan');
  return (db.prepare(`
    SELECT * FROM fitness_training_plans
    WHERE user_id = ? AND tenant_id = ? AND status = 'active'
    ORDER BY created_at DESC LIMIT 1
  `).get(userId, scopedTenantId) as TrainingPlan | undefined) ?? null;
}

/**
 * Get ALL active plans for a user — supports multi-sport planning.
 * Each plan targets a different sport (gym, running, cycling, swim).
 * Used by the cross-plan interference check and the plan renewal logic.
 *
 * See `getActivePlan` for the tenant_id scoping rationale.
 */
export function getActivePlans(userId: number, tenantId: number): TrainingPlan[] {
  const db = getDb();
  const scopedTenantId = requireTenantIdParam(tenantId, 'getActivePlans');
  return db.prepare(`
    SELECT * FROM fitness_training_plans
    WHERE user_id = ? AND tenant_id = ? AND status = 'active'
    ORDER BY sport, created_at DESC
  `).all(userId, scopedTenantId) as TrainingPlan[];
}

/**
 * Get the total weekly training load across ALL active plans.
 * Used for overtraining prevention when creating a new plan.
 */
export function getCrossplanWeeklyLoad(userId: number, tenantId: number): {
  totalSessions: number;
  bySport: Record<string, number>;
  totalMinutes: number;
} {
  const plans = getActivePlans(userId, tenantId);
  const result = { totalSessions: 0, bySport: {} as Record<string, number>, totalMinutes: 0 };

  for (const plan of plans) {
    const week = getCurrentWeek(plan.id);
    if (!week) continue;
    const sessions = getSessionsForWeek(week.id);
    const sportSessions = sessions.filter(s => isLoadBearingSession(s.status));
    result.totalSessions += sportSessions.length;
    result.bySport[plan.sport] = (result.bySport[plan.sport] || 0) + sportSessions.length;
    result.totalMinutes += sportSessions.reduce((sum, s) => sum + (s.duration_minutes || 0), 0);
  }

  return result;
}

export function getPlanById(planId: number): TrainingPlan | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM fitness_training_plans WHERE id = ?')
    .get(planId) as TrainingPlan | undefined) ?? null;
}

export function getUserPlans(userId: number): TrainingPlan[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM fitness_training_plans
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(userId) as TrainingPlan[];
}

export function updatePlanStatus(planId: number, status: TrainingPlan['status']): boolean {
  const db = getDb();
  const result = db.prepare(`
    UPDATE fitness_training_plans SET status = ?, updated_at = datetime('now') WHERE id = ?
  `).run(status, planId);
  return result.changes > 0;
}

export function updatePlanPreferences(planId: number, preferencesJson: string): boolean {
  const db = getDb();
  const result = db.prepare(`
    UPDATE fitness_training_plans
    SET preferences_json = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(preferencesJson, planId);
  return result.changes > 0;
}

/**
 * Hard-delete a training plan and every artifact derived from it.
 *
 * Used by `POST /api/v1/training/plan/cancel` to satisfy the user
 * contract "nothing left behind." Schema FKs declared in
 * `migrations/023_fitness_training_plans.sql` cascade as
 * `ON DELETE CASCADE`, so a single DELETE on the plan row removes:
 *
 *   - every `training_weeks` row with that `plan_id`
 *   - every `training_sessions` row (via `plan_id` AND via `week_id`)
 *   - every `training_completions` row (via `plan_id` AND via `session_id`)
 *
 * Pre-conditions enforced by callers:
 *   - the plan's calendar events have already been removed via
 *     `unifiedCalendar.deleteEvent` so external Google/Outlook
 *     state matches the local hard delete
 *   - the caller has verified `plan.user_id === ctx.userId`
 *
 * Returns row counts so the route can report what was actually
 * removed in the response payload (audit + UI feedback).
 */
export function deletePlanHard(planId: number, userId: number, tenantId: number): {
  ok: boolean;
  removedPlans: number;
  removedWeeks: number;
  removedSessions: number;
  removedCompletions: number;
} {
  const db = getDb();
  const scopedTenantId = requireTenantIdParam(tenantId, 'deletePlanHard');

  const weeksCount = (db.prepare('SELECT COUNT(*) AS n FROM training_weeks WHERE plan_id = ?')
    .get(planId) as { n: number } | undefined)?.n ?? 0;
  const sessionsCount = (db.prepare('SELECT COUNT(*) AS n FROM training_sessions WHERE plan_id = ?')
    .get(planId) as { n: number } | undefined)?.n ?? 0;
  const completionsCount = (db.prepare('SELECT COUNT(*) AS n FROM training_completions WHERE plan_id = ?')
    .get(planId) as { n: number } | undefined)?.n ?? 0;

  // Scope the DELETE to (id, user_id, tenant_id) so a stale planId from
  // another tenant cannot remove someone else's plan even if the caller's
  // ownership gate is bypassed in the future.
  const result = db.prepare(`
    DELETE FROM fitness_training_plans WHERE id = ? AND user_id = ? AND tenant_id = ?
  `).run(planId, userId, scopedTenantId);

  const removedPlans = result.changes;
  return {
    ok: removedPlans > 0,
    removedPlans,
    removedWeeks: removedPlans > 0 ? weeksCount : 0,
    removedSessions: removedPlans > 0 ? sessionsCount : 0,
    removedCompletions: removedPlans > 0 ? completionsCount : 0,
  };
}

// ── Week CRUD ──────────────────────────────────────────────────────

export function createWeek(input: CreateWeekInput): TrainingWeek {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO training_weeks (plan_id, week_number, focus, intensity_pct, volume_sessions, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    input.plan_id, input.week_number, input.focus ?? null,
    input.intensity_pct ?? 100, input.volume_sessions ?? null, input.notes ?? null,
  );
  return db.prepare('SELECT * FROM training_weeks WHERE id = ?')
    .get(result.lastInsertRowid) as TrainingWeek;
}

export function getWeeksForPlan(planId: number): TrainingWeek[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM training_weeks WHERE plan_id = ? ORDER BY week_number ASC
  `).all(planId) as TrainingWeek[];
}

export function resolveTrainingPlanWeekNumber(
  plan: Pick<TrainingPlan, 'start_date' | 'duration_weeks'>
    & Partial<Pick<TrainingPlan, 'preferences_json'>>,
  options: { now?: Date; timezone?: string | null } = {},
): number {
  const timezone = resolveTrainingPlanTimezone(plan, options.timezone);
  const start = DateTime.fromISO(plan.start_date, { zone: timezone }).startOf('day');
  const now = DateTime.fromJSDate(options.now ?? new Date(), { zone: timezone }).startOf('day');
  if (!start.isValid || !now.isValid) return 1;
  const diffDays = Math.floor(now.diff(start, 'days').days);
  const rawWeekNumber = Math.floor(diffDays / 7) + 1;
  return Math.min(
    Math.max(1, rawWeekNumber),
    Math.max(1, plan.duration_weeks || 1),
  );
}

export function getCurrentWeek(planId: number, options: { now?: Date; timezone?: string | null } = {}): TrainingWeek | null {
  const db = getDb();
  const plan = getPlanById(planId);
  if (!plan) return null;

  const weekNumber = resolveTrainingPlanWeekNumber(plan, options);

  return (db.prepare(`
    SELECT * FROM training_weeks WHERE plan_id = ? AND week_number = ?
  `).get(planId, weekNumber) as TrainingWeek | undefined) ?? null;
}

export function updateWeekAdjustment(weekId: number, intensityPct: number, reason: string): boolean {
  const db = getDb();
  const scope = db.prepare(`
    SELECT plans.user_id AS userId,
           COALESCE(plans.tenant_id, plans.user_id) AS tenantId
      FROM training_weeks weeks
      JOIN fitness_training_plans plans ON plans.id = weeks.plan_id
     WHERE weeks.id = ?
     LIMIT 1
  `).get(weekId) as { userId: number; tenantId: number } | undefined;
  if (!scope) return false;
  assertLegacyWeekMutationAllowed(
    { userId: scope.userId, tenantId: scope.tenantId },
    weekId,
  );
  const result = db.prepare(`
    UPDATE training_weeks
    SET intensity_pct = ?, auto_adjusted = 1, adjustment_reason = ?
    WHERE id = ?
  `).run(intensityPct, reason, weekId);
  return result.changes > 0;
}

// ── Session CRUD ───────────────────────────────────────────────────

export function createSession(input: CreateSessionInput): TrainingSession {
  const db = getDb();
  const normalizedDay = canonicalDayOfWeek(input.day_of_week);
  const planScope = db.prepare('SELECT tenant_id AS tenantId, user_id AS userId FROM fitness_training_plans WHERE id = ?')
    .get(input.plan_id) as { tenantId?: number | null; userId?: number | null } | undefined;
  const tenantId = planScope?.tenantId ?? null;
  if (!Number.isFinite(tenantId) || Number(tenantId) <= 0) {
    throw new Error(`TRAINING_PLAN_TENANT_SCOPE_MISSING: ${input.plan_id}`);
  }
  const userId = Number.isSafeInteger(planScope?.userId) && Number(planScope?.userId) > 0
    ? Number(planScope?.userId)
    : null;
  const exerciseIdentityMode = getTrainingExerciseIdentityV1Mode(process.env, {
    tenantId: Number(tenantId),
    userId,
  });
  if (exerciseIdentityMode === 'active' && userId == null) {
    throw new Error(`TRAINING_PLAN_USER_SCOPE_MISSING: ${input.plan_id}`);
  }
  const exercisesJson = normalizeTrainingExercisesJsonForWrite(input.exercises_json, {
    scope: { tenantId: Number(tenantId), userId },
    source: 'training-plans.createSession',
  });
  const result = db.prepare(`
    INSERT INTO training_sessions
      (week_id, plan_id, tenant_id, day_of_week, session_type, title, description,
       description_json, exercises_json, duration_minutes, intensity_text,
       calendar_event_id, calendar_source, session_identity_key, session_shape_hash,
       preferred_time_unavailable, status, scheduled_start_at, scheduled_end_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.week_id, input.plan_id, tenantId, normalizedDay, input.session_type,
    input.title, input.description ?? null, input.description_json ?? null,
    exercisesJson ?? null,
    input.duration_minutes ?? null, input.intensity_text ?? null,
    input.calendar_event_id ?? null, input.calendar_source ?? null,
    input.session_identity_key ?? null, input.session_shape_hash ?? null,
    input.preferred_time_unavailable ? 1 : 0,
    input.status ?? 'pending',
    input.scheduled_start_at ?? null, input.scheduled_end_at ?? null,
  );
  return db.prepare('SELECT * FROM training_sessions WHERE id = ?')
    .get(result.lastInsertRowid) as TrainingSession;
}

export function getSessionsForWeek(weekId: number): TrainingSession[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM training_sessions WHERE week_id = ? ORDER BY
      CASE day_of_week
        WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2 WHEN 'Wednesday' THEN 3
        WHEN 'Thursday' THEN 4 WHEN 'Friday' THEN 5 WHEN 'Saturday' THEN 6
        WHEN 'Sunday' THEN 7
      END
  `).all(weekId) as TrainingSession[];
}

export function getSessionById(sessionId: number): TrainingSession | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM training_sessions WHERE id = ?')
    .get(sessionId) as TrainingSession | undefined) ?? null;
}

export interface TrainingSessionLookupScope {
  userId: number;
  tenantId: number;
}

/**
 * Resolve a session only through its owning plan's authenticated scope.
 *
 * Calendar/agenda pointers are durable external identifiers and can become
 * corrupt or misrouted. Callers that hydrate user-visible content from one of
 * those pointers must use this loader instead of the legacy global-by-id read.
 * The session/plan tenant equality in the JOIN also rejects internally
 * inconsistent rows. Missing ownership tables, malformed scope, and query
 * failures all return null so callers cannot fall back to unscoped data.
 */
export function getSessionByIdForScope(
  sessionId: number,
  scope: TrainingSessionLookupScope,
): TrainingSession | null {
  try {
    if (!Number.isSafeInteger(sessionId) || sessionId <= 0) return null;
    const scopedUserId = requireTenantIdParam(scope.userId, 'getSessionByIdForScope.userId');
    const scopedTenantId = requireTenantIdParam(scope.tenantId, 'getSessionByIdForScope.tenantId');
    const db = getDb();
    return (db.prepare(`
      SELECT sessions.*
        FROM training_sessions sessions
        JOIN fitness_training_plans plans
          ON plans.id = sessions.plan_id
         AND plans.tenant_id = sessions.tenant_id
       WHERE sessions.id = ?
         AND plans.user_id = ?
         AND plans.tenant_id = ?
         AND sessions.tenant_id = ?
       LIMIT 1
    `).get(
      sessionId,
      scopedUserId,
      scopedTenantId,
      scopedTenantId,
    ) as TrainingSession | undefined) ?? null;
  } catch (err) {
    logger.warn(
      {
        err,
        sessionId,
        userId: scope?.userId ?? null,
        tenantId: scope?.tenantId ?? null,
      },
      'Scoped Training session lookup failed — refusing unscoped hydration',
    );
    return null;
  }
}

export function updateSession(
  sessionId: number,
  updates: Partial<Pick<TrainingSession, 'day_of_week' | 'title' | 'exercises_json' | 'duration_minutes' | 'intensity_text' | 'description' | 'status' | 'session_identity_key' | 'session_shape_hash' | 'preferred_time_unavailable'>> & {
    calendar_event_id?: string | null;
    calendar_source?: string | null;
  },
): boolean {
  const db = getDb();
  const setClauses: string[] = [];
  const values: any[] = [];

  const normalizedUpdates = { ...updates };
  if (typeof updates.exercises_json === 'string') {
    const scope = db.prepare(`
      SELECT plans.user_id AS userId, sessions.tenant_id AS tenantId
        FROM training_sessions sessions
        JOIN fitness_training_plans plans ON plans.id = sessions.plan_id
       WHERE sessions.id = ?
    `).get(sessionId) as { userId?: number | null; tenantId?: number | null } | undefined;
    const tenantId = Number.isSafeInteger(scope?.tenantId) && Number(scope?.tenantId) > 0
      ? Number(scope?.tenantId)
      : null;
    const userId = Number.isSafeInteger(scope?.userId) && Number(scope?.userId) > 0
      ? Number(scope?.userId)
      : null;
    const exerciseIdentityMode = getTrainingExerciseIdentityV1Mode(process.env, { tenantId, userId });
    if (exerciseIdentityMode === 'active' && (userId == null || tenantId == null)) {
      throw new Error(`TRAINING_SESSION_SCOPE_MISSING: ${sessionId}`);
    }
    normalizedUpdates.exercises_json = normalizeTrainingExercisesJsonForWrite(updates.exercises_json, {
      scope: { tenantId, userId },
      source: 'training-plans.updateSession',
    });
  }

  for (const [key, value] of Object.entries(normalizedUpdates)) {
    if (value !== undefined) {
      if (!TRAINING_SESSION_UPDATE_COLUMNS.has(key)) {
        throw new Error(`TRAINING_SESSION_UPDATE_INVALID_FIELD: ${key}`);
      }
      setClauses.push(`${key} = ?`);
      values.push(value);
    }
  }
  if (setClauses.length === 0) return false;

  setClauses.push("updated_at = datetime('now')");
  values.push(sessionId);

  const result = db.prepare(`
    UPDATE training_sessions SET ${setClauses.join(', ')} WHERE id = ?
  `).run(...values);
  return result.changes > 0;
}

export function markSessionCompleted(sessionId: number): boolean {
  return updateSession(sessionId, { status: 'completed' });
}

export function markSessionSkipped(sessionId: number): boolean {
  return updateSession(sessionId, { status: 'skipped' });
}

export function linkSessionToCalendar(sessionId: number, eventId: string, source: string): boolean {
  return updateSession(sessionId, { calendar_event_id: eventId, calendar_source: source });
}

export interface TrainingSessionCalendarLookupScope {
  userId: number;
  tenantId: number;
}

export function getSessionByCalendarEvent(
  eventId: string,
  source: string | null | undefined,
  scope: TrainingSessionCalendarLookupScope,
): TrainingSession | null {
  const db = getDb();
  const scopedUserId = requireTenantIdParam(scope.userId, 'getSessionByCalendarEvent.userId');
  const scopedTenantId = requireTenantIdParam(scope.tenantId, 'getSessionByCalendarEvent');
  const clauses = ['ts.calendar_event_id = ?'];
  const values: any[] = [eventId];

  if (source) {
    clauses.push('ts.calendar_source = ?');
    values.push(source);
  }
  clauses.push('ftp.user_id = ? AND ftp.tenant_id = ?');
  values.push(scopedUserId, scopedTenantId);

  const row = db.prepare(`
    SELECT ts.* FROM training_sessions ts
    JOIN fitness_training_plans ftp ON ftp.id = ts.plan_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY ts.updated_at DESC, ts.id DESC
    LIMIT 1
  `).get(...values);

  return (row as TrainingSession | undefined) ?? null;
}

export function syncSessionWithCoachRecommendation(rec: {
  eventId: string;
  source?: string | null;
  userId: number;
  tenantId: number;
  timezone?: string | null;
  action: 'KEEP' | 'MODIFY' | 'SWAP' | 'REST';
  newTitle?: string | null;
  newStart?: string | null;
}): boolean {
  const session = getSessionByCalendarEvent(rec.eventId, rec.source, {
    userId: rec.userId,
    tenantId: rec.tenantId,
  });
  if (!session) return false;

  const updates: Partial<Pick<TrainingSession, 'day_of_week' | 'title' | 'status'>> = {};

  if (rec.newTitle && rec.newTitle.trim() && rec.newTitle !== session.title) {
    updates.title = rec.newTitle.trim();
  }

  if (rec.newStart) {
    const movedAt = new Date(rec.newStart);
    if (!Number.isNaN(movedAt.getTime())) {
      const plan = getPlanById(session.plan_id);
      const timeZone = resolveTrainingPlanTimezone(plan, rec.timezone);
      updates.day_of_week = movedAt.toLocaleDateString('en-US', {
        weekday: 'long',
        timeZone,
      });
    }
  }

  if (rec.action === 'REST') {
    updates.status = 'skipped';
  }

  return updateSession(session.id, updates);
}

// ── Completion Logging ─────────────────────────────────────────────

const COMPLETION_RETRY_FIELDS = [
  'actual_exercises_json',
  'rpe_overall',
  'duration_minutes',
  'energy_level',
  'soreness_level',
  'notes',
  'completed_duration_sec',
  'completed_distance_meters',
  'completed_sets_json',
  'completed_reps_json',
  'completed_load_json',
  'rir',
  'pain_score',
  'pain_location',
  'technical_success_score',
  'missed_reason',
  'external_training_declared',
  'completion_state',
  'readiness_level',
  'difficulty_feedback',
  'duration_feedback',
  'discomfort_flag',
  'discomfort_flags_json',
  'discomfort_locations_json',
  'discomfort_details',
  'substitutions_used_json',
  'felt_too_hard',
  'felt_too_easy',
  'felt_too_long',
  'felt_too_short',
  'modality',
  'session_role',
] as const satisfies ReadonlyArray<keyof TrainingCompletion>;

function normalizedCompletionWrite(
  input: LogCompletionInput,
  completionState: TrainingCompletionState,
): Pick<TrainingCompletion, (typeof COMPLETION_RETRY_FIELDS)[number]> {
  return {
    actual_exercises_json: input.actual_exercises_json ?? null,
    rpe_overall: input.rpe_overall ?? null,
    duration_minutes: input.duration_minutes ?? null,
    energy_level: input.energy_level ?? null,
    soreness_level: input.soreness_level ?? null,
    notes: input.notes ?? null,
    completed_duration_sec: input.completed_duration_sec ?? null,
    completed_distance_meters: input.completed_distance_meters ?? null,
    completed_sets_json: input.completed_sets_json ?? null,
    completed_reps_json: input.completed_reps_json ?? null,
    completed_load_json: input.completed_load_json ?? null,
    rir: input.rir ?? null,
    pain_score: input.pain_score ?? null,
    pain_location: input.pain_location ?? null,
    technical_success_score: input.technical_success_score ?? null,
    missed_reason: input.missed_reason ?? null,
    external_training_declared: input.external_training_declared === true ? 1 : 0,
    completion_state: completionState,
    readiness_level: input.readiness_level ?? null,
    difficulty_feedback: input.difficulty_feedback ?? null,
    duration_feedback: input.duration_feedback ?? null,
    discomfort_flag: input.discomfort_flag === true ? 1 : 0,
    discomfort_flags_json: input.discomfort_flags_json ?? '[]',
    discomfort_locations_json: input.discomfort_locations_json ?? '[]',
    discomfort_details: input.discomfort_details ?? null,
    substitutions_used_json: input.substitutions_used_json ?? '[]',
    felt_too_hard: input.felt_too_hard === true ? 1 : 0,
    felt_too_easy: input.felt_too_easy === true ? 1 : 0,
    felt_too_long: input.felt_too_long === true ? 1 : 0,
    felt_too_short: input.felt_too_short === true ? 1 : 0,
    modality: input.modality ?? null,
    session_role: input.session_role ?? null,
  };
}

function isExactCompletionRetry(
  row: TrainingCompletion,
  expected: Pick<TrainingCompletion, (typeof COMPLETION_RETRY_FIELDS)[number]>,
): boolean {
  return COMPLETION_RETRY_FIELDS.every((field) => row[field] === expected[field]);
}

export function logCompletion(input: LogCompletionInput): TrainingCompletion {
  const db = getDb();
  const completionState = input.completion_state ?? 'completed';
  const normalized = normalizedCompletionWrite(input, completionState);
  // The completion row and session state are one business write. This remains
  // safe inside the route's surrounding outbox transaction because
  // better-sqlite3 nests transactions with savepoints.
  const completion = db.transaction(() => {
    const session = db.prepare(`
      SELECT plan_id FROM training_sessions WHERE id = ?
    `).get(input.session_id) as { plan_id: number } | undefined;
    if (!session || session.plan_id !== input.plan_id) {
      throw new Error(
        `TRAINING_COMPLETION_SESSION_PLAN_MISMATCH:${input.session_id}:${input.plan_id}`,
      );
    }

    // A mobile retry after a lost response must not create a second action.
    // Collapse only an exact payload replay; a materially different payload
    // remains a later disposition and is resolved by latest-state readers.
    const latestCompletion = db.prepare(`
      SELECT * FROM training_completions
       WHERE session_id = ? AND plan_id = ?
       ORDER BY datetime(completed_at) DESC, id DESC
       LIMIT 1
    `).get(input.session_id, input.plan_id) as TrainingCompletion | undefined;
    if (latestCompletion && isExactCompletionRetry(latestCompletion, normalized)) {
      return latestCompletion;
    }

    const result = db.prepare(`
      INSERT INTO training_completions
        (session_id, plan_id, actual_exercises_json, rpe_overall,
         duration_minutes, energy_level, soreness_level, notes,
         completed_duration_sec, completed_distance_meters,
         completed_sets_json, completed_reps_json, completed_load_json,
         rir, pain_score, pain_location, technical_success_score,
         missed_reason, external_training_declared, completion_state,
         readiness_level, difficulty_feedback, duration_feedback,
         discomfort_flag, discomfort_flags_json, discomfort_locations_json,
         discomfort_details, substitutions_used_json, felt_too_hard,
         felt_too_easy, felt_too_long, felt_too_short, modality, session_role)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.session_id,
      input.plan_id,
      ...COMPLETION_RETRY_FIELDS.map((field) => normalized[field]),
    );

    const stateUpdated = completionState === 'completed'
      ? markSessionCompleted(input.session_id)
      : completionState === 'skipped'
        ? markSessionSkipped(input.session_id)
        : updateSession(input.session_id, { status: 'partial' });
    if (!stateUpdated) {
      throw new Error(`TRAINING_COMPLETION_SESSION_STATE_WRITE_FAILED:${input.session_id}`);
    }
    return db.prepare('SELECT * FROM training_completions WHERE id = ?')
      .get(result.lastInsertRowid) as TrainingCompletion;
  })();

  logger.info(
    {
      sessionId: input.session_id,
      completionState,
      hasRpe: input.rpe_overall != null,
      hasRir: input.rir != null,
      hasPainScore: input.pain_score != null,
      hasPainLocation: Boolean(input.pain_location),
      hasDiscomfortDetails: Boolean(input.discomfort_details),
      externalDeclared: input.external_training_declared === true,
    },
    'Training completion feedback persisted',
  );
  return completion;
}

/**
 * Latest durable disposition for a plan. The session join rejects orphaned
 * or cross-plan rows before an aggregate summary reaches another skill.
 */
export function getLatestCompletionForPlan(planId: number): TrainingCompletion | null {
  const db = getDb();
  return (db.prepare(`
    SELECT tc.*
      FROM training_completions tc
      JOIN training_sessions ts
        ON ts.id = tc.session_id
       AND ts.plan_id = tc.plan_id
     WHERE tc.plan_id = ?
     ORDER BY datetime(tc.completed_at) DESC, tc.id DESC
     LIMIT 1
  `).get(planId) as TrainingCompletion | undefined) ?? null;
}

// ── Analytics & Auto-Adjust ────────────────────────────────────────

export interface WeeklyAdherenceStats {
  planId: number;
  weekNumber: number;
  totalSessions: number;
  completedSessions: number;
  partialSessions: number;
  skippedSessions: number;
  pendingSessions: number;
  adherenceRate: number;          // 0-100
  avgRpe: number | null;
  avgEnergy: number | null;
  avgSoreness: number | null;
}

export function getWeeklyAdherence(planId: number, weekId: number): WeeklyAdherenceStats {
  const db = getDb();

  const sessions = db.prepare(`
    SELECT status FROM training_sessions WHERE week_id = ? AND plan_id = ?
  `).all(weekId, planId) as Array<{ status: string }>;

  const completions = db.prepare(`
    WITH ranked AS (
      SELECT tc.rpe_overall, tc.energy_level, tc.soreness_level,
             tc.completion_state, ts.status,
             ROW_NUMBER() OVER (
               PARTITION BY tc.session_id
               ORDER BY datetime(tc.completed_at) DESC, tc.id DESC
             ) AS row_number
        FROM training_completions tc
        JOIN training_sessions ts
          ON ts.id = tc.session_id
         AND ts.plan_id = tc.plan_id
       WHERE tc.plan_id = ? AND ts.week_id = ?
    )
    SELECT rpe_overall, energy_level, soreness_level
      FROM ranked
     WHERE row_number = 1
       AND completion_state IN ('completed', 'partial')
       AND status <> 'skipped'
  `).all(planId, weekId) as Array<{ rpe_overall: number | null; energy_level: number | null; soreness_level: number | null }>;

  const week = db.prepare('SELECT week_number FROM training_weeks WHERE id = ?')
    .get(weekId) as { week_number: number } | undefined;

  const adherenceSessions = sessions.filter((s) => isAdherenceBearingSession(s.status));
  const total = adherenceSessions.length;
  const completed = adherenceSessions.filter(s => s.status === 'completed').length;
  const partial = adherenceSessions.filter(s => s.status === 'partial').length;
  const skipped = adherenceSessions.filter(s => s.status === 'skipped').length;

  const rpValues = completions.filter(c => c.rpe_overall != null).map(c => c.rpe_overall!);
  const energyValues = completions.filter(c => c.energy_level != null).map(c => c.energy_level!);
  const sorenessValues = completions.filter(c => c.soreness_level != null).map(c => c.soreness_level!);

  const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

  return {
    planId,
    weekNumber: week?.week_number ?? 0,
    totalSessions: total,
    completedSessions: completed,
    partialSessions: partial,
    skippedSessions: skipped,
    pendingSessions: total - completed - partial - skipped,
    adherenceRate: total > 0 ? Math.round(((completed + (partial * 0.5)) / total) * 100) : 0,
    avgRpe: avg(rpValues) != null ? Math.round(avg(rpValues)! * 10) / 10 : null,
    avgEnergy: avg(energyValues) != null ? Math.round(avg(energyValues)! * 10) / 10 : null,
    avgSoreness: avg(sorenessValues) != null ? Math.round(avg(sorenessValues)! * 10) / 10 : null,
  };
}

/**
 * Compute auto-adjustment recommendation for the upcoming week
 * based on adherence, RPE, energy, and soreness trends.
 */
export function computeAdjustmentRecommendation(stats: WeeklyAdherenceStats): {
  adjustIntensity: number;   // new intensity_pct (e.g. 80 = reduce to 80%)
  reason: string;
} {
  const reasons: string[] = [];
  let intensityMod = 0;

  // Low adherence — reduce volume/intensity
  if (stats.adherenceRate < 50) {
    intensityMod -= 20;
    reasons.push(`low adherence (${stats.adherenceRate}%)`);
  } else if (stats.adherenceRate < 75) {
    intensityMod -= 10;
    reasons.push(`moderate adherence (${stats.adherenceRate}%)`);
  }

  // High RPE — athlete is struggling
  if (stats.avgRpe != null && stats.avgRpe >= 9) {
    intensityMod -= 15;
    reasons.push(`very high RPE (${stats.avgRpe})`);
  } else if (stats.avgRpe != null && stats.avgRpe >= 8) {
    intensityMod -= 5;
    reasons.push(`high RPE (${stats.avgRpe})`);
  }

  // Low energy
  if (stats.avgEnergy != null && stats.avgEnergy <= 3) {
    intensityMod -= 15;
    reasons.push(`low energy (${stats.avgEnergy}/10)`);
  } else if (stats.avgEnergy != null && stats.avgEnergy <= 5) {
    intensityMod -= 5;
    reasons.push(`moderate energy (${stats.avgEnergy}/10)`);
  }

  // High soreness
  if (stats.avgSoreness != null && stats.avgSoreness >= 8) {
    intensityMod -= 15;
    reasons.push(`high soreness (${stats.avgSoreness}/10)`);
  } else if (stats.avgSoreness != null && stats.avgSoreness >= 6) {
    intensityMod -= 5;
    reasons.push(`moderate soreness (${stats.avgSoreness}/10)`);
  }

  // Good signals — can increase slightly
  if (stats.adherenceRate >= 90 && (stats.avgRpe ?? 7) <= 7 && (stats.avgEnergy ?? 7) >= 7) {
    intensityMod += 5;
    reasons.push('strong adherence + recovery signals');
  }

  // Clamp between 60% and 110%
  const adjustIntensity = Math.max(60, Math.min(110, 100 + intensityMod));
  const reason = reasons.length > 0 ? reasons.join('; ') : 'on track — no adjustment needed';

  return { adjustIntensity, reason };
}

/**
 * Get a summary of the active training plan for state context injection.
 */
export function getActivePlanSummary(userId: number, tenantId: number): string | null {
  const plan = getActivePlan(userId, tenantId);
  if (!plan) return null;

  const currentWeek = getCurrentWeek(plan.id);
  const weeks = getWeeksForPlan(plan.id);
  const parts: string[] = [];

  parts.push(`[ACTIVE TRAINING PLAN: "${plan.name}"]`);
  parts.push(`Sport: ${plan.sport} | Goal: ${plan.goal || 'general fitness'}`);
  parts.push(`Duration: ${plan.duration_weeks} weeks (${plan.start_date} → ${plan.end_date})`);
  parts.push(`Periodization: ${plan.periodization}`);
  parts.push(`Plan ID: ${plan.id}`);

  if (currentWeek) {
    parts.push(`\nCurrent: Week ${currentWeek.week_number}/${plan.duration_weeks} — Focus: ${currentWeek.focus || 'general'}`);
    parts.push(`Intensity: ${currentWeek.intensity_pct}%`);
    if (currentWeek.auto_adjusted) {
      parts.push(`(Auto-adjusted: ${currentWeek.adjustment_reason})`);
    }

    const sessions = getSessionsForWeek(currentWeek.id);
    if (sessions.length > 0) {
      parts.push(`\nThis week's sessions:`);
      for (const s of sessions) {
        const statusIcon = s.status === 'completed' ? 'done' : s.status === 'skipped' ? 'skip' : 'todo';
        parts.push(`  ${s.day_of_week}: ${s.title} [${s.session_type}] (${statusIcon}) — session_id: ${s.id}`);
      }
    }

    // Adherence for completed week
    const adherence = getWeeklyAdherence(plan.id, currentWeek.id);
    if (adherence.completedSessions > 0 || adherence.partialSessions > 0 || adherence.skippedSessions > 0) {
      const partialLabel = adherence.partialSessions > 0
        ? ` + ${adherence.partialSessions} partial`
        : '';
      parts.push(`\nWeek stats: ${adherence.completedSessions} completed${partialLabel} / ${adherence.totalSessions} sessions (${adherence.adherenceRate}%)`);
      if (adherence.avgRpe != null) parts.push(`Avg RPE: ${adherence.avgRpe}`);
      if (adherence.avgSoreness != null) parts.push(`Avg soreness: ${adherence.avgSoreness}/10`);
    }
  } else {
    parts.push(`\nWeeks defined: ${weeks.length}`);
  }

  return parts.join('\n');
}

/**
 * Get plan stats for portal display.
 */
export function getPlanStats(userId: number, tenantId: number): {
  activePlans: number;
  totalCompletedSessions: number;
  currentWeekAdherence: number;
  currentPlanName: string | null;
} {
  const db = getDb();
  const activePlan = getActivePlan(userId, tenantId);

  const activePlans = (db.prepare(`
    SELECT COUNT(*) as cnt FROM fitness_training_plans WHERE user_id = ? AND tenant_id = ? AND status = 'active'
  `).get(userId, tenantId) as { cnt: number }).cnt;

  const totalCompleted = (db.prepare(`
    SELECT COUNT(*) AS cnt
      FROM training_sessions sessions
      JOIN fitness_training_plans plans ON plans.id = sessions.plan_id
     WHERE plans.user_id = ?
       AND plans.tenant_id = ?
       AND sessions.status = 'completed'
  `).get(userId, tenantId) as { cnt: number }).cnt;

  let adherence = 0;
  if (activePlan) {
    const currentWeek = getCurrentWeek(activePlan.id);
    if (currentWeek) {
      const stats = getWeeklyAdherence(activePlan.id, currentWeek.id);
      adherence = stats.adherenceRate;
    }
  }

  return {
    activePlans,
    totalCompletedSessions: totalCompleted,
    currentWeekAdherence: adherence,
    currentPlanName: activePlan?.name ?? null,
  };
}
