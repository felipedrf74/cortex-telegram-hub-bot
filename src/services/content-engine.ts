// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
import crypto from 'crypto';
import { config } from '../config';
import { logger } from '../utils/logger';
import type { AgentSignal } from './intelligence-bus';
import { buildCurrentCreatorProfilePayload } from './content-engine-profile-payload';
import {
  assertContentOutputLanguageFields,
  assertContentScriptOutputLanguage,
  ContentOutputLanguageMismatchError,
} from './content-output-language';
import { buildContentEngineScriptAttribution } from './content-engine-script-attribution';
import {
  PAUSED_CONTENT_AGENT_IDS,
  filterActiveContentAgentSignals,
} from './content-agent-lifecycle';
import {
  isContentLocalPrimaryAdmitted,
  normalizeScriptLanguage,
  normalizeScriptRenderMode,
  normalizeScriptStyle,
  type ScriptGenerationMode,
  type ScriptProviderBoundary,
  type ScriptRenderMode,
  type ScriptRuntimeOptions,
  type ScriptStyle,
} from './content-engine-script-runtime';
import { requireTenantIdParam } from './tenant-scope';
import {
  engineFetch,
  throwIfContentEngineRequestCancelled,
} from './content-engine-http';
import { buildContentEngineCacheLogContext } from './content-engine-log-context';
import { DEFAULT_SCRIPT_GENERATION_EXECUTION_POLICY, SYNTHETIC_EVALUATION_SCRIPT_EXECUTION_POLICY, type ScriptGenerationExecutionPolicy } from './content-script-execution-policy';
import {
  assertContentResearchGenerationAllowed,
  assertContentScriptResearchQueryMatches,
  buildContentScriptResearchQuery,
  buildContentResearchSubject,
} from './content-research-generation-policy';
export {
  ForwardedAiBudgetError,
  ForwardedContentPolicyError,
  ForwardedLocalInferenceError,
  parseForwardedAiBudgetError,
  parseForwardedContentPolicyError,
  parseForwardedContentEngineError,
  parseForwardedLocalInferenceError,
  type ForwardedAiBudgetCode,
  type ForwardedContentPolicyCode,
  type ForwardedLocalInferenceCode,
} from './content-engine-error-contract';
export { DEFAULT_SCRIPT_GENERATION_EXECUTION_POLICY, SYNTHETIC_EVALUATION_SCRIPT_EXECUTION_POLICY, type ScriptGenerationExecutionPolicy } from './content-script-execution-policy';
export { contentEngineApiBaseUrl, isContentEngineHealthy } from './content-engine-http';
export type {
  ScriptGenerationMode,
  ScriptProviderBoundary,
  ScriptRenderMode,
  ScriptRuntimeOptions,
  ScriptStyle,
} from './content-engine-script-runtime';

// ── Types mirroring Python Pydantic models ──────────────────────────

export interface SourceReference {
  source_id?: string | null;
  title: string;
  url: string;
  source_type: string;
  relevance_note: string;
  publisher?: string | null;
  author?: string | null;
  published_at?: string | null;
  accessed_at?: string | null;
}
export interface ResearchClaim {
  text: string;
  source_ids: string[];
  /** Source IDs were reconciled; this is not entailment or human verification. */
  verification_status: 'source_bound' | 'unverified';
}
export interface ContentBrief {
  title: string;
  hook: string;
  angle: string;
  format: string;
  niche: string;
  key_points: string[];
  claims?: ResearchClaim[];
  title_options: string[];
  sources: SourceReference[];
  score: number;
  time_sensitive: boolean;
  why_now: string;
}
export interface DeepSearchResponse {
  query: string;
  briefs: ContentBrief[];
  search_count: number;
  duration_ms: number;
  degraded: boolean;
  warnings: string[];
}
export interface SourcesResponse {
  query: string;
  sources: SourceReference[];
  degraded: boolean;
  warnings: string[];
}
export interface TrendingTopic {
  topic: string;
  heat_score: number;
  sources: string[];
  source_ids?: string[];
  source_references?: SourceReference[];
  first_seen: string | null;
  niche: string;
  content_angle: string;
  relevance: number;
}
export interface HotNewsResponse {
  topics: TrendingTopic[];
  generated_at: string;
  degraded: boolean;
  warnings: string[];
}
export interface TrendingResponse {
  topics: TrendingTopic[];
  niche: string;
  duration_ms: number;
  generated_at: string;
  degraded: boolean;
  warnings: string[];
}
export interface ReactionResponse {
  query: string;
  briefs: ContentBrief[];
  duration_ms: number;
  degraded: boolean;
  warnings: string[];
}
export type ContentOperationKind = 'hook_pack' | 'title_pack' | 'caption_pack' | 'thumbnail_pack'
  | 'cta_pack' | 'shorts_cutdown' | 'repurpose' | 'competitor_insight' | 'seo_insight'
  | 'gap_insight' | 'book_source';
export interface ContentOperationTrace {
  operation: ContentOperationKind;
  provider: 'content-engine';
  model: 'provider-routed';
  inputTokens: number;
  systemPromptTokens: number;
  userPromptTokens: number;
  promptTokenBudget: number;
  promptEnvelopeTokenTarget: number;
  outputTokenBudget: number;
  cacheStatus: 'miss';
  cacheablePrefixHash: string;
  cacheablePrefixReady: boolean;
  promptSections: Array<{ sectionName: string; inputTokens: number; truncated: boolean }>;
  latencyMs: number | null;
}
export interface ContentOperationArtifactRef {
  type: 'source_package' | 'voice_card' | 'draft' | 'script';
  id: string;
  source: 'request';
}
export interface ContentOperationNextAction {
  id: 'generate_draft' | 'refresh_research' | 'rewrite_tone' | 'turn_into_draft'
    | 'create_script_from_reference';
  label: string;
  kind: 'draft' | 'research_refresh' | 'rewrite';
  costTier: 'low' | 'medium' | 'high';
}
export interface ContentOperationQualityReport {
  tier: 'fast' | 'standard' | 'strict';
  warnings: Array<
    | 'prompt_over_budget'
    | 'prompt_section_truncated'
    | 'no_source_data'
    | 'research_source_unavailable'
    | 'provider_output_invalid'
  >;
}
export interface ContentOperationClaimLedgerEntry {
  claim: string;
  support: 'source_bound' | 'source_backed' | 'creator_memory_backed' | 'unverified';
  sourceRef: string | null;
  sourceRefs: string[];
  suggestedSourceRefs: string[];
}
export interface ContentOperationMetadata {
  operation_trace: ContentOperationTrace | null;
  artifact_refs: ContentOperationArtifactRef[];
  next_actions: ContentOperationNextAction[];
  reuse_status: 'fresh' | 'refreshed' | 'reused' | 'none' | null;
  cost_tier: 'low' | 'medium' | 'high' | null;
  quality_report: ContentOperationQualityReport | null;
  claim_ledger: ContentOperationClaimLedgerEntry[];
  agent_signals_used: Array<{ type: string; source: string }>;
}
export interface HooksResponse extends ContentOperationMetadata {
  topic: string;
  niche: string;
  hooks: Array<{
    text: string;
    trigger_type: 'curiosity_gap' | 'bold_claim' | 'data_shock' | 'controversy'
      | 'identity' | 'urgency' | 'story' | 'contrarian' | 'challenge'
      | 'build_reveal' | 'reaction_opener' | 'raw_moment';
    score: number;
    why: string;
    sfx: string;
    edit_cue: string;
  }>;
  duration_ms: number;
  degraded?: boolean;
  warnings?: string[];
}
export interface ScriptResponse {
  topic: string;
  script: string;
  hook: string;
  title_options: string[];
  sources_used: SourceReference[];
  estimated_duration: string;
  duration_ms: number;
  // Creator-pack fields (April 2026)
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
  /** Server-authored, payload-free identities of intelligence inputs consumed. */
  agent_signals_used?: Array<{ type: string; source: string }>;
}
export interface ScriptTopicContext {
  ideaId?: number | null;
  pipelineId?: number | null;
  topicFeedbackId?: number | null;
  niche?: string | null;
  hookIdea?: string | null;
  whyNow?: string | null;
  angleTag?: string | null;
  sourceJob?: string | null;
}

