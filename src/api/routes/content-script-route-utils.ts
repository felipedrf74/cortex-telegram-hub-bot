// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { buildGenerationMeta, type GenerationMode } from './content-generation-meta';
import {
  analyzeAndImproveScript,
  buildScriptPreflightBrief,
  type ScriptPreflightBrief,
  type ScriptQualityReport,
} from '../../services/content-script-quality';
import type {
  CompiledContentPrompt,
  ContentBudgetState,
  ContentCostEstimate,
  ContentQualityGateResult,
  CreatorVoiceCard,
  ResearchRoute,
  SourcePackage,
} from '../../services/content-token-economy';
import {
  buildClaimLedger,
  buildContentArtifactRefs,
  buildContentNextActions,
  buildContentOperationTrace,
  isMockContentSource,
  type ContentOperationKind,
} from '../../services/content-token-economy';
import {
  buildContentResearchPackage,
  researchPublishabilityBlockers,
  type ContentResearchPackage,
} from '../../services/content-research-package';
import type { NormalizedScriptFormat } from './content-script-utils';
import type { CreatorVoiceBrandCardV2 } from '../../services/content-voice-brand-card';

export type ScriptRenderMode = 'structured' | 'chat';
export type ScriptFormat = NormalizedScriptFormat;
export type ScriptStyle = 'detailed' | 'bullets';

interface ContentKnowledgeLike {
  category?: string | null;
  synthesized_text?: string | null;
}

export interface ScriptSourceUsed {
  title?: string;
  url?: string;
  source_type?: string;
  relevance_note?: string;
}

export interface ContentScriptEngineResult {
  topic: string;
  script: string;
  hook?: string;
  title_options?: string[];
  sources_used?: ScriptSourceUsed[] | null;
  estimated_duration?: string;
  duration_ms?: number;
  hashtags?: string[];
  caption?: string;
  cta?: string;
  degraded?: boolean;
  warnings?: string[];
  generation_mode?: string;
  cache_status?: string;
  research_artifact_id?: string;
  source_package_id?: string;
  voice_card_version?: string;
  quality_score?: number;
  quality_warnings?: string[];
  budget_state?: string;
  expand_options?: Array<{ id: string; label: string; action: string }>;
  estimated_cost?: Record<string, unknown>;
  actual_cost?: Record<string, unknown>;
  prompt_budget?: Record<string, unknown>;
  research_route?: Record<string, unknown>;
  context_signals_used?: Array<{
    type?: string;
    source?: string;
    value?: string;
  }>;
}

export type ContentModeDowngradeReason =
  | 'none'
  | 'budget_constrained'
  | 'force_draft_only'
  | 'deep_research_disabled'
  | 'fresh_research_disabled'
  | 'longform_disabled'
  | 'high_risk_draft_only';

export function resolveScriptGenerationMode(mode: unknown): GenerationMode {
  if (typeof mode !== 'string') return 'draft';
  const normalized = mode.trim().toLowerCase();
  return normalized === 'draft' || normalized === 'quick' || normalized === 'standard' || normalized === 'deep'
    ? normalized
    : 'draft';
}

export function resolveScriptRenderMode(renderMode: unknown): ScriptRenderMode {
  if (typeof renderMode !== 'string') return 'structured';
  const normalized = renderMode.trim().toLowerCase();
  return normalized === 'structured' || normalized === 'chat'
    ? normalized
    : 'structured';
}

export function resolveScriptStyle(style: unknown): ScriptStyle {
  if (typeof style !== 'string') return 'detailed';
  const normalized = style.trim().toLowerCase();
  if (['bullet', 'bullets', 'outline', 'pontos'].includes(normalized) || normalized.includes('ponto')) return 'bullets';
  if (
    ['detailed', 'full', 'script', 'roteiro', 'completo'].includes(normalized)
    || normalized.includes('roteiro')
    || normalized.includes('complete')
  ) return 'detailed';
  return 'detailed';
}

export function resolveScriptTargetLanguage(
  language: unknown,
  userId: number,
  readUserLanguage: (userId: number) => string | undefined | null,
): string {
  if (typeof language === 'string' && language.trim().length > 0) {
    return language.trim();
  }

  try {
    return readUserLanguage(userId) || 'pt-BR';
  } catch {
    return 'pt-BR';
  }
}

