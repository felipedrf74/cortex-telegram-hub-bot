// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Channel Learner Service
 *
 * Analyzes YouTube reference channels to extract content creation patterns:
 * 1. Fetches recent videos via YouTube Data API (title, description, stats)
 * 2. Sends video metadata to Claude for pattern extraction
 * 3. Stores extracted patterns per channel in SQLite
 * 4. Synthesizes cross-channel knowledge into a unified knowledge base
 * 5. Knowledge is injected into the content domain's system prompt
 *
 * The result: the content AI learns hook styles, title formulas, content
 * structures, storytelling techniques, etc. from the best creators.
 */
import Anthropic from '@anthropic-ai/sdk';
import { createHash, randomUUID } from 'crypto';
import { config } from '../config';
import { logger } from '../utils/logger';
import { trackedCreate } from './anthropic-hook';
import { completeOneShotWithFallback } from './gemini-provider';
import { loadPrompt } from '../utils/prompt-loader';
import { pushEvent } from '../portal/telemetry';
import { deepAnalyzeTopVideos } from './video-study';
import {
  addChannel,
  addSystemChannel,
  createContentReferencesAdminContext,
  getActiveChannels,
  getAllChannels,
  getSystemChannels,
  getPatternsForChannel,
  updateChannelStatus,
  upsertPatterns,
  upsertKnowledge,
  upsertSystemKnowledge,
  PATTERN_CATEGORIES,
  type PatternCategory,
  type ContentRefChannel,
  type ContentReferencesAccess,
} from '../state/content-references';
import { writeGovernedSignal } from './intelligence-bus';
import { getDb } from './database';
import {
  buildCreatorPromptContext,
  loadCreatorPromptContextForUser,
  type CreatorPromptContext,
} from './content-profile-prompt-context';
import type { ContentCreatorProfile } from '../state/content-creator-profile';
import {
  contentScopeParams,
  contentScopePredicate,
  ensureContentTenantScopeColumns,
  resolveContentTenantId,
} from './content-tenant-scope';
import { sanitizeForPromptInterpolation } from '../utils/prompt-sanitizer';
import {
  recordAiAutomationEligibilitySkip,
  resolveAiAutomationEligibility,
} from './ai-automation-policy';
import { AiBudgetError, withAiBudgetReservation, type AiBudgetRequest } from './cost-guardrail';
import { ApiUsagePersistenceError } from './api-usage-fallback';
import { invalidateContentDerivedCaches } from './cache-coherence-registry';

const CHANNEL_LEARNER_SIGNAL_PRODUCER_VERSION = 'channel-learner.v1';
const client = new Anthropic({
  apiKey: config.anthropic.apiKey,
  // Each extraction/synthesis call is cost-bearing and has no durable replay
  // identity at the provider boundary. Transport retries are therefore unsafe.
  maxRetries: 0,
});

const CONTENT_LEARNER_ADMIN_CONTEXT = createContentReferencesAdminContext('channel-learner system-scope processing');

// Flash remains the parity-approved extraction/synthesis model. Compact,
// balanced inputs plus a validated 2,304-token JSON cap keep the concrete
// worst-case reservation below the Pro $0.012 daily automation ceiling when
// no higher-priority work/spend is outstanding; Max retains more headroom.
const CHANNEL_LEARNING_MODEL = 'gemini-2.5-flash';
const CHANNEL_LEARNING_MAX_OUTPUT_TOKENS = 2_304;
const CHANNEL_EXTRACTION_SYSTEM_PROMPT_MAX_CHARS = 3_000;
const CHANNEL_EXTRACTION_USER_PROMPT_MAX_CHARS = 7_000;
const CHANNEL_SYNTHESIS_SYSTEM_PROMPT_MAX_CHARS = 3_000;
const CHANNEL_SYNTHESIS_USER_PROMPT_MAX_CHARS = 6_000;
const CHANNEL_LEARNING_BASE_CATEGORY = 'channel_learning';
const CHANNEL_LEARNING_UNSUPPORTED_SCOPE_MESSAGE = 'Channel analysis and synthesis currently support user-default tenant only';

export class UnsupportedChannelLearningScopeError extends Error {
  readonly code = 'UNSUPPORTED_SCOPE';
  readonly status = 409;

  constructor() {
    super(CHANNEL_LEARNING_UNSUPPORTED_SCOPE_MESSAGE);
    this.name = 'UnsupportedChannelLearningScopeError';
  }
}

export class ChannelAutomationTargetsUnavailableError extends Error {
  readonly code = 'CONTENT_CHANNEL_AUTOMATION_TARGETS_UNAVAILABLE';
  readonly status = 503;
  readonly retryable = true;

  constructor() {
    super('Active Content channel-learning targets are temporarily unavailable.');
    this.name = 'ChannelAutomationTargetsUnavailableError';
  }
}

export class ChannelSourceUnavailableError extends Error {
  readonly code = 'CONTENT_CHANNEL_SOURCE_UNAVAILABLE';
  readonly status = 503;
  readonly retryable = true;
  readonly source = 'youtube';

  constructor(readonly reason: 'configuration' | 'transport' | 'http' | 'invalid_response') {
    super('The YouTube channel source is temporarily unavailable.');
    this.name = 'ChannelSourceUnavailableError';
  }
}

function assertSupportedChannelLearningScope(userId: number, tenantId?: number): void {
  if (userId > 0 && resolveContentTenantId(userId, tenantId) !== userId) {
    throw new UnsupportedChannelLearningScopeError();
  }
}

function safeChannelErrorName(error: unknown): string {
  const candidate = error instanceof Error && error.name ? error.name : typeof error;
  return candidate.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80) || 'UnknownError';
}

function channelInputDiagnostics(value: string): { inputHash: string; inputLength: number } {
  return {
    inputHash: createHash('sha256').update(value).digest('hex').slice(0, 16),
    inputLength: value.length,
  };
}

function invalidateChannelLearnerContentCaches(userId?: number): void {
  try {
    invalidateContentDerivedCaches(userId != null && userId > 0 ? userId : undefined);
  } catch {
    // A cache clear cannot undo the committed channel/knowledge mutation and
    // must not change the learner's reported provider or persistence result.
  }
}

function compactBalancedText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const marker = '\n...[budget-safe compacted context]...\n';
  const available = Math.max(0, maxChars - marker.length);
  const head = Math.floor(available * 0.7);
  return `${value.slice(0, head)}${marker}${value.slice(value.length - (available - head))}`;
}

function channelStageJobName(base: string | null | undefined, stage: 'extract' | 'synthesize'): string {
  const normalized = String(base || 'channel_relearn').trim() || 'channel_relearn';
  return `${normalized}:${stage}`;
}

type AIMeteringScope = {
  userId?: number;
  tenantId?: number;
};

type ChannelAiBudgetContext = Pick<
  AiBudgetRequest,
  'requestSource' | 'jobName' | 'runId' | 'estimatedCostUsd'
> & { abortSignal?: AbortSignal };

function throwIfChannelLearningAborted(abortSignal?: AbortSignal): void {
  if (!abortSignal?.aborted) return;
  if (abortSignal.reason instanceof Error) throw abortSignal.reason;
  throw Object.assign(new Error('channel_learning_cancelled'), {
    name: 'AbortError',
    code: 'ACCOUNT_DELETION_IN_PROGRESS',
  });
}

function recordChannelSynthesisContractDeferral(
  userId: number,
  budgetContext: ChannelAiBudgetContext,
): void {
  const jobName = channelStageJobName(budgetContext.jobName, 'synthesize');
  try {
    getDb().prepare(`
      INSERT INTO ai_budget_deferrals (
        user_id, request_source, job_name, base_category, run_id,
        code, budget_window, reset_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'global', NULL)
    `).run(
      userId,
      budgetContext.requestSource,
      jobName,
      CHANNEL_LEARNING_BASE_CATEGORY,
      budgetContext.runId ?? null,
      'CHANNEL_SYNTHESIS_PROMPT_CONTRACT_EXCEEDED',
    );
  } catch (err) {
    // Migration 226 is additive and may not exist during an observe-only
    // rolling deploy. The provider call still remains fail-closed.
    logger.warn(
      { errorName: safeChannelErrorName(err), userId, jobName, runId: budgetContext.runId ?? null },
      'Channel synthesis contract deferral persistence unavailable',
    );
  }
}

// ─── Re-learn cost controls (migration 222) ──────────────────────────
//
// 2026-07-03 audit: the weekly channel_relearn cron re-ran the full
// extraction + synthesis LLM pipeline for every active channel each cycle
// even when the channel had published nothing new, and auto-retried failed
// channels every cycle (12h threshold == below cron cadence) forever.
//
// Controls:
//   1. New-video gate — analysis_fingerprint on content_ref_channels stores
//      a deterministic fingerprint of the video set from the last successful
//      analysis. On re-learn, if the freshly fetched video list fingerprints
//      identically, extraction + synthesis are skipped for that channel.
//      NULL fingerprint (pre-migration rows, first run) always analyzes.
//   2. Failure backoff — consecutive_failure_count is incremented on every
//      failed analysis and reset on success (including a fingerprint skip).
//      At >= CHANNEL_FAILURE_BACKOFF_THRESHOLD the 12h auto-retry is backed
//      off to at most one retry per 7 days.

const CHANNEL_FAILURE_BACKOFF_THRESHOLD = 3;

/** Extra columns added by migration 222 (not part of the shared state type). */
type ChannelLearnerCostControlColumns = {
  analysis_fingerprint?: string | null;
  last_checked_at?: string | null;
  consecutive_failure_count?: number | null;
};

