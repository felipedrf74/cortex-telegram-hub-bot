// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getCurrentRequestId, generateRequestId } from '../utils/request-context';
import { uploadToDrive } from './google-drive';

// ── File Saver for large outputs ────────────────────────────────────

const IDEAS_DIR = process.env.IDEAS_DIR || path.join(os.homedir(), 'Desktop', 'IDEAS');

/** Threshold in chars — if formatted message exceeds this, save to file */
const FILE_THRESHOLD = 3500;

/** Command → subfolder mapping */
const COMMAND_FOLDERS: Record<string, string> = {
  // RESEARCH — raw input & trending data
  deepsearch: 'RESEARCH',
  sources: 'RESEARCH',
  hotnews: 'RESEARCH',
  trending: 'RESEARCH',
  discover: 'RESEARCH',
  transcribe: 'RESEARCH',
  // IDEAS — ideation, hooks, titles, reactions, studies
  ideas: 'IDEAS',
  reaction: 'IDEAS',
  hooks: 'IDEAS',
  titles: 'IDEAS',
  video: 'IDEAS',
  reel: 'IDEAS',
  calendar: 'IDEAS',
  contenttopic: 'IDEAS',
  studyvideo: 'IDEAS',
  // SCRIPTS — production-ready scripts & repurpose
  genscript: 'SCRIPTS',
  script: 'SCRIPTS',
  buildscript: 'SCRIPTS',
  repurpose: 'SCRIPTS',
  // VISUALS — thumbnails & captions
  genthumbnail: 'VISUALS',
  gencaption: 'VISUALS',
  // REPORTS — analysis, competitive intel, feedback
  competitor: 'REPORTS',
  gaps: 'REPORTS',
  seo: 'REPORTS',
  brandcheck: 'REPORTS',
  feedback: 'REPORTS',
  report: 'REPORTS',
};

/**
 * Converts HTML-formatted content into a DOCX document with proper formatting.
 */
function htmlToDocxChildren(content: string): Paragraph[] {
  const plain = content
    .replace(/<a href="([^"]*)">[^<]*<\/a>/g, '$1')
    .replace(/<code>[^<]*<\/code>/g, (m) => m.replace(/<\/?code>/g, ''));

  const lines = plain.split('\n');
  const children: Paragraph[] = [];

  for (const line of lines) {
    if (!line.trim()) {
      children.push(new Paragraph({ text: '' }));
      continue;
    }

    // Parse inline bold/italic from HTML tags
    const runs: TextRun[] = [];
    const regex = /(<b>(.+?)<\/b>|<i>(.+?)<\/i>|([^<]+|<[^>]*>))/g;
    let match;
    let hasRuns = false;
    const stripped = line.replace(/<[^>]*>/g, '').trim();

    // Check if line looks like a heading (starts with emoji + all caps or bold)
    const isHeading = /^[🔥🎯📌🎣⏰📊🔍💡📝🎬🖼️📢✂️📁🏆⚡🧠💰🎯🔎📈💪🏃‍♂️🚴‍♂️⛪🇧🇷🌍]/.test(stripped) && stripped.length < 100;

    if (isHeading && stripped === stripped) {
      // Bold heading-like line
      children.push(new Paragraph({
        children: [new TextRun({ text: stripped, bold: true, size: 24, font: 'Calibri' })],
        spacing: { before: 120, after: 60 },
      }));
      continue;
    }

    // Parse runs with bold/italic
    while ((match = regex.exec(line)) !== null) {
      if (match[2]) {
        runs.push(new TextRun({ text: match[2], bold: true, font: 'Calibri', size: 22 }));
        hasRuns = true;
      } else if (match[3]) {
        runs.push(new TextRun({ text: match[3], italics: true, font: 'Calibri', size: 22 }));
        hasRuns = true;
      } else if (match[4] && !match[4].startsWith('<')) {
        runs.push(new TextRun({ text: match[4], font: 'Calibri', size: 22 }));
        hasRuns = true;
      }
    }

    if (!hasRuns) {
      // Fallback — strip all HTML and add as plain text
      runs.push(new TextRun({ text: stripped, font: 'Calibri', size: 22 }));
    }

    children.push(new Paragraph({ children: runs, spacing: { before: 40, after: 40 } }));
  }

  return children;
}

export interface DocxResult {
  filePath: string;
  driveUrl?: string;
}

/**
 * Saves content as DOCX to IDEAS/<subfolder>/<slug>_<command>_<date>.docx
 * Returns the file path + Drive URL, or null if content was short enough for inline display.
 */
