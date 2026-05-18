// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import type { ScriptGenerationMode, SourceReference, ScriptResponse } from './content-engine';
import type { DailyQuotaStatus } from './cost-guardrail';

export type ExtendedScriptGenerationMode = ScriptGenerationMode | 'draft';
export type ContentBudgetState = 'healthy' | 'watch' | 'constrained' | 'exhausted';
export type ResearchRoute = 'creator_only' | 'evergreen_cached' | 'fresh_compact' | 'deep_explicit' | 'high_risk_review' | 'unsupported';

export interface ContentPromptSection {
  sectionName: string;
  text: string;
  required: boolean;
  cacheable: boolean;
  source: string;
  maxChars: number;
}

export interface CompiledContentPromptSection extends ContentPromptSection {
  tokenEstimate: number;
  truncated: boolean;
}

export interface CompiledContentPrompt {
  prompt: string;
  tokenEstimate: number;
  maxTokens: number;
  overBudget: boolean;
  cacheablePrefixHash: string;
  sections: CompiledContentPromptSection[];
}

export interface CreatorVoiceCard {
  creatorId: number;
  tenantId: number;
  voiceCardVersion: string;
  tone: string;
  pacing: string;
  phrasesToUse: string[];
  phrasesToAvoid: string[];
  contentPillars: string[];
  audience: string;
  formatPreferences: string[];
  ctaStyle: string;
  examplesCompressed: string;
  sourceHash: string;
  updatedAt: string;
  promptText: string;
}

export interface SourcePackage {
  sourcePackageId: string;
  researchArtifactId: string;
  topicHash: string;
  freshnessClass: 'cached' | 'fresh' | 'deep' | 'none';
  language: string;
  format: string;
  sources: SourceReference[];
  sourceSummaries: string[];
  claims: string[];
  unsafeOrUnverifiedClaims: string[];
  expiresAt: string;
  tokenEstimate: number;
}

export interface ContentCostEstimate {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUsd: number;
  costConfidence: 'low' | 'medium' | 'high';
}

export interface ContentQualityGateResult {
  qualityScore: number;
  qualityWarnings: string[];
  needsExpansion: boolean;
  needsResearchRefresh: boolean;
}

const PROMPT_BUDGETS: Record<ExtendedScriptGenerationMode, number> = {
  draft: 1600,
  quick: 2200,
  standard: 3200,
  deep: 6500,
};

const OUTPUT_BUDGETS: Record<ExtendedScriptGenerationMode, number> = {
  draft: 1200,
  quick: 2200,
  standard: 3800,
  deep: 7000,
};

export function estimateContentTokens(value: string): number {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return 0;
  return Math.ceil(normalized.length / 4);
}

function stableHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function compactLines(value: string, maxChars: number): { text: string; truncated: boolean } {
  const normalized = value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
  if (normalized.length <= maxChars) return { text: normalized, truncated: false };
  return { text: normalized.slice(0, Math.max(0, maxChars - 18)).trimEnd() + '\n[truncated]', truncated: true };
}

export function compileContentPrompt(input: {
  mode: ExtendedScriptGenerationMode;
  sections: ContentPromptSection[];
}): CompiledContentPrompt {
  const budget = PROMPT_BUDGETS[input.mode] ?? PROMPT_BUDGETS.standard;
  const compiledSections = input.sections.map((section) => {
    const compacted = compactLines(section.text, section.maxChars);
    return {
      ...section,
      text: compacted.text,
      truncated: compacted.truncated,
      tokenEstimate: estimateContentTokens(compacted.text),
    };
  });
  const prompt = compiledSections
    .filter((section) => section.required || section.text.length > 0)
    .map((section) => `[${section.sectionName}]\n${section.text}`)
    .join('\n\n');
  const tokenEstimate = estimateContentTokens(prompt);
  const cacheablePrefix = compiledSections
    .filter((section) => section.cacheable && (section.required || section.text.length > 0))
    .map((section) => `[${section.sectionName}]\n${section.text}`)
    .join('\n\n');
  return {
    prompt,
    tokenEstimate,
    maxTokens: budget,
    overBudget: tokenEstimate > budget,
    cacheablePrefixHash: stableHash(cacheablePrefix),
    sections: compiledSections,
  };
}

function splitVoiceLines(value: string, pattern: RegExp, limit: number): string[] {
  return value
    .split(/\n+/)
    .map((line) => line.replace(/^\[[^\]]+\]\s*/, '').trim())
    .filter((line) => pattern.test(line))
    .slice(0, limit);
}

