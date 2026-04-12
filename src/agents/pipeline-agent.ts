// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Pipeline Tracker Agent — monitors content pipeline stages,
 * detects bottlenecks, and adjusts topic generation pace.
 *
 * Schedule: Daily at 20:00
 */

import { writeSignal, readSignals, logAgentRun } from '../services/intelligence-bus';
import { buildAgentContext } from '../services/cross-agent-learning';
import { getDb } from '../services/database';
import { logger } from '../utils/logger';

// Stage thresholds (days) before a bottleneck is flagged
const STAGE_THRESHOLDS: Record<string, number> = {
  approved: 3,   // approved → scripted
  scripted: 7,   // scripted → filming
  filming: 5,    // filming → editing
  editing: 3,    // editing → published
};

const STAGE_ORDER = ['approved', 'scripted', 'filming', 'editing', 'published'];

export interface PipelineStats {
  stages: Record<string, number>;
  bottleneck: { stage: string; count: number; avgDays: number } | null;
  publishedThisWeek: number;
  totalActive: number;
}

export function getPipelineStats(): PipelineStats {
  const db = getDb();
  const stages: Record<string, number> = {};
  for (const stage of STAGE_ORDER) {
    const row = db.prepare(
      "SELECT COUNT(*) as cnt FROM content_pipeline WHERE stage = ?"
    ).get(stage) as any;
    stages[stage] = row?.cnt ?? 0;
  }

  // Find bottleneck — stage with items stuck longer than threshold
  let bottleneck: PipelineStats['bottleneck'] = null;
  for (const [stage, thresholdDays] of Object.entries(STAGE_THRESHOLDS)) {
    const stuck = db.prepare(`
      SELECT COUNT(*) as cnt,
             AVG(julianday('now') - julianday(updated_at)) as avg_days
      FROM content_pipeline
      WHERE stage = ?
        AND julianday('now') - julianday(updated_at) > ?
    `).get(stage, thresholdDays) as any;

    if (stuck?.cnt > 0 && (!bottleneck || stuck.cnt > bottleneck.count)) {
      bottleneck = {
        stage,
        count: stuck.cnt,
        avgDays: Math.round(stuck.avg_days * 10) / 10,
      };
    }
  }

  // Published this week
  const pubRow = db.prepare(`
    SELECT COUNT(*) as cnt FROM content_pipeline
    WHERE stage = 'published'
      AND updated_at >= datetime('now', '-7 days')
  `).get() as any;

  return {
    stages,
    bottleneck,
    publishedThisWeek: pubRow?.cnt ?? 0,
    totalActive: Object.entries(stages)
      .filter(([s]) => s !== 'published')
      .reduce((sum, [, n]) => sum + n, 0),
  };
}