export interface TitlesResponse extends ContentOperationMetadata {
  topic: string;
  titles: Array<{
    title: string;
    strategy: 'NUMBER' | 'QUESTION' | 'HOW_TO' | 'BOLD_CLAIM' | 'VS'
      | 'STORY' | 'CONTROVERSY' | 'URGENCY' | 'CONTRARIAN';
    score: number;
    why: string;
    char_count: number;
  }>;
  duration_ms: number;
  degraded?: boolean;
  warnings?: string[];
}

export interface ThumbnailResponse extends ContentOperationMetadata {
  title: string;
  concepts: Array<{
    layout: 'split_screen' | 'close_up' | 'text_heavy' | 'before_after'
      | 'subject_detail' | 'process_demo' | 'screenshot_focus' | 'diagram';
    background_color: string;
    text_overlay: {
      main_text: string;
      font_style: 'sans-serif' | 'serif' | 'condensed' | 'display' | 'monospace' | 'script' | 'bold';
      color: string;
      position: 'center' | 'top' | 'bottom' | 'left' | 'right'
        | 'top-left' | 'top-center' | 'top-right'
        | 'middle-left' | 'middle-right'
        | 'bottom-left' | 'bottom-center' | 'bottom-right';
    };
    facial_expression: '' | 'neutral' | 'focused' | 'surprised' | 'skeptical' | 'excited' | 'determined';
    additional_elements: string[];
    why_it_works: string;
  }>;
  duration_ms: number;
  degraded?: boolean;
  warnings?: string[];
}

export interface CaptionResponse extends ContentOperationMetadata {
  topic: string;
  caption: string;
  hashtags: string[];
  duration_ms: number;
  degraded?: boolean;
  warnings?: string[];
}

export interface CompetitorResponse extends ContentOperationMetadata {
  channel: string;
  analysis: {
    channel?: string;
    title_patterns?: string[];
    content_mix?: Record<string, string>;
    upload_frequency?: string;
    avg_views?: number;
    top_performer?: string;
    strengths?: string[];
    weaknesses?: string[];
    actionable_insights?: string[];
    confidence?: 'low' | 'medium' | 'high';
  };
  duration_ms: number;
  degraded?: boolean;
  warnings?: string[];
}

export interface ContentGapInsight {
  topic: string;
  gap_type: 'big_opportunity' | 'quality_gap' | 'saturated';
  search_demand?: 'high' | 'medium' | 'low';
  existing_content_quality?: 'none' | 'low' | 'medium' | 'high';
  opportunity_score?: number;
  suggested_angle?: string;
  suggested_title?: string;
}
export interface GapsResponse extends ContentOperationMetadata {
  niche: string;
  gaps: ContentGapInsight[];
  duration_ms: number;
  degraded?: boolean;
  warnings?: string[];
}

export interface ContentSeoCluster {
  keyword: string;
  variations?: string[];
  estimated_volume?: 'high' | 'medium' | 'low';
  competition?: 'high' | 'medium' | 'low';
  opportunity_score?: number;
  content_type?: string;
  suggested_title?: string;
  notes?: string;
}
export interface SeoResponse extends ContentOperationMetadata {
  topic: string;
  clusters: ContentSeoCluster[];
  duration_ms: number;
  degraded?: boolean;
  warnings?: string[];
}

export interface RepurposeResponse extends ContentOperationMetadata {
  topic: string;
  outputs: Array<{ format: string; platform: string; content: string; posting_delay: string; notes: string }>;
  duration_ms: number;
  degraded?: boolean;
  warnings?: string[];
}

export interface FeedbackResponse {
  status: 'logged';
  analysis: {
    performance_level?: 'exceptional' | 'above_average' | 'average' | 'below_average' | 'poor';
    strengths?: string[];
    weaknesses?: string[];
    learnings?: string[];
    hook_analysis?: string;
    recommendations?: string[];
  };
  duration_ms: number;
  degraded?: boolean;
  warnings?: string[];
}

export interface ContentReportPerformer {
  title?: string | null;
  views?: number | null;
  retention_pct?: number | null;
  summary?: string | null;
  reason?: string | null;
}
export interface ContentReportPayload {
  status: 'available' | 'no_data' | 'unavailable' | 'analysis_unavailable';
  degraded: boolean;
  data_source_status: 'available' | 'unavailable';
  reason_code?: 'internal_auth_unavailable'
    | 'invalid_backend_payload'
    | 'backend_request_rejected'
    | 'backend_unavailable'
    | 'provider_output_invalid'
    | null;
  message?: string | null;
  videos_published: null;
  outcomes_logged: number | null;
  publication_tracking: {
    availability: 'unavailable';
    reason_code: 'CONTENT_PUBLICATION_TRACKING_NOT_SUPPORTED';
    publication_execution: 'not_supported';
  };
  total_views?: number | null;
  avg_retention?: number | null;
  best_performer?: string | ContentReportPerformer | null;
  worst_performer?: string | ContentReportPerformer | null;
  top_insights?: string[];
  recommendations?: string[];
  hook_analysis?: string | null;
  trend_direction?: 'improving' | 'stable' | 'declining' | null;
}
export interface ReportResponse {
  period: string;
  report: ContentReportPayload;
  duration_ms: number;
  degraded?: boolean;
  warnings?: string[];
}

export type ContentEngineRequestOptions = {
  abortSignal?: AbortSignal;
  /** Authenticated request-selected output locale. Never sourced from model text. */
  language?: 'en-US' | 'pt-PT' | 'pt-BR';
};

export type CreativePackRequestOptions = ContentEngineRequestOptions & {
  sourcePackageId?: string;
  sourceSummary?: string[];
  sourceReuseStatus?: 'fresh' | 'refreshed' | 'reused' | 'none';
};

export type HookPackRequestOptions = CreativePackRequestOptions & {
  format?: 'YouTube' | 'Short' | 'Reel' | 'Carousel';
};

export type TitlePackRequestOptions = CreativePackRequestOptions & {
  platform?: 'YouTube' | 'Instagram';
};

export type ThumbnailPackRequestOptions = CreativePackRequestOptions & {
  topic?: string;
};

export type SeoRequestOptions = ContentEngineRequestOptions & {
  platform?: 'YouTube' | 'Instagram';
};

export type RepurposeOriginalFormat = 'YouTube' | 'Short' | 'Reel' | 'Carousel' | 'Podcast' | 'Article' | 'Newsletter';
export type ContentEngineScriptFormat = 'YouTube' | 'Short' | 'Reel';

export class ContentEngineRequestValidationError extends TypeError {
  readonly code = 'CONTENT_ENGINE_REQUEST_INVALID';
  readonly status = 400;

  constructor(readonly field: string, constraint: string) {
    super(`Invalid Content Engine request field "${field}": ${constraint}`);
    this.name = 'ContentEngineRequestValidationError';
  }
}

export class ContentEngineReportScopeError extends Error {
  readonly code = 'CONTENT_ENGINE_REPORT_SCOPE_REQUIRED';
  readonly status = 401;

  constructor() {
    super('Content Engine reports require an authenticated user, tenant, and signed request context');
    this.name = 'ContentEngineReportScopeError';
  }
}

