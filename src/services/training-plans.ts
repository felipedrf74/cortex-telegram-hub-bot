// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Fitness Training Plans Service
 *
 * Manages AI-generated periodized training plans with calendar integration
 * and weekly auto-adjustment based on completion data and wearable metrics.
 */

import { getDb } from './database';
import { logger } from '../utils/logger';
import { createEvent as createCalendarEvent, hasWritableCalendarForUser } from './unified-calendar';
import { publishTrainingSessionScheduled } from './training-signals';

// ─── Phase 1 Slice B helper ─────────────────────────────────────────

/** Map a training plan sport string to the canonical sport enum for signals. */
function normalizeSportForSignals(sport: string): 'gym' | 'running' | 'cycling' | 'swim' | null {
  const s = sport.toLowerCase().trim();
  if (['gym', 'strength', 'lifting', 'weight', 'weights', 'musculacao', 'musculação'].includes(s)) return 'gym';
  if (['run', 'running', 'corrida'].includes(s)) return 'running';
  if (['bike', 'biking', 'cycle', 'cycling', 'ciclismo', 'pedal'].includes(s)) return 'cycling';
  if (['swim', 'swimming', 'natacao', 'natação'].includes(s)) return 'swim';
  return null;
}

// ── Types ──────────────────────────────────────────────────────────

export interface TrainingPlan {
  id: number;
  user_id: number;
  name: string;
  sport: string;
  goal: string | null;
  duration_weeks: number;
  periodization: string;
  status: 'active' | 'completed' | 'paused' | 'cancelled';
  start_date: string;
  end_date: string;
  preferences_json: string | null;
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

export interface TrainingSession {
  id: number;
  week_id: number;
  plan_id: number;
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
  status: 'pending' | 'completed' | 'skipped' | 'moved';
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
  created_at: string;
}

export interface CreatePlanInput {
  user_id: number;
  name: string;
  sport: string;
  goal?: string;
  duration_weeks: number;
  periodization?: string;
  start_date: string;
  end_date: string;
  preferences_json?: string;
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
}

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
  const result = db.prepare(`
    INSERT INTO fitness_training_plans
      (user_id, name, sport, goal, duration_weeks, periodization, start_date, end_date, preferences_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.user_id, input.name, input.sport, input.goal ?? null,
    input.duration_weeks, input.periodization ?? 'linear',
    input.start_date, input.end_date, input.preferences_json ?? null,
  );
  logger.info({ planId: result.lastInsertRowid, name: input.name }, 'Training plan created');
  return getDb().prepare('SELECT * FROM fitness_training_plans WHERE id = ?')
    .get(result.lastInsertRowid) as TrainingPlan;
}

export function getActivePlan(userId: number): TrainingPlan | null {
  const db = getDb();
  return (db.prepare(`
    SELECT * FROM fitness_training_plans
    WHERE user_id = ? AND status = 'active'
    ORDER BY created_at DESC LIMIT 1
  `).get(userId) as TrainingPlan | undefined) ?? null;
}

/**
 * Get ALL active plans for a user — supports multi-sport planning.
 * Each plan targets a different sport (gym, running, cycling, swim).
 * Used by the cross-plan interference check and the plan renewal logic.
 */
export function getActivePlans(userId: number): TrainingPlan[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM fitness_training_plans
    WHERE user_id = ? AND status = 'active'
    ORDER BY sport, created_at DESC
  `).all(userId) as TrainingPlan[];
}

/**
 * Get the total weekly training load across ALL active plans.
 * Used for overtraining prevention when creating a new plan.
 */