export function buildUserVoiceMemory(
  userId: number,
  readAllKnowledge: (userId: number) => ContentKnowledgeLike[],
): string | null {
  try {
    const knowledge = readAllKnowledge(userId) || [];
    const preferredCategories = [
      'brand_voice',
      'voice_summary',
      'voice_pattern',
      'voice_phrase_trend',
      'hook_style',
      'storytelling',
      'content_structure',
      'cta_pattern',
      'audience_engagement',
    ];
    const byCategory = new Map<string, string>();

    for (const entry of knowledge) {
      const category = (entry.category || '').trim();
      const text = (entry.synthesized_text || '').trim();
      if (!category || !text || byCategory.has(category)) continue;
      byCategory.set(category, text);
    }

    const lines = preferredCategories
      .map((category) => {
        const text = byCategory.get(category);
        return text ? `[${category}] ${text}` : null;
      })
      .filter((line): line is string => Boolean(line));

    if (lines.length === 0) return null;
    return lines.join('\n\n').slice(0, 6000);
  } catch {
    return null;
  }
}

export function buildScriptCreatorProfile(params: {
  language: string;
  niche?: string | null;
  voiceMemory?: string | null;
}): string {
  const language = params.language?.trim() || 'pt-BR';
  const niche = params.niche?.trim() || 'general';
  const lines = [
    'Creator scope: current authenticated Nexus Hub user only.',
    `Primary output language: ${language}.`,
    `Requested niche/context: ${niche}.`,
  ];

  const voiceMemory = params.voiceMemory?.trim();
  if (voiceMemory) {
    lines.push(
      'User-scoped Voice DNA follows. Apply it to sentence rhythm, stance, vocabulary, examples, and CTA style without quoting it verbatim.',
      voiceMemory.slice(0, 6000),
    );
  } else {
    lines.push(
      'No stored Voice DNA exists yet. Use a neutral creator voice grounded in this topic, niche, language, and research. Do not borrow another creator identity, brand, audience, politics, biography, or hashtags.',
    );
  }

  return lines.join('\n');
}

