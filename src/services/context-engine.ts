// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Cross-Domain Context Engine
 *
 * Builds a ~500-token "daily context summary" for each active user that
 * gets injected into EVERY AI call as system context. This is the core
 * cost-optimization for cross-domain intelligence:
 *
 *   Without it: every AI message triggers 5+ tool calls (list_tasks,
 *               get_calendar, get_training, get_content_pipeline,
 *               get_wearable) totaling ~1350 tokens of speculative I/O
 *               BEFORE the model starts reasoning.
 *
 *   With it:    one ~500-token block of pre-baked summary, refreshed at
 *               5 AM and on every task write. Model has the same context
 *               at fixed cost.
 *
 * The cache is persisted in `daily_context_cache` (PK on user_id, date)
 * so it survives restarts and only rebuilds at the scheduled hour or on
 * explicit invalidation. Mid-day mutations (task complete, calendar
 * change) call `invalidateContextCache` to drop today's row — the next
 * AI request triggers a synchronous rebuild.
 */

import { getDb } from './database';
import { logger } from '../utils/logger';
import { now } from '../utils/date-parser';
import { config } from '../config';

// ─── Cache primitives ──────────────────────────────────────────────────

/** Today's date in the user's local timezone (YYYY-MM-DD). */
function todayString(): string {
  return now().toFormat('yyyy-MM-dd');
}

/**
 * Look up the cached context for today. Returns empty string if no row
 * exists — never throws, never falls back to building. Callers that want
 * "either cached or freshly built" should use `getOrBuildDailyContext`.
 */
export function getDailyContext(userId: number): string {
  try {
    const db = getDb();
    const row = db.prepare(
      'SELECT context_summary FROM daily_context_cache WHERE user_id = ? AND date = ?',
    ).get(userId, todayString()) as { context_summary: string } | undefined;
    return row?.context_summary || '';
  } catch (err) {
    logger.debug({ err, userId }, 'getDailyContext lookup failed');
    return '';
  }
}

/**
 * Drop today's cached row for a user. Next read triggers a rebuild.
 *
 * Called from task-service after every create / complete / delete so the
 * AI never sees stale "5 tasks pending" when the user just completed two.
 */
export function invalidateContextCache(userId?: number): void {
  try {
    const db = getDb();
    if (typeof userId === 'number' && Number.isFinite(userId)) {
      db.prepare(
        'DELETE FROM daily_context_cache WHERE user_id = ? AND date = ?',
      ).run(userId, todayString());
      return;
    }

    db.prepare(
      'DELETE FROM daily_context_cache WHERE date = ?',
    ).run(todayString());
  } catch (err) {
    logger.debug({ err, userId }, 'invalidateContextCache failed');
  }
}

/** Convenience: cached or freshly-built. Used by domain-handler. */
export async function getOrBuildDailyContext(userId: number): Promise<string> {
  const cached = getDailyContext(userId);
  if (cached) return cached;
  return await buildDailyContext(userId);
}

// ─── Builder ───────────────────────────────────────────────────────────

/**
 * Build the daily context summary for a user from scratch and persist it.
 *
 * Each section is wrapped in its own try/catch so a missing wearable, an
 * empty calendar, or a user without an active training plan never blocks
 * the rest of the summary from rendering. Worst case: a user with zero
 * data gets an empty string, the AI falls back to its tool-using behavior,
 * and the cron retries tomorrow.
 *
 * Token budget: ~500 tokens (~1500 chars). Sections that don't fit are
 * truncated with a "+N more" suffix. The hard cap is enforced at the end
 * to prevent a runaway context blowing up the system prompt.
 */
