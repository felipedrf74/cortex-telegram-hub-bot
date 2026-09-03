// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from '../services/database';
import { ensureContentTenantScopeColumns, resolveContentTenantId } from '../services/content-tenant-scope';
import { loadContentWorkScheduleSummaries } from '../services/content-workspace-schedule-summary';
import { safeContentLogErrorFields } from '../services/content-log-safety';
import { logger } from '../utils/logger';

// CONTENT-UI-O3 (2026-05-04): Content Performance aggregate.
//
// Read-only aggregate over canonical tenant-scoped Content data:
//   - content_domain_objects (workspace state and idea inventory)
//   - content_artifacts/content_revisions (durable script inventory)
//   - content_schedule_bindings (private work sessions, never publication)
//   - content_performance (user-reported performance metrics)
//   - content_radar_feedback (accept vs reject counts)
//
// No new schema. The admin route exposes this for the portal Performance
// panel. iOS doesn't consume it yet — that's a follow-up surface.

export interface ContentPerformanceAggregate {
  generatedAt: string;
  tenantId: number;
  ownerUserId: number;
  availability: 'available' | 'partial' | 'unavailable';
  unavailableSections: ContentPerformanceAggregateSection[];
  topics: {
    total: number;
    byStatus: Record<string, number>;
    /** External publication execution/tracking is not implemented. */
    publishedLast30d: null;
    publicationTracking: {
      availability: 'unavailable';
      reasonCode: 'CONTENT_PUBLICATION_TRACKING_NOT_SUPPORTED';
      publicationExecution: 'not_supported';
    };
    /** Current Secretary-confirmed private work only. */
    scheduledNext14d: number;
    /** Recoverable, stale, provider-failed, or cancellation-pending schedule bindings. */
    scheduleAttentionNext14d: number;
    source: 'content_workspace';
    scheduleSemantics: 'private_work_session';
  };
  scripts: {
    total: number;
    last30d: number;
  };
  ideas: {
    total: number;
  };
  radarFeedback: {
    total: number;
    byAction: { accept: number; reject: number; save: number; create_brief: number };
    last7dByAction: { accept: number; reject: number; save: number; create_brief: number };
    topRejectedTopics: Array<{ topic: string; count: number }>;
    topAcceptedTopics: Array<{ topic: string; count: number }>;
  };
  performance: {
    total: number;
    last30d: number;
    avgViewsLast30d: number;
    avgRetentionLast30d: number;
    totalLikesLast30d: number;
    totalCommentsLast30d: number;
    totalSubsGainedLast30d: number;
    topByViews: Array<{ title: string; views: number; retentionPct: number }>;
  };
  highlights: string[]; // ready-rendered "what's working" phrases
  warnings: string[];   // ready-rendered "what's underperforming" phrases
}

export type ContentPerformanceAggregateSection =
  | 'workspace_inventory'
  | 'scripts'
  | 'ideas'
  | 'radar_feedback'
  | 'performance';

const ZERO_ACTION_BUCKETS = { accept: 0, reject: 0, save: 0, create_brief: 0 } as const;

function emptyAggregate(tenantId: number, ownerUserId: number): ContentPerformanceAggregate {
  return {
    generatedAt: new Date().toISOString(),
    tenantId,
    ownerUserId,
    availability: ownerUserId > 0 ? 'available' : 'unavailable',
    unavailableSections: ownerUserId > 0
      ? []
      : ['workspace_inventory', 'scripts', 'ideas', 'radar_feedback', 'performance'],
    topics: {
      total: 0,
      byStatus: {},
      publishedLast30d: null,
      publicationTracking: {
        availability: 'unavailable',
        reasonCode: 'CONTENT_PUBLICATION_TRACKING_NOT_SUPPORTED',
        publicationExecution: 'not_supported',
      },
      scheduledNext14d: 0,
      scheduleAttentionNext14d: 0,
      source: 'content_workspace',
      scheduleSemantics: 'private_work_session',
    },
    scripts: { total: 0, last30d: 0 },
    ideas: { total: 0 },
    radarFeedback: {
      total: 0,
      byAction: { ...ZERO_ACTION_BUCKETS },
      last7dByAction: { ...ZERO_ACTION_BUCKETS },
      topRejectedTopics: [],
      topAcceptedTopics: [],
    },
    performance: {
      total: 0,
      last30d: 0,
      avgViewsLast30d: 0,
      avgRetentionLast30d: 0,
      totalLikesLast30d: 0,
      totalCommentsLast30d: 0,
      totalSubsGainedLast30d: 0,
      topByViews: [],
    },
    highlights: [],
    warnings: [],
  };
}

