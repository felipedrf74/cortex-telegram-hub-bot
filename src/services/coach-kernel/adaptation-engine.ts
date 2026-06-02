// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Adaptation Engine — deterministic per-session adjustments derived from
 * the user's current readiness snapshot.
 *
 * Why this exists:
 *   Before this module, "the plan didn't adapt to my actual signals" was a
 *   fair complaint (audit 2026-04-27 Layer 5). The old behavior emitted
 *   PROSE — "consider an easy run instead" — but the actual session row
 *   still said "threshold run." iOS had to either render confusing
 *   contradictions or strip the prose, neither of which surfaced *what*
 *   the coach was asking for.
 *
 *   This module returns an `AdaptedSession`: the original session with
 *   typed adaptation metadata (substituted session type, intensity
 *   downshift percent, code-emitted explanation). iOS consumes the
 *   adapted version directly. The adaptation is deterministic — given
 *   the same session and readiness, you always get the same output.
 *
 *   Rules (all code-enforced, no LLM):
 *     - readiness.level === 'red'    → swap intensity work to recovery_run/recovery_ride
 *                                      with intensityDownshiftPct: 0.6 (60% of original)
 *     - readiness.level === 'orange' → keep session type, downshift to 0.8
 *                                      EXCEPT mobility / rest / recovery_* sessions which
 *                                      pass through unchanged (already conservative)
 *     - readiness.level === 'yellow' → pass through
 *     - readiness.level === 'green'  → pass through
 *     - high-severity injury constraint → swap key/intensity sessions to
 *                                         a mobility session (caps the day)
 *
 *   The engine never UPGRADES a session (e.g., yellow readiness doesn't
 *   make a recovery run into a tempo run). It only downshifts or
 *   passes through.
 *
 * Relationship to `poor-recovery-variation.ts`:
 *   These two modules are complementary, not redundant.
 *   - `adaptation-engine` is single-session, readiness-driven, with a small
 *     fixed rule set (red/orange/yellow/green + injury cap). It is cheap
 *     enough to call at read-time from `training-read-models.ts` for the
 *     iOS Today screen, and the output structure is the canonical
 *     `AdaptedSession` that iOS renders.
 *   - `poor-recovery-variation` is scenario-aware, week-aware, and knowledge-
 *     backed. It accepts a `PoorRecoveryContext` (athlete + session + week +
 *     index) and resolves one of seven `RecoveryScenario` cases
 *     (mild_fatigue, high_soreness, low_readiness, post_intensity_fatigue,
 *     low_adherence_fatigue, travel_fatigue, hybrid_modality_overload) with
 *     templated variant prescriptions. It is invoked from the planner
 *     during plan generation, not at read time.
 *
 *   In short: this module is the fast read-time downshift; the variation
 *   module is the planner-time scenario engine. Either may eventually
 *   migrate toward the other, but today they own different surfaces.
 */

import type {
  ReadinessSnapshot,
  Session,
  SessionType,
  Sport,
} from './types';

export interface AdaptationContext {
  /** Current readiness — typically built via `readinessResultToSnapshot`. */
  readiness: ReadinessSnapshot;
  /** True when the user has an active high-severity injury constraint
   *  affecting the session's sport. Forces a mobility swap regardless of
   *  readiness level. */
  injuryAffectsSession?: boolean;
}

export type AdaptationReason =
  | 'red_readiness'
  | 'orange_readiness'
  | 'injury_safe_swap'
  | 'no_change';

export interface AdaptedSession extends Session {
  /** Original sessionType BEFORE adaptation. Set when the adapter swapped
   *  the session type (red readiness or injury). Undefined when intensity
   *  was simply downshifted. */
  originalSessionType?: SessionType;
  /** Multiplier applied to the prescribed intensity. `1.0` = no change,
   *  `0.8` = orange downshift, `0.6` = red downshift. Always in `[0, 1]`. */
  intensityDownshiftPct?: number;
  /** Why the adapter changed the session. Always set, even on
   *  pass-through (`'no_change'`) so the iOS layer can render an
   *  informational chip if it wants. */
  adaptationReason: AdaptationReason;
  /** Code-emitted, human-readable explanation. Stable across runs given
   *  the same inputs. */
  adaptationExplanation: string;
}

/** Sport-specific recovery session type. Used by the red-readiness branch. */
const RECOVERY_SESSION_BY_SPORT: Record<Sport, SessionType> = {
  running: 'recovery_run',
  cycling: 'recovery_ride',
  swimming: 'recovery_swim',
  strength: 'mobility',
};

