// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import {
  getContentCreatorProfile,
  type ContentCreatorProfile,
} from '../state/content-creator-profile';
import {
  buildContentCreativeProfileContext,
  type ContentCreativeProfileContext,
} from './content-memory-profile';
import { resolveContentTenantId } from './content-tenant-scope';
import type { CreatorVoiceCard } from './content-token-economy';
import type { ScriptVoiceFitCriteria } from './content-script-quality';

export const CREATOR_VOICE_BRAND_CARD_V2_SCHEMA = 'creator-voice-brand-card-v2';

export interface CreatorVoiceBrandCardV2 extends CreatorVoiceCard {
  schemaVersion: typeof CREATOR_VOICE_BRAND_CARD_V2_SCHEMA;
  audienceSegments: string[];
  positioning: string;
  proofLibrary: string[];
  platformOverrides: Record<string, string>;
  preferredFormats: string[];
  bannedTopics: string[];
  trustedSources: string[];
  dislikedSources: string[];
  quality: {
    completenessScore: number;
    specificityScore: number;
    confidenceScore: number;
    staleMemoryCount: number;
    missingCriticalKeys: string[];
    warnings: string[];
  };
  provenance: {
    profileUpdatedAt: string | null;
    appliedMemoryKeys: string[];
    omittedPrivateMemoryKeys: string[];
    sourceHash: string;
  };
  missingFacts: string[];
  voiceFitCriteria: ScriptVoiceFitCriteria;
}