function normalizePerformanceTitle(value: unknown): string {
  const cleaned = String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned || '(untitled)';
}

function safeQuery(
  fn: () => void,
  ctx: ContentPerformanceAggregateSection,
  unavailableSections: ContentPerformanceAggregateSection[],
): void {
  try {
    fn();
  } catch (err) {
    unavailableSections.push(ctx);
    logger.warn(safeContentLogErrorFields(err), `content-performance-aggregate.${ctx} failed`);
  }
}

export function getContentPerformanceAggregate(
  userId: number,
  tenantId?: number | null,
): ContentPerformanceAggregate {
  if (!Number.isFinite(userId) || userId <= 0) {
    return emptyAggregate(0, 0);
  }
  ensureContentTenantScopeColumns();
  const db = getDb();
  const resolvedTenantId = resolveContentTenantId(userId, tenantId);
  const result = emptyAggregate(resolvedTenantId, userId);

  // ─── Canonical workspace inventory ──────────────────────────────
  safeQuery(() => {
    const totalRow = db.prepare(`
      SELECT COUNT(*) AS c FROM content_domain_objects item
      WHERE item.tenant_id = ? AND item.owner_user_id = ?
        AND item.visibility_scope = 'user_private'
        AND item.scope_status = 'active'
        AND item.deleted_at IS NULL
        AND item.object_type = 'content_item'
    `).get(resolvedTenantId, userId) as { c: number };
    result.topics.total = Number(totalRow?.c ?? 0);

    const statusRows = db.prepare(`
      SELECT production_state AS status, COUNT(*) AS c
      FROM content_domain_objects item
      WHERE item.tenant_id = ? AND item.owner_user_id = ?
        AND item.visibility_scope = 'user_private'
        AND item.scope_status = 'active'
        AND item.deleted_at IS NULL
        AND item.object_type = 'content_item'
      GROUP BY production_state
    `).all(resolvedTenantId, userId) as Array<{ status: string; c: number }>;
    for (const row of statusRows) {
      result.topics.byStatus[String(row.status)] = Number(row.c) || 0;
    }

    const scheduledItemIds = (db.prepare(`
      SELECT item.id
        FROM content_domain_objects item
       WHERE item.tenant_id = ? AND item.owner_user_id = ?
         AND item.visibility_scope = 'user_private'
         AND item.scope_status = 'active'
         AND item.deleted_at IS NULL
         AND item.object_type = 'content_item'
    `).all(resolvedTenantId, userId) as Array<{ id: number }>).map((row) => Number(row.id));
    const windowStart = Date.now();
    const windowEnd = windowStart + (14 * 24 * 60 * 60 * 1000);
    for (let offset = 0; offset < scheduledItemIds.length; offset += 400) {
      const schedules = loadContentWorkScheduleSummaries(
        { tenantId: resolvedTenantId, userId },
        scheduledItemIds.slice(offset, offset + 400),
        db,
      );
      for (const schedule of schedules.values()) {
        const scheduledStart = Date.parse(schedule.scheduledStart);
        if (!Number.isFinite(scheduledStart) || scheduledStart < windowStart || scheduledStart >= windowEnd) continue;
        if (
          schedule.authorityStatus === 'current'
          && (
            schedule.state === 'scheduled'
            || schedule.state === 'provider_synced'
            || schedule.state === 'sync_failed'
          )
        ) {
          result.topics.scheduledNext14d += 1;
        }
        if (schedule.recoverable) {
          result.topics.scheduleAttentionNext14d += 1;
        }
      }
    }
  }, 'workspace_inventory', result.unavailableSections);

  // ─── Canonical scripts ──────────────────────────────────────────
  safeQuery(() => {
    const total = db.prepare(`
      SELECT COUNT(DISTINCT artifact.id) AS c
      FROM content_artifacts artifact
      JOIN content_domain_objects item
        ON item.id = artifact.item_id
       AND item.tenant_id = artifact.tenant_id
       AND item.owner_user_id = artifact.owner_user_id
      WHERE artifact.tenant_id = ? AND artifact.owner_user_id = ?
        AND artifact.visibility_scope = 'user_private'
        AND artifact.scope_status = 'active'
        AND artifact.artifact_type = 'script'
        AND artifact.current_revision_id IS NOT NULL
        AND item.visibility_scope = 'user_private'
        AND item.scope_status = 'active'
        AND item.deleted_at IS NULL
        AND item.object_type = 'content_item'
    `).get(resolvedTenantId, userId) as { c: number };
    result.scripts.total = Number(total?.c ?? 0);

    const last30 = db.prepare(`
      SELECT COUNT(DISTINCT artifact.id) AS c
      FROM content_artifacts artifact
      JOIN content_domain_objects item
        ON item.id = artifact.item_id
       AND item.tenant_id = artifact.tenant_id
       AND item.owner_user_id = artifact.owner_user_id
      WHERE artifact.tenant_id = ? AND artifact.owner_user_id = ?
        AND artifact.visibility_scope = 'user_private'
        AND artifact.scope_status = 'active'
        AND artifact.artifact_type = 'script'
        AND artifact.current_revision_id IS NOT NULL
        AND artifact.created_at >= datetime('now', '-30 days')
        AND item.visibility_scope = 'user_private'
        AND item.scope_status = 'active'
        AND item.deleted_at IS NULL
        AND item.object_type = 'content_item'
    `).get(resolvedTenantId, userId) as { c: number };
    result.scripts.last30d = Number(last30?.c ?? 0);
  }, 'scripts', result.unavailableSections);

  // ─── Canonical early-phase ideas ────────────────────────────────
  safeQuery(() => {
    const total = db.prepare(`
      SELECT COUNT(*) AS c FROM content_domain_objects item
      WHERE item.tenant_id = ? AND item.owner_user_id = ?
        AND item.visibility_scope = 'user_private'
        AND item.scope_status = 'active'
        AND item.deleted_at IS NULL
        AND item.object_type = 'content_item'
        AND item.artifact_phase IN ('idea', 'brief', 'outline')
        AND item.production_state NOT IN ('published', 'archived', 'rejected')
    `).get(resolvedTenantId, userId) as { c: number };
    result.ideas.total = Number(total?.c ?? 0);
  }, 'ideas', result.unavailableSections);

  // ─── Radar feedback ─────────────────────────────────────────────
  safeQuery(() => {
    const totalRow = db.prepare(`
      SELECT COUNT(*) AS c FROM content_radar_feedback
      WHERE tenant_id = ? AND owner_user_id = ?
        AND COALESCE(scope_status, 'active') = 'active'
    `).get(resolvedTenantId, userId) as { c: number };
    result.radarFeedback.total = Number(totalRow?.c ?? 0);

    const byActionRows = db.prepare(`
      SELECT action, COUNT(*) AS c
      FROM content_radar_feedback
      WHERE tenant_id = ? AND owner_user_id = ?
        AND COALESCE(scope_status, 'active') = 'active'
      GROUP BY action
    `).all(resolvedTenantId, userId) as Array<{ action: string; c: number }>;
    for (const row of byActionRows) {
      const k = row.action as keyof typeof ZERO_ACTION_BUCKETS;
      if (k in ZERO_ACTION_BUCKETS) {
        result.radarFeedback.byAction[k] = Number(row.c) || 0;
      }
    }

    const last7dRows = db.prepare(`
      SELECT action, COUNT(*) AS c
      FROM content_radar_feedback
      WHERE tenant_id = ? AND owner_user_id = ?
        AND COALESCE(scope_status, 'active') = 'active'
        AND created_at >= datetime('now', '-7 days')
      GROUP BY action
    `).all(resolvedTenantId, userId) as Array<{ action: string; c: number }>;
    for (const row of last7dRows) {
      const k = row.action as keyof typeof ZERO_ACTION_BUCKETS;
      if (k in ZERO_ACTION_BUCKETS) {
        result.radarFeedback.last7dByAction[k] = Number(row.c) || 0;
      }
    }

    const topRejected = db.prepare(`
      SELECT COALESCE(NULLIF(signal_topic, ''), NULLIF(signal_summary, ''), 'Unknown radar topic') AS topic, COUNT(*) AS c
      FROM content_radar_feedback
      WHERE tenant_id = ? AND owner_user_id = ?
        AND COALESCE(scope_status, 'active') = 'active'
        AND action = 'reject'
      GROUP BY topic
      ORDER BY c DESC
      LIMIT 5
    `).all(resolvedTenantId, userId) as Array<{ topic: string; c: number }>;
    result.radarFeedback.topRejectedTopics = topRejected.map(r => ({
      topic: String(r.topic ?? '(unknown)'),
      count: Number(r.c) || 0,
    }));

    const topAccepted = db.prepare(`
      SELECT COALESCE(NULLIF(signal_topic, ''), NULLIF(signal_summary, ''), 'Unknown radar topic') AS topic, COUNT(*) AS c
      FROM content_radar_feedback
      WHERE tenant_id = ? AND owner_user_id = ?
        AND COALESCE(scope_status, 'active') = 'active'
        AND action = 'accept'
      GROUP BY topic
      ORDER BY c DESC
      LIMIT 5
    `).all(resolvedTenantId, userId) as Array<{ topic: string; c: number }>;
    result.radarFeedback.topAcceptedTopics = topAccepted.map(r => ({
      topic: String(r.topic ?? '(unknown)'),
      count: Number(r.c) || 0,
    }));
  }, 'radar_feedback', result.unavailableSections);

  // ─── Published performance feedback ─────────────────────────────
  safeQuery(() => {
    const row = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN logged_at >= datetime('now', '-30 days') THEN 1 ELSE 0 END) AS last30d,
        AVG(CASE WHEN logged_at >= datetime('now', '-30 days') THEN views ELSE NULL END) AS avg_views_last30d,
        AVG(CASE WHEN logged_at >= datetime('now', '-30 days') THEN retention_pct ELSE NULL END) AS avg_retention_last30d,
        SUM(CASE WHEN logged_at >= datetime('now', '-30 days') THEN likes ELSE 0 END) AS total_likes_last30d,
        SUM(CASE WHEN logged_at >= datetime('now', '-30 days') THEN comments ELSE 0 END) AS total_comments_last30d,
        SUM(CASE WHEN logged_at >= datetime('now', '-30 days') THEN subs_gained ELSE 0 END) AS total_subs_gained_last30d
      FROM content_performance
      WHERE COALESCE(tenant_id, user_id) = ?
        AND COALESCE(owner_user_id, user_id) = ?
        AND COALESCE(scope_status, 'active') = 'active'
    `).get(resolvedTenantId, userId) as {
      total: number | null;
      last30d: number | null;
      avg_views_last30d: number | null;
      avg_retention_last30d: number | null;
      total_likes_last30d: number | null;
      total_comments_last30d: number | null;
      total_subs_gained_last30d: number | null;
    };
    result.performance.total = Number(row?.total ?? 0);
    result.performance.last30d = Number(row?.last30d ?? 0);
    result.performance.avgViewsLast30d = Math.round(Number(row?.avg_views_last30d ?? 0));
    result.performance.avgRetentionLast30d = Math.round(Number(row?.avg_retention_last30d ?? 0) * 10) / 10;
    result.performance.totalLikesLast30d = Number(row?.total_likes_last30d ?? 0);
    result.performance.totalCommentsLast30d = Number(row?.total_comments_last30d ?? 0);
    result.performance.totalSubsGainedLast30d = Number(row?.total_subs_gained_last30d ?? 0);

    const topRows = db.prepare(`
      SELECT COALESCE(selected_title, video_url, 'Untitled performance item') AS title,
             views,
             retention_pct
      FROM content_performance
      WHERE COALESCE(tenant_id, user_id) = ?
        AND COALESCE(owner_user_id, user_id) = ?
        AND COALESCE(scope_status, 'active') = 'active'
        AND logged_at >= datetime('now', '-90 days')
      ORDER BY views DESC, retention_pct DESC, logged_at DESC
      LIMIT 5
    `).all(resolvedTenantId, userId) as Array<{
      title: string | null;
      views: number | null;
      retention_pct: number | null;
    }>;
    result.performance.topByViews = topRows.map((item) => ({
      title: normalizePerformanceTitle(item.title),
      views: Number(item.views ?? 0),
      retentionPct: Math.round(Number(item.retention_pct ?? 0) * 10) / 10,
    }));
  }, 'performance', result.unavailableSections);

  // ─── Highlights / warnings ──────────────────────────────────────
  const sectionAvailable = (section: ContentPerformanceAggregateSection): boolean => (
    !result.unavailableSections.includes(section)
  );
  if (sectionAvailable('scripts') && result.scripts.last30d >= 8) {
    result.highlights.push(
      `${result.scripts.last30d} scripts generated in the last 30 days — script velocity is healthy.`,
    );
  }
  if (sectionAvailable('radar_feedback')
      && (result.radarFeedback.byAction.accept) > (result.radarFeedback.byAction.reject)) {
    result.highlights.push(
      `Radar fit is healthy — ${result.radarFeedback.byAction.accept} accepts vs ${result.radarFeedback.byAction.reject} rejects.`,
    );
  }
  if (sectionAvailable('radar_feedback')
      && (result.radarFeedback.byAction.reject) > (result.radarFeedback.byAction.accept) * 2
      && result.radarFeedback.byAction.reject >= 5) {
    result.warnings.push(
      `Radar is under-fitting the profile — ${result.radarFeedback.byAction.reject} rejects vs ${result.radarFeedback.byAction.accept} accepts. Consider tightening pillars + banned topics.`,
    );
  }
  if (sectionAvailable('performance')
      && result.performance.last30d > 0 && result.performance.avgRetentionLast30d >= 50) {
    result.highlights.push(
      `User-reported performance is holding attention — ${result.performance.avgRetentionLast30d}% average retention across ${result.performance.last30d} recent entries.`,
    );
  }
  if (sectionAvailable('performance')
      && result.performance.last30d > 0 && result.performance.avgRetentionLast30d < 25) {
    result.warnings.push(
      `Recent user-reported performance is under-retaining viewers at ${result.performance.avgRetentionLast30d}% average retention. Review hooks and pacing before scaling the next batch.`,
    );
  }
  if (sectionAvailable('workspace_inventory')
      && sectionAvailable('scripts')
      && result.scripts.total === 0 && result.topics.total >= 3) {
    result.warnings.push(
      'Workspace items exist but no current script artifacts are available. Develop the highest-priority item into an outline or script.',
    );
  }

  result.availability = result.unavailableSections.length === 0
    ? 'available'
    : result.unavailableSections.length === 5
      ? 'unavailable'
      : 'partial';
  return result;
}