export function advancePipelineStage(
  topicTitle: string,
  newStage: string,
  extra?: { script_path?: string; drive_url?: string; youtube_video_id?: string },
): boolean {
  const db = getDb();
  // Find the pipeline entry by fuzzy title match
  const entry = db.prepare(`
    SELECT id, stage, stage_history FROM content_pipeline
    WHERE topic_title = ? OR topic_title LIKE ?
    ORDER BY created_at DESC LIMIT 1
  `).get(topicTitle, `%${topicTitle.slice(0, 30)}%`) as any;

  if (!entry) return false;

  const history: any[] = JSON.parse(entry.stage_history || '[]');
  history.push({ from: entry.stage, to: newStage, at: new Date().toISOString() });

  const sets = ['stage = ?', 'stage_history = ?', "updated_at = datetime('now')"];
  const params: any[] = [newStage, JSON.stringify(history)];

  if (extra?.script_path) { sets.push('script_path = ?'); params.push(extra.script_path); }
  if (extra?.drive_url) { sets.push('drive_url = ?'); params.push(extra.drive_url); }
  if (extra?.youtube_video_id) { sets.push('youtube_video_id = ?'); params.push(extra.youtube_video_id); }

  params.push(entry.id);
  db.prepare(`UPDATE content_pipeline SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return true;
}

// ─── Operational Metrics (April 2026) ──────────────────────────────
//
// These metrics power the portal pipeline dashboard and the iOS
// content health card. They answer operational questions:
//   - What's my idea → publish conversion rate?
//   - How long do scripts sit before getting filmed?
//   - Which format or niche is stuck?
//   - What inventory is going stale?

export interface PipelineOperationalMetrics {
  /** % of approved topics that eventually get published (all time). */
  approvalToPublishRate: number;
  /** % of topics that get a script generated. */
  approvalToScriptRate: number;
  /** Average days per stage transition (for completed items). */
  avgDaysPerStage: Record<string, number>;
  /** Items per stage that haven't moved in >N days (threshold-specific). */
  staleInventory: Array<{ id: number; title: string; stage: string; daysStuck: number; niche: string | null }>;
  /** Format distribution of active pipeline items. */
  formatDistribution: Record<string, number>;
  /** Weekly throughput: items published per week over last 4 weeks. */
  weeklyThroughput: number[];
  /** Total items that have ever entered the pipeline. */
  totalEverEntered: number;
  /** Total items published. */
  totalPublished: number;
}

export function getPipelineOperationalMetrics(): PipelineOperationalMetrics {
  const db = getDb();

  // Total counts
  const totalRow = db.prepare('SELECT COUNT(*) as cnt FROM content_pipeline').get() as any;
  const totalEverEntered = totalRow?.cnt ?? 0;

  const pubRow = db.prepare("SELECT COUNT(*) as cnt FROM content_pipeline WHERE stage = 'published'").get() as any;
  const totalPublished = pubRow?.cnt ?? 0;

  const scriptedRow = db.prepare("SELECT COUNT(*) as cnt FROM content_pipeline WHERE stage IN ('scripted','filming','editing','published')").get() as any;
  const totalScripted = scriptedRow?.cnt ?? 0;

  // Conversion rates
  const approvalToPublishRate = totalEverEntered > 0
    ? Math.round((totalPublished / totalEverEntered) * 100)
    : 0;
  const approvalToScriptRate = totalEverEntered > 0
    ? Math.round((totalScripted / totalEverEntered) * 100)
    : 0;

  // Average days per stage (from stage_history JSON)
  const avgDaysPerStage: Record<string, number> = {};
  const publishedItems = db.prepare(
    "SELECT stage_history FROM content_pipeline WHERE stage = 'published' AND stage_history != '[]'",
  ).all() as any[];

  const stageDurations: Record<string, number[]> = {};
  for (const item of publishedItems) {
    try {
      const history = JSON.parse(item.stage_history || '[]') as Array<{ from?: string; to: string; at: string }>;
      for (let i = 1; i < history.length; i++) {
        const prev = history[i - 1];
        const curr = history[i];
        const stage = prev.to || prev.from || 'unknown';
        const days = (new Date(curr.at).getTime() - new Date(prev.at).getTime()) / (24 * 3600_000);
        if (!stageDurations[stage]) stageDurations[stage] = [];
        stageDurations[stage].push(days);
      }
    } catch { /* skip malformed history */ }
  }
  for (const [stage, durations] of Object.entries(stageDurations)) {
    avgDaysPerStage[stage] = Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10;
  }

  // Stale inventory
  const staleItems = db.prepare(`
    SELECT id, topic_title, stage, niche,
           ROUND(julianday('now') - julianday(updated_at), 1) as days_stuck
    FROM content_pipeline
    WHERE stage != 'published'
      AND julianday('now') - julianday(updated_at) > 3
    ORDER BY days_stuck DESC
    LIMIT 20
  `).all() as any[];

  const staleInventory = staleItems.map((r: any) => ({
    id: r.id,
    title: r.topic_title,
    stage: r.stage,
    daysStuck: r.days_stuck,
    niche: r.niche,
  }));

  // Format distribution (from linked topic_feedback)
  const formatRows = db.prepare(`
    SELECT COALESCE(tf.format, 'unknown') as fmt, COUNT(*) as cnt
    FROM content_pipeline p
    LEFT JOIN content_topic_feedback tf ON p.topic_feedback_id = tf.id
    WHERE p.stage != 'published'
    GROUP BY fmt
  `).all() as any[];

  const formatDistribution: Record<string, number> = {};
  for (const r of formatRows) {
    formatDistribution[r.fmt] = r.cnt;
  }

  // Weekly throughput (last 4 weeks)
  const weeklyThroughput: number[] = [];
  for (let i = 0; i < 4; i++) {
    const row = db.prepare(`
      SELECT COUNT(*) as cnt FROM content_pipeline
      WHERE stage = 'published'
        AND updated_at >= datetime('now', '-' || ? || ' days')
        AND updated_at < datetime('now', '-' || ? || ' days')
    `).get((i + 1) * 7, i * 7) as any;
    weeklyThroughput.push(row?.cnt ?? 0);
  }
  weeklyThroughput.reverse(); // oldest first

  return {
    approvalToPublishRate,
    approvalToScriptRate,
    avgDaysPerStage,
    staleInventory,
    formatDistribution,
    weeklyThroughput,
    totalEverEntered,
    totalPublished,
  };
}

export function createPipelineEntry(
  topicTitle: string,
  niche: string | null,
  feedbackId?: number,
): number {
  const db = getDb();
  const history = JSON.stringify([{ to: 'approved', at: new Date().toISOString() }]);
  const result = db.prepare(`
    INSERT INTO content_pipeline (topic_feedback_id, topic_title, niche, stage, stage_history)
    VALUES (?, ?, ?, 'approved', ?)
  `).run(feedbackId ?? null, topicTitle, niche, history);
  return (result as any).lastInsertRowid ?? -1;
}

export async function runPipelineAgent(): Promise<void> {
  const start = Date.now();
  let signalsProduced = 0;
  let signalsConsumed = 0;

  try {
    const stats = getPipelineStats();

    // Cross-agent learning: consume keyword + hook signals to prioritize pipeline items
    const peerContext = buildAgentContext('pipeline-agent');
    signalsConsumed += peerContext.signalsConsumed;

    // Check for sprint mode
    const sprintSignals = readSignals('pipeline-agent', ['content_sprint_mode'], 1);
    const sprintMode = sprintSignals.length > 0;

    if (stats.bottleneck && !sprintMode) {
      writeSignal({
        source_agent: 'pipeline-agent',
        signal_type: 'pipeline_bottleneck',
        payload: {
          bottleneck_stage: stats.bottleneck.stage,
          stuck_count: stats.bottleneck.count,
          avg_days_stuck: stats.bottleneck.avgDays,
          recommendation: `Reduce topic generation — ${stats.bottleneck.count} items stuck at "${stats.bottleneck.stage}" for avg ${stats.bottleneck.avgDays} days`,
          stats,
        },
      });
      signalsProduced++;
    } else {
      writeSignal({
        source_agent: 'pipeline-agent',
        signal_type: 'pipeline_capacity',
        payload: {
          active_items: stats.totalActive,
          published_this_week: stats.publishedThisWeek,
          sprint_mode: sprintMode,
          stats,
        },
      });
      signalsProduced++;
    }

    logAgentRun('pipeline-agent', 'success', signalsProduced, signalsConsumed, Date.now() - start);
    logger.info({ stats, signalsProduced }, 'Pipeline agent completed');
  } catch (err: any) {
    logAgentRun('pipeline-agent', 'error', signalsProduced, signalsConsumed, Date.now() - start, err.message);
    logger.error({ err }, 'Pipeline agent failed');
    throw err;
  }
}
