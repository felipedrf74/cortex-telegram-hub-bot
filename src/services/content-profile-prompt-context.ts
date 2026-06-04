// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  getContentCreatorProfile,
  type ContentCreatorProfile,
} from '../state/content-creator-profile';

export interface CreatorPromptContext {
  language: string;
  audience: string;
  pillars: string[];
  niches: string[];
  block: string;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function cleanList(values: unknown, fallback: string[]): string[] {
  if (!Array.isArray(values)) return fallback;
  const cleaned = values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 12);
  return cleaned.length > 0 ? cleaned : fallback;
}

export function buildCreatorPromptContext(
  profile?: Partial<ContentCreatorProfile> | null,
): CreatorPromptContext {
  const language = nonEmpty(profile?.languagePreference) ?? 'the creator preferred language';
  const audience = nonEmpty(profile?.audience) ?? 'the creator saved audience';
  const pillars = cleanList(profile?.pillars, ['the creator saved pillars']);
  const niches = cleanList(profile?.niches, pillars);
  const voiceRules = cleanList(profile?.voiceRules, []);

  const lines = [
    `Target language: ${language}`,
    `Audience: ${audience}`,
    `Pillars: ${pillars.join(', ')}`,
    `Niches: ${niches.join(', ')}`,
  ];
  if (voiceRules.length > 0) {
    lines.push(`Voice rules: ${voiceRules.join('; ')}`);
  }

  return {
    language,
    audience,
    pillars,
    niches,
    block: lines.join('\n'),
  };
}

export function loadCreatorPromptContextForUser(
  userId?: number | null,
  tenantId?: number | null,
): CreatorPromptContext {
  if (!Number.isFinite(userId) || Number(userId) <= 0) {
    return buildCreatorPromptContext(null);
  }
  return buildCreatorPromptContext(getContentCreatorProfile(Number(userId), tenantId));
}
