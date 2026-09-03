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
import { normalizeSupportedLang } from '../../utils/i18n';
import {
  assertContentScriptOutputLanguage,
  assertContentScriptPublicOutputLanguage,
} from '../../services/content-output-language';

export type ScriptRenderMode = 'structured' | 'chat';
export type ScriptFormat = 'YouTube' | 'Reel';
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
  publisher?: string | null;
  author?: string | null;
  published_at?: string | null;
  accessed_at?: string | null;
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
  generation_mode?: string | null;
  cache_status?: string | null;
  research_artifact_id?: string | null;
  source_package_id?: string | null;
  voice_card_version?: string | null;
  quality_score?: number | null;
  quality_warnings?: string[];
  budget_state?: string | null;
  expand_options?: Array<{ id: string; label: string; action: string }>;
  estimated_cost?: Record<string, unknown> | null;
  actual_cost?: Record<string, unknown> | null;
  prompt_budget?: Record<string, unknown> | null;
  research_route?: Record<string, unknown> | null;
  agent_signals_used?: Array<{ type?: unknown; source?: unknown }>;
}

export type ContentModeDowngradeReason =
  | 'none'
  | 'budget_constrained'
  | 'force_draft_only'
  | 'deep_research_disabled'
  | 'fresh_research_disabled'
  | 'longform_disabled';

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
    return normalizeSupportedLang(language, 'en-US');
  }

  try {
    return normalizeSupportedLang(readUserLanguage(userId), 'en-US');
  } catch {
    return 'en-US';
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
  const language = params.language?.trim() || 'en-US';
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
  language?: string;
  /** Source metadata came from immutable request input rather than the model. */
  sourceMetadataIsRequestEcho?: boolean;
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
  } = params;
  const language = normalizeSupportedLang(params.language, 'en-US');
  assertContentScriptOutputLanguage(
    language,
    result,
    'content-script-response-input',
    { sourceMetadataIsRequestEcho: params.sourceMetadataIsRequestEcho === true },
  );

  const rawSources = Array.isArray(result.sources_used) ? result.sources_used : [];
  const sources = rawSources.filter((source) => !isMockContentSource({
    title: source.title || '',
    url: source.url || '',
    source_type: source.source_type || '',
    relevance_note: source.relevance_note || '',
  }));
  const excludedMockSources = rawSources.length - sources.length;
  const scriptQuality = analyzeAndImproveScript({
    topic: result.topic,
    script: result.script,
    hook: result.hook,
    titleOptions: result.title_options,
    cta: result.cta,
    sources,
    format,
    language,
    preflightBrief: preflightBrief ?? buildScriptPreflightBrief({
      topic: result.topic,
      format,
      language,
      cta: result.cta,
      sources,
    }),
  });
  const generationQualityRecord = generationQuality ?? {};
  const sourceGrounding = typeof generationQualityRecord.sourceGrounding === 'string'
    ? generationQualityRecord.sourceGrounding
    : null;
  const providerFallback = result.cache_status === 'fallback'
    || (result.quality_warnings ?? []).includes('provider_fallback_review_required');
  const lowTrustGeneration = providerFallback
    || sourceGrounding === 'ungrounded';
  const warnings = Array.from(new Set([
    ...(result.warnings ?? []),
    ...scriptQuality.complianceWarnings,
    ...(qualityGate?.qualityWarnings ?? []),
    ...(providerFallback ? ['provider_fallback_review_required'] : []),
    ...(sourceGrounding === 'ungrounded' ? ['source_grounding_review_required'] : []),
    ...(excludedMockSources > 0 ? ['mock_sources_excluded'] : []),
  ]));
  const rawQualityScore = qualityGate?.qualityScore
    ?? (typeof result.quality_score === 'number' ? result.quality_score : scriptQuality.overallScore);
  const effectiveQualityScore = lowTrustGeneration
    ? Math.min(rawQualityScore, 49)
    : rawQualityScore;
  const expandOptions = result.expand_options ?? defaultExpandOptions(generationMode, language);
  const enginePromptBudget = normalizeEnginePromptBudget(result.prompt_budget ?? undefined);
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
  const publicQualityWarnings = warnings.map((warning) => publicQualityWarningText(warning, language));
  const hasSourcePackageContents = Boolean(sourcePackage && (sourcePackage.sources.length > 0 || sourcePackage.sourceSummaries.length > 0));
  const hasReusableSourcePackage = Boolean(hasSourcePackageContents || publicSourcePackageIds);
  const nextActions = buildContentNextActions({
    mode: generationMode,
    budgetState: (result.budget_state as ContentBudgetState | undefined) ?? budgetState,
    hasSourcePackage: hasReusableSourcePackage,
  }).map((action) => ({
    ...action,
    label: contentActionLabel(action.id, action.label, language),
  }));
  const artifactRefs = buildContentArtifactRefs({
    voiceCard: creatorVoiceCard ?? null,
    // A generated in-memory source package is useful response context, but it
    // is not a durable artifact. Publish stored refs only when the caller has
    // supplied IDs from a successful persistence boundary.
    sourcePackage: hasSourcePackageContents && publicSourcePackageIds
      ? {
        ...(sourcePackage as SourcePackage),
        sourcePackageId: publicSourcePackageIds.sourcePackageId,
        researchArtifactId: publicSourcePackageIds.researchArtifactId,
      }
      : null,
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
    text: result.script,
    sourcePackage: hasSourcePackageContents ? (sourcePackage ?? null) : null,
    voiceCard: creatorVoiceCard ?? null,
  });
  // The engine adds this payload-free digest after it has selected the exact
  // intelligence inputs. Never synthesize usage from output text and never
  // expose signal payloads through the public response.
  const agentSignalsUsed = (result.agent_signals_used ?? []).slice(0, 10).flatMap((signal) => {
    const type = typeof signal.type === 'string' ? signal.type.trim().toLowerCase() : '';
    const source = typeof signal.source === 'string' ? signal.source.trim().toLowerCase() : '';
    if (!/^[a-z0-9][a-z0-9._:-]{0,79}$/.test(type)
        || !/^[a-z0-9][a-z0-9._:-]{0,119}$/.test(source)) return [];
    return [{ type, source }];
  });
  // A provider-created package is fresh until durable IDs prove that a stored
  // package was reused. Merely having in-memory research is not reuse.
  const reuseStatus = cacheHit
    ? 'cached'
    : publicSourcePackageIds
      ? 'reused'
      : 'fresh';

  const response = {
    topic: result.topic,
    // The quality pass is advisory. Preserve the engine-owned document
    // byte-for-byte so long scripts and user-visible tail sections cannot be
    // replaced by the bounded structured quality summary.
    script: result.script,
    hook: scriptQuality.structuredOutput.firstThreeSeconds || result.hook,
    titleOptions: result.title_options,
    sourcesUsed: sources.map((source) => ({
      title: source.title,
      url: source.url,
      sourceType: source.source_type,
      relevanceNote: source.relevance_note,
      publisher: source.publisher ?? null,
      author: source.author ?? null,
      publishedAt: source.published_at ?? null,
      accessedAt: source.accessed_at ?? null,
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
      freshnessClass: hasSourcePackageContents ? (sourcePackage?.freshnessClass ?? null) : null,
      ...(publicSourcePackageIds ? {
        sourcePackageId: publicSourcePackageIds.sourcePackageId,
        researchArtifactId: publicSourcePackageIds.researchArtifactId,
      } : {}),
      sourceSummary: hasSourcePackageContents ? (sourcePackage?.sourceSummaries ?? []) : [],
    },
    // Only the TypeScript artifact boundary can prove the stored Voice Card
    // version. The Python engine may echo prompt metadata, but it cannot
    // authoritatively version the persisted creator artifact.
    voiceCardVersion: creatorVoiceCard?.voiceCardVersion ?? null,
    qualityScore: effectiveQualityScore,
    qualityWarnings: publicQualityWarnings,
    budgetState: result.budget_state ?? budgetState ?? 'healthy',
    expandOptions,
    nextActions,
    artifactRefs,
    operationTrace,
    claimLedger,
    agentSignalsUsed,
    reuseStatus,
    costTier: operationTrace.costTier,
    qualityReport: {
      score: effectiveQualityScore,
      warnings: publicQualityWarnings,
      needsExpansion: (qualityGate?.needsExpansion ?? generationMode === 'draft') || lowTrustGeneration,
      needsResearchRefresh: (qualityGate?.needsResearchRefresh ?? false) || lowTrustGeneration || excludedMockSources > 0,
    },
    scriptSafety: {
      blocked: scriptQuality.blockers.length > 0,
      blockers: scriptQuality.blockers,
    },
    scriptQuality: lowTrustGeneration ? null : publicScriptQualityReport(scriptQuality),
    scriptStructure: scriptQuality.structuredOutput,
    generation: buildGenerationMeta({
      mode: generationMode,
      startMs,
      cacheHit,
      provider: 'content-engine',
      providerSemantics: 'service_boundary',
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
  assertContentScriptPublicOutputLanguage(
    language,
    response,
    'content-script-public-response',
    { sourceMetadataIsRequestEcho: params.sourceMetadataIsRequestEcho === true },
  );
  return response;
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

function publicQualityWarningText(code: string, language: string): string {
  if (language === 'pt-BR') {
    switch (code) {
      case 'output_too_thin':
      case 'needs_expansion':
        return 'O rascunho precisa ser expandido antes da publicação.';
      case 'weak_hook':
        return 'O gancho pode precisar de uma abertura mais forte.';
      case 'missing_clear_cta':
        return 'Adicione uma próxima ação mais clara.';
      case 'high_risk_without_sources':
        return 'As alegações sensíveis precisam de revisão das fontes.';
      case 'unsupported_absolute_claim_review':
        return 'Evite alegações absolutas sem fontes.';
      case 'unsafe_prompt_artifact_review':
        return 'A formulação insegura foi removida do fluxo de revisão.';
      case 'no_source_package_available':
        return 'Nenhum pacote de fontes reutilizável estava disponível.';
      case 'source_package_over_budget':
        return 'O pacote de fontes foi comprimido para respeitar o orçamento.';
      case 'duplicate_source_removed_or_review_required':
        return 'A evidência duplicada precisa de revisão.';
      case 'source_note_too_long':
        return 'As notas das fontes foram encurtadas para respeitar o orçamento.';
      case 'provider_fallback_review_required':
        return 'A saída alternativa do modelo precisa de revisão humana antes da publicação.';
      case 'provider_fallback_research_claims_withheld':
        return 'As alegações da pesquisa alternativa foram ocultadas; revise as fontes antes de usar o roteiro.';
      case 'source_grounding_review_required':
        return 'A fundamentação das fontes não foi suficiente para uma versão pronta para publicação.';
      case 'mock_sources_excluded':
        return 'As fontes simuladas locais foram excluídas da proveniência publicável.';
      case 'provider_fallback_voice_dna_not_applied':
        return 'A saída alternativa não conseguiu aplicar o Voice DNA salvo; revise o tom antes da publicação.';
      case 'script_metadata_recovered':
        return 'Os metadados do roteiro foram recuperados de uma saída incompleta.';
      case 'compact_research_used':
        return 'Foi usada pesquisa compacta sem síntese aprofundada.';
      case 'research_degraded_review_required':
        return 'A pesquisa ficou degradada e precisa de revisão antes da publicação.';
      case 'prompt_budget_compacted_review_required':
        return 'O contexto foi comprimido para respeitar o orçamento; revise a especificidade.';
      case 'script_repaired_after_incomplete':
        return 'Um roteiro incompleto foi regenerado com uma reparação compacta.';
      case 'script_repair_incomplete_review_required':
        return 'O roteiro continuou incompleto após a reparação e precisa de revisão.';
      case 'script_repair_unavailable_review_required':
        return 'A reparação automática do roteiro não ficou disponível; revise-o antes da publicação.';
      case 'unsupported_or_overconfident_claim_review_required':
        return 'As alegações absolutas ou excessivamente confiantes precisam de revisão.';
      case 'platform_mismatch_review_required':
        return 'A estrutura do roteiro precisa ser ajustada à plataforma.';
      case 'short_form_script_too_long_for_platform':
        return 'Revise o tamanho do roteiro em relação ao tempo explicitamente solicitado; sem tempo definido, trate a duração como hipótese.';
      default:
        return code;
    }
  }
  if (language === 'pt-PT') {
    switch (code) {
      case 'output_too_thin':
      case 'needs_expansion':
        return 'O rascunho precisa de ser expandido antes da publicação.';
      case 'weak_hook':
        return 'O gancho pode precisar de uma abertura mais forte.';
      case 'missing_clear_cta':
        return 'Adicione uma próxima ação mais clara.';
      case 'high_risk_without_sources':
        return 'As alegações sensíveis precisam de revisão das fontes.';
      case 'unsupported_absolute_claim_review':
        return 'Evite alegações absolutas sem fontes.';
      case 'unsafe_prompt_artifact_review':
        return 'A formulação insegura foi removida do caminho de revisão.';
      case 'no_source_package_available':
        return 'Não estava disponível um pacote de fontes reutilizável.';
      case 'source_package_over_budget':
        return 'O pacote de fontes foi comprimido para respeitar o orçamento.';
      case 'duplicate_source_removed_or_review_required':
        return 'A evidência duplicada precisa de revisão.';
      case 'source_note_too_long':
        return 'As notas das fontes foram encurtadas para respeitar o orçamento.';
      case 'provider_fallback_review_required':
        return 'A saída alternativa do modelo precisa de revisão humana antes da publicação.';
      case 'provider_fallback_research_claims_withheld':
        return 'As alegações da investigação alternativa foram ocultadas; reveja as fontes antes de usar o guião.';
      case 'source_grounding_review_required':
        return 'A fundamentação das fontes não foi suficiente para uma versão pronta a publicar.';
      case 'mock_sources_excluded':
        return 'As fontes simuladas locais foram excluídas da proveniência publicável.';
      case 'provider_fallback_voice_dna_not_applied':
        return 'A saída alternativa não conseguiu aplicar o Voice DNA guardado; reveja o tom antes da publicação.';
      case 'script_metadata_recovered':
        return 'Os metadados do guião foram recuperados de uma saída incompleta.';
      case 'compact_research_used':
        return 'Foi usada investigação compacta sem síntese aprofundada.';
      case 'research_degraded_review_required':
        return 'A investigação ficou degradada e precisa de revisão antes da publicação.';
      case 'prompt_budget_compacted_review_required':
        return 'O contexto foi comprimido para respeitar o orçamento; reveja a especificidade.';
      case 'script_repaired_after_incomplete':
        return 'Um guião incompleto foi regenerado com uma reparação compacta.';
      case 'script_repair_incomplete_review_required':
        return 'O guião continuou incompleto após a reparação e precisa de revisão.';
      case 'script_repair_unavailable_review_required':
        return 'A reparação automática do guião não ficou disponível; reveja-o antes da publicação.';
      case 'unsupported_or_overconfident_claim_review_required':
        return 'As alegações absolutas ou excessivamente confiantes precisam de revisão.';
      case 'platform_mismatch_review_required':
        return 'A estrutura do guião precisa de ser ajustada à plataforma.';
      case 'short_form_script_too_long_for_platform':
        return 'Revê o tamanho do guião em relação ao tempo explicitamente pedido; sem tempo definido, trata a duração como hipótese.';
      default:
        return code;
    }
  }
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
    case 'provider_fallback_research_claims_withheld':
      return 'Fallback research claims were withheld; review the sources before using the script.';
    case 'source_grounding_review_required':
      return 'Source grounding was not strong enough for a publish-ready score.';
    case 'mock_sources_excluded':
      return 'Local mock research sources were excluded from publishable provenance.';
    case 'provider_fallback_voice_dna_not_applied':
      return 'The fallback output could not apply saved Voice DNA; review its tone before publishing.';
    case 'script_metadata_recovered':
      return 'Script metadata was recovered from an incomplete provider response.';
    case 'compact_research_used':
      return 'Compact research was used without deep synthesis.';
    case 'research_degraded_review_required':
      return 'Research was degraded and needs review before publishing.';
    case 'prompt_budget_compacted_review_required':
      return 'Context was compacted to fit the prompt budget; review specificity.';
    case 'script_repaired_after_incomplete':
      return 'An incomplete script was regenerated with a compact repair pass.';
    case 'script_repair_incomplete_review_required':
      return 'The script remained incomplete after repair and needs review.';
    case 'script_repair_unavailable_review_required':
      return 'Automatic script repair was unavailable; review before publishing.';
    case 'unsupported_or_overconfident_claim_review_required':
      return 'Absolute or overconfident claims need review.';
    case 'platform_mismatch_review_required':
      return 'The script structure needs adjustment for the platform.';
    case 'short_form_script_too_long_for_platform':
      return 'Review script length against the explicitly requested runtime; without one, treat duration as a hypothesis.';
    default:
      return code.replace(/[_-]+/g, ' ');
  }
}

function defaultExpandOptions(
  mode: GenerationMode,
  language: string,
): Array<{ id: string; label: string; action: string }> {
  if (mode !== 'draft') {
    return [
      { id: 'rewrite-hook', label: contentActionLabel('rewrite-hook', 'Rewrite hook', language), action: 'rewrite_hook' },
      { id: 'title-pack', label: contentActionLabel('title-pack', 'Title pack', language), action: 'title_pack' },
      { id: 'caption-pack', label: contentActionLabel('caption-pack', 'Caption pack', language), action: 'caption_pack' },
      { id: 'refresh-research', label: contentActionLabel('refresh-research', 'Refresh research', language), action: 'refresh_research' },
    ];
  }
  return [
    { id: 'expand-full', label: contentActionLabel('expand-full', 'Expand to full script', language), action: 'expand_full' },
    { id: 'expand-intro', label: contentActionLabel('expand-intro', 'Expand intro', language), action: 'expand_section:intro' },
    { id: 'rewrite-hook', label: contentActionLabel('rewrite-hook', 'Rewrite hook', language), action: 'rewrite_hook' },
    { id: 'title-pack', label: contentActionLabel('title-pack', 'Title pack', language), action: 'title_pack' },
    { id: 'thumbnail-pack', label: contentActionLabel('thumbnail-pack', 'Thumbnail pack', language), action: 'thumbnail_pack' },
    { id: 'caption-pack', label: contentActionLabel('caption-pack', 'Caption pack', language), action: 'caption_pack' },
    { id: 'refresh-research', label: contentActionLabel('refresh-research', 'Refresh research', language), action: 'refresh_research' },
  ];
}

function contentActionLabel(id: string, fallback: string, language: string): string {
  if (language === 'pt-BR') {
    return ({
      'expand-full': 'Expandir para o roteiro completo',
      'expand-intro': 'Expandir a introdução',
      'rewrite-hook': 'Reescrever o gancho',
      'hook-pack': 'Pacote de ganchos',
      'title-pack': 'Pacote de títulos',
      'thumbnail-pack': 'Pacote de miniaturas',
      'caption-pack': 'Pacote de legendas',
      'refresh-research': 'Atualizar a pesquisa',
    } as Record<string, string>)[id] ?? fallback;
  }
  if (language !== 'pt-PT') return fallback;
  return ({
    'expand-full': 'Expandir para o guião completo',
    'expand-intro': 'Expandir a introdução',
    'rewrite-hook': 'Reescrever o gancho',
    'hook-pack': 'Pacote de ganchos',
    'title-pack': 'Pacote de títulos',
    'thumbnail-pack': 'Pacote de miniaturas',
    'caption-pack': 'Pacote de legendas',
    'refresh-research': 'Atualizar a pesquisa',
  } as Record<string, string>)[id] ?? fallback;
}

function publicScriptQualityReport(
  report: ScriptQualityReport,
): Omit<ScriptQualityReport, 'suggestedScript' | 'structuredOutput'> & {
  suggestedActions: string[];
  appliedChanges: string[];
} {
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
    suggestedActions: report.revisionActions,
    appliedChanges: [],
    blockers: report.blockers,
  };
}
