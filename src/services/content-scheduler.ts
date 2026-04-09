// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Content Scheduler Service
 *
 * TASK-14 Phase 2 — backs the iOS Content skill's Topic scheduler card.
 * Owns a user's self-created topics with optional publish dates: the
 * "here are the videos I plan to make in the next month" workflow.
 *
 * Distinct from `content-workflow.ts`:
 *   - content-workflow.ts → AI-generated topic CANDIDATES the user
 *     approves/rejects (sentiment-driven, runs inside the pipeline
 *     agent cron)
 *   - content-scheduler.ts → user's OWN manually-entered topics with
 *     optional publish dates, edited and reviewed interactively
 *
 * Both feed into the broader "content pipeline" concept but have
 * different data shapes and lifecycles, so they live in separate
 * tables (content_topic_feedback vs content_topics) and separate
 * service files.
 *
 * Status lifecycle:
 *   planned   → drafting → ready → published  (forward, happy path)
 *                                  → cancelled (abandoned, terminal)
 *
 * The service is deliberately boring: thin CRUD + one helper for the
 * "upcoming within N days" query the iOS landing page needs to show a
 * preview count. Anything smarter (AI prompts, calendar integration,
 * topic → pipeline advance) is intentionally out of scope for this
 * module.
 */

import { getDb } from './database';
import { logger } from '../utils/logger';

// ─── Types ──────────────────────────────────────────────────────────

export type ContentTopicStatus =
  | 'planned'
  | 'drafting'
  | 'ready'
  | 'published'
  | 'cancelled';

export interface ContentTopic {
  id: number;
  user_id: number;
  title: string;
  notes: string | null;
  scheduled_date: string | null;   // YYYY-MM-DD, nullable
  status: ContentTopicStatus;
  created_at: string;
  updated_at: string;
}

/** Valid status transitions — enforced at the route layer. */
export const CONTENT_TOPIC_STATUSES: ContentTopicStatus[] = [
  'planned',
  'drafting',
  'ready',
  'published',
  'cancelled',
];

// ─── Create ─────────────────────────────────────────────────────────

export function addTopic(
  userId: number,
  title: string,
  opts?: {
    notes?: string | null;
    scheduledDate?: string | null;
    status?: ContentTopicStatus;
  },
): ContentTopic {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO content_topics (user_id, title, notes, scheduled_date, status)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      userId,
      title,
      opts?.notes ?? null,
      opts?.scheduledDate ?? null,
      opts?.status ?? 'planned',
    );

  const row = db
    .prepare('SELECT * FROM content_topics WHERE id = ?')
    .get(result.lastInsertRowid) as ContentTopic;

  logger.info(
    { userId, topicId: row.id, title, status: row.status, scheduledDate: row.scheduled_date },
    'Content topic created',
  );
  return row;
}

// ─── Read ───────────────────────────────────────────────────────────

/**
 * List topics for a user, with optional filters. Sort order:
 *   1. Scheduled topics first, ordered by scheduled_date ASC
 *   2. Unscheduled topics last, ordered by updated_at DESC
 *
 * This matches the iOS UI expectation: the upcoming timeline at the
 * top of the view, then "later" topics at the bottom.
 */
export function getTopics(
  userId: number,
  filters?: {
    status?: ContentTopicStatus;
    /** Only topics with scheduled_date >= this date (YYYY-MM-DD). */
    from?: string;
    /** Only topics with scheduled_date <= this date (YYYY-MM-DD). */
    to?: string;
    /** If true, only return scheduled topics (excludes null dates). */
    scheduledOnly?: boolean;
    /** Exclude cancelled + published by default — caller can opt in. */
    includeTerminal?: boolean;
    limit?: number;
  },
): ContentTopic[] {
  const db = getDb();
  const conditions: string[] = ['user_id = ?'];
  const params: any[] = [userId];

  if (filters?.status) {
    conditions.push('status = ?');
    params.push(filters.status);
  } else if (!filters?.includeTerminal) {
    // Default: hide cancelled topics. Published topics stay visible
    // because the user often wants to see "what did I ship lately?"
    // immediately after a publish.
    conditions.push("status != 'cancelled'");
  }

  if (filters?.scheduledOnly) {
    conditions.push('scheduled_date IS NOT NULL');
  }

  if (filters?.from) {
    conditions.push('(scheduled_date IS NULL OR scheduled_date >= ?)');
    params.push(filters.from);
  }

  if (filters?.to) {
    conditions.push('(scheduled_date IS NULL OR scheduled_date <= ?)');
    params.push(filters.to);
  }

  // Composite sort: scheduled topics first by date, unscheduled last
  // by updated_at descending.
  const sql = `
    SELECT *
    FROM content_topics
    WHERE ${conditions.join(' AND ')}
    ORDER BY
      CASE WHEN scheduled_date IS NULL THEN 1 ELSE 0 END,
      scheduled_date ASC,
      updated_at DESC
    LIMIT ?
  `;
  params.push(filters?.limit ?? 100);

  return db.prepare(sql).all(...params) as ContentTopic[];
}

