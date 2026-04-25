// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getCurrentRequestId, generateRequestId } from '../utils/request-context';
import { maybeSaveToFile, saveContentAsDocx } from './content-file-saver';
import type { AgentSignal } from './intelligence-bus';

export { maybeSaveToFile, saveContentAsDocx } from './content-file-saver';

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

// ── Phase 2: Visual + Social ──────────────────────────────────────────

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

// ── Phase 3: Creative Intelligence ────────────────────────────────────

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

// ── Phase 4: Strategic Intelligence ───────────────────────────────────

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

// ── Phase 5: Learning System ──────────────────────────────────────────

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

// ── HTTP Client ─────────────────────────────────────────────────────

const BASE_URL = `http://localhost:${config.contentEngine.port}/api/v1`;

// ── Health check + Circuit Breaker ─────────────────────────────────

let _lastHealthCheck = 0;
let _isHealthy = true;
let _consecutiveFailures = 0;
const HEALTH_CHECK_INTERVAL_MS = 60_000; // 1 minute between probes
const CIRCUIT_BREAKER_THRESHOLD = 3;     // 3 consecutive failures → fail-fast
const CIRCUIT_BREAKER_COOLDOWN_MS = 5 * 60_000; // 5 minutes

/**
 * Check if the Python content-engine is healthy.
 * Returns cached result if checked recently.
 */
export async function isContentEngineHealthy(): Promise<boolean> {
  if (Date.now() - _lastHealthCheck < HEALTH_CHECK_INTERVAL_MS) return _isHealthy;
  try {
    const res = await fetch(`${BASE_URL.replace('/api/v1', '')}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    _isHealthy = res.ok;
    _consecutiveFailures = _isHealthy ? 0 : _consecutiveFailures + 1;
  } catch {
    _isHealthy = false;
    _consecutiveFailures++;
  }
  _lastHealthCheck = Date.now();
  return _isHealthy;
}

/**
 * Retry wrapper with exponential backoff.
 * Retries up to 3 times with delays: 2s, 4s, 8s.
 */
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  // Circuit breaker: fail-fast if engine has been down
  if (_consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
    if (Date.now() - _lastHealthCheck < CIRCUIT_BREAKER_COOLDOWN_MS) {
      throw new Error('Content engine circuit breaker OPEN — too many consecutive failures. Cooling down.');
    }
    // Cooldown expired, reset and try
    _consecutiveFailures = 0;
  }

  let lastError: Error = new Error('Unknown');
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      _consecutiveFailures = 0; // success resets the counter
      return result;
    } catch (err) {
      lastError = err as Error;
      _consecutiveFailures++;
      if (attempt < maxRetries) {
        const delayMs = Math.pow(2, attempt + 1) * 1000; // 2s, 4s, 8s
        logger.warn({ attempt, delayMs, error: lastError.message }, 'Content engine call failed, retrying');
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }
  throw lastError;
}

async function engineFetch<T>(path: string, options?: RequestInit, timeoutMs = 30_000): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Distributed tracing: propagate the current requestId to the Python
  // content-engine via X-Request-Id (Quarter audit item). When this fetch
  // happens inside a request context (Telegram message, HTTP request,
  // or cron tick), getCurrentRequestId() returns the same ID that the
  // upstream is logging. The Python service has matching middleware in
  // content-engine/main.py that reads X-Request-Id and threads it through
  // its own contextvars-backed logging filter. Result: a single grep on
  // the requestId surfaces every log line from both services for one
  // logical operation.
  //
  // If we're outside any context (rare — startup work or unwrapped
  // background code) we still generate one so the content-engine call
  // is traceable from the Python side at least.
  const requestId = getCurrentRequestId() || generateRequestId();

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Request-Id': requestId,
        ...options?.headers,
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Content Engine ${res.status}: ${body}`);
    }
    return res.json() as Promise<T>;
  } finally {
    clearTimeout(timer);
  }
}

export async function deepSearch(query: string, niches?: string[], maxResults = 10): Promise<DeepSearchResponse> {
  return withRetry(() => engineFetch<DeepSearchResponse>('/deepsearch', {
    method: 'POST',
    body: JSON.stringify({ query, niches: niches || [], max_results: maxResults }),
  }, 180_000)); // deep search: 5 query variations + AI synthesis
}

export async function getSources(query: string): Promise<SourcesResponse> {
  return engineFetch<SourcesResponse>(`/sources?query=${encodeURIComponent(query)}`);
}

export async function getHotNews(): Promise<HotNewsResponse> {
  return engineFetch<HotNewsResponse>('/hotnews');
}

export function isContentEngineConfigured(): boolean {
  return config.contentEngine.enabled;
}

// ── Phase 2 API ─────────────────────────────────────────────────────

