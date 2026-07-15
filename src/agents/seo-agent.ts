// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * SEO Tracking Agent — monitors YouTube keyword rankings,
 * identifies opportunities, and tracks the authenticated creator's search visibility.
 *
 * Schedule: Weekly, Monday 06:00
 *
 * Consumes: pillar_performance, channel_dna, retention_pattern (cross-agent), hook_effectiveness (cross-agent)
 * Produces: keyword_rank_change, keyword_opportunity
 */

import { readSignals, logAgentRun } from '../services/intelligence-bus';
import { buildAgentContext } from '../services/cross-agent-learning';
import { getDb } from '../services/database';
import { config } from '../config';
import { logger } from '../utils/logger';
import { listUserScopedYoutubeChannelTargets } from '../services/youtube-channel-scope';

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

// ── Seed Keywords ────────────────────────────────────────────────────

const SEED_KEYWORDS = [
  // Setup-safe defaults only. Per-creator keywords should be added through
  // tracked SEO keywords or saved content pillars, not founder-shaped seeds.
  'ai automation tools',
  'creator economy 2026',
  'youtube growth strategy',
  'content workflow automation',
  'running strength training',
  'marathon training plan',
  'meal prep for training',
  'wellness routine',
  'productivity systems',
  'small business operations',
  'gaming creator trends',
];

// ── Types ────────────────────────────────────────────────────────────

interface KeywordRank {
  keyword: string;
  position: number | null;  // null = not found in top 20
  top_competitor: string;
  search_volume_hint: string;  // 'high' | 'medium' | 'low'
  checked_at: string;
}

interface RankChange {
  keyword: string;
  previous: number | null;
  current: number | null;
  delta: number;  // negative = improved
  direction: 'up' | 'down' | 'new' | 'lost' | 'stable';
}

// ── Core Functions ───────────────────────────────────────────────────

/**
 * Search YouTube for a keyword and find the authenticated creator's ranking position.
 */
async function checkKeywordRank(keyword: string, channelId: string): Promise<KeywordRank> {
  const apiKey = config.youtube?.apiKey;
  if (!apiKey) {
    return {
      keyword,
      position: null,
      top_competitor: '',
      search_volume_hint: 'unknown',
      checked_at: new Date().toISOString(),
    };
  }

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

    const resp = await fetch(`${YOUTUBE_API_BASE}/search?${params}`, {
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      logger.warn({ keyword, status: resp.status }, 'YouTube search API failed');
      return {
        keyword,
        position: null,
        top_competitor: '',
        search_volume_hint: 'unknown',
        checked_at: new Date().toISOString(),
      };
    }

    const data = await resp.json() as any;
    const items = data.items || [];

    let position: number | null = null;
    let topCompetitor = '';

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const itemChannelId = item.snippet?.channelId;

      // Track first competitor
      if (i === 0 && itemChannelId !== channelId) {
        topCompetitor = item.snippet?.channelTitle || '';
      }

      // Found the authenticated creator's video
      if (itemChannelId === channelId) {
        position = i + 1;
        break;
      }
    }

    // If the authenticated creator's channel is not in the results, the top result is the competitor
    if (!topCompetitor && items.length > 0) {
      topCompetitor = items[0].snippet?.channelTitle || '';
    }

    // Rough volume hint based on result count
    const totalResults = data.pageInfo?.totalResults || 0;
    const volumeHint = totalResults > 500000 ? 'high' :
                       totalResults > 50000 ? 'medium' : 'low';

    return {
      keyword,
      position,
      top_competitor: topCompetitor,
      search_volume_hint: volumeHint,
      checked_at: new Date().toISOString(),
    };
  } catch (err) {
    logger.warn({ err, keyword }, 'Keyword rank check failed');
    return {
      keyword,
      position: null,
      top_competitor: '',
      search_volume_hint: 'unknown',
      checked_at: new Date().toISOString(),
    };
  }
}

/**
 * Compare current rank against last week's stored rank.
 */
function compareRanks(keyword: string, current: number | null, previous: number | null): RankChange {
  if (previous === null && current !== null) {
    return { keyword, previous, current, delta: 0, direction: 'new' };
  }
  if (previous !== null && current === null) {
    return { keyword, previous, current, delta: 0, direction: 'lost' };
  }
  if (previous === null && current === null) {
    return { keyword, previous, current, delta: 0, direction: 'stable' };
  }

  const delta = current! - previous!;
  const direction = delta < -1 ? 'up' : delta > 1 ? 'down' : 'stable';
  return { keyword, previous, current, delta, direction };
}

/**
 * Find keyword opportunities from channel DNA signals.
 */
function findOpportunitiesFromDNA(): string[] {
  const dnaSignals = readSignals('seo-agent', ['channel_dna'], 50);
  const opportunities: string[] = [];

  for (const signal of dnaSignals) {
    const payload = signal.payload as any;
    if (payload.category === 'title_pattern' || payload.category === 'hook_style') {
      // Extract keywords from patterns
      const patterns: string[] = payload.patterns || [];
      for (const p of patterns) {
        // Extract short phrases that could be keywords
        const words = p.toLowerCase().split(/\s+/).filter(w => w.length > 3);
        if (words.length >= 2 && words.length <= 4) {
          opportunities.push(words.join(' '));
        }
      }
    }
  }

  return [...new Set(opportunities)].slice(0, 5);
}

// ── Seed Keywords on Startup ─────────────────────────────────────────

