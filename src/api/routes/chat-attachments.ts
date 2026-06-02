// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ImageClassificationResult } from '../../services/anthropic';
import type { DomainName } from '../../domains/types';
import {
  buildPhotoExtractionPreview,
  normalizePhotoExtractionAttachment,
  type PhotoExtractionAttachment,
} from '../../services/photo-extraction';

export type ChatImageAttachment = PhotoExtractionAttachment;

export function normalizeChatAttachment(raw: unknown): ChatImageAttachment | null {
  return normalizePhotoExtractionAttachment(raw);
}

export function buildAttachmentText(
  result: ImageClassificationResult,
  isPT: boolean,
): { text: string; domain: DomainName; metadata: any } {
  const preview = buildPhotoExtractionPreview(result, isPT);
  return {
    text: preview.text,
    domain: preview.domain,
    metadata: preview.metadata,
  };
}
