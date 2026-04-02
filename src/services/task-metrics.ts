// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Task Execution Metrics — tracks cost and duration per Notion task execution.
 *
 * Aggregates API usage (from anthropic-hook.ts) at the task level.
 * Provides data for the portal dashboard and SaaS pricing decisions.
 */

import { getDb } from './database';
import { logger } from '../utils/logger';

export interface TaskExecution {
  id?: number;
  notionTaskId: string;
  taskTitle: string;
  agent: string;
  status: 'running' | 'success' | 'failed';
  startTime: string;
  endTime?: string;
  durationMs?: number;
  apiCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  errorMessage?: string;
  retryCount: number;
}

/**
 * Start tracking a task execution. Returns the row ID for later update.
 */
export function startTaskExecution(notionTaskId: string, taskTitle: string, agent: string): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO task_execution_metrics (notion_task_id, task_title, agent, status, start_time)
    VALUES (?, ?, ?, 'running', datetime('now'))
  `);
  const result = stmt.run(notionTaskId, taskTitle, agent);
  logger.info({ notionTaskId, taskTitle, agent }, 'Task execution started');
  return Number(result.lastInsertRowid);
}

/**
 * Complete a task execution with final metrics.
 */
export function completeTaskExecution(
  executionId: number,
  status: 'success' | 'failed',
  metrics: {
    apiCalls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    errorMessage?: string;
    retryCount?: number;
  }
): void {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE task_execution_metrics
    SET status = ?,
        end_time = datetime('now'),
        duration_ms = CAST((julianday('now') - julianday(start_time)) * 86400000 AS INTEGER),
        api_calls = ?,
        input_tokens = ?,
        output_tokens = ?,
        total_tokens = ? + ?,
        cost_usd = ?,
        error_message = ?,
        retry_count = ?
    WHERE id = ?
  `);
  stmt.run(
    status,
    metrics.apiCalls,
    metrics.inputTokens,
    metrics.outputTokens,
    metrics.inputTokens, metrics.outputTokens,
    metrics.costUsd,
    metrics.errorMessage ?? null,
    metrics.retryCount ?? 0,
    executionId
  );
  logger.info({ executionId, status, costUsd: metrics.costUsd }, 'Task execution completed');
}

/**
 * Query task execution summaries for the portal dashboard.
 */
export function getTaskExecutionSummary(days: number = 7): {
  totalTasks: number;
  totalCost: number;
  avgDurationMs: number;
  costByAgent: Record<string, number>;
  failureRate: number;
} {
  const db = getDb();

  const totals = db.prepare(`
    SELECT
      COUNT(*) as totalTasks,
      COALESCE(SUM(cost_usd), 0) as totalCost,
      COALESCE(AVG(duration_ms), 0) as avgDurationMs,
      COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failures
    FROM task_execution_metrics
    WHERE ts >= datetime('now', '-' || ? || ' days')
  `).get(days) as { totalTasks: number; totalCost: number; avgDurationMs: number; failures: number };

  const byAgent = db.prepare(`
    SELECT agent, COALESCE(SUM(cost_usd), 0) as cost
    FROM task_execution_metrics
    WHERE ts >= datetime('now', '-' || ? || ' days')
    GROUP BY agent
  `).all(days) as Array<{ agent: string; cost: number }>;

  const costByAgent: Record<string, number> = {};
  for (const row of byAgent) {
    costByAgent[row.agent] = row.cost;
  }

  return {
    totalTasks: totals.totalTasks,
    totalCost: totals.totalCost,
    avgDurationMs: totals.avgDurationMs,
    costByAgent,
    failureRate: totals.totalTasks > 0 ? totals.failures / totals.totalTasks : 0,
  };
}

/**
 * Get recent task executions for portal table.
 */
export function getRecentExecutions(limit: number = 20): TaskExecution[] {
  const db = getDb();
  return db.prepare(`
    SELECT
      id, notion_task_id as notionTaskId, task_title as taskTitle, agent,
      status, start_time as startTime, end_time as endTime,
      duration_ms as durationMs, api_calls as apiCalls,
      input_tokens as inputTokens, output_tokens as outputTokens,
      total_tokens as totalTokens, cost_usd as costUsd,
      error_message as errorMessage, retry_count as retryCount
    FROM task_execution_metrics
    ORDER BY ts DESC LIMIT ?
  `).all(limit) as TaskExecution[];
}