const CONTENT_ENGINE_LANGUAGES = ['en-US', 'pt-PT', 'pt-BR'] as const;
const SCRIPT_FORMATS = ['YouTube', 'Short', 'Reel'] as const;
const SCRIPT_MODES = ['draft', 'quick', 'standard', 'deep'] as const;
const HOOK_FORMATS = ['YouTube', 'Short', 'Reel', 'Carousel'] as const;
const TITLE_PLATFORMS = ['YouTube', 'Instagram'] as const;
const REPURPOSE_FORMATS = ['YouTube', 'Short', 'Reel', 'Carousel', 'Podcast', 'Article', 'Newsletter'] as const;
const SOURCE_REUSE_STATUSES = ['fresh', 'refreshed', 'reused', 'none'] as const;
const SINGLE_LINE_CONTROL = /[\x00-\x1f\x7f]/;
const FORMATTED_TEXT_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

function invalidRequest(field: string, constraint: string): never {
  throw new ContentEngineRequestValidationError(field, constraint);
}

function unicodeLength(value: string): number {
  return Array.from(value).length;
}

function boundedText(
  value: unknown,
  field: string,
  maxLength: number,
  options: { allowEmpty?: boolean; formatted?: boolean } = {},
): string {
  if (typeof value !== 'string') invalidRequest(field, 'must be a string');
  const normalized = value.trim();
  if (!options.allowEmpty && normalized.length === 0) invalidRequest(field, 'must not be empty');
  if (unicodeLength(normalized) > maxLength) {
    invalidRequest(field, `must contain at most ${maxLength} characters`);
  }
  const unsupportedControl = options.formatted ? FORMATTED_TEXT_CONTROL : SINGLE_LINE_CONTROL;
  if (unsupportedControl.test(normalized)) invalidRequest(field, 'contains an unsupported control character');
  return normalized;
}

function optionalBoundedText(
  value: unknown,
  field: string,
  maxLength: number,
  options: { allowEmpty?: boolean; formatted?: boolean } = {},
): string | undefined {
  if (value == null) return undefined;
  return boundedText(value, field, maxLength, options);
}

function optionalNonBlankBoundedText(
  value: unknown,
  field: string,
  maxLength: number,
  options: { formatted?: boolean } = {},
): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return boundedText(value, field, maxLength, options);
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    invalidRequest(field, `must be an integer between ${minimum} and ${maximum}`);
  }
  return Number(value);
}

function boundedNumber(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    invalidRequest(field, `must be a finite number between ${minimum} and ${maximum}`);
  }
  return value;
}

function enumValue<const T extends readonly string[]>(value: unknown, field: string, allowed: T): T[number] {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    invalidRequest(field, `must be one of ${allowed.join(', ')}`);
  }
  return value as T[number];
}

function boundedTextArray(
  value: unknown,
  field: string,
  maxItems: number,
  itemMaxLength: number,
): string[] {
  if (!Array.isArray(value)) invalidRequest(field, 'must be an array');
  if (value.length > maxItems) invalidRequest(field, `must contain at most ${maxItems} items`);
  return value.map((item, index) => boundedText(item, `${field}[${index}]`, itemMaxLength));
}

function validateRequestOptions(options: ContentEngineRequestOptions): void {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    invalidRequest('options', 'must be an object');
  }
  if (options.language !== undefined) enumValue(options.language, 'language', CONTENT_ENGINE_LANGUAGES);
}

function validateCreatorPayload(payload: ReturnType<typeof buildCurrentCreatorProfilePayload>): void {
  enumValue(payload.language, 'language', CONTENT_ENGINE_LANGUAGES);
  optionalBoundedText(payload.creator_profile, 'creator_profile', 6_000, { formatted: true });
  if (payload.user_id !== undefined) boundedInteger(payload.user_id, 'user_id', 1);
  if (payload.tenant_id !== undefined) boundedInteger(payload.tenant_id, 'tenant_id', 1);
  optionalBoundedText(payload.internal_attribution_token, 'internal_attribution_token', 8_192);
}

function validateCreativePackOptions(options: CreativePackRequestOptions): {
  sourcePackageId?: string;
  sourceSummary?: string[];
  sourceReuseStatus?: 'fresh' | 'refreshed' | 'reused' | 'none';
} {
  validateRequestOptions(options);
  const sourcePackageId = optionalBoundedText(options.sourcePackageId, 'source_package_id', 256);
  const sourceSummary = options.sourceSummary === undefined
    ? undefined
    : boundedTextArray(options.sourceSummary, 'source_summary', 8, 220);
  const sourceReuseStatus = options.sourceReuseStatus == null
    ? undefined
    : enumValue(options.sourceReuseStatus, 'source_reuse_status', SOURCE_REUSE_STATUSES);
  return { sourcePackageId, sourceSummary, sourceReuseStatus };
}

function normalizedScriptTopicContext(context?: ScriptTopicContext | null): ScriptTopicContext | undefined {
  if (context == null) return undefined;
  if (typeof context !== 'object' || Array.isArray(context)) invalidRequest('topic_context', 'must be an object');
  const allowedKeys = new Set([
    'ideaId', 'pipelineId', 'topicFeedbackId', 'niche', 'hookIdea', 'whyNow', 'angleTag', 'sourceJob',
  ]);
  if (Object.keys(context).some((key) => !allowedKeys.has(key))) {
    invalidRequest('topic_context', 'contains an unsupported field');
  }
  const sourceJob = optionalBoundedText(context.sourceJob, 'topic_context.sourceJob', 120);
  if (sourceJob !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(sourceJob)) {
    invalidRequest('topic_context.sourceJob', 'must be a bounded server job identifier');
  }
  return {
    ideaId: context.ideaId == null ? undefined : boundedInteger(context.ideaId, 'topic_context.ideaId', 1),
    pipelineId: context.pipelineId == null ? undefined : boundedInteger(context.pipelineId, 'topic_context.pipelineId', 1),
    topicFeedbackId: context.topicFeedbackId == null
      ? undefined
      : boundedInteger(context.topicFeedbackId, 'topic_context.topicFeedbackId', 1),
    niche: optionalBoundedText(context.niche, 'topic_context.niche', 160),
    hookIdea: optionalBoundedText(context.hookIdea, 'topic_context.hookIdea', 2_000),
    whyNow: optionalBoundedText(context.whyNow, 'topic_context.whyNow', 2_000),
    angleTag: optionalBoundedText(context.angleTag, 'topic_context.angleTag', 160),
    sourceJob,
  };
}

function validateScriptAttribution(attribution: ReturnType<typeof buildContentEngineScriptAttribution>): void {
  optionalBoundedText(attribution.internal_attribution_token, 'internal_attribution_token', 8_192);
  optionalBoundedText(
    attribution.internal_inference_attribution_token,
    'internal_inference_attribution_token',
    8_192,
  );
  optionalBoundedText(
    attribution.internal_inference_proof_key,
    'internal_inference_proof_key',
    1_024,
  );
}

function buildContentEngineCreatorPayload(
  category: string,
  language?: ContentEngineRequestOptions['language'],
): ReturnType<typeof buildCurrentCreatorProfilePayload> {
  const payload = buildCurrentCreatorProfilePayload(language, category, {
    authoritativeLanguageHint: language !== undefined,
  });
  validateCreatorPayload(payload);
  return payload;
}

export async function deepSearch(
  query: string,
  niches?: string[],
  maxResults = 10,
  options: ContentEngineRequestOptions = {},
): Promise<DeepSearchResponse> {
  validateRequestOptions(options);
  const normalizedQuery = boundedText(query, 'query', 2_000);
  const normalizedNiches = boundedTextArray(niches === undefined ? [] : niches, 'niches', 12, 120);
  const normalizedMaxResults = boundedInteger(maxResults, 'max_results', 1, 30);
  const creatorPayload = buildContentEngineCreatorPayload('content_engine_deepsearch', options.language);
  const result = await engineFetch<DeepSearchResponse>('/deepsearch', {
    method: 'POST',
    signal: options.abortSignal,
    body: JSON.stringify({
      query: normalizedQuery,
      niches: normalizedNiches,
      max_results: normalizedMaxResults,
      ...creatorPayload,
    }),
  }, 180_000, 0); // Cost-bearing fan-out has no durable replay key, so transport retries are unsafe.
  assertContentOutputLanguageFields(
    creatorPayload.language,
    [
      ...contentBriefLanguageFields(result.briefs),
      ...providerWarningProse(result.warnings),
    ],
    'content-engine-deepsearch',
  );
  return result;
}