/**
 * Deterministic fingerprint of the video set an analysis is based on.
 * Order-insensitive (IDs are sorted) so pure ranking shuffles of the same
 * video set do not trigger a re-analysis.
 */
export function computeChannelAnalysisFingerprint(videos: Pick<VideoData, 'videoId'>[]): string {
  const ids = videos.map((v) => v.videoId).filter(Boolean).sort();
  return `v1:${ids.length}:${ids.join(',')}`;
}

/** Increment the consecutive failure counter; log when the channel enters backoff. */
function recordChannelAnalysisFailure(channelId: number): void {
  try {
    const db = getDb();
    db.prepare(`
      UPDATE content_ref_channels
         SET consecutive_failure_count = COALESCE(consecutive_failure_count, 0) + 1
       WHERE id = ?
    `).run(channelId);
    const row = db.prepare(
      'SELECT channel_name, COALESCE(consecutive_failure_count, 0) AS failures FROM content_ref_channels WHERE id = ?',
    ).get(channelId) as { channel_name: string | null; failures: number } | undefined;
    if (row && row.failures === CHANNEL_FAILURE_BACKOFF_THRESHOLD) {
      logger.warn(
        { channelId, consecutiveFailures: row.failures },
        'Channel entered failure backoff — auto-retry limited to once per 7 days until a successful analysis',
      );
    }
  } catch (err) {
    logger.warn(
      { errorName: safeChannelErrorName(err), channelId },
      'Failed to record channel analysis failure metadata (non-critical)',
    );
  }
}

/**
 * Persist success metadata: fingerprint of the analyzed (or verified-unchanged)
 * video set, last_checked_at, and a failure-count reset. Logs when a channel
 * leaves failure backoff.
 */
function recordChannelAnalysisSuccess(channelId: number, fingerprint: string): void {
  try {
    const db = getDb();
    const row = db.prepare(
      'SELECT channel_name, COALESCE(consecutive_failure_count, 0) AS failures FROM content_ref_channels WHERE id = ?',
    ).get(channelId) as { channel_name: string | null; failures: number } | undefined;
    db.prepare(`
      UPDATE content_ref_channels
         SET analysis_fingerprint = ?,
             last_checked_at = datetime('now'),
             consecutive_failure_count = 0
       WHERE id = ?
    `).run(fingerprint, channelId);
    if (row && row.failures >= CHANNEL_FAILURE_BACKOFF_THRESHOLD) {
      logger.info(
        { channelId, previousConsecutiveFailures: row.failures },
        'Channel left failure backoff after successful analysis',
      );
    }
  } catch (err) {
    logger.warn(
      { errorName: safeChannelErrorName(err), channelId },
      'Failed to record channel analysis success metadata (non-critical)',
    );
  }
}

function accessForChannel(channel: Pick<ContentRefChannel, 'user_id' | 'tenant_id'>): ContentReferencesAccess {
  return channel.user_id && channel.user_id > 0
    ? { userId: channel.user_id, tenantId: channel.tenant_id ?? undefined }
    : { adminContext: CONTENT_LEARNER_ADMIN_CONTEXT };
}

function accessForUserId(userId?: number): ContentReferencesAccess {
  return userId && userId > 0
    ? { userId }
    : { adminContext: CONTENT_LEARNER_ADMIN_CONTEXT };
}

function getScopeClause(userId?: number): { clause: string; params: unknown[] } {
  if (userId != null && userId > 0) {
    return {
      clause: contentScopePredicate(),
      params: contentScopeParams(userId),
    };
  }
  return {
    clause: "COALESCE(scope_status, 'quarantined') = 'active' AND COALESCE(visibility_scope, 'platform_internal') IN ('platform_internal', 'public_published') AND COALESCE(tenant_id, 0) = 0",
    params: [],
  };
}

function getScopedChannelsForProcessing(
  status: ContentRefChannel['status'],
  userId?: number,
): ContentRefChannel[] {
  const db = getDb();
  ensureContentTenantScopeColumns(db);
  const { clause, params } = getScopeClause(userId);
  return db.prepare(
    `SELECT * FROM content_ref_channels
      WHERE status = ?
        AND ${clause}
      ORDER BY created_at ASC`,
  ).all(status, ...params) as ContentRefChannel[];
}

function listContentChannelUserIds(): number[] {
  const db = getDb();
  ensureContentTenantScopeColumns(db);
  const rows = db.prepare(
    `SELECT DISTINCT user_id
       FROM content_ref_channels
      WHERE COALESCE(scope_status, CASE WHEN user_id > 0 THEN 'active' ELSE 'quarantined' END) = 'active'
        AND COALESCE(visibility_scope, CASE WHEN user_id > 0 THEN 'user_private' ELSE 'platform_internal' END) = 'user_private'
        AND COALESCE(tenant_id, user_id) = user_id
        AND COALESCE(owner_user_id, user_id) = user_id
        AND user_id > 0
      ORDER BY user_id ASC`,
  ).all() as Array<{ user_id: number }>;
  return rows.map((row) => row.user_id);
}

function listEligibleContentAutomationUserIds(): number[] {
  const candidateIds = new Set<number>();
  try {
    const rows = getDb().prepare(
      "SELECT id FROM users WHERE status = 'active' ORDER BY id ASC",
    ).all() as Array<{ id: number }>;
    for (const row of rows) {
      if (Number.isSafeInteger(row.id) && row.id > 0) candidateIds.add(row.id);
    }
  } catch (err) {
    logger.warn(
      { errorName: safeChannelErrorName(err) },
      'Unable to enumerate active Content automation consumers',
    );
    throw new ChannelAutomationTargetsUnavailableError();
  }

  const eligible: number[] = [];
  for (const userId of candidateIds) {
    const result = resolveAiAutomationEligibility(userId, 'content');
    if (result.allowed) {
      eligible.push(userId);
    } else {
      recordAiAutomationEligibilitySkip(userId, result, {
        jobName: 'channel_relearn',
        baseCategory: 'channel_learning',
      });
      logger.debug(
        {
          userId,
          reason: result.reason,
          entitlementSource: result.entitlement.source,
        },
        'Channel re-learn scope skipped before YouTube/provider work',
      );
    }
  }
  return eligible;
}

/** Durable proof that shared system knowledge was injected into this user's prompt. */
function hasSharedChannelKnowledgeConsumerEvidence(userId: number): boolean {
  try {
    const row = getDb().prepare(`
      SELECT EXISTS(
        SELECT 1
          FROM shared_knowledge_consumption
         WHERE user_id = ?
           AND tenant_id = ?
           AND source = 'content_prompt'
           AND consumed_at >= datetime('now', '-30 days')
      ) AS consuming
    `).get(userId, userId) as { consuming: number };
    return row.consuming === 1;
  } catch (err) {
    logger.warn(
      { errorName: safeChannelErrorName(err), userId },
      'Shared channel learning consumer evidence unavailable; platform scope skipped fail-closed',
    );
    return false;
  }
}

function recordSharedKnowledgeEvidenceDeferral(): void {
  try {
    getDb().prepare(`
      INSERT INTO ai_budget_deferrals (
        user_id, request_source, job_name, base_category, run_id,
        code, budget_window, reset_at
      )
      SELECT 0, 'system', 'channel_relearn', 'channel_learning', NULL,
             'SHARED_KNOWLEDGE_CONSUMPTION_REQUIRED', 'policy', NULL
      WHERE NOT EXISTS (
        SELECT 1 FROM ai_budget_deferrals
         WHERE user_id = 0
           AND request_source = 'system'
           AND job_name = 'channel_relearn'
           AND code = 'SHARED_KNOWLEDGE_CONSUMPTION_REQUIRED'
           AND created_at >= datetime('now', 'start of day')
      )
    `).run();
  } catch (err) {
    logger.warn(
      { errorName: safeChannelErrorName(err) },
      'Channel platform-scope evidence deferral could not be persisted',
    );
  }
}

// ─── YouTube Data API helpers ────────────────────────────────────────

const YT_API_KEY = process.env.YOUTUBE_API_KEY || '';
const YT_SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';
const YT_VIDEOS_URL = 'https://www.googleapis.com/youtube/v3/videos';
const YT_CHANNELS_URL = 'https://www.googleapis.com/youtube/v3/channels';

async function readYouTubeItems(response: Response): Promise<unknown[]> {
  if (!response.ok) throw new ChannelSourceUnavailableError('http');
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ChannelSourceUnavailableError('invalid_response');
  }
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') {
    throw new ChannelSourceUnavailableError('invalid_response');
  }
  const items = (payload as { items?: unknown }).items;
  if (!Array.isArray(items)) throw new ChannelSourceUnavailableError('invalid_response');
  return items;
}

interface VideoData {
  videoId: string;
  title: string;
  description: string;
  publishedAt: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  duration: string;
  channelTitle: string;
}

function youtubePayloadRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseYouTubeCount(value: unknown, optional = false): number {
  if (value === undefined && optional) return 0;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new ChannelSourceUnavailableError('invalid_response');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ChannelSourceUnavailableError('invalid_response');
  }
  return parsed;
}