export function buildScriptSuccessResponse(params: {
  result: ContentScriptEngineResult;
  format: ScriptFormat;
  renderMode: ScriptRenderMode;
  scriptStyle: ScriptStyle;
  requestedMode?: GenerationMode;
  generationMode: GenerationMode;
  downgradeReason?: ContentModeDowngradeReason;
  startMs: number;
  cacheHit: boolean;
  generationQuality?: Record<string, unknown>;
  preflightBrief?: ScriptPreflightBrief;
  promptBudget?: CompiledContentPrompt;
  creatorVoiceCard?: CreatorVoiceCard;
  sourcePackage?: SourcePackage;
  publicSourcePackageIds?: { sourcePackageId: string; researchArtifactId: string };
  researchRoute?: { route: ResearchRoute; reason: string; allowDeepSearch: boolean };
  estimatedCost?: ContentCostEstimate;
  budgetState?: ContentBudgetState;
  qualityGate?: ContentQualityGateResult;
  researchPackage?: ContentResearchPackage;
}) {
  const {
    result,
    format,
    renderMode,
    scriptStyle,
    requestedMode,
    generationMode,
    downgradeReason,
    startMs,
    cacheHit,
    generationQuality,
    preflightBrief,
    promptBudget,
    creatorVoiceCard,
    sourcePackage,
    publicSourcePackageIds,
    researchRoute,
    estimatedCost,
    budgetState,
    qualityGate,
    researchPackage: providedResearchPackage,
  } = params;

  const rawSources = Array.isArray(result.sources_used) ? result.sources_used : [];
  const sources = rawSources.filter((source) => !isMockContentSource({
    title: source.title || '',
    url: source.url || '',
    source_type: source.source_type || '',
    relevance_note: source.relevance_note || '',
  }));
  const excludedMockSources = rawSources.length - sources.length;
  const researchPackage = providedResearchPackage ?? buildContentResearchPackage({
    topic: result.topic,
    query: result.topic,
    route: researchRoute?.route ?? (result.research_route as any)?.route ?? null,
    sourcePackage: sourcePackage ?? null,
    rawSources,
    sourceOrigin: 'server_fetched',
    degraded: result.degraded,
    cacheStatus: result.cache_status,
    warnings: result.warnings,
  });
  const voiceBrandCard = creatorVoiceCard as CreatorVoiceBrandCardV2 | undefined;
  const scriptQuality = analyzeAndImproveScript({
    topic: result.topic,
    script: result.script,
    hook: result.hook,
    titleOptions: result.title_options,
    cta: result.cta,
    sources,
    format,
    preflightBrief: preflightBrief ?? buildScriptPreflightBrief({
      topic: result.topic,
      format,
      cta: result.cta,
      sources,
      voiceFitCriteria: voiceBrandCard?.voiceFitCriteria,
    }),
  });
  const generationQualityRecord = generationQuality ?? {};
  const sourceGrounding = typeof generationQualityRecord.sourceGrounding === 'string'
    ? generationQualityRecord.sourceGrounding
    : null;
  const providerFallback = result.cache_status === 'fallback'
    || (result.quality_warnings ?? []).includes('provider_fallback_review_required');
  const lowTrustGeneration = providerFallback
    || sourceGrounding === 'ungrounded'
    || researchPackage.sourceMode === 'mock'
    || researchPackage.sourceMode === 'degraded';
  const warnings = Array.from(new Set([
    ...(result.warnings ?? []),
    ...researchPackage.warnings,
    ...scriptQuality.complianceWarnings,
    ...(qualityGate?.qualityWarnings ?? []),
    ...(providerFallback ? ['provider_fallback_review_required'] : []),
    ...(sourceGrounding === 'ungrounded' ? ['source_grounding_review_required'] : []),
    ...(excludedMockSources > 0 ? ['mock_sources_excluded'] : []),
  ]));
  const qualityBlockers = Array.from(new Set([
    ...scriptQuality.blockers,
    ...(providerFallback ? ['provider_fallback_review_required'] : []),
    ...(sourceGrounding === 'ungrounded' ? ['source_grounding_review_required'] : []),
    ...researchPublishabilityBlockers(researchPackage),
  ]));
  const rawQualityScore = qualityGate?.qualityScore
    ?? (typeof result.quality_score === 'number' ? result.quality_score : scriptQuality.overallScore);
  const effectiveQualityScore = lowTrustGeneration
    ? Math.min(rawQualityScore, 49)
    : rawQualityScore;
  const expandOptions = result.expand_options ?? defaultExpandOptions(generationMode);
  const enginePromptBudget = normalizeEnginePromptBudget(result.prompt_budget);
  const publicPromptBudget = enginePromptBudget ?? (promptBudget ? {
    tokenEstimate: promptBudget.tokenEstimate,
    maxTokens: promptBudget.maxTokens,
    overBudget: promptBudget.overBudget,
    cacheablePrefixHash: promptBudget.cacheablePrefixHash,
    sections: promptBudget.sections.map((section) => ({
      sectionName: section.sectionName,
      tokenEstimate: section.tokenEstimate,
      required: section.required,
      cacheable: section.cacheable,
      source: publicPromptSectionSource(section.source),
      truncated: section.truncated,
    })),
  } : null);
  const publicQualityWarnings = warnings.map(publicQualityWarningText);
  const hasSourcePackageContents = Boolean(sourcePackage && (sourcePackage.sources.length > 0 || sourcePackage.sourceSummaries.length > 0));
  const hasReusableSourcePackage = Boolean(hasSourcePackageContents || publicSourcePackageIds);
  const nextActions = buildContentNextActions({
    mode: generationMode,
    budgetState: (result.budget_state as ContentBudgetState | undefined) ?? budgetState,
    hasSourcePackage: hasReusableSourcePackage,
  });
  const artifactRefs = buildContentArtifactRefs({
    voiceCard: creatorVoiceCard ?? null,
    sourcePackage: hasSourcePackageContents ? (sourcePackage ?? null) : null,
  });
  const operationKind: ContentOperationKind = generationMode === 'draft' ? 'script_draft' : 'script_expand';
  const operationTrace = buildContentOperationTrace({
    operation: operationKind,
    prompt: {
      tokenEstimate: publicPromptBudget?.tokenEstimate ?? promptBudget?.tokenEstimate ?? 0,
      cacheablePrefixHash: publicPromptBudget?.cacheablePrefixHash ?? promptBudget?.cacheablePrefixHash ?? null,
    },
    provider: 'content-engine',
    model: result.actual_cost?.model as string || 'routed',
    cacheStatus: result.cache_status ?? (cacheHit ? 'hit' : 'miss'),
    latencyMs: typeof result.duration_ms === 'number' ? result.duration_ms : Date.now() - startMs,
  });
  const claimLedger = buildClaimLedger({
    text: scriptQuality.revisedScript,
    sourcePackage: hasSourcePackageContents ? (sourcePackage ?? null) : null,
    voiceCard: creatorVoiceCard ?? null,
  });
  const agentSignalDigest = buildEngineAgentSignalDigest(result.context_signals_used ?? []);
  // 2026-05-18 phase2-qa P2: previously defaulted to 'reused' even when
  // nothing was reused (no source package, non-deep mode). Now honestly
  // reports 'fresh' for that case.
  const reuseStatus = cacheHit
    ? 'cached'
    : hasReusableSourcePackage
      ? 'reused'
      : 'fresh';

  return {
    topic: result.topic,
    script: scriptQuality.revisedScript,
    hook: scriptQuality.structuredOutput.firstThreeSeconds || result.hook,
    titleOptions: result.title_options,
    sourcesUsed: sources.map((source) => ({
      title: source.title,
      url: source.url,
      sourceType: source.source_type,
      relevanceNote: source.relevance_note,
    })),
    estimatedDuration: result.estimated_duration,
    format,
    renderMode,
    scriptStyle,
    durationMs: result.duration_ms,
    hashtags: result.hashtags ?? [],
    caption: result.caption ?? '',
    cta: result.cta || scriptQuality.structuredOutput.cta,
    degraded: result.degraded ?? false,
    warnings: publicQualityWarnings,
    generationQuality,
    contentCost: {
      estimatedBeforeCall: estimatedCost,
      actualAfterCall: result.actual_cost ?? null,
      providerCache: {
        status: result.cache_status ?? (cacheHit ? 'hit' : 'miss'),
        cacheablePrefixHash: publicPromptBudget?.cacheablePrefixHash ?? null,
        cacheCreationTokens: null,
        cacheReadTokens: null,
      },
    },
    promptBudget: publicPromptBudget,
    research: {
      route: researchRoute?.route ?? (result.research_route as any)?.route ?? null,
      reason: researchRoute?.reason ?? (result.research_route as any)?.reason ?? null,
      allowDeepSearch: researchRoute?.allowDeepSearch ?? (result.research_route as any)?.allowDeepSearch ?? null,
      freshnessClass: researchPackage.freshnessClass ?? 'unknown',
      sourceMode: researchPackage.sourceMode,
      sourceCount: researchPackage.sourceCount,
      realSourceCount: researchPackage.realSourceCount,
      mockSourceCount: researchPackage.mockSourceCount,
      observedAt: researchPackage.observedAt,
      confidence: researchPackage.confidence,
      publishable: researchPackage.publishable,
      warnings: researchPackage.warnings,
      ...(publicSourcePackageIds ? {
        sourcePackageId: publicSourcePackageIds.sourcePackageId,
        researchArtifactId: publicSourcePackageIds.researchArtifactId,
      } : {}),
      sourceSummary: hasSourcePackageContents ? (sourcePackage?.sourceSummaries ?? []) : [],
      package: researchPackage,
    },
    voiceCardVersion: result.voice_card_version ?? creatorVoiceCard?.voiceCardVersion ?? null,
    voiceBrandCard: voiceBrandCard ? {
      schemaVersion: voiceBrandCard.schemaVersion,
      version: voiceBrandCard.voiceCardVersion,
      audience: voiceBrandCard.audience,
      audienceSegments: voiceBrandCard.audienceSegments,
      contentPillars: voiceBrandCard.contentPillars,
      positioning: voiceBrandCard.positioning,
      proofLibrary: voiceBrandCard.proofLibrary,
      quality: voiceBrandCard.quality,
      provenance: voiceBrandCard.provenance,
      missingFacts: voiceBrandCard.missingFacts,
    } : null,
    sourceMode: researchPackage.sourceMode,
    sourceCount: researchPackage.sourceCount,
    researchWarnings: researchPackage.warnings,
    qualityScore: effectiveQualityScore,
    qualityBlockers,
    qualityWarnings: publicQualityWarnings,
    budgetState: result.budget_state ?? budgetState ?? 'healthy',
    expandOptions,
    nextActions,
    artifactRefs,
    operationTrace,
    claimLedger,
    agentSignalsUsed: agentSignalDigest.signals,
    reuseStatus,
    costTier: operationTrace.costTier,
    qualityReport: {
      score: effectiveQualityScore,
      blockers: qualityBlockers,
      warnings: publicQualityWarnings,
      needsExpansion: (qualityGate?.needsExpansion ?? generationMode === 'draft') || lowTrustGeneration,
      needsResearchRefresh: (qualityGate?.needsResearchRefresh ?? false) || lowTrustGeneration || excludedMockSources > 0 || !researchPackage.publishable,
    },
    scriptQuality: lowTrustGeneration ? null : publicScriptQualityReport(scriptQuality),
    scriptStructure: scriptQuality.structuredOutput,
    generation: buildGenerationMeta({
      mode: generationMode,
      startMs,
      cacheHit,
      provider: 'content-engine',
      researchUsed: generationMode !== 'draft' && generationMode !== 'quick' && !cacheHit,
    }),
    // Backward compat — keep old fields until iOS migrates.
    generationMode,
    requestedMode: requestedMode ?? generationMode,
    appliedMode: generationMode,
    downgradeReason: downgradeReason ?? 'none',
    cacheHit,
    usageImpact: cacheHit ? 'none' : generationMode === 'deep' ? 'high' : generationMode === 'draft' ? 'low' : generationMode,
  };
}