export function getCrossplanWeeklyLoad(userId: number): {
  totalSessions: number;
  bySport: Record<string, number>;
  totalMinutes: number;
} {
  const plans = getActivePlans(userId);
  const result = { totalSessions: 0, bySport: {} as Record<string, number>, totalMinutes: 0 };

  for (const plan of plans) {
    const week = getCurrentWeek(plan.id);
    if (!week) continue;
    const sessions = getSessionsForWeek(week.id);
    const sportSessions = sessions.filter(s => s.status !== 'skipped');
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
export function deletePlanHard(planId: number, userId: number): {
  ok: boolean;
  removedPlans: number;
  removedWeeks: number;
  removedSessions: number;
  removedCompletions: number;
} {
  const db = getDb();

  const weeksCount = (db.prepare('SELECT COUNT(*) AS n FROM training_weeks WHERE plan_id = ?')
    .get(planId) as { n: number } | undefined)?.n ?? 0;
  const sessionsCount = (db.prepare('SELECT COUNT(*) AS n FROM training_sessions WHERE plan_id = ?')
    .get(planId) as { n: number } | undefined)?.n ?? 0;
  const completionsCount = (db.prepare('SELECT COUNT(*) AS n FROM training_completions WHERE plan_id = ?')
    .get(planId) as { n: number } | undefined)?.n ?? 0;

  // Scope the DELETE to (id, user_id) so a stale planId from another
  // tenant cannot accidentally remove someone else's plan even if the
  // caller's ownership gate is bypassed in the future.
  const result = db.prepare(`
    DELETE FROM fitness_training_plans WHERE id = ? AND user_id = ?
  `).run(planId, userId);

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

export function getCurrentWeek(planId: number): TrainingWeek | null {
  const db = getDb();
  const plan = getPlanById(planId);
  if (!plan) return null;

  const startDate = new Date(plan.start_date);
  const now = new Date();
  const diffMs = now.getTime() - startDate.getTime();
  const rawWeekNumber = Math.floor(diffMs / (7 * 24 * 60 * 60 * 1000)) + 1;
  const weekNumber = Math.min(
    Math.max(1, rawWeekNumber),
    Math.max(1, plan.duration_weeks || 1),
  );

  return (db.prepare(`
    SELECT * FROM training_weeks WHERE plan_id = ? AND week_number = ?
  `).get(planId, weekNumber) as TrainingWeek | undefined) ?? null;
}

export function updateWeekAdjustment(weekId: number, intensityPct: number, reason: string): boolean {
  const db = getDb();
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
  const result = db.prepare(`
    INSERT INTO training_sessions
      (week_id, plan_id, day_of_week, session_type, title, description,
       description_json, exercises_json, duration_minutes, intensity_text,
       calendar_event_id, calendar_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.week_id, input.plan_id, normalizedDay, input.session_type,
    input.title, input.description ?? null, input.description_json ?? null,
    input.exercises_json ?? null,
    input.duration_minutes ?? null, input.intensity_text ?? null,
    input.calendar_event_id ?? null, input.calendar_source ?? null,
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

export function updateSession(
  sessionId: number,
  updates: Partial<Pick<TrainingSession, 'day_of_week' | 'title' | 'exercises_json' | 'duration_minutes' | 'intensity_text' | 'description' | 'status' | 'calendar_event_id' | 'calendar_source'>>,
): boolean {
  const db = getDb();
  const setClauses: string[] = [];
  const values: any[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
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

export function getSessionByCalendarEvent(eventId: string, source?: string | null): TrainingSession | null {
  const db = getDb();
  const row = source
    ? db.prepare(`
      SELECT * FROM training_sessions
      WHERE calendar_event_id = ? AND calendar_source = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `).get(eventId, source)
    : db.prepare(`
      SELECT * FROM training_sessions
      WHERE calendar_event_id = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `).get(eventId);

  return (row as TrainingSession | undefined) ?? null;
}

export function syncSessionWithCoachRecommendation(rec: {
  eventId: string;
  source?: string | null;
  action: 'KEEP' | 'MODIFY' | 'SWAP' | 'REST';
  newTitle?: string | null;
  newStart?: string | null;
}): boolean {
  const session = getSessionByCalendarEvent(rec.eventId, rec.source);
  if (!session) return false;

  const updates: Partial<Pick<TrainingSession, 'day_of_week' | 'title' | 'status'>> = {};

  if (rec.newTitle && rec.newTitle.trim() && rec.newTitle !== session.title) {
    updates.title = rec.newTitle.trim();
  }

  if (rec.newStart) {
    const movedAt = new Date(rec.newStart);
    if (!Number.isNaN(movedAt.getTime())) {
      updates.day_of_week = movedAt.toLocaleDateString('en-US', {
        weekday: 'long',
        timeZone: 'Europe/Lisbon',
      });
    }
  }

  if (rec.action === 'REST') {
    updates.status = 'skipped';
  }

  return updateSession(session.id, updates);
}

// ── Completion Logging ─────────────────────────────────────────────

export function logCompletion(input: LogCompletionInput): TrainingCompletion {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO training_completions
      (session_id, plan_id, actual_exercises_json, rpe_overall,
       duration_minutes, energy_level, soreness_level, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.session_id, input.plan_id, input.actual_exercises_json ?? null,
    input.rpe_overall ?? null, input.duration_minutes ?? null,
    input.energy_level ?? null, input.soreness_level ?? null, input.notes ?? null,
  );
  // Also mark the session as completed
  markSessionCompleted(input.session_id);

  logger.info({ sessionId: input.session_id, rpe: input.rpe_overall }, 'Training session completed');
  return db.prepare('SELECT * FROM training_completions WHERE id = ?')
    .get(result.lastInsertRowid) as TrainingCompletion;
}

// ── Analytics & Auto-Adjust ────────────────────────────────────────

export interface WeeklyAdherenceStats {
  planId: number;
  weekNumber: number;
  totalSessions: number;
  completedSessions: number;
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
    SELECT rpe_overall, energy_level, soreness_level FROM training_completions
    WHERE plan_id = ? AND session_id IN (
      SELECT id FROM training_sessions WHERE week_id = ?
    )
  `).all(planId, weekId) as Array<{ rpe_overall: number | null; energy_level: number | null; soreness_level: number | null }>;

  const week = db.prepare('SELECT week_number FROM training_weeks WHERE id = ?')
    .get(weekId) as { week_number: number } | undefined;

  const total = sessions.length;
  const completed = sessions.filter(s => s.status === 'completed').length;
  const skipped = sessions.filter(s => s.status === 'skipped').length;

  const rpValues = completions.filter(c => c.rpe_overall != null).map(c => c.rpe_overall!);
  const energyValues = completions.filter(c => c.energy_level != null).map(c => c.energy_level!);
  const sorenessValues = completions.filter(c => c.soreness_level != null).map(c => c.soreness_level!);

  const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

  return {
    planId,
    weekNumber: week?.week_number ?? 0,
    totalSessions: total,
    completedSessions: completed,
    skippedSessions: skipped,
    pendingSessions: total - completed - skipped,
    adherenceRate: total > 0 ? Math.round((completed / total) * 100) : 0,
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
export function getActivePlanSummary(userId: number): string | null {
  const plan = getActivePlan(userId);
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
    if (adherence.completedSessions > 0) {
      parts.push(`\nWeek stats: ${adherence.completedSessions}/${adherence.totalSessions} completed (${adherence.adherenceRate}%)`);
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
export function getPlanStats(userId: number): {
  activePlans: number;
  totalCompletedSessions: number;
  currentWeekAdherence: number;
  currentPlanName: string | null;
} {
  const db = getDb();
  const activePlan = getActivePlan(userId);

  const activePlans = (db.prepare(`
    SELECT COUNT(*) as cnt FROM fitness_training_plans WHERE user_id = ? AND status = 'active'
  `).get(userId) as { cnt: number }).cnt;

  const totalCompleted = (db.prepare(`
    SELECT COUNT(*) as cnt FROM training_completions
    WHERE plan_id IN (SELECT id FROM fitness_training_plans WHERE user_id = ?)
  `).get(userId) as { cnt: number }).cnt;

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

// ── Calendar Blocker Creation ───────────────────────────────────────

function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function addMinutesToISO(isoDateTime: string, minutes: number): string {
  const d = new Date(isoDateTime);
  d.setMinutes(d.getMinutes() + minutes);
  return d.toISOString().replace('Z', '').split('.')[0];
}

/**
 * Create calendar events for all sessions in a training week.
 * Uses the authenticated user's connected calendar. Skips gracefully if the
 * user has not connected a writable provider yet.
 *
 * @param weekOf - ISO Monday date, e.g., '2026-04-06'
 * @param sessions - Training sessions for the week
 * @param preferredTime - User's preferred start time, e.g., '06:00'
 */
export async function createCalendarBlockers(
  userId: number,
  weekOf: string,
  sessions: TrainingSession[],
  preferredTime: string,
): Promise<{ created: number; failed: number }> {
  if (!hasWritableCalendarForUser(userId)) {
    logger.info({ userId }, 'No writable user calendar connected — skipping blocker creation');
    return { created: 0, failed: 0 };
  }

  // Determine which calendar to use for this user only.
  let calendarSource: 'outlook' | 'google' | undefined;
  try {
    const { isConnected } = require('./oauth-store');
    if (isConnected(userId, 'outlook')) calendarSource = 'outlook';
    else if (isConnected(userId, 'google')) calendarSource = 'google';
  } catch { /* oauth-store not available */ }

  if (!calendarSource) {
    logger.info({ userId }, 'No user-scoped calendar provider found for blocker creation');
    return { created: 0, failed: 0 };
  }

  // Resolve sport once for the batch — all sessions belong to the same plan.
  let batchSport: 'gym' | 'running' | 'cycling' | 'swim' | null = null;
  if (sessions.length > 0) {
    const plan = getPlanById(sessions[0].plan_id);
    if (plan) batchSport = normalizeSportForSignals(plan.sport);
  }

  let created = 0;
  let failed = 0;

  for (const session of sessions) {
    const dayOfWeek = typeof session.day_of_week === 'string'
      ? parseInt(session.day_of_week, 10)
      : (session.day_of_week as unknown as number) ?? 0;

    const dayDate = addDays(weekOf, dayOfWeek);
    const duration = session.duration_minutes || 60;
    const startISO = `${dayDate}T${preferredTime}:00`;
    const endISO = addMinutesToISO(startISO, duration);

    try {
      const event = await createCalendarEvent({
        title: `🏋️ ${session.title} (${duration}min)`,
        start: startISO,
        end: endISO,
        description: session.description || undefined,
        categories: ['Green category'],
      }, calendarSource, userId);

      linkSessionToCalendar(session.id, event.id || event.summary, calendarSource);
      created++;

      // ─── Phase 1 Slice B — Signal C publishing ───
      // Let the secretary (and sibling sport coaches) know this session
      // now occupies a calendar slot. The secretary will cross-reference
      // future user events against these signals to detect conflicts.
      if (batchSport) {
        try {
          publishTrainingSessionScheduled({
            userId,
            sport: batchSport,
            sessionId: session.id,
            startTimeIso: new Date(startISO).toISOString(),
            endTimeIso: new Date(endISO).toISOString(),
            title: session.title,
            calendarEventId: event.id || event.summary,
          });
        } catch (err) {
          logger.warn({ err, sessionId: session.id }, 'publishTrainingSessionScheduled failed');
        }
      }
    } catch (err) {
      logger.warn({ err, session: session.title, userId }, 'Failed to create calendar blocker');
      failed++;
    }
  }

  return { created, failed };
}