export async function getSources(
  query: string,
  options: ContentEngineRequestOptions = {},
): Promise<SourcesResponse> {
  validateRequestOptions(options);
  const normalizedQuery = boundedText(query, 'query', 2_000);
  const language = buildContentEngineCreatorPayload('content_engine_sources', options.language).language;
  const result = await engineFetch<SourcesResponse>(
    `/sources?query=${encodeURIComponent(normalizedQuery)}&language=${encodeURIComponent(language)}`,
    { signal: options.abortSignal },
  );
  assertContentOutputLanguageFields(
    language,
    providerWarningProse(result.warnings),
    'content-engine-sources',
  );
  return result;
}

export async function getHotNews(options: ContentEngineRequestOptions = {}): Promise<HotNewsResponse> {
  validateRequestOptions(options);
  const creatorPayload = buildContentEngineCreatorPayload('content_engine', options.language);
  const result = await engineFetch<HotNewsResponse>('/hotnews', {
    method: 'POST',
    signal: options.abortSignal,
    body: JSON.stringify(creatorPayload),
  });
  assertContentOutputLanguageFields(
    creatorPayload.language,
    [
      ...result.topics.flatMap((topic) => [topic.topic, topic.content_angle]),
      ...providerWarningProse(result.warnings),
    ],
    'content-engine-hotnews',
  );
  return result;
}

export function isContentEngineConfigured(): boolean {
  return config.contentEngine.enabled;
}

export async function getTrending(
  niche?: string,
  options: ContentEngineRequestOptions = {},
): Promise<TrendingResponse> {
  validateRequestOptions(options);
  const normalizedNiche = niche == null
    ? undefined
    : (typeof niche === 'string' && niche.trim() === '' ? undefined : boundedText(niche, 'niche', 160));
  const language = buildContentEngineCreatorPayload('content_engine_trending', options.language).language;
  const params = new URLSearchParams({ language });
  if (normalizedNiche) params.set('niche', normalizedNiche);
  const result = await engineFetch<TrendingResponse>(
    `/trending?${params.toString()}`,
    { signal: options.abortSignal },
  );
  assertContentOutputLanguageFields(
    language,
    [
      ...result.topics.flatMap((topic) => [topic.topic, topic.content_angle]),
      ...providerWarningProse(result.warnings),
    ],
    'content-engine-trending',
  );
  return result;
}

export async function getReaction(
  topic: string,
  options: ContentEngineRequestOptions = {},
): Promise<ReactionResponse> {
  validateRequestOptions(options);
  const normalizedTopic = boundedText(topic, 'topic', 2_000);
  const language = buildContentEngineCreatorPayload('content_engine_reaction', options.language).language;
  const result = await engineFetch<ReactionResponse>(
    `/reaction?topic=${encodeURIComponent(normalizedTopic)}&language=${encodeURIComponent(language)}`,
    { signal: options.abortSignal },
  );
  assertContentOutputLanguageFields(
    language,
    [
      ...contentBriefLanguageFields(result.briefs),
      ...providerWarningProse(result.warnings),
    ],
    'content-engine-reaction',
  );
  return result;
}

export async function getHooks(
  topic: string,
  niche = 'general',
  count = 8,
  options: HookPackRequestOptions = {},
): Promise<HooksResponse> {
  const sourceOptions = validateCreativePackOptions(options);
  const normalizedTopic = boundedText(topic, 'topic', 2_000);
  const normalizedNiche = boundedText(niche, 'niche', 160);
  const normalizedCount = boundedInteger(count, 'count', 1, 8);
  const format = enumValue(options.format === undefined ? 'YouTube' : options.format, 'format', HOOK_FORMATS);
  const creatorPayload = buildContentEngineCreatorPayload('content_engine_hooks', options.language);
  const result = await engineFetch<HooksResponse>('/hooks', {
    method: 'POST',
    signal: options.abortSignal,
    body: JSON.stringify({
      topic: normalizedTopic,
      niche: normalizedNiche,
      count: normalizedCount,
      format,
      source_package_id: sourceOptions.sourcePackageId,
      source_summary: sourceOptions.sourceSummary,
      source_reuse_status: sourceOptions.sourceReuseStatus,
      ...creatorPayload,
    }),
  }, 45_000, 0); // Cost-bearing creative generation has no durable replay key.
  assertContentOutputLanguageFields(
    creatorPayload.language,
    [
      ...result.hooks.flatMap((hook) => [hook.text, hook.why, hook.sfx, hook.edit_cue]),
      ...providerWarningProse(result.warnings),
    ],
    'content-engine-hooks',
  );
  return result;
}

const MODE_CONFIG: Record<ScriptGenerationMode, { cacheTtl: number; signalDays: number; timeoutMs: number }> = {
  draft:    { cacheTtl: 48 * 3600, signalDays: 0,  timeoutMs: 45_000 },
  quick:    { cacheTtl: 48 * 3600, signalDays: 0,  timeoutMs: 60_000 },
  standard: { cacheTtl: 24 * 3600, signalDays: 14, timeoutMs: 120_000 },
  deep:     { cacheTtl: 0,         signalDays: 90, timeoutMs: 300_000 },
};

function hashBrandVoice(brandVoice?: string | null): string {
  const normalized = (brandVoice || '').trim();
  if (!normalized) return 'default';
  return crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 12);
}

function hashScriptCreatorProfile(creatorProfile?: string | null): string {
  const normalized = (creatorProfile || '').trim();
  if (!normalized) return 'none';
  // The profile contains private reference and recent-content context. Hash the
  // complete normalized payload so cache identity tracks it without copying
  // that private text into cache keys or logs.
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function hashScriptContext(context?: ScriptTopicContext | null): string {
  if (!context) return 'default';
  const normalized = {
    ideaId: context.ideaId ?? null,
    pipelineId: context.pipelineId ?? null,
    topicFeedbackId: context.topicFeedbackId ?? null,
    niche: context.niche?.trim().toLowerCase() || null,
    hookIdea: context.hookIdea?.trim().toLowerCase() || null,
    whyNow: context.whyNow?.trim().toLowerCase() || null,
    angleTag: context.angleTag?.trim().toLowerCase() || null,
    sourceJob: context.sourceJob?.trim().toLowerCase() || null,
  };
  if (Object.values(normalized).every((value) => value == null)) return 'default';
  return crypto.createHash('sha1').update(JSON.stringify(normalized)).digest('hex').slice(0, 12);
}

function hashRegenerationSeed(seed?: string | null): string | null {
  const normalized = (seed || '').trim();
  if (!normalized) return null;
  return crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 12);
}

function tokenizeContentText(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9à-ÿ]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4);
}

function collectSignalPayloadText(payload: unknown): string {
  if (payload == null) return '';
  if (typeof payload === 'string' || typeof payload === 'number' || typeof payload === 'boolean') {
    return String(payload);
  }
  if (Array.isArray(payload)) {
    return payload.map((item) => collectSignalPayloadText(item)).join(' ');
  }
  if (typeof payload === 'object') {
    return Object.values(payload as Record<string, unknown>)
      .map((item) => collectSignalPayloadText(item))
      .join(' ');
  }
  return '';
}

