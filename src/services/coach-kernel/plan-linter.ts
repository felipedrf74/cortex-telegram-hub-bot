// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Plan-level deterministic linter.
 *
 * The coach-kernel produces individual sessions through specialized
 * engines (strength, running, cycling, hybrid) and each session is
 * locally validated by `session-coherence.ts` (volume × time match) and
 * `guardrails.ts` (capacity, density, key-session protection). Those
 * passes are FAST PATHS: they fix the session/week they're handed.
 *
 * `lintPlan` is a SLOW, structural pass that runs AFTER persistence
 * has decided which sessions are active vs unscheduled. It enforces
 * cross-week invariants that no per-session check can see:
 *
 *   1. **No active session is dated in the past.**           (defense-in-depth
 *      — catches anything that slipped past `resolvePlanSlotDate`.)
 *   2. **Equipment compatibility.**                          (a bodyweight-only
 *      user must never see a session whose exercises mention barbells,
 *      machines, or named gym equipment.)
 *   3. **No three consecutive leg-heavy days.**              (lower-body
 *      density safety — even if each individual day passed coherence.)
 *   4. **No heavy-lower-body strength the day before a long run.**
 *      (key-session protection.)
 *   5. **No fake taper without an event/benchmark.**         (a "taper"
 *      week without a race date is misleading product copy.)
 *   6. **Race-specific plan requires a race date.**          (catches
 *      profile-incomplete cases that slipped through.)
 *   7. **Event-based race dates must be usable.**            (future race
 *      date, and plan window must not run past the race.)
 *   8. **No two consecutive identical strength sessions.**   (variety
 *      — backstops slice 4.B/4.C catalog rotation.)
 *   9. **Week 1 cannot be empty when later weeks contain work.**
 *      (prevents a plan from "starting" unscheduled while weeks 2+ sync.)
 *  10. **No sessions outside the actual plan window.**       (prevents
 *      hidden Week 5 / out-of-window move suggestions in 4-week plans.)
 *  11. **Active sessions need executable prescription basics.**
 *      (duration plus detail/equipment blocks, not just a label.)
 *
 * Output shape mirrors `GuardrailResult` so the existing decision-trail
 * infrastructure can absorb findings without a parallel notification
 * stack. The linter NEVER mutates the plan — it produces a verdict.
 * Caller decides whether to treat blockers as fatal (strict mode) or
 * advisor (default).
 *
 * The app-facing plan generation route now runs this as a strict,
 * write-free preflight before cancelling or persisting a plan. The
 * persistence layer still runs it again in advisor mode after writes so
 * final scheduled-date evidence can be surfaced without throwing from a
 * partially written plan.
 */

import { logger } from '../../utils/logger';
import { getTrainingCoachRuleById } from './coach-rules';

export type PlanLintRuleId =
  | 'no_past_active_sessions'
  | 'equipment_compatibility'
  | 'no_three_consecutive_leg_heavy_days'
  | 'no_heavy_lower_before_long_run'
  | 'no_fake_taper_without_event'
  | 'race_specific_plan_requires_race_date'
  | 'race_date_must_be_future'
  | 'plan_duration_overshoots_race_date'
  | 'no_consecutive_identical_strength_sessions'
  | 'plan_linter_exception'
  | 'week_one_has_active_training'
  | 'no_sessions_outside_plan_window'
  | 'session_prescription_completeness';

export type PlanLintSeverity = 'blocker' | 'warning' | 'info';

export interface PlanLintAffectedSession {
  weekNumber: number;
  sessionId?: string | number;
  dayOfWeek?: string;
  title?: string;
}

export interface PlanLintFinding {
  ruleId: PlanLintRuleId;
  severity: PlanLintSeverity;
  message: string;
  affectedSessions: PlanLintAffectedSession[];
  evidence?: Record<string, unknown>;
}

export interface PlanLintResult {
  status: 'pass' | 'pass_with_warnings' | 'fail';
  blockers: PlanLintFinding[];
  warnings: PlanLintFinding[];
  /**
   * Advisory hints for the human-readable plan summary. NOT
   * auto-applied — the call site decides whether to surface or act.
   */
  suggestedFixes: Array<{
    findingRuleId: PlanLintRuleId;
    action: string;
  }>;
}

