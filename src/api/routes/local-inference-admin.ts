// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, type Request, type Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { extractClientIp } from '../rate-limiter';
import { requirePortalAdminToken } from '../secret-guards';
import { sendError, sendInternalError, sendSuccess } from '../response-helpers';
import { getDb } from '../../services/database';
import {
  drainLocalInferenceWaitingQueueForRuntimeOff,
  getLocalInferenceRuntimeControl,
  LocalInferenceRuntimeControlError,
  setLocalInferenceRuntimeControl,
  type LocalInferenceMode,
} from '../../services/local-inference-runtime-control';
import { getOwnerBootstrapTarget } from '../../services/user-service';
import { insertPortalAdminMutationAuditStrict } from '../../portal/admin-audit';
import { logger } from '../../utils/logger';
import { buildLocalInferenceSummary } from '../../services/local-inference-reporting';
import { getEndUserApiErrorSnapshot, getNonAiLatencySnapshot } from '../request-timer';
import { getProvider } from '../../services/provider-registry';
import type { ProviderHealthSnapshot } from '../../services/ai-provider';

const BODY_KEYS = new Set(['mode', 'rolloutPercent', 'reason', 'evidenceReference']);

async function readOllamaModelHealth(): Promise<ProviderHealthSnapshot> {
  try {
    const provider = getProvider('ollama') as unknown as {
      getProviderHealth?: () => Promise<ProviderHealthSnapshot>;
    } | null;
    if (!provider?.getProviderHealth) {
      return {
        name: 'ollama',
        healthy: false,
        degraded: true,
        warning: 'provider_not_configured',
      };
    }
    return await provider.getProviderHealth();
  } catch (error) {
    logger.warn({ err: error }, 'Local inference model-health probe failed');
    return {
      name: 'ollama',
      healthy: false,
      degraded: true,
      warning: 'provider_health_probe_failed',
    };
  }
}

export function localInferenceAdminRoutes(): Router {
  const router = Router();
  router.use(rateLimit({
    windowMs: 60_000,
    limit: 30,
    keyGenerator: (req: Request) => `ip:${ipKeyGenerator(extractClientIp(req))}`,
    legacyHeaders: false,
    standardHeaders: true,
  }));
  router.use(requirePortalAdminToken);

  router.get('/runtime-control', (_req: Request, res: Response) => {
    try {
      sendSuccess(res, { runtimeControl: getLocalInferenceRuntimeControl() });
    } catch (error) {
      logger.error({ err: error }, 'Local inference runtime-control read failed');
      sendInternalError(res, 'Failed to read local inference runtime control');
    }
  });

  router.get('/summary', async (req: Request, res: Response) => {
    const rawHours = Number(req.query.windowHours ?? 24);
    if (!Number.isSafeInteger(rawHours) || rawHours < 1 || rawHours > 24 * 90) {
      sendError(res, 'LOCAL_REPORT_WINDOW_INVALID', 'windowHours must be an integer from 1 to 2160.', 400);
      return;
    }
    try {
      const modelHealth = await readOllamaModelHealth();
      sendSuccess(res, {
        summary: buildLocalInferenceSummary(rawHours),
        modelHealth,
      });
    } catch (error) {
      logger.error({ err: error }, 'Local inference summary read failed');
      sendInternalError(res, 'Failed to build local inference summary');
    }
  });

  router.post('/runtime-control', (req: Request, res: Response) => {
    const body = parseBody(req.body);
    if (!body) {
      sendError(
        res,
        'LOCAL_CONTROL_INVALID',
        'A closed mode, rolloutPercent, reason, and evidenceReference contract is required.',
        400,
      );
      return;
    }
    const owner = getOwnerBootstrapTarget();
    if (!owner?.tenantId) {
      sendError(res, 'OWNER_UNAVAILABLE', 'The owner bootstrap identity is unavailable.', 503);
      return;
    }
    try {
      const db = getDb();
      const before = getLocalInferenceRuntimeControl(db);
      const enteringProductionShadow = before.environment === 'production'
        && before.mode === 'off'
        && body.mode === 'shadow';
      const nonAiBaseline = enteringProductionShadow ? getNonAiLatencySnapshot() : null;
      const errorBaseline = enteringProductionShadow ? getEndUserApiErrorSnapshot() : null;
      const after = db.transaction(() => {
        const updated = setLocalInferenceRuntimeControl({
          mode: body.mode,
          rolloutPercent: body.rolloutPercent,
          reason: body.reason,
          updatedBy: owner.tenantId,
          actorType: 'owner',
          evidenceReference: body.evidenceReference,
          ...(nonAiBaseline?.p95Ms != null && nonAiBaseline.sampleCount >= 20
            ? {
              nonAiP95BaselineMs: nonAiBaseline.p95Ms,
              nonAiBaselineSampleCount: nonAiBaseline.sampleCount,
              nonAiBaselineCapturedAt: new Date().toISOString(),
            }
            : {}),
          ...(errorBaseline?.serverErrorRatePercent != null && errorBaseline.sampleCount >= 20
            ? {
              endUserErrorRateBaselinePercent: errorBaseline.serverErrorRatePercent,
              endUserErrorBaselineSampleCount: errorBaseline.sampleCount,
            }
            : {}),
        }, db, { deferInMemoryQueueDrain: true });
        insertPortalAdminMutationAuditStrict(db, req, {
          userId: owner.tenantId,
          tenantId: owner.tenantId,
          resource: 'local_inference.runtime_control',
          details: {
            environment: updated.environment,
            previousMode: before.mode,
            previousRolloutPercent: before.rolloutPercent,
            mode: updated.mode,
            rolloutPercent: updated.rolloutPercent,
            manifestVersion: updated.manifestVersion,
            activeModelId: updated.activeModelId,
            activeModelDigest: updated.activeModelDigest,
            profileVersion: updated.profileVersion,
            reason: body.reason,
            evidenceReference: body.evidenceReference,
            nonAiP95BaselineMs: updated.nonAiP95BaselineMs,
            nonAiBaselineSampleCount: updated.nonAiBaselineSampleCount,
            nonAiBaselineCapturedAt: updated.nonAiBaselineCapturedAt,
            endUserErrorRateBaselinePercent: updated.endUserErrorRateBaselinePercent,
            endUserErrorBaselineSampleCount: updated.endUserErrorBaselineSampleCount,
          },
        });
        return updated;
      }).immediate();
      if (after.mode === 'off') drainLocalInferenceWaitingQueueForRuntimeOff();
      sendSuccess(res, { runtimeControl: after });
    } catch (error) {
      if (error instanceof LocalInferenceRuntimeControlError) {
        sendError(res, error.code, error.message, error.status);
        return;
      }
      logger.error({ err: error }, 'Local inference runtime-control mutation failed');
      sendInternalError(res, 'Failed to update local inference runtime control');
    }
  });

  return router;
}

function parseBody(value: unknown): {
  mode: LocalInferenceMode;
  rolloutPercent: number;
  reason: string;
  evidenceReference: string;
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !BODY_KEYS.has(key))
      || !['off', 'shadow', 'canary', 'active'].includes(String(body.mode))
      || !Number.isSafeInteger(body.rolloutPercent)
      || typeof body.reason !== 'string'
      || !body.reason.trim()
      || body.reason.trim().length > 240
      || typeof body.evidenceReference !== 'string'
      || !body.evidenceReference.trim()
      || body.evidenceReference.trim().length > 240) return null;
  return {
    mode: body.mode as LocalInferenceMode,
    rolloutPercent: body.rolloutPercent as number,
    reason: body.reason.trim(),
    evidenceReference: body.evidenceReference.trim(),
  };
}
