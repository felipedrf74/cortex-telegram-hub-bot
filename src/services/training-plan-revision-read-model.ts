// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  resolveTrainingWorkoutCapability,
  type TrainingWorkoutPresentationFamily,
} from './training-workout-capability-registry';
import type { TrainingPlanRevisionResource } from './training-plan-revisions';
import { incrementTrainingGenerationCounter } from './training-generation-observability';

export const TRAINING_PLAN_REVIEW_READ_MODEL_SCHEMA = 'training-plan-review-read-model.v1' as const;

export interface TrainingPlanRevisionReviewReadModel {
  schemaVersion: typeof TRAINING_PLAN_REVIEW_READ_MODEL_SCHEMA;
  revisionId: string;
  sourceDocumentSchemaVersion: string;
  presentationMode: 'TYPED' | 'COMPATIBILITY' | 'UNKNOWN_FALLBACK';
  horizonWeeks: number | null;
  phases: Array<{
    phaseKey: string;
    phaseType: string;
    position: number;
    startWeek: number;
    endWeek: number;
    durationWeeks: number;
    purpose: string | null;
    progressionDirection: string | null;
    recoveryOrLighterPeriod: boolean | null;
    transitionExplanation: string | null;
    profileFitExplanation: string | null;
    targetWorkoutTypeDistribution: Array<{ sessionType: string; targetPerWeek: number }>;
  }>;
  weeks: Array<{
    weekNumber: number;
    phaseKey: string | null;
    workouts: Array<{
      workoutKey: string;
      sessionType: string;
      sessionTypeClassification: 'CANONICAL' | 'UNKNOWN';
      presentationFamily: TrainingWorkoutPresentationFamily;
      presentationLabel: string;
      plannedDurationMinutes: number | null;
      isStandalone: boolean;
      phaseKey: string | null;
      blocks: unknown[];
      fallbackUsed: boolean;
      newlyPrescribable: boolean;
    }>;
  }>;
}

/**
 * Maps immutable revision JSON to the review surface without fabricating phase
 * purpose/transition data for legacy rows. Unknown session identifiers remain
 * visible and generic instead of being relabeled as strength or planned work.
 */
export function buildTrainingPlanRevisionReviewReadModel(
  revision: Pick<TrainingPlanRevisionResource, 'revisionId' | 'documentSchemaVersion' | 'document'>,
): TrainingPlanRevisionReviewReadModel {
  const document = isRecord(revision.document) ? revision.document : {};
  const rawPhases = arrayValue(document.phases);
  const rawWeeks = arrayValue(document.weeks);
  const typed = revision.documentSchemaVersion === 'training-plan-revision.v2';
  const compatibility = revision.documentSchemaVersion === 'training-plan-revision.v1';
  const model: TrainingPlanRevisionReviewReadModel = {
    schemaVersion: TRAINING_PLAN_REVIEW_READ_MODEL_SCHEMA,
    revisionId: revision.revisionId,
    sourceDocumentSchemaVersion: revision.documentSchemaVersion,
    presentationMode: typed ? 'TYPED' : compatibility ? 'COMPATIBILITY' : 'UNKNOWN_FALLBACK',
    horizonWeeks: safePositiveInteger(document.horizonWeeks),
    phases: rawPhases.map(mapPhase).filter((phase): phase is NonNullable<typeof phase> => phase != null),
    weeks: rawWeeks.map(mapWeek).filter((week): week is NonNullable<typeof week> => week != null),
  };
  if (model.presentationMode === 'UNKNOWN_FALLBACK'
      || model.weeks.some((week) => week.workouts.some((workout) => workout.fallbackUsed))) {
    incrementTrainingGenerationCounter('typed_read_model_fallback_total');
  }
  return model;
}

function mapPhase(value: unknown): TrainingPlanRevisionReviewReadModel['phases'][number] | null {
  if (!isRecord(value)) return null;
  const phaseKey = stringValue(value.phaseKey);
  const phaseType = stringValue(value.phaseType);
  const position = safePositiveInteger(value.position);
  const startWeek = safePositiveInteger(value.startWeek);
  const endWeek = safePositiveInteger(value.endWeek);
  const durationWeeks = safePositiveInteger(value.durationWeeks);
  if (!phaseKey || !phaseType || !position || !startWeek || !endWeek || !durationWeeks) return null;
  return {
    phaseKey,
    phaseType,
    position,
    startWeek,
    endWeek,
    durationWeeks,
    purpose: nullableString(value.purpose),
    progressionDirection: nullableString(value.progressionDirection),
    recoveryOrLighterPeriod: typeof value.recoveryOrLighterPeriod === 'boolean'
      ? value.recoveryOrLighterPeriod
      : null,
    transitionExplanation: nullableString(value.transitionExplanation),
    profileFitExplanation: nullableString(value.profileFitExplanation),
    targetWorkoutTypeDistribution: arrayValue(value.targetWorkoutTypeDistribution)
      .flatMap((target) => {
        if (!isRecord(target)) return [];
        const sessionType = stringValue(target.sessionType);
        const targetPerWeek = safeNonNegativeInteger(target.targetPerWeek);
        return sessionType && targetPerWeek != null ? [{ sessionType, targetPerWeek }] : [];
      }),
  };
}

function mapWeek(value: unknown): TrainingPlanRevisionReviewReadModel['weeks'][number] | null {
  if (!isRecord(value)) return null;
  const weekNumber = safePositiveInteger(value.weekNumber);
  if (!weekNumber) return null;
  const phaseKey = nullableString(value.phaseKey);
  return {
    weekNumber,
    phaseKey,
    workouts: arrayValue(value.workouts).map((workout, index) => mapWorkout(workout, index, phaseKey)),
  };
}

function mapWorkout(
  value: unknown,
  index: number,
  weekPhaseKey: string | null,
): TrainingPlanRevisionReviewReadModel['weeks'][number]['workouts'][number] {
  const raw = isRecord(value) ? value : {};
  const rawSessionType = stringValue(raw.sessionType) || 'unknown';
  const capability = resolveTrainingWorkoutCapability(rawSessionType);
  const standalone = raw.isStandalone === true;
  const phaseKey = standalone ? null : nullableString(raw.phaseKey) ?? weekPhaseKey;
  const blocks = arrayValue(raw.blocks);
  return {
    workoutKey: stringValue(raw.workoutKey) || `legacy-workout-${index + 1}`,
    sessionType: rawSessionType,
    sessionTypeClassification: capability.canonical ? 'CANONICAL' : 'UNKNOWN',
    presentationFamily: capability.presentationFamily,
    presentationLabel: capability.presentationLabel,
    plannedDurationMinutes: safeNonNegativeNumber(raw.plannedDurationMinutes),
    isStandalone: standalone,
    phaseKey,
    blocks,
    fallbackUsed: !capability.canonical || blocks.length === 0,
    newlyPrescribable: capability.canonical,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function nullableString(value: unknown): string | null {
  return stringValue(value) || null;
}

function safePositiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function safeNonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function safeNonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