/** Equipment profile vocabulary aligned with `training-plan-equipment-adaptation.ts`. */
export type EquipmentProfileLabel =
  | 'full_gym'
  | 'garage_gym'
  | 'home_basic'
  | 'bands'
  | 'bodyweight'
  | 'no_equipment'
  | string;

export interface PlanLintSession {
  id?: string | number;
  /** Lower-cased weekday string. */
  dayOfWeek: string;
  /** Lower-cased session-type token (e.g. `'run' | 'gym' | 'long_run' | 'rest'`). */
  sessionType: string;
  title: string;
  durationMinutes?: number;
  description?: string;
  /** Persistence status. Past-day-floor + capacity-reconciliation produce these. */
  status?:
    | 'scheduled'
    | 'compressed'
    | 'reflowed'
    | 'capped'
    | 'unscheduled'
    | 'deferred'
    | 'dropped'
    | 'pending';
  /** ISO date for the scheduled session. Required for the past-session check. */
  scheduledDate?: string | Date;
  /** Free-form lower-cased exercise tokens (joined `name + equipment + tags`). */
  exerciseTokens?: string[];
  /** Caller-set; the linter trusts these flags. Use existing helpers if you have them. */
  isLowerHeavy?: boolean;
  isLongRun?: boolean;
  isKey?: boolean;
}

export interface PlanLintWeek {
  weekNumber: number;
  focus?: string;
  intensityPct?: number;
  sessions: PlanLintSession[];
}

export interface PlanLintInput {
  now: Date;
  planId?: number;
  startDate?: string;
  /** Mark the plan as race-specific so rule 6 can fire on missing race date. */
  isRaceSpecific?: boolean;
  /** Goal mode from the plan request; event_based enables race/taper strictness. */
  goalMode?: string | null;
  raceDate?: string | Date | null;
  /** Intended plan duration. Used to block Week 5 leakage in a 4-week plan. */
  durationWeeks?: number;
  /** Vocab as produced by `training-plan-equipment-adaptation.ts`. Used by rule 2. */
  equipmentProfile?: EquipmentProfileLabel;
  weeks: PlanLintWeek[];
}

const ACTIVE_STATUSES = new Set([
  'scheduled',
  'compressed',
  'reflowed',
  'capped',
  // 'pending' deliberately excluded: a pending session has no date yet.
]);

const GYM_EQUIPMENT_TOKENS = [
  'barbell',
  'dumbbell',
  'kettlebell',
  'cable',
  'machine',
  'leg press',
  'lat pulldown',
  'smith machine',
  'leg extension',
  'leg curl',
  'hack squat',
  'pec deck',
  'preacher curl',
  'seated row',
  'rack',
  'plate',
];

const TAPER_FOCUS_PATTERNS = /\btaper\b|\brace\s*week\b|\bpeak\b|\bevent\s*week\b/i;

const PLAN_LINT_COACH_RULE_MAP: Partial<Record<PlanLintRuleId, string>> = {
  equipment_compatibility: 'strength-progressive-overload-with-deloads',
  no_three_consecutive_leg_heavy_days: 'hybrid-interference-protect-key-sessions',
  no_heavy_lower_before_long_run: 'hybrid-interference-protect-key-sessions',
  no_fake_taper_without_event: 'endurance-periodization-by-goal-horizon',
  race_specific_plan_requires_race_date: 'endurance-periodization-by-goal-horizon',
  race_date_must_be_future: 'endurance-periodization-by-goal-horizon',
  plan_duration_overshoots_race_date: 'endurance-periodization-by-goal-horizon',
  no_consecutive_identical_strength_sessions: 'strength-progressive-overload-with-deloads',
  week_one_has_active_training: 'endurance-periodization-by-goal-horizon',
  no_sessions_outside_plan_window: 'endurance-periodization-by-goal-horizon',
  session_prescription_completeness: 'coach-communication-no-raw-dumps',
};

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? new Date(value) : new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function startOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}

function makeAffected(weekNumber: number, session: PlanLintSession): PlanLintAffectedSession {
  return {
    weekNumber,
    sessionId: session.id,
    dayOfWeek: session.dayOfWeek,
    title: session.title,
  };
}

function isActiveSession(session: PlanLintSession): boolean {
  return !!session.status && ACTIVE_STATUSES.has(session.status);
}

