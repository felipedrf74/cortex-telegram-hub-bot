/**
 * YouTube Analytics Service — fetches video stats from YouTube Data API v3.
 *
 * Uses:
 * - YouTube Data API v3 (YOUTUBE_API_KEY) for public stats
 * - Google OAuth (GOOGLE_REFRESH_TOKEN) for YouTube Analytics API (retention, CTR)
 *
 * Gracefully degrades: if Analytics API unavailable, uses Data API only.
 */

import { config } from '../config';
import { logger } from '../utils/logger';

const YT_DATA_BASE = 'https://www.googleapis.com/youtube/v3';
const YT_ANALYTICS_BASE = 'https://youtubeanalytics.googleapis.com/v2/reports';

export interface VideoStats {
  videoId: string;
  title: string;
  publishedAt: string;
  views: number;
  likes: number;
  comments: number;
  duration: string;       // ISO 8601 duration
  durationSeconds: number;
  // Analytics API fields (null if unavailable)
  retentionPct: number | null;
  estimatedMinutesWatched: number | null;
  impressions: number | null;
  ctr: number | null;
  subscribersGained: number | null;
}

export interface SearchTermData {
  term: string;
  views: number;
  impressions: number;
  ctr: number;
}

// ── YouTube Data API v3 ──────────────────────────────────────────────

/**
 * Get stats for a single video by ID using YouTube Data API v3.
 */
export async function getVideoStats(videoId: string): Promise<VideoStats | null> {
  const apiKey = config.youtube?.apiKey;
  if (!apiKey) return null;

  try {
    const params = new URLSearchParams({
      part: 'snippet,statistics,contentDetails',
      id: videoId,
      key: apiKey,
    });

    const resp = await fetch(`${YT_DATA_BASE}/videos?${params}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      logger.warn({ status: resp.status, videoId }, 'YouTube Data API failed');
      return null;
    }

    const data = await resp.json() as any;
    const item = data.items?.[0];
    if (!item) return null;

    const duration = item.contentDetails?.duration || 'PT0S';
    const durationSeconds = parseDuration(duration);

    return {
      videoId,
      title: item.snippet?.title || '',
      publishedAt: item.snippet?.publishedAt || '',
      views: parseInt(item.statistics?.viewCount || '0', 10),
      likes: parseInt(item.statistics?.likeCount || '0', 10),
      comments: parseInt(item.statistics?.commentCount || '0', 10),
      duration,
      durationSeconds,
      retentionPct: null,       // Needs Analytics API
      estimatedMinutesWatched: null,
      impressions: null,
      ctr: null,
      subscribersGained: null,
    };
  } catch (err) {
    logger.warn({ err, videoId }, 'Failed to fetch video stats');
    return null;
  }
}

/**
 * Get recent uploads from a channel with stats.
 */
export async function getRecentVideoStats(
  channelId: string,
  days = 7,
  maxResults = 10,
): Promise<VideoStats[]> {
  const apiKey = config.youtube?.apiKey;
  if (!apiKey || !channelId) return [];

  try {
    // Get uploads playlist
    const chResp = await fetch(`${YT_DATA_BASE}/channels?${new URLSearchParams({
      part: 'contentDetails',
      id: channelId,
      key: apiKey,
    })}`, { signal: AbortSignal.timeout(10_000) });
    if (!chResp.ok) return [];

    const chData = await chResp.json() as any;
    const uploadsPlaylist = chData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsPlaylist) return [];

    // Get recent videos
    const plResp = await fetch(`${YT_DATA_BASE}/playlistItems?${new URLSearchParams({
      part: 'snippet',
      playlistId: uploadsPlaylist,
      maxResults: String(maxResults),
      key: apiKey,
    })}`, { signal: AbortSignal.timeout(10_000) });
    if (!plResp.ok) return [];

    const plData = await plResp.json() as any;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const videoIds = (plData.items || [])
      .filter((item: any) => new Date(item.snippet?.publishedAt) > cutoff)
      .map((item: any) => item.snippet?.resourceId?.videoId)
      .filter(Boolean);

    if (videoIds.length === 0) return [];

    // Batch fetch stats
    const statsResp = await fetch(`${YT_DATA_BASE}/videos?${new URLSearchParams({
      part: 'snippet,statistics,contentDetails',
      id: videoIds.join(','),
      key: apiKey,
    })}`, { signal: AbortSignal.timeout(10_000) });
    if (!statsResp.ok) return [];

    const statsData = await statsResp.json() as any;
    return (statsData.items || []).map((item: any) => {
      const duration = item.contentDetails?.duration || 'PT0S';
      return {
        videoId: item.id,
        title: item.snippet?.title || '',
        publishedAt: item.snippet?.publishedAt || '',
        views: parseInt(item.statistics?.viewCount || '0', 10),
        likes: parseInt(item.statistics?.likeCount || '0', 10),
        comments: parseInt(item.statistics?.commentCount || '0', 10),
        duration,
        durationSeconds: parseDuration(duration),
        retentionPct: null,
        estimatedMinutesWatched: null,
        impressions: null,
        ctr: null,
        subscribersGained: null,
      };
    });
  } catch (err) {
    logger.warn({ err, channelId }, 'Failed to fetch recent video stats');
    return [];
  }
}

/**
 * Check keyword ranking — where does your video appear in YouTube search?
 */
export async function checkKeywordRanking(
  keyword: string,
  channelId: string,
): Promise<{ position: number | null; topCompetitor: string | null }> {
  const apiKey = config.youtube?.apiKey;
  if (!apiKey || !channelId) return { position: null, topCompetitor: null };

  try {
    const params = new URLSearchParams({
      part: 'snippet',
      q: keyword,
      type: 'video',
      maxResults: '20',
      relevanceLanguage: 'pt',
      regionCode: 'BR',
      key: apiKey,
    });

    const resp = await fetch(`${YT_DATA_BASE}/search?${params}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return { position: null, topCompetitor: null };

    const data = await resp.json() as any;
    const items = data.items || [];

    let position: number | null = null;
    let topCompetitor: string | null = null;

    for (let i = 0; i < items.length; i++) {
      if (items[i].snippet?.channelId === channelId) {
        position = i + 1;
        break;
      }
    }

    // First non-own result is top competitor
    const comp = items.find((item: any) => item.snippet?.channelId !== channelId);
    if (comp) topCompetitor = comp.snippet?.channelTitle || null;

    return { position, topCompetitor };
  } catch (err) {
    logger.warn({ err, keyword }, 'Failed to check keyword ranking');
    return { position: null, topCompetitor: null };
  }
}

/**
 * Extract video ID from various YouTube URL formats.
 */
export function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /shorts\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

// ── Helpers ──────────────────────────────────────────────────────────

function parseDuration(iso: string): number {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  return (parseInt(match[1] || '0') * 3600) +
         (parseInt(match[2] || '0') * 60) +
         (parseInt(match[3] || '0'));
}