const SIGNAL_TYPE_RELEVANCE_WEIGHT: Partial<Record<string, number>> = {
  hook_effectiveness: 1.4,
  voice_pattern: 1.25,
  voice_phrase_trend: 1.15,
  keyword_rank_change: 1.1,
  pillar_performance: 1.0,
  retention_pattern: 0.95,
  channel_dna: 0.9,
  book_knowledge: 0.85,
};

function rankScriptSignals(
  signals: AgentSignal[],
  topic: string,
  niche: string,
  scriptContext?: ScriptTopicContext | null,
): AgentSignal[] {
  const keywordSet = new Set([
    ...tokenizeContentText(topic),
    ...tokenizeContentText(niche),
    ...tokenizeContentText(scriptContext?.hookIdea || ''),
    ...tokenizeContentText(scriptContext?.whyNow || ''),
    ...tokenizeContentText(scriptContext?.angleTag || ''),
  ]);

  if (keywordSet.size === 0) return signals;

  return [...signals]
    .map((signal, index) => {
      const haystack = `${signal.signal_type} ${collectSignalPayloadText(signal.payload)}`.toLowerCase();
      let topicalMatches = 0;
      for (const keyword of keywordSet) {
        if (haystack.includes(keyword)) topicalMatches++;
      }

      const topicalScore = Math.min(topicalMatches, 5) * 0.45;
      const typeScore = SIGNAL_TYPE_RELEVANCE_WEIGHT[signal.signal_type] ?? 0.7;
      const freshnessScore = Math.max(0, 1 - index / Math.max(1, signals.length)) * 0.35;
      return {
        signal,
        score: topicalScore + typeScore + freshnessScore,
      };
    })
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.signal);
}

function buildConsumedScriptSignalDigest(
  signals: Array<{ type?: unknown; source?: unknown }>,
  selectedSignals: Array<{ type?: unknown; source?: unknown }> = [],
): Array<{ type: string; source: string }> {
  const selectedIdentities = new Set(selectedSignals.flatMap((signal) => {
    const type = typeof signal.type === 'string' ? signal.type.trim().toLowerCase() : '';
    const source = typeof signal.source === 'string' ? signal.source.trim().toLowerCase() : '';
    return type && source ? [`${type}:${source}`] : [];
  }));
  const seen = new Set<string>();
  return signals.slice(0, 10).flatMap((signal) => {
    const type = typeof signal.type === 'string' ? signal.type.trim().toLowerCase() : '';
    const source = typeof signal.source === 'string' ? signal.source.trim().toLowerCase() : '';
    if (!/^[a-z0-9][a-z0-9._:-]{0,79}$/.test(type)
        || !/^[a-z0-9][a-z0-9._:-]{0,119}$/.test(source)) return [];
    const identity = `${type}:${source}`;
    // The engine is authoritative about which selected inputs it actually
    // compiled, but it cannot attribute an identity that this scoped request
    // never supplied.
    if (!selectedIdentities.has(identity) || seen.has(identity)) return [];
    seen.add(identity);
    return [{ type, source }];
  });
}

function canonicalizeScriptSignalCacheValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeScriptSignalCacheValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalizeScriptSignalCacheValue(entry)]),
    );
  }
  return value;
}

function hashScriptSignalInputs(
  signals: Array<{ type: string; source: string; payload: unknown }>,
): string {
  if (signals.length === 0) return 'none';
  return crypto.createHash('sha1')
    .update(JSON.stringify(canonicalizeScriptSignalCacheValue(signals)))
    .digest('hex')
    .slice(0, 12);
}

export function buildScriptCacheKey(
  topic: string,
  niche = 'general',
  maxDuration = 8,
  format = 'YouTube',
  targetDurationSeconds?: number | null,
  mode: ScriptGenerationMode = 'draft',
  brandVoice?: string | null,
  language?: string | null,
  renderMode: ScriptRenderMode = 'structured',
  userId?: number,
  scriptContext?: ScriptTopicContext | null,
  scriptStyle: ScriptStyle = 'detailed',
  regenerationSeed?: string | null,
  tenantId?: number,
  signalInputFingerprint?: string | null,
  creatorProfile?: string | null,
): string {
  const tenantKey = tenantId == null && userId == null
    ? 'global'
    : String(requireTenantIdParam(tenantId, 'buildScriptCacheKey'));
  const parts = [
    // v9 invalidates pre-pause entries that may have embedded Performance/SEO
    // output before the active Content-agent source policy was enforced.
    'script-v9',
    topic.toLowerCase().trim(),
    niche,
    format,
    `duration:${maxDuration}`,
    `target:${targetDurationSeconds ?? maxDuration * 60}`,
    `mode:${mode}`,
    `lang:${normalizeScriptLanguage(language)}`,
    `voice:${hashBrandVoice(brandVoice)}`,
    `render:${normalizeScriptRenderMode(renderMode)}`,
    `style:${normalizeScriptStyle(scriptStyle)}`,
    `ctx:${hashScriptContext(scriptContext)}`,
    `signals:${signalInputFingerprint || 'none'}`,
    `profile:${hashScriptCreatorProfile(creatorProfile)}`,
    `scope:${userId ?? 'global'}`,
    `tenant:${tenantKey}`,
  ];
  const seedHash = hashRegenerationSeed(regenerationSeed);
  if (seedHash) parts.push(`regen:${seedHash}`);
  return parts.join(':');
}

