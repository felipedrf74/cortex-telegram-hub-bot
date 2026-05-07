// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from '../services/database';

export interface SavedIdea {
  id: number;
  title: string;
  source_date: string;
  status: string;
  source: string;
  score: number;
  workflow_eligible: number;
  angle_tag: string | null;
  niche: string | null;
  hook_idea: string | null;
  why_now: string | null;
  created_at: string;
}

export interface SaveIdeaOptions {
  title: string;
  sourceDate: string;
  source?: string;       // 'manual' | 'discovery' | 'workflow' | 'command'
  score?: number;
  workflowEligible?: boolean;
  angleTag?: string;
  niche?: string;
  hookIdea?: string;
  whyNow?: string;
  userId: number;
}

export function saveIdea(opts: SaveIdeaOptions): SavedIdea;
export function saveIdea(
  titleOrOpts: string | SaveIdeaOptions,
  sourceDateArg?: string,
): SavedIdea {
  const db = getDb();

  // Legacy 2-arg signature
  if (typeof titleOrOpts === 'string') {
    throw new Error('userId required: use saveIdea({ title, sourceDate, userId })');
  }

  // New options signature
  const opts = titleOrOpts;
  if (!Number.isFinite(opts.userId) || opts.userId <= 0) {
    throw new Error('userId required: must be a positive integer');
  }
  const result = db.prepare(`
    INSERT INTO saved_ideas (title, source_date, source, score, workflow_eligible, angle_tag, niche, hook_idea, why_now, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.title,
    opts.sourceDate,
    opts.source || 'manual',
    opts.score || 0,
    opts.workflowEligible ? 1 : 0,
    opts.angleTag || null,
    opts.niche || null,
    opts.hookIdea || null,
    opts.whyNow || null,
    opts.userId,
  );
  return db.prepare('SELECT * FROM saved_ideas WHERE id = ?').get(result.lastInsertRowid) as SavedIdea;
}

/**
 * Closed-beta-auth-hardening (2026-05-04): the previous signature
 * accepted `userId?: number`. When omitted, the query returned every
 * user's saved ideas — a cross-tenant leak surface for any "list X
 * for current user" route that forgot to thread userId. Same shape
 * as the May-2026 fix on `getIdeasBySource`.
 *
 * Post-fix: `userId` is required. Callers MUST supply the
 * authenticated user's id explicitly; there is no all-users
 * variant.
 */
export function getSavedIdeas(status = 'saved', userId: number): SavedIdea[] {
  if (!Number.isFinite(userId) || userId <= 0) {
    throw new Error('userId required: must be a positive integer');
  }
  const db = getDb();
  return db.prepare(
    'SELECT * FROM saved_ideas WHERE status = ? AND user_id = ? ORDER BY created_at DESC'
  ).all(status, userId) as SavedIdea[];
}

/**
 * Get ideas by source type, scoped to a specific user.
 *
 * Identity-safety (May 2026 audit): every read must be user-scoped. The
 * legacy zero-arg variant of this function returned every user's rows for
 * the requested source — a cross-user data leak surface even though no
 * caller currently relies on it. The required `userId` parameter forces
 * callers to declare scope at the type level.
 */
export function getIdeasBySource(source: string, userId: number, limit = 20): SavedIdea[] {
  if (!Number.isFinite(userId) || userId <= 0) {
    throw new Error('userId required: must be a positive integer');
  }
  const db = getDb();
  return db.prepare(
    'SELECT * FROM saved_ideas WHERE source = ? AND user_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(source, userId, limit) as SavedIdea[];
}

/**
 * Get workflow-eligible ideas from discovery (last 7 days, not yet promoted).
 *
 * Closed-beta-auth-hardening (2026-05-04): `userId` is now required.
 * The previous optional signature returned every user's eligible
 * ideas when omitted — a cross-tenant leak vector. Same shape as
 * `getIdeasBySource` (May 2026 audit fix) and `getSavedIdeas`
 * (this pass).
 */
export function getWorkflowEligibleIdeas(userId: number): SavedIdea[] {
  if (!Number.isFinite(userId) || userId <= 0) {
    throw new Error('userId required: must be a positive integer');
  }
  const db = getDb();
  return db.prepare(`
    SELECT * FROM saved_ideas
    WHERE workflow_eligible = 1
      AND source = 'discovery'
      AND status = 'saved'
      AND created_at > datetime('now', '-7 days')
      AND user_id = ?
    ORDER BY score DESC
    LIMIT 10
  `).all(userId) as SavedIdea[];
}

/** Mark an idea as promoted to workflow */
export function markIdeaPromoted(id: number, userId: number): boolean {
  if (!Number.isFinite(userId) || userId <= 0) {
    throw new Error('userId required: must be a positive integer');
  }
  const db = getDb();
  const result = db.prepare(
    "UPDATE saved_ideas SET status = 'promoted' WHERE id = ? AND user_id = ?"
  ).run(id, userId);
  return result.changes > 0;
}

export function markIdeaUsed(id: number, userId: number): boolean {
  if (!Number.isFinite(userId) || userId <= 0) {
    throw new Error('userId required: must be a positive integer');
  }
  const db = getDb();
  const result = db.prepare(
    "UPDATE saved_ideas SET status = 'used' WHERE id = ? AND user_id = ?"
  ).run(id, userId);
  return result.changes > 0;
}

export function deleteIdea(id: number, userId: number): boolean {
  if (!Number.isFinite(userId) || userId <= 0) {
    throw new Error('userId required: must be a positive integer');
  }
  const db = getDb();
  const result = db.prepare('DELETE FROM saved_ideas WHERE id = ? AND user_id = ?').run(id, userId);
  return result.changes > 0;
}
