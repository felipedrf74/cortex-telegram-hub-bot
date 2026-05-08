// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getContentCreatorProfile } from '../state/content-creator-profile';
import { logger } from '../utils/logger';
import { getCurrentContext } from '../utils/request-context';

export function buildCurrentCreatorProfilePayload(languageHint?: string | null): {
  language: string;
  creator_profile?: string;
} {
  const context = getCurrentContext();
  const fallbackLanguage = String(languageHint || 'en-US').trim() || 'en-US';
  if (!context?.userId) {
    return { language: fallbackLanguage };
  }
  try {
    const profile = getContentCreatorProfile(context.userId, context.userId);
    const language = profile.languagePreference?.trim() || fallbackLanguage;
    const lines = [
      'Creator scope: current authenticated Nexus Hub user only.',
      `Primary output language: ${language}.`,
      profile.audience ? `Audience: ${profile.audience}` : null,
      profile.pillars.length > 0 ? `Pillars: ${profile.pillars.join(', ')}` : null,
      profile.niches.length > 0 ? `Niches: ${profile.niches.join(', ')}` : null,
      profile.voiceRules.length > 0 ? `Voice rules: ${profile.voiceRules.join('; ')}` : null,
      profile.preferredFormats.length > 0 ? `Preferred formats: ${profile.preferredFormats.join(', ')}` : null,
      profile.dislikedTopics.length > 0 ? `Disliked topics: ${profile.dislikedTopics.join(', ')}` : null,
      profile.bannedTopics.length > 0 ? `Banned topics: ${profile.bannedTopics.join(', ')}` : null,
      profile.contentGoals.length > 0 ? `Content goals: ${profile.contentGoals.join('; ')}` : null,
      profile.voiceExamples.length > 0 ? `Voice examples: ${profile.voiceExamples.join('\n---\n')}` : null,
    ].filter((line): line is string => Boolean(line));
    return {
      language,
      creator_profile: lines.join('\n').slice(0, 6000),
    };
  } catch (err) {
    logger.warn({ err, userId: context.userId }, 'content-engine creator profile payload unavailable');
    return { language: fallbackLanguage };
  }
}