export function seedKeywordsIfEmpty(): void {
  const db = getDb();

  // Ensure table exists (migration should handle this, but be safe)
  db.exec(`
    CREATE TABLE IF NOT EXISTS seo_keywords (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword TEXT NOT NULL UNIQUE,
      current_position INTEGER,
      previous_position INTEGER,
      top_competitor TEXT DEFAULT '',
      volume_hint TEXT DEFAULT 'unknown',
      last_checked TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const count = (db.prepare('SELECT COUNT(*) as cnt FROM seo_keywords').get() as any)?.cnt ?? 0;
  if (count > 0) return;

  logger.info('Seeding SEO keywords with %d defaults', SEED_KEYWORDS.length);
  const stmt = db.prepare('INSERT OR IGNORE INTO seo_keywords (keyword) VALUES (?)');
  for (const kw of SEED_KEYWORDS) {
    stmt.run(kw);
  }
}

// ── Main Agent Runner ────────────────────────────────────────────────

export async function runSEOAgent(): Promise<void> {
  const start = Date.now();
  let signalsProduced = 0;
  let signalsConsumed = 0;

  try {
    const db = getDb();
    seedKeywordsIfEmpty();

    const channelTargets = listUserScopedYoutubeChannelTargets();
    if (channelTargets.length === 0) {
      logger.warn('SEO Agent: no user-scoped creator YouTube channel configured. Global YOUTUBE_CHANNEL_ID is intentionally ignored.');
      logAgentRun('seo-agent', 'skipped', 0, 0, Date.now() - start, 'No user-scoped creator YouTube channel configured');
      return;
    }

    // SEO keyword tables and content-mesh rank-change signals are currently
    // platform-global. Until both are user/tenant scoped, fail closed rather
    // than recording one creator's YouTube ranks where another creator can
    // read them.
    logger.warn(
      { channelTargets: channelTargets.length },
      'SEO Agent paused: user-scoped SEO rank storage/signals are not supported yet',
    );
    logAgentRun('seo-agent', 'skipped', 0, 0, Date.now() - start, 'User-scoped SEO rank storage/signals not supported yet');
    return;

    // Unreachable keyword-check/signal body removed 2026-07-03 (audit item
    // #10): the fail-closed pause above has been permanent since the
    // user-scoping decision. Recover the implementation from git history
    // when user/tenant-scoped SEO rank storage ships.
  } catch (err: any) {
    logAgentRun('seo-agent', 'error', signalsProduced, signalsConsumed, Date.now() - start, err.message);
    logger.error({ err }, 'SEO Agent failed');
    throw err;
  }
}

// ── Bot Command: /seokeyword ─────────────────────────────────────────

export async function handleAddSEOKeyword(ctx: any): Promise<void> {
  const keyword = ctx.match?.toString().trim();
  if (!keyword) {
    await ctx.reply('🔍 <b>Usage:</b> <code>/seokeyword treino híbrido</code>', { parse_mode: 'HTML' });
    return;
  }

  const db = getDb();
  seedKeywordsIfEmpty();

  const existing = db.prepare('SELECT keyword FROM seo_keywords WHERE keyword = ?').get(keyword);
  if (existing) {
    await ctx.reply(`🔍 "<b>${keyword}</b>" is already being tracked.`, { parse_mode: 'HTML' });
    return;
  }

  db.prepare('INSERT INTO seo_keywords (keyword) VALUES (?)').run(keyword);
  await ctx.reply(
    `✅ Now tracking "<b>${keyword}</b>" for YouTube SEO.\n\nRanking will be checked on next Monday 06:00 run, or use the portal to run SEO Agent now.`,
    { parse_mode: 'HTML' },
  );
}

// ── Bot Command: /seorank ────────────────────────────────────────────

export async function handleSEORank(ctx: any): Promise<void> {
  const db = getDb();
  seedKeywordsIfEmpty();

  const keywords = db.prepare(`
    SELECT keyword, current_position, previous_position, top_competitor, volume_hint, last_checked
    FROM seo_keywords
    ORDER BY
      CASE WHEN current_position IS NOT NULL THEN 0 ELSE 1 END,
      current_position ASC
  `).all() as any[];

  if (keywords.length === 0) {
    await ctx.reply('🔍 No keywords tracked. Add some with <code>/seokeyword</code>', { parse_mode: 'HTML' });
    return;
  }

  let msg = '🔍 <b>SEO Rankings</b>\n\n';

  for (const kw of keywords) {
    const pos = kw.current_position;
    const prev = kw.previous_position;

    let icon = '⬜';
    let trend = '';

    if (pos === null) {
      icon = '❌';
      trend = 'not ranked';
    } else if (pos <= 3) {
      icon = '🥇';
    } else if (pos <= 10) {
      icon = '🟢';
    } else {
      icon = '🟡';
    }

    if (prev !== null && pos !== null) {
      const delta = prev - pos;
      if (delta > 0) trend = `⬆${delta}`;
      else if (delta < 0) trend = `⬇${Math.abs(delta)}`;
      else trend = '→';
    }

    msg += `${icon} <b>${kw.keyword}</b>`;
    msg += pos ? ` — #${pos}` : ' — unranked';
    if (trend) msg += ` ${trend}`;
    if (kw.top_competitor) msg += `\n   vs ${kw.top_competitor}`;
    msg += '\n\n';
  }

  const lastChecked = keywords[0]?.last_checked;
  if (lastChecked) {
    msg += `\n<i>Last checked: ${lastChecked.slice(0, 16)}</i>`;
  }

  await ctx.reply(msg, { parse_mode: 'HTML' });
}