function parseYouTubeVideoDetails(
  item: unknown,
  requestedVideoIds: ReadonlySet<string>,
  seenVideoIds: Set<string>,
): VideoData {
  const video = youtubePayloadRecord(item);
  const snippet = youtubePayloadRecord(video?.snippet);
  const statistics = youtubePayloadRecord(video?.statistics);
  const contentDetails = youtubePayloadRecord(video?.contentDetails);
  const videoId = typeof video?.id === 'string' ? video.id.trim() : '';
  const title = typeof snippet?.title === 'string' ? snippet.title.trim() : '';
  const description = snippet?.description;
  const publishedAt = typeof snippet?.publishedAt === 'string' ? snippet.publishedAt.trim() : '';
  const duration = typeof contentDetails?.duration === 'string' ? contentDetails.duration.trim() : '';
  const channelTitle = typeof snippet?.channelTitle === 'string' ? snippet.channelTitle.trim() : '';
  const validPublishedAt = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(publishedAt)
    && Number.isFinite(Date.parse(publishedAt));
  const validDuration = /^P(?=.+)(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/.test(duration);

  if (!videoId
    || !requestedVideoIds.has(videoId)
    || seenVideoIds.has(videoId)
    || !title
    || typeof description !== 'string'
    || !validPublishedAt
    || !validDuration
    || !channelTitle
    || !statistics) {
    throw new ChannelSourceUnavailableError('invalid_response');
  }
  seenVideoIds.add(videoId);

  return {
    videoId,
    title,
    description: description.substring(0, 500),
    publishedAt,
    viewCount: parseYouTubeCount(statistics.viewCount),
    // YouTube may omit these counters when likes or comments are disabled.
    // Preserve the learner's legacy numeric shape for that valid omission;
    // malformed present values still fail the complete source response closed.
    likeCount: parseYouTubeCount(statistics.likeCount, true),
    commentCount: parseYouTubeCount(statistics.commentCount, true),
    duration,
    channelTitle,
  };
}

/**
 * Resolve a YouTube channel URL/handle to a channel ID and name.
 * Supports: @handle, /channel/UCxxxx, /c/Name, full URL
 */
async function resolveChannel(channelUrl: string, abortSignal?: AbortSignal): Promise<{
  channelId: string;
  channelName: string;
} | null> {
  if (!YT_API_KEY) {
    logger.warn('YOUTUBE_API_KEY not set — cannot resolve channel');
    throw new ChannelSourceUnavailableError('configuration');
  }

  // Extract handle or ID from URL
  let searchQuery = channelUrl;
  const handleMatch = channelUrl.match(/@([\w.-]+)/);
  const channelIdMatch = channelUrl.match(/\/channel\/(UC[\w-]+)/);

  if (channelIdMatch) {
    // Direct channel ID — fetch info
    try {
      const url = `${YT_CHANNELS_URL}?part=snippet&id=${channelIdMatch[1]}&key=${YT_API_KEY}`;
      const res = await fetch(url, { signal: abortSignal });
      const items = await readYouTubeItems(res);
      if (items.length > 0) {
        const first = items[0] as { id?: unknown; snippet?: { title?: unknown } } | null;
        if (!first || typeof first.id !== 'string' || !first.id.trim()) {
          throw new ChannelSourceUnavailableError('invalid_response');
        }
        return {
          channelId: first.id,
          channelName: typeof first.snippet?.title === 'string' && first.snippet.title.trim()
            ? first.snippet.title
            : channelUrl,
        };
      }
    } catch (err) {
      throwIfChannelLearningAborted(abortSignal);
      if (err instanceof ChannelSourceUnavailableError) throw err;
      logger.warn(
        { errorName: safeChannelErrorName(err), ...channelInputDiagnostics(channelUrl) },
        'Failed to resolve channel by ID',
      );
      throw new ChannelSourceUnavailableError('transport');
    }
    return null;
  }

  if (handleMatch) {
    searchQuery = handleMatch[1];
  } else {
    // Try to extract channel name from URL path
    const nameMatch = channelUrl.match(/youtube\.com\/(?:c\/|user\/)?([^/?]+)/);
    if (nameMatch) searchQuery = nameMatch[1];
  }

  // Search for channel by name/handle
  try {
    const params = new URLSearchParams({
      part: 'snippet',
      q: searchQuery,
      type: 'channel',
      maxResults: '1',
      key: YT_API_KEY,
    });
    const res = await fetch(`${YT_SEARCH_URL}?${params}`, { signal: abortSignal });
    const items = await readYouTubeItems(res);

    if (items.length > 0) {
      const first = items[0] as {
        id?: { channelId?: unknown };
        snippet?: { channelId?: unknown; channelTitle?: unknown };
      } | null;
      const channelId = first?.id?.channelId ?? first?.snippet?.channelId;
      if (typeof channelId !== 'string' || !channelId.trim()) {
        throw new ChannelSourceUnavailableError('invalid_response');
      }
      return {
        channelId,
        channelName: typeof first?.snippet?.channelTitle === 'string' && first.snippet.channelTitle.trim()
          ? first.snippet.channelTitle
          : searchQuery,
      };
    }
  } catch (err) {
    throwIfChannelLearningAborted(abortSignal);
    if (err instanceof ChannelSourceUnavailableError) throw err;
    logger.warn(
      { errorName: safeChannelErrorName(err), ...channelInputDiagnostics(searchQuery) },
      'Failed to search for channel',
    );
    throw new ChannelSourceUnavailableError('transport');
  }

  return null;
}

/**
 * Fetch recent videos from a channel with statistics.
 */
async function fetchChannelVideos(
  channelId: string,
  maxVideos = 20,
  abortSignal?: AbortSignal,
): Promise<VideoData[]> {
  if (!YT_API_KEY) throw new ChannelSourceUnavailableError('configuration');

  try {
    // Step 1: Get video IDs
    // Fetch up to 50 recent videos, then pick top performers by views
    const fetchCount = Math.max(maxVideos, 50);
    const searchParams = new URLSearchParams({
      part: 'snippet',
      channelId,
      type: 'video',
      order: 'date',
      maxResults: String(fetchCount),
      key: YT_API_KEY,
    });
    const searchRes = await fetch(`${YT_SEARCH_URL}?${searchParams}`, { signal: abortSignal });
    const searchItems = await readYouTubeItems(searchRes);
    const videoIds = searchItems.map((item) => {
      const videoId = (item as { id?: { videoId?: unknown } } | null)?.id?.videoId;
      if (typeof videoId !== 'string' || !videoId.trim()) {
        throw new ChannelSourceUnavailableError('invalid_response');
      }
      return videoId;
    });

    if (videoIds.length === 0) return [];

    // Step 2: Get video details + statistics (YouTube API allows max 50 per call)
    const statsParams = new URLSearchParams({
      part: 'statistics,contentDetails,snippet',
      id: videoIds.join(','),
      key: YT_API_KEY,
    });
    const statsRes = await fetch(`${YT_VIDEOS_URL}?${statsParams}`, { signal: abortSignal });
    const statsItems = await readYouTubeItems(statsRes);
    const requestedVideoIds = new Set(videoIds);
    const seenVideoIds = new Set<string>();
    const allVideos = statsItems.map((item) => (
      parseYouTubeVideoDetails(item, requestedVideoIds, seenVideoIds)
    ));

    // Return top performers sorted by view count
    return allVideos
      .sort((a: VideoData, b: VideoData) => b.viewCount - a.viewCount)
      .slice(0, maxVideos);
  } catch (err) {
    throwIfChannelLearningAborted(abortSignal);
    if (err instanceof ChannelSourceUnavailableError) throw err;
    logger.error(
      { errorName: safeChannelErrorName(err), ...channelInputDiagnostics(channelId) },
      'Failed to fetch channel videos',
    );
    throw new ChannelSourceUnavailableError('transport');
  }
}

// ─── Claude Analysis ─────────────────────────────────────────────────

// EXTRACTION_SYSTEM_PROMPT loaded from prompts/channel-learner.md via loadPrompt()

interface ExtractionResult {
  channel_summary: string;
  patterns: {
    category: PatternCategory;
    pattern_text: string;
    examples: string[];
    confidence: number;
    source_videos: string[];
  }[];
}

class InvalidChannelExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidChannelExtractionError';
  }
}

function validateChannelExtraction(value: unknown): ExtractionResult {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new InvalidChannelExtractionError('Channel extraction root must be an object');
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.channel_summary !== 'string' || !candidate.channel_summary.trim()) {
    throw new InvalidChannelExtractionError('Channel extraction is missing a non-empty channel_summary');
  }
  if (!Array.isArray(candidate.patterns) || candidate.patterns.length === 0) {
    throw new InvalidChannelExtractionError('Channel extraction is missing actionable patterns');
  }

  const patterns: ExtractionResult['patterns'] = candidate.patterns.map((raw, index) => {
    if (!raw || Array.isArray(raw) || typeof raw !== 'object') {
      throw new InvalidChannelExtractionError(`Channel extraction pattern ${index} is not an object`);
    }
    const pattern = raw as Record<string, unknown>;
    const examples = Array.isArray(pattern.examples)
      ? pattern.examples.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      : [];
    const sourceVideos = Array.isArray(pattern.source_videos)
      ? pattern.source_videos.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      : [];
    if (
      typeof pattern.category !== 'string'
      || !PATTERN_CATEGORIES.includes(pattern.category as PatternCategory)
      || typeof pattern.pattern_text !== 'string'
      || !pattern.pattern_text.trim()
      || examples.length === 0
      || typeof pattern.confidence !== 'number'
      || !Number.isFinite(pattern.confidence)
      || pattern.confidence < 0
      || pattern.confidence > 1
      || sourceVideos.length === 0
    ) {
      throw new InvalidChannelExtractionError(`Channel extraction pattern ${index} is incomplete or non-actionable`);
    }
    return {
      category: pattern.category as PatternCategory,
      pattern_text: pattern.pattern_text.trim(),
      examples,
      confidence: pattern.confidence,
      source_videos: sourceVideos,
    };
  });
  const actionableCategories = new Set(
    patterns
      .filter((pattern) => pattern.confidence > 0.2)
      .map((pattern) => pattern.category),
  );
  const missingCategories = PATTERN_CATEGORIES.filter(
    (category) => !actionableCategories.has(category),
  );
  if (missingCategories.length > 0) {
    throw new InvalidChannelExtractionError(
      `Channel extraction is missing actionable coverage for: ${missingCategories.join(', ')}`,
    );
  }
  return {
    channel_summary: candidate.channel_summary.trim(),
    patterns,
  };
}

