// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { DomainName } from '../domains/types';
import {
  classifyAndExtractImage,
  type ImageClassificationResult,
} from './anthropic';

export const PHOTO_EXTRACTION_TIMEOUT_MS = 40_000;

export type PhotoExtractionMimeType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

export type PhotoExtractionAttachment = {
  base64: string;
  mimeType: PhotoExtractionMimeType;
};

export type PhotoExtractionClassifier = (
  imageBase64: string,
  mediaType: PhotoExtractionMimeType,
  caption?: string,
  userId?: number,
  tenantId?: number,
) => Promise<ImageClassificationResult>;

export type PhotoExtractionPreview = {
  text: string;
  domain: DomainName;
  confidence: number;
  metadata: Record<string, unknown>;
};

export type PhotoExtractionResult = {
  userText: string;
  conversationDomain: DomainName;
  preview: PhotoExtractionPreview;
  degraded: boolean;
  degradedReason: 'classification_failed' | 'timeout' | null;
  error?: unknown;
};

class PhotoExtractionTimeoutError extends Error {
  constructor() {
    super('Photo extraction timeout');
    this.name = 'PhotoExtractionTimeoutError';
  }
}

export function normalizePhotoExtractionAttachment(raw: unknown): PhotoExtractionAttachment | null {
  if (!raw || typeof raw !== 'object') return null;
  const base64 = typeof (raw as any).base64 === 'string' ? (raw as any).base64.trim() : '';
  const mimeType = typeof (raw as any).mimeType === 'string' ? (raw as any).mimeType.trim().toLowerCase() : '';
  if (!base64) return null;
  if (!['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'].includes(mimeType)) return null;
  return {
    base64,
    mimeType: (mimeType === 'image/jpg' ? 'image/jpeg' : mimeType) as PhotoExtractionMimeType,
  };
}

export function buildPhotoExtractionPreview(
  result: ImageClassificationResult,
  isPT: boolean,
): Omit<PhotoExtractionPreview, 'confidence'> {
  switch (result.type) {
    case 'invoice': {
      const vendor = result.vendor ?? (isPT ? 'fornecedor desconhecido' : 'unknown merchant');
      const amount = result.totalAmount ?? (isPT ? 'valor não encontrado' : 'amount not found');
      const date = result.documentDateRaw ?? result.documentDate ?? (isPT ? 'data não encontrada' : 'date not found');
      return {
        text: isPT
          ? `Analisei a imagem como recibo/nota.\n\nEstabelecimento: ${vendor}\nValor: ${amount}\nData: ${date}\nConfiança: ${Math.round((result.confidence ?? 0) * 100)}%\n\nPara arquivar ou corrigir os campos, abre Finanças > Capturar recibo.`
          : `I analyzed the image as a receipt/invoice.\n\nMerchant: ${vendor}\nAmount: ${amount}\nDate: ${date}\nConfidence: ${Math.round((result.confidence ?? 0) * 100)}%\n\nTo file it or correct any fields, open Finance > Capture Receipt.`,
        domain: 'finance',
        metadata: {
          type: 'invoice_preview',
          invoiceVendor: result.vendor,
          invoiceAmount: result.totalAmount,
        },
      };
    }
    case 'calendar': {
      const visibleEvents = result.events.slice(0, 6);
      const lines = visibleEvents.map((event) => {
        const start = event.start?.slice(11, 16) || '--:--';
        return `- ${start} ${event.title}`;
      });
      const more = result.events.length > visibleEvents.length
        ? (isPT ? `\n... + ${result.events.length - visibleEvents.length} eventos na imagem.` : `\n... + ${result.events.length - visibleEvents.length} more events in the image.`)
        : '';
      return {
        text: isPT
          ? `Detetei um horário/agenda nesta imagem.\n\n${lines.join('\n')}${more}\n\nSe quiseres, posso ajudar a transformar isto em eventos do calendário.`
          : `I detected a schedule/calendar in this image.\n\n${lines.join('\n')}${more}\n\nIf you want, I can help turn this into calendar events.`,
        domain: 'secretary',
        metadata: {
          type: 'calendar_preview',
          calendar: visibleEvents.map((event) => ({
            time: event.start?.slice(11, 16) || null,
            title: event.title,
          })),
        },
      };
    }
    case 'task': {
      const subtasks = result.subtasks.slice(0, 6);
      const lines = subtasks.map((item) => `- ${item}`);
      return {
        text: isPT
          ? `Li esta imagem como checklist/tarefa.\n\nTitulo: ${result.title || 'Nova tarefa'}${lines.length > 0 ? `\n\n${lines.join('\n')}` : ''}\n\nSe quiseres, posso transformar isto numa tarefa estruturada.`
          : `I read this image as a checklist/task.\n\nTitle: ${result.title || 'New task'}${lines.length > 0 ? `\n\n${lines.join('\n')}` : ''}\n\nIf you want, I can turn this into a structured task.`,
        domain: 'secretary',
        metadata: {
          type: 'task_preview',
          taskTitle: result.title,
        },
      };
    }
  }
}

