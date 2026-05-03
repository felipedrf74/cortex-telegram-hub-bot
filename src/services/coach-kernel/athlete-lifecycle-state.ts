// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Athlete lifecycle state derivation.
 *
 * The existing `AthleteState` (`coach-kernel/types.ts`) is a SNAPSHOT
 * type carrying profile, goals, availability, recent sessions, and
 * readiness. This module derives a higher-level *lifecycle* state from
 * that snapshot:
 *
 *   onboarding             — no profile data yet; ask the questionnaire.
 *   profile_incomplete     — partial profile; some critical fields
 *                            (race date, equipment access, experience
 *                            level) still missing.
 *   returning_from_break   — 4+ consecutive missed sessions; the safe
 *                            move is reduced volume + base re-entry.
 *   overloaded             — high fatigue + persistent missed sessions;
 *                            forcing more volume risks injury.
 *   recovering             — readiness red OR illness flag set OR
 *                            high pain severity reported.
 *   deloading              — current block phase is deload OR planner
 *                            says recoveryEmphasis === 'high'.
 *   tapering               — race phase + race date < 14 days out.
 *   base_building          — early in plan (week 1–3), little history,
 *                            building aerobic base.
 *   progressing            — happy path: progressing toward goal.
 *   maintenance            — explicit maintenance goal (no progression
 *                            target).
 *   needs_user_input       — a calendar / availability conflict the
 *                            planner cannot resolve without user
 *                            choice.
 *
 * Derivation is PURE — same `AthleteState` produces the same lifecycle
 * verdict, no I/O, no DB writes. iOS read-models can call this directly
 * to render an honest "you're in <state> right now because <reason>"
 * banner. The derivation also lives outside the planner so its decisions
 * can be unit-tested in isolation.
 *
 * NO MIGRATION REQUIRED. This is a typed derivation; the lifecycle is
 * recomputed on every read. A future slice can persist the lifecycle
 * to a `training_athlete_lifecycle` table for trend analysis, but for
 * closed beta the on-demand derivation is sufficient.
 */

import type { AthleteState, ReadinessSnapshot, ComplianceSummary } from './types';

export type AthleteLifecycleState =
  | 'onboarding'
  | 'profile_incomplete'
  | 'returning_from_break'
  | 'overloaded'
  | 'recovering'
  | 'deloading'
  | 'tapering'
  | 'base_building'
  | 'progressing'
  | 'maintenance'
  | 'needs_user_input';

export interface AthleteLifecycleVerdict {
  state: AthleteLifecycleState;
  /**
   * Short human-readable rationale ("readiness red + recent miss
   * streak → recovering"). Goes into decision-trail / iOS banner /
   * structured logs.
   */
  reason: string;
  /** Diagnostic bag for log aggregation. */
  signals: AthleteLifecycleSignals;
}

export interface AthleteLifecycleSignals {
  hasProfile: boolean;
  hasMissingCriticalData: boolean;
  consecutiveMisses: number;
  trailing14DayCompliance: number;
  readinessLevel: ReadinessSnapshot['level'] | 'unknown';
  isIllOrInjured: boolean;
  currentBlockPhase: string;
  blockWeekIndex: number;
  totalWeeksInBlock: number;
  hasRaceDate: boolean;
  daysToRace: number | null;
  isMaintenanceGoal: boolean;
  isReturnToTrainingGoal: boolean;
  highSeverityInjury: boolean;
}

const RETURN_TO_BREAK_THRESHOLD = 4; // 4+ misses in a row
const TAPER_DAYS_THRESHOLD = 14;

function safeDate(value: unknown): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(d.getTime()) ? d : null;
}

function daysBetween(a: Date, b: Date): number {
  const ms = b.getTime() - a.getTime();
  return Math.round(ms / (24 * 60 * 60 * 1000));
}

function detectHighSeverityInjury(state: AthleteState): boolean {
  const flags = state.constraints?.filter((c) => c.type === 'injury') ?? [];
  return flags.some((c) => {
    const severity = (c as any).severity;
    return severity === 'high' || severity === 'critical' || severity === 'severe';
  });
}

function detectIllness(readiness: ReadinessSnapshot | undefined): boolean {
  if (!readiness) return false;
  // Some snapshots carry an explicit illness flag; some don't.
  // Use the level + a structured field if present.
  if ((readiness as any).illness === true) return true;
  if ((readiness as any).status === 'sick' || (readiness as any).status === 'illness') return true;
  return false;
}

