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
import { config } from '../config';
import { logger } from '../utils/logger';
import { trackedCreate } from '../portal/anthropic-hook';
import { completeOneShotWithFallback } from './gemini-provider';
import { loadPrompt } from '../utils/prompt-loader';
import { pushEvent } from '../portal/telemetry';
import { deepAnalyzeTopVideos } from './video-study';
import {
  addChannel,
  getAllChannels,
  getActiveChannels,
  getPendingChannels,
  updateChannelStatus,
  upsertPatterns,
  upsertKnowledge,
  getAllPatternsByCategory,
  PATTERN_CATEGORIES,
  type PatternCategory,
  type ContentRefChannel,
} from '../state/content-references';
import { writeSignal } from './intelligence-bus';
import { getDb } from './database';

const client = new Anthropic({
  apiKey: config.anthropic.apiKey,
  maxRetries: 3,
});

// ─── YouTube Data API helpers ────────────────────────────────────────

const YT_API_KEY = process.env.YOUTUBE_API_KEY || '';
const YT_SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';
const YT_VIDEOS_URL = 'https://www.googleapis.com/youtube/v3/videos';
const YT_CHANNELS_URL = 'https://www.googleapis.com/youtube/v3/channels';

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

/**
 * Resolve a YouTube channel URL/handle to a channel ID and name.
 * Supports: @handle, /channel/UCxxxx, /c/Name, full URL
 */