/** Session types that already represent the gentlest version of their
 *  sport — orange/red downshifts pass these through unchanged. The user
 *  is already on a recovery day; the engine should not double-soften. */
const GENTLE_SESSION_TYPES = new Set<SessionType>([
  'recovery_run',
  'recovery_ride',
  'recovery_swim',
  'strength_maintenance',
  'mobility',
  'rest',
]);

function isGentleSession(sessionType: SessionType): boolean {
  return GENTLE_SESSION_TYPES.has(sessionType);
}

function buildExplanation(
  reason: AdaptationReason,
  original: Session,
  adapted: { sessionType: SessionType; intensityDownshiftPct: number },
): string {
  switch (reason) {
    case 'red_readiness':
      if (original.sessionType === adapted.sessionType) {
        return `Red readiness — intensity capped at ${Math.round(adapted.intensityDownshiftPct * 100)}% of plan.`;
      }
      return `Red readiness — swapped from ${original.sessionType} to ${adapted.sessionType} (${Math.round(adapted.intensityDownshiftPct * 100)}% of plan).`;
    case 'orange_readiness':
      return `Orange readiness — intensity capped at ${Math.round(adapted.intensityDownshiftPct * 100)}% of plan.`;
    case 'injury_safe_swap':
      return `Active injury — swapped from ${original.sessionType} to ${adapted.sessionType} for safety.`;
    case 'no_change':
      return 'Plan stays as written.';
  }
}

/**
 * Adapt a single session for the user's current readiness state.
 * Pure function — no I/O, no AI, no DB.
 */
export function adaptSessionForReadiness(
  session: Session,
  context: AdaptationContext,
): AdaptedSession {
  const { readiness, injuryAffectsSession } = context;

  // Injury short-circuit. A high-severity injury affecting this session's
  // sport forces a mobility swap regardless of readiness — the engine
  // protects the user from training on top of an injury even if they
  // technically slept well last night.
  if (injuryAffectsSession === true && !isGentleSession(session.sessionType)) {
    const adapted = {
      ...session,
      sessionType: 'mobility' as SessionType,
      originalSessionType: session.sessionType,
      intensityDownshiftPct: 0.5,
      adaptationReason: 'injury_safe_swap' as AdaptationReason,
    };
    return {
      ...adapted,
      adaptationExplanation: buildExplanation('injury_safe_swap', session, {
        sessionType: adapted.sessionType,
        intensityDownshiftPct: 0.5,
      }),
    };
  }

  // Already-gentle sessions pass through unchanged. The engine should not
  // softer-than-soft a recovery run into anything else — that would
  // confuse the user.
  if (isGentleSession(session.sessionType)) {
    return {
      ...session,
      adaptationReason: 'no_change',
      adaptationExplanation: buildExplanation('no_change', session, {
        sessionType: session.sessionType,
        intensityDownshiftPct: 1.0,
      }),
    };
  }

  switch (readiness.level) {
    case 'red': {
      const recoveryType = RECOVERY_SESSION_BY_SPORT[session.sport];
      const adapted: AdaptedSession = {
        ...session,
        sessionType: recoveryType,
        originalSessionType: session.sessionType,
        intensityDownshiftPct: 0.6,
        adaptationReason: 'red_readiness',
        adaptationExplanation: '',
      };
      adapted.adaptationExplanation = buildExplanation('red_readiness', session, {
        sessionType: recoveryType,
        intensityDownshiftPct: 0.6,
      });
      return adapted;
    }
    case 'orange': {
      const adapted: AdaptedSession = {
        ...session,
        // Orange keeps the same session type but caps intensity. Iuser-visible
        // contract: the title is unchanged, only the explanation + downshift
        // pct flag the adjustment so the iOS card shows "easy day on this
        // tempo run" rather than "different workout."
        intensityDownshiftPct: 0.8,
        adaptationReason: 'orange_readiness',
        adaptationExplanation: '',
      };
      adapted.adaptationExplanation = buildExplanation('orange_readiness', session, {
        sessionType: session.sessionType,
        intensityDownshiftPct: 0.8,
      });
      return adapted;
    }
    case 'yellow':
    case 'green':
    default:
      return {
        ...session,
        adaptationReason: 'no_change',
        adaptationExplanation: buildExplanation('no_change', session, {
          sessionType: session.sessionType,
          intensityDownshiftPct: 1.0,
        }),
      };
  }
}