export async function getScript(
  topic: string, niche = 'general', maxDuration = 8, format: ContentEngineScriptFormat = 'YouTube',
  mode: ScriptGenerationMode = 'draft', brandVoice?: string | null,
  language = 'en-US', renderMode: ScriptRenderMode = 'structured', userId?: number,
  targetDurationSeconds?: number | null, scriptContext?: ScriptTopicContext | null,
  scriptStyle: ScriptStyle = 'detailed', forceRefresh = false,
  regenerationSeed?: string | null, creatorProfile?: string | null, tenantId?: number,
  providerBoundary?: ScriptProviderBoundary,
  executionPolicy: ScriptGenerationExecutionPolicy = DEFAULT_SCRIPT_GENERATION_EXECUTION_POLICY,
  runtimeOptions: ScriptRuntimeOptions = {},
): Promise<ScriptResponse> {
  throwIfContentEngineRequestCancelled(runtimeOptions.abortSignal);
  const normalizedTopic = boundedText(topic, 'topic', 2_000);
  const normalizedNiche = boundedText(niche, 'niche', 160);
  const normalizedMaxDuration = boundedInteger(maxDuration, 'max_duration_minutes', 1, 30);
  const normalizedFormat = enumValue(format, 'format', SCRIPT_FORMATS);
  const normalizedMode = enumValue(mode, 'mode', SCRIPT_MODES) as ScriptGenerationMode;
  const normalizedBrandVoice = optionalNonBlankBoundedText(
    brandVoice,
    'brand_voice',
    2_000,
    { formatted: true },
  );
  const normalizedCreatorProfile = optionalNonBlankBoundedText(
    creatorProfile,
    'creator_profile',
    6_000,
    { formatted: true },
  );
  const normalizedUserId = userId == null ? undefined : boundedInteger(userId, 'user_id', 1);
  const normalizedTenantId = tenantId == null ? undefined : boundedInteger(tenantId, 'tenant_id', 1);
  const normalizedTargetDurationSeconds = targetDurationSeconds == null
    ? undefined
    : boundedInteger(targetDurationSeconds, 'target_duration_seconds', 15, 900);
  const normalizedContext = normalizedScriptTopicContext(scriptContext);
  const normalizedRegenerationSeed = optionalNonBlankBoundedText(regenerationSeed, 'regeneration_seed', 120);
  if (typeof forceRefresh !== 'boolean') invalidRequest('force_refresh', 'must be a boolean');
  const directResearchSubject = buildContentResearchSubject([
    { label: 'Topic', value: normalizedTopic },
    { label: 'Niche', value: normalizedNiche },
    { label: 'Hook idea', value: normalizedContext?.hookIdea },
    { label: 'Why now', value: normalizedContext?.whyNow },
    { label: 'Angle', value: normalizedContext?.angleTag },
    { label: 'Source job', value: normalizedContext?.sourceJob },
  ]);
  assertContentResearchGenerationAllowed({
    subject: buildContentResearchSubject([
      { label: 'Direct request', value: directResearchSubject },
      { label: 'Server research query', value: runtimeOptions.researchQuery },
    ]),
    semanticValues: [
      normalizedTopic,
      normalizedNiche,
      normalizedContext?.hookIdea,
      normalizedContext?.whyNow,
      normalizedContext?.angleTag,
      normalizedContext?.sourceJob,
      runtimeOptions.researchQuery,
    ],
    mode: normalizedMode,
    forceRefresh,
  });
  const effectiveResearchQuery = buildContentScriptResearchQuery(normalizedTopic, normalizedNiche);
  assertContentScriptResearchQueryMatches(runtimeOptions.researchQuery, effectiveResearchQuery);
  const cfg = MODE_CONFIG[normalizedMode];
  const requestTimeoutMs = executionPolicy === SYNTHETIC_EVALUATION_SCRIPT_EXECUTION_POLICY
    ? Math.min(cfg.timeoutMs, 85_000)
    : cfg.timeoutMs;
  const normalizedLanguage = enumValue(normalizeScriptLanguage(language), 'language', CONTENT_ENGINE_LANGUAGES);
  const normalizedRenderMode = normalizeScriptRenderMode(renderMode);
  const normalizedScriptStyle = normalizeScriptStyle(scriptStyle);

  // Resolve decision inputs before cache lookup. The selected signal payloads
  // are part of the cache identity, so a response cannot be replayed after its
  // active-agent context changes.
  let contextSignals: Array<{ type: string; source: string; payload: unknown }> = [];
  if (executionPolicy.intelligenceSignals === 'default' && cfg.signalDays > 0) {
    try {
      const { readSignals } = await import('./intelligence-bus');
      throwIfContentEngineRequestCancelled(runtimeOptions.abortSignal);
      const signalTypes = [
        'hook_effectiveness', 'voice_pattern', 'voice_phrase_trend',
        'channel_dna', 'book_knowledge', 'keyword_rank_change',
        'retention_pattern', 'pillar_performance',
      ] as const;
      const raw = readSignals(
        'script-engine',
        [...signalTypes],
        100,
        normalizedUserId,
        cfg.signalDays,
        normalizedTenantId,
        { excludeSourceAgents: PAUSED_CONTENT_AGENT_IDS },
      ) || [];
      const activeSignals = filterActiveContentAgentSignals(raw);
      const ranked = rankScriptSignals(activeSignals, normalizedTopic, normalizedNiche, normalizedContext);
      const signalLimit = normalizedMode === 'deep' ? 10 : 4;
      contextSignals = ranked.slice(0, signalLimit).map((signal) => ({
        type: signal.signal_type,
        source: signal.source_agent,
        payload: signal.payload,
      }));
      logger.info({
        signalCount: contextSignals.length,
        rawSignalCount: raw.length,
        pausedSignalCount: raw.length - activeSignals.length,
        mode: normalizedMode,
        signalDays: cfg.signalDays,
      }, 'Injecting ranked bus signals');
    } catch (error) {
      throwIfContentEngineRequestCancelled(runtimeOptions.abortSignal, error);
      // Bus unavailable — generate without signals (backward compatible).
    }
  }
  const signalInputFingerprint = hashScriptSignalInputs(contextSignals);
  const normalizedKey = buildScriptCacheKey(
    normalizedTopic,
    normalizedNiche,
    normalizedMaxDuration,
    normalizedFormat,
    normalizedTargetDurationSeconds,
    normalizedMode,
    normalizedBrandVoice,
    normalizedLanguage,
    normalizedRenderMode,
    normalizedUserId,
    normalizedContext,
    normalizedScriptStyle,
    normalizedRegenerationSeed,
    normalizedTenantId,
    signalInputFingerprint,
    normalizedCreatorProfile,
  );

  // ── Cache check (skip for deep mode — always generate fresh) ──
  if (executionPolicy.cache === 'default' && cfg.cacheTtl > 0 && !forceRefresh) {
    try {
      const { getCached } = await import('./cache-store');
      throwIfContentEngineRequestCancelled(runtimeOptions.abortSignal);
      const cached = getCached<ScriptResponse>(normalizedKey);
      if (cached) {
        throwIfContentEngineRequestCancelled(runtimeOptions.abortSignal);
        const { agent_signals_used: cachedSignalDigest, ...cachedBase } = cached;
        const normalizedCachedSignalDigest = buildConsumedScriptSignalDigest(
          cachedSignalDigest ?? [],
          contextSignals,
        );
        const safeCached: ScriptResponse = normalizedCachedSignalDigest.length > 0
          ? { ...cachedBase, agent_signals_used: normalizedCachedSignalDigest }
          : cachedBase;
        assertContentScriptOutputLanguage(normalizedLanguage, safeCached, 'content-engine-script-cache');
        const publicCached = safeCached.degraded === true || safeCached.cache_status === 'fallback'
          ? safeCached
          : { ...safeCached, cache_status: 'hit' };
        logger.info(
          buildContentEngineCacheLogContext(normalizedTopic, normalizedMode, true),
          'Script cache hit — returning cached result',
        );
        return publicCached;
      }
    } catch (error) {
      throwIfContentEngineRequestCancelled(runtimeOptions.abortSignal, error);
      if (error instanceof ContentOutputLanguageMismatchError) throw error;
      // Cache unavailable: generate fresh.
    }
  }

  const invokeFreshProviderPath = () => {
    // Mint cloud attribution inside the provider boundary so it can carry the
    // active, signed budget reservation marker. This still happens only after
    // the token-zero cache path has missed.
    const scriptAttribution = buildContentEngineScriptAttribution({
      contentProxyEnabled: runtimeOptions.localPrimaryAdmitted
        ?? isContentLocalPrimaryAdmitted(normalizedUserId),
      providerBoundarySupplied: Boolean(providerBoundary),
      userId: normalizedUserId,
      tenantId: normalizedTenantId,
      mode: normalizedMode,
      operationId: runtimeOptions.operationId,
    });
    validateScriptAttribution(scriptAttribution);
    return engineFetch<ScriptResponse>('/script', {
      method: 'POST',
      signal: runtimeOptions.abortSignal,
      body: JSON.stringify({
        topic: normalizedTopic,
        niche: normalizedNiche,
        format: normalizedFormat,
        mode: normalizedMode,
        research_query: effectiveResearchQuery || undefined,
        language: normalizedLanguage,
        render_mode: normalizedRenderMode,
        script_style: normalizedScriptStyle,
        max_duration_minutes: normalizedMaxDuration,
        target_duration_seconds: normalizedTargetDurationSeconds,
        topic_context: normalizedContext,
        context_signals: contextSignals.length > 0 ? contextSignals : undefined,
        // CONT-M4: pass user's brand voice to Python script writer so the
        // generated script reflects the user's tone, vocabulary, and style.
        brand_voice: normalizedBrandVoice,
        creator_profile: normalizedCreatorProfile,
        user_id: normalizedUserId,
        tenant_id: normalizedTenantId,
        ...scriptAttribution,
        force_refresh: forceRefresh || undefined,
        regeneration_seed: normalizedRegenerationSeed,
      }),
    }, requestTimeoutMs, 0); // Script generation has no provider-level replay key; ambiguous transport retries are unsafe.
  };
  const providerResult = providerBoundary
    ? await providerBoundary(invokeFreshProviderPath)
    : await invokeFreshProviderPath();
  throwIfContentEngineRequestCancelled(runtimeOptions.abortSignal);
  const { agent_signals_used: providerSignalDigest, ...providerResultBase } = providerResult;
  const consumedSignals = buildConsumedScriptSignalDigest(providerSignalDigest ?? [], contextSignals);
  const result: ScriptResponse = consumedSignals.length > 0
    ? { ...providerResultBase, agent_signals_used: consumedSignals }
    : providerResultBase;
  assertContentScriptOutputLanguage(normalizedLanguage, result, 'content-engine-script');

  // ── Cache store (skip for deep mode) ───────────────────────────
  if (
    executionPolicy.cache === 'default'
    && cfg.cacheTtl > 0
    && (!forceRefresh || Boolean(normalizedRegenerationSeed))
    && result.degraded !== true
    && result.cache_status !== 'fallback'
  ) {
    try {
      const { setCache } = await import('./cache-store');
      throwIfContentEngineRequestCancelled(runtimeOptions.abortSignal);
      setCache(normalizedKey, result, cfg.cacheTtl);
      logger.info(
        buildContentEngineCacheLogContext(normalizedTopic, normalizedMode, false, cfg.cacheTtl),
        'Script cached',
      );
    } catch (error) {
      throwIfContentEngineRequestCancelled(runtimeOptions.abortSignal, error);
      // Cache store failed — non-fatal.
    }
  }

  throwIfContentEngineRequestCancelled(runtimeOptions.abortSignal);
  return result;
}