export async function getTrending(niche?: string): Promise<TrendingResponse> {
  const qs = niche ? `?niche=${encodeURIComponent(niche)}` : '';
  return engineFetch<TrendingResponse>(`/trending${qs}`);
}

export async function getReaction(topic: string): Promise<ReactionResponse> {
  return engineFetch<ReactionResponse>(`/reaction?topic=${encodeURIComponent(topic)}`);
}

// ── Phase 3 API ─────────────────────────────────────────────────────

export async function getHooks(topic: string, niche = 'general', count = 8): Promise<HooksResponse> {
  return engineFetch<HooksResponse>('/hooks', {
    method: 'POST',
    body: JSON.stringify({ topic, niche, count }),
  }, 45_000);
}

// ── Generation Mode Configuration ──────────────────────────────────
//
// Mode controls three levers: cache behavior, signal window, and timeout.
//
//   Quick:    cache-first (48h), no signals, 60s timeout  (~$0.003 cached, ~$0.005 fresh)
//   Standard: cache 24h, 30-day signals, 180s timeout     (~$0.01-0.02)
//   Deep:     skip cache, 90-day signals, 300s timeout     (~$0.02-0.05)

export type ScriptGenerationMode = 'quick' | 'standard' | 'deep';
export type ScriptRenderMode = 'structured' | 'chat';
export type ScriptStyle = 'detailed' | 'bullets';

const MODE_CONFIG: Record<ScriptGenerationMode, { cacheTtl: number; signalDays: number; timeoutMs: number }> = {
  quick:    { cacheTtl: 48 * 3600, signalDays: 0,  timeoutMs: 60_000 },
  standard: { cacheTtl: 24 * 3600, signalDays: 30, timeoutMs: 180_000 },
  deep:     { cacheTtl: 0,         signalDays: 90, timeoutMs: 300_000 },
};

function normalizeScriptLanguage(language?: string | null): string {
  const normalized = String(language || 'pt-BR').trim().toLowerCase();
  if (normalized.startsWith('en')) return 'en-US';
  if (normalized === 'pt-pt' || normalized.includes('european')) return 'pt-PT';
  return 'pt-BR';
}

function normalizeScriptRenderMode(renderMode?: string | null): ScriptRenderMode {
  return String(renderMode || 'structured').trim().toLowerCase() === 'chat'
    ? 'chat'
    : 'structured';
}

function normalizeScriptStyle(style?: string | null): ScriptStyle {
  const normalized = String(style || 'detailed').trim().toLowerCase();
  return ['bullet', 'bullets', 'outline', 'pontos'].includes(normalized)
    ? 'bullets'
    : 'detailed';
}

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
  mode: ScriptGenerationMode = 'standard',
  brandVoice?: string | null,
  language?: string | null,
  renderMode: ScriptRenderMode = 'structured',
  userId?: number,
  scriptContext?: ScriptTopicContext | null,
  scriptStyle: ScriptStyle = 'detailed',
): string {
  return [
    'script-v5',
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
  ].join(':');
}

export async function getScript(
  topic: string, niche = 'general', maxDuration = 8, format = 'YouTube',
  mode: ScriptGenerationMode = 'standard',
  brandVoice?: string | null,
  language = 'pt-BR',
  renderMode: ScriptRenderMode = 'structured',
  userId?: number,
  targetDurationSeconds?: number | null,
  scriptContext?: ScriptTopicContext | null,
  scriptStyle: ScriptStyle = 'detailed',
): Promise<ScriptResponse> {
  const cfg = MODE_CONFIG[mode];
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
  );

  // ── Cache check (skip for deep mode — always generate fresh) ──
  if (cfg.cacheTtl > 0) {
    try {
      const { getCached } = await import('./cache-store');
      const cached = getCached<ScriptResponse>(normalizedKey);
      if (cached) {
        logger.info({ topic, mode, cacheHit: true }, 'Script cache hit — returning cached result');
        return cached;
      }
    } catch { /* cache unavailable — generate fresh */ }
  }

  // ── Intelligence bus signals (skip for quick mode) ──────────────
  let contextSignals: any[] = [];
  if (cfg.signalDays > 0) {
    try {
      const { readSignals } = await import('./intelligence-bus');
      const signalTypes = [
        'hook_effectiveness', 'voice_pattern', 'voice_phrase_trend',
        'channel_dna', 'book_knowledge', 'keyword_rank_change',
        'retention_pattern', 'pillar_performance',
      ] as const;
      // FIX: signalDays is a time window, not a count limit.
      // readSignals(consumer, types, limit, userId, maxAgeDays)
      // CONT-M1: null-coalesce in case readSignals returns null/undefined
      const raw = readSignals('script-engine', [...signalTypes], 100, userId, cfg.signalDays) || [];
      const ranked = rankScriptSignals(raw, topic, niche, scriptContext);
      const signalLimit = mode === 'deep' ? 10 : 6;
      contextSignals = ranked.slice(0, signalLimit).map(s => ({
        type: s.signal_type,
        source: s.source_agent,
        payload: s.payload,
      }));
      logger.info({ signalCount: contextSignals.length, rawSignalCount: raw.length, mode, signalDays: cfg.signalDays }, 'Injecting ranked bus signals');
    } catch {
      // Bus unavailable — generate without signals (backward compatible)
    }
  }

  const result = await engineFetch<ScriptResponse>('/script', {
    method: 'POST',
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
    }),
  }, cfg.timeoutMs);

  // ── Cache store (skip for deep mode) ───────────────────────────
  if (cfg.cacheTtl > 0) {
    try {
      const { setCache } = await import('./cache-store');
      setCache(normalizedKey, result, cfg.cacheTtl);
      logger.info({ topic, mode, cacheHit: false, cacheTtl: cfg.cacheTtl }, 'Script cached');
    } catch { /* cache store failed — non-fatal */ }
  }

  return result;
}

