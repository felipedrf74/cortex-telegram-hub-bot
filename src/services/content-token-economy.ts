// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import type { ScriptGenerationMode, SourceReference, ScriptResponse } from './content-engine';
import type { DailyQuotaStatus } from './cost-guardrail';
import { contentBigramDice, contentTokenJaccard } from './content-text-utils';

export type ExtendedScriptGenerationMode = ScriptGenerationMode | 'draft';
export type ContentBudgetState = 'healthy' | 'watch' | 'constrained' | 'exhausted';
export type ResearchRoute = 'creator_only' | 'evergreen_cached' | 'fresh_compact' | 'deep_explicit' | 'high_risk_review' | 'unsupported';
export type ContentOperationKind =
  | 'script_draft'
  | 'script_expand'
  | 'script_rewrite'
  | 'hook_pack'
  | 'title_pack'
  | 'caption_pack'
  | 'thumbnail_pack'
  | 'cta_pack'
  | 'shorts_cutdown'
  | 'repurpose'
  | 'competitor_insight'
  | 'seo_insight'
  | 'gap_insight'
  | 'book_source';
export type ContentCostTier = 'low' | 'medium' | 'high';
export type ContentReuseStatus = 'fresh' | 'reused' | 'cached' | 'refreshed';

export interface ContentArtifactRef {
  type: 'voice_card' | 'source_package' | 'research_artifact' | 'draft' | 'script' | 'idea_memory' | 'agent_signal';
  id: string;
  version?: string | null;
  source: 'request' | 'stored' | 'generated' | 'cache';
  expiresAt?: string | null;
}

export interface ContentOperationTrace {
  operation: ContentOperationKind;
  provider: string;
  model: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUsd: number;
  costTier: ContentCostTier;
  cacheStatus: string;
  cacheablePrefixHash: string | null;
  latencyMs: number | null;
  userId?: number;
  tenantId?: number;
}

export interface ContentReusableContext {
  voiceCard?: CreatorVoiceCard | null;
  sourcePackage?: SourcePackage | null;
  priorDraft?: string | null;
  recentHooks?: string[];
  recentAngles?: string[];
  acceptedOutputs?: string[];
  rejectedOutputs?: string[];
  agentDigest?: ContentAgentSignalDigest | null;
}

export interface ContentNextAction {
  id: string;
  label: string;
  action: string;
  operation: ContentOperationKind;
  costTier: ContentCostTier;
  reusePolicy: 'prefer_reuse' | 'force_refresh' | 'no_research';
}

export interface ContentAgentSignalDigest {
  summary: string;
  signals: Array<{
    key: string;
    value: string;
    confidence: 'low' | 'medium' | 'high';
    source: 'idea_memory' | 'performance' | 'creator_profile' | 'manual' | 'computed';
    freshness: 'fresh' | 'recent' | 'stale';
    expiresAt?: string | null;
  }>;
  tokenEstimate: number;
}

export interface ContentClaimLedgerEntry {
  claim: string;
  support: 'source_backed' | 'creator_memory_backed' | 'unverified';
  sourceRef?: string | null;
}

export interface ContentNoveltyResult {
  repeated: boolean;
  warnings: string[];
  matchedRecentItems: string[];
}

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