async function resolveChannel(channelUrl: string): Promise<{
  channelId: string;
  channelName: string;
} | null> {
  if (!YT_API_KEY) {
    logger.warn('YOUTUBE_API_KEY not set — cannot resolve channel');
    return null;
  }

  // Extract handle or ID from URL
  let searchQuery = channelUrl;
  const handleMatch = channelUrl.match(/@([\w.-]+)/);
  const channelIdMatch = channelUrl.match(/\/channel\/(UC[\w-]+)/);

  if (channelIdMatch) {
    // Direct channel ID — fetch info
    try {
      const url = `${YT_CHANNELS_URL}?part=snippet&id=${channelIdMatch[1]}&key=${YT_API_KEY}`;
      const res = await fetch(url);
      const data = await res.json() as any;
      if (data.items?.length > 0) {
        return {
          channelId: data.items[0].id,
          channelName: data.items[0].snippet?.title || channelUrl,
        };
      }
    } catch (err) {
      logger.warn({ err, channelUrl }, 'Failed to resolve channel by ID');
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
    const res = await fetch(`${YT_SEARCH_URL}?${params}`);
    const data = await res.json() as any;

    if (data.items?.length > 0) {
      return {
        channelId: data.items[0].id?.channelId || data.items[0].snippet?.channelId,
        channelName: data.items[0].snippet?.channelTitle || searchQuery,
      };
    }
  } catch (err) {
    logger.warn({ err, searchQuery }, 'Failed to search for channel');
  }

  return null;
}

/**
 * Fetch recent videos from a channel with statistics.
 */
async function fetchChannelVideos(
  channelId: string,
  maxVideos = 20,
): Promise<VideoData[]> {
  if (!YT_API_KEY) return [];

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
    const searchRes = await fetch(`${YT_SEARCH_URL}?${searchParams}`);
    const searchData = await searchRes.json() as any;

    const videoIds = (searchData.items || [])
      .map((item: any) => item.id?.videoId)
      .filter(Boolean);

    if (videoIds.length === 0) return [];

    // Step 2: Get video details + statistics (YouTube API allows max 50 per call)
    const statsParams = new URLSearchParams({
      part: 'statistics,contentDetails,snippet',
      id: videoIds.join(','),
      key: YT_API_KEY,
    });
    const statsRes = await fetch(`${YT_VIDEOS_URL}?${statsParams}`);
    const statsData = await statsRes.json() as any;

    const allVideos = (statsData.items || []).map((v: any) => ({
      videoId: v.id,
      title: v.snippet?.title || '',
      description: (v.snippet?.description || '').substring(0, 500),
      publishedAt: v.snippet?.publishedAt || '',
      viewCount: parseInt(v.statistics?.viewCount || '0', 10),
      likeCount: parseInt(v.statistics?.likeCount || '0', 10),
      commentCount: parseInt(v.statistics?.commentCount || '0', 10),
      duration: v.contentDetails?.duration || '',
      channelTitle: v.snippet?.channelTitle || '',
    }));

    // Return top performers sorted by view count
    return allVideos
      .sort((a: VideoData, b: VideoData) => b.viewCount - a.viewCount)
      .slice(0, maxVideos);
  } catch (err) {
    logger.error({ err, channelId }, 'Failed to fetch channel videos');
    return [];
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

/**
 * Send video data to Claude for pattern extraction.
 */
async function extractPatterns(
  channelName: string,
  videos: VideoData[],
  transcriptData?: string,
): Promise<ExtractionResult> {
  // Build a concise video summary for Claude
  const videoSummary = videos.map((v, i) => {
    const views = v.viewCount > 1000 ? `${(v.viewCount / 1000).toFixed(1)}K` : v.viewCount;
    const likes = v.likeCount > 1000 ? `${(v.likeCount / 1000).toFixed(1)}K` : v.likeCount;
    return `${i + 1}. "${v.title}"
   Views: ${views} | Likes: ${likes} | Comments: ${v.commentCount} | Duration: ${v.duration}
   Desc: ${v.description.substring(0, 200)}${v.description.length > 200 ? '...' : ''}`;
  }).join('\n\n');

  let prompt = `Analyze the YouTube channel "${channelName}" based on their ${videos.length} most recent videos.

VIDEOS:
${videoSummary}`;

  // Enrich with transcript data from top videos
  if (transcriptData) {
    prompt += `

TRANSCRIPTS FROM TOP-PERFORMING VIDEOS:
(Use these to extract EXACT hook phrases, transition words, storytelling beats, and pacing patterns — not just title-level patterns)
${transcriptData}`;
  }

  prompt += `

Extract content creation patterns across all 9 categories. Focus on what makes this creator successful — patterns that can be adapted (not copied) for a Portuguese-language fitness + commentary YouTube channel.`;

  // Gemini-first: gemini-2.5-flash matches Sonnet for analytical pattern
  // extraction at ~9× lower cost. Falls back to Anthropic on failure.
  const { text: rawAnalysisText } = await completeOneShotWithFallback(
    loadPrompt('channel-learner'),
    prompt,
    'channel_analysis',
    async () => {
      const response = await trackedCreate(client, {
        model: config.anthropic.model, // Sonnet for quality analysis
        max_tokens: 8192,
        system: loadPrompt('channel-learner'),
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3, // Lower temp for more consistent analysis
      }, 'channel_analysis');
      return response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
    },
    { maxTokens: 8192, temperature: 0.3 },
  );

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
    return JSON.parse(text) as ExtractionResult;
  } catch (err) {
    logger.warn({ err, textLength: text.length }, 'Failed to parse extraction result');
    return { channel_summary: '', patterns: [] };
  }
}

// ─── Synthesis (merge patterns across all channels) ──────────────────

const SYNTHESIS_SYSTEM_PROMPT = `You are a content strategy synthesizer. You receive patterns extracted from multiple successful YouTube creators. Your job: merge them into a unified, actionable knowledge base.

Rules:
- Combine similar patterns into a single, richer description
- Prioritize patterns that appear across MULTIPLE creators (cross-validated)
- Keep concrete examples from each creator (attribute them)
- Remove contradictions — if creators disagree, note both approaches
- Write as actionable advice for a creator making PT-BR content about fitness + commentary
- Be concise: each category should be 3-6 sentences max + examples
- Output language: English (this is a system prompt, not audience-facing content)

Return ONLY valid JSON:
{
  "categories": [
    {
      "category": "hook_style",
      "synthesized_text": "Merged insight with examples...",
      "source_channels": ["Channel A", "Channel B"]
    }
  ]
}`;

async function synthesizeKnowledge(): Promise<void> {
  const channels = getActiveChannels();
  if (channels.length === 0) {
    logger.info('No active channels to synthesize knowledge from');
    return;
  }

  logger.info({ channelCount: channels.length }, 'Synthesizing cross-channel knowledge');

  for (const category of PATTERN_CATEGORIES) {
    const patterns = getAllPatternsByCategory(category);
    if (patterns.length === 0) continue;

    // Group by channel
    const byChannel = new Map<string, typeof patterns>();
    for (const p of patterns) {
      const name = (p as any).channel_name || 'Unknown';
      const existing = byChannel.get(name) || [];
      existing.push(p);
      byChannel.set(name, existing);
    }

    // Build context for Claude
    const context = [...byChannel.entries()].map(([name, pats]) => {
      return `From "${name}":\n${pats.map((p) => {
        const examples = JSON.parse(p.examples) as string[];
        return `  - ${p.pattern_text} (confidence: ${p.confidence})\n    Examples: ${examples.join('; ')}`;
      }).join('\n')}`;
    }).join('\n\n');

    // If only one channel contributes to this category, skip synthesis — use directly
    if (byChannel.size === 1) {
      const [channelName, pats] = [...byChannel.entries()][0];
      const highConf = pats.filter((p) => p.confidence >= 0.5);
      if (highConf.length === 0) continue;

      const directText = highConf.map((p) => {
        const examples = JSON.parse(p.examples) as string[];
        return `${p.pattern_text}\nExamples from ${channelName}: ${examples.slice(0, 3).join('; ')}`;
      }).join('\n');

      upsertKnowledge(category, directText, [channelName]);
      continue;
    }

    // Multiple channels → synthesize via Gemini (Anthropic Haiku fallback).
    // knowledge_synthesis is the highest-frequency line in the audit
    // (~18 calls/wk avg) so cumulative savings here are meaningful even
    // though per-call cost is small.
    try {
      const userPrompt = `Synthesize the "${category}" patterns from ${byChannel.size} creators:\n\n${context}`;
      const { text: synthText } = await completeOneShotWithFallback(
        SYNTHESIS_SYSTEM_PROMPT,
        userPrompt,
        'knowledge_synthesis',
        async () => {
          const response = await trackedCreate(client, {
            model: config.anthropic.classifierModel, // Haiku for synthesis (structured task)
            max_tokens: 2048,
            system: SYNTHESIS_SYSTEM_PROMPT,
            messages: [{ role: 'user', content: userPrompt }],
            temperature: 0.3,
          }, 'knowledge_synthesis');
          return response.content
            .filter((b): b is Anthropic.TextBlock => b.type === 'text')
            .map((b) => b.text)
            .join('');
        },
        { maxTokens: 2048, temperature: 0.3 },
      );

      let text = synthText;

      // Extract JSON from potential markdown fences or surrounding text
      const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fenceMatch) {
        text = fenceMatch[1].trim();
      } else {
        // Try to find the JSON object directly
        const jsonStart = text.indexOf('{');
        const jsonEnd = text.lastIndexOf('}');
        if (jsonStart !== -1 && jsonEnd > jsonStart) {
          text = text.slice(jsonStart, jsonEnd + 1);
        }
      }

      const result = JSON.parse(text) as {
        categories: { category: string; synthesized_text: string; source_channels: string[] }[];
      };

      for (const cat of result.categories) {
        if (cat.category === category) {
          upsertKnowledge(category as PatternCategory, cat.synthesized_text, cat.source_channels);
          break;
        }
      }
    } catch (err) {
      logger.warn({ err, category }, 'Failed to synthesize category — using concatenation fallback');
      // Fallback: concatenate all patterns
      const allText = patterns
        .filter((p) => p.confidence >= 0.5)
        .map((p) => p.pattern_text)
        .join('\n');
      if (allText) {
        upsertKnowledge(
          category,
          allText,
          [...byChannel.keys()],
        );
      }
    }
  }

  logger.info('Knowledge synthesis complete');
  pushEvent({
    ts: new Date().toISOString(),
    type: 'job',
    summary: `Content knowledge synthesized from ${channels.length} channel(s)`,
  });

  // Write structured Channel DNA signals to the intelligence bus
  writeChannelDNASignals(channels);
}

