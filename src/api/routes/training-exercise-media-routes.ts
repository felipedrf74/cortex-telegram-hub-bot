// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Request, Response, Router } from 'express';
import type { AuthenticatedRequest } from '../auth-middleware';
import { sendError, sendSuccess } from '../response-helpers';
import {
  getEffectiveEntitlement,
  isSkillAllowedByEntitlement,
  type UserEntitlement,
} from '../../services/entitlement';
import {
  lookupTrainingExerciseMedia,
  type TrainingExerciseMediaBatchDto,
} from '../../services/training-exercise-media';
import {
  isTrainingExerciseMediaV1Enabled,
  type RuntimeFlagScope,
} from '../../services/runtime-flags';
import type { TrainingExerciseMediaLocale } from '../../services/training-exercise-media-manifest';
import { recordTrainingMediaLookupObservations } from '../../services/training-learning-producers';
import { logger } from '../../utils/logger';

const MAX_EXERCISE_IDS = 50;
const SAFE_EXERCISE_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/;

type MediaRequest = AuthenticatedRequest & { entitlement?: UserEntitlement };

export interface TrainingExerciseMediaRouteDependencies {
  env?: NodeJS.ProcessEnv;
  lookup?: typeof lookupTrainingExerciseMedia;
  resolveEntitlement?: typeof getEffectiveEntitlement;
  recordLearning?: typeof recordTrainingMediaLookupObservations;
  scheduleLearning?: (task: () => void) => void;
}

/**
 * Registers the dark-by-default exercise-media read surface. These routes are
 * mounted inside the authenticated Training router, but retain their own
 * entitlement and tenant checks so future remounting cannot accidentally make
 * the content public. While the feature is disabled, the route returns the
 * hidden 404 before entitlement resolution or any exercise-media catalog
 * lookup. The global authenticated-router middleware may still perform its
 * normal session/user activity work before this feature-specific boundary.
 */
export function registerTrainingExerciseMediaRoutes(
  router: Router,
  dependencies: TrainingExerciseMediaRouteDependencies = {},
): void {
  const lookup = dependencies.lookup ?? lookupTrainingExerciseMedia;
  const recordLearning = dependencies.recordLearning ?? recordTrainingMediaLookupObservations;
  const scheduleLearning = dependencies.scheduleLearning ?? scheduleWithImmediate;

  router.get('/exercises', (req: Request, res: Response) => {
    const scope = requireMediaRouteScope(
      req as MediaRequest, res, dependencies.env, dependencies.resolveEntitlement,
    );
    if (!scope) return;
    const parsed = parseBatchExerciseIds(req.query.ids);
    if (!parsed.ok) {
      sendError(res, parsed.code, parsed.message, 400, parsed.details);
      return;
    }
    serveLookup(
      req as MediaRequest,
      res,
      scope,
      parsed.exerciseIds,
      resolveLocale(req),
      lookup,
      recordLearning,
      scheduleLearning,
    );
  });

  router.get('/exercises/:exerciseId', (req: Request, res: Response) => {
    const scope = requireMediaRouteScope(
      req as MediaRequest, res, dependencies.env, dependencies.resolveEntitlement,
    );
    if (!scope) return;
    const rawExerciseId = typeof req.params.exerciseId === 'string' ? req.params.exerciseId.trim() : '';
    if (!SAFE_EXERCISE_ID.test(rawExerciseId)) {
      sendError(res, 'INVALID_EXERCISE_ID', 'Exercise identifier is invalid.', 400);
      return;
    }
    serveLookup(
      req as MediaRequest,
      res,
      scope,
      [rawExerciseId],
      resolveLocale(req),
      lookup,
      recordLearning,
      scheduleLearning,
      true,
    );
  });
}

function requireMediaRouteScope(
  req: MediaRequest,
  res: Response,
  env: NodeJS.ProcessEnv = process.env,
  resolveEntitlement: typeof getEffectiveEntitlement = getEffectiveEntitlement,
): Required<RuntimeFlagScope> | null {
  const userId = req.userId;
  const tenantId = req.tenantId;
  const scope = { userId, tenantId };

  // Flag check is first by design: no entitlement or catalog database read is
  // allowed when the surface is dark.
  if (!isTrainingExerciseMediaV1Enabled(env, scope)) {
    hiddenNotFound(res);
    return null;
  }
  if (!Number.isInteger(userId) || userId <= 0 || !Number.isInteger(tenantId)
    || tenantId <= 0 || userId !== tenantId) {
    hiddenNotFound(res);
    return null;
  }
  let entitlement: UserEntitlement;
  let entitled: boolean;
  try {
    entitlement = req.entitlement ?? resolveEntitlement(userId);
    entitled = entitlement.userId === userId && isSkillAllowedByEntitlement(entitlement, 'training');
  } catch (error) {
    logger.warn(
      { err: error, userId, tenantId },
      'Training exercise media entitlement lookup failed closed',
    );
    hiddenNotFound(res);
    return null;
  }
  if (!entitled) {
    hiddenNotFound(res);
    return null;
  }
  return { userId, tenantId };
}

