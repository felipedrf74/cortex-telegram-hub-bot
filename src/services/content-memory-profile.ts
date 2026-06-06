// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  applySkillMemoryCorrection,
  getSkillMemories,
  markSkillMemoriesStaleForVersion,
  setSkillMemory,
  type SkillMemoryRecord,
  type SkillMemoryScope,
  type SkillMemoryType,
} from './skill-memory';
import { resolveContentTenantId, type ContentVisibilityScope } from './content-tenant-scope';

export const CONTENT_CREATIVE_MEMORY_SCHEMA_VERSION = 'content-creative-memory-v1';

export type ContentCreativeProfileScope = Extract<SkillMemoryScope, 'user_private' | 'tenant_shared'>;

export interface ContentVoiceProfileInput {
  tenantId?: number;
  userId: number;
  scope?: ContentCreativeProfileScope;
  tone?: string;
  style?: string;
  pacing?: string;
  vocabularyPreferences?: string[];
  hookPreferences?: string[];
  structurePreferences?: string[];
  storytellingStyle?: string;
  humorSincerityLevel?: string;
  directness?: string;
  formality?: string;
  bannedPhrases?: string[];
  preferredCallsToAction?: string[];
  platformVoice?: Record<string, string>;
  source?: string;
  confidence?: number;
  relatedSkillVersion?: string | null;
}

export interface ContentBrandProfileInput {
  tenantId?: number;
  userId: number;
  scope?: ContentCreativeProfileScope;
  brandRules?: string[];
  audience?: string[];
  contentPillars?: string[];
  topicsToAvoid?: string[];
  preferredFormats?: string[];
  dislikedFormats?: string[];
  positioning?: string;
  recurringThemes?: string[];
  referencePreferences?: string[];
  sourceTrustPreferences?: string[];
  source?: string;
  confidence?: number;
  relatedSkillVersion?: string | null;
}

export interface ContentPerformanceMemoryInput {
  tenantId?: number;
  userId: number;
  scope?: ContentCreativeProfileScope;
  successfulTopics?: string[];
  weakTopics?: string[];
  successfulHooks?: string[];
  successfulFormats?: string[];
  rejectedPatterns?: string[];
  audienceResponseSignals?: string[];
  source?: string;
  confidence?: number;
  relatedSkillVersion?: string | null;
}

export interface ContentMemoryCorrectionInput {
  tenantId?: number;
  userId: number;
  scope?: ContentCreativeProfileScope;
  memoryKey: string;
  correctedValue: string | string[];
  source?: string;
  confidence?: number;
  relatedSkillVersion?: string | null;
}

export interface ContentCreativeProfileContextInput {
  tenantId?: number;
  userId: number;
  platform?: string | null;
  outputVisibilityScope?: ContentVisibilityScope | string | null;
  allowUserPrivateForTenantShared?: boolean;
  includeStale?: boolean;
}

export interface ContentCreativeProfileContext {
  tenantId: number;
  userId: number;
  platform: string | null;
  contextBlock: string;
  memories: SkillMemoryRecord[];
  appliedMemoryKeys: string[];
  omittedPrivateMemoryKeys: string[];
  warnings: string[];
  followUpQuestions: string[];
  quality: {
    completenessScore: number;
    confidenceScore: number;
    staleCount: number;
    missingCriticalKeys: string[];
  };
}

export interface ContentSuggestion {
  id: string;
  title: string;
  topic?: string;
  format?: string;
  hook?: string;
}

export interface ContentSuggestionDecision extends ContentSuggestion {
  score: number;
  reasonCodes: string[];
}

const CONTENT_MEMORY_SKILL_ID = 'content';
const CRITICAL_PROFILE_KEYS = ['voice.tone', 'brand.audience', 'brand.content_pillars'] as const;

function asList(value?: string[]): string | null {
  const cleaned = (value ?? []).map((item) => String(item).trim()).filter(Boolean);
  return cleaned.length > 0 ? JSON.stringify(cleaned) : null;
}

function normalizeTenant(userId: number, tenantId?: number): number {
  return resolveContentTenantId(userId, tenantId);
}