/**
 * Send video data to Claude for pattern extraction.
 */
export function buildChannelLearnerExtractionPrompt(
  channelName: string,
  videos: VideoData[],
  creatorProfile?: Partial<ContentCreatorProfile> | null,
  transcriptData?: string,
): string {
  return buildChannelLearnerExtractionPromptFromContext(
    channelName,
    videos,
    buildCreatorPromptContext(creatorProfile),
    transcriptData,
  );
}

function buildChannelLearnerExtractionPromptFromContext(
  channelName: string,
  videos: VideoData[],
  creator: CreatorPromptContext,
  transcriptData?: string,
): string {
  // Preserve all ten-video coverage while bounding descriptive prose. Titles,
  // engagement, duration, and a concise description remain available for
  // every item; transcript compaction below keeps both opening and trailing
  // examples instead of dropping whole required categories.
  const videoSummary = compactBalancedText(videos.map((v, i) => {
    const views = v.viewCount > 1000 ? `${(v.viewCount / 1000).toFixed(1)}K` : v.viewCount;
    const likes = v.likeCount > 1000 ? `${(v.likeCount / 1000).toFixed(1)}K` : v.likeCount;
    return `${i + 1}. ${sanitizeForPromptInterpolation(v.title)}
   Views: ${views} | Likes: ${likes} | Comments: ${v.commentCount} | Duration: ${v.duration}
   Desc: ${sanitizeForPromptInterpolation(v.description.substring(0, 120))}${v.description.length > 120 ? '...' : ''}`;
  }).join('\n\n'), 3_000);
  const creatorBlock = compactBalancedText(creator.block, 1_200);

  let prompt = `Analyze the YouTube channel ${sanitizeForPromptInterpolation(channelName)} based on their ${videos.length} most recent videos.

AUTHENTICATED CREATOR CONTEXT:
${creatorBlock}

VIDEOS:
${videoSummary}`;

  // Enrich with transcript data from top videos
  if (transcriptData) {
    prompt += `

TRANSCRIPTS FROM TOP-PERFORMING VIDEOS:
(Use these to extract EXACT hook phrases, transition words, storytelling beats, and pacing patterns — not just title-level patterns)
${compactBalancedText(sanitizeForPromptInterpolation(transcriptData), 2_200)}`;
  }

  prompt += `

Extract content creation patterns across all 9 categories. Focus on what makes this creator successful — patterns that can be adapted (not copied) for the authenticated creator's language, audience, pillars, and niches above.`;

  return compactBalancedText(prompt, CHANNEL_EXTRACTION_USER_PROMPT_MAX_CHARS);
}

export function buildChannelLearnerSynthesisPrompt(
  creatorProfile?: Partial<ContentCreatorProfile> | null,
): string {
  return buildChannelLearnerSynthesisPromptFromContext(buildCreatorPromptContext(creatorProfile));
}

function buildChannelLearnerSynthesisPromptFromContext(creator: CreatorPromptContext): string {
  return compactBalancedText(`You are a content strategy synthesizer. You receive patterns extracted from multiple successful YouTube creators. Your job: merge them into a unified, actionable knowledge base.

AUTHENTICATED CREATOR CONTEXT:
${compactBalancedText(creator.block, 1_200)}

Rules:
- Combine similar patterns into a single, richer description
- Prioritize patterns that appear across MULTIPLE creators (cross-validated)
- Keep concrete examples from each creator (attribute them)
- Remove contradictions — if creators disagree, note both approaches
- Write as actionable advice for the authenticated creator's language, audience, pillars, and niches
- Be concise: each category should be 3-6 sentences max + examples
- Output language: English for internal knowledge storage unless the creator context explicitly requires localized wording

Return ONLY valid JSON:
{
  "categories": [
    {
      "category": "hook_style",
      "synthesized_text": "Merged insight with examples...",
      "source_channels": ["Channel A", "Channel B"]
    }
  ]
}`, CHANNEL_SYNTHESIS_SYSTEM_PROMPT_MAX_CHARS);
}

async function extractPatterns(
  channelName: string,
  videos: VideoData[],
  transcriptData?: string,
  creatorProfile?: Partial<ContentCreatorProfile> | null,
  meteringScope: AIMeteringScope = {},
): Promise<ExtractionResult> {
  return extractPatternsForCreatorContext(
    channelName,
    videos,
    transcriptData,
    buildCreatorPromptContext(creatorProfile),
    meteringScope,
  );
}

async function extractPatternsForCreatorContext(
  channelName: string,
  videos: VideoData[],
  transcriptData: string | undefined,
  creator: CreatorPromptContext,
  meteringScope: AIMeteringScope = {},
  budgetContext: ChannelAiBudgetContext = { requestSource: 'interactive' },
): Promise<ExtractionResult> {
  const prompt = buildChannelLearnerExtractionPromptFromContext(channelName, videos, creator, transcriptData);
  const extractionSystemPrompt = compactBalancedText(
    loadPrompt('channel-learner'),
    CHANNEL_EXTRACTION_SYSTEM_PROMPT_MAX_CHARS,
  );

  // Gemini-first: gemini-2.5-flash matches Sonnet for analytical pattern
  // extraction at ~9× lower cost. Provider selection may fall through only
  // before dispatch; a dispatched failure is terminal without a replay ID.
  const { text: rawAnalysisText } = await withAiBudgetReservation({
    userId: meteringScope.userId ?? 0,
    requestSource: budgetContext.requestSource,
    baseCategory: CHANNEL_LEARNING_BASE_CATEGORY,
    jobName: channelStageJobName(budgetContext.jobName, 'extract'),
    runId: budgetContext.runId ?? null,
    estimatedCostUsd: budgetContext.estimatedCostUsd,
    automationPriority: 'channel_learning',
  }, () => completeOneShotWithFallback(
    extractionSystemPrompt,
    prompt,
    'channel_analysis',
    async () => {
      const response = await trackedCreate(client, {
        model: config.anthropic.model, // Sonnet for quality analysis
        max_tokens: CHANNEL_LEARNING_MAX_OUTPUT_TOKENS,
        system: extractionSystemPrompt,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3, // Lower temp for more consistent analysis
      }, 'channel_analysis', {
        ...meteringScope,
        abortSignal: budgetContext.abortSignal,
      });
      return response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
    },
    {
      model: CHANNEL_LEARNING_MODEL,
      maxTokens: CHANNEL_LEARNING_MAX_OUTPUT_TOKENS,
      temperature: 0.3,
      maxRetries: 0,
      ...meteringScope,
      abortSignal: budgetContext.abortSignal,
      allowFallbackAfterProviderFailure: false,
    },
  ));

  let text = rawAnalysisText;

  // Extract JSON from potential markdown fences or surrounding text
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  } else {
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd > jsonStart) {
      text = text.slice(jsonStart, jsonEnd + 1);
    }
  }

  try {
    return validateChannelExtraction(JSON.parse(text));
  } catch (err) {
    logger.warn(
      { errorName: safeChannelErrorName(err), textLength: text.length },
      'Channel extraction failed validation; retaining prior patterns and success fingerprint',
    );
    if (err instanceof InvalidChannelExtractionError) throw err;
    throw new InvalidChannelExtractionError('Channel extraction returned invalid JSON');
  }
}

// ─── Synthesis (merge patterns across all channels) ──────────────────

