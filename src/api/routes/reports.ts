// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { sendSuccess, sendError, asyncHandler } from '../response-helpers';
import { isValidTenantUserId, recordTenantScopeAnomaly } from '../../services/tenant-scope-observability';
import {
  getLatestByType,
  getRecentReports,
  getReportById,
  getUnreadReportCount,
  markReportRead,
  type ReportType,
} from '../../services/report-document-store';

/**
 * Report Documents — iOS API routes.
 *
 * Reports (morning briefing, evening summary, weekly review, coach briefing)
 * are durable structured documents stored in the `report_documents` table.
 * iOS fetches them on launch to catch up on missed reports, and reads them
 * in a native report detail view.
 */
export function reportRoutes(): Router {
  const router = Router();

  function ensureValidReportsRouteScope(
    res: Response,
    userId: number | undefined,
    operation: string,
    details?: Record<string, unknown>,
  ): userId is number {
    if (isValidTenantUserId(userId)) return true;
    recordTenantScopeAnomaly({
      layer: 'delivery',
      operation,
      reason: 'invalid_user_scope',
      userId: typeof userId === 'number' ? userId : null,
      details,
    });
    sendError(res, 'UNAUTHORIZED', 'Invalid authenticated user scope', 401);
    return false;
  }

  /**
   * GET /api/v1/reports
   *
   * List recent reports for the authenticated user.
   * Query: ?type=morning_briefing&limit=20
   */
  router.get('/', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidReportsRouteScope(res, userId, 'reports_route_list')) return;
    const type = req.query.type as ReportType | undefined;
    const limit = parseInt(String(req.query.limit || '20'), 10);

    const reports = getRecentReports(userId, { type, limit });
    const unreadCount = getUnreadReportCount(userId);

    sendSuccess(res, {
      unreadCount,
      count: reports.length,
      reports: reports.map((r: any) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        summary: r.summary,
        status: r.status,
        createdAt: r.createdAt,
      })),
    });
  }));

  /**
   * GET /api/v1/reports/latest
   *
   * Get the most recent report of a given type.
   * Query: ?type=morning_briefing (required)
   */
  router.get('/latest', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidReportsRouteScope(res, userId, 'reports_route_latest', { type: req.query.type ?? null })) return;
    const type = req.query.type as ReportType;

    if (!type) {
      sendError(res, 'VALIDATION', 'type query parameter is required', 400);
      return;
    }

    const report = getLatestByType(userId, type);

    if (!report) {
      sendSuccess(res, { report: null });
      return;
    }

    sendSuccess(res, {
      report: {
        id: report.id,
        type: report.type,
        title: report.title,
        summary: report.summary,
        documentJson: report.documentJson,
        status: report.status,
        createdAt: report.createdAt,
      },
    });
  }));

  /**
   * GET /api/v1/reports/:id
   *
   * Get a single report with full structured data.
   */
  router.get('/:id', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidReportsRouteScope(res, userId, 'reports_route_detail', { reportId: req.params.id })) return;
    const { id } = req.params;

    const report = getReportById(parseInt(id, 10), userId);

    if (!report) {
      sendError(res, 'NOT_FOUND', 'Report not found', 404);
      return;
    }

    sendSuccess(res, {
      report: {
        id: report.id,
        type: report.type,
        title: report.title,
        summary: report.summary,
        documentJson: report.documentJson,
        sourceJob: report.sourceJob,
        status: report.status,
        readAt: report.readAt,
        createdAt: report.createdAt,
      },
    });
  }));

  /**
   * POST /api/v1/reports/:id/read
   *
   * Mark a report as read.
   */
  router.post('/:id/read', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidReportsRouteScope(res, userId, 'reports_route_mark_read', { reportId: req.params.id })) return;
    const { id } = req.params;

    const success = markReportRead(parseInt(id, 10), userId);

    if (!success) {
      sendError(res, 'NOT_FOUND', 'Report not found', 404);
      return;
    }

    sendSuccess(res, { marked: true });
  }));

  return router;
}