export async function getTitles(topic: string, niche = 'general', count = 10): Promise<TitlesResponse> {
  return engineFetch<TitlesResponse>('/titles', {
    method: 'POST',
    body: JSON.stringify({ topic, niche, count }),
  }, 45_000);
}

export async function getThumbnail(title: string, niche = 'general'): Promise<ThumbnailResponse> {
  return engineFetch<ThumbnailResponse>('/thumbnail', {
    method: 'POST',
    body: JSON.stringify({ title, niche }),
  }, 45_000);
}

export async function getCaption(topic: string, niche = 'general'): Promise<CaptionResponse> {
  return engineFetch<CaptionResponse>('/caption', {
    method: 'POST',
    body: JSON.stringify({ topic, niche }),
  }, 45_000);
}

// ── Phase 4 API ─────────────────────────────────────────────────────

export async function getCompetitor(channel: string, maxVideos = 10): Promise<CompetitorResponse> {
  return engineFetch<CompetitorResponse>('/competitor', {
    method: 'POST',
    body: JSON.stringify({ channel, max_videos: maxVideos }),
  }, 60_000);
}

export async function getGaps(niche = 'fitness', maxGaps = 10): Promise<GapsResponse> {
  return engineFetch<GapsResponse>('/gaps', {
    method: 'POST',
    body: JSON.stringify({ niche, max_gaps: maxGaps }),
  }, 60_000);
}

export async function getSeo(topic: string): Promise<SeoResponse> {
  return engineFetch<SeoResponse>('/seo', {
    method: 'POST',
    body: JSON.stringify({ topic }),
  }, 60_000);
}

export async function getRepurpose(topic: string, originalFormat = 'YouTube'): Promise<RepurposeResponse> {
  return engineFetch<RepurposeResponse>('/repurpose', {
    method: 'POST',
    body: JSON.stringify({ topic, original_format: originalFormat }),
  }, 60_000);
}

// ── Phase 5 API ─────────────────────────────────────────────────────

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
  return engineFetch<FeedbackResponse>('/feedback', {
    method: 'POST',
    body: JSON.stringify(data),
  }, 45_000);
}

export async function getReport(period = 'week'): Promise<ReportResponse> {
  return engineFetch<ReportResponse>(`/report?period=${encodeURIComponent(period)}`);
}

// ── Telegram Formatters — MOVED ─────────────────────────────────────
//
// All 16 format functions (formatDeepSearch, formatScript, formatHotNews,
// etc.) have been physically moved to content-telegram-formatter.ts
// (April 2026). Core content services return structured response types
// only — no Telegram HTML formatting.
//
// The Telegram handler imports directly from content-telegram-formatter.ts.
// This file (content-engine.ts) is now purely a structured data service.

// Re-export for any remaining backward-compat imports:
export {
  formatDeepSearch, formatSources, formatHotNews,
  formatTrending, formatReaction, formatHooks, formatScript, formatTitles,
  formatThumbnail, formatCaption, formatCompetitor, formatGaps, formatSeo,
  formatRepurpose, formatFeedback, formatReport,
} from './content-telegram-formatter';

// ── END OF FILE ─────────────────────────────────────────────────────
// (The 350 LOC of inline format functions that used to be here have been
// moved to content-telegram-formatter.ts. See git history for the
// original implementations if needed.)

// NOTE: The lines below were the old inline implementations. They have
// been deleted. If you need them, check content-telegram-formatter.ts.
// (end of content-engine.ts — format functions live in content-telegram-formatter.ts)