function serveLookup(
  req: MediaRequest,
  res: Response,
  scope: Required<RuntimeFlagScope>,
  exerciseIds: string[],
  locale: TrainingExerciseMediaLocale,
  lookup: typeof lookupTrainingExerciseMedia,
  recordLearning: typeof recordTrainingMediaLookupObservations,
  scheduleLearning: (task: () => void) => void,
  single = false,
): void {
  let result: TrainingExerciseMediaBatchDto | null;
  try {
    result = lookup(Number(scope.tenantId), Number(scope.userId), exerciseIds, locale);
  } catch (error) {
    logger.warn(
      { err: error, userId: scope.userId, tenantId: scope.tenantId },
      'Training exercise media lookup failed closed',
    );
    hiddenNotFound(res);
    return;
  }
  if (!result) {
    hiddenNotFound(res);
    return;
  }

  scheduleMediaLearningObservation(scope, result, recordLearning, scheduleLearning);

  if (single) {
    const item = result.items[0];
    if (!item || item.kind === 'UNAVAILABLE') {
      sendError(
        res,
        'TRAINING_EXERCISE_MEDIA_NOT_FOUND',
        'Reviewed exercise media is not available for this identifier.',
        404,
        {
          exerciseId: item?.rawIdentifier ?? exerciseIds[0],
          reason: item?.reason ?? 'MEDIA_UNAVAILABLE',
          textFallbackRequired: true,
        },
      );
      return;
    }
    setMediaResponseHeaders(res, result.eTag);
    if (ifNoneMatch(req, result.eTag)) {
      res.status(304).end();
      return;
    }
    const { eTag: _eTag, ...metadata } = result;
    sendSuccess(res, { ...metadata, exercise: item });
    return;
  }

  setMediaResponseHeaders(res, result.eTag);
  if (ifNoneMatch(req, result.eTag)) {
    res.status(304).end();
    return;
  }
  const { eTag: _eTag, ...payload } = result;
  sendSuccess(res, payload);
}

function scheduleWithImmediate(task: () => void): void {
  setImmediate(task);
}

function scheduleMediaLearningObservation(
  scope: Required<RuntimeFlagScope>,
  result: TrainingExerciseMediaBatchDto,
  recordLearning: typeof recordTrainingMediaLookupObservations,
  scheduleLearning: (task: () => void) => void,
): void {
  const task = (): void => {
    try {
      recordLearning({
        scope: { tenantId: Number(scope.tenantId), userId: Number(scope.userId) },
        result,
      });
    } catch (error) {
      // Learning telemetry must not turn an otherwise valid governed read into
      // a failed product request. The producer is retry-safe and can be
      // replayed from an equivalent later lookup.
      logger.warn(
        { err: error, userId: scope.userId, tenantId: scope.tenantId },
        'Training exercise media learning observation failed',
      );
    }
  };
  try {
    scheduleLearning(task);
  } catch (error) {
    logger.warn(
      { err: error, userId: scope.userId, tenantId: scope.tenantId },
      'Training exercise media learning observation scheduling failed',
    );
  }
}

function parseBatchExerciseIds(raw: unknown):
  | { ok: true; exerciseIds: string[] }
  | { ok: false; code: string; message: string; details?: Record<string, unknown> } {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, code: 'EXERCISE_IDS_REQUIRED', message: 'A comma-separated ids query is required.' };
  }
  const exerciseIds = raw.split(',').map((value) => value.trim());
  if (exerciseIds.length > MAX_EXERCISE_IDS) {
    return {
      ok: false,
      code: 'EXERCISE_ID_LIMIT_EXCEEDED',
      message: `At most ${MAX_EXERCISE_IDS} exercise identifiers may be requested.`,
      details: { maximum: MAX_EXERCISE_IDS },
    };
  }
  const invalid = exerciseIds.find((exerciseId) => !SAFE_EXERCISE_ID.test(exerciseId));
  if (invalid != null) {
    return { ok: false, code: 'INVALID_EXERCISE_ID', message: 'One or more exercise identifiers are invalid.' };
  }
  return { ok: true, exerciseIds };
}

export function resolveTrainingExerciseMediaLocale(req: Pick<Request, 'header'>): TrainingExerciseMediaLocale {
  const raw = req.header?.('x-language') ?? req.header?.('accept-language') ?? '';
  const primary = raw.split(',')[0]?.split(';')[0]?.trim().replace('_', '-').toLowerCase();
  if (primary === 'pt-pt' || primary?.startsWith('pt-pt-')) return 'pt-PT';
  if (primary === 'pt-br' || primary?.startsWith('pt-br-')) return 'pt-BR';
  return 'en-US';
}

function resolveLocale(req: Request): TrainingExerciseMediaLocale {
  return resolveTrainingExerciseMediaLocale(req);
}

function setMediaResponseHeaders(res: Response, eTag: string): void {
  res.setHeader('ETag', `W/${eTag}`);
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  res.setHeader('Vary', 'Authorization, X-Language, Accept-Language');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function ifNoneMatch(req: Request, eTag: string): boolean {
  const raw = req.header?.('if-none-match');
  if (!raw) return false;

  // This governed route only accepts a concrete validator as proof that the
  // client already has this exact availability payload. The wildcard's
  // resource-existence semantics do not prove that, and accepting it could
  // suppress a fresh batch response after a takedown makes an item
  // unavailable. The same rule applies to single-item responses; unavailable
  // singles are still resolved to their explicit 404 before this check.
  return raw.split(',').map((value) => value.trim()).some((candidate) => (
    candidate === eTag || candidate === `W/${eTag}`
  ));
}

function hiddenNotFound(res: Response): void {
  sendError(res, 'NOT_FOUND', 'Route not found.', 404);
}
