// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Semantic deduplication for content ideas.
 * Uses Claude Haiku to detect topically similar ideas across all sources.
 */

import { config } from '../config';
import { getDb } from './database';
import { logger } from '../utils/logger';

interface DedupResult {
  isDuplicate: boolean;
  similarTo: string | null;
  confidence: number;
}

// ─── In-memory cache to avoid re-checking the same idea within 5 minutes ───
const dedupCache = new Map<string, { result: DedupResult; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCacheKey(idea: string, angle?: string): string {
  return `${idea.toLowerCase().trim()}|${angle ?? ''}`;
}

function getCached(key: string): DedupResult | null {
  const entry = dedupCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    dedupCache.delete(key);
    return null;
  }
  return entry.result;
}

function setCache(key: string, result: DedupResult): void {
  dedupCache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  // Evict expired entries periodically (keep cache small)
  if (dedupCache.size > 200) {
    const now = Date.now();
    for (const [k, v] of dedupCache) {
      if (now > v.expiresAt) dedupCache.delete(k);
    }
  }
}

/**
 * Fetch with exponential backoff on 429 responses.
 * Retries up to 3 times with delays of 1s, 2s, 4s.
 */
async function fetchWithBackoff(url: string, init: RequestInit, maxRetries = 3): Promise<Response> {
  let lastResp: Response | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fetch(url, init);
    if (resp.status !== 429 || attempt === maxRetries) {
      return resp;
    }
    lastResp = resp;
    const delayMs = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
    logger.warn({ attempt: attempt + 1, delayMs }, 'Dedup API rate-limited (429), backing off');
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  return lastResp!;
}

/**
 * Check if a new idea is semantically similar to recent ideas (last 14 days).
 * Two ideas about the SAME topic with DIFFERENT angles are NOT duplicates.
 */
export async function isDuplicateIdea(
  newIdea: string,
  angleTag?: string,
): Promise<DedupResult> {
  // Check in-memory cache first
  const cacheKey = getCacheKey(newIdea, angleTag);
  const cached = getCached(cacheKey);
  if (cached) {
    logger.debug({ newIdea }, 'Dedup cache hit');
    return cached;
  }

  const db = getDb();

  // Get userId from AsyncLocalStorage for per-user filtering
  let uid: number | undefined;
  try {
    const { getCurrentContext } = require('../utils/request-context');
    uid = getCurrentContext()?.userId;
  } catch { /* outside request context */ }
  const userFilter = uid != null ? 'AND user_id = ?' : '';
  const userArgs = uid != null ? [uid] : [];

  // Gather recent ideas from both tables (per-user)
  const recentSaved = db.prepare(`
    SELECT title, angle_tag FROM saved_ideas
    WHERE created_at > datetime('now', '-14 days') ${userFilter}
    ORDER BY created_at DESC LIMIT 30
  `).all(...userArgs) as { title: string; angle_tag: string | null }[];

  const recentFeedback = db.prepare(`
    SELECT topic as title, angle_tag FROM content_topic_feedback
    WHERE created_at > datetime('now', '-14 days') ${userFilter}
    ORDER BY created_at DESC LIMIT 30
  `).all(...userArgs) as { title: string; angle_tag: string | null }[];

  const existingIdeas = [...recentSaved, ...recentFeedback];

  // If fewer than 3 recent ideas, skip dedup (not enough data)
  if (existingIdeas.length < 3) {
    const result: DedupResult = { isDuplicate: false, similarTo: null, confidence: 0 };
    setCache(cacheKey, result);
    return result;
  }

  const ideasList = existingIdeas
    .map(i => `- ${i.title}${i.angle_tag ? ` [angle: ${i.angle_tag}]` : ''}`)
    .join('\n');

  const prompt = `Given these existing content ideas from the last 14 days:
${ideasList}

Is this new idea semantically similar (>80% overlap in BOTH topic AND angle) to any of them?
New idea: "${newIdea}"${angleTag ? ` [angle: ${angleTag}]` : ''}

Important: Two ideas about the SAME topic but with DIFFERENT angles are NOT duplicates.
Example: "Por que o estado é seu inimigo" (opinion) and "Reação: nova lei do governo" (reaction) are about government but have completely different angles — NOT duplicates.

Respond with JSON only: { "isDuplicate": boolean, "similarTo": string | null, "confidence": number }`;

  try {
    const resp = await fetchWithBackoff('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': config.anthropic.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: config.anthropic.classifierModel,
        max_tokens: 256,
        temperature: 0.1,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!resp.ok) {
      logger.warn('Dedup API call failed: %d', resp.status);
      return { isDuplicate: false, similarTo: null, confidence: 0 };
    }

    const data = await resp.json() as any;
    const text = data.content?.[0]?.text || '';
    const cleaned = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const result = JSON.parse(cleaned) as DedupResult;

    if (result.isDuplicate && result.confidence > 0.8) {
      logger.info({ newIdea, similarTo: result.similarTo, confidence: result.confidence }, 'Duplicate idea detected');
    }

    // Cache the result
    setCache(cacheKey, result);

    return result;
  } catch (err) {
    logger.warn({ err }, 'Dedup check failed — allowing idea through');
    return { isDuplicate: false, similarTo: null, confidence: 0 };
  }
}

