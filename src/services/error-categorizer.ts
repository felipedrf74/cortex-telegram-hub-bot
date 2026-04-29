// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Error Categorizer — classifies failures by type and recommends retry strategies.
 *
 * Used by the dispatcher/agent flow to make intelligent retry decisions
 * instead of naive fail→retry loops.
 */

import { getDb } from './database';
import { logger } from '../utils/logger';
import { pushEvent } from '../portal/telemetry';
import { sanitizeLogText } from '../utils/log-sanitizer';

// ─── Error Taxonomy ──────────────────────────────────────────────

export type ErrorCategory =
  | 'syntax'
  | 'logic'
  | 'integration'
  | 'timeout'
  | 'rate_limit'
  | 'context_overflow'
  | 'test_failure'
  | 'unknown';

export type RetryStrategy =
  | 'auto_fix'
  | 'backoff_retry'
  | 'summarize_retry'
  | 'escalate'
  | 'wait_retry';

export interface CategorizedError {
  category: ErrorCategory;
  strategy: RetryStrategy;
  maxRetries: number;
  backoffMs: number;
  hint?: string;
}

// ─── Classification patterns ─────────────────────────────────────

const PATTERNS: Array<{ pattern: RegExp; category: ErrorCategory }> = [
  { pattern: /SyntaxError|Unexpected token|Cannot find module/i, category: 'syntax' },
  { pattern: /TypeError|ReferenceError|is not a function|is not defined/i, category: 'syntax' },
  { pattern: /tsc.*error TS/i, category: 'syntax' },
  { pattern: /FAIL.*\.test\.ts|AssertionError|expect\(.*\)\.to/i, category: 'test_failure' },
  { pattern: /vitest.*failed/i, category: 'test_failure' },
  { pattern: /timeout|ETIMEDOUT|ECONNABORTED|deadline exceeded/i, category: 'timeout' },
  { pattern: /429|rate.?limit|too many requests/i, category: 'rate_limit' },
  { pattern: /token.*limit|context.*length|max.*tokens/i, category: 'context_overflow' },
  { pattern: /ECONNREFUSED|ENOTFOUND|503|502|500|network error/i, category: 'integration' },
  { pattern: /notion.*error|telegram.*error|api.*error/i, category: 'integration' },
];

// ─── Strategy mapping ────────────────────────────────────────────

const STRATEGY_MAP: Record<ErrorCategory, Omit<CategorizedError, 'category' | 'hint'>> = {
  syntax:           { strategy: 'auto_fix',        maxRetries: 3, backoffMs: 0 },
  test_failure:     { strategy: 'auto_fix',        maxRetries: 3, backoffMs: 0 },
  logic:            { strategy: 'auto_fix',        maxRetries: 2, backoffMs: 0 },
  timeout:          { strategy: 'backoff_retry',   maxRetries: 3, backoffMs: 5000 },
  rate_limit:       { strategy: 'wait_retry',      maxRetries: 5, backoffMs: 60000 },
  context_overflow: { strategy: 'summarize_retry', maxRetries: 2, backoffMs: 0 },
  integration:      { strategy: 'backoff_retry',   maxRetries: 3, backoffMs: 10000 },
  unknown:          { strategy: 'escalate',        maxRetries: 1, backoffMs: 0 },
};

// ─── Public API ──────────────────────────────────────────────────

/**
 * Classify an error message and return the recommended retry strategy.
 */
export function categorizeError(errorMessage: string, stack?: string): CategorizedError {
  const fullText = `${errorMessage} ${stack ?? ''}`;

  for (const { pattern, category } of PATTERNS) {
    if (pattern.test(fullText)) {
      const base = STRATEGY_MAP[category];
      return {
        category,
        ...base,
        hint: buildHint(category, errorMessage),
      };
    }
  }

  return { category: 'unknown', ...STRATEGY_MAP.unknown };
}

function buildHint(category: ErrorCategory, message: string): string {
  const safeMessage = sanitizeLogText(message);
  switch (category) {
    case 'syntax':
      return `Fix the syntax/type error. Error: ${safeMessage.slice(0, 200)}`;
    case 'test_failure':
      return `Tests are failing. Read the test output and fix the implementation. Error: ${safeMessage.slice(0, 200)}`;
    case 'context_overflow':
      return 'Reduce the context size: summarize long files, remove unnecessary context, focus on the specific task.';
    case 'rate_limit':
      return 'Rate limit hit. Waiting before retry.';
    default:
      return '';
  }
}

/**
 * Log a categorized error to the database for trend analysis.
 */
export function logCategorizedError(
  taskId: string,
  agent: string,
  errorMessage: string,
  categorized: CategorizedError,
  retryAttempt: number
): void {
  const db = getDb();
  const safeErrorMessage = sanitizeLogText(errorMessage);

  db.prepare(`
    INSERT INTO error_log (level, source, message, context)
    VALUES ('error', 'agent', ?, ?)
  `).run(
    safeErrorMessage.slice(0, 500),
    JSON.stringify({
      taskId,
      agent,
      category: categorized.category,
      strategy: categorized.strategy,
      retryAttempt,
      maxRetries: categorized.maxRetries,
    })
  );

  pushEvent({
    ts: new Date().toISOString(),
    type: 'error',
    summary: `[${categorized.category}] ${agent}: ${safeErrorMessage.slice(0, 60)}`,
    detail: `Strategy: ${categorized.strategy}, retry ${retryAttempt}/${categorized.maxRetries}`,
  });

  logger.warn({
    taskId, agent,
    category: categorized.category,
    strategy: categorized.strategy,
    retryAttempt,
  }, 'Categorized error logged');
}

/**
 * Determine if we should retry or escalate.
 */
export function shouldRetry(categorized: CategorizedError, currentRetry: number): boolean {
  return currentRetry < categorized.maxRetries;
}

/**
 * Get error distribution for portal dashboard.
 */
export function getErrorDistribution(days: number = 7): Record<string, number> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      json_extract(context, '$.category') as category,
      COUNT(*) as count
    FROM error_log
    WHERE source = 'agent'
      AND ts >= datetime('now', '-' || ? || ' days')
      AND context IS NOT NULL
    GROUP BY category
  `).all(days) as Array<{ category: string; count: number }>;

  const result: Record<string, number> = {};
  for (const row of rows) {
    if (row.category) result[row.category] = row.count;
  }
  return result;
}
