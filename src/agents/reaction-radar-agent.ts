// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Reaction Radar Agent — monitors reference channels for new uploads
 * and YouTube trending for reaction-worthy content.
 *
 * Schedule: Every 4 hours (06:00, 10:00, 14:00, 18:00, 22:00)
 *
 * Consumes: channel_dna, book_knowledge, pillar_performance
 * Produces: trending_spike, competitor_upload
 */

import { writeSignal, readSignals, logAgentRun } from '../services/intelligence-bus';
import { getDb } from '../services/database';
import { config } from '../config';
import { logger } from '../utils/logger';

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

// Content pillars for trending detection
const PILLAR_KEYWORDS: Record<string, string[]> = {
  politics: ['política', 'governo', 'lula', 'bolsonaro', 'esquerda', 'direita', 'estado', 'imposto', 'congresso', 'stf', 'regulação', 'censura', 'liberdade'],
  economics: ['economia', 'inflação', 'dólar', 'real', 'mercado', 'juros', 'selic', 'pib', 'recessão', 'investimento', 'cripto', 'bitcoin', 'banco central'],
  fitness: ['treino', 'musculação', 'corrida', 'maratona', 'dieta', 'suplemento', 'academia', 'crossfit', 'hipertrofia', 'atleta'],
  faith: ['cristão', 'igreja', 'bíblia', 'fé', 'deus', 'família', 'valores', 'casamento', 'masculinidade'],
  selfdev: ['disciplina', 'hábito', 'produtividade', 'mentalidade', 'sucesso', 'foco', 'propósito', 'estoicismo'],
  geopolitics: ['guerra', 'china', 'eua', 'trump', 'brics', 'otan', 'israel', 'irã', 'ucrânia', 'rússia', 'petróleo'],
};

// ── Types ────────────────────────────────────────────────────────────

interface VideoFinding {
  title: string;
  url: string;
  channelTitle: string;
  channelId: string;
  publishedAt: string;
  viewCount: number;
  pillar: string;
  source: 'reference_channel' | 'trending' | 'search';
}

interface ReactionScores {
  audience_trigger: number;   // 0-10
  controversy: number;        // 0-10
  timeliness: number;         // 0-10
  visual_reactability: number;// 0-10
  pillar_alignment: number;   // 0-10
}

interface ScoredFinding extends VideoFinding {
  reactionScore: number;
  scores: ReactionScores;
  totalScore: number;         // sum of all scores (0-50)
  suggestedAngle: string;
  keyQuoteOrClip: string;
  counterPosition: string;
  bookReference: { book: string; framework: string } | null;
  reactionWindowHours: number;
}

// ── YouTube API Helpers ──────────────────────────────────────────────

async function fetchChannelUploads(channelId: string, maxResults = 5): Promise<VideoFinding[]> {
  const apiKey = config.youtube?.apiKey;
  if (!apiKey) return [];

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

    // Get recent videos
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

    return (plData.items || []).map((item: any) => ({
      title: item.snippet?.title || '',
      url: `https://www.youtube.com/watch?v=${item.snippet?.resourceId?.videoId}`,
      channelTitle: item.snippet?.channelTitle || '',
      channelId,
      publishedAt: item.snippet?.publishedAt || '',
      viewCount: 0, // Not available from playlist endpoint
      pillar: detectPillar(item.snippet?.title || ''),
      source: 'reference_channel' as const,
    }));
  } catch (err) {
    logger.warn({ err, channelId }, 'Failed to fetch channel uploads');
    return [];
  }
}

async function fetchTrendingVideos(): Promise<VideoFinding[]> {
  const apiKey = config.youtube?.apiKey;
  if (!apiKey) return [];

  try {
    const params = new URLSearchParams({
      part: 'snippet,statistics',
      chart: 'mostPopular',
      regionCode: 'BR',
      maxResults: '25',
      key: apiKey,
    });
    const resp = await fetch(`${YOUTUBE_API_BASE}/videos?${params}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return [];
    const data = await resp.json() as any;

    return (data.items || [])
      .map((item: any) => ({
        title: item.snippet?.title || '',
        url: `https://www.youtube.com/watch?v=${item.id}`,
        channelTitle: item.snippet?.channelTitle || '',
        channelId: item.snippet?.channelId || '',
        publishedAt: item.snippet?.publishedAt || '',
        viewCount: parseInt(item.statistics?.viewCount || '0', 10),
        pillar: detectPillar(item.snippet?.title || ''),
        source: 'trending' as const,
      }))
      .filter((v: VideoFinding) => v.pillar !== 'none');
  } catch (err) {
    logger.warn({ err }, 'Failed to fetch trending videos');
    return [];
  }
}