/**
 * Get angle distribution from the last 30 days for diversity injection.
 */
export function getAngleDistribution(): { tag: string; count: number; pct: number }[] {
  const db = getDb();

  // Per-user filtering via AsyncLocalStorage context
  let uid: number | undefined;
  try {
    const { getCurrentContext } = require('../utils/request-context');
    uid = getCurrentContext()?.userId;
  } catch {}
  const userFilter = uid != null ? 'AND user_id = ?' : '';
  const userArgs = uid != null ? [uid] : [];

  const ANGLE_TAGS = [
    'opinion', 'reaction', 'how-to', 'story', 'myth-bust',
    'comparison', 'data', 'framework', 'listicle', 'trending-take',
  ];

  // Count from both tables (per-user)
  const savedAngles = db.prepare(`
    SELECT angle_tag, COUNT(*) as cnt FROM saved_ideas
    WHERE angle_tag IS NOT NULL AND created_at > datetime('now', '-30 days') ${userFilter}
    GROUP BY angle_tag
  `).all(...userArgs) as { angle_tag: string; cnt: number }[];

  const feedbackAngles = db.prepare(`
    SELECT angle_tag, COUNT(*) as cnt FROM content_topic_feedback
    WHERE angle_tag IS NOT NULL AND created_at > datetime('now', '-30 days') ${userFilter}
    GROUP BY angle_tag
  `).all(...userArgs) as { angle_tag: string; cnt: number }[];

  // Merge counts
  const counts = new Map<string, number>();
  for (const tag of ANGLE_TAGS) counts.set(tag, 0);
  for (const r of [...savedAngles, ...feedbackAngles]) {
    counts.set(r.angle_tag, (counts.get(r.angle_tag) || 0) + r.cnt);
  }

  const total = Array.from(counts.values()).reduce((a, b) => a + b, 0) || 1;

  return ANGLE_TAGS.map(tag => ({
    tag,
    count: counts.get(tag) || 0,
    pct: Math.round(((counts.get(tag) || 0) / total) * 100),
  }));
}

/**
 * Build the angle diversity prompt block for topic generation.
 */
export function buildAngleDiversityBlock(): string {
  const dist = getAngleDistribution();
  if (dist.every(d => d.count === 0)) return '';

  const lines = dist.map(d => {
    let label = '';
    if (d.pct >= 30) label = ' ← OVERUSED, avoid this angle';
    else if (d.count === 0) label = ' ← NEVER USED, try this';
    else if (d.pct <= 5) label = ' ← UNDERUSED, prioritize';
    return `- ${d.tag}: ${d.count} topics (${d.pct}%)${label}`;
  });

  return `
## Recent angle distribution (last 30 days)
${lines.join('\n')}

IMPORTANT: Generate topics that DIVERSIFY the angle distribution.
Do NOT generate more of angles marked OVERUSED.
Prioritize angles marked UNDERUSED or NEVER USED.

ANGLE DEFINITIONS:
- opinion: Hot take / thesis / personal stance
- reaction: Responding to external content (video, news, statement)
- how-to: Instructional / tutorial / step-by-step
- story: Personal narrative / experience
- myth-bust: Debunking common beliefs
- comparison: A vs B / debate format
- data: Data-driven argument with numbers/stats
- framework: Applying a book or intellectual framework to current events
- listicle: Numbered list format (5 things, 7 habits, etc.)
- trending-take: Timely commentary on a trending event

CONSTRAINT: In this batch, use at least 3 different angle_tags.
No more than 2 topics may share the same angle_tag.
At least 1 topic must use an angle marked UNDERUSED or NEVER USED.

For each topic candidate, include "angle_tag" in the JSON output.
`;
}