export function buildCreatorVoiceCard(input: {
  tenantId: number;
  userId: number;
  language: string;
  niche: string;
  voiceMemory?: string | null;
}): CreatorVoiceCard {
  const source = (input.voiceMemory || '').trim();
  const sourceHash = stableHash(`${input.tenantId}:${input.userId}:${input.language}:${input.niche}:${source}`);
  const phrasesToUse = splitVoiceLines(source, /phrase|hook|cta|voz|frase|chamada/i, 6);
  const contentPillars = splitVoiceLines(source, /pillar|estrutura|story|content|conte[uú]do|niche/i, 5);
  const compact = compactLines(source || 'No saved creator voice yet. Use a neutral, topic-led voice.', 1400).text;
  const promptText = [
    `Voice card version: ${sourceHash}`,
    `Language: ${input.language}`,
    `Audience/niche: ${input.niche || 'general'}`,
    'Use this as style guidance only. Do not quote it verbatim.',
    compact,
  ].join('\n');
  return {
    creatorId: input.userId,
    tenantId: input.tenantId,
    voiceCardVersion: sourceHash,
    tone: source ? 'user_scoped' : 'neutral_topic_led',
    pacing: source ? 'match_saved_creator_patterns' : 'clear_and_concise',
    phrasesToUse,
    phrasesToAvoid: ['generic motivation', 'unsupported guarantees', 'another creator identity'],
    contentPillars,
    audience: input.niche || 'general',
    formatPreferences: [],
    ctaStyle: phrasesToUse.find((line) => /cta|call|chamada/i.test(line)) || 'single clear next action',
    examplesCompressed: compact,
    sourceHash,
    updatedAt: new Date(0).toISOString(),
    promptText,
  };
}

const TIMELY_PATTERN = /\b(today|now|latest|breaking|this week|202[5-9]|hoje|agora|últim[ao]s?|semana|not[ií]cia|lançamento)\b/i;
const HIGH_RISK_PATTERN = /\b(medical|medicine|medication|drug|dose|dosage|diagnosis|treatment|therapy|ibuprofen|migraine|depression|anxiety|diet|fasting|blood pressure|legal|lawsuit|tax advice|investment advice|tratamento|diagn[oó]stico|rem[eé]dio|medicamento|dose|enxaqueca|depress[aã]o|ansiedade|dieta|jejum|press[aã]o arterial|jur[ií]dico|imposto|investimento)\b/i;
const CREATOR_ONLY_PATTERN = /\b(my audience|my voice|my content pillars|my channel|meu p[uú]blico|minha voz|meus pilares|meu canal)\b/i;
const UNSUPPORTED_PATTERN = /\b(hack account|steal|piracy|plagiarize exactly|roubar conta|copiar exatamente)\b/i;

export function routeContentResearch(input: {
  topic: string;
  mode: ExtendedScriptGenerationMode;
  forceRefresh?: boolean;
}): { route: ResearchRoute; freshnessClass: SourcePackage['freshnessClass']; allowDeepSearch: boolean; reason: string } {
  const topic = input.topic.trim();
  if (UNSUPPORTED_PATTERN.test(topic)) {
    return { route: 'unsupported', freshnessClass: 'none', allowDeepSearch: false, reason: 'unsupported_or_abusive_topic' };
  }
  if (HIGH_RISK_PATTERN.test(topic)) {
    return { route: 'high_risk_review', freshnessClass: 'fresh', allowDeepSearch: input.mode === 'deep', reason: 'high_risk_source_grounding_required' };
  }
  if (CREATOR_ONLY_PATTERN.test(topic)) {
    return { route: 'creator_only', freshnessClass: 'none', allowDeepSearch: false, reason: 'creator_context_only' };
  }
  if (input.mode === 'deep') {
    return { route: 'deep_explicit', freshnessClass: 'deep', allowDeepSearch: true, reason: 'explicit_deep_mode' };
  }
  if (input.forceRefresh || TIMELY_PATTERN.test(topic)) {
    return { route: 'fresh_compact', freshnessClass: 'fresh', allowDeepSearch: false, reason: 'timely_or_refresh_compact_research' };
  }
  return { route: 'evergreen_cached', freshnessClass: 'cached', allowDeepSearch: false, reason: 'evergreen_or_draft_default' };
}