async function searchPillarVideos(query: string): Promise<VideoFinding[]> {
  const apiKey = config.youtube?.apiKey;
  if (!apiKey) return [];

  try {
    const params = new URLSearchParams({
      part: 'snippet',
      q: query,
      type: 'video',
      order: 'date',
      publishedAfter: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      regionCode: 'BR',
      relevanceLanguage: 'pt',
      maxResults: '10',
      key: apiKey,
    });
    const resp = await fetch(`${YOUTUBE_API_BASE}/search?${params}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return [];
    const data = await resp.json() as any;

    return (data.items || []).map((item: any) => ({
      title: item.snippet?.title || '',
      url: `https://www.youtube.com/watch?v=${item.id?.videoId}`,
      channelTitle: item.snippet?.channelTitle || '',
      channelId: item.snippet?.channelId || '',
      publishedAt: item.snippet?.publishedAt || '',
      viewCount: 0,
      pillar: detectPillar(item.snippet?.title || ''),
      source: 'search' as const,
    }));
  } catch (err) {
    logger.warn({ err, query }, 'Failed to search pillar videos');
    return [];
  }
}

// ── Scoring ──────────────────────────────────────────────────────────

function detectPillar(title: string): string {
  const lower = title.toLowerCase();
  let bestPillar = 'none';
  let bestScore = 0;

  for (const [pillar, keywords] of Object.entries(PILLAR_KEYWORDS)) {
    const score = keywords.filter(kw => lower.includes(kw)).length;
    if (score > bestScore) {
      bestScore = score;
      bestPillar = pillar;
    }
  }

  return bestPillar;
}

/**
 * 5-Dimension Reaction Scoring Rubric.
 * Each dimension 0-10. Minimum total 25/50 to qualify.
 */