export async function getTitles(
  topic: string,
  niche = 'general',
  count = 10,
  options: TitlePackRequestOptions = {},
): Promise<TitlesResponse> {
  const sourceOptions = validateCreativePackOptions(options);
  const normalizedTopic = boundedText(topic, 'topic', 2_000);
  const normalizedNiche = boundedText(niche, 'niche', 160);
  const normalizedCount = boundedInteger(count, 'count', 1, 10);
  const platform = enumValue(
    options.platform === undefined ? 'YouTube' : options.platform,
    'platform',
    TITLE_PLATFORMS,
  );
  const creatorPayload = buildContentEngineCreatorPayload('content_engine_titles', options.language);
  const result = await engineFetch<TitlesResponse>('/titles', {
    method: 'POST',
    signal: options.abortSignal,
    body: JSON.stringify({
      topic: normalizedTopic,
      niche: normalizedNiche,
      count: normalizedCount,
      platform,
      source_package_id: sourceOptions.sourcePackageId,
      source_summary: sourceOptions.sourceSummary,
      source_reuse_status: sourceOptions.sourceReuseStatus,
      ...creatorPayload,
    }),
  }, 45_000, 0); // Cost-bearing creative generation has no durable replay key.
  assertContentOutputLanguageFields(
    creatorPayload.language,
    [
      ...result.titles.flatMap((title) => [title.title, title.why]),
      ...providerWarningProse(result.warnings),
    ],
    'content-engine-titles',
  );
  return result;
}

export async function getThumbnail(
  title: string,
  niche = 'general',
  options: ThumbnailPackRequestOptions = {},
): Promise<ThumbnailResponse> {
  const sourceOptions = validateCreativePackOptions(options);
  const normalizedTitle = boundedText(title, 'title', 2_000);
  const normalizedTopic = options.topic === undefined
    ? ''
    : (typeof options.topic === 'string' && options.topic.trim() === ''
      ? ''
      : boundedText(options.topic, 'topic', 2_000).replace(/\s+/g, ' '));
  const normalizedNiche = boundedText(niche, 'niche', 160);
  const effectiveTopic = normalizedTopic || normalizedTitle;
  if (unicodeLength(normalizedTitle) + unicodeLength(effectiveTopic) > 2_800) {
    invalidRequest('title/topic', 'must contain at most 2800 combined characters');
  }
  const creatorPayload = buildContentEngineCreatorPayload('content_engine_thumbnail', options.language);
  const result = await engineFetch<ThumbnailResponse>('/thumbnail', {
    method: 'POST',
    signal: options.abortSignal,
    body: JSON.stringify({
      title: normalizedTitle,
      topic: normalizedTopic,
      niche: normalizedNiche,
      source_package_id: sourceOptions.sourcePackageId,
      source_summary: sourceOptions.sourceSummary,
      source_reuse_status: sourceOptions.sourceReuseStatus,
      ...creatorPayload,
    }),
  }, 45_000, 0); // Cost-bearing creative generation has no durable replay key.
  assertContentOutputLanguageFields(
    creatorPayload.language,
    result.concepts.flatMap((concept) => [
      concept.text_overlay.main_text,
      concept.why_it_works,
      ...concept.additional_elements,
    ]).concat(providerWarningProse(result.warnings)),
    'content-engine-thumbnail',
  );
  return result;
}

export async function getCaption(
  topic: string,
  niche = 'general',
  options: CreativePackRequestOptions = {},
): Promise<CaptionResponse> {
  const sourceOptions = validateCreativePackOptions(options);
  const normalizedTopic = boundedText(topic, 'topic', 2_000);
  const normalizedNiche = boundedText(niche, 'niche', 160);
  const creatorPayload = buildContentEngineCreatorPayload('content_engine_caption', options.language);
  const result = await engineFetch<CaptionResponse>('/caption', {
    method: 'POST',
    signal: options.abortSignal,
    body: JSON.stringify({
      topic: normalizedTopic,
      niche: normalizedNiche,
      source_package_id: sourceOptions.sourcePackageId,
      source_summary: sourceOptions.sourceSummary,
      source_reuse_status: sourceOptions.sourceReuseStatus,
      ...creatorPayload,
    }),
  }, 45_000, 0); // Cost-bearing creative generation has no durable replay key.
  assertContentOutputLanguageFields(
    creatorPayload.language,
    [result.caption, ...result.hashtags, ...providerWarningProse(result.warnings)],
    'content-engine-caption',
  );
  return result;
}

export async function getCompetitor(
  channel: string,
  maxVideos = 10,
  options: ContentEngineRequestOptions = {},
): Promise<CompetitorResponse> {
  validateRequestOptions(options);
  const normalizedChannel = boundedText(channel, 'channel', 2_048);
  const normalizedMaxVideos = boundedInteger(maxVideos, 'max_videos', 1, 50);
  const creatorPayload = buildContentEngineCreatorPayload('content_engine_competitor', options.language);
  const result = await engineFetch<CompetitorResponse>('/competitor', {
    method: 'POST',
    signal: options.abortSignal,
    body: JSON.stringify({ channel: normalizedChannel, max_videos: normalizedMaxVideos, ...creatorPayload }),
  }, 60_000);
  assertContentOutputLanguageFields(
    creatorPayload.language,
    [
      ...(result.analysis.title_patterns ?? []),
      ...Object.keys(result.analysis.content_mix ?? {}),
      ...Object.values(result.analysis.content_mix ?? {}),
      result.analysis.upload_frequency,
      result.analysis.top_performer,
      ...(result.analysis.strengths ?? []),
      ...(result.analysis.weaknesses ?? []),
      ...(result.analysis.actionable_insights ?? []),
      ...providerWarningProse(result.warnings),
    ],
    'content-engine-competitor',
  );
  return result;
}

export async function getGaps(
  niche: string,
  maxGaps = 10,
  options: ContentEngineRequestOptions = {},
): Promise<GapsResponse> {
  validateRequestOptions(options);
  if (typeof niche !== 'string' || !niche.trim()) {
    throw new TypeError('Content gaps require a non-empty creator niche');
  }
  const normalizedNiche = boundedText(niche, 'niche', 160).replace(/\s+/g, ' ');
  const normalizedMaxGaps = boundedInteger(maxGaps, 'max_gaps', 1, 20);
  const creatorPayload = buildContentEngineCreatorPayload('content_engine_gaps', options.language);
  const result = await engineFetch<GapsResponse>('/gaps', {
    method: 'POST',
    signal: options.abortSignal,
    body: JSON.stringify({ niche: normalizedNiche, max_gaps: normalizedMaxGaps, ...creatorPayload }),
  }, 60_000);
  assertContentOutputLanguageFields(
    creatorPayload.language,
    [
      ...result.gaps.flatMap((gap) => [gap.topic, gap.suggested_angle, gap.suggested_title]),
      ...providerWarningProse(result.warnings),
    ],
    'content-engine-gaps',
  );
  return result;
}

