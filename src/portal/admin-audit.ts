// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Request } from 'express';
import {
  extractPortalActorHint,
  getPortalAuthContext,
} from '../api/secret-guards';
import { logAudit } from '../services/audit-trail';
import { getOwnerBootstrapTarget } from '../services/user-service';
import { logger } from '../utils/logger';

export function buildPortalAdminAuditDetails(req: Request): Record<string, unknown> {
  const auth = getPortalAuthContext(req);
  const actorHint = auth?.actorHint ?? extractPortalActorHint(req);
  if (auth?.requiredScope === 'admin' && auth.matchedCredential === 'legacy') {
    logger.warn(
      {
        path: req.path,
        matchedCredential: auth.matchedCredential,
        dedicatedAdminConfigured: auth.dedicatedAdminConfigured,
      },
      'Portal admin mutation authorized without a dedicated admin token',
    );
  }

  return {
    portalCredential: auth?.matchedCredential ?? 'unknown',
    dedicatedAdminConfigured: auth?.dedicatedAdminConfigured ?? false,
    legacyFallbackUsed: auth?.usingLegacyFallback === true ? true : undefined,
    portalActorHint: actorHint,
    portalActorRequired: auth?.actorRequired === true ? true : undefined,
    portalActorAllowlistConfigured: auth?.actorAllowlistConfigured === true ? true : undefined,
    portalActorSignatureRequired: auth?.actorSignatureRequired === true ? true : undefined,
    portalActorSignatureVerified: auth?.actorSignatureVerified === true ? true : undefined,
  };
}

export function logPortalAdminMutation(
  req: Request,
  userId: number,
  resource: string,
  details?: Record<string, unknown>,
): void {
  try {
    const ownerTarget = getOwnerBootstrapTarget();
    logAudit({
      userId,
      actorId: ownerTarget?.tenantId ?? 0,
      action: 'admin_mutation',
      resource,
      details: {
        ...buildPortalAdminAuditDetails(req),
        ...(details ?? {}),
      },
      ipAddress: (req.ip || req.socket?.remoteAddress) ?? undefined,
    });
  } catch (auditErr) {
    logger.warn({ err: auditErr, resource }, 'portal admin mutation audit log failed');
  }
}