export function buildCreatorVoiceBrandCardV2(input: {
  tenantId?: number | null;
  userId: number;
  language: string;
  niche?: string | null;
  platform?: string | null;
  voiceMemory?: string | null;
  outputVisibilityScope?: string | null;
}): CreatorVoiceBrandCardV2 {
  const tenantId = resolveContentTenantId(input.userId, input.tenantId);
  const profile = getContentCreatorProfile(input.userId, tenantId);
  const memoryContext = buildContentCreativeProfileContext({
    tenantId,
    userId: input.userId,
    platform: input.platform,
    outputVisibilityScope: input.outputVisibilityScope ?? 'user_private',
    allowUserPrivateForTenantShared: false,
  });

  const memoryValues = memoryMap(memoryContext);
  const toneRules = uniqueCompact([
    ...profile.voiceRules,
    ...memoryList(memoryValues, 'voice.tone'),
    ...memoryList(memoryValues, 'voice.style'),
    ...memoryList(memoryValues, 'voice.directness'),
    ...memoryList(memoryValues, 'voice.formality'),
  ], 10);
  const phrasesToUse = uniqueCompact([
    ...memoryList(memoryValues, 'voice.vocabulary_preferences'),
    ...memoryList(memoryValues, 'voice.hook_preferences'),
    ...memoryList(memoryValues, 'voice.preferred_ctas'),
  ], 10);
  const topicsToAvoid = uniqueCompact([
    ...profile.bannedTopics,
    ...profile.dislikedTopics,
    ...memoryList(memoryValues, 'brand.topics_to_avoid'),
  ], 14);
  const phrasesToAvoid = uniqueCompact([
    ...memoryList(memoryValues, 'voice.banned_phrases'),
    'generic motivation',
    'unsupported guarantees',
    'another creator identity',
  ], 14);
  const contentPillars = uniqueCompact([
    ...profile.pillars,
    ...memoryList(memoryValues, 'brand.content_pillars'),
    input.niche ?? '',
  ], 8);
  const audienceSegments = uniqueCompact([
    profile.audience,
    ...memoryList(memoryValues, 'brand.audience'),
    input.niche ?? '',
  ], 6);
  const formatPreferences = uniqueCompact([
    ...profile.preferredFormats,
    ...memoryList(memoryValues, 'brand.preferred_formats'),
  ], 8);
  const proofLibrary = uniqueCompact([
    ...profile.trustedSources.map((source) => `Trusted source: ${source}`),
    ...profile.voiceExamples.map((example) => `Voice example: ${example}`),
    ...memoryList(memoryValues, 'source.reference_preferences'),
    ...memoryList(memoryValues, 'source.trust_preferences'),
  ], 8);
  const platformOverrides = Object.fromEntries(
    memoryContext.memories
      .filter((memory) => memory.memoryKey.startsWith('voice.platform.'))
      .map((memory) => [memory.memoryKey.replace(/^voice\.platform\./, ''), memory.memoryValue.slice(0, 360)]),
  );
  const positioning = firstNonEmpty([
    ...memoryList(memoryValues, 'brand.positioning'),
    ...profile.contentGoals,
  ]) || 'topic-led useful creator positioning';
  const ctaStyle = firstNonEmpty(memoryList(memoryValues, 'voice.preferred_ctas'))
    || profile.contentGoals[0]
    || 'single clear next action';
  const examplesCompressed = uniqueCompact([
    ...profile.voiceExamples,
    input.voiceMemory ?? '',
    memoryContext.contextBlock,
  ], 6).join('\n\n').slice(0, 1800);
  const quality = evaluateVoiceBrandQuality(profile, memoryContext, {
    audienceSegments,
    contentPillars,
    toneRules,
    proofLibrary,
    phrasesToAvoid,
    formatPreferences,
  });
  const missingFacts = buildMissingFacts(quality.missingCriticalKeys);
  const sourceHash = stableHash(JSON.stringify({
    tenantId,
    userId: input.userId,
    language: input.language,
    niche: input.niche,
    platform: input.platform,
    profile,
    memoryKeys: memoryContext.appliedMemoryKeys,
    memoryUpdated: memoryContext.memories.map((memory) => `${memory.memoryKey}:${memory.updatedAt}:${memory.confidence}`),
    voiceMemory: input.voiceMemory ?? '',
  }));
  const promptText = [
    `Voice card schema: ${CREATOR_VOICE_BRAND_CARD_V2_SCHEMA}`,
    `Voice card version: ${sourceHash}`,
    `Language: ${input.language}`,
    `Audience: ${audienceSegments.join('; ') || 'not yet specified'}`,
    `Positioning: ${positioning}`,
    `Content pillars: ${contentPillars.join('; ') || 'not yet specified'}`,
    toneRules.length ? `Tone and style: ${toneRules.join('; ')}` : 'Tone and style: neutral, topic-led, specific.',
    phrasesToUse.length ? `Use vocabulary/hooks/CTA patterns like: ${phrasesToUse.join('; ')}` : null,
    phrasesToAvoid.length ? `Avoid: ${phrasesToAvoid.join('; ')}` : null,
    topicsToAvoid.length ? `Avoid topics or angles: ${topicsToAvoid.join('; ')}` : null,
    proofLibrary.length ? `Proof library: ${proofLibrary.join('; ')}` : 'Proof library: ask for or use source-backed examples before factual claims.',
    formatPreferences.length ? `Preferred formats: ${formatPreferences.join('; ')}` : null,
    Object.keys(platformOverrides).length
      ? `Platform overrides: ${Object.entries(platformOverrides).map(([key, value]) => `${key}=${value}`).join('; ')}`
      : null,
    missingFacts.length ? `Profile follow-up questions: ${missingFacts.join(' | ')}` : null,
    examplesCompressed ? `Compressed examples and memory:\n${examplesCompressed}` : null,
    'Apply this as style guidance only. Do not quote memory verbatim and do not invent private biography.',
  ].filter(Boolean).join('\n');

  return {
    creatorId: input.userId,
    tenantId,
    voiceCardVersion: sourceHash,
    schemaVersion: CREATOR_VOICE_BRAND_CARD_V2_SCHEMA,
    tone: toneRules.length ? toneRules.join('; ').slice(0, 260) : 'neutral_topic_led',
    pacing: firstNonEmpty(memoryList(memoryValues, 'voice.pacing')) || 'clear_and_concise',
    phrasesToUse,
    phrasesToAvoid,
    contentPillars,
    audience: audienceSegments[0] || input.niche || 'general',
    audienceSegments,
    positioning,
    formatPreferences,
    preferredFormats: formatPreferences,
    ctaStyle,
    examplesCompressed,
    proofLibrary,
    platformOverrides,
    bannedTopics: topicsToAvoid,
    trustedSources: profile.trustedSources,
    dislikedSources: profile.dislikedSources,
    sourceHash,
    updatedAt: new Date().toISOString(),
    promptText,
    quality,
    provenance: {
      profileUpdatedAt: profile.updatedAt ?? null,
      appliedMemoryKeys: memoryContext.appliedMemoryKeys,
      omittedPrivateMemoryKeys: memoryContext.omittedPrivateMemoryKeys,
      sourceHash,
    },
    missingFacts,
    voiceFitCriteria: {
      audience: audienceSegments[0] || input.niche || null,
      contentPillars,
      toneRules,
      phrasesToAvoid,
      preferredCtas: memoryList(memoryValues, 'voice.preferred_ctas'),
      proofLibrary,
      confidence: quality.confidenceScore,
    },
  };
}

