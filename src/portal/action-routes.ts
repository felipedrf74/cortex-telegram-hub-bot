// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Express, Request, Response } from 'express';
import { requirePortalAdminToken } from '../api/secret-guards';
import { logAudit } from '../services/audit-trail';
import { getOwnerBootstrapTarget } from '../services/user-service';
import { buildPortalAdminAuditDetails } from './admin-audit';
import {
  VALID_PORTAL_ACTIONS,
  handlePortalAction,
  isPortalActionRateLimited,
  recordPortalAction,
} from './actions';
import { sendPortalInternalError } from './http';
import { clearPortalSnapshotCache } from './snapshot-cache';

function auditPortalAction(req: Request, name: string): void {
  try {
    const ownerTarget = getOwnerBootstrapTarget();
    if (ownerTarget) {
      // Portal actions run as the owner tenant but are dispatched by an
      // operator. Capture the operator's auth context in the audit details
      // (credential kind, actor hint, signature verification state) so the
      // audit trail can attribute the action to the human who triggered it
      // — not just the owner the bot impersonates.
      logAudit({
        userId: ownerTarget.tenantId,
        actorId: ownerTarget.tenantId,
        action: 'access',
        resource: `portal.action.${name}`,
        details: buildPortalAdminAuditDetails(req),
        ipAddress: (req.ip || req.socket?.remoteAddress) ?? undefined,
      });
    }
  } catch {
    // Audit trail is non-critical for action execution. Fail closed at the
    // action/auth layer, not because optional audit persistence is unavailable.
  }
}

export function registerPortalActionRoutes(app: Express): void {
  app.post('/api/action/:name', requirePortalAdminToken, async (req: Request, res: Response) => {
    const name = String(req.params.name);

    if (!VALID_PORTAL_ACTIONS.has(name)) {
      res.status(400).json({ ok: false, message: `Unknown action: ${name}` });
      return;
    }

    if (isPortalActionRateLimited(name)) {
      res.status(429).json({ ok: false, message: 'Too many requests — wait 30s' });
      return;
    }

    try {
      const result = await handlePortalAction(name);
      recordPortalAction(name);
      clearPortalSnapshotCache();
      auditPortalAction(req, name);
      res.json(result);
    } catch (err) {
      sendPortalInternalError(res, err, 'Action failed', 'Portal: action failed');
    }
  });
}
