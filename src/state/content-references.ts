// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from '../services/database';
import {
  contentScopeForInsert,
  contentScopeOrderExpr,
  contentScopeParams,
  contentScopePredicate,
  platformContentScopePredicate,
  ensureContentTenantScopeColumns,
  isAuthorizedContentRow,
  type ContentVisibilityScope,
} from '../services/content-tenant-scope';

// ─── Types ──────────────────────────────────────────────────────────

export type ContentOwnerScope = 'system' | 'user';

function resolveContentOwnerScope(userId: number): ContentOwnerScope {
  return userId === 0 ? 'system' : 'user';
}

function effectiveContentOwnerScope(row: { owner_scope?: string | null; user_id?: number | null }): ContentOwnerScope {
  if (row.owner_scope === 'system') return 'system';
  if (row.owner_scope === 'user') return 'user';
  return row.user_id === 0 ? 'system' : 'user';
}

function isUserOwnedContentRow(
  row: { owner_scope?: string | null; user_id?: number | null },
  userId?: number,
): boolean {
  return userId != null && row.user_id === userId && effectiveContentOwnerScope(row) === 'user';
}

function dedupeScopedRows<T extends { owner_scope?: string | null; user_id?: number | null }>(
  rows: T[],
  keyFn: (row: T) => string,
  userId?: number,
): T[] {
  if (userId == null) return rows;
  const deduped = new Map<string, T>();
  for (const row of rows) {
    const key = keyFn(row);
    const existing = deduped.get(key);
    if (!existing || (isUserOwnedContentRow(row, userId) && !isUserOwnedContentRow(existing, userId))) {
      deduped.set(key, row);
    }
  }
  return Array.from(deduped.values());
}

export interface ContentRefChannel {
  id: number;
  channel_url: string;
  channel_name: string | null;
  channel_id: string | null;
  status: 'pending' | 'analyzing' | 'active' | 'failed';
  last_analyzed_at: string | null;
  video_count_analyzed: number;
  error_message: string | null;
  added_via: string;
  created_at: string;
  updated_at: string;
  user_id?: number;
  owner_scope?: ContentOwnerScope | null;
  tenant_id?: number | null;
  owner_user_id?: number | null;
  visibility_scope?: string | null;
  scope_status?: string | null;
}

export interface ContentPattern {
  id: number;
  channel_id: number;
  category: string;
  pattern_text: string;
  examples: string; // JSON array
  confidence: number;
  source_videos: string; // JSON array
  created_at: string;
  updated_at: string;
  user_id?: number;
  tenant_id?: number | null;
  owner_user_id?: number | null;
  visibility_scope?: string | null;
  scope_status?: string | null;
}

export interface ContentKnowledge {
  id: number;
  category: string;
  synthesized_text: string;
  source_channels: string; // JSON array
  version: number;
  created_at: string;
  updated_at: string;
  user_id?: number;
  owner_scope?: ContentOwnerScope | null;
  tenant_id?: number | null;
  owner_user_id?: number | null;
  visibility_scope?: string | null;
  scope_status?: string | null;
}

// ─── Pattern categories ──────────────────────────────────────────────

export const PATTERN_CATEGORIES = [
  'hook_style',
  'title_pattern',
  'content_structure',
  'editing_style',
  'storytelling',
  'cta_pattern',
  'audience_engagement',
  'visual_style',
  'brand_voice',
] as const;

export type PatternCategory = typeof PATTERN_CATEGORIES[number];

function visibilityScopeForSystemOrUser(
  userId: number,
  visibilityScope?: string | null,
): ContentVisibilityScope {
  if (visibilityScope === 'tenant_shared' || visibilityScope === 'tenant_admin_visible'
    || visibilityScope === 'platform_internal' || visibilityScope === 'public_published') {
    return visibilityScope;
  }
  return userId > 0 ? 'user_private' : 'platform_internal';
}

// ─── Channel CRUD ───────────────────────────────────────────────────

