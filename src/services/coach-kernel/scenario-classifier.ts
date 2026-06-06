// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Unified scenario classifier with CoachAction grammar — slice C8 of
 * the Week-Level Adaptability + Periodization plan (v2.1).
 *
 * Replaces the v1 free-form `recommendedActions[]` (strings) with a
 * typed `CoachAction[]` discriminated union. Every adaptive output
 * the engine produces becomes data, not prose — testable, ledger-
 * persistable, iOS-explainable.
 *
 * Two-tier precedence (per v2.1 critique):
 *
 *   1. **Hard safety overrides** — chest pain, fever, acute injury,
 *      RED-S high risk. ALWAYS win. Surface a `pause_training`
 *      action with severity 'medical_referral'.
 *
 *   2. **Composable modifiers** — race/taper, recovery, travel,
 *      return-from-gap, missed-session, progression/deload, adherence.
 *      These STACK rather than single-winner — multiple can fire
 *      together, producing multiple CoachActions.
 *
 * Anti-churn (slice A5 CoachPlanPolicy.adaptationRateLimits):
 *   - Defaults: ≤1 non-safety reflow per 24h, ≤2 per week.
 *   - Safety overrides are EXEMPT.
 *   - Configurable per plan.
 *
 * Missed-session policy (per session type):
 *   - easy_aerobic → drop_session.
 *   - strength_accessory → drop or merge.
 *   - key_interval / tempo → reschedule when ≥48h before next high
 *     intensity; otherwise drop.
 *   - long_run / long_ride → reschedule with recovery window, or
 *     replace with shortened aerobic.
 *   - taper_session → drop_session ALWAYS (never cram).
 *
 * Low-adherence policy:
 *   - When `lowAdherenceTrend === true`, swap to "minimum viable
 *     week" (from A1b minimumViableWeekTemplates).
 */

import type {
  IntensityZone,
  Session,
  WeekConditions,
  WeekIntent,
} from './types';
import type { WireHealthSignalOutput } from './safety-wiring';
import { getMissedSessionPolicy, type Principles } from './training-principles';
import { DAY_ORDER } from './utils';

/** Typed coach actions — the DSL produced by the classifier. */
export type CoachAction =
  | { type: 'drop_session'; sessionId: string; reasonCode: string }
  | { type: 'move_session'; sessionId: string; toDate: string; reasonCode: string }
  | { type: 'scale_volume'; sessionId: string; multiplier: number; reasonCode: string }
  | { type: 'swap_exercise'; sessionId: string; fromExerciseId: string; toExerciseId: string; reasonCode: string }
  | { type: 'downgrade_intensity'; sessionId: string; targetCeiling: IntensityZone; reasonCode: string }
  | { type: 'insert_recovery_day'; date: string; reasonCode: string }
  | { type: 'pause_training'; reasonCode: string; severity: 'pause' | 'medical_referral' };

export type ScenarioName =
  | 'safety_pause'
  | 'race_protection'
  | 'taper_protection'
  | 'post_race_recovery'
  | 'low_readiness'
  | 'travel_adjustment'
  | 'equipment_substitute'
  | 'return_from_gap'
  | 'missed_session_drop'
  | 'missed_session_reschedule'
  | 'progression_block'
  | 'deload_apply'
  | 'low_adherence_simplify'
  | 'no_scenario';

/**
 * R8 P2-10 — discriminated `kind` tag for ScenarioAssessment.
 *
 * Codex called this out as the exact bug-shape that drove R6, R7,
 * and R8: a fat-optional `rateLimited?: boolean` lets every
 * consumer forget to check it, and the type system can't catch
 * the omission. The new `kind` field is non-optional, so any
 * `switch (assessment.kind)` is exhaustiveness-checked by the
 * compiler. Existing fields stay in place to preserve iOS Codable
 * compatibility — only the `kind` discriminator is new.
 *
 *   - 'safety'       — hard-pause override fires; actions[] carries
 *                      the pause_training action; modifiers/
 *                      suppressedActions are empty.
 *   - 'rate_limited' — anti-churn limit tripped; actions[] is empty;
 *                      modifiers/suppressedActions reflect the
 *                      would-have plan. `rateLimited === true`.
 *   - 'normal'       — neither gate fired; actions[] is the plan,
 *                      modifiers carry the applied scenarios.
 */
