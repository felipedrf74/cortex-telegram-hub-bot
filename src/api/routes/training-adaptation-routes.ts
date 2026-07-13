// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Request, Response, Router } from 'express';
import type { AuthenticatedRequest } from '../auth-middleware';
import { sendError, sendInternalError, sendSuccess } from '../response-helpers';
import { requireTenantIdParam } from '../../services/tenant-scope';
import {
  getTrainingAdaptationOptionEnvelope,
  previewTrainingAdaptation,
  requestTrainingAdaptationReview,
  selectTrainingAdaptationOption,
} from '../../services/training-adaptation-proposals';
import type {
  TrainingAdaptationExplicitInput,
  TrainingAdaptationScope,
  TrainingAdaptationTarget,
} from '../../services/training-adaptation-types';
import type { DayOfWeek } from '../../services/coach-kernel/types';
import { TrainingPlanRevisionError } from '../../services/training-plan-revision-errors';
import { logger } from '../../utils/logger';

export function registerTrainingAdaptationRoutes(router: Router): void {
  router.post('/adaptations/preview', (req, res: Response) => {
    const scope = resolveScope(req as unknown as AuthenticatedRequest, res);
    if (!scope) return;
    const body = isRecord(req.body) ? req.body : {};
    try {
      const preview = previewTrainingAdaptation({
        scope,
        eventId: stringValue(body.eventId),
        currentRevisionId: stringValue(body.currentRevisionId),
        expectedContentHash: stringValue(body.expectedContentHash),
        contextVersion: stringValue(body.contextVersion),
        idempotencyKey: req.header('idempotency-key') ?? '',
        adaptationScope: body.requestedScope as TrainingAdaptationScope,
        target: targetValue(body.target),
        explicitInput: explicitInput(body),
      });
      sendSuccess(res, preview, { status: 200 });
    } catch (error) {
      sendAdaptationError(res, error, 'preview');
    }
  });

  router.post('/adaptations/:adaptationId/request-review', async (req: Request, res: Response) => {
    const scope = resolveScope(req as unknown as AuthenticatedRequest, res);
    if (!scope) return;
    const body = isRecord(req.body) ? req.body : {};
    try {
      const review = await requestTrainingAdaptationReview({
        scope,
        adaptationId: stringValue(req.params.adaptationId),
        optionId: stringValue(body.optionId),
        expectedCurrentRevisionId: stringValue(body.expectedCurrentRevisionId),
        expectedContextVersion: stringValue(body.expectedContextVersion),
        idempotencyKey: req.header('idempotency-key') ?? '',
      });
      sendSuccess(res, review, { status: 201 });
    } catch (error) {
      sendAdaptationError(res, error, 'request review');
    }
  });

  router.post('/adaptations/:adaptationId/select-option', (req: Request, res: Response) => {
    const scope = resolveScope(req as unknown as AuthenticatedRequest, res);
    if (!scope) return;
    const body = isRecord(req.body) ? req.body : {};
    try {
      const selection = selectTrainingAdaptationOption({
        scope,
        adaptationId: stringValue(req.params.adaptationId),
        optionId: stringValue(body.optionId),
        expectedCurrentRevisionId: stringValue(body.expectedCurrentRevisionId),
        expectedContextVersion: stringValue(body.expectedContextVersion),
        idempotencyKey: req.header('idempotency-key') ?? '',
      });
      sendSuccess(res, selection, { status: 200 });
    } catch (error) {
      sendAdaptationError(res, error, 'select option');
    }
  });

  router.get('/adaptations/:adaptationId', (req, res: Response) => {
    const scope = resolveScope(req as unknown as AuthenticatedRequest, res);
    if (!scope) return;
    try {
      const envelope = getTrainingAdaptationOptionEnvelope(scope, stringValue(req.params.adaptationId));
      if (!envelope) {
        sendError(res, 'TRAINING_ADAPTATION_NOT_FOUND', 'Training adaptation proposal not found.', 404);
        return;
      }
      sendSuccess(res, envelope);
    } catch (error) {
      sendAdaptationError(res, error, 'read');
    }
  });
}