function normalizePlatform(platform: string): string {
  return platform.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function valueToMemory(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return asList(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseMemoryList(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.map((item) => String(item).trim()).filter(Boolean)
      : [value];
  } catch {
    return [value];
  }
}

function memoryTypeForKey(memoryKey: string): SkillMemoryType {
  if (memoryKey.startsWith('voice.')) return 'voice_brand_preference';
  if (memoryKey.startsWith('source.')) return 'source_reference_preference';
  if (memoryKey.startsWith('performance.') || memoryKey.startsWith('pattern.')) return 'content_creative_preference';
  if (memoryKey.startsWith('brand.')) return 'tenant_preference';
  return 'content_creative_preference';
}

function writeContentMemory(input: {
  tenantId: number;
  userId: number;
  scope: ContentCreativeProfileScope;
  memoryKey: string;
  memoryValue: string | string[];
  source: string;
  confidence?: number;
  relatedSkillVersion?: string | null;
  auditMetadata?: Record<string, unknown>;
}): SkillMemoryRecord {
  const memoryValue = valueToMemory(input.memoryValue);
  if (!memoryValue) throw new Error(`CONTENT_MEMORY_EMPTY: ${input.memoryKey}`);
  return setSkillMemory({
    tenantId: input.tenantId,
    userId: input.scope === 'user_private' ? input.userId : null,
    skillId: CONTENT_MEMORY_SKILL_ID,
    memoryType: memoryTypeForKey(input.memoryKey),
    scope: input.scope,
    memoryKey: input.memoryKey,
    memoryValue,
    source: input.source,
    confidence: input.confidence ?? 0.75,
    schemaVersion: CONTENT_CREATIVE_MEMORY_SCHEMA_VERSION,
    relatedSkillVersion: input.relatedSkillVersion ?? null,
    auditMetadata: input.auditMetadata,
  });
}

export function upsertContentVoiceProfile(input: ContentVoiceProfileInput): SkillMemoryRecord[] {
  const tenantId = normalizeTenant(input.userId, input.tenantId);
  const scope = input.scope ?? 'user_private';
  const source = input.source ?? 'content_voice_profile';
  const records: SkillMemoryRecord[] = [];
  const entries: Array<[string, string | string[] | undefined]> = [
    ['voice.tone', input.tone],
    ['voice.style', input.style],
    ['voice.pacing', input.pacing],
    ['voice.vocabulary_preferences', input.vocabularyPreferences],
    ['voice.hook_preferences', input.hookPreferences],
    ['voice.structure_preferences', input.structurePreferences],
    ['voice.storytelling_style', input.storytellingStyle],
    ['voice.humor_sincerity_level', input.humorSincerityLevel],
    ['voice.directness', input.directness],
    ['voice.formality', input.formality],
    ['voice.banned_phrases', input.bannedPhrases],
    ['voice.preferred_ctas', input.preferredCallsToAction],
  ];
  for (const [memoryKey, memoryValue] of entries) {
    if (valueToMemory(memoryValue)) {
      records.push(writeContentMemory({
        tenantId,
        userId: input.userId,
        scope,
        memoryKey,
        memoryValue: memoryValue as string | string[],
        source,
        confidence: input.confidence,
        relatedSkillVersion: input.relatedSkillVersion,
      }));
    }
  }
  for (const [platform, value] of Object.entries(input.platformVoice ?? {})) {
    if (valueToMemory(value)) {
      records.push(writeContentMemory({
        tenantId,
        userId: input.userId,
        scope,
        memoryKey: `voice.platform.${normalizePlatform(platform)}`,
        memoryValue: value,
        source,
        confidence: input.confidence,
        relatedSkillVersion: input.relatedSkillVersion,
      }));
    }
  }
  return records;
}

export function upsertContentBrandProfile(input: ContentBrandProfileInput): SkillMemoryRecord[] {
  const tenantId = normalizeTenant(input.userId, input.tenantId);
  const scope = input.scope ?? 'tenant_shared';
  const source = input.source ?? 'content_brand_profile';
  const records: SkillMemoryRecord[] = [];
  const entries: Array<[string, string | string[] | undefined]> = [
    ['brand.rules', input.brandRules],
    ['brand.audience', input.audience],
    ['brand.content_pillars', input.contentPillars],
    ['brand.topics_to_avoid', input.topicsToAvoid],
    ['brand.preferred_formats', input.preferredFormats],
    ['brand.disliked_formats', input.dislikedFormats],
    ['brand.positioning', input.positioning],
    ['brand.recurring_themes', input.recurringThemes],
    ['source.reference_preferences', input.referencePreferences],
    ['source.trust_preferences', input.sourceTrustPreferences],
  ];
  for (const [memoryKey, memoryValue] of entries) {
    if (valueToMemory(memoryValue)) {
      records.push(writeContentMemory({
        tenantId,
        userId: input.userId,
        scope,
        memoryKey,
        memoryValue: memoryValue as string | string[],
        source,
        confidence: input.confidence,
        relatedSkillVersion: input.relatedSkillVersion,
      }));
    }
  }
  return records;
}

export function recordContentPerformanceMemory(input: ContentPerformanceMemoryInput): SkillMemoryRecord[] {
  const tenantId = normalizeTenant(input.userId, input.tenantId);
  const scope = input.scope ?? 'tenant_shared';
  const source = input.source ?? 'content_performance_learning';
  const records: SkillMemoryRecord[] = [];
  const entries: Array<[string, string[] | undefined]> = [
    ['performance.successful_topics', input.successfulTopics],
    ['performance.weak_topics', input.weakTopics],
    ['performance.successful_hooks', input.successfulHooks],
    ['performance.successful_formats', input.successfulFormats],
    ['pattern.rejected_content_patterns', input.rejectedPatterns],
    ['performance.audience_response_signals', input.audienceResponseSignals],
  ];
  for (const [memoryKey, memoryValue] of entries) {
    if (valueToMemory(memoryValue)) {
      records.push(writeContentMemory({
        tenantId,
        userId: input.userId,
        scope,
        memoryKey,
        memoryValue: memoryValue as string[],
        source,
        confidence: input.confidence ?? 0.72,
        relatedSkillVersion: input.relatedSkillVersion,
      }));
    }
  }
  return records;
}

export function applyContentMemoryCorrection(input: ContentMemoryCorrectionInput): SkillMemoryRecord {
  const tenantId = normalizeTenant(input.userId, input.tenantId);
  const scope = input.scope ?? 'user_private';
  const correctedValue = valueToMemory(input.correctedValue);
  if (!correctedValue) throw new Error(`CONTENT_MEMORY_EMPTY: ${input.memoryKey}`);
  return applySkillMemoryCorrection({
    tenantId,
    userId: scope === 'user_private' ? input.userId : null,
    skillId: CONTENT_MEMORY_SKILL_ID,
    memoryType: memoryTypeForKey(input.memoryKey),
    scope,
    memoryKey: input.memoryKey,
    correctedValue,
    source: input.source ?? 'user_correction',
    confidence: input.confidence ?? 0.95,
    schemaVersion: CONTENT_CREATIVE_MEMORY_SCHEMA_VERSION,
    relatedSkillVersion: input.relatedSkillVersion ?? null,
    auditMetadata: { contentMemoryCorrection: true },
  });
}

export function markContentCreativeMemoryStaleForVersion(input: {
  tenantId?: number;
  userId?: number;
  schemaVersion?: string;
  relatedSkillVersion?: string;
  reason: string;
}): number {
  return markSkillMemoriesStaleForVersion({
    tenantId: input.tenantId,
    skillId: CONTENT_MEMORY_SKILL_ID,
    schemaVersion: input.schemaVersion,
    relatedSkillVersion: input.relatedSkillVersion,
    reason: input.reason,
  });
}

export function buildContentCreativeProfileContext(input: ContentCreativeProfileContextInput): ContentCreativeProfileContext {
  const tenantId = normalizeTenant(input.userId, input.tenantId);
  const allMemories = getSkillMemories({
    tenantId,
    userId: input.userId,
    skillId: CONTENT_MEMORY_SKILL_ID,
    memoryTypes: [
      'voice_brand_preference',
      'content_creative_preference',
      'source_reference_preference',
      'tenant_preference',
      'correction_override',
    ],
    includeStale: input.includeStale ?? false,
  });

  const tenantSharedOutput = input.outputVisibilityScope === 'tenant_shared';
  const memories = allMemories.filter((memory) =>
    !tenantSharedOutput
    || input.allowUserPrivateForTenantShared === true
    || memory.scope !== 'user_private',
  );
  const omittedPrivateMemoryKeys = tenantSharedOutput && !input.allowUserPrivateForTenantShared
    ? allMemories.filter((memory) => memory.scope === 'user_private').map((memory) => memory.memoryKey)
    : [];
  const platform = input.platform ? normalizePlatform(input.platform) : null;
  const platformExcluded = new Set(
    platform
      ? memories
          .filter((memory) => memory.memoryKey.startsWith('voice.platform.') && memory.memoryKey !== `voice.platform.${platform}`)
          .map((memory) => memory.memoryKey)
      : memories
          .filter((memory) => memory.memoryKey.startsWith('voice.platform.'))
          .map((memory) => memory.memoryKey),
  );
  const applied = memories.filter((memory) => !platformExcluded.has(memory.memoryKey));
  const missingCriticalKeys = CRITICAL_PROFILE_KEYS.filter((key) =>
    !applied.some((memory) => memory.memoryKey === key),
  );
  const staleCount = allMemories.filter((memory) => ['stale', 'expired'].includes(memory.freshnessStatus) || memory.status === 'stale').length;
  const confidenceScore = applied.length > 0
    ? Math.round((applied.reduce((sum, memory) => sum + memory.confidence, 0) / applied.length) * 100) / 100
    : 0;
  const completenessScore = Math.round(((CRITICAL_PROFILE_KEYS.length - missingCriticalKeys.length) / CRITICAL_PROFILE_KEYS.length) * 100) / 100;
  const followUpQuestions = buildFollowUpQuestions(missingCriticalKeys, platform);
  const warnings = [
    ...(omittedPrivateMemoryKeys.length > 0 ? ['user_private_memory_omitted_for_tenant_shared_output'] : []),
    ...(missingCriticalKeys.length > 0 ? ['profile_missing_critical_memory'] : []),
    ...(staleCount > 0 ? ['stale_memory_available_but_not_applied'] : []),
  ];
  const lines = applied.map((memory) =>
    `- ${memory.memoryKey}: ${formatMemoryValue(memory.memoryValue)} (scope=${memory.scope}, source=${memory.source}, confidence=${memory.confidence.toFixed(2)}, freshness=${memory.freshnessStatus})`,
  );
  return {
    tenantId,
    userId: input.userId,
    platform,
    contextBlock: lines.length > 0
      ? `Content creative memory (${platform ?? 'all platforms'}):\n${lines.join('\n')}`
      : '',
    memories: applied,
    appliedMemoryKeys: applied.map((memory) => memory.memoryKey),
    omittedPrivateMemoryKeys,
    warnings,
    followUpQuestions,
    quality: {
      completenessScore,
      confidenceScore,
      staleCount,
      missingCriticalKeys,
    },
  };
}

export function filterContentSuggestionsWithMemory(
  suggestions: ContentSuggestion[],
  context: ContentCreativeProfileContext,
): ContentSuggestionDecision[] {
  const avoidedTopics = new Set<string>();
  const dislikedFormats = new Set<string>();
  const rejectedPatterns = new Set<string>();
  const successfulTopics = new Set<string>();
  const successfulFormats = new Set<string>();
  const successfulHooks = new Set<string>();

  for (const memory of context.memories) {
    const values = parseMemoryList(memory.memoryValue).map((value) => value.toLowerCase());
    if (memory.memoryKey === 'brand.topics_to_avoid') values.forEach((value) => avoidedTopics.add(value));
    if (memory.memoryKey === 'brand.disliked_formats') values.forEach((value) => dislikedFormats.add(value));
    if (memory.memoryKey === 'pattern.rejected_content_patterns') values.forEach((value) => rejectedPatterns.add(value));
    if (memory.memoryKey === 'performance.successful_topics') values.forEach((value) => successfulTopics.add(value));
    if (memory.memoryKey === 'performance.successful_formats') values.forEach((value) => successfulFormats.add(normalizePlatform(value)));
    if (memory.memoryKey === 'performance.successful_hooks') values.forEach((value) => successfulHooks.add(value));
  }

  return suggestions.flatMap((suggestion) => {
    const title = suggestion.title.toLowerCase();
    const topic = (suggestion.topic ?? suggestion.title).toLowerCase();
    const format = normalizePlatform(suggestion.format ?? '');
    const hook = (suggestion.hook ?? '').toLowerCase();
    const reasonCodes: string[] = [];

    if ([...avoidedTopics].some((avoid) => topic.includes(avoid) || title.includes(avoid))) return [];
    if (format && dislikedFormats.has(format)) return [];
    if ([...rejectedPatterns].some((pattern) => title.includes(pattern) || hook.includes(pattern))) return [];

    let score = 1;
    if ([...successfulTopics].some((memoryTopic) => topic.includes(memoryTopic) || title.includes(memoryTopic))) {
      score += 0.4;
      reasonCodes.push('matches_successful_topic_memory');
    }
    if (format && successfulFormats.has(format)) {
      score += 0.25;
      reasonCodes.push('matches_successful_format_memory');
    }
    if ([...successfulHooks].some((memoryHook) => hook.includes(memoryHook))) {
      score += 0.2;
      reasonCodes.push('matches_successful_hook_memory');
    }
    return [{ ...suggestion, score: Math.round(score * 100) / 100, reasonCodes }];
  }).sort((a, b) => b.score - a.score);
}

function buildFollowUpQuestions(missingCriticalKeys: readonly string[], platform: string | null): string[] {
  const questions: string[] = [];
  if (missingCriticalKeys.includes('voice.tone')) {
    questions.push('What tone should Content Creation default to for this creator or brand?');
  }
  if (missingCriticalKeys.includes('brand.audience')) {
    questions.push('Who is the primary audience for this content?');
  }
  if (missingCriticalKeys.includes('brand.content_pillars')) {
    questions.push('What content pillars should guide future ideas?');
  }
  if (platform) {
    questions.push(`Should ${platform.replace(/_/g, ' ')} use any voice differences from the default style?`);
  }
  return questions.slice(0, 3);
}

function formatMemoryValue(value: string): string {
  const list = parseMemoryList(value);
  return list.length > 1 || value.trim().startsWith('[') ? list.join('; ') : value;
}