/** Fetch a single topic by id, scoped to user_id. Returns null on miss. */
export function getTopicById(userId: number, topicId: number): ContentTopic | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM content_topics WHERE id = ? AND user_id = ?')
    .get(topicId, userId) as ContentTopic | undefined;
  return row ?? null;
}

/**
 * Count of topics scheduled within the next N days (default: 14).
 * Used by the iOS Content skill landing page's Topic scheduler card
 * subtitle ("3 topics this week") without loading the full list.
 */
export function getUpcomingTopicCount(
  userId: number,
  daysAhead: number = 14,
): number {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const future = new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
  const result = db
    .prepare(
      `SELECT COUNT(*) as count
       FROM content_topics
       WHERE user_id = ?
         AND scheduled_date IS NOT NULL
         AND scheduled_date >= ?
         AND scheduled_date <= ?
         AND status NOT IN ('cancelled', 'published')`,
    )
    .get(userId, today, future) as { count: number };
  return result.count;
}

// ─── Update ─────────────────────────────────────────────────────────

/**
 * Patch a topic. Only the fields present in `updates` are written.
 * `scheduled_date` and `notes` accept explicit null to clear.
 * `status` is validated against the CONTENT_TOPIC_STATUSES allow-list.
 *
 * Returns the updated row, or null if no row matched.
 */
export function updateTopic(
  userId: number,
  topicId: number,
  updates: {
    title?: string;
    notes?: string | null;
    scheduled_date?: string | null;
    status?: ContentTopicStatus;
  },
): ContentTopic | null {
  const db = getDb();

  const setParts: string[] = [];
  const params: any[] = [];

  if (updates.title !== undefined) {
    setParts.push('title = ?');
    params.push(updates.title);
  }
  if (updates.notes !== undefined) {
    setParts.push('notes = ?');
    params.push(updates.notes);
  }
  if (updates.scheduled_date !== undefined) {
    setParts.push('scheduled_date = ?');
    params.push(updates.scheduled_date);
  }
  if (updates.status !== undefined) {
    if (!CONTENT_TOPIC_STATUSES.includes(updates.status)) {
      throw new Error(`Invalid status: ${updates.status}`);
    }
    setParts.push('status = ?');
    params.push(updates.status);
  }

  if (setParts.length > 0) {
    // Always bump updated_at on any write — drives the "last touched"
    // sort order for unscheduled topics.
    setParts.push("updated_at = datetime('now')");

    const sql = `UPDATE content_topics SET ${setParts.join(', ')} WHERE id = ? AND user_id = ?`;
    params.push(topicId, userId);
    const result = db.prepare(sql).run(...params);
    if (result.changes === 0) return null;
    logger.info({ userId, topicId, updates }, 'Content topic updated');
  }

  return getTopicById(userId, topicId);
}

// ─── Delete ─────────────────────────────────────────────────────────

/**
 * Hard-delete a topic. Returns true if a row was removed.
 * Note: the UI can also "cancel" (soft-delete) via updateTopic with
 * status='cancelled' — that preserves history for later review.
 */
export function deleteTopic(userId: number, topicId: number): boolean {
  const db = getDb();
  const result = db
    .prepare('DELETE FROM content_topics WHERE id = ? AND user_id = ?')
    .run(topicId, userId);
  if (result.changes > 0) {
    logger.info({ userId, topicId }, 'Content topic deleted');
    return true;
  }
  return false;
}
