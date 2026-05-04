// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from '../services/database';
import { ensureContentTenantScopeColumns, resolveContentTenantId } from '../services/content-tenant-scope';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────────────────────────────
// CONTENT-UI-O4 (2026-05-04): Canonical 12-stage Content Idea lifecycle.
//
// Two competing lifecycle models exist today:
//   - `ContentStages` (legacy): ideas → scripted → filmed → editing → published
//   - `ContentTopicStatus` (rich): planned, drafting, idea, researched, selected,
//     outlined, drafted, reviewed, revised, approved, scheduled, ready,
//     published, cancelled, archived, repurposed, rejected, stale,
//     deferred, unscheduled, blocked, unknown
//
// The product spec asks for 12 buckets:
//   discovered → suggested → accepted → briefing → drafting → review →
//   approved → scheduled → published → measured → archived → rejected
//
// This module is a PURE DERIVED VIEW. We don't add new schema or
// migrate existing rows. We map both `saved_ideas.status` and
// `content_topics.status` into the canonical 12 buckets so the
// portal/iOS can render a unified pipeline. When backend code adopts
// the canonical states natively, this mapper becomes a pass-through.
//
// Rationale: minimal blast radius. No data migration required. Existing
// 5-stage view keeps working unchanged (`ContentStages` continues to
// surface `ideas/scripted/filmed/editing/published` from
// `content-pipeline-routes.ts`). The new view is additive.
// ─────────────────────────────────────────────────────────────────────

export type CanonicalLifecycleStage =
  | 'discovered'
  | 'suggested'
  | 'accepted'
  | 'briefing'
  | 'drafting'
  | 'review'
  | 'approved'
  | 'scheduled'
  | 'published'
  | 'measured'
  | 'archived'
  | 'rejected';

export const CANONICAL_LIFECYCLE_STAGES: readonly CanonicalLifecycleStage[] = [
  'discovered',
  'suggested',
  'accepted',
  'briefing',
  'drafting',
  'review',
  'approved',
  'scheduled',
  'published',
  'measured',
  'archived',
  'rejected',
];

export const CANONICAL_LIFECYCLE_LABEL: Record<CanonicalLifecycleStage, string> = {
  discovered: 'Discovered',
  suggested: 'Suggested',
  accepted: 'Accepted',
  briefing: 'Briefing',
  drafting: 'Drafting',
  review: 'Review',
  approved: 'Approved',
  scheduled: 'Scheduled',
  published: 'Published',
  measured: 'Measured',
  archived: 'Archived',
  rejected: 'Rejected',
};

/**
 * Map a `content_topics.status` value into a canonical lifecycle stage.
 * The rich set has 22 values; we collapse them into the 12 canonical
 * buckets. Order of map keys reflects nuance — e.g. `'approved'` and
 * `'scheduled'` are distinct buckets, not folded.
 */
export function mapContentTopicStatusToCanonical(
  status: string | null | undefined,
): CanonicalLifecycleStage {
  if (!status) return 'discovered';
  switch (status.toLowerCase()) {
    case 'idea':            return 'suggested';
    case 'planned':         return 'suggested';
    case 'researched':      return 'briefing';
    case 'selected':        return 'briefing';
    case 'outlined':        return 'briefing';
    case 'drafting':        return 'drafting';
    case 'drafted':         return 'drafting';
    case 'reviewed':        return 'review';
    case 'revised':         return 'review';
    case 'approved':        return 'approved';
    case 'ready':           return 'approved';
    case 'scheduled':       return 'scheduled';
    case 'published':       return 'published';
    case 'repurposed':      return 'published';
    case 'cancelled':       return 'rejected';
    case 'rejected':        return 'rejected';
    case 'archived':        return 'archived';
    case 'stale':           return 'archived';
    case 'deferred':        return 'archived';
    case 'unscheduled':     return 'discovered';
    case 'blocked':         return 'review';
    default:                return 'discovered';
  }
}

/**
 * Map a `saved_ideas.status` value into a canonical lifecycle stage.
 * The legacy `saved_ideas` table uses a smaller status set
 * (idea/scripted/filmed/editing/published). Idea-specific words like
 * "rejected" / "accepted" don't appear there yet — those came from the
 * radar-feedback log (CONTENT-UI-O2).
 */
export function mapSavedIdeaStatusToCanonical(
  status: string | null | undefined,
): CanonicalLifecycleStage {
  if (!status) return 'suggested';
  switch (status.toLowerCase()) {
    case 'idea':            return 'suggested';
    case 'scripted':        return 'drafting';
    case 'filmed':          return 'review';
    case 'editing':         return 'review';
    case 'published':       return 'published';
    default:                return 'suggested';
  }
}

export interface CanonicalLifecycleBucket {
  stage: CanonicalLifecycleStage;
  label: string;
  count: number;
}

