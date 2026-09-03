// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Content Dashboard Service — canonical read models for portal + API.
 *
 * This service centralizes all content dashboard queries so the portal
 * and iOS API share one authoritative read path. No more duplicated
 * SQL across content-dashboard.ts and portal/server.ts.
 *
 * Rule: if a canonical domain service exists (content-references.ts,
 * pipeline-agent.ts, intelligence-bus.ts), we call it. We only add
 * new queries here for cross-domain aggregations that don't belong
 * in any single domain service.
 */

import { getDb } from './database';
import { logger } from '../utils/logger';
import { dismissSignal, writeGovernedSignal } from './intelligence-bus';
import {
  getContentWorkspaceRecentItems,
  type ContentWorkspaceRecentItem,
} from './content-workspace-read-models';
import type { ContentWorkspaceScope } from './content-workspace';
import {
  contentPrivateScopeParams,
  contentPrivateScopePredicate,
  contentScopeOrderExpr,
  contentScopeParams,
  contentScopePredicate,
  ensureContentTenantScopeColumns,
  platformOrSystemSeedContentScopePredicate,
} from './content-tenant-scope';
import { safeContentLogErrorFields } from './content-log-safety';

const CONTENT_DASHBOARD_SIGNAL_PRODUCER_VERSION = 'content-dashboard-service.v1';

function db() {
  return getDb();
}