export function buildSourcePackage(input: {
  topic: string;
  language: string;
  format: string;
  mode: ExtendedScriptGenerationMode;
  sources?: SourceReference[] | null;
  warnings?: string[] | null;
}): SourcePackage {
  const sources = (input.sources ?? []).slice(0, input.mode === 'deep' ? 8 : 4);
  const topicHash = stableHash(input.topic.toLowerCase().trim());
  const sourceSummaries = sources.map((source) => [source.title, source.relevance_note].filter(Boolean).join(' — ').slice(0, 260));
  const unsafe = (input.warnings ?? []).filter((warning) => /unsupported|unverified|review/i.test(warning));
  const sourceFingerprint = stableHash([
    input.language,
    input.format,
    ...sources.map((s) => [s.title, s.url, s.relevance_note].filter(Boolean).join('::')),
    ...sourceSummaries,
  ].join('|'));
  return {
    sourcePackageId: `sp_${topicHash}_${sourceFingerprint}`,
    researchArtifactId: `ra_${topicHash}_${stableHash(`${input.language}|${input.format}`)}`,
    topicHash,
    freshnessClass: input.mode === 'deep' ? 'deep' : sources.length > 0 ? 'cached' : 'none',
    language: input.language,
    format: input.format,
    sources,
    sourceSummaries,
    claims: sourceSummaries.slice(0, 8),
    unsafeOrUnverifiedClaims: unsafe,
    expiresAt: new Date(Date.now() + (input.mode === 'deep' ? 6 : 48) * 3600_000).toISOString(),
    tokenEstimate: estimateContentTokens(sourceSummaries.join('\n')),
  };
}

export function lintSourcePackage(pkg: SourcePackage): string[] {
  const warnings: string[] = [];
  const urls = new Set<string>();
  for (const source of pkg.sources) {
    if (source.url && urls.has(source.url)) warnings.push('duplicate_source_removed_or_review_required');
    if (source.url) urls.add(source.url);
    if ((source.relevance_note || '').length > 500) warnings.push('source_note_too_long');
  }
  if (pkg.tokenEstimate > 900) warnings.push('source_package_over_budget');
  if (pkg.sources.length === 0) warnings.push('no_source_package_available');
  return [...new Set(warnings)];
}

export function estimateContentGenerationCost(input: {
  mode: ExtendedScriptGenerationMode;
  promptTokens: number;
  outputTokens?: number;
}): ContentCostEstimate {
  const outputTokens = input.outputTokens ?? OUTPUT_BUDGETS[input.mode] ?? OUTPUT_BUDGETS.standard;
  const blendedInputPer1k = input.mode === 'deep' ? 0.0015 : input.mode === 'standard' ? 0.0008 : 0.00035;
  const blendedOutputPer1k = input.mode === 'deep' ? 0.004 : input.mode === 'standard' ? 0.002 : 0.0012;
  return {
    estimatedInputTokens: input.promptTokens,
    estimatedOutputTokens: outputTokens,
    estimatedCostUsd: Number(((input.promptTokens / 1000) * blendedInputPer1k + (outputTokens / 1000) * blendedOutputPer1k).toFixed(6)),
    costConfidence: input.mode === 'deep' ? 'medium' : 'high',
  };
}

export function budgetStateFromQuota(quota: Pick<DailyQuotaStatus, 'over' | 'usageFraction'>): ContentBudgetState {
  if (quota.over) return 'exhausted';
  if (quota.usageFraction >= 0.9) return 'constrained';
  if (quota.usageFraction >= 0.7) return 'watch';
  return 'healthy';
}

export function qualityGateContent(input: {
  mode: ExtendedScriptGenerationMode;
  response: ScriptResponse;
  route: ResearchRoute;
  sourcePackage: SourcePackage;
}): ContentQualityGateResult {
  const text = [input.response.script, input.response.hook, input.response.caption, input.response.cta].filter(Boolean).join('\n');
  const warnings = new Set<string>();
  if (text.length < (input.mode === 'draft' ? 200 : 700)) warnings.add('output_too_thin');
  if (!input.response.hook || input.response.hook.length < 18) warnings.add('weak_hook');
  if (!input.response.cta || input.response.cta.length < 8) warnings.add('missing_clear_cta');
  if (input.route === 'high_risk_review' && input.sourcePackage.sources.length === 0) warnings.add('high_risk_without_sources');
  if (/guaranteed|100%|always works|garantido|sempre funciona/i.test(text)) warnings.add('unsupported_absolute_claim_review');
  if (/ignore previous instructions|system prompt|raw_provider_output|internal_id/i.test(text)) warnings.add('unsafe_prompt_artifact_review');
  const qualityScore = Math.max(0, 100 - warnings.size * 12 - (input.sourcePackage.unsafeOrUnverifiedClaims.length * 5));
  return {
    qualityScore,
    qualityWarnings: [...warnings],
    needsExpansion: input.mode === 'draft',
    needsResearchRefresh: warnings.has('high_risk_without_sources'),
  };
}
