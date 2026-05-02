// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Response } from 'express';
import { buildQuotaExceededMessage, isUserOverDailyCap } from '../../services/cost-guardrail';
import { normalizeLangHeader } from '../../services/secretary-fastpath';
import { getUserLanguageById, setUserLanguage } from '../../services/user-service';
import { logger } from '../../utils/logger';
import { sendError } from '../response-helpers';
import { normalizeChatAttachment, type ChatImageAttachment } from './chat-attachments';

type HeaderReadable = {
  header(name: string): string | string[] | undefined;
};

export type NormalizedChatMessageRequest = {
  normalizedText: string;
  normalizedTextLower: string;
  normalizedAttachments: ChatImageAttachment[];
  clientMessageId: string | null;
  idempotencyKey: string | null;
};

export function normalizeChatMessageRequest(body: unknown): NormalizedChatMessageRequest {
  const payload = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const normalizedText = typeof payload.text === 'string' ? payload.text.trim() : '';
  const normalizedAttachments = Array.isArray(payload.attachments)
    ? payload.attachments.map(normalizeChatAttachment).filter(Boolean) as ChatImageAttachment[]
    : [];

  return {
    normalizedText,
    normalizedTextLower: normalizedText.toLowerCase(),
    normalizedAttachments,
    clientMessageId: typeof payload.clientMessageId === 'string' && payload.clientMessageId.trim()
      ? payload.clientMessageId.trim().slice(0, 160)
      : null,
    idempotencyKey: typeof payload.idempotencyKey === 'string' && payload.idempotencyKey.trim()
      ? payload.idempotencyKey.trim().slice(0, 160)
      : null,
  };
}

export function persistChatLanguagePreference(req: HeaderReadable, userId: number): void {
  try {
    const headerValue = req.header('x-language');
    if (!headerValue) return;

    const lang = normalizeLangHeader(headerValue);
    const current = getUserLanguageById(userId);
    if (current === lang) return;

    setUserLanguage(userId, lang);
    logger.debug(
      { userId, from: current, to: lang, platform: 'ios' },
      'iOS X-Language header flipped user language preference',
    );
  } catch (err) {
    logger.warn({ err }, 'iOS X-Language header handling failed — continuing with existing preference');
  }
}

export function sendChatQuotaExceededIfNeeded(
  res: Response,
  userId: number,
  logMessage: string,
): boolean {
  const quota = isUserOverDailyCap(userId);
  if (!quota.over) return false;

  logger.warn(
    { userId, spentUsd: quota.spentUsd, capUsd: quota.capUsd, platform: 'ios' },
    logMessage,
  );
  sendError(
    res,
    'QUOTA_EXCEEDED',
    buildQuotaExceededMessage(quota),
    402,
    { plan: quota.plan, resetAt: quota.resetAt },
  );
  return true;
}
