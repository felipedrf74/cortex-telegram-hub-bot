// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Pipeline Tracker Agent — monitors content pipeline stages,
 * detects bottlenecks, and adjusts topic generation pace.
 *
 * Schedule: Daily at 20:00
 */

import { writeGovernedSignal, readSignals, logAgentRun } from '../services/intelligence-bus';
import { buildAgentContext } from '../services/cross-agent-learning';
import {
  getContentWorkspacePipelineOperationalMetrics,
  getContentWorkspacePipelineStats,
  type ContentWorkspacePipelineOperationalMetrics,
  type ContentWorkspacePipelineStats,
} from '../services/content-workspace-read-models';
import type { ContentWorkspaceScope } from '../services/content-workspace';
import { logger } from '../utils/logger';

const PIPELINE_SIGNAL_PRODUCER_VERSION = 'pipeline-agent.v2';

export type PipelineStats = ContentWorkspacePipelineStats;

export function getPipelineStats(scope: ContentWorkspaceScope): PipelineStats {
  return getContentWorkspacePipelineStats(scope);
}

// ─── Operational Metrics (April 2026) ──────────────────────────────
//
// These metrics power the portal pipeline dashboard and the iOS
// content health card. They answer operational questions:
//   - What's my idea → publish conversion rate?
//   - How long do scripts sit before getting filmed?
//   - Which format or niche is stuck?
//   - What inventory is going stale?

export type PipelineOperationalMetrics = ContentWorkspacePipelineOperationalMetrics;

export function getPipelineOperationalMetrics(
  scope: ContentWorkspaceScope,
): PipelineOperationalMetrics {
  return getContentWorkspacePipelineOperationalMetrics(scope);
}

export async function runPipelineAgent(scope: ContentWorkspaceScope): Promise<void> {
  const start = Date.now();
  let signalsProduced = 0;
  let signalsConsumed = 0;

  try {
    const stats = getPipelineStats(scope);

    // Cross-agent learning: consume keyword + hook signals to prioritize pipeline items
    const peerContext = buildAgentContext('pipeline-agent', scope.userId, scope.tenantId);
    signalsConsumed += peerContext.signalsConsumed;

    // Check for sprint mode
    const sprintSignals = readSignals('pipeline-agent', ['content_sprint_mode'], 1, scope.userId, undefined, scope.tenantId);
    const sprintMode = sprintSignals.length > 0;

    if (stats.bottleneck && !sprintMode) {
      const signalId = writeGovernedSignal({
        source_agent: 'pipeline-agent',
        signal_type: 'pipeline_bottleneck',
        provenance: {
          producerVersion: PIPELINE_SIGNAL_PRODUCER_VERSION,
          source: 'runtime',
          observedAt: new Date().toISOString(),
        },
        payload: {
          bottleneck_stage: stats.bottleneck.stage,
          stuck_count: stats.bottleneck.count,
          avg_days_stuck: stats.bottleneck.avgDays,
          recommendation: `Reduce topic generation — ${stats.bottleneck.count} items stuck at "${stats.bottleneck.stage}" for avg ${stats.bottleneck.avgDays} days`,
          stats,
        },
        user_id: scope.userId,
        tenant_id: scope.tenantId,
      });
      if (signalId > 0) signalsProduced++;
    } else {
      const signalId = writeGovernedSignal({
        source_agent: 'pipeline-agent',
        signal_type: 'pipeline_capacity',
        provenance: {
          producerVersion: PIPELINE_SIGNAL_PRODUCER_VERSION,
          source: 'runtime',
          observedAt: new Date().toISOString(),
        },
        payload: {
          active_items: stats.totalActive,
          published_this_week: stats.publishedThisWeek,
          sprint_mode: sprintMode,
          stats,
        },
        user_id: scope.userId,
        tenant_id: scope.tenantId,
      });
      if (signalId > 0) signalsProduced++;
    }

    logAgentRun('pipeline-agent', 'success', signalsProduced, signalsConsumed, Date.now() - start);
    logger.info({ stats, signalsProduced }, 'Pipeline agent completed');
  } catch (err: any) {
    logAgentRun('pipeline-agent', 'error', signalsProduced, signalsConsumed, Date.now() - start, err.message);
    logger.error({ err }, 'Pipeline agent failed');
    throw err;
  }
}
