// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
import crypto from 'crypto';
import { config } from '../config';
import { logger } from '../utils/logger';
import type { AgentSignal } from './intelligence-bus';
import { buildCurrentCreatorProfilePayload } from './content-engine-profile-payload';
import { assertContentScriptOutputLanguage, ContentOutputLanguageMismatchError } from './content-output-language';
import { buildContentEngineScriptAttribution } from './content-engine-script-attribution';
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
  withRetry,
} from './content-engine-http';
import { buildContentEngineCacheLogContext } from './content-engine-log-context';
import { DEFAULT_SCRIPT_GENERATION_EXECUTION_POLICY, SYNTHETIC_EVALUATION_SCRIPT_EXECUTION_POLICY, type ScriptGenerationExecutionPolicy } from './content-script-execution-policy';
export {
  ForwardedAiBudgetError,
  ForwardedLocalInferenceError,
  parseForwardedAiBudgetError,
  parseForwardedContentEngineError,
  parseForwardedLocalInferenceError,
  type ForwardedAiBudgetCode,
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
  title: string;
  url: string;
  source_type: string;
  relevance_note: string;
}
export interface ContentBrief {
  title: string;
  hook: string;
  angle: string;
  format: string;
  niche: string;
  key_points: string[];
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
}
export interface SourcesResponse {
  query: string;
  sources: SourceReference[];
}
export interface TrendingTopic {
  topic: string;
  heat_score: number;
  sources: string[];
  first_seen: string | null;
  niche: string;
}
export interface HotNewsResponse {
  topics: TrendingTopic[];
  generated_at: string;
}
export interface TrendingResponse {
  topics: TrendingTopic[];
  niche: string;
  duration_ms: number;
  generated_at: string;
}
export interface ReactionResponse {
  query: string;
  briefs: ContentBrief[];
  duration_ms: number;
}
export interface HooksResponse {
  topic: string;
  niche: string;
  hooks: Array<{ text: string; trigger_type: string; score: number; why: string }>;
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

export interface TitlesResponse {
  topic: string;
  titles: Array<{ title: string; strategy: string; score: number; why: string }>;
  duration_ms: number;
}

export interface ThumbnailResponse {
  title: string;
  concepts: Array<{ layout: string; colors: string; text: string; expression: string; why: string }>;
  duration_ms: number;
}

export interface CaptionResponse {
  topic: string;
  caption: string;
  hashtags: string[];
  duration_ms: number;
}

export interface CompetitorResponse {
  channel: string;
  analysis: Record<string, unknown>;
  duration_ms: number;
}

export interface GapsResponse {
  niche: string;
  gaps: Array<{ topic: string; gap_type: string; search_volume: string; opportunity: string }>;
  duration_ms: number;
}

export interface SeoResponse {
  topic: string;
  clusters: Array<{ keyword: string; volume: string; difficulty: string; content_type: string }>;
  duration_ms: number;
}

export interface RepurposeResponse {
  topic: string;
  outputs: Array<{ format: string; platform: string; content: string; posting_delay: string; notes: string }>;
  duration_ms: number;
}

export interface FeedbackResponse {
  status: string;
  analysis: Record<string, unknown>;
  duration_ms: number;
}

export interface ReportResponse {
  period: string;
  report: Record<string, unknown>;
  duration_ms: number;
}

export async function deepSearch(query: string, niches?: string[], maxResults = 10): Promise<DeepSearchResponse> {
  const creatorPayload = buildCurrentCreatorProfilePayload(null, 'content_engine_deepsearch');
  return withRetry(() => engineFetch<DeepSearchResponse>('/deepsearch', {
    method: 'POST',
    body: JSON.stringify({ query, niches: niches || [], max_results: maxResults, ...creatorPayload }),
  }, 180_000)); // deep search: 5 query variations + AI synthesis
}

export async function getSources(query: string): Promise<SourcesResponse> {
  return engineFetch<SourcesResponse>(`/sources?query=${encodeURIComponent(query)}`);
}

export async function getHotNews(): Promise<HotNewsResponse> {
  const creatorPayload = buildCurrentCreatorProfilePayload(null, 'content_engine');
  return engineFetch<HotNewsResponse>('/hotnews', {
    method: 'POST',
    body: JSON.stringify(creatorPayload),
  });
}

export function isContentEngineConfigured(): boolean {
  return config.contentEngine.enabled;
}

export async function getTrending(niche?: string): Promise<TrendingResponse> {
  const qs = niche ? `?niche=${encodeURIComponent(niche)}` : '';
  return engineFetch<TrendingResponse>(`/trending${qs}`);
}

export async function getReaction(topic: string): Promise<ReactionResponse> {
  return engineFetch<ReactionResponse>(`/reaction?topic=${encodeURIComponent(topic)}`);
}

export async function getHooks(topic: string, niche = 'general', count = 8): Promise<HooksResponse> {
  const creatorPayload = buildCurrentCreatorProfilePayload(null, 'content_engine_hooks');
  return engineFetch<HooksResponse>('/hooks', {
    method: 'POST',
    body: JSON.stringify({ topic, niche, count, ...creatorPayload }),
  }, 45_000);
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
): string {
  const tenantKey = tenantId == null && userId == null
    ? 'global'
    : String(requireTenantIdParam(tenantId, 'buildScriptCacheKey'));
  const parts = [
    'script-v8',
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
    `scope:${userId ?? 'global'}`,
    `tenant:${tenantKey}`,
  ];
  const seedHash = hashRegenerationSeed(regenerationSeed);
  if (seedHash) parts.push(`regen:${seedHash}`);
  return parts.join(':');
}

export async function getScript(
  topic: string, niche = 'general', maxDuration = 8, format = 'YouTube',
  mode: ScriptGenerationMode = 'draft', brandVoice?: string | null,
  language = 'pt-BR', renderMode: ScriptRenderMode = 'structured', userId?: number,
  targetDurationSeconds?: number | null, scriptContext?: ScriptTopicContext | null,
  scriptStyle: ScriptStyle = 'detailed', forceRefresh = false,
  regenerationSeed?: string | null, creatorProfile?: string | null, tenantId?: number,
  providerBoundary?: ScriptProviderBoundary,
  executionPolicy: ScriptGenerationExecutionPolicy = DEFAULT_SCRIPT_GENERATION_EXECUTION_POLICY,
  runtimeOptions: ScriptRuntimeOptions = {},
): Promise<ScriptResponse> {
  throwIfContentEngineRequestCancelled(runtimeOptions.abortSignal);
  const cfg = MODE_CONFIG[mode];
  const requestTimeoutMs = executionPolicy === SYNTHETIC_EVALUATION_SCRIPT_EXECUTION_POLICY
    ? Math.min(cfg.timeoutMs, 85_000)
    : cfg.timeoutMs;
  const normalizedLanguage = normalizeScriptLanguage(language);
  const normalizedRenderMode = normalizeScriptRenderMode(renderMode);
  const normalizedScriptStyle = normalizeScriptStyle(scriptStyle);
  const normalizedKey = buildScriptCacheKey(
    topic,
    niche,
    maxDuration,
    format,
    targetDurationSeconds,
    mode,
    brandVoice,
    normalizedLanguage,
    normalizedRenderMode,
    userId,
    scriptContext,
    normalizedScriptStyle,
    regenerationSeed,
    tenantId,
  );

  // ── Cache check (skip for deep mode — always generate fresh) ──
  if (executionPolicy.cache === 'default' && cfg.cacheTtl > 0 && !forceRefresh) {
    try {
      const { getCached } = await import('./cache-store');
      throwIfContentEngineRequestCancelled(runtimeOptions.abortSignal);
      const cached = getCached<ScriptResponse>(normalizedKey);
      if (cached) {
        throwIfContentEngineRequestCancelled(runtimeOptions.abortSignal);
        assertContentScriptOutputLanguage(normalizedLanguage, cached, 'content-engine-script-cache');
        logger.info(buildContentEngineCacheLogContext(topic, mode, true), 'Script cache hit — returning cached result');
        return cached;
      }
    } catch (error) {
      throwIfContentEngineRequestCancelled(runtimeOptions.abortSignal, error);
      if (error instanceof ContentOutputLanguageMismatchError) throw error;
      // Cache unavailable: generate fresh.
    }
  }

  // ── Intelligence bus signals (skip for quick mode) ──────────────
  let contextSignals: any[] = [];
  if (executionPolicy.intelligenceSignals === 'default' && cfg.signalDays > 0) {
    try {
      const { readSignals } = await import('./intelligence-bus');
      throwIfContentEngineRequestCancelled(runtimeOptions.abortSignal);
      const signalTypes = [
        'hook_effectiveness', 'voice_pattern', 'voice_phrase_trend',
        'channel_dna', 'book_knowledge', 'keyword_rank_change',
        'retention_pattern', 'pillar_performance',
      ] as const;
      // FIX: signalDays is a time window, not a count limit.
      // readSignals(consumer, types, limit, userId, maxAgeDays)
      // CONT-M1: null-coalesce in case readSignals returns null/undefined
      const raw = readSignals('script-engine', [...signalTypes], 100, userId, cfg.signalDays, tenantId) || [];
      const ranked = rankScriptSignals(raw, topic, niche, scriptContext);
      const signalLimit = mode === 'deep' ? 10 : 4;
      contextSignals = ranked.slice(0, signalLimit).map(s => ({
        type: s.signal_type,
        source: s.source_agent,
        payload: s.payload,
      }));
      logger.info({ signalCount: contextSignals.length, rawSignalCount: raw.length, mode, signalDays: cfg.signalDays }, 'Injecting ranked bus signals');
    } catch (error) {
      throwIfContentEngineRequestCancelled(runtimeOptions.abortSignal, error);
      // Bus unavailable — generate without signals (backward compatible)
    }
  }

  const invokeFreshProviderPath = () => engineFetch<ScriptResponse>('/script', {
    method: 'POST',
    signal: runtimeOptions.abortSignal,
    body: JSON.stringify({
      topic, niche, format, mode,
      language: normalizedLanguage,
      render_mode: normalizedRenderMode,
      script_style: normalizedScriptStyle,
      max_duration_minutes: maxDuration,
      target_duration_seconds: targetDurationSeconds ?? undefined,
      topic_context: scriptContext ?? undefined,
      context_signals: contextSignals.length > 0 ? contextSignals : undefined,
      // CONT-M4: pass user's brand voice to Python script writer so the
      // generated script reflects the user's tone, vocabulary, and style.
      brand_voice: brandVoice || undefined,
      creator_profile: creatorProfile || undefined,
      user_id: userId ?? undefined,
      tenant_id: tenantId ?? undefined,
      ...buildContentEngineScriptAttribution({
        contentProxyEnabled: runtimeOptions.localPrimaryAdmitted
          ?? isContentLocalPrimaryAdmitted(userId),
        providerBoundarySupplied: Boolean(providerBoundary),
        userId,
        tenantId,
        mode,
        operationId: runtimeOptions.operationId,
      }),
      force_refresh: forceRefresh || undefined,
      regeneration_seed: regenerationSeed || undefined,
    }),
  }, requestTimeoutMs);
  const result = providerBoundary
    ? await providerBoundary(invokeFreshProviderPath)
    : await invokeFreshProviderPath();
  throwIfContentEngineRequestCancelled(runtimeOptions.abortSignal);
  assertContentScriptOutputLanguage(normalizedLanguage, result, 'content-engine-script');

  // ── Cache store (skip for deep mode) ───────────────────────────
  if (executionPolicy.cache === 'default' && cfg.cacheTtl > 0 && (!forceRefresh || Boolean(regenerationSeed?.trim()))) {
    try {
      const { setCache } = await import('./cache-store');
      throwIfContentEngineRequestCancelled(runtimeOptions.abortSignal);
      setCache(normalizedKey, result, cfg.cacheTtl);
      logger.info(buildContentEngineCacheLogContext(topic, mode, false, cfg.cacheTtl), 'Script cached');
    } catch (error) {
      throwIfContentEngineRequestCancelled(runtimeOptions.abortSignal, error);
      // Cache store failed — non-fatal.
    }
  }

  throwIfContentEngineRequestCancelled(runtimeOptions.abortSignal);
  return result;
}

export async function getTitles(topic: string, niche = 'general', count = 10): Promise<TitlesResponse> {
  const creatorPayload = buildCurrentCreatorProfilePayload(null, 'content_engine');
  return engineFetch<TitlesResponse>('/titles', {
    method: 'POST',
    body: JSON.stringify({ topic, niche, count, ...creatorPayload }),
  }, 45_000);
}

export async function getThumbnail(title: string, niche = 'general'): Promise<ThumbnailResponse> {
  const creatorPayload = buildCurrentCreatorProfilePayload(null, 'content_engine');
  return engineFetch<ThumbnailResponse>('/thumbnail', {
    method: 'POST',
    body: JSON.stringify({ title, niche, ...creatorPayload }),
  }, 45_000);
}

export async function getCaption(topic: string, niche = 'general'): Promise<CaptionResponse> {
  const creatorPayload = buildCurrentCreatorProfilePayload(null, 'content_engine');
  return engineFetch<CaptionResponse>('/caption', {
    method: 'POST',
    body: JSON.stringify({ topic, niche, ...creatorPayload }),
  }, 45_000);
}

export async function getCompetitor(channel: string, maxVideos = 10): Promise<CompetitorResponse> {
  const creatorPayload = buildCurrentCreatorProfilePayload(null, 'content_engine');
  return engineFetch<CompetitorResponse>('/competitor', {
    method: 'POST',
    body: JSON.stringify({ channel, max_videos: maxVideos, ...creatorPayload }),
  }, 60_000);
}

export async function getGaps(niche = 'fitness', maxGaps = 10): Promise<GapsResponse> {
  const creatorPayload = buildCurrentCreatorProfilePayload(null, 'content_engine');
  return engineFetch<GapsResponse>('/gaps', {
    method: 'POST',
    body: JSON.stringify({ niche, max_gaps: maxGaps, ...creatorPayload }),
  }, 60_000);
}

export async function getSeo(topic: string): Promise<SeoResponse> {
  const creatorPayload = buildCurrentCreatorProfilePayload(null, 'content_engine');
  return engineFetch<SeoResponse>('/seo', {
    method: 'POST',
    body: JSON.stringify({ topic, ...creatorPayload }),
  }, 60_000);
}

export async function getRepurpose(topic: string, originalFormat = 'YouTube'): Promise<RepurposeResponse> {
  const creatorPayload = buildCurrentCreatorProfilePayload(null, 'content_engine');
  return engineFetch<RepurposeResponse>('/repurpose', {
    method: 'POST',
    body: JSON.stringify({ topic, original_format: originalFormat, ...creatorPayload }),
  }, 60_000);
}

export async function logFeedback(data: {
  video_url: string;
  views: number;
  retention_pct: number;
  likes?: number;
  comments?: number;
  subs_gained?: number;
  hook_used?: string;
  notes?: string;
}): Promise<FeedbackResponse> {
  const creatorPayload = buildCurrentCreatorProfilePayload(null, 'content_engine_feedback');
  return engineFetch<FeedbackResponse>('/feedback', {
    method: 'POST',
    body: JSON.stringify({ ...data, ...creatorPayload }),
  }, 45_000);
}

export async function getReport(period = 'week'): Promise<ReportResponse> {
  const creatorPayload = buildCurrentCreatorProfilePayload(null, 'content_engine_report');
  return engineFetch<ReportResponse>('/report', {
    method: 'POST',
    body: JSON.stringify({ period, ...creatorPayload }),
  }, 45_000);
}

// Legacy Telegram format-function re-exports removed with the Telegram
// legacy delivery path (2026-07). Consumers use the structured Response
// interfaces above.