function effectiveContentOwnerScope(row: { owner_scope?: string | null; user_id?: number | null }): 'system' | 'user' {
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

// ═══════════════════════════════════════════════════════════════════
// Books
// ═══════════════════════════════════════════════════════════════════

export interface BookSummary {
  id: number;
  title: string;
  author: string;
  status: string;
  thesis: string | null;
  frameworks: any[];
  pillars: any[];
  timesReferenced: number;
  createdAt: string;
}

export interface BooksOverview {
  total: number;
  extracted: number;
  pending: number;
  rows: BookSummary[];
}

/**
 * Get books with aggregate counts. Used by both portal GET /api/books
 * and content-dashboard.ts books section.
 *
 * @param limit - max books to return
 * @param dbOverride - optional DB reference (for test environments where
 *   the module-level getDb mock may not propagate to dynamic requires)
 */
export function getBooks(limit = 50, dbOverride?: any, userId?: number, tenantId?: number): BooksOverview {
  const d = dbOverride || db();
  ensureContentTenantScopeColumns(d);
  const rows = userId != null
    ? d.prepare(`
        SELECT id, title, author, core_thesis, key_frameworks, pillar_mapping,
               extraction_status, times_referenced, created_at, user_id, owner_scope,
               tenant_id, owner_user_id, visibility_scope, scope_status
        FROM book_library
        WHERE ${contentScopePredicate()}
        ORDER BY ${contentScopeOrderExpr(undefined, userId)},
                 times_referenced DESC,
                 created_at DESC
        LIMIT ?
      `).all(...contentScopeParams(userId, tenantId), limit * 2) as any[]
    : d.prepare(`
        SELECT id, title, author, core_thesis, key_frameworks, pillar_mapping,
               extraction_status, times_referenced, created_at, user_id, owner_scope,
               tenant_id, owner_user_id, visibility_scope, scope_status
        FROM book_library
        WHERE ${platformOrSystemSeedContentScopePredicate()}
        ORDER BY times_referenced DESC, created_at DESC
        LIMIT ?
      `).all(limit) as any[];

  const dedupedRows = dedupeScopedRows(rows, (row) => `${row.title}::${row.author}`, userId).slice(0, limit);
  const totals = dedupedRows.reduce((acc, row) => {
    acc.total += 1;
    if (row.extraction_status === 'extracted') acc.extracted += 1;
    if (row.extraction_status === 'pending' || row.extraction_status === 'extracting') acc.pending += 1;
    return acc;
  }, { total: 0, extracted: 0, pending: 0 });

  return {
    total: totals?.total ?? 0,
    extracted: totals?.extracted ?? 0,
    pending: totals?.pending ?? 0,
    rows: dedupedRows.map(r => ({
      id: r.id,
      title: r.title,
      author: r.author,
      status: r.extraction_status,
      thesis: r.core_thesis,
      frameworks: safeJsonArray(r.key_frameworks),
      pillars: safeJsonArray(r.pillar_mapping),
      timesReferenced: r.times_referenced ?? 0,
      createdAt: r.created_at,
    })),
  };
}

// ═══════════════════════════════════════════════════════════════════
// Voice DNA / Content Knowledge
// ═══════════════════════════════════════════════════════════════════

const CATEGORY_LABELS: Record<string, string> = {
  hook_style: 'Hook Styles',
  title_pattern: 'Title Patterns',
  content_structure: 'Content Structure',
  editing_style: 'Editing Style',
  storytelling: 'Storytelling',
  cta_pattern: 'CTA Patterns',
  audience_engagement: 'Audience Engagement',
  visual_branding: 'Visual Branding',
  brand_voice: 'Brand Voice',
  addition_pattern: 'Additions (Voice Evolution)',
  removal_pattern: 'Removals (Voice Evolution)',
  rephrasing_pattern: 'Rephrasings (Voice Evolution)',
  book_influence: 'Book Influence',
  voice_summary: 'Voice Summary',
};

export interface VoiceDnaEntry {
  id: number;
  category: string;
  label: string;
  text: string;
  sources: string[];
  version: number;
  updatedAt: string;
}

export class ContentKnowledgeUnavailableError extends Error {
  readonly code = 'CONTENT_KNOWLEDGE_UNAVAILABLE';
  readonly status = 503;
  readonly details = { retryable: true } as const;

  constructor() {
    super('Content voice and knowledge data is temporarily unavailable.');
    this.name = 'ContentKnowledgeUnavailableError';
  }
}

interface ContentKnowledgeReadOptions {
  strict?: boolean;
}

/**
 * Get voice DNA entries with human-readable labels.
 * Reads from content_knowledge table (same data as getAllKnowledge()
 * in content-references.ts) with added label mapping for the dashboard.
 */
export function getVoiceDna(
  dbOverride?: any,
  userId?: number,
  tenantId?: number,
  options: ContentKnowledgeReadOptions = {},
): VoiceDnaEntry[] {
  try {
  const d = dbOverride || db();
  ensureContentTenantScopeColumns(d);
  const rows = userId != null
    ? d.prepare(
          `SELECT id, category, synthesized_text, source_channels, version, updated_at,
                  user_id, owner_scope, tenant_id, owner_user_id, visibility_scope, scope_status
             FROM content_knowledge
            WHERE ${contentPrivateScopePredicate()}
            ORDER BY ${contentScopeOrderExpr(undefined, userId)},
                     category ASC,
                     updated_at DESC`,
        ).all(...contentPrivateScopeParams(userId, tenantId)) as any[]
      : d.prepare(
          `SELECT id, category, synthesized_text, source_channels, version, updated_at,
                  user_id, owner_scope, tenant_id, owner_user_id, visibility_scope, scope_status
             FROM content_knowledge
            WHERE ${platformOrSystemSeedContentScopePredicate()}
            ORDER BY updated_at DESC`,
        ).all() as any[];

  const deduped = new Map<string, any>();
  for (const row of rows) {
    if (!deduped.has(row.category)) {
      deduped.set(row.category, row);
    }
  }

  return Array.from(deduped.values()).map((k: any) => mapVoiceDnaRow(k, options.strict === true));
  } catch (error) {
    if (options.strict) {
      if (error instanceof ContentKnowledgeUnavailableError) throw error;
      throw new ContentKnowledgeUnavailableError();
    }
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Knowledge Stats + Reference Channel Count
// ═══════════════════════════════════════════════════════════════════

export interface KnowledgeStats {
  categories: Array<{ category: string; updatedAt: string; sources: number }>;
  referenceChannels: number;
}

/**
 * Get knowledge category stats and reference channel count.
 * Used by the dashboard's bottom-bar knowledge overview.
 */
export function getKnowledgeStats(
  dbOverride?: any,
  userId?: number,
  tenantId?: number,
  options: ContentKnowledgeReadOptions = {},
): KnowledgeStats {
  try {
  const d = dbOverride || db();
  ensureContentTenantScopeColumns(d);
  const voiceEntries = getVoiceDna(d, userId, tenantId, options);
  const kStats = voiceEntries.map((entry) => ({
    category: entry.category,
    updatedAt: entry.updatedAt,
    sources: entry.sources.length,
  }));

  const referenceChannels = userId != null
    ? dedupeScopedRows(
          d.prepare(
            `SELECT channel_url, user_id, owner_scope, tenant_id, owner_user_id, visibility_scope, scope_status
               FROM content_ref_channels
              WHERE ${contentPrivateScopePredicate()}
              ORDER BY ${contentScopeOrderExpr(undefined, userId)},
                       channel_url ASC`,
          ).all(...contentPrivateScopeParams(userId, tenantId)) as any[],
          (row) => row.channel_url,
          userId,
      ).length
    : ((d.prepare(`
          SELECT COUNT(*) as cnt
            FROM content_ref_channels
           WHERE ${platformOrSystemSeedContentScopePredicate()}
        `).get() as any)?.cnt ?? 0);

  return {
    categories: kStats.map(r => ({
      category: r.category,
      updatedAt: r.updatedAt,
      sources: r.sources ?? 0,
    })),
    referenceChannels,
  };
  } catch (error) {
    if (options.strict) {
      if (error instanceof ContentKnowledgeUnavailableError) throw error;
      throw new ContentKnowledgeUnavailableError();
    }
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Pipeline Recent Items
// ═══════════════════════════════════════════════════════════════════

export type PipelineRecentItem = ContentWorkspaceRecentItem;

/**
 * Get recent pipeline items. Complements getPipelineStats() (aggregates)
 * with the actual item list for the portal pipeline table.
 */
export function getPipelineRecent(
  scope: ContentWorkspaceScope,
  limit = 30,
  dbOverride?: any,
): PipelineRecentItem[] {
  return getContentWorkspaceRecentItems(scope, limit, dbOverride || db());
}

// ═══════════════════════════════════════════════════════════════════
// Sprint Mode (uses intelligence bus, not raw SQL)
// ═══════════════════════════════════════════════════════════════════

/**
 * Check if content sprint mode is active.
 * Queries agent_signals directly for the sprint mode signal.
 */
export function isSprintModeActive(): boolean {
  const d = db();
  try {
    const row = d.prepare(
      `SELECT id FROM agent_signals
       WHERE signal_type = 'content_sprint_mode'
         AND status = 'active'
         AND julianday(expires_at) > julianday('now')
         AND tenant_id IS NULL
         AND user_id IS NULL
       LIMIT 1`,
    ).get();
    return !!row;
  } catch {
    return false;
  }
}

/**
 * Toggle sprint mode on/off. Returns new state.
 * Uses governed intelligence-bus writes so sprint state keeps provenance.
 */
export function toggleSprintMode(): { sprint: boolean; message: string } {
  const d = db();
  try {
    const existing = d.prepare(
      `SELECT id FROM agent_signals
       WHERE signal_type = 'content_sprint_mode'
         AND status = 'active'
         AND julianday(expires_at) > julianday('now')
         AND tenant_id IS NULL
         AND user_id IS NULL
       LIMIT 1`,
    ).get() as { id: number } | undefined;

    if (existing) {
      const dismissed = dismissSignal(existing.id);
      if (dismissed !== 1) throw new Error('Sprint-mode signal dismissal did not affect exactly one global row');
      return { sprint: false, message: 'Sprint mode disabled' };
    }

    const activatedAt = new Date().toISOString();
    writeGovernedSignal({
      source_agent: 'portal',
      signal_type: 'content_sprint_mode',
      payload: { enabled: true, activated_at: activatedAt },
      priority: 'urgent',
      provenance: {
        producerVersion: CONTENT_DASHBOARD_SIGNAL_PRODUCER_VERSION,
        source: 'runtime',
        observedAt: activatedAt,
      },
    });
    return { sprint: true, message: 'Sprint mode enabled' };
  } catch (err) {
    logger.debug(safeContentLogErrorFields(err), 'toggleSprintMode failed');
    return { sprint: false, message: 'Sprint mode toggle failed' };
  }
}

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

function safeJsonArray(val: any): any[] {
  if (val === null || val === undefined) return [];
  if (typeof val !== 'string') return Array.isArray(val) ? val : [];
  try { const parsed = JSON.parse(val); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

function mapVoiceDnaRow(row: any, strict: boolean): VoiceDnaEntry {
  if (!strict) {
    return {
      id: row.id,
      category: row.category,
      label: CATEGORY_LABELS[row.category] ?? row.category,
      text: row.synthesized_text,
      sources: safeKnowledgeSources(row.source_channels),
      version: row.version ?? 1,
      updatedAt: row.updated_at,
    };
  }
  if (!Number.isSafeInteger(row?.id)
    || row.id <= 0
    || typeof row.category !== 'string'
    || !row.category.trim()
    || typeof row.synthesized_text !== 'string'
    || !Number.isSafeInteger(row.version)
    || row.version < 1
    || typeof row.updated_at !== 'string'
    || !row.updated_at.trim()) {
    throw new ContentKnowledgeUnavailableError();
  }
  const sources = parseStrictKnowledgeSources(row.source_channels);
  return {
    id: row.id,
    category: row.category,
    label: CATEGORY_LABELS[row.category] ?? row.category,
    text: row.synthesized_text,
    sources,
    version: row.version,
    updatedAt: row.updated_at,
  };
}

function parseStrictKnowledgeSources(raw: unknown): string[] {
  if (typeof raw !== 'string') throw new ContentKnowledgeUnavailableError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ContentKnowledgeUnavailableError();
  }
  if (!Array.isArray(parsed)
    || parsed.some((source) => typeof source !== 'string' || !source.trim())) {
    throw new ContentKnowledgeUnavailableError();
  }
  return parsed.map((source) => (source as string).trim());
}

function safeKnowledgeSources(raw: unknown): string[] {
  try {
    return parseStrictKnowledgeSources(raw);
  } catch {
    return [];
  }
}
