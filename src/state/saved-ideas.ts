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
}

export function saveIdea(opts: SaveIdeaOptions): SavedIdea;
export function saveIdea(title: string, sourceDate: string): SavedIdea;
export function saveIdea(
  titleOrOpts: string | SaveIdeaOptions,
  sourceDateArg?: string,
): SavedIdea {
  const db = getDb();

  // Legacy 2-arg signature
  if (typeof titleOrOpts === 'string') {
    const result = db.prepare(
      'INSERT INTO saved_ideas (title, source_date, user_id) VALUES (?, ?, ?)'
    ).run(titleOrOpts, sourceDateArg!, 0);
    return db.prepare('SELECT * FROM saved_ideas WHERE id = ?').get(result.lastInsertRowid) as SavedIdea;
  }

  // New options signature
  const opts = titleOrOpts;
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
    (opts as any).userId ?? 0,
  );
  return db.prepare('SELECT * FROM saved_ideas WHERE id = ?').get(result.lastInsertRowid) as SavedIdea;
}

export function getSavedIdeas(status = 'saved', userId?: number): SavedIdea[] {
  const db = getDb();
  if (userId != null) {
    return db.prepare(
      'SELECT * FROM saved_ideas WHERE status = ? AND user_id = ? ORDER BY created_at DESC'
    ).all(status, userId) as SavedIdea[];
  }
  return db.prepare(
    'SELECT * FROM saved_ideas WHERE status = ? ORDER BY created_at DESC'
  ).all(status) as SavedIdea[];
}

/** Get ideas by source type */
export function getIdeasBySource(source: string, limit = 20): SavedIdea[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM saved_ideas WHERE source = ? ORDER BY created_at DESC LIMIT ?'
  ).all(source, limit) as SavedIdea[];
}

/**
 * Get workflow-eligible ideas from discovery (last 7 days, not yet promoted).
 *
 * @param userId — scope to this user's ideas. If omitted, returns ideas
 *   for all users (backward compat for legacy callers). New callers
 *   MUST pass userId for proper multi-tenant isolation.
 */
export function getWorkflowEligibleIdeas(userId?: number): SavedIdea[] {
  const db = getDb();
  const userClause = userId != null ? 'AND user_id = ?' : '';
  const params: any[] = [];
  if (userId != null) params.push(userId);
  return db.prepare(`
    SELECT * FROM saved_ideas
    WHERE workflow_eligible = 1
      AND source = 'discovery'
      AND status = 'saved'
      AND created_at > datetime('now', '-7 days')
      ${userClause}
    ORDER BY score DESC
    LIMIT 10
  `).all(...params) as SavedIdea[];
}

/** Mark an idea as promoted to workflow */
export function markIdeaPromoted(id: number): boolean {
  const db = getDb();
  const result = db.prepare(
    "UPDATE saved_ideas SET status = 'promoted' WHERE id = ?"
  ).run(id);
  return result.changes > 0;
}

export function markIdeaUsed(id: number): boolean {
  const db = getDb();
  const result = db.prepare(
    "UPDATE saved_ideas SET status = 'used' WHERE id = ?"
  ).run(id);
  return result.changes > 0;
}

export function deleteIdea(id: number): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM saved_ideas WHERE id = ?').run(id);
  return result.changes > 0;
}