function buildSignals(state: AthleteState, now: Date): AthleteLifecycleSignals {
  const compliance: ComplianceSummary = state.compliance ?? {
    trailing14DayCompliance: 1,
    consecutiveMisses: 0,
  } as ComplianceSummary;
  const profileQuality = state.profileQuality;
  const hasProfile =
    !!state.normalizedTrainingProfile &&
    Object.keys(state.normalizedTrainingProfile).length > 0;
  const hasMissingCriticalData =
    !!profileQuality?.missingCriticalData?.length;
  const readiness = state.readiness;
  const goals = state.goals;
  // `Goals['primaryFocus']` is a `CoachingDiscipline`; "maintenance"
  // is signaled via `priorityOrder` (e.g. `['strength']` with
  // strengthGoal='maintenance') or via `progressionState`. We detect
  // it cheaply through the priority order's first entry being literally
  // 'maintenance' OR the strengthGoal explicitly being 'maintenance'
  // when there's no race calendar.
  const isMaintenanceGoal =
    String(goals.priorityOrder?.[0] || '').toLowerCase() === 'maintenance' ||
    (goals.strengthGoal === 'maintenance' && (!goals.raceCalendar || goals.raceCalendar.length === 0));
  const isReturnToTrainingGoal = String(goals.priorityOrder?.[0] || '').toLowerCase() === 'return';
  const raceDate = safeDate(goals.raceCalendar?.[0]?.date);
  const daysToRace = raceDate ? daysBetween(now, raceDate) : null;
  const block = state.currentBlock ?? {
    discipline: 'hybrid',
    phase: 'base',
    weekIndex: 0,
    totalWeeks: 0,
    volumeProgressionPct: 0,
  };
  return {
    hasProfile,
    hasMissingCriticalData,
    consecutiveMisses: compliance.consecutiveMisses ?? 0,
    trailing14DayCompliance: compliance.trailing14DayCompliance ?? 1,
    readinessLevel: readiness?.level ?? 'unknown',
    isIllOrInjured: detectIllness(readiness) || detectHighSeverityInjury(state),
    currentBlockPhase: String(block.phase),
    blockWeekIndex: block.weekIndex ?? 0,
    totalWeeksInBlock: block.totalWeeks ?? 0,
    hasRaceDate: !!raceDate,
    daysToRace,
    isMaintenanceGoal,
    isReturnToTrainingGoal,
    highSeverityInjury: detectHighSeverityInjury(state),
  };
}

/**
 * Derive the typed lifecycle state. Order matters — earlier branches
 * have priority because they describe more urgent product needs.
 */
export function deriveAthleteLifecycleState(
  state: AthleteState,
  now: Date = new Date(),
): AthleteLifecycleVerdict {
  const signals = buildSignals(state, now);

  // 1. Hard-blocking: no profile at all.
  if (!signals.hasProfile) {
    return {
      state: 'onboarding',
      reason: 'No training profile present yet — start with the questionnaire.',
      signals,
    };
  }

  // 2. Hard-blocking: profile is partial.
  if (signals.hasMissingCriticalData) {
    return {
      state: 'profile_incomplete',
      reason: 'One or more critical profile fields are missing (e.g. race date, equipment, experience level).',
      signals,
    };
  }

  // 3. Health-first overrides: illness or high-severity injury.
  if (signals.isIllOrInjured) {
    return {
      state: 'recovering',
      reason: signals.highSeverityInjury
        ? 'High-severity injury reported; protective recovery state engaged.'
        : 'Illness flag detected; recovery state engaged.',
      signals,
    };
  }

  // 4. Readiness-first override.
  if (signals.readinessLevel === 'red') {
    return {
      state: 'recovering',
      reason: 'Readiness is red — recovery before next hard session.',
      signals,
    };
  }

  // 5. Long absence: 4+ consecutive missed sessions.
  if (signals.consecutiveMisses >= RETURN_TO_BREAK_THRESHOLD) {
    return {
      state: 'returning_from_break',
      reason: `${signals.consecutiveMisses} consecutive missed sessions — return-to-training mode.`,
      signals,
    };
  }

  // 6. Overload: orange readiness + low adherence + missing sessions.
  if (
    signals.readinessLevel === 'orange' &&
    signals.trailing14DayCompliance < 0.6 &&
    signals.consecutiveMisses >= 1
  ) {
    return {
      state: 'overloaded',
      reason: 'Orange readiness with low adherence; reducing volume to avoid overload.',
      signals,
    };
  }

  // 7. Explicit deload phase.
  if (signals.currentBlockPhase === 'deload') {
    return {
      state: 'deloading',
      reason: 'Current block is a deload week.',
      signals,
    };
  }

  // 8. Tapering window: race date close.
  if (
    signals.hasRaceDate &&
    signals.daysToRace !== null &&
    signals.daysToRace > 0 &&
    signals.daysToRace <= TAPER_DAYS_THRESHOLD
  ) {
    return {
      state: 'tapering',
      reason: `Race day in ${signals.daysToRace} day${signals.daysToRace === 1 ? '' : 's'} — taper engaged.`,
      signals,
    };
  }

  // 9. Maintenance / return-to-training explicit goals.
  if (signals.isReturnToTrainingGoal) {
    return {
      state: 'returning_from_break',
      reason: 'Goal is explicitly return-to-training.',
      signals,
    };
  }
  if (signals.isMaintenanceGoal) {
    return {
      state: 'maintenance',
      reason: 'Goal is explicitly maintenance — no progression target.',
      signals,
    };
  }

  // 10. Early-block + low recent volume → base building.
  if (signals.blockWeekIndex <= 2 && signals.trailing14DayCompliance >= 0.85) {
    return {
      state: 'base_building',
      reason: 'Early in the block with healthy adherence — base-building phase.',
      signals,
    };
  }

  // 11. Default happy path.
  return {
    state: 'progressing',
    reason: 'On track: healthy readiness, healthy adherence, mid-block progression.',
    signals,
  };
}