function isRestLikeSession(session: PlanLintSession): boolean {
  const token = `${session.sessionType} ${session.title}`.toLowerCase();
  // Word-boundary matching is intentional: a coded training type such
  // as `recovery_run` stays active, while standalone rest/recovery rows
  // remain exempt from active-session and prescription checks.
  return /\b(rest|recovery|mobility|off)\b/.test(token);
}

const DAY_ORDER = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const DAY_MS = 24 * 60 * 60 * 1000;

function isEventBasedPlan(input: PlanLintInput): boolean {
  return input.goalMode === 'event_based' || input.isRaceSpecific === true;
}

function dayIndexFor(dayOfWeek: string): number {
  return DAY_ORDER.indexOf(String(dayOfWeek || '').toLowerCase());
}

function ruleNoPastActiveSessions(input: PlanLintInput): PlanLintFinding | null {
  const today = startOfDay(input.now);
  const offenders: PlanLintAffectedSession[] = [];
  for (const week of input.weeks) {
    for (const session of week.sessions) {
      if (!session.status || !ACTIVE_STATUSES.has(session.status)) continue;
      const sessionDate = toDate(session.scheduledDate);
      if (!sessionDate) continue;
      if (startOfDay(sessionDate).getTime() < today.getTime()) {
        offenders.push(makeAffected(week.weekNumber, session));
      }
    }
  }
  if (offenders.length === 0) return null;
  return {
    ruleId: 'no_past_active_sessions',
    severity: 'blocker',
    message:
      `${offenders.length} active session${offenders.length === 1 ? '' : 's'} scheduled in the past. ` +
      `Active sessions must have a scheduled date >= today; mark them 'unscheduled' instead.`,
    affectedSessions: offenders,
    evidence: { todayIso: today.toISOString().slice(0, 10) },
  };
}

function ruleEquipmentCompatibility(input: PlanLintInput): PlanLintFinding | null {
  const profile = String(input.equipmentProfile || '').toLowerCase();
  const isBodyweightProfile =
    profile === 'bodyweight' ||
    profile === 'no_equipment' ||
    profile === 'bands' ||
    profile.includes('bodyweight') ||
    profile.includes('no equipment');
  if (!isBodyweightProfile) return null;

  // For bodyweight-only profiles bands are fine; barbells/machines/cables aren't.
  const bannedTokens = GYM_EQUIPMENT_TOKENS;
  const offenders: PlanLintAffectedSession[] = [];
  const offendingTokens: string[] = [];
  for (const week of input.weeks) {
    for (const session of week.sessions) {
      if (!session.exerciseTokens?.length) continue;
      const hits = bannedTokens.filter((tok) =>
        session.exerciseTokens!.some((existing) => tokenMatchesPhrase(existing, tok)),
      );
      if (hits.length > 0) {
        offenders.push(makeAffected(week.weekNumber, session));
        offendingTokens.push(...hits);
      }
    }
  }
  if (offenders.length === 0) return null;
  return {
    ruleId: 'equipment_compatibility',
    severity: 'blocker',
    message:
      `${offenders.length} session${offenders.length === 1 ? '' : 's'} reference gym equipment ` +
      `(${[...new Set(offendingTokens)].slice(0, 5).join(', ')}) ` +
      `but the user's equipment profile is "${input.equipmentProfile}". ` +
      `Re-run training-plan-equipment-adaptation or substitute these for bodyweight/band variants.`,
    affectedSessions: offenders,
    evidence: { equipmentProfile: input.equipmentProfile, offendingTokens: [...new Set(offendingTokens)] },
  };
}

function tokenMatchesPhrase(phrase: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(phrase);
}

function ruleNoThreeConsecutiveLegHeavyDays(input: PlanLintInput): PlanLintFinding | null {
  const offenders: PlanLintAffectedSession[] = [];
  for (const week of input.weeks) {
    // Build a flat day-indexed array of {hasLegHeavy, session?}
    const byDay = new Array<PlanLintSession | null>(7).fill(null);
    for (const s of week.sessions) {
      if (!s.isLowerHeavy) continue;
      const idx = dayIndexFor(s.dayOfWeek);
      if (idx < 0) continue;
      // Last writer wins; if multiple leg-heavy on same day, count once.
      byDay[idx] = s;
    }
    // Slide a window of 3 across Mon→Sun.
    for (let i = 0; i < 5; i++) {
      const a = byDay[i];
      const b = byDay[i + 1];
      const c = byDay[i + 2];
      if (a && b && c) {
        offenders.push(
          makeAffected(week.weekNumber, a),
          makeAffected(week.weekNumber, b),
          makeAffected(week.weekNumber, c),
        );
      }
    }
  }
  if (offenders.length === 0) return null;
  return {
    ruleId: 'no_three_consecutive_leg_heavy_days',
    severity: 'warning',
    message:
      `Lower-body strength stacked on three or more consecutive days. ` +
      `Re-flow at least one of these days to upper-body, mobility, or recovery.`,
    affectedSessions: offenders,
  };
}

