// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Audit Trail self-service route — GET /api/v1/audit-trail/me
 *
 * Audit P0-10: GDPR Article 15 ("right of access by the data subject")
 * requires that users be able to obtain confirmation of whether their
 * personal data is being processed and, if so, access to that data plus
 * the audit trail of how it has been used.
 *
 * This endpoint returns the authenticated user's own audit_trail entries
 * — never anyone else's. The portal admin endpoint at /api/audit-trail
 * can return rows for any user but is gated by the static portal token,
 * not the iOS JWT.
 *
 * Pagination is offset+limit. Default limit 50, max 200, to keep mobile
 * round-trips small. Decrypt-level entries (which fire on every Garmin
 * cron etc.) are excluded by default — set ?includeSystem=1 to see them.
 */

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { getDb } from '../../services/database';
import { sendSuccess, sendError, sendInternalError, asyncHandler } from '../response-helpers';
import { ensureValidTenantRouteScope } from '../tenant-route-scope';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface AuditRowOut {
  id: number;
  ts: string;
  action: string;
  resource: string;
  details: unknown;
  ipAddress: string | null;
}

export function auditTrailRoutes(): Router {
  const router = Router();

  router.use((req, res, next) => {
    const { userId } = req as AuthenticatedRequest;
    if (!ensureValidTenantRouteScope(res as Response, userId, 'audit_trail_route', {
      method: req.method,
      path: req.path,
    })) return;
    next();
  });

  /**
   * GET /api/v1/audit-trail/me
   * Query: limit (default 50, max 200), offset (default 0),
   *        includeSystem (default 0 — set to 1 to include 'decrypt' entries)
   */
  router.get('/me', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;

    const limitRaw = parseInt(String(req.query.limit ?? DEFAULT_LIMIT), 10);
    const limit = Math.min(MAX_LIMIT, Math.max(1, isNaN(limitRaw) ? DEFAULT_LIMIT : limitRaw));
    const offsetRaw = parseInt(String(req.query.offset ?? 0), 10);
    const offset = Math.max(0, isNaN(offsetRaw) ? 0 : offsetRaw);
    const includeSystem = req.query.includeSystem === '1' || req.query.includeSystem === 'true';

    try {
      const db = getDb();

      // System actions ('decrypt') are noisy because they fire on every
      // Garmin cron — hide them by default. Explicit user actions (export,
      // delete, register, refresh, portal admin actions) are always shown.
      const whereClause = includeSystem
        ? 'WHERE user_id = ?'
        : "WHERE user_id = ? AND action != 'decrypt'";

      const rows = db.prepare(`
        SELECT id, ts, action, resource, details, ip_address as ipAddress
        FROM audit_trail
        ${whereClause}
        ORDER BY ts DESC
        LIMIT ? OFFSET ?
      `).all(userId, limit, offset) as Array<{
        id: number;
        ts: string;
        action: string;
        resource: string;
        details: string | null;
        ipAddress: string | null;
      }>;

      const totalRow = db.prepare(`
        SELECT COUNT(*) as n FROM audit_trail ${whereClause}
      `).get(userId) as { n: number };

      const formatted: AuditRowOut[] = rows.map((r) => ({
        id: r.id,
        ts: r.ts,
        action: r.action,
        resource: r.resource,
        details: r.details ? safeParseJson(r.details) : null,
        ipAddress: r.ipAddress,
      }));

      sendSuccess(res, {
        entries: formatted,
        pagination: {
          total: totalRow.n,
          limit,
          offset,
          hasMore: offset + formatted.length < totalRow.n,
        },
        includeSystem,
      });
    } catch (err: any) {
      logger.error({ err, userId }, 'Audit trail self-service query failed');
      sendInternalError(res, 'Failed to fetch audit trail');
    }
  }));

  return router;
}

function safeParseJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}