function explicitInput(body: Record<string, unknown>): TrainingAdaptationExplicitInput {
  const value = isRecord(body.input) ? body.input : {};
  const trigger = stringValue(body.trigger);
  if (trigger === 'BUSY_DAY') {
    return {
      kind: 'BUSY_DAY',
      availableMinutes: numberValue(value.availableMinutes),
      ...optionalNumberField(value, 'secondWindowMinutes'),
      ...optionalNumberField(value, 'secondWindowGapMinutes'),
      ...optionalDayField(value, 'rescheduleDay'),
      ...optionalStringField(value, 'authoritativeScheduleVersion'),
    };
  }
  if (trigger === 'TIRED_DAY') {
    const level = stringValue(value.tirednessLevel);
    return {
      kind: 'TIRED_DAY',
      selfReport: 'MORE_TIRED_THAN_EXPECTED',
      reportedLevel: level as 'SLIGHTLY' | 'MORE_THAN_EXPECTED' | 'VERY_TIRED',
      ...optionalStringListField(value, 'availableEquipmentIds'),
      ...optionalStringListField(value, 'exclusions'),
      ...optionalDayField(value, 'rescheduleDay'),
      ...optionalStringField(value, 'authoritativeScheduleVersion'),
    };
  }
  if (trigger === 'EXERCISE_SUBSTITUTION') {
    const reason = stringValue(value.substitutionReason);
    return {
      kind: 'SUBSTITUTION',
      reason: (reason === 'EQUIPMENT_UNAVAILABLE' ? 'EQUIPMENT'
        : reason === 'USER_EXCLUSION' ? 'EXCLUSION' : reason) as 'EQUIPMENT' | 'EXCLUSION',
      originalExerciseId: stringValue(value.originalExerciseId),
      unavailableEquipmentIds: stringList(value.unavailableEquipmentIds),
      exclusions: stringList(value.exclusionIds),
      proposedExerciseId: undefined,
    };
  }
  if (trigger === 'REFLOW') return { kind: 'REFLOW' };
  return {} as TrainingAdaptationExplicitInput;
}

function targetValue(value: unknown): TrainingAdaptationTarget {
  const target = isRecord(value) ? value : {};
  return {
    workoutKey: stringValue(target.workoutKey),
    sessionId: optionalString(target.sessionId),
    blockId: optionalString(target.blockId),
    exerciseId: optionalString(target.exerciseId),
  };
}

function resolveScope(
  req: AuthenticatedRequest,
  res: Response,
): { userId: number; tenantId: number } | null {
  try {
    return { userId: req.userId, tenantId: requireTenantIdParam(req.tenantId, 'training.adaptation') };
  } catch {
    sendError(res, 'TENANT_SCOPE_REQUIRED', 'Training adaptations require a validated tenant scope.', 400);
    return null;
  }
}

function sendAdaptationError(res: Response, error: unknown, operation: string): void {
  if (error instanceof TrainingPlanRevisionError) {
    sendError(res, error.code, error.message, error.statusCode);
    return;
  }
  if (error instanceof Error && error.message.startsWith('TRAINING_')) {
    const [code] = error.message.split(':');
    sendError(res, code, 'The adaptation request is invalid.', 400);
    return;
  }
  logger.error({ err: error, operation }, 'Training adaptation route failed');
  sendInternalError(res, `Failed to ${operation} training adaptation`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' ? value : Number.NaN;
}

function stringList(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)
      || value.some((entry) => typeof entry !== 'string')) {
    throw new Error('TRAINING_ADAPTATION_STRING_LIST_INVALID');
  }
  return value;
}

function optionalNumberField<K extends string>(
  source: Record<string, unknown>,
  key: K,
): Partial<Record<K, number>> {
  if (!(key in source) || source[key] == null) return {};
  if (typeof source[key] !== 'number' || !Number.isFinite(source[key])) {
    throw new Error('TRAINING_ADAPTATION_OPTIONAL_NUMBER_INVALID');
  }
  return { [key]: source[key] } as Partial<Record<K, number>>;
}

function optionalStringField<K extends string>(
  source: Record<string, unknown>,
  key: K,
): Partial<Record<K, string>> {
  if (!(key in source) || source[key] == null) return {};
  if (typeof source[key] !== 'string' || !source[key].trim()) {
    throw new Error('TRAINING_ADAPTATION_OPTIONAL_STRING_INVALID');
  }
  return { [key]: source[key] } as Partial<Record<K, string>>;
}

function optionalStringListField<K extends string>(
  source: Record<string, unknown>,
  key: K,
): Partial<Record<K, string[]>> {
  if (!(key in source) || source[key] == null) return {};
  return { [key]: stringList(source[key]) } as Partial<Record<K, string[]>>;
}

function optionalDayField<K extends string>(
  source: Record<string, unknown>,
  key: K,
): Partial<Record<K, DayOfWeek>> {
  if (!(key in source) || source[key] == null) return {};
  const day = source[key];
  if (typeof day !== 'string' || !isDayOfWeek(day)) {
    throw new Error('TRAINING_ADAPTATION_RESCHEDULE_DAY_INVALID');
  }
  return { [key]: day } as Partial<Record<K, DayOfWeek>>;
}

function isDayOfWeek(value: string): value is DayOfWeek {
  return ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].includes(value);
}