function ruleNoHeavyLowerBeforeLongRun(input: PlanLintInput): PlanLintFinding | null {
  const offenders: PlanLintAffectedSession[] = [];

  // Prefer exact scheduled dates when callers provide them. This catches
  // boundary cases such as "week 1 Sunday heavy lower" before "week 2
  // Monday long run", which weekday-only logic cannot see.
  const datedSessions: Array<{ weekNumber: number; session: PlanLintSession; dayStartMs: number }> = [];
  for (const week of input.weeks) {
    for (const session of week.sessions) {
      const d = toDate(session.scheduledDate);
      if (!d) continue;
      datedSessions.push({ weekNumber: week.weekNumber, session, dayStartMs: startOfDay(d).getTime() });
    }
  }
  if (datedSessions.length > 0) {
    const lowerByDay = new Map<number, Array<{ weekNumber: number; session: PlanLintSession }>>();
    for (const entry of datedSessions) {
      if (!entry.session.isLowerHeavy) continue;
      const existing = lowerByDay.get(entry.dayStartMs) ?? [];
      existing.push({ weekNumber: entry.weekNumber, session: entry.session });
      lowerByDay.set(entry.dayStartMs, existing);
    }
    for (const entry of datedSessions) {
      if (!entry.session.isLongRun) continue;
      const previousDay = entry.dayStartMs - DAY_MS;
      for (const heavy of lowerByDay.get(previousDay) ?? []) {
        offenders.push(makeAffected(heavy.weekNumber, heavy.session));
      }
    }
    if (offenders.length > 0) {
      return {
        ruleId: 'no_heavy_lower_before_long_run',
        severity: 'blocker',
        message:
          `Heavy lower-body strength scheduled the day before a long run in ${
            new Set(offenders.map((o) => o.weekNumber)).size
          } week${offenders.length === 1 ? '' : 's'}. ` +
          `Move heavy lower-body two days before, or to upper-body that day.`,
        affectedSessions: offenders,
      };
    }
  }

  for (const week of input.weeks) {
    const longRunDays = new Set<number>();
    const heavyLowerDays = new Map<number, PlanLintSession>();
    for (const s of week.sessions) {
      const idx = dayIndexFor(s.dayOfWeek);
      if (idx < 0) continue;
      if (s.isLongRun) longRunDays.add(idx);
      if (s.isLowerHeavy) heavyLowerDays.set(idx, s);
    }
    for (const longIdx of longRunDays) {
      const dayBefore = longIdx - 1;
      // Monday's previous calendar day is in the prior week; date-aware
      // lint above catches that when session dates are available.
      if (dayBefore < 0) continue;
      const heavy = heavyLowerDays.get(dayBefore);
      if (heavy) {
        offenders.push(makeAffected(week.weekNumber, heavy));
      }
    }
  }
  if (offenders.length === 0) return null;
  return {
    ruleId: 'no_heavy_lower_before_long_run',
    severity: 'blocker',
    message:
      `Heavy lower-body strength scheduled the day before a long run in ${
        new Set(offenders.map((o) => o.weekNumber)).size
      } week${offenders.length === 1 ? '' : 's'}. ` +
      `Move heavy lower-body two days before, or to upper-body that day.`,
    affectedSessions: offenders,
  };
}

function ruleNoFakeTaperWithoutEvent(input: PlanLintInput): PlanLintFinding | null {
  if (!isEventBasedPlan(input)) return null;
  const hasRaceDate = !!toDate(input.raceDate);
  if (hasRaceDate) return null;
  const offenders: PlanLintAffectedSession[] = [];
  for (const week of input.weeks) {
    if (!week.focus) continue;
    if (TAPER_FOCUS_PATTERNS.test(week.focus)) {
      offenders.push({
        weekNumber: week.weekNumber,
        title: `Week ${week.weekNumber} focus="${week.focus}"`,
      });
    }
  }
  if (offenders.length === 0) return null;
  return {
    ruleId: 'no_fake_taper_without_event',
    severity: 'blocker',
    message:
      `${offenders.length} week${offenders.length === 1 ? '' : 's'} marked as taper/peak/race-week, ` +
      `but no race date is set on the plan. Either set a race date or use a neutral focus label ` +
      `(e.g. "deload", "review", "consolidation").`,
    affectedSessions: offenders,
  };
}