export function addChannel(
  channelUrl: string,
  addedVia: 'manual' | 'portal' | 'bot' | 'ios' = 'manual',
  userId: number = 0,
  tenantId?: number,
): ContentRefChannel {
  const db = getDb();
  ensureContentTenantScopeColumns(db);
  const ownerScope = resolveContentOwnerScope(userId);
  const scope = contentScopeForInsert(
    userId,
    userId > 0 ? tenantId : 0,
    visibilityScopeForSystemOrUser(userId),
  );
  // Normalize URL: strip trailing slashes, ensure consistent format
  const normalized = channelUrl.trim().replace(/\/+$/, '');

  const existing = db.prepare(
    `SELECT * FROM content_ref_channels
      WHERE channel_url = ?
        AND ${contentScopePredicate()}`,
  ).get(normalized, ...contentScopeParams(userId, tenantId)) as ContentRefChannel | undefined;

  if (existing) {
    // Re-enable if it was previously removed/failed
    if (existing.status === 'failed') {
      db.prepare(`
        UPDATE content_ref_channels
        SET status = 'pending', error_message = NULL, updated_at = datetime('now')
        WHERE id = ?
      `).run(existing.id);
    }
    return db.prepare('SELECT * FROM content_ref_channels WHERE id = ?')
      .get(existing.id) as ContentRefChannel;
  }

  const result = db.prepare(`
    INSERT INTO content_ref_channels (
      channel_url, added_via, user_id, owner_scope, tenant_id, owner_user_id,
      visibility_scope, lifecycle_state, scope_status, created_by, updated_by, audit_metadata_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    normalized,
    addedVia,
    userId,
    ownerScope,
    scope.tenantId,
    scope.ownerUserId,
    scope.visibilityScope,
    'pending',
    scope.scopeStatus,
    scope.createdBy,
    scope.updatedBy,
    scope.auditMetadataJson,
  );

  return db.prepare('SELECT * FROM content_ref_channels WHERE id = ?')
    .get(result.lastInsertRowid) as ContentRefChannel;
}

export function getChannel(id: number): ContentRefChannel | undefined {
  const db = getDb();
  ensureContentTenantScopeColumns(db);
  return db.prepare('SELECT * FROM content_ref_channels WHERE id = ?')
    .get(id) as ContentRefChannel | undefined;
}

export function getAllChannels(userId?: number, tenantId?: number): ContentRefChannel[] {
  const db = getDb();
  ensureContentTenantScopeColumns(db);
  if (userId != null) {
    if (userId === 0) {
      return db.prepare(
        `SELECT * FROM content_ref_channels
          WHERE ${platformContentScopePredicate()}
          ORDER BY status ASC, channel_name ASC`,
      ).all() as ContentRefChannel[];
    }
    const rows = db.prepare(
      `SELECT * FROM content_ref_channels
        WHERE ${contentScopePredicate()}
        ORDER BY ${contentScopeOrderExpr(undefined, userId)},
                 status ASC,
                 channel_name ASC`,
    ).all(...contentScopeParams(userId, tenantId)) as ContentRefChannel[];
    return dedupeScopedRows(rows, (row) => row.channel_url, userId);
  }
  return db.prepare(
    'SELECT * FROM content_ref_channels ORDER BY status ASC, channel_name ASC',
  ).all() as ContentRefChannel[];
}

export function getActiveChannels(userId?: number, tenantId?: number): ContentRefChannel[] {
  const db = getDb();
  ensureContentTenantScopeColumns(db);
  if (userId != null) {
    if (userId === 0) {
      return db.prepare(
        `SELECT * FROM content_ref_channels
          WHERE status = 'active'
            AND ${platformContentScopePredicate()}
          ORDER BY channel_name ASC`,
      ).all() as ContentRefChannel[];
    }
    const rows = db.prepare(
      `SELECT * FROM content_ref_channels
        WHERE status = 'active'
          AND ${contentScopePredicate()}
        ORDER BY ${contentScopeOrderExpr(undefined, userId)},
                 channel_name ASC`,
    ).all(...contentScopeParams(userId, tenantId)) as ContentRefChannel[];
    return dedupeScopedRows(rows, (row) => row.channel_url, userId);
  }
  return db.prepare(
    "SELECT * FROM content_ref_channels WHERE status = 'active' ORDER BY channel_name ASC",
  ).all() as ContentRefChannel[];
}

export function getPendingChannels(userId?: number, tenantId?: number): ContentRefChannel[] {
  const db = getDb();
  ensureContentTenantScopeColumns(db);
  if (userId != null) {
    if (userId === 0) {
      return db.prepare(
        `SELECT * FROM content_ref_channels
          WHERE status = 'pending'
            AND ${platformContentScopePredicate()}
          ORDER BY created_at ASC`,
      ).all() as ContentRefChannel[];
    }
    const rows = db.prepare(
      `SELECT * FROM content_ref_channels
        WHERE status = 'pending'
          AND ${contentScopePredicate()}
        ORDER BY ${contentScopeOrderExpr(undefined, userId)},
                 created_at ASC`,
    ).all(...contentScopeParams(userId, tenantId)) as ContentRefChannel[];
    return dedupeScopedRows(rows, (row) => row.channel_url, userId);
  }
  return db.prepare(
    "SELECT * FROM content_ref_channels WHERE status = 'pending' ORDER BY created_at ASC",
  ).all() as ContentRefChannel[];
}

export function updateChannelStatus(
  id: number,
  status: ContentRefChannel['status'],
  extra?: {
    channel_name?: string;
    channel_id?: string;
    video_count_analyzed?: number;
    error_message?: string | null;
  },
): void {
  const db = getDb();
  const sets: string[] = ['status = ?', "updated_at = datetime('now')"];
  const params: unknown[] = [status];

  if (status === 'active' || status === 'analyzing') {
    sets.push("last_analyzed_at = datetime('now')");
  }
  if (extra?.channel_name) {
    sets.push('channel_name = ?');
    params.push(extra.channel_name);
  }
  if (extra?.channel_id) {
    sets.push('channel_id = ?');
    params.push(extra.channel_id);
  }
  if (extra?.video_count_analyzed !== undefined) {
    sets.push('video_count_analyzed = ?');
    params.push(extra.video_count_analyzed);
  }
  if (extra?.error_message !== undefined) {
    sets.push('error_message = ?');
    params.push(extra.error_message);
  }

  params.push(id);
  db.prepare(`UPDATE content_ref_channels SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

export function removeChannel(id: number): boolean {
  const db = getDb();
  ensureContentTenantScopeColumns(db);
  // Delete patterns first (cascade), then channel
  db.prepare('DELETE FROM content_patterns WHERE channel_id = ?').run(id);
  const result = db.prepare('DELETE FROM content_ref_channels WHERE id = ?').run(id);
  return result.changes > 0;
}

// ─── Pattern CRUD ───────────────────────────────────────────────────

export function upsertPatterns(
  channelId: number,
  patterns: {
    category: PatternCategory;
    pattern_text: string;
    examples: string[];
    confidence: number;
    source_videos: string[];
  }[],
): void {
  const db = getDb();
  ensureContentTenantScopeColumns(db);
  const channel = getChannel(channelId);
  const patternUserId = channel?.user_id ?? 0;
  const scope = contentScopeForInsert(
    patternUserId,
    patternUserId > 0 ? channel?.tenant_id ?? undefined : 0,
    visibilityScopeForSystemOrUser(patternUserId, channel?.visibility_scope),
  );
  // Clear old patterns for this channel before inserting new ones
  db.prepare('DELETE FROM content_patterns WHERE channel_id = ?').run(channelId);

  const stmt = db.prepare(`
    INSERT INTO content_patterns (
      channel_id, category, pattern_text, examples, confidence, source_videos,
      user_id, tenant_id, owner_user_id, visibility_scope, lifecycle_state,
      scope_status, created_by, updated_by, audit_metadata_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((items: typeof patterns) => {
    for (const p of items) {
      stmt.run(
        channelId,
        p.category,
        p.pattern_text,
        JSON.stringify(p.examples),
        p.confidence,
        JSON.stringify(p.source_videos),
        channel?.user_id ?? 0,
        scope.tenantId,
        scope.ownerUserId,
        scope.visibilityScope,
        scope.lifecycleState,
        scope.scopeStatus,
        scope.createdBy,
        scope.updatedBy,
        scope.auditMetadataJson,
      );
    }
  });

  insertMany(patterns);
}

export function getPatternsForChannel(channelId: number): ContentPattern[] {
  const db = getDb();
  ensureContentTenantScopeColumns(db);
  return db.prepare(
    'SELECT * FROM content_patterns WHERE channel_id = ? ORDER BY category, confidence DESC',
  ).all(channelId) as ContentPattern[];
}

export function getAllPatternsByCategory(category: PatternCategory, userId?: number, tenantId?: number): ContentPattern[] {
  const db = getDb();
  ensureContentTenantScopeColumns(db);
  if (userId != null) {
    if (userId === 0) {
      return db.prepare(
        `SELECT p.*, c.channel_name
           FROM content_patterns p
           JOIN content_ref_channels c ON p.channel_id = c.id
          WHERE p.category = ?
            AND c.status = ?
            AND ${platformContentScopePredicate('c')}
            AND ${platformContentScopePredicate('p')}
          ORDER BY p.confidence DESC`,
      ).all(category, 'active') as (ContentPattern & { channel_name: string })[];
    }
    return db.prepare(
      `SELECT p.*, c.channel_name
         FROM content_patterns p
         JOIN content_ref_channels c ON p.channel_id = c.id
        WHERE p.category = ?
          AND c.status = ?
          AND ${contentScopePredicate('c')}
          AND ${contentScopePredicate('p')}
        ORDER BY p.confidence DESC`,
    ).all(
      category,
      'active',
      ...contentScopeParams(userId, tenantId),
      ...contentScopeParams(userId, tenantId),
    ) as (ContentPattern & { channel_name: string })[];
  }
  return db.prepare(
    'SELECT p.*, c.channel_name FROM content_patterns p JOIN content_ref_channels c ON p.channel_id = c.id WHERE p.category = ? AND c.status = ? ORDER BY p.confidence DESC',
  ).all(category, 'active') as (ContentPattern & { channel_name: string })[];
}

// ─── Knowledge (Synthesized) ─────────────────────────────────────────

export function upsertKnowledge(
  category: PatternCategory,
  synthesizedText: string,
  sourceChannels: string[],
  userId: number = 0,
  tenantId?: number,
): void {
  const db = getDb();
  ensureContentTenantScopeColumns(db);
  const ownerScope = resolveContentOwnerScope(userId);
  const scope = contentScopeForInsert(
    userId,
    userId > 0 ? tenantId : 0,
    visibilityScopeForSystemOrUser(userId),
  );
  db.prepare(`
    INSERT INTO content_knowledge (
      category, synthesized_text, source_channels, user_id, owner_scope,
      tenant_id, owner_user_id, visibility_scope, lifecycle_state, scope_status,
      created_by, updated_by, audit_metadata_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, category) DO UPDATE SET
      synthesized_text = excluded.synthesized_text,
      source_channels = excluded.source_channels,
      owner_scope = excluded.owner_scope,
      tenant_id = excluded.tenant_id,
      owner_user_id = excluded.owner_user_id,
      visibility_scope = excluded.visibility_scope,
      lifecycle_state = excluded.lifecycle_state,
      scope_status = excluded.scope_status,
      updated_by = excluded.updated_by,
      version = content_knowledge.version + 1,
      updated_at = datetime('now')
  `).run(
    category,
    synthesizedText,
    JSON.stringify(sourceChannels),
    userId,
    ownerScope,
    scope.tenantId,
    scope.ownerUserId,
    scope.visibilityScope,
    scope.lifecycleState,
    scope.scopeStatus,
    scope.createdBy,
    scope.updatedBy,
    scope.auditMetadataJson,
  );
}

export function getAllKnowledge(userId?: number, tenantId?: number): ContentKnowledge[] {
  const db = getDb();
  ensureContentTenantScopeColumns(db);
  if (userId != null) {
    if (userId === 0) {
      return db.prepare(
        `SELECT * FROM content_knowledge
          WHERE ${platformContentScopePredicate()}
          ORDER BY category ASC, updated_at DESC`,
      ).all() as ContentKnowledge[];
    }
    const rows = db.prepare(
      `SELECT * FROM content_knowledge
        WHERE ${contentScopePredicate()}
        ORDER BY ${contentScopeOrderExpr(undefined, userId)},
                 category ASC,
                 updated_at DESC`,
    ).all(...contentScopeParams(userId, tenantId)) as ContentKnowledge[];
    return dedupeScopedRows(rows, (row) => row.category, userId);
  }
  return db.prepare(
    'SELECT * FROM content_knowledge ORDER BY category ASC',
  ).all() as ContentKnowledge[];
}

export function getKnowledgeByCategory(
  category: PatternCategory,
  userId?: number,
  tenantId?: number,
): ContentKnowledge | undefined {
  const db = getDb();
  ensureContentTenantScopeColumns(db);
  if (userId != null) {
    if (userId === 0) {
      return db.prepare(
        `SELECT * FROM content_knowledge
          WHERE category = ?
            AND ${platformContentScopePredicate()}
          ORDER BY updated_at DESC
          LIMIT 1`,
      ).get(category) as ContentKnowledge | undefined;
    }
    return db.prepare(
      `SELECT * FROM content_knowledge
        WHERE category = ?
          AND ${contentScopePredicate()}
        ORDER BY ${contentScopeOrderExpr(undefined, userId)},
                 updated_at DESC
        LIMIT 1`,
    ).get(category, ...contentScopeParams(userId, tenantId)) as ContentKnowledge | undefined;
  }
  return db.prepare(
    'SELECT * FROM content_knowledge WHERE category = ?',
  ).get(category) as ContentKnowledge | undefined;
}

/**
 * Build a compact knowledge summary for injection into the content domain system prompt.
 * Returns empty string if no knowledge has been synthesized yet.
 */
export function buildKnowledgePromptBlock(userId?: number, tenantId?: number): string {
  const knowledge = getAllKnowledge(userId, tenantId)
    .filter((row) => userId == null || isAuthorizedContentRow(row, { userId, tenantId }));
  if (knowledge.length === 0) return '';

  const CATEGORY_LABELS: Record<string, string> = {
    hook_style: '🎣 Hook Styles',
    title_pattern: '🏷️ Title Patterns',
    content_structure: '🏗️ Content Structure',
    editing_style: '✂️ Editing & Pacing',
    storytelling: '📖 Storytelling Techniques',
    cta_pattern: '📢 CTA Patterns',
    audience_engagement: '💬 Audience Engagement',
    visual_style: '🎨 Visual Style',
    brand_voice: '🗣️ Brand Voice',
  };

  const lines: string[] = [
    '\n[LEARNED CONTENT PATTERNS — from reference creators]',
    'These patterns were extracted from successful YouTube creators. Use them as inspiration — adapt to the authenticated creator\'s saved Voice DNA / brand voice for this user and tenant, never copy verbatim. Do not assume any founder, owner, or default creator identity.\n',
  ];

  for (const k of knowledge) {
    const label = CATEGORY_LABELS[k.category] || k.category;
    const sources = JSON.parse(k.source_channels) as string[];
    lines.push(`${label} (from: ${sources.join(', ')})`);
    lines.push(k.synthesized_text);
    lines.push('');
  }

  return lines.join('\n');
}