async function synthesizeKnowledge(
  userId?: number,
  budgetContext: ChannelAiBudgetContext = {
    requestSource: userId != null && userId > 0 ? 'interactive' : 'system',
  },
): Promise<boolean> {
  throwIfChannelLearningAborted(budgetContext.abortSignal);
  const scopedUserId = userId != null && userId > 0 ? userId : 0;
  let knowledgeChanged = false;
  const creatorContext = scopedUserId > 0 ? loadCreatorPromptContextForUser(scopedUserId, scopedUserId) : buildCreatorPromptContext(null);
  const synthesisSystemPrompt = buildChannelLearnerSynthesisPromptFromContext(creatorContext);
  const platformChannels = getScopedChannelsForProcessing('active', undefined);
  const userChannels = scopedUserId > 0 ? getActiveChannels(scopedUserId) : [];
  const channelsById = new Map<number, ContentRefChannel>();
  for (const channel of scopedUserId > 0 ? [...platformChannels, ...userChannels] : platformChannels) {
    channelsById.set(channel.id, channel);
  }
  const channels = Array.from(channelsById.values());
  if (channels.length === 0) {
    logger.info({ userId: userId ?? null }, 'No active channels to synthesize knowledge from');
    return false;
  }

  logger.info({ channelCount: channels.length, userId: userId ?? null }, 'Synthesizing cross-channel knowledge');

  type SynthesisInput = {
    category: PatternCategory;
    byChannel: Map<string, ReturnType<typeof getPatternsForChannel>>;
    context: string;
  };
  const synthesisInputs: SynthesisInput[] = [];
  const directKnowledge: Array<{
    category: PatternCategory;
    text: string;
    sourceChannels: string[];
  }> = [];

  const persistKnowledge = (
    category: PatternCategory,
    text: string,
    sourceChannels: string[],
  ): void => {
    if (scopedUserId > 0) {
      upsertKnowledge(category, text, sourceChannels, scopedUserId);
    } else {
      upsertSystemKnowledge(category, text, sourceChannels, CONTENT_LEARNER_ADMIN_CONTEXT);
    }
  };

  for (const category of PATTERN_CATEGORIES) {
    // Group by channel
    const byChannel = new Map<string, ReturnType<typeof getPatternsForChannel>>();
    for (const channel of channels) {
      const patterns = getPatternsForChannel(channel.id, accessForChannel(channel))
        .filter((pattern) => pattern.category === category && pattern.confidence >= 0.5);
      if (patterns.length === 0) continue;
      const name = channel.channel_name || channel.channel_url;
      byChannel.set(name, patterns);
    }
    if (byChannel.size === 0) continue;

    // Build context for Claude
    const context = compactBalancedText([...byChannel.entries()].map(([name, pats]) => {
      return `From ${sanitizeForPromptInterpolation(name)}:\n${pats.map((p) => {
        const examples = JSON.parse(p.examples) as string[];
        return `  - ${sanitizeForPromptInterpolation(p.pattern_text)} (confidence: ${p.confidence})\n    Examples: ${examples.map((example) => sanitizeForPromptInterpolation(example)).join('; ')}`;
      }).join('\n')}`;
    }).join('\n\n'), 500);

    // If only one channel contributes to this category, skip synthesis — use directly
    if (byChannel.size === 1) {
      const [channelName, pats] = [...byChannel.entries()][0];
      const highConf = pats.filter((p) => p.confidence >= 0.5);
      if (highConf.length === 0) continue;

      const directText = highConf.map((p) => {
        const examples = JSON.parse(p.examples) as string[];
        return `${p.pattern_text}\nExamples from ${channelName}: ${examples.slice(0, 3).join('; ')}`;
      }).join('\n');

      directKnowledge.push({ category, text: directText, sourceChannels: [channelName] });
      continue;
    }

    synthesisInputs.push({ category, byChannel, context });
  }

  // One structured synthesis request per changed scope. The former
  // per-category loop repeated the system prompt up to nine times and was the
  // channel learner's highest-frequency cost line. Local synthesis remains
  // deliberately disabled until it demonstrates full category and actionable
  // pattern parity with this cloud path.
  if (synthesisInputs.length > 0) {
    const categoryBlocks = synthesisInputs.map((input) => (
      `CATEGORY ${input.category} (${input.byChannel.size} creators):\n${input.context}`
    )).join('\n\n---\n\n');
    const userPrompt = `Synthesize every category below in one response. Return exactly one entry for each requested category (${synthesisInputs.map((input) => input.category).join(', ')}).\n\n${categoryBlocks}`;
    if (userPrompt.length > CHANNEL_SYNTHESIS_USER_PROMPT_MAX_CHARS) {
      recordChannelSynthesisContractDeferral(scopedUserId, budgetContext);
      logger.warn(
        {
          userId: scopedUserId,
          promptChars: userPrompt.length,
          runId: budgetContext.runId ?? null,
        },
        'Channel synthesis retained prior knowledge because the complete category batch exceeded its validated budget-safe contract',
      );
      return false;
    }

    try {
      const { text: cloudText } = await withAiBudgetReservation({
        userId: scopedUserId,
        requestSource: budgetContext.requestSource,
        baseCategory: CHANNEL_LEARNING_BASE_CATEGORY,
        jobName: channelStageJobName(budgetContext.jobName, 'synthesize'),
        runId: budgetContext.runId ?? null,
        estimatedCostUsd: budgetContext.estimatedCostUsd,
        automationPriority: 'channel_learning',
      }, () => completeOneShotWithFallback(
        synthesisSystemPrompt,
        userPrompt,
        'knowledge_synthesis',
        async () => {
          const response = await trackedCreate(client, {
            model: config.anthropic.classifierModel,
            max_tokens: CHANNEL_LEARNING_MAX_OUTPUT_TOKENS,
            system: synthesisSystemPrompt,
            messages: [{ role: 'user', content: userPrompt }],
            temperature: 0.3,
          }, 'knowledge_synthesis', {
            userId: scopedUserId,
            tenantId: scopedUserId,
            abortSignal: budgetContext.abortSignal,
          });
          return response.content
            .filter((block): block is Anthropic.TextBlock => block.type === 'text')
            .map((block) => block.text)
            .join('');
        },
        {
          model: CHANNEL_LEARNING_MODEL,
          maxTokens: CHANNEL_LEARNING_MAX_OUTPUT_TOKENS,
          temperature: 0.3,
          maxRetries: 0,
          userId: scopedUserId,
          tenantId: scopedUserId,
          abortSignal: budgetContext.abortSignal,
          allowFallbackAfterProviderFailure: false,
        },
      ));

      const fenceMatch = cloudText.match(/```(?:json)?\s*([\s\S]*?)```/i);
      const jsonText = fenceMatch?.[1]?.trim()
        ?? cloudText.slice(cloudText.indexOf('{'), cloudText.lastIndexOf('}') + 1);
      const parsed = JSON.parse(jsonText) as {
        categories?: Array<{ category?: unknown; synthesized_text?: unknown; source_channels?: unknown }>;
      };
      if (!Array.isArray(parsed.categories)) throw new Error('Synthesis response is missing categories array');

      const validated = synthesisInputs.map((input) => {
        const matching = parsed.categories!.filter((candidate) => candidate.category === input.category);
        const result = matching[0];
        const sourceChannels = Array.isArray(result?.source_channels)
          ? result.source_channels.filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
          : [];
        if (
          matching.length !== 1
          || typeof result?.synthesized_text !== 'string'
          || !result.synthesized_text.trim()
          || sourceChannels.length < 2
        ) {
          throw new Error(`Invalid or incomplete category ${input.category}`);
        }
        return {
          category: input.category,
          text: result.synthesized_text.trim(),
          sourceChannels,
        };
      });
      const unexpectedCategories = parsed.categories.filter(
        (candidate) => !synthesisInputs.some((input) => input.category === candidate.category),
      );
      if (unexpectedCategories.length > 0 || parsed.categories.length !== synthesisInputs.length) {
        throw new Error('Synthesis response category set does not match the requested set');
      }
      throwIfChannelLearningAborted(budgetContext.abortSignal);

      // Validate the complete category set before opening the transaction,
      // then persist it atomically so a SQLite failure cannot leave a scope
      // with a half-old/half-new knowledge set.
      getDb().transaction(() => {
        throwIfChannelLearningAborted(budgetContext.abortSignal);
        for (const result of directKnowledge) {
          persistKnowledge(result.category, result.text, result.sourceChannels);
        }
        for (const result of validated) {
          persistKnowledge(result.category, result.text, result.sourceChannels);
        }
      })();
      knowledgeChanged = true;
    } catch (err) {
      throwIfChannelLearningAborted(budgetContext.abortSignal);
      // An unmetered provider response is a process-wide fail-closed event for
      // every request source. Do not turn it into an ordinary synthesis skip.
      if (
        err instanceof ApiUsagePersistenceError
        || (err as { name?: string })?.name === 'ApiUsagePersistenceError'
      ) {
        throw err;
      }
      if (budgetContext.requestSource === 'interactive' && err instanceof AiBudgetError) {
        throw err;
      }
      logger.warn(
        { errorName: safeChannelErrorName(err), categoryCount: synthesisInputs.length },
        'Batched channel synthesis deferred — retaining latest valid knowledge for every category',
      );
      return false;
    }
  } else if (directKnowledge.length > 0) {
    try {
      throwIfChannelLearningAborted(budgetContext.abortSignal);
      getDb().transaction(() => {
        throwIfChannelLearningAborted(budgetContext.abortSignal);
        for (const result of directKnowledge) {
          persistKnowledge(result.category, result.text, result.sourceChannels);
        }
      })();
      knowledgeChanged = true;
    } catch (err) {
      throwIfChannelLearningAborted(budgetContext.abortSignal);
      logger.warn(
        { errorName: safeChannelErrorName(err), categoryCount: directKnowledge.length },
        'Direct channel knowledge persistence deferred — retaining latest valid category set',
      );
      return false;
    }
  }

  throwIfChannelLearningAborted(budgetContext.abortSignal);
  if (knowledgeChanged) {
    invalidateChannelLearnerContentCaches(scopedUserId);
  }

  logger.info({ userId: userId ?? null }, 'Knowledge synthesis complete');
  pushEvent({
    ts: new Date().toISOString(),
    type: 'job',
    summary: `Content knowledge synthesized from ${channels.length} channel(s)${userId != null && userId > 0 ? ` for user ${userId}` : ' (system scope)'}`,
  });

  // Keep channel_dna as a system-level content mesh signal for now.
  // User-specific knowledge is already persisted explicitly in content_knowledge,
  // but broader signal isolation still belongs to the later tenant hardening wave.
  if (scopedUserId === 0) {
    writeChannelDNASignals(channels);
  }
  return true;
}

/**
 * Writes one signal per channel per pattern category to the intelligence bus.
 * Other agents (Script, Hooks, SEO, Performance) can read these independently.
 */