function ruleRaceSpecificRequiresRaceDate(input: PlanLintInput): PlanLintFinding | null {
  if (!isEventBasedPlan(input)) return null;
  if (toDate(input.raceDate)) return null;
  return {
    ruleId: 'race_specific_plan_requires_race_date',
    severity: 'blocker',
    message:
      `Plan is marked race-specific but no race date is set. ` +
      `Ask the user for the race date before generating taper / build progression.`,
    affectedSessions: [],
  };
}

function ruleRaceDateMustBeFuture(input: PlanLintInput): PlanLintFinding | null {
  if (!isEventBasedPlan(input)) return null;
  const raceDate = toDate(input.raceDate);
  if (!raceDate) return null;
  const today = startOfDay(input.now);
  const race = startOfDay(raceDate);
  if (race.getTime() > today.getTime()) return null;
  return {
    ruleId: 'race_date_must_be_future',
    severity: 'blocker',
    message: 'Race date must be in the future before Nexus can generate an event-based training plan.',
    affectedSessions: [],
    evidence: {
      todayIso: today.toISOString().slice(0, 10),
      raceDateIso: race.toISOString().slice(0, 10),
    },
  };
}

function rulePlanDurationDoesNotOvershootRaceDate(input: PlanLintInput): PlanLintFinding | null {
  if (!isEventBasedPlan(input)) return null;
  const raceDate = toDate(input.raceDate);
  const startDate = toDate(input.startDate);
  const durationWeeks = Number(input.durationWeeks);
  if (!raceDate || !startDate || !Number.isFinite(durationWeeks) || durationWeeks <= 0) return null;
  const start = startOfDay(startDate);
  const race = startOfDay(raceDate);
  if (race.getTime() < start.getTime()) return null;
  const planDays = Math.round(durationWeeks * 7);
  const daysThroughRace = Math.floor((race.getTime() - start.getTime()) / DAY_MS) + 1;
  if (planDays <= daysThroughRace) return null;
  return {
    ruleId: 'plan_duration_overshoots_race_date',
    severity: 'blocker',
    message: `Requested ${durationWeeks} week plan extends beyond the race date. Shorten the plan or move the start date.`,
    affectedSessions: [],
    evidence: {
      startDateIso: start.toISOString().slice(0, 10),
      raceDateIso: race.toISOString().slice(0, 10),
      planDays,
      daysThroughRace,
    },
  };
}

function ruleNoConsecutiveIdenticalStrengthSessions(input: PlanLintInput): PlanLintFinding | null {
  const offenders: PlanLintAffectedSession[] = [];
  for (const week of input.weeks) {
    // Order strength sessions by day index.
    const strength = week.sessions
      .filter(
        (s) =>
          s.sessionType === 'gym' ||
          s.sessionType.startsWith('strength') ||
          s.sessionType === 'lift',
      )
      .map((s) => ({ s, idx: dayIndexFor(s.dayOfWeek) }))
      .filter((entry) => entry.idx >= 0)
      .sort((a, b) => a.idx - b.idx);

    for (let i = 0; i + 1 < strength.length; i++) {
      const cur = strength[i];
      const next = strength[i + 1];
      if (next.idx - cur.idx !== 1) continue;
      const curTokens = (cur.s.exerciseTokens ?? []).slice(0, 6).join(',');
      const nextTokens = (next.s.exerciseTokens ?? []).slice(0, 6).join(',');
      if (curTokens && curTokens === nextTokens) {
        offenders.push(makeAffected(week.weekNumber, cur.s));
        offenders.push(makeAffected(week.weekNumber, next.s));
      }
    }
  }
  if (offenders.length === 0) return null;
  return {
    ruleId: 'no_consecutive_identical_strength_sessions',
    severity: 'warning',
    message:
      `Two consecutive strength sessions with identical exercise selection detected. ` +
      `Coach-kernel slice 4.B/4.C should rotate variants — verify support-session-builder ran.`,
    affectedSessions: offenders,
  };
}