function buildEngineAgentSignalDigest(signals: NonNullable<ContentScriptEngineResult['context_signals_used']>) {
  return {
    signals: signals
      .filter((signal) => signal.type || signal.source || signal.value)
      .slice(0, 10)
      .map((signal) => ({
        key: signal.type || 'context_signal',
        value: signal.value || signal.source || 'context signal used',
        confidence: 'medium' as const,
        source: sourceForAgentSignal(signal.source),
        freshness: 'recent' as const,
      })),
  };
}

function sourceForAgentSignal(source: string | undefined): 'idea_memory' | 'performance' | 'creator_profile' | 'manual' | 'computed' {
  const normalized = (source || '').toLowerCase();
  if (normalized.includes('idea')) return 'idea_memory';
  if (normalized.includes('performance') || normalized.includes('analytics')) return 'performance';
  if (normalized.includes('voice') || normalized.includes('profile')) return 'creator_profile';
  if (normalized.includes('manual')) return 'manual';
  return 'computed';
}

function normalizeEnginePromptBudget(value: Record<string, unknown> | undefined): null | {
  tokenEstimate?: number;
  maxTokens?: number;
  overBudget?: boolean;
  cacheablePrefixHash?: string;
  sections?: Array<{
    sectionName?: string;
    tokenEstimate?: number;
    required?: boolean;
    cacheable?: boolean;
    source?: string;
    truncated?: boolean;
  }>;
} {
  if (!value || typeof value !== 'object') return null;
  const sections = Array.isArray(value.sections)
    ? value.sections
      .filter((section): section is Record<string, unknown> => Boolean(section) && typeof section === 'object')
      .map((section) => ({
        sectionName: typeof section.sectionName === 'string' ? section.sectionName : undefined,
        tokenEstimate: typeof section.tokenEstimate === 'number' ? section.tokenEstimate : undefined,
        required: typeof section.required === 'boolean' ? section.required : undefined,
        cacheable: typeof section.cacheable === 'boolean' ? section.cacheable : undefined,
        source: publicPromptSectionSource(typeof section.source === 'string' ? section.source : undefined),
        truncated: typeof section.truncated === 'boolean' ? section.truncated : undefined,
      }))
    : undefined;
  return {
    tokenEstimate: typeof value.tokenEstimate === 'number' ? value.tokenEstimate : undefined,
    maxTokens: typeof value.maxTokens === 'number' ? value.maxTokens : undefined,
    overBudget: typeof value.overBudget === 'boolean' ? value.overBudget : undefined,
    cacheablePrefixHash: typeof value.cacheablePrefixHash === 'string' ? value.cacheablePrefixHash : undefined,
    sections,
  };
}

