// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * AI output reports route — POST /api/v1/ai-reports
 *
 * App Review guideline 1.2: an app that surfaces user-generated or
 * model-generated content needs an in-app way to report objectionable
 * output. The iOS chat transcript offers "Report this response" on every
 * assistant message and POSTs the report here.
 *
 * Write-only from the client's perspective: reads are an operator concern
 * and are not exposed on the iOS API. Every insert is bounded (message id
 * ≤ 200 chars, content ≤ 8000 chars) so a JWT holder can't fill the disk,
 * and every insert writes an `audit_trail` row.
 *
 * Rows are `user_id`-scoped, so account deletion and GDPR export pick the
 * table up automatically through the ownership-column discovery in
 * `services/user-data-export.ts` — no hand-maintained list to update.
 *
 * Auth: JWT-protected (mounted under the protected router).
 * Rate limit: inherits from the global rate-limiter.
 */

import { Router, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { getDb } from '../../services/database';
import { sendSuccess, sendError, sendInternalError, asyncHandler } from '../response-helpers';
import { ensureValidTenantRouteScope } from '../tenant-route-scope';
import { logAudit } from '../../services/audit-trail';

// Hard size caps — keep in sync with the iOS reporter so it can pre-truncate,
// and with the CHECK constraints in migration 264.
const MAX_MESSAGE_ID = 200;
const MAX_CONVERSATION_ID = 200;
const MAX_CONTENT = 8_000;

const ALLOWED_REASONS = ['harmful', 'inaccurate', 'offensive', 'other'] as const;
type AiReportReason = (typeof ALLOWED_REASONS)[number];

interface AiReportBody {
  messageId?: unknown;
  conversationId?: unknown;
  reason?: unknown;
  content?: unknown;
}

function asBoundedString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? null : trimmed;
}

function asReason(value: unknown): AiReportReason | null {
  return typeof value === 'string' && (ALLOWED_REASONS as readonly string[]).includes(value)
    ? value as AiReportReason
    : null;
}

export function aiReportsRoutes(): Router {
  const router = Router();

  router.use((req, res, next) => {
    const { userId } = req as AuthenticatedRequest;
    if (!ensureValidTenantRouteScope(res as Response, userId, 'ai_reports_route', {
      method: req.method,
      path: req.path,
    })) return;
    next();
  });

  /**
   * POST /api/v1/ai-reports
   * Body: {
   *   messageId: string (required, ≤200 chars)
   *   conversationId?: string | null (≤200 chars)
   *   reason: 'harmful' | 'inaccurate' | 'offensive' | 'other' (required)
   *   content: string (required, ≤8000 chars) — the reported output
   * }
   *
   * Returns: { reported: true, reportId: string }
   */
  router.post('/', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as AuthenticatedRequest;
    const body = (req.body || {}) as AiReportBody;

    const messageId = asBoundedString(body.messageId, MAX_MESSAGE_ID);
    if (!messageId) {
      sendError(res, 'BAD_REQUEST', `messageId is required and must be a non-empty string of at most ${MAX_MESSAGE_ID} characters`);
      return;
    }

    const reason = asReason(body.reason);
    if (!reason) {
      sendError(res, 'BAD_REQUEST', `reason must be one of: ${ALLOWED_REASONS.join(', ')}`);
      return;
    }

    // Oversized content is REJECTED rather than truncated: a truncated report
    // would misrepresent what the user actually flagged.
    const content = asBoundedString(body.content, MAX_CONTENT);
    if (!content) {
      sendError(res, 'BAD_REQUEST', `content is required and must be a non-empty string of at most ${MAX_CONTENT} characters`);
      return;
    }

    let conversationId: string | null = null;
    if (body.conversationId !== undefined && body.conversationId !== null) {
      conversationId = asBoundedString(body.conversationId, MAX_CONVERSATION_ID);
      if (!conversationId) {
        sendError(res, 'BAD_REQUEST', `conversationId must be a non-empty string of at most ${MAX_CONVERSATION_ID} characters when provided`);
        return;
      }
    }

    const reportId = randomUUID();
    const scopedTenantId = typeof tenantId === 'number' && tenantId > 0 ? tenantId : userId;

    try {
      getDb().prepare(`
        INSERT INTO ai_output_reports
          (report_id, tenant_id, user_id, message_id, conversation_id, reason, content)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(reportId, scopedTenantId, userId, messageId, conversationId, reason, content);

      logAudit({
        userId,
        tenantId: scopedTenantId,
        actorId: userId,
        action: 'create',
        resource: 'ai_report',
        // The reported text itself stays in ai_output_reports; the audit row
        // records only that a report happened and what it pointed at.
        details: { reportId, messageId, conversationId, reason, contentLength: content.length },
        ipAddress: req.ip,
      });

      logger.warn(
        { userId, tenantId: scopedTenantId, reportId, messageId, reason },
        'AI output reported by user',
      );

      sendSuccess(res, { reported: true, reportId });
    } catch (err: any) {
      logger.error({ err, userId, reportId }, 'Failed to persist AI output report');
      sendInternalError(res, 'Unable to submit the report right now.');
    }
  }));

  return router;
}