function ruleWeekOneHasActiveTraining(input: PlanLintInput): PlanLintFinding | null {
  const totalActiveTraining = input.weeks.reduce((count, week) => {
    return count + week.sessions.filter((session) => isActiveSession(session) && !isRestLikeSession(session)).length;
  }, 0);
  if (totalActiveTraining === 0) return null;

  const weekOne = input.weeks.find((week) => week.weekNumber === 1);
  const weekOneActive = weekOne?.sessions.filter(
    (session) => isActiveSession(session) && !isRestLikeSession(session),
  ) ?? [];
  if (weekOneActive.length > 0) return null;

  return {
    ruleId: 'week_one_has_active_training',
    severity: 'blocker',
    message:
      `Week 1 has zero active training sessions while the plan contains ${totalActiveTraining} ` +
      `active session${totalActiveTraining === 1 ? '' : 's'} later. ` +
      `Do not save a plan whose first week is empty; reflow or keep the whole plan in preview.`,
    affectedSessions: [{ weekNumber: 1, title: 'Week 1' }],
    evidence: { totalActiveTraining },
  };
}

function ruleNoSessionsOutsidePlanWindow(input: PlanLintInput): PlanLintFinding | null {
  const durationWeeks = typeof input.durationWeeks === 'number' && Number.isFinite(input.durationWeeks)
    ? Math.max(0, Math.floor(input.durationWeeks))
    : undefined;
  if (!durationWeeks || durationWeeks <= 0) {
    if (input.startDate || input.weeks.some((week) => week.weekNumber > 1)) {
      logger.debug(
        {
          ruleId: 'no_sessions_outside_plan_window',
          durationWeeks: input.durationWeeks,
          startDate: input.startDate,
          weekNumbers: input.weeks.map((week) => week.weekNumber),
        },
        'Training plan lint skipped window check because durationWeeks is missing or invalid',
      );
    }
    return null;
  }

  const offenders: PlanLintAffectedSession[] = [];
  const offendingWeeks: number[] = [];
  for (const week of input.weeks) {
    if (week.weekNumber < 1 || week.weekNumber > durationWeeks) {
      offendingWeeks.push(week.weekNumber);
      for (const session of week.sessions) {
        offenders.push(makeAffected(week.weekNumber, session));
      }
      if (week.sessions.length === 0) {
        offenders.push({ weekNumber: week.weekNumber, title: `Week ${week.weekNumber}` });
      }
    }
  }

  const start = toDate(input.startDate);
  if (start) {
    const startDay = startOfDay(start);
    const endExclusive = new Date(startDay.getTime() + durationWeeks * 7 * 24 * 60 * 60 * 1000);
    for (const week of input.weeks) {
      for (const session of week.sessions) {
        if (!isActiveSession(session)) continue;
        const scheduledDate = toDate(session.scheduledDate);
        if (!scheduledDate) continue;
        const sessionDay = startOfDay(scheduledDate);
        if (sessionDay.getTime() < startDay.getTime() || sessionDay.getTime() >= endExclusive.getTime()) {
          offenders.push(makeAffected(week.weekNumber, session));
        }
      }
    }
  }

  if (offenders.length === 0) return null;
  return {
    ruleId: 'no_sessions_outside_plan_window',
    severity: 'blocker',
    message:
      `Training plan contains sessions outside its ${durationWeeks}-week window. ` +
      `Move suggestions and scheduled sessions must stay inside the actual plan dates.`,
    affectedSessions: offenders,
    evidence: {
      durationWeeks,
      offendingWeeks: [...new Set(offendingWeeks)],
      startDate: input.startDate,
    },
  };
}

function ruleSessionPrescriptionCompleteness(input: PlanLintInput): PlanLintFinding | null {
  const offenders: PlanLintAffectedSession[] = [];
  for (const week of input.weeks) {
    for (const session of week.sessions) {
      if (!isActiveSession(session) || isRestLikeSession(session)) continue;
      const hasDuration = typeof session.durationMinutes === 'number' && session.durationMinutes > 0;
      const hasDetail =
        (typeof session.description === 'string' && session.description.trim().length >= 12) ||
        (Array.isArray(session.exerciseTokens) && session.exerciseTokens.length > 0);
      if (!hasDuration || !hasDetail) offenders.push(makeAffected(week.weekNumber, session));
    }
  }
  if (offenders.length === 0) return null;
  return {
    ruleId: 'session_prescription_completeness',
    severity: 'warning',
    message:
      `Active training sessions need executable prescription basics: duration plus description, intervals, ` +
      `or exercise detail. Avoid saving label-only workouts.`,
    affectedSessions: offenders,
  };
}