const OPERATION_CONFIG: Record<ContentOperationKind, {
  promptMode: ExtendedScriptGenerationMode;
  maxPromptTokens: number;
  outputTokens: number;
  costTier: ContentCostTier;
}> = {
  script_draft: { promptMode: 'draft', maxPromptTokens: 1600, outputTokens: 1200, costTier: 'low' },
  script_expand: { promptMode: 'quick', maxPromptTokens: 2200, outputTokens: 1800, costTier: 'medium' },
  script_rewrite: { promptMode: 'draft', maxPromptTokens: 1200, outputTokens: 900, costTier: 'low' },
  hook_pack: { promptMode: 'draft', maxPromptTokens: 700, outputTokens: 450, costTier: 'low' },
  title_pack: { promptMode: 'draft', maxPromptTokens: 750, outputTokens: 500, costTier: 'low' },
  caption_pack: { promptMode: 'draft', maxPromptTokens: 950, outputTokens: 700, costTier: 'low' },
  thumbnail_pack: { promptMode: 'draft', maxPromptTokens: 850, outputTokens: 650, costTier: 'low' },
  cta_pack: { promptMode: 'draft', maxPromptTokens: 650, outputTokens: 350, costTier: 'low' },
  shorts_cutdown: { promptMode: 'quick', maxPromptTokens: 1500, outputTokens: 1100, costTier: 'medium' },
  repurpose: { promptMode: 'quick', maxPromptTokens: 1900, outputTokens: 1800, costTier: 'medium' },
  competitor_insight: { promptMode: 'standard', maxPromptTokens: 2600, outputTokens: 1800, costTier: 'medium' },
  seo_insight: { promptMode: 'standard', maxPromptTokens: 2300, outputTokens: 1500, costTier: 'medium' },
  gap_insight: { promptMode: 'standard', maxPromptTokens: 2400, outputTokens: 1500, costTier: 'medium' },
  book_source: { promptMode: 'deep', maxPromptTokens: 4200, outputTokens: 2600, costTier: 'high' },
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

export function compileContentOperationPrompt(input: {
  operation: ContentOperationKind;
  topic: string;
  language: string;
  reusableContext?: ContentReusableContext;
  sourceSummary?: string[];
  formatContract?: string;
  outputSchema?: string;
  draftContext?: string | null;
  userInstruction?: string | null;
}): CompiledContentPrompt {
  const config = OPERATION_CONFIG[input.operation];
  const sourcePackage = input.reusableContext?.sourcePackage ?? null;
  const voiceCard = input.reusableContext?.voiceCard ?? null;
  const agentDigest = input.reusableContext?.agentDigest ?? null;
  const sourceSummary = input.sourceSummary ?? sourcePackage?.sourceSummaries ?? [];
  const sections: ContentPromptSection[] = [
    {
      sectionName: 'system_policy',
      text: [
        'Nexus Content operation prompt.',
        'Use only the authenticated creator context supplied here.',
        'Reuse artifacts when present. Do not rerun research or invent sources.',
        'Return user-safe output only; do not expose provider diagnostics or internal metadata.',
      ].join('\n'),
      required: true,
      cacheable: true,
      source: 'code',
      maxChars: 900,
    },
    {
      sectionName: 'output_contract',
      text: input.outputSchema || defaultOperationSchema(input.operation),
      required: true,
      cacheable: true,
      source: 'content-domain-ontology',
      maxChars: 900,
    },
    {
      sectionName: 'creator_voice_card',
      text: voiceCard?.promptText ?? 'No stored creator voice card. Use a neutral, topic-led creator voice.',
      required: true,
      cacheable: true,
      source: 'content_knowledge',
      maxChars: 1100,
    },
    {
      sectionName: 'agent_signal_digest',
      text: agentDigest?.summary ?? '',
      required: false,
      cacheable: true,
      source: 'content_agent_signal_digest',
      maxChars: 700,
    },
    {
      sectionName: 'topic_brief',
      text: [
        `Operation: ${input.operation}`,
        `Topic: ${input.topic}`,
        `Language: ${input.language}`,
        input.userInstruction ? `User instruction: ${input.userInstruction}` : '',
      ].filter(Boolean).join('\n'),
      required: true,
      cacheable: false,
      source: 'request',
      maxChars: 900,
    },
    {
      sectionName: 'source_package',
      text: sourceSummary.length
        ? sourceSummary.map((line) => `- ${line}`).join('\n')
        : 'No source package supplied. Avoid factual claims that need citations.',
      required: false,
      cacheable: false,
      source: 'retrieval',
      maxChars: input.operation === 'book_source' ? 1800 : 900,
    },
    {
      sectionName: 'draft_context',
      text: input.draftContext || input.reusableContext?.priorDraft || '',
      required: false,
      cacheable: false,
      source: 'request',
      maxChars: input.operation === 'script_expand' ? 2400 : 1400,
    },
    {
      sectionName: 'format_contract',
      text: input.formatContract || defaultOperationFormatContract(input.operation),
      required: true,
      cacheable: false,
      source: 'content-domain-ontology',
      maxChars: 900,
    },
    {
      sectionName: 'budget_hints',
      text: `Prompt budget ${config.maxPromptTokens} tokens; output budget ${config.outputTokens} tokens; cost tier ${config.costTier}.`,
      required: true,
      cacheable: false,
      source: 'cost-guardrail',
      maxChars: 220,
    },
  ];
  const compiled = compileContentPrompt({ mode: config.promptMode, sections });
  return {
    ...compiled,
    maxTokens: config.maxPromptTokens,
    overBudget: compiled.tokenEstimate > config.maxPromptTokens,
  };
}

function defaultOperationSchema(operation: ContentOperationKind): string {
  switch (operation) {
    case 'hook_pack':
      return 'Return JSON: {"hooks":[{"text":"","pattern":"","risk":"","why":""}],"qualityWarnings":[]}.';
    case 'title_pack':
      return 'Return JSON: {"titles":[{"title":"","label":"","why":""}],"qualityWarnings":[]}.';
    case 'caption_pack':
      return 'Return JSON: {"captions":[{"platform":"","caption":"","cta":""}],"qualityWarnings":[]}.';
    case 'thumbnail_pack':
      return 'Return JSON: {"concepts":[{"visual":"","thumbnailText":"","composition":"","promise":""}],"qualityWarnings":[]}.';
    case 'cta_pack':
      return 'Return JSON: {"ctas":[{"style":"","text":"","bestFor":""}],"qualityWarnings":[]}.';
    case 'shorts_cutdown':
      return 'Return JSON: {"beats":[{"timebox":"","line":"","visual":""}],"qualityWarnings":[]}.';
    case 'competitor_insight':
      return 'Return JSON: {"patterns":[],"gaps":[],"moves":[],"qualityWarnings":[]}.';
    case 'seo_insight':
      return 'Return JSON: {"clusters":[{"keyword":"","intent":"","opportunity":""}],"qualityWarnings":[]}.';
    case 'gap_insight':
      return 'Return JSON: {"gaps":[{"topic":"","angle":"","whyNow":""}],"qualityWarnings":[]}.';
    case 'book_source':
      return 'Return JSON: {"referenceDna":{"thesis":"","frameworks":[],"claimBoundaries":[],"contentAngles":[]},"qualityWarnings":[]}.';
    default:
      return 'Return concise user-facing content and qualityWarnings as JSON where possible.';
  }
}

function defaultOperationFormatContract(operation: ContentOperationKind): string {
  switch (operation) {
    case 'hook_pack':
      return '8-12 short hooks, grouped by pattern. Flag repeated or risky angles.';
    case 'title_pack':
      return '10 titles with curiosity, clarity, and search labels. No clickbait unsupported by the draft.';
    case 'caption_pack':
      return 'Short, medium, LinkedIn-style, Instagram-style, and CTA variants. Preserve language.';
    case 'thumbnail_pack':
      return '3-5 visual concepts with composition, thumbnail text, and emotional promise.';
    case 'repurpose':
      return 'Chunk by target platform. Reuse the existing draft/source package instead of restating the full script.';
    case 'competitor_insight':
    case 'seo_insight':
    case 'gap_insight':
      return 'Use summarized data only. Prefer deterministic scoring and send only top candidates to the model.';
    case 'book_source':
      return 'Extract a reusable ReferenceDNA card once; avoid full book/source dumps in future prompts.';
    default:
      return 'Keep output compact, grounded, and easy to reuse in the next Content action.';
  }
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
    updatedAt: new Date().toISOString(),
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
  const sources = (input.sources ?? [])
    .filter((source) => !isMockContentSource(source))
    .slice(0, input.mode === 'deep' ? 8 : 4);
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

export function isMockContentSource(source: SourceReference | null | undefined): boolean {
  if (!source) return false;
  const title = String(source.title || '').trim();
  const url = String(source.url || '').trim();
  const note = String(source.relevance_note || '').trim();
  return /^\[mock\]/i.test(title)
    || /\bexample\.com\b/i.test(url)
    || /(?:[?&]mock=1\b|\/mock[_-]|watch\?v=mock[_-]|mock_react_|mock_walk_)/i.test(url)
    || /\bmock\b/i.test(note);
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

export function estimateContentOperationCost(input: {
  operation: ContentOperationKind;
  promptTokens: number;
}): ContentCostEstimate & { costTier: ContentCostTier } {
  const config = OPERATION_CONFIG[input.operation];
  const estimate = estimateContentGenerationCost({
    mode: config.promptMode,
    promptTokens: input.promptTokens,
    outputTokens: config.outputTokens,
  });
  return { ...estimate, costTier: config.costTier };
}

export function buildContentOperationTrace(input: {
  operation: ContentOperationKind;
  prompt: { tokenEstimate: number; cacheablePrefixHash?: string | null };
  provider?: string;
  model?: string;
  cacheStatus?: string;
  latencyMs?: number | null;
  userId?: number;
  tenantId?: number;
}): ContentOperationTrace {
  const estimate = estimateContentOperationCost({
    operation: input.operation,
    promptTokens: input.prompt.tokenEstimate,
  });
  return {
    operation: input.operation,
    provider: input.provider || 'content-engine',
    model: input.model || 'routed',
    estimatedInputTokens: estimate.estimatedInputTokens,
    estimatedOutputTokens: estimate.estimatedOutputTokens,
    estimatedCostUsd: estimate.estimatedCostUsd,
    costTier: estimate.costTier,
    cacheStatus: input.cacheStatus || 'unknown',
    cacheablePrefixHash: input.prompt.cacheablePrefixHash || null,
    latencyMs: input.latencyMs ?? null,
    userId: input.userId,
    tenantId: input.tenantId,
  };
}

export function buildContentArtifactRefs(input: {
  voiceCard?: CreatorVoiceCard | null;
  sourcePackage?: SourcePackage | null;
  draftId?: string | null;
  scriptId?: string | null;
  agentDigest?: ContentAgentSignalDigest | null;
}): ContentArtifactRef[] {
  const refs: ContentArtifactRef[] = [];
  if (input.voiceCard) {
    refs.push({
      type: 'voice_card',
      id: `voice_${input.voiceCard.creatorId}_${input.voiceCard.voiceCardVersion}`,
      version: input.voiceCard.voiceCardVersion,
      source: 'generated',
      expiresAt: null,
    });
  }
  if (input.sourcePackage) {
    refs.push({
      type: 'source_package',
      id: input.sourcePackage.sourcePackageId,
      version: input.sourcePackage.topicHash,
      source: 'stored',
      expiresAt: input.sourcePackage.expiresAt,
    });
    refs.push({
      type: 'research_artifact',
      id: input.sourcePackage.researchArtifactId,
      version: input.sourcePackage.topicHash,
      source: 'stored',
      expiresAt: input.sourcePackage.expiresAt,
    });
  }
  if (input.draftId) refs.push({ type: 'draft', id: input.draftId, source: 'request', expiresAt: null });
  if (input.scriptId) refs.push({ type: 'script', id: input.scriptId, source: 'request', expiresAt: null });
  if (input.agentDigest?.signals.length) {
    refs.push({ type: 'agent_signal', id: stableHash(input.agentDigest.summary), source: 'generated', expiresAt: null });
  }
  return refs;
}

export function buildContentNextActions(input: {
  mode: ExtendedScriptGenerationMode;
  budgetState?: ContentBudgetState;
  hasSourcePackage?: boolean;
}): ContentNextAction[] {
  if (input.budgetState === 'exhausted') {
    return [
      { id: 'rewrite-hook', label: 'Rewrite hook', action: 'rewrite_hook', operation: 'script_rewrite', costTier: 'low', reusePolicy: 'prefer_reuse' },
    ];
  }
  const base: ContentNextAction[] = [
    { id: 'hook-pack', label: 'Hook pack', action: 'hook_pack', operation: 'hook_pack', costTier: 'low', reusePolicy: 'prefer_reuse' },
    { id: 'title-pack', label: 'Title pack', action: 'title_pack', operation: 'title_pack', costTier: 'low', reusePolicy: 'prefer_reuse' },
    { id: 'caption-pack', label: 'Caption pack', action: 'caption_pack', operation: 'caption_pack', costTier: 'low', reusePolicy: 'prefer_reuse' },
    { id: 'thumbnail-pack', label: 'Thumbnail pack', action: 'thumbnail_pack', operation: 'thumbnail_pack', costTier: 'low', reusePolicy: 'prefer_reuse' },
  ];
  if (input.mode === 'draft') {
    base.unshift({ id: 'expand-full', label: 'Expand full script', action: 'expand_full', operation: 'script_expand', costTier: 'medium', reusePolicy: 'prefer_reuse' });
  }
  base.push({ id: 'refresh-research', label: 'Refresh research', action: 'refresh_research', operation: 'script_draft', costTier: 'medium', reusePolicy: 'force_refresh' });
  return input.hasSourcePackage ? base : base.filter((action) => action.action !== 'refresh_research');
}

export function buildClaimLedger(input: {
  text: string;
  sourcePackage?: SourcePackage | null;
  voiceCard?: CreatorVoiceCard | null;
}): ContentClaimLedgerEntry[] {
  const sentences = input.text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 24 && /(\d|%|research|study|estudo|dados|people|users|clientes|sempre|always|never|nunca)/i.test(sentence))
    .slice(0, 12);
  const sourceText = (input.sourcePackage?.sourceSummaries ?? []).join(' ').toLowerCase();
  const voiceText = input.voiceCard?.promptText.toLowerCase() ?? '';
  return sentences.map((claim) => {
    const terms = claim.toLowerCase().split(/\W+/).filter((term) => term.length > 4).slice(0, 8);
    const sourceMatches = terms.filter((term) => sourceText.includes(term)).length;
    const voiceMatches = terms.filter((term) => voiceText.includes(term)).length;
    if (sourceMatches >= 2) {
      return { claim, support: 'source_backed', sourceRef: input.sourcePackage?.sourcePackageId ?? null };
    }
    if (voiceMatches >= 2) {
      return { claim, support: 'creator_memory_backed', sourceRef: input.voiceCard?.voiceCardVersion ?? null };
    }
    return { claim, support: 'unverified', sourceRef: null };
  });
}

export function buildContentAgentSignalDigest(input: {
  recentHooks?: string[];
  recentAngles?: string[];
  acceptedOutputs?: string[];
  rejectedOutputs?: string[];
}): ContentAgentSignalDigest {
  const signals: ContentAgentSignalDigest['signals'] = [];
  const topHook = input.recentHooks?.find(Boolean);
  if (topHook) signals.push({ key: 'recent_hook', value: topHook.slice(0, 140), confidence: 'medium', source: 'idea_memory', freshness: 'recent' });
  const overused = (input.recentAngles ?? []).find((angle, index, all) => all.findIndex((other) => other.toLowerCase() === angle.toLowerCase()) !== index);
  if (overused) signals.push({ key: 'overused_angle', value: overused.slice(0, 140), confidence: 'high', source: 'computed', freshness: 'fresh' });
  if (input.acceptedOutputs?.length) signals.push({ key: 'accepted_pattern', value: input.acceptedOutputs[0].slice(0, 140), confidence: 'medium', source: 'performance', freshness: 'recent' });
  if (input.rejectedOutputs?.length) signals.push({ key: 'avoid_pattern', value: input.rejectedOutputs[0].slice(0, 140), confidence: 'medium', source: 'performance', freshness: 'recent' });
  const summary = signals.length
    ? signals.map((signal) => `${signal.key}: ${signal.value}`).join('\n').slice(0, 700)
    : 'No reliable agent signal digest yet. Use only the current topic, voice card, and source package.';
  return { summary, signals, tokenEstimate: estimateContentTokens(summary) };
}

export function noveltyCheck(input: {
  hook?: string | null;
  angle?: string | null;
  recentHooks?: string[];
  recentAngles?: string[];
}): ContentNoveltyResult {
  const warnings: string[] = [];
  const matchedRecentItems: string[] = [];
  const hook = (input.hook || '').trim().toLowerCase();
  const angle = (input.angle || '').trim().toLowerCase();
  for (const recent of input.recentHooks ?? []) {
    if (hook && isSimilarNoveltyText(hook, recent)) {
      warnings.push('repeated_hook_detected');
      matchedRecentItems.push(recent);
      break;
    }
  }
  for (const recent of input.recentAngles ?? []) {
    if (angle && isSimilarNoveltyText(angle, recent)) {
      warnings.push('repeated_angle_detected');
      matchedRecentItems.push(recent);
      break;
    }
  }
  return { repeated: warnings.length > 0, warnings, matchedRecentItems };
}

function similarityBucket(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 3)
    .slice(0, 8)
    .sort()
    .join('|');
}

function isSimilarNoveltyText(left: string, right: string): boolean {
  const normalizedLeft = normalizeNoveltyText(left);
  const normalizedRight = normalizeNoveltyText(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (similarityBucket(normalizedLeft) === similarityBucket(normalizedRight)) return true;
  return Math.max(
    contentTokenJaccard(normalizedLeft, normalizedRight),
    contentBigramDice(normalizedLeft, normalizedRight),
  ) >= 0.72;
}

function normalizeNoveltyText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
