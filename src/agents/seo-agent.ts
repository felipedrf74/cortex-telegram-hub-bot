// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * SEO Tracking Agent — monitors YouTube keyword rankings,
 * identifies opportunities, and tracks Felipe's search visibility.
 *
 * Schedule: Weekly, Monday 06:00
 *
 * Consumes: pillar_performance, channel_dna, retention_pattern (cross-agent), hook_effectiveness (cross-agent)
 * Produces: keyword_rank_change, keyword_opportunity
 */

import { writeSignal, readSignals, logAgentRun } from '../services/intelligence-bus';
import { buildAgentContext } from '../services/cross-agent-learning';
import { getDb } from '../services/database';
import { config } from '../config';
import { logger } from '../utils/logger';

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

// ── Seed Keywords ────────────────────────────────────────────────────

const SEED_KEYWORDS = [
  // Fitness
  'treino híbrido', 'atleta híbrido', 'corrida e musculação',
  'treino de força corrida', 'dieta para treino',
  // Politics / Economics
  'economia austríaca', 'livre mercado brasil', 'estado é o problema',
  'liberalismo brasil', 'impostos brasil',
  // Self-development
  'disciplina masculina', 'desenvolvimento pessoal homem',
  'mentalidade vencedora',
  // Faith
  'fé e disciplina', 'valores cristãos homem',
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
 * Search YouTube for a keyword and find Felipe's ranking position.
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

      // Found Felipe's video
      if (itemChannelId === channelId) {
        position = i + 1;
        break;
      }
    }

    // If Felipe's not in the results, the top result is the competitor
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

    // Get Felipe's channel ID (from reference channels or config)
    const felipeChannelId = config.youtube?.channelId || '';
    if (!felipeChannelId) {
      logger.warn('SEO Agent: No YouTube channel ID configured (YOUTUBE_CHANNEL_ID). Skipping rank checks.');
    }

    // Get all tracked keywords
    const keywords = db.prepare('SELECT * FROM seo_keywords').all() as any[];

    const changes: RankChange[] = [];
    const opportunities: { keyword: string; reason: string }[] = [];

    // Check ranks for each keyword (with 2s delay between to avoid rate limits)
    for (let i = 0; i < keywords.length; i++) {
      const kw = keywords[i];
      const rank = await checkKeywordRank(kw.keyword, felipeChannelId);

      // Store previous and update current
      db.prepare(`
        UPDATE seo_keywords SET
          previous_position = current_position,
          current_position = ?,
          top_competitor = ?,
          volume_hint = ?,
          last_checked = ?
        WHERE id = ?
      `).run(
        rank.position,
        rank.top_competitor,
        rank.search_volume_hint,
        rank.checked_at,
        kw.id,
      );

      const change = compareRanks(kw.keyword, rank.position, kw.current_position);
      changes.push(change);

      // Write signal for significant changes
      if (change.direction === 'up' || change.direction === 'down' || change.direction === 'lost') {
        writeSignal({
          source_agent: 'seo-agent',
          signal_type: 'keyword_rank_change',
          payload: {
            keyword: change.keyword,
            previous_position: change.previous,
            current_position: change.current,
            direction: change.direction,
            delta: change.delta,
            top_competitor: rank.top_competitor,
            volume_hint: rank.search_volume_hint,
          },
          priority: change.direction === 'lost' ? 'urgent' : 'normal',
        });
        signalsProduced++;
      }

      // Rate limit: 2s between API calls
      if (i < keywords.length - 1) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    // Cross-agent learning: consume peer signals (retention, hooks, formulas)
    const peerContext = buildAgentContext('seo-agent');
    signalsConsumed += peerContext.signalsConsumed;

    // Use retention insights to prioritize keywords that retain viewers
    for (const ri of peerContext.retentionInsights) {
      if (ri.avgRetention > 0.6 && ri.pattern) {
        opportunities.push({
          keyword: ri.pattern,
          reason: `High retention pattern (${(ri.avgRetention * 100).toFixed(0)}%) — optimize for this`,
        });
      }
    }

    // Consume pillar_performance signals for opportunity identification
    const pillarSignals = readSignals('seo-agent', ['pillar_performance'], 5);
    signalsConsumed += pillarSignals.length;

    // Find high-performing pillars to suggest keyword expansion
    for (const signal of pillarSignals) {
      const rankings = (signal.payload as any)?.rankings || [];
      for (const r of rankings) {
        if (r.trend === 'rising') {
          opportunities.push({
            keyword: `${r.pillar} brasil 2026`,
            reason: `Pillar "${r.pillar}" is trending up — expand keyword coverage`,
          });
        }
      }
    }

    // Find opportunities from channel DNA
    const dnaKeywords = findOpportunitiesFromDNA();
    for (const kw of dnaKeywords) {
      const existing = db.prepare('SELECT 1 FROM seo_keywords WHERE keyword = ?').get(kw);
      if (!existing) {
        opportunities.push({
          keyword: kw,
          reason: 'Extracted from reference channel patterns',
        });
      }
    }

    // Write keyword opportunity signals
    for (const opp of opportunities.slice(0, 5)) {
      writeSignal({
        source_agent: 'seo-agent',
        signal_type: 'keyword_opportunity',
        payload: opp,
        priority: 'normal',
      });
      signalsProduced++;
    }

    // Summary
    const improved = changes.filter(c => c.direction === 'up').length;
    const declined = changes.filter(c => c.direction === 'down').length;
    const lost = changes.filter(c => c.direction === 'lost').length;
    const newRanks = changes.filter(c => c.direction === 'new').length;

    const summary = `SEO: ${keywords.length} keywords checked. ⬆${improved} improved, ⬇${declined} declined, ❌${lost} lost, ✨${newRanks} new rankings. ${opportunities.length} opportunities found.`;

    logAgentRun('seo-agent', 'success', signalsProduced, signalsConsumed, Date.now() - start);
    logger.info({ improved, declined, lost, newRanks, opportunities: opportunities.length }, summary);
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