export async function saveContentAsDocx(
  content: string,
  command: string,
  topic: string,
  forceFile = false,
): Promise<DocxResult | null> {
  if (!forceFile && content.length < FILE_THRESHOLD) return null;

  const today = new Date().toISOString().slice(0, 10);
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9àáâãéêíóôõúç]+/gi, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 60);

  const subfolder = COMMAND_FOLDERS[command] || 'OTHER';
  const dir = path.join(IDEAS_DIR, subfolder);
  const filename = `${slug}_${command}_${today}.docx`;
  const filePath = path.join(dir, filename);

  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const titleText = `${command.toUpperCase()} — ${topic}`;
    const docChildren = [
      new Paragraph({
        children: [new TextRun({ text: titleText, bold: true, size: 32, font: 'Calibri', color: '1A1A2E' })],
        heading: HeadingLevel.HEADING_1,
        spacing: { after: 100 },
      }),
      new Paragraph({
        children: [new TextRun({ text: `Generated: ${today}`, italics: true, size: 18, font: 'Calibri', color: '6B7280' })],
        spacing: { after: 200 },
      }),
      ...htmlToDocxChildren(content),
    ];

    const doc = new Document({
      sections: [{ children: docChildren }],
    });

    const buffer = await Packer.toBuffer(doc);
    fs.writeFileSync(filePath, buffer);
    logger.info({ filePath, chars: content.length }, `Saved ${command} output as DOCX`);

    // Upload to Google Drive — wait briefly for URL to include in Telegram caption
    let driveUrl: string | undefined;
    try {
      driveUrl = await uploadToDrive(filePath, filename, subfolder) || undefined;
    } catch {
      // Drive upload failure is non-critical
    }

    return { filePath, driveUrl };
  } catch (err) {
    logger.error({ err }, 'Failed to save content DOCX');
    return null;
  }
}

/**
 * Legacy sync wrapper — saves as plain text. Kept for backward compat.
 */
export function maybeSaveToFile(
  content: string,
  command: string,
  topic: string,
  forceFile = false,
): string | null {
  if (!forceFile && content.length < FILE_THRESHOLD) return null;

  const today = new Date().toISOString().slice(0, 10);
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9àáâãéêíóôõúç]+/gi, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 60);
  const filename = `${slug}_${command}_${today}.txt`;
  const filePath = path.join(IDEAS_DIR, filename);

  const plain = content
    .replace(/<b>/g, '**').replace(/<\/b>/g, '**')
    .replace(/<i>/g, '_').replace(/<\/i>/g, '_')
    .replace(/<a href="([^"]*)">[^<]*<\/a>/g, '$1')
    .replace(/<[^>]*>/g, '');

  try {
    if (!fs.existsSync(IDEAS_DIR)) fs.mkdirSync(IDEAS_DIR, { recursive: true });
    fs.writeFileSync(filePath, plain, 'utf-8');
    logger.info({ filePath, chars: content.length }, `Saved ${command} output to file`);
    return filePath;
  } catch (err) {
    logger.error({ err }, 'Failed to save content file');
    return null;
  }
}

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

// Script cache TTL: 24 hours. Scripts are expensive ($0.01-0.08 per generation).
// Cache key normalizes topic to lowercase trimmed to avoid near-duplicates.
const SCRIPT_CACHE_TTL = 24 * 3600; // 24 hours

export async function getScript(topic: string, niche = 'general', maxDuration = 8, format = 'YouTube'): Promise<ScriptResponse> {
  // ── Cache check ──────────────────────────────────────────────────
  // Same topic + niche + format within 24h → return cached result.
  // Saves $0.01-0.08 per duplicate request.
  const normalizedKey = `script:${topic.toLowerCase().trim()}:${niche}:${format}`;
  try {
    const { getCached } = await import('./cache-store');
    const cached = getCached<ScriptResponse>(normalizedKey);
    if (cached) {
      logger.info({ topic, cacheHit: true }, 'Script cache hit — returning cached result');
      return cached;
    }
  } catch { /* cache unavailable — generate fresh */ }

  // Query intelligence bus for context signals
  let contextSignals: any[] = [];
  try {
    const { readSignals } = await import('./intelligence-bus');
    const signalTypes = [
      'hook_effectiveness', 'voice_pattern', 'voice_phrase_trend',
      'channel_dna', 'book_knowledge', 'keyword_rank_change',
      'retention_pattern', 'pillar_performance',
    ] as const;
    const raw = readSignals('script-engine', [...signalTypes], 30);
    contextSignals = raw.map(s => ({
      type: s.signal_type,
      source: s.source_agent,
      payload: s.payload,
    }));
    logger.info({ signalCount: contextSignals.length }, 'Injecting bus signals into script generation');
  } catch {
    // Bus unavailable — generate without signals (backward compatible)
  }

  const result = await engineFetch<ScriptResponse>('/script', {
    method: 'POST',
    body: JSON.stringify({
      topic, niche, format,
      max_duration_minutes: maxDuration,
      context_signals: contextSignals.length > 0 ? contextSignals : undefined,
    }),
  }, 180_000); // scripts take longer — research + Sonnet generation

  // ── Cache store ──────────────────────────────────────────────────
  try {
    const { setCache } = await import('./cache-store');
    setCache(normalizedKey, result, SCRIPT_CACHE_TTL);
    logger.info({ topic, cacheHit: false }, 'Script cached for 24h');
  } catch { /* cache store failed — non-fatal */ }

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

