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
import { resolveChatTenantId } from './chat-tenant-scope';
import { sanitizeForPromptInterpolation } from '../utils/prompt-sanitizer';
import { taskPriorityRankSql } from './task-store/task-priority';

export type DailyContextReadStatus = 'available' | 'empty' | 'failed';

export type DailyContextProjectedSource =
  | 'tasks'
  | 'calendar'
  | 'training'
  | 'readiness'
  | 'content';

export interface DailyContextSourceProjection {
  source: DailyContextProjectedSource;
  /**
   * `unknown` is intentionally distinct from `empty`: the legacy cache stores
   * only rendered sections, so an absent section cannot prove that its source
   * was queried successfully and contained no facts.
   */
  status: 'available' | 'unknown';
  observedAt: string;
  content?: string;
  reasonCode?: string;
}

export interface DailyContextReadResult {
  status: DailyContextReadStatus;
  context: string;
  observedAt: string;
  date: string;
  staleAfter: string;
  reasonCode?: string;
  sourceProjections: DailyContextSourceProjection[];
}

export const DAILY_CONTEXT_PROJECTED_SOURCES: readonly DailyContextProjectedSource[] = [
  'tasks',
  'calendar',
  'training',
  'readiness',
  'content',
] as const;

/**
 * These Secretary sources are deliberately not represented by
 * `daily_context_cache`. Mail and reminders have no section in the builder;
 * readiness/training are derived projections and are not a complete Garmin
 * read. Callers must collect these sources through their scoped adapters and
 * must not interpret a missing daily-context section as "no mail/reminders/
 * Garmin data".
 */
export const DAILY_CONTEXT_UNREPRESENTED_SOURCES = ['mail', 'reminders', 'garmin'] as const;

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
export function getDailyContext(userId: number, tenantId?: number): string {
  return getDailyContextWithStatus(userId, tenantId).context;
}

/**
 * Status-preserving variant of `getDailyContext`.
 *
 * The legacy function must continue to return an empty string for both an
 * empty cache and a lookup failure. Structured reasoning callers use this
 * API so those states cannot be confused. The source projections expose only
 * sections actually present in the persisted summary; absent projections are
 * `unknown`, never asserted to be empty.
 */
export function getDailyContextWithStatus(userId: number, tenantId?: number): DailyContextReadResult {
  const readAt = new Date().toISOString();
  const date = todayString();
  try {
    const db = getDb();
    const scopedTenantId = resolveChatTenantId(userId, tenantId);
    const row = db.prepare(
      'SELECT context_summary, built_at FROM daily_context_cache WHERE tenant_id = ? AND user_id = ? AND date = ? AND scope_status = ?',
    ).get(scopedTenantId, userId, date, 'active') as { context_summary: string; built_at: string | null } | undefined;
    const observedAt = normalizeSqliteTimestamp(row?.built_at) ?? readAt;
    const staleAfter = new Date(Date.parse(observedAt) + 24 * 60 * 60 * 1000).toISOString();
    if (!row) {
      return {
        status: 'empty',
        context: '',
        observedAt,
        date,
        staleAfter,
        reasonCode: 'daily_context_not_materialized',
        sourceProjections: projectDailyContextSources('', observedAt),
      };
    }
    const context = row.context_summary?.trim() ?? '';
    if (!context) {
      return {
        status: 'empty',
        context: '',
        observedAt,
        date,
        staleAfter,
        reasonCode: 'daily_context_materialized_without_facts',
        sourceProjections: projectDailyContextSources('', observedAt),
      };
    }
    return {
      status: 'available',
      context,
      observedAt,
      date,
      staleAfter,
      sourceProjections: projectDailyContextSources(context, observedAt),
    };
  } catch (err) {
    logger.debug({ err, userId }, 'getDailyContext lookup failed');
    return {
      status: 'failed',
      context: '',
      observedAt: readAt,
      date,
      staleAfter: readAt,
      reasonCode: 'daily_context_read_failed',
      sourceProjections: projectDailyContextSources('', readAt),
    };
  }
}

function projectDailyContextSources(context: string, observedAt: string): DailyContextSourceProjection[] {
  const sections = new Map<DailyContextProjectedSource, string[]>();
  let activeSource: DailyContextProjectedSource | null = null;
  for (const line of context.split('\n').map((value) => value.trim()).filter(Boolean)) {
    const heading = /^(TASKS|CALENDAR|TRAINING|READINESS|CONTENT):/.exec(line)?.[1]?.toLowerCase();
    if (heading && DAILY_CONTEXT_PROJECTED_SOURCES.includes(heading as DailyContextProjectedSource)) {
      activeSource = heading as DailyContextProjectedSource;
      sections.set(activeSource, [line]);
      continue;
    }
    if (activeSource) sections.get(activeSource)?.push(line);
  }

  return DAILY_CONTEXT_PROJECTED_SOURCES.map((source) => {
    const lines = sections.get(source);
    if (lines?.length) {
      return {
        source,
        status: 'available',
        observedAt,
        content: lines.join('\n'),
      };
    }
    return {
      source,
      status: 'unknown',
      observedAt,
      reasonCode: 'daily_context_projection_absent',
    };
  });
}

function normalizeSqliteTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const candidate = /Z$|[+-]\d{2}:?\d{2}$/.test(value)
    ? value
    : `${value.replace(' ', 'T')}Z`;
  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/**
 * Drop today's cached row for a user. Next read triggers a rebuild.
 *
 * Called from task-service after every create / complete / delete so the
 * AI never sees stale "5 tasks pending" when the user just completed two.
 */
export function invalidateContextCache(userId?: number, tenantId?: number): void {
  try {
    const db = getDb();
    if (typeof userId === 'number' && Number.isFinite(userId)) {
      const scopedTenantId = resolveChatTenantId(userId, tenantId);
      db.prepare(
        'DELETE FROM daily_context_cache WHERE tenant_id = ? AND user_id = ? AND date = ?',
      ).run(scopedTenantId, userId, todayString());
      return;
    }

    db.prepare(
      'DELETE FROM daily_context_cache WHERE date = ?',
    ).run(todayString());
  } catch (err) {
    logger.debug({ err, userId }, 'invalidateContextCache failed');
  }
}

/**
 * Convenience: cached or freshly-built. Used by domain-handler on every
 * scoped chat turn (the 5 AM pre-build cron was removed 2026-07-03), so it
 * must keep getDailyContext's never-throw contract: a failed build returns
 * '' and the chat proceeds without the context block.
 */
export async function getOrBuildDailyContext(userId: number, tenantId?: number): Promise<string> {
  const cached = getDailyContext(userId, tenantId);
  if (cached) return cached;
  try {
    return await buildDailyContext(userId, tenantId);
  } catch (err) {
    logger.debug({ err, userId }, 'getOrBuildDailyContext build failed (continuing without context)');
    return '';
  }
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
export async function buildDailyContext(userId: number, tenantId?: number): Promise<string> {
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
         ORDER BY ${taskPriorityRankSql('priority')} ASC LIMIT 5`,
      ).all(userId) as { title: string }[];

      if (dueToday.length > 0) {
        parts.push(`Due today: ${dueToday.map((t) => sanitizeForPromptInterpolation(t.title)).join(', ')}`);
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
          const title = sanitizeForPromptInterpolation(e.summary || e.subject || e.title || '(untitled)');
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
    const scopedTenantId = typeof tenantId === 'number' && Number.isSafeInteger(tenantId) && tenantId > 0
      ? tenantId
      : null;
    const plan = scopedTenantId ? getActivePlan(userId, scopedTenantId) : null;
    if (plan) {
      const currentWeek = getCurrentWeek(plan.id);
      if (currentWeek) {
        const sessions = getSessionsForWeek(currentWeek.id);
        const todayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });
        const today = sessions?.find((s: any) => s.day_of_week === todayName);
        if (today) {
          parts.push(`TRAINING: ${sanitizeForPromptInterpolation(today.title || today.session_type)} (${sanitizeForPromptInterpolation(today.status)})`);
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
    // Identity-safety (May 2026 audit): scope strictly by user_id. Earlier
    // code used `user_id IN (0, ?)` to mix system seeds (user_id = 0) into
    // every user's pipeline count; that allowed any non-zero user's
    // accidentally-zero-keyed row to leak into other users' counts. The
    // strict per-user scope removes that risk surface entirely. System
    // seeds, if needed, should now be surfaced via an explicit, audited
    // path that does not coalesce with per-user data.
    const pipeline = db.prepare(
      `SELECT COUNT(*) AS cnt FROM saved_ideas WHERE user_id = ? AND status = 'saved'`,
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
    const scopedTenantId = resolveChatTenantId(userId, tenantId);
    db.prepare(
      `INSERT INTO daily_context_cache (tenant_id, user_id, scope_status, context_summary, date, built_at)
       VALUES (?, ?, 'active', ?, ?, datetime('now'))
       ON CONFLICT(tenant_id, user_id, date) DO UPDATE SET
         context_summary = excluded.context_summary,
         scope_status = excluded.scope_status,
         built_at = excluded.built_at`,
    ).run(scopedTenantId, userId, summary, todayString());
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
