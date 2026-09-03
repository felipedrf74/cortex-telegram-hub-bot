// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from '../services/database';
import { ensureContentTenantScopeColumns, resolveContentTenantId } from '../services/content-tenant-scope';
import { safeContentLogErrorFields } from '../services/content-log-safety';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────────────────────────────
// CONTENT-UI-O4 (2026-05-04): Canonical 12-stage Content lifecycle.
//
// The workspace owns lifecycle truth through `production_state` plus
// `artifact_phase`. Frozen topic/idea stores are not operational inputs.
// The product surface keeps these 12 presentation buckets:
//   discovered → suggested → accepted → briefing → drafting → review →
//   approved → scheduled → published → measured → archived → rejected
//
// This module is a pure tenant-scoped read model. It never writes workflow
// state or reconstructs publication truth from a legacy status claim.
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
 * Translate retired topic-API status values for compatibility payloads.
 * This pure translator does not read the retired topic store. The rich set
 * has 22 values; we collapse them into the 12 canonical presentation buckets.
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

/** Map canonical workspace state into the 12-stage presentation model. */
export function mapContentWorkspaceStateToCanonical(
  productionState: string | null | undefined,
  artifactPhase: string | null | undefined,
): CanonicalLifecycleStage {
  switch ((productionState ?? '').toLowerCase()) {
    case 'published': return 'published';
    case 'scheduled': return 'scheduled';
    case 'approved': return 'approved';
    case 'review': return 'review';
    case 'archived': return 'archived';
    case 'rejected': return 'rejected';
    case 'inbox': return 'suggested';
    case 'active': {
      switch ((artifactPhase ?? '').toLowerCase()) {
        case 'brief':
        case 'outline': return 'briefing';
        case 'draft': return 'drafting';
        case 'final': return 'review';
        case 'idea':
        default: return 'accepted';
      }
    }
    default: return 'discovered';
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
  availability: 'available' | 'partial' | 'unavailable';
  unavailableSections: Array<'workspace' | 'radar_feedback'>;
  buckets: CanonicalLifecycleBucket[];
  total: number;
  hasData: boolean;
}

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
      availability: 'unavailable',
      unavailableSections: ['workspace', 'radar_feedback'],
      buckets: emptyBuckets(counters),
      total: 0, hasData: false,
    };
  }
  ensureContentTenantScopeColumns();
  const db = getDb();
  const resolvedTenantId = resolveContentTenantId(userId, tenantId);
  const unavailableSections: CanonicalLifecycleSummary['unavailableSections'] = [];

  // ─── Canonical workspace inventory ─────────────────────────────
  try {
    const rows = db.prepare(`
      SELECT production_state, artifact_phase, COUNT(*) AS c
      FROM content_domain_objects
      WHERE tenant_id = ? AND owner_user_id = ?
        AND visibility_scope = 'user_private'
        AND scope_status = 'active'
        AND deleted_at IS NULL
        AND object_type = 'content_item'
      GROUP BY production_state, artifact_phase
    `).all(resolvedTenantId, userId) as Array<{
      production_state: string;
      artifact_phase: string;
      c: number;
    }>;
    for (const r of rows) {
      const stage = mapContentWorkspaceStateToCanonical(r.production_state, r.artifact_phase);
      counters[stage] += Number(r.c) || 0;
    }
  } catch (err) {
    unavailableSections.push('workspace');
    logger.warn({ ...safeContentLogErrorFields(err), userId, tenantId: resolvedTenantId },
      'content-lifecycle.summarize workspace failed');
  }

  // ─── Radar-feedback signals → 'rejected' / 'accepted' ──────────
  // A radar signal that the user has 'reject'-ed at least once feeds
  // the 'rejected' bucket; an 'accept'-ed signal that hasn't been
  // converted into a workspace item yet sits in 'accepted'.
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
      SELECT COUNT(DISTINCT f.signal_id) AS c
      FROM content_radar_feedback f
      WHERE f.tenant_id = ? AND f.owner_user_id = ?
        AND COALESCE(f.scope_status, 'active') = 'active'
        AND f.action = 'accept'
        AND NOT EXISTS (
          SELECT 1
          FROM content_radar_feedback converted
          WHERE converted.tenant_id = f.tenant_id
            AND converted.owner_user_id = f.owner_user_id
            AND converted.signal_id = f.signal_id
            AND COALESCE(converted.scope_status, 'active') = 'active'
            AND converted.action = 'create_brief'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM content_domain_objects item
          WHERE item.tenant_id = f.tenant_id
            AND item.owner_user_id = f.owner_user_id
            AND item.visibility_scope = 'user_private'
            AND item.scope_status = 'active'
            AND item.deleted_at IS NULL
            AND item.object_type = 'content_item'
            AND f.signal_topic IS NOT NULL
            AND lower(trim(item.title)) = lower(trim(f.signal_topic))
        )
    `).get(resolvedTenantId, userId) as { c: number };
    counters.accepted += Number(accepted?.c ?? 0);
  } catch (err) {
    unavailableSections.push('radar_feedback');
    logger.warn({ ...safeContentLogErrorFields(err), userId, tenantId: resolvedTenantId },
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
    availability: unavailableSections.length === 0
      ? 'available'
      : unavailableSections.length === 2
        ? 'unavailable'
        : 'partial',
    unavailableSections,
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