const RULES: Array<(input: PlanLintInput) => PlanLintFinding | null> = [
  ruleNoPastActiveSessions,
  ruleWeekOneHasActiveTraining,
  ruleNoSessionsOutsidePlanWindow,
  ruleEquipmentCompatibility,
  ruleNoThreeConsecutiveLegHeavyDays,
  ruleNoHeavyLowerBeforeLongRun,
  ruleNoFakeTaperWithoutEvent,
  ruleRaceSpecificRequiresRaceDate,
  ruleRaceDateMustBeFuture,
  rulePlanDurationDoesNotOvershootRaceDate,
  ruleNoConsecutiveIdenticalStrengthSessions,
  ruleSessionPrescriptionCompleteness,
];

const SUGGESTED_FIXES: Record<PlanLintRuleId, string> = {
  no_past_active_sessions:
    'Mark past-dated active sessions as `unscheduled` and surface in the read model.',
  equipment_compatibility:
    'Re-run `adaptTrainingPlanToAvailableEquipment` against the user equipment profile.',
  no_three_consecutive_leg_heavy_days:
    'Replace the middle leg-heavy day with upper-body or mobility (see catalog substitutions).',
  no_heavy_lower_before_long_run:
    'Move heavy lower-body strength two days before the long run, or convert that day to upper-body.',
  no_fake_taper_without_event:
    'Use neutral focus copy ("deload"/"review") OR collect race date via training-profile follow-up.',
  race_specific_plan_requires_race_date:
    'Block plan generation until race date is provided; emit follow-up question through training-profile-requirements.',
  race_date_must_be_future:
    'Ask for a future race date before generating an event-specific plan.',
  plan_duration_overshoots_race_date:
    'Shorten the generated plan duration or ask the user to choose a later race/start date.',
  no_consecutive_identical_strength_sessions:
    'Bump strength variant index by `weekIndex` (slice 4.B/4.C) before the next regenerate.',
  plan_linter_exception:
    'Retry after the quality gate can complete; do not persist strict-preflight plans that could not be linted.',
  week_one_has_active_training:
    'Re-run scheduling with Week 1 protected; if no legal slot exists, ask the user before saving.',
  no_sessions_outside_plan_window:
    'Clamp move suggestions to the requested plan window and keep later weeks in a new plan preview.',
  session_prescription_completeness:
    'Regenerate missing warm-up/main/cooldown or strength set/rep/rest details before surfacing the session.',
};

function attachCoachRuleEvidence(finding: PlanLintFinding): PlanLintFinding {
  const coachRuleId = PLAN_LINT_COACH_RULE_MAP[finding.ruleId];
  if (!coachRuleId) return finding;
  const coachRule = getTrainingCoachRuleById(coachRuleId);
  if (!coachRule) return finding;
  return {
    ...finding,
    evidence: {
      ...finding.evidence,
      coachRuleId: coachRule.id,
      sourceAnchors: coachRule.sourceAnchors,
      userFacingPrinciple: coachRule.userFacingPrinciple,
    },
  };
}

/**
 * Run every plan-lint rule against the input, collect findings, classify
 * them by severity, and produce a stable status verdict.
 */
export function lintPlan(input: PlanLintInput): PlanLintResult {
  const findings: PlanLintFinding[] = [];
  for (const rule of RULES) {
    const finding = rule(input);
    if (finding) findings.push(attachCoachRuleEvidence(finding));
  }
  const blockers = findings.filter((f) => f.severity === 'blocker');
  const warnings = findings.filter((f) => f.severity === 'warning');
  const status: PlanLintResult['status'] =
    blockers.length > 0 ? 'fail' : warnings.length > 0 ? 'pass_with_warnings' : 'pass';
  const suggestedFixes = findings.map((f) => ({
    findingRuleId: f.ruleId,
    action: SUGGESTED_FIXES[f.ruleId],
  }));
  return { status, blockers, warnings, suggestedFixes };
}