function writeChannelDNASignals(channels: ContentRefChannel[]): void {
  let signalCount = 0;

  for (const channel of channels) {
    for (const category of PATTERN_CATEGORIES) {
      const patterns = getPatternsForChannel(channel.id, accessForChannel(channel))
        .filter((p) => p.category === category && p.confidence >= 0.4);

      if (patterns.length === 0) continue;

      const examples: string[] = [];
      const patternNames: string[] = [];

      for (const p of patterns) {
        patternNames.push(p.pattern_text.slice(0, 80));
        try {
          const ex = JSON.parse(p.examples) as string[];
          examples.push(...ex.slice(0, 2));
        } catch { /* skip bad JSON */ }
      }

      try {
        const signalId = writeGovernedSignal({
          source_agent: 'channel-learner',
          signal_type: 'channel_dna',
          provenance: {
            producerVersion: CHANNEL_LEARNER_SIGNAL_PRODUCER_VERSION,
            source: 'runtime',
            observedAt: new Date().toISOString(),
          },
          payload: {
            channel_name: channel.channel_name || channel.channel_url,
            channel_id: channel.channel_id,
            category,
            patterns: patternNames,
            examples: examples.slice(0, 6),
            effectiveness_score: null, // filled by Performance Agent later
            extracted_at: new Date().toISOString(),
          },
        });
        if (signalId > 0) {
          signalCount++;
        } else {
          logger.warn({ channelId: channel.id }, 'Governed channel DNA signal write rejected');
        }
      } catch (err) {
        logger.warn(
          { errorName: safeChannelErrorName(err), channelId: channel.id },
          'Failed to write channel DNA signal',
        );
      }
    }
  }

  logger.info({ signalCount, channelCount: channels.length }, 'Channel DNA signals written to intelligence bus');
}

// ─── Main Analysis Pipeline ──────────────────────────────────────────

/**
 * Analyze a single channel: fetch videos → extract patterns → store.
 * Returns a human-readable summary.
 *
 * When `options.skipIfUnchanged` is set (the scheduled re-learn path), the
 * freshly fetched video list is fingerprinted and compared against the
 * fingerprint persisted by the last successful analysis. If nothing new was
 * published, extraction + synthesis are skipped (`skipped: true`), the
 * channel is re-marked active (bumping last_analyzed_at / last_checked_at so
 * the skip is observable), and the consecutive failure count is reset.
 * A NULL stored fingerprint always analyzes (backward compatible).
 */
export async function analyzeChannel(
  channelId: number,
  options: { skipIfUnchanged?: boolean; budgetContext?: ChannelAiBudgetContext } = {},
): Promise<{
  success: boolean;
  summary: string;
  patternsFound: number;
  videosAnalyzed: number;
  skipped?: boolean;
  deferred?: boolean;
  error?: string;
}> {
  const { getChannel } = await import('../state/content-references');
  const channel = getChannel(channelId, { adminContext: CONTENT_LEARNER_ADMIN_CONTEXT }) as
    | (ContentRefChannel & ChannelLearnerCostControlColumns)
    | undefined;
  if (!channel) {
    return { success: false, summary: '', patternsFound: 0, videosAnalyzed: 0, error: 'Channel not found' };
  }
  const channelAccess = accessForChannel(channel);
  const channelMeteringScope = {
    userId: channel.user_id && channel.user_id > 0 ? channel.user_id : 0,
    tenantId: channel.tenant_id ?? channel.user_id ?? 0,
  };
  const budgetContext = options.budgetContext ?? {
    requestSource: channel.user_id && channel.user_id > 0 ? 'interactive' as const : 'system' as const,
    jobName: 'channel_analysis',
  };
  throwIfChannelLearningAborted(budgetContext.abortSignal);

  if (budgetContext.requestSource === 'automation' && channelMeteringScope.userId > 0) {
    const eligibility = resolveAiAutomationEligibility(channelMeteringScope.userId, 'content');
    if (!eligibility.allowed) {
      recordAiAutomationEligibilitySkip(channelMeteringScope.userId, eligibility, {
        jobName: budgetContext.jobName ?? 'channel_relearn',
        baseCategory: CHANNEL_LEARNING_BASE_CATEGORY,
        runId: budgetContext.runId ?? null,
      });
      logger.debug(
        { channelId, userId: channelMeteringScope.userId, reason: eligibility.reason },
        'Channel analysis skipped before YouTube/provider work: automation is not eligible',
      );
      return {
        success: false,
        deferred: true,
        summary: '',
        patternsFound: 0,
        videosAnalyzed: 0,
        error: eligibility.reason,
      };
    }
  }
  const creatorProfile = channel.user_id && channel.user_id > 0
    ? loadCreatorPromptContextForUser(channel.user_id, channel.tenant_id ?? channel.user_id)
    : buildCreatorPromptContext(null);

  logger.info(
    { channelId, ...channelInputDiagnostics(channel.channel_url) },
    'Starting channel analysis',
  );
  updateChannelStatus(channelId, 'analyzing', undefined, channelAccess);

  try {
    // Cheap no-op reservation preflight prevents YouTube quota/transcript work
    // when the canonical plan, daily, monthly, automation, system, or global
    // allowance already denies the eventual model call. The provider boundary
    // repeats the locked check after external reads to close the race.
    await withAiBudgetReservation({
      userId: channelMeteringScope.userId,
      requestSource: budgetContext.requestSource,
      baseCategory: CHANNEL_LEARNING_BASE_CATEGORY,
      jobName: channelStageJobName(budgetContext.jobName, 'extract'),
      runId: budgetContext.runId ?? null,
      estimatedCostUsd: budgetContext.estimatedCostUsd,
      automationPriority: 'channel_learning',
    }, async () => undefined);
    throwIfChannelLearningAborted(budgetContext.abortSignal);

    // Step 1: Resolve channel
    const resolved = await resolveChannel(channel.channel_url, budgetContext.abortSignal);
    throwIfChannelLearningAborted(budgetContext.abortSignal);
    if (!resolved) {
      updateChannelStatus(channelId, 'failed', {
        error_message: 'CHANNEL_SOURCE_NOT_FOUND',
      }, channelAccess);
      recordChannelAnalysisFailure(channelId);
      return {
        success: false,
        summary: '',
        patternsFound: 0,
        videosAnalyzed: 0,
        error: 'CHANNEL_SOURCE_NOT_FOUND',
      };
    }

    updateChannelStatus(channelId, 'analyzing', {
      channel_name: resolved.channelName,
      channel_id: resolved.channelId,
    }, channelAccess);

    // Step 2: Fetch recent videos
    const videos = await fetchChannelVideos(resolved.channelId, 10, budgetContext.abortSignal);
    throwIfChannelLearningAborted(budgetContext.abortSignal);
    if (videos.length === 0) {
      updateChannelStatus(channelId, 'failed', {
        error_message: 'CHANNEL_SOURCE_NO_RESULTS',
      }, channelAccess);
      recordChannelAnalysisFailure(channelId);
      return {
        success: false,
        summary: '',
        patternsFound: 0,
        videosAnalyzed: 0,
        error: 'CHANNEL_SOURCE_NO_RESULTS',
      };
    }

    // Step 2.25: New-video gate. If the fetched video set fingerprints
    // identically to the last successful analysis, there is nothing new to
    // learn — skip the expensive extraction/synthesis LLM pipeline. The
    // channel is re-marked active (bumps last_analyzed_at + updated_at via
    // updateChannelStatus) and last_checked_at records the verification.
    const fingerprint = computeChannelAnalysisFingerprint(videos);
    if (options.skipIfUnchanged && channel.analysis_fingerprint && channel.analysis_fingerprint === fingerprint) {
      throwIfChannelLearningAborted(budgetContext.abortSignal);
      updateChannelStatus(channelId, 'active', { error_message: null }, channelAccess);
      recordChannelAnalysisSuccess(channelId, fingerprint);
      logger.info(
        { channelId, videoCount: videos.length },
        'Channel re-learn skipped — no new videos since last successful analysis',
      );
      return {
        success: true,
        skipped: true,
        summary: 'No new videos since last analysis — extraction and synthesis skipped',
        patternsFound: 0,
        videosAnalyzed: 0,
      };
    }

    logger.info({ channelId, videoCount: videos.length }, 'Videos fetched, extracting patterns');

    // Step 2.5: Fetch transcripts for top 5 videos (enriches pattern extraction)
    let transcriptData: string | undefined;
    try {
      const topVids = videos.map((v) => ({
        videoId: v.videoId,
        title: v.title,
        viewCount: v.viewCount,
      }));
      const deep = await deepAnalyzeTopVideos(
        resolved.channelName,
        topVids,
        5,
        channel.user_id && channel.user_id > 0 ? channel.user_id : 0,
        channel.tenant_id ?? channel.user_id ?? 0,
        budgetContext.abortSignal,
      );
      if (deep.transcriptCount > 0) {
        transcriptData = deep.deepPatterns;
        logger.info({
          channelId,
          transcriptCount: deep.transcriptCount,
        }, 'Transcript data fetched for top videos');
      }
    } catch (err) {
      throwIfChannelLearningAborted(budgetContext.abortSignal);
      logger.warn(
        { errorName: safeChannelErrorName(err), channelId },
        'Transcript enrichment failed (non-critical, continuing with metadata only)',
      );
    }

    // Step 3: Extract patterns via Claude (now with optional transcript data)
    const extraction = await extractPatternsForCreatorContext(
      resolved.channelName,
      videos,
      transcriptData,
      creatorProfile,
      channelMeteringScope,
      budgetContext,
    );
    throwIfChannelLearningAborted(budgetContext.abortSignal);

    // Step 4: Store patterns
    const validPatterns = extraction.patterns.filter(
      (p) => PATTERN_CATEGORIES.includes(p.category) && p.confidence > 0.2,
    );

    if (validPatterns.length > 0) {
      throwIfChannelLearningAborted(budgetContext.abortSignal);
      upsertPatterns(channelId, validPatterns, channelAccess);
    }

    // Step 5: Mark as active + persist the fingerprint of the analyzed
    // video set (drives the new-video gate on the next re-learn cycle).
    throwIfChannelLearningAborted(budgetContext.abortSignal);
    updateChannelStatus(channelId, 'active', {
      video_count_analyzed: videos.length,
      error_message: null,
    }, channelAccess);
    recordChannelAnalysisSuccess(channelId, fingerprint);

    logger.info({
      channelId,
      patternsFound: validPatterns.length,
      videosAnalyzed: videos.length,
    }, 'Channel analysis complete');

    pushEvent({
      ts: new Date().toISOString(),
      type: 'job',
      summary: `Channel ${channelId} analyzed: ${validPatterns.length} patterns from ${videos.length} videos`,
    });

    return {
      success: true,
      summary: extraction.channel_summary,
      patternsFound: validPatterns.length,
      videosAnalyzed: videos.length,
    };
  } catch (err) {
    if (budgetContext.abortSignal?.aborted) {
      const restoreStatus: ContentRefChannel['status'] = channel.analysis_fingerprint ? 'active' : 'pending';
      updateChannelStatus(channelId, restoreStatus, { error_message: 'Channel analysis cancelled' }, channelAccess);
      throwIfChannelLearningAborted(budgetContext.abortSignal);
    }
    if (err instanceof AiBudgetError) {
      const restoreStatus: ContentRefChannel['status'] = channel.analysis_fingerprint ? 'active' : 'pending';
      updateChannelStatus(channelId, restoreStatus, {
        error_message: `AI budget deferred (${err.decision.code})`,
      }, channelAccess);
      if (budgetContext.requestSource === 'interactive') throw err;
      logger.info(
        { channelId, code: err.decision.code, window: err.decision.window },
        'Channel analysis deferred by AI budget without entering failure backoff',
      );
      return {
        success: false,
        deferred: true,
        summary: '',
        patternsFound: 0,
        videosAnalyzed: 0,
        error: err.decision.code,
      };
    }
    if (
      err instanceof ApiUsagePersistenceError
      || (err as { name?: string })?.name === 'ApiUsagePersistenceError'
    ) {
      const restoreStatus: ContentRefChannel['status'] = channel.analysis_fingerprint ? 'active' : 'pending';
      updateChannelStatus(channelId, restoreStatus, {
        error_message: 'AI usage persistence degraded',
      }, channelAccess);
      throw err;
    }
    if (err instanceof ChannelSourceUnavailableError) {
      updateChannelStatus(
        channelId,
        channel.status === 'active' ? 'active' : 'failed',
        { error_message: err.code, preserve_last_analyzed_at: true },
        channelAccess,
      );
      logger.warn(
        { channelId, reason: err.reason, source: err.source },
        'Channel source unavailable; analysis withheld',
      );
      throw err;
    }
    const failureCode = err instanceof InvalidChannelExtractionError
      ? 'CHANNEL_EXTRACTION_OUTPUT_INVALID'
      : 'CHANNEL_ANALYSIS_FAILED';
    logger.error({ errorName: safeChannelErrorName(err), channelId, failureCode }, 'Channel analysis failed');
    updateChannelStatus(channelId, 'failed', { error_message: failureCode }, channelAccess);
    recordChannelAnalysisFailure(channelId);
    return {
      success: false,
      summary: '',
      patternsFound: 0,
      videosAnalyzed: 0,
      error: failureCode,
    };
  } finally {
    // Every path reaching the provider pipeline first transitions this row to
    // `analyzing`; clear the exact creator cache (or all caches for shared
    // system channels) after its terminal status/pattern mutation settles.
    invalidateChannelLearnerContentCaches(channel.user_id ?? undefined);
  }
}