export interface CanonicalLifecycleSummary {
  generatedAt: string;
  tenantId: number;
  ownerUserId: number;
  buckets: CanonicalLifecycleBucket[];
  total: number;
  hasData: boolean;
}

const STATUS_BY_TABLE = {
  topics: 'content_topics',
  ideas: 'saved_ideas',
} as const;

export function summarizeCanonicalLifecycle(
  userId: number,
  tenantId?: number | null,
): CanonicalLifecycleSummary {
  const generatedAt = new Date().toISOString();
  const counters: Record<CanonicalLifecycleStage, number> = {
    discovered: 0, suggested: 0, accepted: 0, briefing: 0,
    drafting: 0, review: 0, approved: 0, scheduled: 0,
    published: 0, measured: 0, archived: 0, rejected: 0,
  };

  if (!Number.isFinite(userId) || userId <= 0) {
    return {
      generatedAt, tenantId: 0, ownerUserId: 0,
      buckets: emptyBuckets(counters),
      total: 0, hasData: false,
    };
  }
  ensureContentTenantScopeColumns();
  const db = getDb();
  const resolvedTenantId = resolveContentTenantId(userId, tenantId);

  // ─── Topics → canonical ────────────────────────────────────────
  try {
    const rows = db.prepare(`
      SELECT COALESCE(status, 'idea') AS status, COUNT(*) AS c
      FROM ${STATUS_BY_TABLE.topics}
      WHERE tenant_id = ? AND owner_user_id = ?
        AND COALESCE(scope_status, 'active') = 'active'
      GROUP BY status
    `).all(resolvedTenantId, userId) as Array<{ status: string; c: number }>;
    for (const r of rows) {
      const stage = mapContentTopicStatusToCanonical(String(r.status ?? ''));
      counters[stage] += Number(r.c) || 0;
    }
  } catch (err) {
    logger.warn({ err, userId, tenantId: resolvedTenantId },
      'content-lifecycle.summarize topics failed');
  }

  // ─── Ideas → canonical ─────────────────────────────────────────
  try {
    const rows = db.prepare(`
      SELECT COALESCE(status, 'idea') AS status, COUNT(*) AS c
      FROM ${STATUS_BY_TABLE.ideas}
      WHERE COALESCE(tenant_id, user_id) = ?
        AND COALESCE(owner_user_id, user_id) = ?
        AND COALESCE(scope_status, 'active') = 'active'
      GROUP BY status
    `).all(resolvedTenantId, userId) as Array<{ status: string; c: number }>;
    for (const r of rows) {
      const stage = mapSavedIdeaStatusToCanonical(String(r.status ?? ''));
      counters[stage] += Number(r.c) || 0;
    }
  } catch (err) {
    logger.warn({ err, userId, tenantId: resolvedTenantId },
      'content-lifecycle.summarize ideas failed');
  }

  // ─── Radar-feedback signals → 'rejected' / 'accepted' ──────────
  // A radar signal that the user has 'reject'-ed at least once feeds
  // the 'rejected' bucket; an 'accept'-ed signal that hasn't been
  // converted into a topic yet sits in 'accepted'.
  try {
    const rejected = db.prepare(`
      SELECT COUNT(DISTINCT signal_id) AS c
      FROM content_radar_feedback
      WHERE tenant_id = ? AND owner_user_id = ?
        AND COALESCE(scope_status, 'active') = 'active'
        AND action = 'reject'
    `).get(resolvedTenantId, userId) as { c: number };
    counters.rejected += Number(rejected?.c ?? 0);

    const accepted = db.prepare(`
      SELECT COUNT(DISTINCT signal_id) AS c
      FROM content_radar_feedback
      WHERE tenant_id = ? AND owner_user_id = ?
        AND COALESCE(scope_status, 'active') = 'active'
        AND action = 'accept'
    `).get(resolvedTenantId, userId) as { c: number };
    counters.accepted += Number(accepted?.c ?? 0);
  } catch (err) {
    logger.warn({ err, userId, tenantId: resolvedTenantId },
      'content-lifecycle.summarize radar feedback failed');
  }

  const buckets = CANONICAL_LIFECYCLE_STAGES.map(stage => ({
    stage,
    label: CANONICAL_LIFECYCLE_LABEL[stage],
    count: counters[stage],
  }));
  const total = buckets.reduce((acc, b) => acc + b.count, 0);

  return {
    generatedAt,
    tenantId: resolvedTenantId,
    ownerUserId: userId,
    buckets,
    total,
    hasData: total > 0,
  };
}

function emptyBuckets(c: Record<CanonicalLifecycleStage, number>): CanonicalLifecycleBucket[] {
  return CANONICAL_LIFECYCLE_STAGES.map(stage => ({
    stage,
    label: CANONICAL_LIFECYCLE_LABEL[stage],
    count: c[stage] || 0,
  }));
}
