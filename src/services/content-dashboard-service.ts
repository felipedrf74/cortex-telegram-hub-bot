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

function db() {
  return getDb();
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
export function getBooks(limit = 50, dbOverride?: any): BooksOverview {
  const d = dbOverride || db();
  const rows = d.prepare(`
    SELECT id, title, author, core_thesis, key_frameworks, pillar_mapping,
           extraction_status, times_referenced, created_at
    FROM book_library
    ORDER BY times_referenced DESC, created_at DESC
    LIMIT ?
  `).all(limit) as any[];

  const totals = d.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN extraction_status = 'extracted' THEN 1 ELSE 0 END) as extracted,
      SUM(CASE WHEN extraction_status IN ('pending', 'extracting') THEN 1 ELSE 0 END) as pending
    FROM book_library
  `).get() as any;

  return {
    total: totals?.total ?? 0,
    extracted: totals?.extracted ?? 0,
    pending: totals?.pending ?? 0,
    rows: rows.map(r => ({
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
  category: string;
  label: string;
  text: string;
  sources: string[];
  version: number;
  updatedAt: string;
}

/**
 * Get voice DNA entries with human-readable labels.
 * Reads from content_knowledge table (same data as getAllKnowledge()
 * in content-references.ts) with added label mapping for the dashboard.
 */
export function getVoiceDna(dbOverride?: any): VoiceDnaEntry[] {
  const d = dbOverride || db();
  try {
    const rows = d.prepare(
      'SELECT category, synthesized_text, source_channels, version, updated_at FROM content_knowledge ORDER BY updated_at DESC',
    ).all() as any[];
    return rows.map((k: any) => ({
      category: k.category,
      label: CATEGORY_LABELS[k.category] ?? k.category,
      text: k.synthesized_text,
      sources: safeJsonArray(k.source_channels),
      version: k.version ?? 1,
      updatedAt: k.updated_at,
    }));
  } catch (err) {
    logger.debug({ err }, 'getVoiceDna failed');
    return [];
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
export function getKnowledgeStats(dbOverride?: any): KnowledgeStats {
  const d = dbOverride || db();
  try {
    const kStats = d.prepare(`
      SELECT category, updated_at,
             json_array_length(COALESCE(source_channels, '[]')) as sources
      FROM content_knowledge
      ORDER BY updated_at DESC
    `).all() as any[];

    const rc = d.prepare('SELECT COUNT(*) as cnt FROM content_ref_channels').get() as any;

    return {
      categories: kStats.map(r => ({
        category: r.category,
        updatedAt: r.updated_at,
        sources: r.sources ?? 0,
      })),
      referenceChannels: rc?.cnt ?? 0,
    };
  } catch (err) {
    logger.debug({ err }, 'getKnowledgeStats failed');
    return { categories: [], referenceChannels: 0 };
  }
}

// ═══════════════════════════════════════════════════════════════════
// Pipeline Recent Items
// ═══════════════════════════════════════════════════════════════════

export interface PipelineRecentItem {
  id: number;
  topicTitle: string;
  niche: string | null;
  stage: string;
  createdAt: string;
  updatedAt: string;
  publishedUrl: string | null;
  publishedAt: string | null;
}

/**
 * Get recent pipeline items. Complements getPipelineStats() (aggregates)
 * with the actual item list for the portal pipeline table.
 */
export function getPipelineRecent(limit = 30, dbOverride?: any): PipelineRecentItem[] {
  const d = dbOverride || db();
  try {
    const rows = d.prepare(`
      SELECT id, topic_title, niche, stage, created_at, updated_at,
             published_url, published_at
      FROM content_pipeline
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(limit) as any[];

    return rows.map(r => ({
      id: r.id,
      topicTitle: r.topic_title,
      niche: r.niche,
      stage: r.stage,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      publishedUrl: r.published_url,
      publishedAt: r.published_at,
    }));
  } catch (err) {
    logger.debug({ err }, 'getPipelineRecent failed');
    return [];
  }
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
      "SELECT id FROM agent_signals WHERE signal_type = 'content_sprint_mode' AND status = 'active' LIMIT 1",
    ).get();
    return !!row;
  } catch {
    return false;
  }
}

/**
 * Toggle sprint mode on/off. Returns new state.
 * Uses writeSignal/dismissSignal from intelligence-bus for writes.
 */
export function toggleSprintMode(): { sprint: boolean; message: string } {
  const d = db();
  try {
    const existing = d.prepare(
      "SELECT id FROM agent_signals WHERE signal_type = 'content_sprint_mode' AND status = 'active' LIMIT 1",
    ).get() as { id: number } | undefined;

    if (existing) {
      // Dismiss via the bus function (maintains consumed_by, status tracking)
      try {
        const { dismissSignal } = require('./intelligence-bus');
        dismissSignal(existing.id);
      } catch {
        // Fallback: direct update if bus module unavailable
        d.prepare("UPDATE agent_signals SET status = 'dismissed' WHERE id = ?").run(existing.id);
      }
      return { sprint: false, message: 'Sprint mode disabled' };
    }

    // Write via the bus function (maintains TTL, priority, schema)
    try {
      const { writeSignal } = require('./intelligence-bus');
      writeSignal({
        source_agent: 'portal',
        signal_type: 'content_sprint_mode',
        payload: { enabled: true, activated_at: new Date().toISOString() },
        priority: 'urgent',
      });
    } catch {
      // Fallback: direct insert
      d.prepare(`
        INSERT INTO agent_signals (source_agent, signal_type, payload, priority, expires_at, confidence)
        VALUES ('portal', 'content_sprint_mode', ?, 'urgent', datetime('now', '+7 days'), 1.0)
      `).run(JSON.stringify({ enabled: true, activated_at: new Date().toISOString() }));
    }
    return { sprint: true, message: 'Sprint mode enabled' };
  } catch (err) {
    logger.debug({ err }, 'toggleSprintMode failed');
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
