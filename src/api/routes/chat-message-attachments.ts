// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { DomainName } from '../../domains/types';
import {
  extractPhotoAttachment,
  PHOTO_EXTRACTION_TIMEOUT_MS,
  type PhotoExtractionClassifier,
} from '../../services/photo-extraction';
import type { ChatImageAttachment } from './chat-attachments';

export const CHAT_ATTACHMENT_CLASSIFICATION_TIMEOUT_MS = PHOTO_EXTRACTION_TIMEOUT_MS;

export type ChatAttachmentResponseEnvelope = {
  id: string;
  text: string;
  domain: DomainName;
  routeMethod: 'attachment' | 'attachment_degraded';
  confidence: number;
  buttons: null;
  metadata: Record<string, unknown> | null;
  timestamp: string;
};

export type ChatAttachmentExecutionResult = {
  userText: string;
  conversationDomain: DomainName;
  response: ChatAttachmentResponseEnvelope;
  degraded: boolean;
  degradedReason: 'classification_failed' | 'timeout' | null;
  error?: unknown;
};

function buildDegradedAttachmentResponse(
  isPT: boolean,
  reason: 'classification_failed' | 'timeout',
  timestamp: string,
  id: string,
): ChatAttachmentResponseEnvelope {
  return {
    id,
    text: isPT
      ? 'Não consegui analisar esta imagem agora. Tenta novamente em alguns segundos ou abre a área certa para registar manualmente.'
      : 'I could not analyze this image right now. Try again in a few seconds or open the right area to file it manually.',
    domain: 'secretary',
    routeMethod: 'attachment_degraded',
    confidence: 0,
    buttons: null,
    metadata: {
      type: 'attachment_unavailable',
      degraded: true,
      reason,
    },
    timestamp,
  };
}

export async function buildChatAttachmentResponse({
  attachment,
  normalizedText,
  userId,
  tenantId,
  language,
  classifier,
  timeoutMs = CHAT_ATTACHMENT_CLASSIFICATION_TIMEOUT_MS,
  timestamp = new Date().toISOString(),
  id = `msg-${Date.now()}`,
}: {
  attachment: ChatImageAttachment;
  normalizedText: string;
  userId: number;
  tenantId?: number;
  language: string;
  classifier?: PhotoExtractionClassifier;
  timeoutMs?: number;
  timestamp?: string;
  id?: string;
}): Promise<ChatAttachmentExecutionResult> {
  const isPT = language.startsWith('pt');
  const extraction = await extractPhotoAttachment({
    attachment,
    caption: normalizedText,
    userId,
    tenantId,
    language,
    classifier,
    timeoutMs,
  });

  if (!extraction.degraded) {
    return {
      userText: extraction.userText,
      conversationDomain: extraction.conversationDomain,
      response: {
        id,
        text: extraction.preview.text,
        domain: extraction.preview.domain,
        routeMethod: 'attachment',
        confidence: extraction.preview.confidence,
        buttons: null,
        metadata: extraction.preview.metadata,
        timestamp,
      },
      degraded: false,
      degradedReason: null,
    };
  }

  const reason = extraction.degradedReason ?? 'classification_failed';
  return {
    userText: extraction.userText,
    conversationDomain: 'secretary',
    response: buildDegradedAttachmentResponse(isPT, reason, timestamp, id),
    degraded: true,
    degradedReason: reason,
    error: extraction.error,
  };
}
