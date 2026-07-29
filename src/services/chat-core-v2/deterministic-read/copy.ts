// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { normalizeChatCoreV2Locale } from '../response-contracts';

export type ChatCoreV2NormalizedLocale = ReturnType<typeof normalizeChatCoreV2Locale>;

export function joinParts(parts: string[], locale: ChatCoreV2NormalizedLocale): string {
  if (parts.length === 1) return parts[0];
  const andWord = locale === 'en' ? 'and' : 'e';
  return `${parts.slice(0, -1).join(', ')} ${andWord} ${parts[parts.length - 1]}`;
}

export function plural(count: number, singular: string, pluralValue: string): string {
  return count === 1 ? singular : pluralValue;
}
