// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Operator surface for audited administrative AI credit grants (plan §2,
 * QA5 P1-2). `grantAdminAiCredits` is the plan's incident-recovery override —
 * support restoring credits after a failed operation, or unblocking a paid
 * user during a provisioning incident — but it had no route, so the override
 * did not exist in practice.
 *
 * Contract mirrors the kill-switch admin surface: portal-admin auth, closed
 * body, owner-derived actor attribution, portal audit row on every mutation.
 * The ledger enforces the money rules (1..5,000 credits, 1..90 days,
 * non-empty reason, idempotent grantId) and this route never relaxes them.
 */

import { Router, type Request, type Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { extractClientIp } from '../rate-limiter';
import { requirePortalAdminToken } from '../secret-guards';
import { sendError, sendInternalError, sendSuccess } from '../response-helpers';
import { getDb } from '../../services/database';
import { grantAdminAiCredits } from '../../services/ai-credit-ledger';
import { getOwnerBootstrapTarget } from '../../services/user-service';
import { insertPortalAdminMutationAuditStrict } from '../../portal/admin-audit';
import { logger } from '../../utils/logger';

const BODY_KEYS = new Set(['userId', 'grantId', 'credits', 'expiryDays', 'reason']);
const MAX_GRANT_ID_LENGTH = 200;
const MAX_REASON_LENGTH = 500;

interface ParsedBody {
  userId: number;
  grantId: string;
  credits: number;
  expiryDays: number;
  reason: string;
}

function parseBody(raw: unknown): ParsedBody | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!BODY_KEYS.has(key)) return null;
  }
  const { userId, grantId, credits, expiryDays, reason } = body;
  if (!Number.isSafeInteger(userId) || (userId as number) <= 0) return null;
  if (typeof grantId !== 'string' || !grantId.trim() || grantId.length > MAX_GRANT_ID_LENGTH) return null;
  if (!Number.isInteger(credits) || (credits as number) <= 0) return null;
  if (!Number.isInteger(expiryDays) || (expiryDays as number) <= 0) return null;
  if (typeof reason !== 'string' || !reason.trim() || reason.length > MAX_REASON_LENGTH) return null;
  return {
    userId: userId as number,
    grantId: grantId.trim(),
    credits: credits as number,
    expiryDays: expiryDays as number,
    reason: reason.trim(),
  };
}

export function aiCreditGrantsAdminRoutes(): Router {
  const router = Router();
  router.use(rateLimit({
    windowMs: 60_000,
    limit: 30,
    keyGenerator: (req: Request) => `ip:${ipKeyGenerator(extractClientIp(req))}`,
    legacyHeaders: false,
    standardHeaders: true,
  }));
  router.use(requirePortalAdminToken);

  router.post('/', (req: Request, res: Response) => {
    const body = parseBody(req.body);
    if (!body) {
      sendError(
        res,
        'AI_CREDIT_GRANT_INVALID',
        'A closed userId, grantId, credits, expiryDays, and reason contract is required.',
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
      const result = grantAdminAiCredits({
        userId: body.userId,
        grantId: body.grantId,
        credits: body.credits,
        expiryDays: body.expiryDays,
        actorUserId: owner.tenantId,
        reason: body.reason,
      });
      if (result.kind === 'rejected') {
        sendError(res, 'AI_CREDIT_GRANT_REJECTED', result.reason, 400);
        return;
      }
      if (result.kind === 'granted') {
        insertPortalAdminMutationAuditStrict(getDb(), req, {
          userId: owner.tenantId,
          tenantId: owner.tenantId,
          resource: `ai_credit_admin_grant.${body.grantId}`,
          details: {
            targetUserId: body.userId,
            credits: body.credits,
            expiryDays: body.expiryDays,
            reason: body.reason,
          },
        });
      }
      sendSuccess(res, {
        lot: result.lot,
        granted: result.kind === 'granted',
        replay: result.kind === 'already_granted',
      });
    } catch (error) {
      logger.error({ err: error }, 'AI credit admin grant failed');
      sendInternalError(res, 'Failed to grant AI credits');
    }
  });

  return router;
}
