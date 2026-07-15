// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, type Request, type Response } from 'express';
import { requirePortalAdminToken } from '../secret-guards';
import { sendError, sendInternalError, sendSuccess } from '../response-helpers';
import {
  buildProductLearningObservabilityReadModel,
} from '../../services/product-learning-observability';
import {
  recordPhysicalDeviceLearningObservation,
  type PhysicalDeviceLearningObservation,
} from '../../services/training-learning-producers';
import { logger } from '../../utils/logger';

export interface ProductLearningAdminRouteDependencies {
  buildSummary?: typeof buildProductLearningObservabilityReadModel;
  recordPhysicalDevice?: typeof recordPhysicalDeviceLearningObservation;
}

const PHYSICAL_DEVICE_BODY_KEYS = new Set([
  'observationId',
  'tenantId',
  'userId',
  'buildNumber',
  'checkCode',
  'result',
  'evidenceReference',
  'observedAt',
]);

export function productLearningAdminRoutes(
  dependencies: ProductLearningAdminRouteDependencies = {},
): Router {
  const router = Router();
  const buildSummary = dependencies.buildSummary ?? buildProductLearningObservabilityReadModel;
  const recordPhysicalDevice = dependencies.recordPhysicalDevice ?? recordPhysicalDeviceLearningObservation;
  router.use(requirePortalAdminToken);

  router.get('/summary', (req: Request, res: Response) => {
    const tenantId = optionalPositiveInt(req.query.tenantId);
    if (req.query.tenantId != null && tenantId == null) {
      sendError(res, 'BAD_REQUEST', 'tenantId must be a positive integer when provided.', 400);
      return;
    }
    try {
      sendSuccess(res, buildSummary({ ...(tenantId ? { tenantId } : {}) }));
    } catch (error) {
      logger.error({ err: error, tenantScoped: tenantId != null }, 'Product learning summary failed');
      sendInternalError(res, 'Failed to build product learning summary');
    }
  });

  router.post('/physical-device-observations', (req: Request, res: Response) => {
    const observation = parsePhysicalDeviceObservation(req.body);
    if (!observation) {
      sendError(
        res,
        'INVALID_PHYSICAL_DEVICE_OBSERVATION',
        'A closed, redacted TestFlight observation contract is required.',
        400,
      );
      return;
    }
    try {
      const learningCase = recordPhysicalDevice(observation);
      sendSuccess(res, {
        observation: {
          caseId: learningCase.id,
          lifecycle: learningCase.lifecycle,
          kind: learningCase.redactedInput.kind,
          outcomeCode: learningCase.redactedInput.outcomeCode,
          observedAt: learningCase.observedAt,
          expiresAt: learningCase.expiresAt,
        },
      }, { status: 201 });
    } catch (error) {
      logger.warn(
        { err: error, tenantId: observation.tenantId, userId: observation.userId },
        'Physical-device learning observation rejected',
      );
      sendError(
        res,
        'INVALID_PHYSICAL_DEVICE_OBSERVATION',
        'The physical-device observation did not satisfy the governed contract.',
        400,
      );
    }
  });

  return router;
}

function parsePhysicalDeviceObservation(value: unknown): PhysicalDeviceLearningObservation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !PHYSICAL_DEVICE_BODY_KEYS.has(key))) return null;
  if (typeof body.observationId !== 'string'
      || !Number.isInteger(body.tenantId)
      || !Number.isInteger(body.userId)
      || typeof body.buildNumber !== 'string'
      || typeof body.checkCode !== 'string'
      || typeof body.result !== 'string'
      || typeof body.evidenceReference !== 'string'
      || typeof body.observedAt !== 'string') return null;
  return body as unknown as PhysicalDeviceLearningObservation;
}

function optionalPositiveInt(value: unknown): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