function publicPromptSectionSource(source: string | undefined): string {
  switch ((source || '').trim()) {
    case 'code':
      return 'policy';
    case 'content-domain-ontology':
      return 'schema';
    case 'content_knowledge':
      return 'voice';
    case 'request':
      return 'user_brief';
    case 'content-research-router':
      return 'research_policy';
    case 'cost-guardrail':
      return 'budget_policy';
    case 'retrieval':
      return 'source_package';
    default:
      return source ? 'content_context' : 'unknown';
  }
}

export function publicQualityWarningText(code: string): string {
  switch (code) {
    case 'output_too_thin':
    case 'needs_expansion':
      return 'Draft needs expansion before publishing.';
    case 'weak_hook':
      return 'Hook may need a stronger opening.';
    case 'missing_clear_cta':
      return 'Add a clearer next action.';
    case 'high_risk_without_sources':
      return 'Sensitive claims need source review.';
    case 'unsupported_absolute_claim_review':
      return 'Avoid absolute claims unless sourced.';
    case 'unsafe_prompt_artifact_review':
      return 'Removed unsafe prompt-like wording from the review path.';
    case 'no_source_package_available':
      return 'No reusable source package was available.';
    case 'source_package_over_budget':
      return 'Source package was compressed for budget.';
    case 'duplicate_source_removed_or_review_required':
      return 'Duplicate source evidence needs review.';
    case 'source_note_too_long':
      return 'Source notes were shortened for budget.';
    case 'provider_fallback_review_required':
      return 'Model fallback output needs human review before publishing.';
    case 'source_grounding_review_required':
      return 'Source grounding was not strong enough for a publish-ready score.';
    case 'mock_sources_excluded':
      return 'Local mock research sources were excluded from publishable provenance.';
    default:
      return code.replace(/[_-]+/g, ' ');
  }
}

