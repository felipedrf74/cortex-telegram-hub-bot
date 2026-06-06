// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from '../services/database';
import { ensureContentTenantScopeColumns, resolveContentTenantId } from '../services/content-tenant-scope';
import { logger } from '../utils/logger';

// CONTENT-UI-O3 (2026-05-04): Content Performance aggregate.
//
// Read-only aggregate over existing tenant-scoped tables:
//   - content_topics (status counts, last 30/90 day distribution)
//   - content_scripts (count, last 30 days)
//   - saved_ideas (count)
//   - content_performance (published video metrics)
//   - content_radar_feedback (accept vs reject counts)
//
// No new schema. The admin route exposes this for the portal Performance
// panel. iOS doesn't consume it yet — that's a follow-up surface.

export interface ContentPerformanceAggregate {
  generatedAt: string;
  tenantId: number;
  ownerUserId: number;
  topics: {
    total: number;
    byStatus: Record<string, number>;
    publishedLast30d: number;
    scheduledNext14d: number;
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

const ZERO_ACTION_BUCKETS = { accept: 0, reject: 0, save: 0, create_brief: 0 } as const;

function emptyAggregate(tenantId: number, ownerUserId: number): ContentPerformanceAggregate {
  return {
    generatedAt: new Date().toISOString(),
    tenantId,
    ownerUserId,
    topics: { total: 0, byStatus: {}, publishedLast30d: 0, scheduledNext14d: 0 },
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

function safeQuery<T = Record<string, unknown>>(
  fn: () => T,
  fallback: T,
  ctx: string,
  meta: Record<string, unknown> = {},
): T {
  try {
    return fn();
  } catch (err) {
    logger.warn({ err, ...meta }, `content-performance-aggregate.${ctx} failed`);
    return fallback;
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

  // ─── Topics ─────────────────────────────────────────────────────
  safeQuery(() => {
    const totalRow = db.prepare(`
      SELECT COUNT(*) AS c FROM content_topics
      WHERE tenant_id = ? AND owner_user_id = ?
        AND COALESCE(scope_status, 'active') = 'active'
    `).get(resolvedTenantId, userId) as { c: number };
    result.topics.total = Number(totalRow?.c ?? 0);

    const statusRows = db.prepare(`
      SELECT COALESCE(status, 'unknown') AS status, COUNT(*) AS c
      FROM content_topics
      WHERE tenant_id = ? AND owner_user_id = ?
        AND COALESCE(scope_status, 'active') = 'active'
      GROUP BY status
    `).all(resolvedTenantId, userId) as Array<{ status: string; c: number }>;
    for (const row of statusRows) {
      result.topics.byStatus[String(row.status)] = Number(row.c) || 0;
    }

    const publishedLast30dRow = db.prepare(`
      SELECT COUNT(*) AS c FROM content_topics
      WHERE tenant_id = ? AND owner_user_id = ?
        AND COALESCE(scope_status, 'active') = 'active'
        AND status = 'published'
        AND COALESCE(updated_at, created_at) >= datetime('now', '-30 days')
    `).get(resolvedTenantId, userId) as { c: number };
    result.topics.publishedLast30d = Number(publishedLast30dRow?.c ?? 0);

    const scheduledNext14dRow = db.prepare(`
      SELECT COUNT(*) AS c FROM content_topics
      WHERE tenant_id = ? AND owner_user_id = ?
        AND COALESCE(scope_status, 'active') = 'active'
        AND scheduled_date IS NOT NULL
        AND scheduled_date BETWEEN date('now') AND date('now', '+14 days')
    `).get(resolvedTenantId, userId) as { c: number };
    result.topics.scheduledNext14d = Number(scheduledNext14dRow?.c ?? 0);
  }, undefined, 'topics', { userId, tenantId: resolvedTenantId });

  // ─── Scripts ────────────────────────────────────────────────────
  safeQuery(() => {
    const total = db.prepare(`
      SELECT COUNT(*) AS c FROM content_scripts
      WHERE COALESCE(tenant_id, user_id) = ?
        AND COALESCE(owner_user_id, user_id) = ?
        AND COALESCE(scope_status, 'active') = 'active'
    `).get(resolvedTenantId, userId) as { c: number };
    result.scripts.total = Number(total?.c ?? 0);

    const last30 = db.prepare(`
      SELECT COUNT(*) AS c FROM content_scripts
      WHERE COALESCE(tenant_id, user_id) = ?
        AND COALESCE(owner_user_id, user_id) = ?
        AND COALESCE(scope_status, 'active') = 'active'
        AND created_at >= datetime('now', '-30 days')
    `).get(resolvedTenantId, userId) as { c: number };
    result.scripts.last30d = Number(last30?.c ?? 0);
  }, undefined, 'scripts', { userId, tenantId: resolvedTenantId });

  // ─── Ideas ──────────────────────────────────────────────────────
  safeQuery(() => {
    const total = db.prepare(`
      SELECT COUNT(*) AS c FROM saved_ideas
      WHERE COALESCE(tenant_id, user_id) = ?
        AND COALESCE(owner_user_id, user_id) = ?
        AND COALESCE(scope_status, 'active') = 'active'
    `).get(resolvedTenantId, userId) as { c: number };
    result.ideas.total = Number(total?.c ?? 0);
  }, undefined, 'ideas', { userId, tenantId: resolvedTenantId });

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
  }, undefined, 'radarFeedback', { userId, tenantId: resolvedTenantId });

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
  }, undefined, 'performance', { userId, tenantId: resolvedTenantId });

  // ─── Highlights / warnings ──────────────────────────────────────
  if (result.topics.publishedLast30d >= 4) {
    result.highlights.push(
      `Strong publishing cadence — ${result.topics.publishedLast30d} topics published in the last 30 days.`,
    );
  }
  if (result.scripts.last30d >= 8) {
    result.highlights.push(
      `${result.scripts.last30d} scripts generated in the last 30 days — script velocity is healthy.`,
    );
  }
  if ((result.radarFeedback.byAction.accept) > (result.radarFeedback.byAction.reject)) {
    result.highlights.push(
      `Radar fit is healthy — ${result.radarFeedback.byAction.accept} accepts vs ${result.radarFeedback.byAction.reject} rejects.`,
    );
  }
  if ((result.radarFeedback.byAction.reject) > (result.radarFeedback.byAction.accept) * 2
      && result.radarFeedback.byAction.reject >= 5) {
    result.warnings.push(
      `Radar is under-fitting the profile — ${result.radarFeedback.byAction.reject} rejects vs ${result.radarFeedback.byAction.accept} accepts. Consider tightening pillars + banned topics.`,
    );
  }
  if (result.performance.last30d > 0 && result.performance.avgRetentionLast30d >= 50) {
    result.highlights.push(
      `Published content is holding attention — ${result.performance.avgRetentionLast30d}% average retention across ${result.performance.last30d} recent performance entries.`,
    );
  }
  if (result.performance.last30d > 0 && result.performance.avgRetentionLast30d < 25) {
    result.warnings.push(
      `Recent published content is under-retaining viewers at ${result.performance.avgRetentionLast30d}% average retention. Review hooks and pacing before scaling the next batch.`,
    );
  }
  if (result.topics.publishedLast30d === 0 && result.topics.total > 5) {
    result.warnings.push(
      'No topics published in the last 30 days even though the pipeline has work-in-progress. Schedule the next publish window.',
    );
  }
  if (result.scripts.total === 0 && result.topics.total >= 3) {
    result.warnings.push(
      'Topics exist but no scripts have been generated yet. Run script generation on the highest-confidence topic.',
    );
  }

  return result;
}