function resolvePhotoExtractionUserText(caption: string, isPT: boolean): string {
  return caption || (isPT ? 'Analisa esta imagem.' : 'Analyze this image.');
}

async function classifyPhotoWithTimeout(
  classifier: PhotoExtractionClassifier,
  attachment: PhotoExtractionAttachment,
  caption: string,
  userId: number,
  tenantId: number | undefined,
  timeoutMs: number,
): Promise<ImageClassificationResult> {
  const classifierPromise = classifier(attachment.base64, attachment.mimeType, caption, userId, tenantId);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new PhotoExtractionTimeoutError()), timeoutMs);
  });

  try {
    return await Promise.race([classifierPromise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function buildDegradedPhotoExtractionPreview(
  isPT: boolean,
  reason: 'classification_failed' | 'timeout',
): PhotoExtractionPreview {
  return {
    text: isPT
      ? 'Não consegui analisar esta imagem agora. Tenta novamente em alguns segundos ou abre a área certa para registar manualmente.'
      : 'I could not analyze this image right now. Try again in a few seconds or open the right area to file it manually.',
    domain: 'secretary',
    confidence: 0,
    metadata: {
      type: 'attachment_unavailable',
      degraded: true,
      reason,
    },
  };
}

export async function extractPhotoAttachment({
  attachment,
  caption,
  userId,
  tenantId,
  language,
  classifier = classifyAndExtractImage,
  timeoutMs = PHOTO_EXTRACTION_TIMEOUT_MS,
}: {
  attachment: PhotoExtractionAttachment;
  caption: string;
  userId: number;
  tenantId?: number;
  language: string;
  classifier?: PhotoExtractionClassifier;
  timeoutMs?: number;
}): Promise<PhotoExtractionResult> {
  const isPT = language.startsWith('pt');
  const userText = resolvePhotoExtractionUserText(caption, isPT);

  try {
    const classified = await classifyPhotoWithTimeout(classifier, attachment, userText, userId, tenantId, timeoutMs);
    const preview = buildPhotoExtractionPreview(classified, isPT);
    const confidence = classified.type === 'invoice' ? classified.confidence ?? 0.8 : 1.0;
    return {
      userText,
      conversationDomain: preview.domain,
      preview: {
        ...preview,
        confidence,
      },
      degraded: false,
      degradedReason: null,
    };
  } catch (err) {
    const reason = err instanceof PhotoExtractionTimeoutError ? 'timeout' : 'classification_failed';
    return {
      userText,
      conversationDomain: 'secretary',
      preview: buildDegradedPhotoExtractionPreview(isPT, reason),
      degraded: true,
      degradedReason: reason,
      error: err,
    };
  }
}