export type ScenarioAssessmentKind = 'safety' | 'rate_limited' | 'normal';

export interface ScenarioAssessment {
  /**
   * R8 P2-10 — discriminator. switch on this to enumerate every
   * mode the classifier emits; the compiler will flag any new
   * branch added in the future.
   */
  kind: ScenarioAssessmentKind;
  /** Primary scenario by precedence order. */
  primaryScenario: ScenarioName;
  /** Other scenarios that apply simultaneously. */
  modifiers: ScenarioName[];
  /** Safety overrides — typically empty unless A4 fires. */
  safetyOverrides: ScenarioName[];
  /** Typed action plan. */
  actions: CoachAction[];
  /** Confidence in the assessment (low when cold-start data). */
  confidence: 'high' | 'medium' | 'low';
  /**
   * R6 P2 fix — true when the assessment ran but actions were
   * suppressed because the plan hit the anti-churn rate limit.
   * Modifiers + primaryScenario still reflect what the classifier
   * WOULD have done so the UI can render "we'd suggest X but
   * waiting." Safety overrides bypass this gate and stay actionable
   * regardless.
   *
   * R8 P2-10 — preserved for iOS Codable compatibility; prefer
   * `kind === 'rate_limited'` for new server-side checks because
   * the compiler enforces exhaustiveness on the discriminated union.
   */
  rateLimited?: boolean;
  /**
   * Optional — the actions that the classifier would have emitted
   * had the rate limit not fired. Useful for support/audit + lets
   * the UI render a preview of the suppressed plan. Populated only
   * when `kind === 'rate_limited'`.
   */
  suppressedActions?: CoachAction[];
}

export interface ClassifyScenarioInput {
  /** Sessions in the week (from the planner). */
  sessions: readonly Session[];
  /** Aggregated week conditions (C7). */
  weekConditions: WeekConditions;
  /** The week's resolved WeekIntent (B2). */
  weekIntent: WeekIntent;
  /** Safety wiring output (A4). */
  safetyOutput?: WireHealthSignalOutput;
  /** Number of non-safety reflows in the last 24h (anti-churn). */
  recentReflowCount24h?: number;
  /** Number of non-safety reflows in the last 7 days. */
  recentReflowCount7d?: number;
  /** Per-plan policy (A5). */
  adaptationRateLimitPerDay?: number;
  adaptationRateLimitPerWeek?: number;
  principles: Principles;
}

const DEFAULT_RATE_PER_DAY = 1;
const DEFAULT_RATE_PER_WEEK = 2;

/**
 * Classify the week's scenario and emit the action plan. The function
 * walks the precedence ladder; safety overrides always emit first.
 */
