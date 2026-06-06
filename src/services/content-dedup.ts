// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Semantic deduplication for content ideas.
 * Uses the live provider-routing one-shot cascade to detect topically
 * similar ideas across scoped content sources.
 */

import { config } from '../config';
import { getDb } from './database';
import { completeOneShotWithFallback } from './gemini-provider';
import { trackedCreate } from '../portal/anthropic-hook';
import { logger } from '../utils/logger';
import { createLazyAnthropicClient } from './anthropic-lazy-client';
import {
  contentScopeParams,
  contentScopePredicate,
  ensureContentTenantScopeColumns,
} from './content-tenant-scope';
import { requireTenantIdParam } from './tenant-scope';

interface DedupResult {
  isDuplicate: boolean;
  similarTo: string | null;
  confidence: number;
}

// ─── In-memory cache to avoid re-checking the same idea within 5 minutes ───
const dedupCache = new Map<string, { result: DedupResult; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const anthropicClient = createLazyAnthropicClient();

function getCacheKey(idea: string, angle?: string, userId?: number, tenantId?: number): string {
  return `t:${tenantId ?? 'global'}|u:${userId ?? 'global'}|${idea.toLowerCase().trim()}|${angle ?? ''}`;
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

function resolveRequiredContentDedupScope(
  userId?: number,
  tenantId?: number,
): { userId: number; tenantId: number } {
  let uid = userId;
  if (uid == null) {
    try {
      const { getCurrentContext } = require('../utils/request-context');
      uid = getCurrentContext()?.userId;
    } catch { /* outside request context */ }
  }
  if (!Number.isFinite(uid) || Number(uid) <= 0) {
    throw new Error('Content dedup requires authenticated user scope');
  }
  const resolvedUserId = Number(uid);
  return {
    userId: resolvedUserId,
    tenantId: requireTenantIdParam(tenantId, 'contentDedup'),
  };
}

/**
 * Check if a new idea is semantically similar to recent ideas (last 14 days).
 * Two ideas about the SAME topic with DIFFERENT angles are NOT duplicates.
 */
export async function isDuplicateIdea(
  newIdea: string,
  angleTag?: string,
  userId?: number,
  tenantId?: number,
): Promise<DedupResult> {
  const db = getDb();
  ensureContentTenantScopeColumns(db);

  const scope = resolveRequiredContentDedupScope(userId, tenantId);
  const uid = scope.userId;
  const tid = scope.tenantId;

  // Check in-memory cache after resolving scope. Duplicate decisions depend
  // on the user's prior content, so the cache key must never be global by
  // accident when user scope is available.
  const cacheKey = getCacheKey(newIdea, angleTag, uid, tid);
  const cached = getCached(cacheKey);
  if (cached) {
    logger.debug({ newIdea, userId: uid, tenantId: tid }, 'Dedup cache hit');
    return cached;
  }

  const scopeFilter = `AND ${contentScopePredicate()}`;
  const scopeArgs = contentScopeParams(uid, tid);

  // Gather recent ideas from both tables (per-user)
  const recentSaved = db.prepare(`
    SELECT title, angle_tag FROM saved_ideas
    WHERE created_at > datetime('now', '-14 days') ${scopeFilter}
    ORDER BY created_at DESC LIMIT 30
  `).all(...scopeArgs) as { title: string; angle_tag: string | null }[];

  const recentFeedback = db.prepare(`
    SELECT topic as title, angle_tag FROM content_topic_feedback
    WHERE created_at > datetime('now', '-14 days') ${scopeFilter}
    ORDER BY created_at DESC LIMIT 30
  `).all(...scopeArgs) as { title: string; angle_tag: string | null }[];

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

  const systemPrompt = `You are a strict semantic duplicate detector for a creator's scoped content archive.
Return compact JSON only: { "isDuplicate": boolean, "similarTo": string | null, "confidence": number }.
Do not infer from any content outside the supplied scoped idea list.`;

  const prompt = `Given these existing content ideas from the last 14 days:
${ideasList}

Is this new idea semantically similar (>80% overlap in BOTH topic AND angle) to any of them?
New idea: "${newIdea}"${angleTag ? ` [angle: ${angleTag}]` : ''}

Important: Two ideas about the SAME topic but with DIFFERENT angles are NOT duplicates.
Example: "Por que o estado é seu inimigo" (opinion) and "Reação: nova lei do governo" (reaction) are about government but have completely different angles — NOT duplicates.

Respond with JSON only: { "isDuplicate": boolean, "similarTo": string | null, "confidence": number }`;

  try {
    const { text, provider } = await completeOneShotWithFallback(
      systemPrompt,
      prompt,
      'content_dedup',
      async () => {
        const response = await trackedCreate(anthropicClient.get(), {
          model: config.anthropic.classifierModel,
          max_tokens: 256,
          temperature: 0.1,
          system: systemPrompt,
          messages: [{ role: 'user', content: prompt }],
        }, 'content_dedup', { userId: uid, tenantId: tid });
        return response.content
          .filter((block: any) => block.type === 'text')
          .map((block: any) => block.text)
          .join('\n');
      },
      {
        maxTokens: 256,
        temperature: 0.1,
        jsonMode: true,
        userId: uid,
        tenantId: tid,
      },
    );
    const cleaned = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const result = JSON.parse(cleaned) as DedupResult;

    if (result.isDuplicate && result.confidence > 0.8) {
      logger.info(
        { newIdea, similarTo: result.similarTo, confidence: result.confidence, provider, userId: uid, tenantId: tid },
        'Duplicate idea detected',
      );
    }

    // Cache the result
    setCache(cacheKey, result);

    return result;
  } catch (err) {
    logger.warn({ err, userId: uid, tenantId: tid }, 'Dedup check failed — allowing idea through');
    return { isDuplicate: false, similarTo: null, confidence: 0 };
  }
}

/**
 * Get angle distribution from the last 30 days for diversity injection.
 */
export function getAngleDistribution(userId?: number, tenantId?: number): { tag: string; count: number; pct: number }[] {
  const db = getDb();
  ensureContentTenantScopeColumns(db);

  const scope = resolveRequiredContentDedupScope(userId, tenantId);
  const scopeFilter = `AND ${contentScopePredicate()}`;
  const scopeArgs = contentScopeParams(scope.userId, scope.tenantId);

  const ANGLE_TAGS = [
    'opinion', 'reaction', 'how-to', 'story', 'myth-bust',
    'comparison', 'data', 'framework', 'listicle', 'trending-take',
  ];

  // Count from both tables (per-user)
  const savedAngles = db.prepare(`
    SELECT angle_tag, COUNT(*) as cnt FROM saved_ideas
    WHERE angle_tag IS NOT NULL AND created_at > datetime('now', '-30 days') ${scopeFilter}
    GROUP BY angle_tag
  `).all(...scopeArgs) as { angle_tag: string; cnt: number }[];

  const feedbackAngles = db.prepare(`
    SELECT angle_tag, COUNT(*) as cnt FROM content_topic_feedback
    WHERE angle_tag IS NOT NULL AND created_at > datetime('now', '-30 days') ${scopeFilter}
    GROUP BY angle_tag
  `).all(...scopeArgs) as { angle_tag: string; cnt: number }[];

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
export function buildAngleDiversityBlock(userId?: number, tenantId?: number): string {
  const dist = getAngleDistribution(userId, tenantId);
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