export async function getSeo(
  topic: string,
  options: SeoRequestOptions = {},
): Promise<SeoResponse> {
  validateRequestOptions(options);
  const normalizedTopic = boundedText(topic, 'topic', 2_000);
  const platform = enumValue(
    options.platform === undefined ? 'YouTube' : options.platform,
    'platform',
    TITLE_PLATFORMS,
  );
  const creatorPayload = buildContentEngineCreatorPayload('content_engine_seo', options.language);
  const result = await engineFetch<SeoResponse>('/seo', {
    method: 'POST',
    signal: options.abortSignal,
    body: JSON.stringify({ topic: normalizedTopic, platform, ...creatorPayload }),
  }, 60_000);
  assertContentOutputLanguageFields(
    creatorPayload.language,
    [
      ...result.clusters.flatMap((cluster) => [
        cluster.keyword,
        ...(cluster.variations ?? []),
        cluster.content_type,
        cluster.suggested_title,
        cluster.notes,
      ]),
      ...providerWarningProse(result.warnings),
    ],
    'content-engine-seo',
  );
  return result;
}

export async function getRepurpose(
  topic: string,
  sourceContent: string,
  originalFormat: RepurposeOriginalFormat = 'YouTube',
  options: CreativePackRequestOptions = {},
): Promise<RepurposeResponse> {
  const sourceOptions = validateCreativePackOptions(options);
  const normalizedTopic = boundedText(topic, 'topic', 2_000);
  const normalizedSourceContent = boundedText(sourceContent, 'source_content', 5_000, { formatted: true });
  const normalizedOriginalFormat = enumValue(originalFormat, 'original_format', REPURPOSE_FORMATS);
  const creatorPayload = buildContentEngineCreatorPayload('content_engine_repurpose', options.language);
  const result = await engineFetch<RepurposeResponse>('/repurpose', {
    method: 'POST',
    signal: options.abortSignal,
    body: JSON.stringify({
      topic: normalizedTopic,
      source_content: normalizedSourceContent,
      original_format: normalizedOriginalFormat,
      source_package_id: sourceOptions.sourcePackageId,
      source_summary: sourceOptions.sourceSummary,
      source_reuse_status: sourceOptions.sourceReuseStatus,
      ...creatorPayload,
    }),
  }, 60_000, 0); // Cost-bearing creative generation has no durable replay key.
  assertContentOutputLanguageFields(
    creatorPayload.language,
    [
      ...result.outputs.flatMap((output) => [output.content, output.notes]),
      ...providerWarningProse(result.warnings),
    ],
    'content-engine-repurpose',
  );
  return result;
}

export async function logFeedback(
  data: {
    video_url: string;
    views: number;
    retention_pct: number;
    likes?: number;
    comments?: number;
    subs_gained?: number;
    hook_used?: string;
    notes?: string;
  },
  options: ContentEngineRequestOptions = {},
): Promise<FeedbackResponse> {
  validateRequestOptions(options);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    invalidRequest('feedback', 'must be an object');
  }
  const normalizedFeedback = {
    video_url: boundedText(data.video_url, 'video_url', 2_048),
    views: boundedInteger(data.views, 'views', 0),
    retention_pct: boundedNumber(data.retention_pct, 'retention_pct', 0, 100),
    likes: data.likes === undefined ? undefined : boundedInteger(data.likes, 'likes', 0),
    comments: data.comments === undefined ? undefined : boundedInteger(data.comments, 'comments', 0),
    subs_gained: data.subs_gained === undefined
      ? undefined
      : boundedInteger(data.subs_gained, 'subs_gained', 0),
    hook_used: data.hook_used === undefined
      ? undefined
      : boundedText(data.hook_used, 'hook_used', 2_000, { allowEmpty: true, formatted: true }),
    notes: data.notes === undefined
      ? undefined
      : boundedText(data.notes, 'notes', 6_000, { allowEmpty: true, formatted: true }),
  };
  const creatorPayload = buildContentEngineCreatorPayload('content_engine_feedback', options.language);
  const result = await engineFetch<FeedbackResponse>('/feedback', {
    method: 'POST',
    signal: options.abortSignal,
    body: JSON.stringify({ ...normalizedFeedback, ...creatorPayload }),
  }, 45_000);
  assertContentOutputLanguageFields(
    creatorPayload.language,
    [
      ...(result.analysis.strengths ?? []),
      ...(result.analysis.weaknesses ?? []),
      ...(result.analysis.learnings ?? []),
      result.analysis.hook_analysis,
      ...(result.analysis.recommendations ?? []),
      ...providerWarningProse(result.warnings),
    ],
    'content-engine-feedback',
  );
  return result;
}

/**
 * Read a performance report inside an authenticated request context.
 *
 * The ambient context must yield a positive user/tenant pair and a signed
 * `content_engine_report` attribution token. Missing signing configuration or
 * an unscoped caller fails locally; the Python report endpoint is never called.
 */
export async function getReport(
  period: 'week' | 'month' = 'week',
  options: ContentEngineRequestOptions = {},
): Promise<ReportResponse> {
  validateRequestOptions(options);
  const normalizedPeriod = enumValue(period, 'period', ['week', 'month'] as const);
  const creatorPayload = buildContentEngineCreatorPayload('content_engine_report', options.language);
  if (
    !Number.isSafeInteger(creatorPayload.user_id)
    || Number(creatorPayload.user_id) <= 0
    || !Number.isSafeInteger(creatorPayload.tenant_id)
    || Number(creatorPayload.tenant_id) <= 0
    || typeof creatorPayload.internal_attribution_token !== 'string'
    || creatorPayload.internal_attribution_token.trim().length === 0
  ) {
    throw new ContentEngineReportScopeError();
  }
  const result = await engineFetch<ReportResponse>('/report', {
    method: 'POST',
    signal: options.abortSignal,
    body: JSON.stringify({ period: normalizedPeriod, ...creatorPayload }),
  }, 45_000);
  assertContentOutputLanguageFields(
    creatorPayload.language,
    [
      result.report.message,
      ...contentReportPerformerLanguageFields(result.report.best_performer),
      ...contentReportPerformerLanguageFields(result.report.worst_performer),
      ...(result.report.top_insights ?? []),
      ...(result.report.recommendations ?? []),
      result.report.hook_analysis,
      ...providerWarningProse(result.warnings),
    ],
    'content-engine-report',
  );
  return result;
}

function contentBriefLanguageFields(briefs: readonly ContentBrief[]): unknown[] {
  return briefs.flatMap((brief) => [
    brief.title,
    brief.hook,
    brief.angle,
    ...brief.key_points,
    ...(brief.claims ?? []).map((claim) => claim.text),
    ...brief.title_options,
    brief.why_now,
  ]);
}

function providerWarningProse(warnings: readonly string[] | undefined): string[] {
  return (warnings ?? []).filter((warning) => (
    typeof warning === 'string'
    && warning.trim().length > 0
    && !/^[a-z0-9]+(?:[_-][a-z0-9]+)+$/i.test(warning.trim())
  ));
}

function contentReportPerformerLanguageFields(
  performer: string | ContentReportPerformer | null | undefined,
): unknown[] {
  if (typeof performer === 'string') return [performer];
  if (!performer) return [];
  return [performer.title, performer.summary, performer.reason];
}

// Legacy Telegram format-function re-exports removed with the Telegram
// legacy delivery path (2026-07). Consumers use the structured Response
// interfaces above.