export async function buildDailyContext(userId: number): Promise<string> {
  const parts: string[] = [];
  const db = getDb();

  // ── Tasks (from unified store — zero API calls) ─────────────────────
  try {
    const counts = db.prepare(
      `SELECT
         SUM(CASE WHEN status = 'pending' AND is_deleted = 0 AND date(due_date) < date('now') THEN 1 ELSE 0 END) AS overdue,
         SUM(CASE WHEN status = 'pending' AND is_deleted = 0 AND date(due_date) = date('now') THEN 1 ELSE 0 END) AS due_today,
         SUM(CASE WHEN status = 'pending' AND is_deleted = 0 THEN 1 ELSE 0 END) AS pending
       FROM unified_tasks WHERE user_id = ?`,
    ).get(userId) as { overdue: number | null; due_today: number | null; pending: number | null };

    const overdueCount = counts.overdue || 0;
    const dueTodayCount = counts.due_today || 0;
    const pendingCount = counts.pending || 0;

    if (pendingCount > 0 || overdueCount > 0) {
      parts.push(`TASKS: ${overdueCount} overdue, ${dueTodayCount} due today, ${pendingCount} total pending`);

      // List up to 5 tasks due today by priority for AI specificity
      const dueToday = db.prepare(
        `SELECT title FROM unified_tasks
         WHERE user_id = ? AND status = 'pending' AND is_deleted = 0 AND date(due_date) = date('now')
         ORDER BY priority DESC LIMIT 5`,
      ).all(userId) as { title: string }[];

      if (dueToday.length > 0) {
        parts.push(`Due today: ${dueToday.map((t) => t.title).join(', ')}`);
      }
    }
  } catch (err) {
    logger.debug({ err, userId }, 'context: tasks section failed');
  }

  // ── Calendar (today's events) ───────────────────────────────────────
  try {
    // Lazy require to avoid circular imports — unified-calendar pulls in
    // outlook + google + auth, which transitively imports a lot.
    const { getEvents, hasConnectedCalendarForUser } = require('./unified-calendar');
    if (hasConnectedCalendarForUser(userId)) {
      const start = now().startOf('day').toISO();
      const end = now().endOf('day').toISO();
      const events = await getEvents(start, end, userId);
      if (Array.isArray(events) && events.length > 0) {
        const top = events.slice(0, 6).map((e: any) => {
          const t = e.start?.dateTime || e.start;
          const timeMatch = String(t || '').match(/T(\d{2}:\d{2})/);
          const time = timeMatch ? timeMatch[1] : '?';
          const title = e.summary || e.subject || e.title || '(untitled)';
          return `${time} ${title}`;
        });
        parts.push(`CALENDAR: ${events.length} events today`);
        parts.push(top.join(' | '));
      }
    }
  } catch (err) {
    logger.debug({ err, userId }, 'context: calendar section failed');
  }

  // ── Training (active plan + today's session) ────────────────────────
  try {
    const { getActivePlan, getCurrentWeek, getSessionsForWeek } = require('./training-plans');
    const plan = getActivePlan(userId);
    if (plan) {
      const currentWeek = getCurrentWeek(plan.id);
      if (currentWeek) {
        const sessions = getSessionsForWeek(currentWeek.id);
        const todayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });
        const today = sessions?.find((s: any) => s.day_of_week === todayName);
        if (today) {
          parts.push(`TRAINING: ${today.title || today.session_type} (${today.status})`);
        } else {
          parts.push(`TRAINING: Rest day`);
        }
      }
    }
  } catch (err) {
    logger.debug({ err, userId }, 'context: training section failed');
  }

  // ── Readiness (cached score + recommendation) ───────────────────────
  try {
    const readiness = db.prepare(
      `SELECT score, recommendation FROM readiness_scores
       WHERE user_id = ? AND date = date('now')`,
    ).get(userId) as { score: number; recommendation: string } | undefined;
    if (readiness) {
      const tier = readiness.score >= 70 ? 'green' : readiness.score >= 40 ? 'yellow' : 'red';
      parts.push(`READINESS: ${readiness.score}/100 (${tier}) — ${readiness.recommendation}`);
    }
  } catch (err) {
    logger.debug({ err, userId }, 'context: readiness section failed');
  }

  // ── Content pipeline (saved ideas count) ────────────────────────────
  try {
    // saved_ideas.status enum: 'saved' | 'promoted' | 'used'
    // 'saved' means in the pipeline and not yet acted on
    // SECURITY FIX: filter by user_id to prevent cross-user count leakage
    const pipeline = db.prepare(
      `SELECT COUNT(*) AS cnt FROM saved_ideas WHERE user_id IN (0, ?) AND status = 'saved'`,
    ).get(userId) as { cnt: number };
    if (pipeline.cnt > 0) {
      parts.push(`CONTENT: ${pipeline.cnt} ideas saved in pipeline`);
    }
  } catch (err) {
    logger.debug({ err, userId }, 'context: content section failed');
  }

  const summary = enforceTokenBudget(parts.join('\n'));

  // Persist to cache (PK conflict → overwrite the existing row)
  try {
    db.prepare(
      `INSERT INTO daily_context_cache (user_id, date, context_summary, built_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(user_id, date) DO UPDATE SET
         context_summary = excluded.context_summary,
         built_at = excluded.built_at`,
    ).run(userId, todayString(), summary);
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to persist daily context cache');
  }

  return summary;
}

/**
 * Enforce a soft 1500-char (~500 token) cap on the summary. Adds a marker
 * if truncation happens so the AI knows it's seeing a partial view.
 */
function enforceTokenBudget(summary: string): string {
  const MAX_CHARS = 1500;
  if (summary.length <= MAX_CHARS) return summary;
  return summary.slice(0, MAX_CHARS - 20).trimEnd() + '\n[…truncated]';
}

// ─── Build all users (called by 5 AM cron) ─────────────────────────────

/**
 * Rebuild context for every active user. Called by the daily_context cron.
 *
 * Sequential rather than parallel: per-user build is fast (<200ms each)
 * and SQLite is single-writer, so parallelism only adds contention.
 */
export async function buildContextForAllUsers(userIds: number[]): Promise<{
  built: number;
  failed: number;
  durationMs: number;
}> {
  const start = Date.now();
  let built = 0;
  let failed = 0;

  for (const userId of userIds) {
    try {
      await buildDailyContext(userId);
      built++;
    } catch (err) {
      failed++;
      logger.warn({ err, userId }, 'Daily context build failed');
    }
  }

  return { built, failed, durationMs: Date.now() - start };
}

/** Test-only: clear the cache table. */
export function _resetContextCacheForTests(): void {
  try {
    getDb().exec('DELETE FROM daily_context_cache');
  } catch { /* ignore */ }
}

// Re-export for callers that want a typed view of the active user list
export { config };
