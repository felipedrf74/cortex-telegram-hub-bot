// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Phase 2 — allowlisted, machine-readable clarification resolution targets.
 *
 * Each Training plan clarification issue maps to the canonical onboarding
 * profile fields that answer it, so the client can render an answerable form,
 * save through the canonical profile path, and re-preview — instead of
 * dead-ending on "Try again" (F2). Everything here is a server-side
 * allowlist: the client never invents profile targets, and unknown ids
 * resolve to null rather than guessing.
 *
 * Severity is decided by `assessTrainingPlanSpecReadiness`, never here —
 * warnings carry resolution metadata too (they are answerable refinements),
 * but only the spec's blockers gate creation.
 *
 * The option lists are deliberate constants (NOT imports from onboarding):
 * route suites fully mock the onboarding module, and a mocked-away
 * QUESTIONNAIRES would silently empty the allowlist. Drift against the real
 * questionnaire definitions is pinned by
 * __tests__/services/training-plan-clarification-registry.test.ts.
 */

import { createHash } from 'node:crypto';
import { getProfile } from './onboarding';
import { fingerprintTrainingPlanGenerationRequest } from './training-plan-generation-idempotency';
import type { TrainingPlanSpecClarificationId } from './training-plan-spec';

export interface TrainingPlanClarificationFieldTarget {
  fieldKey: string;
  answerType: 'choice' | 'number' | 'text';
  allowedValues?: readonly string[];
  min?: number;
  max?: number;
  unit?: string;
}

export interface TrainingPlanClarificationResolution {
  /** Onboarding questionnaire id — the canonical profile write path. */
  profileType: string;
  fields: readonly TrainingPlanClarificationFieldTarget[];
}

/** Mirrors QUESTIONNAIRES['triathlon-gym'] step 'equipment_access' options. */
export const GYM_EQUIPMENT_ACCESS_OPTIONS = [
  'Full commercial gym',
  'Garage gym (barbell + rack)',
  'Home gym (basic)',
  'Bodyweight only',
] as const;

export const SESSION_DURATION_MINUTES_FIELD = 'session_duration_minutes';
export const SESSION_DURATION_MIN_MINUTES = 20;
export const SESSION_DURATION_MAX_MINUTES = 180;

/**
 * Vocabulary the spec's recovery normalizers accept deterministically
 * (training-plan-spec.ts normalizeReadiness/normalizeSoreness/normalizeSleep).
 */
const RECOVERY_READINESS_VALUES = ['low', 'normal', 'high'] as const;
const RECOVERY_SORENESS_VALUES = ['low', 'medium', 'high'] as const;
const RECOVERY_SLEEP_VALUES = ['low', 'normal', 'high'] as const;

const CLARIFICATION_RESOLUTIONS: Record<
  TrainingPlanSpecClarificationId,
  TrainingPlanClarificationResolution | null
> = {
  equipment_clarification: {
    profileType: 'triathlon-gym',
    fields: [{
      fieldKey: 'equipment_access',
      answerType: 'choice',
      allowedValues: GYM_EQUIPMENT_ACCESS_OPTIONS,
    }],
  },
  session_duration_clarification: {
    profileType: 'triathlon-gym',
    fields: [{
      fieldKey: SESSION_DURATION_MINUTES_FIELD,
      answerType: 'number',
      min: SESSION_DURATION_MIN_MINUTES,
      max: SESSION_DURATION_MAX_MINUTES,
      unit: 'minutes',
    }],
  },
  // The endurance schedule derives from generated plan content, not from a
  // profile field — there is no canonical write target that answers it, so
  // this warning stays informational instead of pointing at a wrong field.
  modality_priority_clarification: null,
  recovery_feedback_clarification: {
    profileType: 'fitness',
    fields: [
      { fieldKey: 'readiness', answerType: 'choice', allowedValues: RECOVERY_READINESS_VALUES },
      { fieldKey: 'soreness', answerType: 'choice', allowedValues: RECOVERY_SORENESS_VALUES },
      { fieldKey: 'sleep_quality', answerType: 'choice', allowedValues: RECOVERY_SLEEP_VALUES },
    ],
  },
};

export function resolveTrainingPlanClarificationResolution(
  id: TrainingPlanSpecClarificationId,
): TrainingPlanClarificationResolution | null {
  return CLARIFICATION_RESOLUTIONS[id] ?? null;
}

/**
 * Read the clarified session duration off the canonical gym profile,
 * enforcing the same bounds the allowlist advertises. Out-of-bounds or
 * non-numeric answers are treated as absent (the clarification stays open)
 * rather than silently clamped into a value the athlete never chose.
 */
export function parseSessionDurationMinutesAnswer(
  gymProfile: Record<string, unknown> | null | undefined,
): number | undefined {
  const raw = gymProfile?.[SESSION_DURATION_MINUTES_FIELD];
  // Number() already applies the ECMAScript whitespace grammar. Avoid a
  // redundant trim whose removal is behaviorally indistinguishable.
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  if (rounded < SESSION_DURATION_MIN_MINUTES || rounded > SESSION_DURATION_MAX_MINUTES) {
    return undefined;
  }
  return rounded;
}

/**
 * Phase 2 hash participation: clarification answers live in PROFILES, not in
 * the request body, so without this the auto-dedupe idempotency key
 * (`auto:<requestHash>`, 90s window) would replay a pre-answer plan after the
 * athlete answers a clarification and retries the identical request. The
 * fingerprint covers exactly the allowlisted answer fields (including the
 * legacy aliases the spec inference reads) so any answer change produces a
 * fresh request hash — and unrelated profile churn does not.
 */
export function fingerprintTrainingPlanClarificationAnswers(userId: number): string {
  const gymProfile = profileRecord(getProfile(userId, 'triathlon-gym'));
  const fitnessProfile = profileRecord(getProfile(userId, 'fitness'));
  const material = {
    equipmentAccess: scalarOrNull(gymProfile?.equipment_access),
    sessionDurationMinutes: parseSessionDurationMinutesAnswer(gymProfile) ?? null,
    readiness: scalarOrNull(fitnessProfile?.readiness ?? fitnessProfile?.energy_level),
    soreness: scalarOrNull(fitnessProfile?.soreness ?? fitnessProfile?.muscle_soreness),
    sleepQuality: scalarOrNull(fitnessProfile?.sleep_quality ?? fitnessProfile?.sleepQuality),
    availableEquipment: scalarOrNull(fitnessProfile?.available_equipment),
  };
  return createHash('sha256').update(JSON.stringify(material)).digest('hex').slice(0, 32);
}

/**
 * Candidate-acceptance context is deliberately broader than the narrow
 * clarification auto-dedupe hash above. Plan generation consumes all five
 * canonical Training profiles; if any of them changes after preview, create
 * must require a fresh candidate instead of silently accepting a different
 * plan under the old review.
 *
 * Only the one-way digest crosses the REST boundary. Profile values never do.
 */
export function fingerprintTrainingPlanGenerationProfileContext(userId: number): string {
  const profileTypes = [
    'fitness',
    'triathlon-gym',
    'triathlon-running',
    'triathlon-cycling',
    'triathlon-swim',
  ] as const;
  const profiles = Object.fromEntries(profileTypes.map((profileType) => [
    profileType,
    profileRecord(getProfile(userId, profileType)),
  ]));
  return fingerprintTrainingPlanGenerationRequest({
    contract: 'training_plan_generation_profile_context.v1',
    profiles,
  });
}

function profileRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const data = record.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return record;
}

function scalarOrNull(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim().toLowerCase();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}