/**
 * Process all pending channels and re-analyze stale active channels.
 * Called by the scheduler weekly.
 *
 * Result fields (additive, migration 222 cost controls):
 * - skipped_no_new_videos: channels whose fetched video list fingerprinted
 *   identically to the last successful analysis, so extraction + synthesis
 *   were skipped for them.
 * - synthesis_skipped_all_unchanged: true when every channel processed in
 *   this scope was skipped by the new-video gate (nothing failed, nothing
 *   analyzed) so the scope's synthesis LLM calls were skipped entirely.
 */
export interface ChannelRelearnResult {
  analyzed: number;
  failed: number;
  skipped_no_new_videos: number;
  synthesized: boolean;
  synthesis_skipped_all_unchanged: boolean;
  synthesis_deferred: boolean;
}

export async function processAllChannels(
  force = false,
  userId?: number,
  options: {
    requestSource?: 'interactive' | 'automation' | 'system';
    jobName?: string;
    runId?: string | null;
    abortSignal?: AbortSignal;
  } = {},
): Promise<ChannelRelearnResult> {
  throwIfChannelLearningAborted(options.abortSignal);
  let analyzed = 0;
  let failed = 0;
  let skippedNoNewVideos = 0;
  const { clause: scopeClause, params: scopeParams } = getScopeClause(userId);
  const requestSource = options.requestSource
    ?? (userId != null && userId > 0 ? 'automation' : 'system');
  const jobName = options.jobName ?? (requestSource === 'interactive' ? 'channel_relearn_manual' : 'channel_relearn');
  // One scope/cycle is one workload run. Extraction and synthesis keep their
  // provider categories, but share this run id and channel_learning base so
  // rolling p95 represents the complete cycle instead of isolated stages.
  const scopeRunId = options.runId ?? randomUUID();

  // ── Recovery: resurrect stuck / failed channels ────────────────
  //
  // Bug fix (April 10 2026): getPendingChannels() only returns
  // status='pending', getActiveChannels() only returns status='active'.
  // Two absorbing states caused channels to go permanently dead:
  //
  //   1. 'analyzing' — if the Node process crashed mid-analysis (OOM,
  //      PM2 restart, uncaught exception), the channel stays in
  //      'analyzing' forever. No query picks it up.
  //
  //   2. 'failed' — the catch block in analyzeChannel correctly
  //      transitions to 'failed', but the next cron run skips it
  //      because neither query matches 'failed'.
  //
  // Fix: at the top of every processAllChannels() call, reset both
  // absorbing states back to 'pending' so they're retried this cycle.
  // Conditions are deliberately generous:
  //
  //   - 'analyzing' for >30 minutes → definitely stuck (normal
  //     analysis completes in 30-120 seconds per channel)
  //   - 'failed' for >12 hours → eligible for auto-retry (once per
  //     cron cycle, so at most once per Sunday)
  try {
    const db = getDb();
    const stuckAnalyzing = db.prepare(`
      SELECT id, channel_name FROM content_ref_channels
      WHERE status = 'analyzing'
        AND ${scopeClause}
        AND updated_at < datetime('now', '-30 minutes')
    `).all(...scopeParams) as Array<{ id: number; channel_name: string | null }>;

    for (const ch of stuckAnalyzing) {
      updateChannelStatus(ch.id, 'pending', {
        error_message: 'Auto-recovered from stuck analyzing state (process crash or timeout)',
      }, accessForUserId(userId));
      logger.warn(
        { channelId: ch.id },
        'Channel was stuck in analyzing — reset to pending for retry',
      );
    }

    // Failure backoff (migration 222): channels below the consecutive
    // failure threshold keep the original 12h auto-retry; channels at/over
    // it are backed off to at most one retry per 7 days. updated_at is
    // bumped on every failure, so the window restarts from the latest one.
    const failedRetryable = db.prepare(`
      SELECT id, channel_name, COALESCE(consecutive_failure_count, 0) AS consecutive_failure_count
      FROM content_ref_channels
      WHERE status = 'failed'
        AND ${scopeClause}
        AND (
          (COALESCE(consecutive_failure_count, 0) < ${CHANNEL_FAILURE_BACKOFF_THRESHOLD}
            AND updated_at < datetime('now', '-12 hours'))
          OR (COALESCE(consecutive_failure_count, 0) >= ${CHANNEL_FAILURE_BACKOFF_THRESHOLD}
            AND updated_at < datetime('now', '-7 days'))
        )
    `).all(...scopeParams) as Array<{ id: number; channel_name: string | null; consecutive_failure_count: number }>;

    for (const ch of failedRetryable) {
      updateChannelStatus(ch.id, 'pending', { error_message: null }, accessForUserId(userId));
      logger.info(
        {
          channelId: ch.id,
          consecutiveFailures: ch.consecutive_failure_count,
          inBackoff: ch.consecutive_failure_count >= CHANNEL_FAILURE_BACKOFF_THRESHOLD,
        },
        'Previously failed channel reset to pending for auto-retry',
      );
    }

    if (stuckAnalyzing.length > 0 || failedRetryable.length > 0) {
      logger.info(
        { stuckRecovered: stuckAnalyzing.length, failedRetried: failedRetryable.length },
        'Channel recovery complete — retrying recovered channels in this run',
      );
    }
  } catch (err) {
    // Recovery is best-effort — if it fails, proceed with whatever
    // pending/active channels we can still find.
    logger.error(
      { errorName: safeChannelErrorName(err) },
      'Channel recovery query failed (non-critical, continuing)',
    );
  }

  // Process pending channels first (now includes any just-recovered ones).
  // The new-video gate applies here too: recovered failed channels keep the
  // fingerprint of their last SUCCESSFUL analysis, so an unchanged channel
  // that repeatedly fails during re-extraction settles back to active
  // instead of burning LLM calls. Brand-new channels have a NULL fingerprint
  // and always analyze. `force` bypasses the gate.
  const pending = getScopedChannelsForProcessing('pending', userId);
  for (const ch of pending) {
    const result = await analyzeChannel(ch.id, {
      skipIfUnchanged: !force,
      budgetContext: {
        requestSource: ch.user_id && ch.user_id > 0 ? requestSource : 'system',
        jobName,
        runId: scopeRunId,
        abortSignal: options.abortSignal,
      },
    });
    if (result.skipped) skippedNoNewVideos++;
    else if (result.deferred) { /* budget deferral is neither analysis nor failure */ }
    else if (result.success) analyzed++;
    else failed++;
    // Rate limit: wait 2s between channels to avoid YouTube API quota issues
    await new Promise((r) => setTimeout(r, 2000));
    throwIfChannelLearningAborted(options.abortSignal);
  }

  // Re-analyze active channels (skip fresh ones unless forced)
  const active = getScopedChannelsForProcessing('active', userId);
  const staleThreshold = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const ch of active) {
    if (!force && ch.last_analyzed_at && new Date(ch.last_analyzed_at).getTime() > staleThreshold) {
      continue; // Fresh enough
    }
    const result = await analyzeChannel(ch.id, {
      skipIfUnchanged: !force,
      budgetContext: {
        requestSource: ch.user_id && ch.user_id > 0 ? requestSource : 'system',
        jobName,
        runId: scopeRunId,
        abortSignal: options.abortSignal,
      },
    });
    if (result.skipped) skippedNoNewVideos++;
    else if (result.deferred) { /* budget deferral is neither analysis nor failure */ }
    else if (result.success) analyzed++;
    else failed++;
    await new Promise((r) => setTimeout(r, 2000));
    throwIfChannelLearningAborted(options.abortSignal);
  }

  // Synthesize knowledge if anything was actually (re-)analyzed. Channels
  // skipped by the new-video gate contribute nothing new, so an all-skipped
  // scope skips its synthesis LLM calls entirely.
  let synthesized = false;
  let synthesisDeferred = false;
  const allSkippedNoNewVideos = skippedNoNewVideos > 0 && analyzed === 0 && failed === 0;
  if (analyzed > 0) {
    synthesized = await synthesizeKnowledge(userId, {
      requestSource: userId != null && userId > 0 ? requestSource : 'system',
      jobName,
      runId: scopeRunId,
      abortSignal: options.abortSignal,
    });
    synthesisDeferred = !synthesized;
  } else if (allSkippedNoNewVideos) {
    logger.info(
      { userId: userId ?? null, skippedNoNewVideos },
      'All channels in scope skipped by new-video gate — knowledge synthesis skipped (nothing new to synthesize)',
    );
  }

  return {
    analyzed,
    failed,
    skipped_no_new_videos: skippedNoNewVideos,
    synthesized,
    synthesis_skipped_all_unchanged: allSkippedNoNewVideos,
    synthesis_deferred: synthesisDeferred,
  };
}

