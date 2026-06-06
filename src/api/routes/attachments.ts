// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { asyncHandler, sendError, sendSuccess } from '../response-helpers';
import { enforceCostGuardrails } from '../../services/cost-guardrail';
import {
  extractPhotoAttachment,
  normalizePhotoExtractionAttachment,
} from '../../services/photo-extraction';
import { assertTenantScope } from '../../services/tenant-scope';
import { normalizeLangHeader } from '../../services/secretary-fastpath';
import { getUserLanguageById } from '../../services/user-service';
import { logger } from '../../utils/logger';

function requestCaption(body: unknown): string {
  const payload = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const value = typeof payload.caption === 'string'
    ? payload.caption
    : typeof payload.text === 'string'
      ? payload.text
      : '';
  return value.trim().slice(0, 2000);
}

function requestAttachment(body: unknown): unknown {
  const payload = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  return payload.attachment ?? payload.image ?? payload;
}

function resolveRequestLanguage(req: any, userId: number): string {
  try {
    const header = req.header?.('x-language');
    if (header) return normalizeLangHeader(header);
  } catch {
    // Ignore malformed optional language headers; user preference is the source of truth.
  }
  return getUserLanguageById(userId) || 'pt-BR';
}

function sendAttachmentQuotaExceededIfNeeded(res: Response, userId: number): boolean {
  const decision = enforceCostGuardrails(userId);
  if (!decision.block) return false;

  logger.warn(
    {
      userId,
      reason: decision.reason,
      spentUsd: decision.quota.spentUsd,
      capUsd: decision.quota.capUsd,
      globalTotalUsd: decision.global.totalUsd,
      globalLimitUsd: decision.global.limitUsd,
      platform: 'ios',
    },
    'iOS attachment extraction blocked by quota',
  );
  sendError(
    res,
    decision.reason,
    decision.message,
    decision.status,
    {
      ...decision.details,
      error: 'rate_limited',
      retryable: true,
    },
  );
  return true;
}

export function attachmentRoutes(): Router {
  const router = Router();

  /**
   * POST /api/v1/attachments/extract
   * Body: { attachment: { base64, mimeType }, caption?: string }
   *
   * App-facing migration target for the legacy Telegram photo handler. It
   * returns a deterministic preview for invoice/calendar/task extraction; it
   * does not mutate finance, calendar, or task state.
   */
  router.post('/extract', asyncHandler(async (req, res: Response) => {
    let userId: number;
    let tenantId: number;
    try {
      const scope = assertTenantScope(req as any, 'attachments.extract');
      userId = scope.userId;
      tenantId = scope.tenantId;
    } catch (err: any) {
      if (err?.name === 'TenantScopeError' && typeof err?.status === 'number') {
        sendError(res, err.code ?? 'UNAUTHORIZED', err.message ?? 'Invalid tenant scope', err.status);
        return;
      }
      throw err;
    }
    if (sendAttachmentQuotaExceededIfNeeded(res, userId)) return;

    const attachment = normalizePhotoExtractionAttachment(requestAttachment(req.body));
    if (!attachment) {
      sendError(res, 'BAD_REQUEST', 'A supported image attachment is required.');
      return;
    }

    const result = await extractPhotoAttachment({
      attachment,
      caption: requestCaption(req.body),
      userId,
      tenantId,
      language: resolveRequestLanguage(req, userId),
    });

    if (result.degraded) {
      logger.warn(
        {
          err: result.error,
          userId,
          tenantId,
          reason: result.degradedReason,
        },
        'iOS attachment extraction degraded',
      );
    }

    sendSuccess(res, {
      type: 'photo_extraction_preview',
      routeMethod: result.degraded ? 'attachment_degraded' : 'attachment',
      domain: result.conversationDomain,
      text: result.preview.text,
      confidence: result.preview.confidence,
      metadata: result.preview.metadata,
      degraded: result.degraded,
      degradedReason: result.degradedReason,
      userText: result.userText,
    });
  }));

  return router;
}