function scoreReactionPotential(
  video: VideoFinding,
  bookFrameworks: Map<string, { book: string; framework: string }[]>,
  pillarRankings: Map<string, number>,
): ScoredFinding {
  const lowerTitle = video.title.toLowerCase();
  const hoursAge = (Date.now() - new Date(video.publishedAt).getTime()) / (1000 * 60 * 60);

  // 1. Audience Trigger (0-10): How strongly will this trigger Brazilian men 18-35?
  let audienceTrigger = 0;
  const triggerKeywords = ['homem', 'masculin', 'treino', 'disciplina', 'luta', 'trabalho',
    'preguiça', 'fracass', 'sucesso', 'liberdade', 'imposto', 'governo',
    'família', 'pai', 'cristão', 'dieta', 'academia', 'corrida'];
  const triggerHits = triggerKeywords.filter(k => lowerTitle.includes(k)).length;
  audienceTrigger = Math.min(10, triggerHits * 3 + (video.pillar !== 'none' ? 3 : 0));
  // Opposition to values = strong trigger
  const leftKeywords = ['socialismo', 'igualdade', 'cotas', 'regulação', 'estado social',
    'imposto justo', 'sus funciona', 'feminism', 'aborto', 'desarm'];
  if (leftKeywords.some(k => lowerTitle.includes(k))) audienceTrigger = Math.min(10, audienceTrigger + 4);

  // 2. Controversy Potential (0-10): How polarizing?
  let controversy = 0;
  const controversyKeywords = ['polêmica', 'chocante', 'proibido', 'censurado', 'mentira',
    'destruiu', 'acabou', 'urgente', 'bomba', 'escândalo', 'absurdo',
    'vergonha', 'verdade', 'ninguém fala', 'lacrou', 'cancelado'];
  controversy = Math.min(10, controversyKeywords.filter(k => lowerTitle.includes(k)).length * 3);
  if (leftKeywords.some(k => lowerTitle.includes(k))) controversy = Math.min(10, controversy + 3);
  if (video.viewCount > 500000) controversy = Math.min(10, controversy + 2); // viral = controversial

  // 3. Timeliness (0-10): How fresh?
  let timeliness = 0;
  if (hoursAge < 6) timeliness = 10;
  else if (hoursAge < 12) timeliness = 9;
  else if (hoursAge < 24) timeliness = 7;
  else if (hoursAge < 48) timeliness = 5;
  else if (hoursAge < 72) timeliness = 3;
  else timeliness = 1;

  // 4. Visual Reactability (0-10): Can you react on camera?
  let visualReactability = 5; // base — videos are always reactable
  if (video.source === 'reference_channel' || video.source === 'trending') visualReactability = 8;
  if (video.viewCount > 100000) visualReactability = Math.min(10, visualReactability + 2); // proven clip

  // 5. Pillar Alignment (0-10): Maps to content pillars?
  let pillarAlignment = 0;
  if (video.pillar !== 'none') {
    pillarAlignment = 5;
    if (pillarRankings.has(video.pillar)) pillarAlignment += 2;
    // Multi-pillar bonus (title touches multiple pillars)
    const pillarHits = Object.entries(PILLAR_KEYWORDS)
      .filter(([_, kws]) => kws.some(k => lowerTitle.includes(k))).length;
    if (pillarHits >= 2) pillarAlignment = 10;
    else if (pillarHits === 1) pillarAlignment = Math.min(10, pillarAlignment + 2);
  }

  const scores: ReactionScores = {
    audience_trigger: audienceTrigger,
    controversy,
    timeliness,
    visual_reactability: visualReactability,
    pillar_alignment: pillarAlignment,
  };
  const totalScore = audienceTrigger + controversy + timeliness + visualReactability + pillarAlignment;

  // Build suggested angle
  let suggestedAngle = '';
  let counterPosition = '';
  let keyQuoteOrClip = `Video: "${video.title}" by ${video.channelTitle}`;
  let bookReference: { book: string; framework: string } | null = null;

  if (leftKeywords.some(k => lowerTitle.includes(k))) {
    suggestedAngle = 'Disagree — counter with free market / libertarian arguments';
    counterPosition = 'Expose the statist logic and present the freedom-based alternative';
  } else if (video.source === 'reference_channel') {
    suggestedAngle = `React/respond to ${video.channelTitle}'s take`;
    counterPosition = `Agree, disagree, or add Felipe's unique perspective`;
  } else {
    suggestedAngle = `React to "${video.title.slice(0, 50)}" — ${video.pillar} angle`;
    counterPosition = 'Take a contrarian or deeper-analysis stance';
  }

  // Book framework match
  const pillarBooks = bookFrameworks.get(video.pillar) || [];
  if (pillarBooks.length > 0) {
    bookReference = pillarBooks[0];
    suggestedAngle += ` (use ${bookReference.book}'s "${bookReference.framework}" framework)`;
  }

  const reactionWindow = hoursAge < 12 ? 12 : hoursAge < 24 ? 24 : 48;

  return {
    ...video,
    reactionScore: Math.min(1, totalScore / 50),
    scores,
    totalScore,
    suggestedAngle,
    keyQuoteOrClip,
    counterPosition,
    bookReference,
    reactionWindowHours: reactionWindow,
  };
}

// ── Main Agent Runner ────────────────────────────────────────────────