export interface ChannelRelearnScopePlan {
  scopes: Array<number | undefined>;
  synthesisDeferred: boolean;
}

export function planChannelRelearnScopes(): ChannelRelearnScopePlan {
  const eligibleUserIds = listEligibleContentAutomationUserIds();
  if (eligibleUserIds.length === 0) {
    logger.info('Channel re-learn skipped: no eligible paid Content automation consumer');
    return { scopes: [], synthesisDeferred: false };
  }

  const eligibleSet = new Set(eligibleUserIds);
  const sharedKnowledgeConsumerIds = eligibleUserIds.filter(hasSharedChannelKnowledgeConsumerEvidence);
  let synthesisDeferred = false;
  if (sharedKnowledgeConsumerIds.length === 0) {
    recordSharedKnowledgeEvidenceDeferral();
    synthesisDeferred = true;
    logger.info(
      'Channel re-learn platform scope skipped: no eligible user has recent shared-knowledge consumption evidence',
    );
  }
  return {
    scopes: [
      ...(sharedKnowledgeConsumerIds.length > 0 ? [undefined] : []),
      ...listContentChannelUserIds().filter((userId) => eligibleSet.has(userId)),
    ],
    synthesisDeferred,
  };
}

export async function processChannelRelearnScope(
  force: boolean,
  scopeUserId: number | undefined,
  options: { runId: string; systemScopeChanged: boolean; abortSignal?: AbortSignal },
): Promise<ChannelRelearnResult> {
  const scopeRequestSource = scopeUserId != null && scopeUserId > 0 ? 'automation' as const : 'system' as const;
  const result = await processAllChannels(force, scopeUserId, {
    requestSource: scopeRequestSource,
    jobName: 'channel_relearn',
    runId: options.runId,
    abortSignal: options.abortSignal,
  });

  if (scopeUserId == null) return result;

  // If shared system channels were refreshed, resynthesize user-owned
  // knowledge too so user prompts do not keep stale copies of the shared base.
  const hasActiveUserChannels = getScopedChannelsForProcessing('active', scopeUserId).length > 0;
  if (!options.systemScopeChanged || !hasActiveUserChannels || result.synthesized) return result;

  const userSynthesisSucceeded = await synthesizeKnowledge(scopeUserId, {
    requestSource: 'automation',
    jobName: 'channel_relearn',
    runId: options.runId,
    abortSignal: options.abortSignal,
  });
  return {
    ...result,
    synthesized: userSynthesisSucceeded,
    synthesis_deferred: result.synthesis_deferred || !userSynthesisSucceeded,
  };
}

export async function processAllChannelScopes(force = false): Promise<ChannelRelearnResult> {
  let analyzed = 0;
  let failed = 0;
  let skippedNoNewVideos = 0;
  let synthesized = false;
  // True when at least one scope skipped its synthesis calls because every
  // channel it processed was unchanged (new-video gate).
  let synthesisSkippedAllUnchanged = false;
  let synthesisDeferred = false;

  const plan = planChannelRelearnScopes();
  synthesisDeferred = plan.synthesisDeferred;
  let systemScopeChanged = false;
  for (const scopeUserId of plan.scopes) {
    const scopeRunId = randomUUID();
    const result = await processChannelRelearnScope(force, scopeUserId, {
      runId: scopeRunId,
      systemScopeChanged,
    });
    analyzed += result.analyzed;
    failed += result.failed;
    skippedNoNewVideos += result.skipped_no_new_videos;
    synthesized = synthesized || result.synthesized;
    synthesisSkippedAllUnchanged = synthesisSkippedAllUnchanged || result.synthesis_skipped_all_unchanged;
    synthesisDeferred = synthesisDeferred || result.synthesis_deferred;
    if (scopeUserId == null) systemScopeChanged = result.synthesized;
  }

  return {
    analyzed,
    failed,
    skipped_no_new_videos: skippedNoNewVideos,
    synthesized,
    synthesis_skipped_all_unchanged: synthesisSkippedAllUnchanged,
    synthesis_deferred: synthesisDeferred,
  };
}

/**
 * Add a channel and immediately start analysis.
 * Called from bot command or portal.
 */
export async function addAndAnalyzeChannel(
  channelUrl: string,
  addedVia: 'manual' | 'portal' | 'bot' = 'bot',
  userId = 0,
  tenantId?: number,
  budgetContext: ChannelAiBudgetContext = {
    requestSource: userId > 0 ? 'interactive' : 'system',
    jobName: 'channel_add',
  },
): Promise<{
  channel: ContentRefChannel;
  analysis: Awaited<ReturnType<typeof analyzeChannel>>;
}> {
  // Synthesized knowledge is unique by (user_id, category), so accepting a
  // second tenant here would overwrite that user's default-tenant knowledge.
  // Reject before even reading or adding the channel until persistence can
  // represent independent tenant-specific synthesis safely.
  assertSupportedChannelLearningScope(userId, tenantId);
  throwIfChannelLearningAborted(budgetContext.abortSignal);
  const normalizedUrl = channelUrl.trim().replace(/\/+$/, '');
  const existingChannel = (userId > 0
    ? getAllChannels(userId, tenantId)
    : getSystemChannels(CONTENT_LEARNER_ADMIN_CONTEXT))
    .find((candidate) => candidate.channel_url === normalizedUrl);
  const channel = userId > 0
    ? addChannel(channelUrl, addedVia, userId, tenantId)
    : addSystemChannel(channelUrl, addedVia, CONTENT_LEARNER_ADMIN_CONTEXT);
  if (!existingChannel || (existingChannel.status === 'failed' && channel.status === 'pending')) {
    invalidateChannelLearnerContentCaches(userId > 0 ? userId : undefined);
  }
  const analysis = await analyzeChannel(channel.id, { budgetContext });

  // Re-synthesize if analysis was successful. Explicit add-and-analyze runs
  // without the new-video gate (skipIfUnchanged defaults off), so `skipped`
  // is never set today; the guard future-proofs against gated callers, since
  // a skipped analysis produces nothing new to synthesize.
  if (analysis.success && !analysis.skipped) {
    await synthesizeKnowledge(userId, budgetContext);
  }

  // Return fresh channel data
  const { getChannel } = await import('../state/content-references');
  const updated = getChannel(channel.id, accessForChannel(channel));

  return {
    channel: updated || channel,
    analysis,
  };
}

// ─── Seed default channels ──────────────────────────────────────────

// Default channels are explicit operator configuration. Missing/empty config
// must stay neutral instead of projecting creator-specific references globally.
function getDefaultChannels(): string[] {
  try {
    const rows = getDb().prepare(
      'SELECT url FROM config_default_channels WHERE enabled = 1'
    ).all() as Array<{ url: string }>;
    if (rows.length > 0) return rows.map(r => r.url);
  } catch { /* table does not exist yet */ }
  return [];
}

/**
 * Seed the default reference channels if the table is empty.
 * Called once during bot startup.
 */
export function seedDefaultChannels(): void {
  const defaultChannels = getDefaultChannels();
  if (defaultChannels.length === 0) return;
  const existing = getSystemChannels(CONTENT_LEARNER_ADMIN_CONTEXT);
  if (existing.length > 0) return; // Already seeded

  logger.info({ channelCount: defaultChannels.length }, 'Seeding default content reference channels');
  for (const url of defaultChannels) {
    addSystemChannel(url, 'manual', CONTENT_LEARNER_ADMIN_CONTEXT);
  }
}

// ─── Force re-synthesis (for portal quick action) ────────────────────

export { synthesizeKnowledge };