export function evaluateVoiceBrandQuality(
  profile: ContentCreatorProfile,
  memoryContext: ContentCreativeProfileContext,
  values: {
    audienceSegments: string[];
    contentPillars: string[];
    toneRules: string[];
    proofLibrary: string[];
    phrasesToAvoid: string[];
    formatPreferences: string[];
  },
): CreatorVoiceBrandCardV2['quality'] {
  const warnings: string[] = [...memoryContext.warnings];
  const missing = new Set(memoryContext.quality.missingCriticalKeys);
  if (values.audienceSegments.length > 0) missing.delete('brand.audience');
  if (values.contentPillars.length > 0) missing.delete('brand.content_pillars');
  if (values.toneRules.length > 0) missing.delete('voice.tone');
  if (isGenericAudience(values.audienceSegments.join(' '))) missing.add('brand.audience_specificity');
  if (values.contentPillars.length === 0) missing.add('brand.content_pillars');
  if (values.toneRules.length === 0) missing.add('voice.tone');
  if (values.proofLibrary.length === 0) missing.add('brand.proof_library');
  if (profile.languagePreference && !/^[a-z]{2}(?:-[A-Z]{2})?$/i.test(profile.languagePreference)) warnings.push('language_preference_needs_review');
  if (hasConflict(profile.voiceRules)) warnings.push('voice_rules_may_conflict');
  const completenessPieces = [
    values.audienceSegments.length > 0 && !isGenericAudience(values.audienceSegments.join(' ')),
    values.contentPillars.length > 0,
    values.toneRules.length > 0,
    values.proofLibrary.length > 0,
    values.formatPreferences.length > 0,
    profile.voiceExamples.length > 0,
  ].filter(Boolean).length;
  const completenessScore = Math.round((completenessPieces / 6) * 100);
  const specificityScore = Math.round(([
    averageSpecificity(values.audienceSegments),
    averageSpecificity(values.contentPillars),
    averageSpecificity(values.toneRules),
    averageSpecificity(values.proofLibrary),
  ].reduce((sum, value) => sum + value, 0) / 4) * 100);
  const missingCriticalKeys = [...missing];
  const warningsWithoutResolvedProfileGap = warnings.filter((warning) =>
    warning !== 'profile_missing_critical_memory'
    || missingCriticalKeys.some((key) => ['voice.tone', 'brand.audience', 'brand.content_pillars'].includes(key)),
  );
  return {
    completenessScore,
    specificityScore,
    confidenceScore: Math.round(memoryContext.quality.confidenceScore * 100) / 100,
    staleMemoryCount: memoryContext.quality.staleCount,
    missingCriticalKeys,
    warnings: [...new Set(warningsWithoutResolvedProfileGap)],
  };
}

function buildMissingFacts(keys: string[]): string[] {
  const prompts: Record<string, string> = {
    'voice.tone': 'Define the default tone with 2-3 concrete adjectives.',
    'brand.audience': 'Name the primary audience segment.',
    'brand.audience_specificity': 'Make the audience narrower than “everyone” or “creators”.',
    'brand.content_pillars': 'Add 3-5 content pillars.',
    'brand.proof_library': 'Add proof points, trusted sources, examples, or case studies.',
  };
  return keys.map((key) => prompts[key] ?? `Clarify ${key}.`).slice(0, 6);
}

function memoryMap(context: ContentCreativeProfileContext): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const memory of context.memories) {
    const values = parseMemoryValue(memory.memoryValue);
    if (values.length === 0) continue;
    map.set(memory.memoryKey, [...(map.get(memory.memoryKey) ?? []), ...values]);
  }
  return map;
}

function memoryList(values: Map<string, string[]>, key: string): string[] {
  return values.get(key) ?? [];
}

function parseMemoryValue(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map((item) => String(item).trim()).filter(Boolean);
  } catch {
    // Plain text memories are valid.
  }
  return value.split(/\n|;/).map((item) => item.trim()).filter(Boolean);
}

function firstNonEmpty(values: string[]): string | null {
  return values.map((value) => value.trim()).find(Boolean) ?? null;
}

function uniqueCompact(values: Array<string | null | undefined>, maxItems: number): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const raw of values) {
    const value = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(value.slice(0, 360));
    if (output.length >= maxItems) break;
  }
  return output;
}

function isGenericAudience(value: string): boolean {
  const normalized = value.toLowerCase();
  return !normalized
    || /\b(everyone|general audience|all creators|creators|people|pessoas|todos|geral)\b/.test(normalized);
}

function hasConflict(values: string[]): boolean {
  const joined = values.join(' ').toLowerCase();
  return /formal/.test(joined) && /(casual|informal)/.test(joined)
    || /humor/.test(joined) && /(serious|sem humor|no humor)/.test(joined);
}

function averageSpecificity(values: string[]): number {
  if (values.length === 0) return 0;
  const scores = values.map((value) => {
    const tokens = value.split(/\s+/).filter(Boolean).length;
    if (isGenericAudience(value)) return 0.2;
    if (tokens >= 8) return 1;
    if (tokens >= 4) return 0.75;
    return 0.5;
  });
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

function stableHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}