function defaultExpandOptions(mode: GenerationMode): Array<{ id: string; label: string; action: string }> {
  if (mode !== 'draft') {
    return [
      { id: 'rewrite-hook', label: 'Rewrite hook', action: 'rewrite_hook' },
      { id: 'title-pack', label: 'Title pack', action: 'title_pack' },
      { id: 'caption-pack', label: 'Caption pack', action: 'caption_pack' },
      { id: 'refresh-research', label: 'Refresh research', action: 'refresh_research' },
    ];
  }
  return [
    { id: 'expand-full', label: 'Expand to full script', action: 'expand_full' },
    { id: 'expand-intro', label: 'Expand intro', action: 'expand_section:intro' },
    { id: 'rewrite-hook', label: 'Rewrite hook', action: 'rewrite_hook' },
    { id: 'title-pack', label: 'Title pack', action: 'title_pack' },
    { id: 'thumbnail-pack', label: 'Thumbnail pack', action: 'thumbnail_pack' },
    { id: 'caption-pack', label: 'Caption pack', action: 'caption_pack' },
    { id: 'refresh-research', label: 'Refresh research', action: 'refresh_research' },
  ];
}

function publicScriptQualityReport(report: ScriptQualityReport): Omit<ScriptQualityReport, 'revisedScript' | 'structuredOutput'> {
  return {
    hookScore: report.hookScore,
    retentionScore: report.retentionScore,
    proofScore: report.proofScore,
    platformFitScore: report.platformFitScore,
    voiceFitScore: report.voiceFitScore,
    ctaScore: report.ctaScore,
    structureScore: report.structureScore,
    overallScore: report.overallScore,
    complianceWarnings: report.complianceWarnings,
    revisionActions: report.revisionActions,
    blockers: report.blockers,
  };
}