/**
 * Writes one signal per channel per pattern category to the intelligence bus.
 * Other agents (Script, Hooks, SEO, Performance) can read these independently.
 */
function writeChannelDNASignals(channels: ContentRefChannel[]): void {
  let signalCount = 0;

  for (const channel of channels) {
    for (const category of PATTERN_CATEGORIES) {
      const patterns = getAllPatternsByCategory(category)
        .filter((p) => (p as any).channel_id === channel.id && p.confidence >= 0.4);

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
        writeSignal({
          source_agent: 'channel-learner',
          signal_type: 'channel_dna',
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
        signalCount++;
      } catch (err) {
        logger.warn({ err, channel: channel.channel_name, category }, 'Failed to write channel DNA signal');
      }
    }
  }

  logger.info({ signalCount, channelCount: channels.length }, 'Channel DNA signals written to intelligence bus');
}

// ─── Main Analysis Pipeline ──────────────────────────────────────────

/**
 * Analyze a single channel: fetch videos → extract patterns → store.
 * Returns a human-readable summary.
 */
export async function analyzeChannel(channelId: number): Promise<{
  success: boolean;
  summary: string;
  patternsFound: number;
  videosAnalyzed: number;
  error?: string;
}> {
  const { getChannel } = await import('../state/content-references');
  const channel = getChannel(channelId);
  if (!channel) {
    return { success: false, summary: '', patternsFound: 0, videosAnalyzed: 0, error: 'Channel not found' };
  }

  logger.info({ channelId, url: channel.channel_url }, 'Starting channel analysis');
  updateChannelStatus(channelId, 'analyzing');

  try {
    // Step 1: Resolve channel
    const resolved = await resolveChannel(channel.channel_url);
    if (!resolved) {
      updateChannelStatus(channelId, 'failed', {
        error_message: 'Could not resolve YouTube channel — check URL or API key',
      });
      return {
        success: false,
        summary: '',
        patternsFound: 0,
        videosAnalyzed: 0,
        error: 'Could not resolve YouTube channel',
      };
    }

    updateChannelStatus(channelId, 'analyzing', {
      channel_name: resolved.channelName,
      channel_id: resolved.channelId,
    });

    // Step 2: Fetch recent videos
    const videos = await fetchChannelVideos(resolved.channelId, 10);
    if (videos.length === 0) {
      updateChannelStatus(channelId, 'failed', {
        error_message: 'No videos found for this channel',
      });
      return {
        success: false,
        summary: '',
        patternsFound: 0,
        videosAnalyzed: 0,
        error: 'No videos found',
      };
    }

    logger.info({ channelName: resolved.channelName, videoCount: videos.length }, 'Videos fetched, extracting patterns');

    // Step 2.5: Fetch transcripts for top 5 videos (enriches pattern extraction)
    let transcriptData: string | undefined;
    try {
      const topVids = videos.map((v) => ({
        videoId: v.videoId,
        title: v.title,
        viewCount: v.viewCount,
      }));
      const deep = await deepAnalyzeTopVideos(resolved.channelName, topVids, 5);
      if (deep.transcriptCount > 0) {
        transcriptData = deep.deepPatterns;
        logger.info({
          channelName: resolved.channelName,
          transcriptCount: deep.transcriptCount,
        }, 'Transcript data fetched for top videos');
      }
    } catch (err) {
      logger.warn({ err, channelName: resolved.channelName }, 'Transcript enrichment failed (non-critical, continuing with metadata only)');
    }

    // Step 3: Extract patterns via Claude (now with optional transcript data)
    const extraction = await extractPatterns(resolved.channelName, videos, transcriptData);

    // Step 4: Store patterns
    const validPatterns = extraction.patterns.filter(
      (p) => PATTERN_CATEGORIES.includes(p.category) && p.confidence > 0.2,
    );

    if (validPatterns.length > 0) {
      upsertPatterns(channelId, validPatterns);
    }

    // Step 5: Mark as active
    updateChannelStatus(channelId, 'active', {
      video_count_analyzed: videos.length,
      error_message: null,
    });

    logger.info({
      channelName: resolved.channelName,
      patternsFound: validPatterns.length,
      videosAnalyzed: videos.length,
    }, 'Channel analysis complete');

    pushEvent({
      ts: new Date().toISOString(),
      type: 'job',
      summary: `Channel "${resolved.channelName}" analyzed: ${validPatterns.length} patterns from ${videos.length} videos`,
    });

    return {
      success: true,
      summary: extraction.channel_summary,
      patternsFound: validPatterns.length,
      videosAnalyzed: videos.length,
    };
  } catch (err) {
    const message = (err as Error).message;
    logger.error({ err, channelId }, 'Channel analysis failed');
    updateChannelStatus(channelId, 'failed', { error_message: message });
    return {
      success: false,
      summary: '',
      patternsFound: 0,
      videosAnalyzed: 0,
      error: message,
    };
  }
}

/**
 * Process all pending channels and re-analyze stale active channels.
 * Called by the scheduler weekly.
 */
export async function processAllChannels(force = false): Promise<{
  analyzed: number;
  failed: number;
  synthesized: boolean;
}> {
  let analyzed = 0;
  let failed = 0;

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
        AND updated_at < datetime('now', '-30 minutes')
    `).all() as Array<{ id: number; channel_name: string | null }>;

    for (const ch of stuckAnalyzing) {
      updateChannelStatus(ch.id, 'pending', {
        error_message: 'Auto-recovered from stuck analyzing state (process crash or timeout)',
      });
      logger.warn(
        { channelId: ch.id, channelName: ch.channel_name },
        'Channel was stuck in analyzing — reset to pending for retry',
      );
    }

    const failedRetryable = db.prepare(`
      SELECT id, channel_name FROM content_ref_channels
      WHERE status = 'failed'
        AND updated_at < datetime('now', '-12 hours')
    `).all() as Array<{ id: number; channel_name: string | null }>;

    for (const ch of failedRetryable) {
      updateChannelStatus(ch.id, 'pending', { error_message: null });
      logger.info(
        { channelId: ch.id, channelName: ch.channel_name },
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
    logger.error({ err }, 'Channel recovery query failed (non-critical, continuing)');
  }

  // Process pending channels first (now includes any just-recovered ones)
  const pending = getPendingChannels();
  for (const ch of pending) {
    const result = await analyzeChannel(ch.id);
    if (result.success) analyzed++;
    else failed++;
    // Rate limit: wait 2s between channels to avoid YouTube API quota issues
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Re-analyze active channels (skip fresh ones unless forced)
  const active = getActiveChannels();
  const staleThreshold = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const ch of active) {
    if (!force && ch.last_analyzed_at && new Date(ch.last_analyzed_at).getTime() > staleThreshold) {
      continue; // Fresh enough
    }
    const result = await analyzeChannel(ch.id);
    if (result.success) analyzed++;
    else failed++;
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Synthesize knowledge if anything was analyzed
  let synthesized = false;
  if (analyzed > 0) {
    await synthesizeKnowledge();
    synthesized = true;
  }

  return { analyzed, failed, synthesized };
}

/**
 * Add a channel and immediately start analysis.
 * Called from bot command or portal.
 */
export async function addAndAnalyzeChannel(
  channelUrl: string,
  addedVia: 'manual' | 'portal' | 'bot' = 'bot',
): Promise<{
  channel: ContentRefChannel;
  analysis: Awaited<ReturnType<typeof analyzeChannel>>;
}> {
  const channel = addChannel(channelUrl, addedVia);
  const analysis = await analyzeChannel(channel.id);

  // Re-synthesize if analysis was successful
  if (analysis.success) {
    await synthesizeKnowledge();
  }

  // Return fresh channel data
  const { getChannel } = await import('../state/content-references');
  const updated = getChannel(channel.id);

  return {
    channel: updated || channel,
    analysis,
  };
}

// ─── Seed default channels ──────────────────────────────────────────

// Default channels: read from config_default_channels table (migration 055).
// Falls back to hardcoded array if the table doesn't exist yet.
function getDefaultChannels(): string[] {
  try {
    const rows = getDb().prepare(
      'SELECT url FROM config_default_channels WHERE enabled = 1'
    ).all() as Array<{ url: string }>;
    if (rows.length > 0) return rows.map(r => r.url);
  } catch { /* table doesn't exist yet */ }
  return [
    'https://www.youtube.com/@danielbarada',
    'https://www.youtube.com/@NewelOfKnowledge',
    'https://www.youtube.com/@Jett.franzen',
    'https://www.youtube.com/@DanKoeTalks',
  ];
}
const DEFAULT_CHANNELS = getDefaultChannels();

/**
 * Seed the default reference channels if the table is empty.
 * Called once during bot startup.
 */
export function seedDefaultChannels(): void {
  const existing = getAllChannels();
  if (existing.length > 0) return; // Already seeded

  logger.info({ channels: DEFAULT_CHANNELS }, 'Seeding default content reference channels');
  for (const url of DEFAULT_CHANNELS) {
    addChannel(url, 'manual');
  }
}

// ─── Force re-synthesis (for portal quick action) ────────────────────

export { synthesizeKnowledge };
