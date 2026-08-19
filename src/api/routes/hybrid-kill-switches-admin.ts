// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Operator surface for the four hybrid kill switches (NH-0040). Replaces
 * env-only flips as the day-to-day operator path: every mutation carries
 * actor attribution, a reason, and lands in both the control event log and
 * the portal admin audit. Env kill switches remain the emergency fallback.
 */

import { Router, type Request, type Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { extractClientIp } from '../rate-limiter';
import { requirePortalAdminToken } from '../secret-guards';
import { sendError, sendInternalError, sendSuccess } from '../response-helpers';
import { getDb } from '../../services/database';
import {
  HYBRID_KILL_SWITCH_KEYS,
  listHybridKillSwitches,
  setHybridKillSwitch,
  type HybridKillSwitchKey,
} from '../../services/hybrid-runtime-kill-switches';
import { getOwnerBootstrapTarget } from '../../services/user-service';
import { insertPortalAdminMutationAuditStrict } from '../../portal/admin-audit';
import { logger } from '../../utils/logger';

const BODY_KEYS = new Set(['controlKey', 'engaged', 'reason']);

interface ParsedBody {
  controlKey: HybridKillSwitchKey;
  engaged: boolean;
  reason: string;
}

function parseBody(raw: unknown): ParsedBody | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!BODY_KEYS.has(key)) return null;
  }
  const controlKey = body.controlKey;
  const engaged = body.engaged;
  const reason = body.reason;
  if (typeof controlKey !== 'string'
      || !HYBRID_KILL_SWITCH_KEYS.includes(controlKey as HybridKillSwitchKey)) return null;
  if (typeof engaged !== 'boolean') return null;
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 500) return null;
  return { controlKey: controlKey as HybridKillSwitchKey, engaged, reason: reason.trim() };
}

export function hybridKillSwitchesAdminRoutes(): Router {
  const router = Router();
  router.use(rateLimit({
    windowMs: 60_000,
    limit: 30,
    keyGenerator: (req: Request) => `ip:${ipKeyGenerator(extractClientIp(req))}`,
    legacyHeaders: false,
    standardHeaders: true,
  }));
  router.use(requirePortalAdminToken);

  router.get('/', (_req: Request, res: Response) => {
    try {
      sendSuccess(res, { killSwitches: listHybridKillSwitches() });
    } catch (error) {
      logger.error({ err: error }, 'Hybrid kill-switch list failed');
      sendInternalError(res, 'Failed to read hybrid kill switches');
    }
  });

  router.post('/', (req: Request, res: Response) => {
    const body = parseBody(req.body);
    if (!body) {
      sendError(
        res,
        'HYBRID_KILL_SWITCH_INVALID',
        'A closed controlKey, engaged, and reason contract is required.',
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
      const result = setHybridKillSwitch({
        controlKey: body.controlKey,
        engaged: body.engaged,
        actorUserId: owner.tenantId,
        reason: body.reason,
      });
      if (result.kind === 'rejected') {
        sendError(res, 'HYBRID_KILL_SWITCH_REJECTED', result.reason, 400);
        return;
      }
      if (result.kind === 'updated') {
        insertPortalAdminMutationAuditStrict(getDb(), req, {
          userId: owner.tenantId,
          tenantId: owner.tenantId,
          resource: `hybrid_kill_switch.${body.controlKey}`,
          details: { engaged: body.engaged, reason: body.reason },
        });
      }
      sendSuccess(res, { killSwitch: result.state, changed: result.kind === 'updated' });
    } catch (error) {
      logger.error({ err: error }, 'Hybrid kill-switch mutation failed');
      sendInternalError(res, 'Failed to update hybrid kill switch');
    }
  });

  return router;
}