export function classifyTrainingScenario(
  input: ClassifyScenarioInput,
): ScenarioAssessment {
  const safety: ScenarioName[] = [];
  const modifiers: ScenarioName[] = [];
  const actions: CoachAction[] = [];

  // 1. Hard safety overrides (always exempt from rate limits).
  if (input.safetyOutput && input.safetyOutput.effectiveSeverity === 'block') {
    safety.push('safety_pause');
    actions.push({
      type: 'pause_training',
      reasonCode: 'medical_referral',
      severity: 'medical_referral',
    });
    return {
      kind: 'safety',
      primaryScenario: 'safety_pause',
      modifiers: [],
      safetyOverrides: safety,
      actions,
      confidence: 'high',
    };
  }

  // R6 P2 fix — Codex caught that the prior early-return at
  // rate-limit dropped the would-have modifiers (travel/taper/deload
  // /race), leaving the UI with no way to render "we'd suggest X
  // but waiting." The comment promised that behavior but the code
  // returned modifiers=[] every time.
  //
  // The new shape: compute modifiers + actions normally; AFTER the
  // pass, if rate-limited, move actions → suppressedActions and
  // clear actions. primaryScenario stays as the first matched
  // modifier so support / iOS can show the intent.
  //
  // Compute the rate-limit flag UP FRONT so the post-pass can read
  // it without re-computing.
  const ratePerDay = input.adaptationRateLimitPerDay ?? DEFAULT_RATE_PER_DAY;
  const ratePerWeek = input.adaptationRateLimitPerWeek ?? DEFAULT_RATE_PER_WEEK;
  const rateLimited =
    (input.recentReflowCount24h ?? 0) >= ratePerDay ||
    (input.recentReflowCount7d ?? 0) >= ratePerWeek;

  // 3. Race / taper protection.
  if (input.weekIntent.kind === 'race') {
    modifiers.push('race_protection');
    // Drop any non-race-essential strength session this week.
    for (const s of input.sessions) {
      if (s.sport === 'strength' && !s.keySession) {
        actions.push({ type: 'drop_session', sessionId: s.id, reasonCode: 'race_week_strength_cutoff' });
      }
    }
  } else if (input.weekIntent.kind === 'taper') {
    modifiers.push('taper_protection');
    // Scale volume per WeekIntent multiplier.
    for (const s of input.sessions) {
      actions.push({
        type: 'scale_volume',
        sessionId: s.id,
        multiplier: input.weekIntent.volumeMultiplier,
        reasonCode: 'taper_volume_scaled',
      });
    }
  } else if (input.weekIntent.kind === 'post_race_recovery') {
    modifiers.push('post_race_recovery');
    for (const s of input.sessions) {
      actions.push({
        type: 'downgrade_intensity',
        sessionId: s.id,
        targetCeiling: 'aerobic',
        reasonCode: 'post_race_recovery_aerobic_only',
      });
    }
  }

  // 4. Return-from-gap.
  if (input.weekConditions.returnProtocol) {
    modifiers.push('return_from_gap');
    for (const s of input.sessions) {
      actions.push({
        type: 'scale_volume',
        sessionId: s.id,
        multiplier: 0.5,
        reasonCode: `return_from_gap_${input.weekConditions.returnProtocol}`,
      });
    }
  }

  // 5. Travel adjustment.
  if (input.weekConditions.isTravelWeek) {
    modifiers.push('travel_adjustment');
    for (const s of input.sessions) {
      if (s.sport === 'strength') {
        actions.push({
          type: 'downgrade_intensity',
          sessionId: s.id,
          targetCeiling: 'tempo',
          reasonCode: 'travel_equipment_limited',
        });
      }
    }
  }
  if (input.weekConditions.equipmentOverride) {
    modifiers.push('equipment_substitute');
  }

  // 6. Missed-session policy — per session type. Codex P2 fix:
  //    iterate ONLY the specific sessions listed in
  //    weekConditions.missedSessionIds, not every session in the
  //    week. Without IDs we cannot act safely — log it instead.
  const missedCount = input.weekConditions.missedSessionsThisWeek ?? 0;
  const missedIds = new Set(input.weekConditions.missedSessionIds ?? []);
  if (missedCount > 0 && missedIds.size > 0) {
    // Look at the specific missed sessions to decide drop vs reschedule.
    for (const s of input.sessions) {
      if (!missedIds.has(s.id)) continue;
      const role = inferSessionRole(s);
      const policy = getMissedSessionPolicy(input.principles, role) ?? 'drop';
      if (input.weekIntent.kind === 'taper' || input.weekIntent.kind === 'race') {
        // Taper override — never cram.
        modifiers.push('missed_session_drop');
        actions.push({ type: 'drop_session', sessionId: s.id, reasonCode: 'taper_session_never_cram' });
      } else if (policy === 'drop') {
        modifiers.push('missed_session_drop');
        actions.push({ type: 'drop_session', sessionId: s.id, reasonCode: 'missed_session_dropped' });
      } else if (policy === 'reschedule_if_recovery_window') {
        modifiers.push('missed_session_reschedule');
        actions.push({
          type: 'move_session',
          sessionId: s.id,
          toDate: nextAvailableDate(s.dayOfWeek, input.weekConditions.weekStartISODate),
          reasonCode: 'missed_key_rescheduled',
        });
      } else {
        modifiers.push('missed_session_drop');
        actions.push({ type: 'drop_session', sessionId: s.id, reasonCode: `missed_session_${policy}` });
      }
    }
  }

  // 7. Deload due.
  if (input.weekConditions.deloadDue) {
    modifiers.push('deload_apply');
    for (const s of input.sessions) {
      actions.push({
        type: 'scale_volume',
        sessionId: s.id,
        multiplier: 0.6,
        reasonCode: 'deload_applied',
      });
    }
  }

  // 8. Low-adherence simplification.
  if (input.weekConditions.lowAdherenceTrend) {
    modifiers.push('low_adherence_simplify');
    // Drop non-key sessions; keep one key + one aerobic + one mobility.
    const keepIds = new Set<string>();
    const key = input.sessions.find((s) => s.keySession);
    if (key) keepIds.add(key.id);
    const aerobic = input.sessions.find((s) => s.intensityZone === 'aerobic' && !keepIds.has(s.id));
    if (aerobic) keepIds.add(aerobic.id);
    const mobility = input.sessions.find((s) =>
      (s.sessionType === 'mobility' || s.tags.includes('mobility')) && !keepIds.has(s.id)
    );
    if (mobility) keepIds.add(mobility.id);
    for (const s of input.sessions) {
      if (!keepIds.has(s.id)) {
        actions.push({ type: 'drop_session', sessionId: s.id, reasonCode: 'minimum_viable_week' });
      }
    }
  }

  const primaryScenario: ScenarioName = modifiers[0] ?? 'no_scenario';

  // R6 P2 fix — anti-churn POST-pass. If we ran the classifier and
  // rate limit is tripped, suppress actions but preserve modifiers
  // so the response can communicate "would-have done X." Safety
  // already short-circuited above so this only affects non-safety
  // scenarios.
  const collapsedActions = collapseScaleVolumeActions(actions);

  if (rateLimited) {
    return {
      kind: 'rate_limited',
      primaryScenario,
      modifiers,
      safetyOverrides: safety,
      actions: [],
      suppressedActions: collapsedActions,
      rateLimited: true,
      confidence: 'medium',
    };
  }

  return {
    kind: 'normal',
    primaryScenario,
    modifiers,
    safetyOverrides: safety,
    actions: collapsedActions,
    confidence: 'medium',
  };
}

