// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Performance Intelligence Agent — analyzes the authenticated creator's YouTube channel
 * performance to identify what works and feed back into content creation.
 *
 * Schedule: Weekly, Sunday 06:00 (after channel relearn at 03:00)
 *
 * Consumes: channel_dna, book_knowledge, voice_pattern (cross-agent), keyword_opportunity (cross-agent)
 * Produces: hook_effectiveness, pillar_performance, retention_pattern, book_reference_effective, content_formula
 *
 * NOTE: Currently uses YouTube Data API v3 (public stats only).
 * YouTube Analytics API (retention curves, traffic sources) requires separate OAuth setup.
 * Agent gracefully degrades without it.
 */

import { writeSignal, readSignals, logAgentRun } from '../services/intelligence-bus';
import { buildAgentContext, writeContentFormula, formatContextForPrompt } from '../services/cross-agent-learning';
import { getDb } from '../services/database';
import { config } from '../config';
import { logger } from '../utils/logger';
import { listUserScopedYoutubeChannelTargets } from '../services/youtube-channel-scope';

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

// ── YouTube API Helpers ──────────────────────────────────────────────

interface VideoStats {
  videoId: string;
  title: string;
  publishedAt: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  duration: string;
  pillar: string;
}

async function fetchOwnChannelVideos(channelId: string, maxResults = 30): Promise<VideoStats[]> {
  const apiKey = config.youtube?.apiKey;

  if (!apiKey || !channelId) {
    logger.warn('Performance Agent: YOUTUBE_API_KEY or user-scoped creator channel not set. Skipping.');
    return [];
  }

  try {
    // Get uploads playlist
    const chParams = new URLSearchParams({
      part: 'contentDetails',
      id: channelId,
      key: apiKey,
    });
    const chResp = await fetch(`${YOUTUBE_API_BASE}/channels?${chParams}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!chResp.ok) return [];
    const chData = await chResp.json() as any;
    const uploadsPlaylist = chData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsPlaylist) return [];

    // Get recent video IDs
    const plParams = new URLSearchParams({
      part: 'snippet',
      playlistId: uploadsPlaylist,
      maxResults: String(maxResults),
      key: apiKey,
    });
    const plResp = await fetch(`${YOUTUBE_API_BASE}/playlistItems?${plParams}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!plResp.ok) return [];
    const plData = await plResp.json() as any;

    const videoIds = (plData.items || [])
      .map((item: any) => item.snippet?.resourceId?.videoId)
      .filter(Boolean);

    if (videoIds.length === 0) return [];

    // Get full stats for each video
    const vParams = new URLSearchParams({
      part: 'snippet,statistics,contentDetails',
      id: videoIds.join(','),
      key: apiKey,
    });
    const vResp = await fetch(`${YOUTUBE_API_BASE}/videos?${vParams}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!vResp.ok) return [];
    const vData = await vResp.json() as any;

    return (vData.items || []).map((item: any) => ({
      videoId: item.id,
      title: item.snippet?.title || '',
      publishedAt: item.snippet?.publishedAt || '',
      viewCount: parseInt(item.statistics?.viewCount || '0', 10),
      likeCount: parseInt(item.statistics?.likeCount || '0', 10),
      commentCount: parseInt(item.statistics?.commentCount || '0', 10),
      duration: item.contentDetails?.duration || '',
      pillar: detectPillar(item.snippet?.title || ''),
    }));
  } catch (err) {
    logger.error({ err }, 'Failed to fetch own channel videos');
    return [];
  }
}

function detectPillar(title: string): string {
  const lower = title.toLowerCase();
  const pillars: Record<string, string[]> = {
    technology: ['tecnologia', 'inteligência artificial', 'automação', 'software', 'produto', 'ferramenta', 'startup'],
    creator_economy: ['criador', 'youtube', 'instagram', 'vídeo', 'shorts', 'reels', 'conteúdo', 'audiência'],
    wellness: ['treino', 'corrida', 'nutrição', 'recuperação', 'sono', 'saúde', 'performance', 'gym'],
    lifestyle: ['rotina', 'hábitos', 'viagem', 'organização', 'agenda', 'trabalho', 'comunidade'],
    business: ['negócio', 'empresa', 'mercado', 'cliente', 'produto', 'operação', 'finanças'],
  };

  let best = 'general';
  let bestScore = 0;
  for (const [pillar, kws] of Object.entries(pillars)) {
    const score = kws.filter(k => lower.includes(k)).length;
    if (score > bestScore) { bestScore = score; best = pillar; }
  }
  return best;
}

function parseDuration(iso: string): number {
  // PT5M30S → 330 seconds
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  return (parseInt(match[1] || '0') * 3600) +
         (parseInt(match[2] || '0') * 60) +
         parseInt(match[3] || '0');
}

// ── Analysis Functions ───────────────────────────────────────────────

function analyzePillarPerformance(videos: VideoStats[]): Record<string, any>[] {
  const byPillar = new Map<string, VideoStats[]>();
  for (const v of videos) {
    const existing = byPillar.get(v.pillar) || [];
    existing.push(v);
    byPillar.set(v.pillar, existing);
  }

  const rankings: Record<string, any>[] = [];
  for (const [pillar, vids] of byPillar) {
    if (vids.length < 2) continue;

    const avgViews = Math.round(vids.reduce((s, v) => s + v.viewCount, 0) / vids.length);
    const avgLikes = Math.round(vids.reduce((s, v) => s + v.likeCount, 0) / vids.length);
    const avgComments = Math.round(vids.reduce((s, v) => s + v.commentCount, 0) / vids.length);

    // Trend: compare first half vs second half
    const sorted = [...vids].sort((a, b) => new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime());
    const mid = Math.floor(sorted.length / 2);
    const firstHalf = sorted.slice(0, mid);
    const secondHalf = sorted.slice(mid);
    const firstAvg = firstHalf.reduce((s, v) => s + v.viewCount, 0) / (firstHalf.length || 1);
    const secondAvg = secondHalf.reduce((s, v) => s + v.viewCount, 0) / (secondHalf.length || 1);
    const trend = secondAvg > firstAvg * 1.1 ? 'rising' :
                  secondAvg < firstAvg * 0.9 ? 'declining' : 'stable';

    rankings.push({
      pillar,
      video_count: vids.length,
      avg_views: avgViews,
      avg_likes: avgLikes,
      avg_comments: avgComments,
      engagement_rate: avgViews > 0 ? Math.round((avgLikes + avgComments) / avgViews * 1000) / 10 : 0,
      trend,
    });
  }

  return rankings.sort((a, b) => b.avg_views - a.avg_views);
}

function analyzeOptimalDuration(videos: VideoStats[]): { range: string; avg_views: number }[] {
  const buckets: Record<string, VideoStats[]> = {
    'short_0-3min': [],
    'medium_3-8min': [],
    'long_8-15min': [],
    'extended_15min+': [],
  };

  for (const v of videos) {
    const seconds = parseDuration(v.duration);
    if (seconds < 180) buckets['short_0-3min'].push(v);
    else if (seconds < 480) buckets['medium_3-8min'].push(v);
    else if (seconds < 900) buckets['long_8-15min'].push(v);
    else buckets['extended_15min+'].push(v);
  }

  return Object.entries(buckets)
    .filter(([, vids]) => vids.length >= 2)
    .map(([range, vids]) => ({
      range,
      avg_views: Math.round(vids.reduce((s, v) => s + v.viewCount, 0) / vids.length),
    }))
    .sort((a, b) => b.avg_views - a.avg_views);
}

// ── Main Agent Runner ────────────────────────────────────────────────

export async function runPerformanceAgent(): Promise<void> {
  const start = Date.now();

  try {
    const channelTargets = listUserScopedYoutubeChannelTargets();
    if (channelTargets.length === 0) {
      logger.warn('Performance Agent: no user-scoped creator YouTube channel configured. Global YOUTUBE_CHANNEL_ID is intentionally ignored.');
      logAgentRun('performance-agent', 'skipped', 0, 0, Date.now() - start, 'No user-scoped creator YouTube channel configured');
      return;
    }

    // Content-mesh signals are currently platform-global. Until they carry
    // user/tenant scope, do not analyze user-owned channels here; writing
    // one user's performance metrics into global signals would leak them to
    // every creator. This intentionally fails closed instead of falling back
    // to YOUTUBE_CHANNEL_ID.
    logger.warn(
      { channelTargets: channelTargets.length },
      'Performance Agent paused: user-scoped content performance signals are not supported yet',
    );
    logAgentRun('performance-agent', 'skipped', 0, 0, Date.now() - start, 'User-scoped performance signals not supported yet');
  } catch (err: any) {
    logAgentRun('performance-agent', 'error', 0, 0, Date.now() - start, err.message);
    logger.error({ err }, 'Performance Agent failed');
    throw err;
  }
}
