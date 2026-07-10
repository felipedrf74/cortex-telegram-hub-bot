// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Semantic deduplication for content ideas.
 * Deterministic classifier: a new title is a duplicate of a recent scoped title
 * on normalized exact match (0.95) or token-set Jaccard >= 0.8 (0.85); ideas
 * whose angle tags both exist and differ are never duplicates. Replaced the
 * per-candidate LLM call (2026-07-03) — same rule the prompt encoded, without
 * the cost, latency, or provider-error fail-open.
 */

import { getDb } from './database';
import { logger } from '../utils/logger';
import {
  contentScopeParams,
  contentScopePredicate,
  ensureContentTenantScopeColumns,
} from './content-tenant-scope';
import { requireTenantIdParam } from './tenant-scope';

export interface DedupResult {
  isDuplicate: boolean;
  similarTo: string | null;
  confidence: number;
}

export interface ContentDedupCandidate {
  title: string;
  angleTag?: string | null;
}

const EXACT_MATCH_CONFIDENCE = 0.95;
const TOKEN_OVERLAP_CONFIDENCE = 0.85;
const TOKEN_OVERLAP_THRESHOLD = 0.8;

// Lowercase, strip accents, strip punctuation, collapse whitespace.
function normalizeTitle(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(normalized: string): Set<string> {
  return new Set(normalized.split(' ').filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

function normalizeAngle(angle?: string | null): string | null {
  const trimmed = angle?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

/**
 * Classify one new idea against the recent scoped titles. Pure + deterministic.
 * Exact normalized match wins (0.95); otherwise the first title with token
 * Jaccard >= 0.8 (0.85). When BOTH ideas carry angle tags and they differ, the
 * pair is never a duplicate — same topic, different angle is deliberate reuse.
 */
function classifyAgainstRecent(
  newIdea: string,
  angleTag: string | undefined,
  existingIdeas: { title: string; angle_tag: string | null }[],
): DedupResult {
  const notDuplicate: DedupResult = { isDuplicate: false, similarTo: null, confidence: 0 };
  const normalizedNew = normalizeTitle(newIdea);
  if (!normalizedNew) return notDuplicate;

  const newTokens = tokenize(normalizedNew);
  const newAngle = normalizeAngle(angleTag);

  let best = notDuplicate;
  for (const idea of existingIdeas) {
    const existingAngle = normalizeAngle(idea.angle_tag);
    if (newAngle && existingAngle && newAngle !== existingAngle) continue;

    const normalizedExisting = normalizeTitle(idea.title);
    if (!normalizedExisting) continue;

    if (normalizedExisting === normalizedNew) {
      return { isDuplicate: true, similarTo: idea.title, confidence: EXACT_MATCH_CONFIDENCE };
    }
    if (!best.isDuplicate && jaccard(newTokens, tokenize(normalizedExisting)) >= TOKEN_OVERLAP_THRESHOLD) {
      best = { isDuplicate: true, similarTo: idea.title, confidence: TOKEN_OVERLAP_CONFIDENCE };
    }
  }
  return best;
}

/**
 * Compare a candidate with peers already accepted in the current provider
 * response. Database-backed dedup cannot see those peers until persistence,
 * so this pure check closes the within-batch and cross-array gap without an
 * extra model call. Weekly packages can disable angle exceptions because the
 * package contract forbids repeating the same topic across formats.
 */
export function isDuplicateIdeaInBatch(
  newIdea: string,
  angleTag: string | undefined,
  accepted: readonly ContentDedupCandidate[],
  options: { allowDifferentAngles?: boolean } = {},
): DedupResult {
  const allowDifferentAngles = options.allowDifferentAngles ?? true;
  return classifyAgainstRecent(
    newIdea,
    allowDifferentAngles ? angleTag : undefined,
    accepted.map((candidate) => ({
      title: candidate.title,
      angle_tag: allowDifferentAngles ? candidate.angleTag ?? null : null,
    })),
  );
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
  // Scope-resolution failures must still THROW (pinned contract); only the
  // fetch/classify path below fails open.
  const scope = resolveRequiredContentDedupScope(userId, tenantId);
  const uid = scope.userId;
  const tid = scope.tenantId;

  try {
    const db = getDb();
    ensureContentTenantScopeColumns(db);

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
      return { isDuplicate: false, similarTo: null, confidence: 0 };
    }

    const result = classifyAgainstRecent(newIdea, angleTag, existingIdeas);

    logger.debug(
      { newIdea, isDuplicate: result.isDuplicate, similarTo: result.similarTo, confidence: result.confidence, userId: uid, tenantId: tid },
      'Content dedup decision',
    );
    if (result.isDuplicate) {
      logger.info(
        { newIdea, similarTo: result.similarTo, confidence: result.confidence, userId: uid, tenantId: tid },
        'Duplicate idea detected',
      );
    }

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