function inferSessionRole(session: Session): string {
  if (session.sessionType.includes('long_')) return 'long_run_ride';
  if (session.intensityZone === 'threshold' || session.intensityZone === 'vo2') return 'key_interval_tempo';
  if (session.sport === 'strength') return 'strength_accessory';
  return 'easy_aerobic';
}

function nextAvailableDate(dayOfWeek: string, weekStartISODate?: string): string {
  const weekStartMs = weekStartISODate ? Date.parse(`${weekStartISODate.slice(0, 10)}T00:00:00.000Z`) : NaN;
  const dayOffset = DAY_ORDER.indexOf(dayOfWeek as any);
  if (Number.isFinite(weekStartMs) && dayOffset >= 0) {
    const original = weekStartMs + dayOffset * 24 * 3600 * 1000;
    return new Date(original + 2 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  }
  return new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString().slice(0, 10);
}

function collapseScaleVolumeActions(actions: CoachAction[]): CoachAction[] {
  const result: CoachAction[] = [];
  const scaleIndexes = new Map<string, number>();

  for (const action of actions) {
    if (action.type !== 'scale_volume') {
      result.push(action);
      continue;
    }

    const existingIndex = scaleIndexes.get(action.sessionId);
    if (existingIndex === undefined) {
      scaleIndexes.set(action.sessionId, result.length);
      result.push(action);
      continue;
    }

    const existing = result[existingIndex];
    if (existing.type !== 'scale_volume') continue;
    result[existingIndex] = {
      ...existing,
      multiplier: Math.round(existing.multiplier * action.multiplier * 100) / 100,
      reasonCode: `${existing.reasonCode}+${action.reasonCode}`,
    };
  }

  return result;
}
