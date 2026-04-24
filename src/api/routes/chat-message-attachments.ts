// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { DomainName } from '../../domains/types';
import { classifyAndExtractImage, type ImageClassificationResult } from '../../services/anthropic';
import type { ChatImageAttachment } from './chat-attachments';
import { buildAttachmentText } from './chat-attachments';

export const CHAT_ATTACHMENT_CLASSIFICATION_TIMEOUT_MS = 40_000;

type AttachmentClassifier = (
  imageBase64: string,
  mediaType: ChatImageAttachment['mimeType'],
  caption?: string,
  userId?: number,
) => Promise<ImageClassificationResult>;

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

class ChatAttachmentTimeoutError extends Error {
  constructor() {
    super('Attachment classification timeout');
    this.name = 'ChatAttachmentTimeoutError';
  }
}

function resolveAttachmentUserText(normalizedText: string, isPT: boolean): string {
  return normalizedText || (isPT ? 'Analisa esta imagem.' : 'Analyze this image.');
}

async function classifyAttachmentWithTimeout(
  classifier: AttachmentClassifier,
  attachment: ChatImageAttachment,
  userText: string,
  userId: number,
  timeoutMs: number,
): Promise<ImageClassificationResult> {
  const classifierPromise = classifier(attachment.base64, attachment.mimeType, userText, userId);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new ChatAttachmentTimeoutError()), timeoutMs);
  });

  try {
    return await Promise.race([classifierPromise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

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
  language,
  classifier = classifyAndExtractImage,
  timeoutMs = CHAT_ATTACHMENT_CLASSIFICATION_TIMEOUT_MS,
  timestamp = new Date().toISOString(),
  id = `msg-${Date.now()}`,
}: {
  attachment: ChatImageAttachment;
  normalizedText: string;
  userId: number;
  language: string;
  classifier?: AttachmentClassifier;
  timeoutMs?: number;
  timestamp?: string;
  id?: string;
}): Promise<ChatAttachmentExecutionResult> {
  const isPT = language.startsWith('pt');
  const userText = resolveAttachmentUserText(normalizedText, isPT);

  try {
    const classified = await classifyAttachmentWithTimeout(classifier, attachment, userText, userId, timeoutMs);
    const attachmentReply = buildAttachmentText(classified, isPT);
    const response: ChatAttachmentResponseEnvelope = {
      id,
      text: attachmentReply.text,
      domain: attachmentReply.domain,
      routeMethod: 'attachment',
      confidence: classified.type === 'invoice' ? classified.confidence ?? 0.8 : 1.0,
      buttons: null,
      metadata: attachmentReply.metadata,
      timestamp,
    };

    return {
      userText,
      conversationDomain: attachmentReply.domain,
      response,
      degraded: false,
      degradedReason: null,
    };
  } catch (err) {
    const reason = err instanceof ChatAttachmentTimeoutError ? 'timeout' : 'classification_failed';
    return {
      userText,
      conversationDomain: 'secretary',
      response: buildDegradedAttachmentResponse(isPT, reason, timestamp, id),
      degraded: true,
      degradedReason: reason,
      error: err,
    };
  }
}
