/**
 * Performance Intelligence Agent — analyzes Felipe's YouTube channel
 * performance to identify what works and feed back into content creation.
 *
 * Schedule: Weekly, Sunday 06:00 (after channel relearn at 03:00)
 *
 * Consumes: channel_dna, book_knowledge
 * Produces: hook_effectiveness, pillar_performance, retention_pattern, book_reference_effective
 *
 * NOTE: Currently uses YouTube Data API v3 (public stats only).
 * YouTube Analytics API (retention curves, traffic sources) requires separate OAuth setup.
 * Agent gracefully degrades without it.
 */

import { writeSignal, readSignals, logAgentRun } from '../services/intelligence-bus';
import { getDb } from '../services/database';
import { config } from '../config';
import { logger } from '../utils/logger';

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

async function fetchOwnChannelVideos(maxResults = 30): Promise<VideoStats[]> {
  const apiKey = config.youtube?.apiKey;
  const channelId = config.youtube?.channelId;

  if (!apiKey || !channelId) {
    logger.warn('Performance Agent: YOUTUBE_API_KEY or YOUTUBE_CHANNEL_ID not set. Skipping.');
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
    politics: ['política', 'governo', 'lula', 'estado', 'imposto', 'esquerda', 'direita', 'liberal'],
    economics: ['economia', 'inflação', 'dólar', 'mercado', 'juros', 'banco', 'investimento'],
    fitness: ['treino', 'corrida', 'musculação', 'dieta', 'academia', 'atleta', 'gym'],
    faith: ['cristão', 'deus', 'fé', 'família', 'igreja', 'bíblia', 'valores'],
    selfdev: ['disciplina', 'hábito', 'produtividade', 'mentalidade', 'sucesso', 'foco'],
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
  let signalsProduced = 0;
  let signalsConsumed = 0;

  try {
    if (!config.youtube?.channelId) {
      logger.warn('Performance Agent needs YOUTUBE_CHANNEL_ID in .env. Skipping.');
      logAgentRun('performance-agent', 'skipped', 0, 0, Date.now() - start, 'YOUTUBE_CHANNEL_ID not set');
      return;
    }

    // Fetch Felipe's recent videos
    const videos = await fetchOwnChannelVideos(30);
    if (videos.length === 0) {
      logger.warn('Performance Agent: No videos found. Channel may be new or API issue.');
      logAgentRun('performance-agent', 'skipped', 0, 0, Date.now() - start, 'No videos found');
      return;
    }

    // Consume reference data from bus
    const dnaSignals = readSignals('performance-agent', ['channel_dna'], 50);
    const bookSignals = readSignals('performance-agent', ['book_knowledge'], 20);
    signalsConsumed += dnaSignals.length + bookSignals.length;

    // Analysis 1: Pillar Performance
    const pillarRankings = analyzePillarPerformance(videos);
    if (pillarRankings.length > 0) {
      writeSignal({
        source_agent: 'performance-agent',
        signal_type: 'pillar_performance',
        payload: {
          rankings: pillarRankings,
          period: '30d',
          total_videos: videos.length,
          analyzed_at: new Date().toISOString(),
        },
      });
      signalsProduced++;
    }

    // Analysis 2: Optimal Duration
    const durationAnalysis = analyzeOptimalDuration(videos);
    if (durationAnalysis.length > 0) {
      writeSignal({
        source_agent: 'performance-agent',
        signal_type: 'retention_pattern',
        payload: {
          finding: 'optimal_duration',
          data: durationAnalysis,
          recommendation: durationAnalysis[0]
            ? `Best performing duration: ${durationAnalysis[0].range} (avg ${durationAnalysis[0].avg_views} views)`
            : 'Not enough data',
          confidence: Math.min(0.9, videos.length / 30),
          sample_size: videos.length,
        },
      });
      signalsProduced++;
    }

    // Analysis 3: Top/Bottom performers for pattern learning
    const sorted = [...videos].sort((a, b) => b.viewCount - a.viewCount);
    const top3 = sorted.slice(0, 3);
    const bottom3 = sorted.slice(-3);

    if (top3.length > 0) {
      writeSignal({
        source_agent: 'performance-agent',
        signal_type: 'hook_effectiveness',
        payload: {
          finding: 'top_bottom_comparison',
          top_performers: top3.map(v => ({
            title: v.title,
            views: v.viewCount,
            pillar: v.pillar,
            engagement: v.viewCount > 0 ? Math.round((v.likeCount + v.commentCount) / v.viewCount * 1000) / 10 : 0,
          })),
          bottom_performers: bottom3.map(v => ({
            title: v.title,
            views: v.viewCount,
            pillar: v.pillar,
            engagement: v.viewCount > 0 ? Math.round((v.likeCount + v.commentCount) / v.viewCount * 1000) / 10 : 0,
          })),
          recommendation: `Top content: ${top3.map(v => v.pillar).join(', ')}. Consider more content in these pillars.`,
          confidence: 0.7,
          sample_size: videos.length,
        },
      });
      signalsProduced++;
    }

    // Analysis 4: Posting day effectiveness
    const byDay = new Map<number, number[]>();
    for (const v of videos) {
      const day = new Date(v.publishedAt).getDay();
      const existing = byDay.get(day) || [];
      existing.push(v.viewCount);
      byDay.set(day, existing);
    }
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dayPerformance = [...byDay.entries()]
      .map(([day, views]) => ({
        day: dayNames[day],
        avg_views: Math.round(views.reduce((a, b) => a + b, 0) / views.length),
        count: views.length,
      }))
      .sort((a, b) => b.avg_views - a.avg_views);

    if (dayPerformance.length > 0) {
      writeSignal({
        source_agent: 'performance-agent',
        signal_type: 'retention_pattern',
        payload: {
          finding: 'optimal_posting_day',
          data: dayPerformance,
          recommendation: `Best posting day: ${dayPerformance[0].day} (avg ${dayPerformance[0].avg_views} views)`,
          confidence: Math.min(0.8, videos.length / 20),
          sample_size: videos.length,
        },
      });
      signalsProduced++;
    }

    const summary = `Performance: ${videos.length} videos analyzed. ${pillarRankings.length} pillars ranked. Best: ${pillarRankings[0]?.pillar || 'N/A'} (${pillarRankings[0]?.avg_views || 0} avg views).`;
    logAgentRun('performance-agent', 'success', signalsProduced, signalsConsumed, Date.now() - start);
    logger.info(summary);
  } catch (err: any) {
    logAgentRun('performance-agent', 'error', signalsProduced, signalsConsumed, Date.now() - start, err.message);
    logger.error({ err }, 'Performance Agent failed');
    throw err;
  }
}