export async function runReactionRadar(): Promise<void> {
  const start = Date.now();
  let signalsProduced = 0;
  let signalsConsumed = 0;

  try {
    const db = getDb();

    // Read existing signals for context
    const dnaSignals = readSignals('reaction-radar', ['channel_dna'], 50);
    const bookSignals = readSignals('reaction-radar', ['book_knowledge'], 50);
    const pillarSignals = readSignals('reaction-radar', ['pillar_performance'], 5);
    signalsConsumed += dnaSignals.length + bookSignals.length + pillarSignals.length;

    // Build book framework lookup by pillar
    const bookFrameworks = new Map<string, { book: string; framework: string }[]>();
    for (const sig of bookSignals) {
      const p = sig.payload as any;
      const pillars: string[] = p.pillar_mapping || [];
      for (const pillar of pillars) {
        const existing = bookFrameworks.get(pillar) || [];
        const frameworks: any[] = p.key_frameworks || [];
        for (const fw of frameworks) {
          existing.push({ book: p.title || '', framework: fw.name || '' });
        }
        bookFrameworks.set(pillar, existing);
      }
    }

    // Build pillar performance rankings
    const pillarRankings = new Map<string, number>();
    for (const sig of pillarSignals) {
      const rankings = (sig.payload as any)?.rankings || [];
      for (const r of rankings) {
        pillarRankings.set(r.pillar, r.avg_views || 0);
      }
    }

    // Get reference channel IDs
    const refChannels = db.prepare(
      "SELECT channel_id, channel_name FROM content_ref_channels WHERE status = 'active' AND channel_id IS NOT NULL"
    ).all() as any[];

    // Fetch data from multiple sources
    const allFindings: VideoFinding[] = [];

    // 1. Reference channel new uploads
    for (const ch of refChannels) {
      const uploads = await fetchChannelUploads(ch.channel_id, 3);
      // Filter to last 48 hours only
      const recent = uploads.filter(v => {
        const age = Date.now() - new Date(v.publishedAt).getTime();
        return age < 48 * 60 * 60 * 1000;
      });
      allFindings.push(...recent);
      await new Promise(r => setTimeout(r, 500)); // rate limit
    }

    // 2. YouTube trending (filtered by pillars)
    const trending = await fetchTrendingVideos();
    allFindings.push(...trending);

    // 3. Targeted searches for hot topics
    const hotSearches = [
      'política brasil hoje', 'economia brasil crise',
      'treino polêmica fitness', 'reagindo opinião',
    ];
    for (const query of hotSearches) {
      const results = await searchPillarVideos(query);
      allFindings.push(...results);
      await new Promise(r => setTimeout(r, 1000)); // rate limit
    }

    // Deduplicate by URL
    const seen = new Set<string>();
    const unique = allFindings.filter(v => {
      if (seen.has(v.url)) return false;
      seen.add(v.url);
      return true;
    });

    // Score all findings
    const scored = unique
      .map(v => scoreReactionPotential(v, bookFrameworks, pillarRankings))
      .sort((a, b) => b.reactionScore - a.reactionScore);

    // Check what we've already signaled (avoid duplicates)
    const existingUrls = new Set(
      (db.prepare(
        "SELECT json_extract(payload, '$.source_url') as url FROM agent_signals WHERE signal_type = 'reaction_opportunity' AND status = 'active'"
      ).all() as any[]).map(r => r.url)
    );

    // Write signals for top findings (minimum total score: 25/50)
    let alertsSent = 0;
    for (const finding of scored) {
      if (finding.totalScore < 25) break; // Minimum 25/50 to qualify
      if (existingUrls.has(finding.url)) continue;

      const priority = finding.totalScore >= 40 ? 'urgent' : 'normal';

      writeSignal({
        source_agent: 'reaction-radar',
        signal_type: 'reaction_opportunity',
        payload: {
          title: finding.title,
          source_url: finding.url,
          source_type: 'video',
          channel: finding.channelTitle,
          source_origin: finding.source,
          scores: finding.scores,
          total_score: finding.totalScore,
          reaction_angle: finding.suggestedAngle,
          key_quote_or_clip: finding.keyQuoteOrClip,
          your_counter_position: finding.counterPosition,
          book_reference: finding.bookReference,
          pillar: finding.pillar,
          reaction_window_hours: finding.reactionWindowHours,
          views: finding.viewCount,
        },
        priority,
      });
      signalsProduced++;
      alertsSent++;

      if (alertsSent >= 5) break; // Max 5 signals per run
    }

    const summary = `Radar: scanned ${unique.length} videos from ${refChannels.length} channels + trending + search. ${alertsSent} reaction opportunities found (threshold ≥0.5).`;
    logAgentRun('reaction-radar', 'success', signalsProduced, signalsConsumed, Date.now() - start);
    logger.info({ scanned: unique.length, alerts: alertsSent }, summary);
  } catch (err: any) {
    logAgentRun('reaction-radar', 'error', signalsProduced, signalsConsumed, Date.now() - start, err.message);
    logger.error({ err }, 'Reaction Radar failed');
    throw err;
  }
}
