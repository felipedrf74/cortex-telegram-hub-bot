// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Pipeline Tracker Agent — monitors content pipeline stages,
 * detects bottlenecks, and adjusts topic generation pace.
 *
 * Schedule: Daily at 20:00
 */

import { writeSignal, readSignals, logAgentRun } from '../services/intelligence-bus';
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

  try {
    const stats = getPipelineStats();

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

    logAgentRun('pipeline-agent', 'success', signalsProduced, 0, Date.now() - start);
    logger.info({ stats, signalsProduced }, 'Pipeline agent completed');
  } catch (err: any) {
    logAgentRun('pipeline-agent', 'error', signalsProduced, 0, Date.now() - start, err.message);
    logger.error({ err }, 'Pipeline agent failed');
    throw err;
  }
}
