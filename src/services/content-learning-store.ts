// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Content Learning Store — Canonical DB-backed learning model.
 *
 * This service is the SINGLE durable store for all content learning data.
 * It replaces the fragmented storage (feedback.json, file paths, transient
 * bus signals) with a canonical DB model that:
 *
 *   1. Persists raw script text alongside the DOCX file path
 *   2. Stores performance feedback in SQLite (not JSON files)
 *   3. Durably records learned patterns (survive signal expiry)
 *   4. Links all artifacts: idea → script → publish → feedback → pattern
 *
 * All functions accept a userId parameter for multi-tenant isolation.
 * The artifact chain is traceable via foreign keys:
 *   content_topic_feedback.id → content_pipeline.topic_feedback_id
 *   content_pipeline.id → content_scripts.pipeline_id
 *   content_pipeline.id → content_performance.pipeline_id
 *   content_learned_patterns (standalone, aggregated from all sources)
 *
 * Consumers:
 *   - content-workflow.ts — calls storeScript() after generation
 *   - voice-evolution-agent.ts — calls getRecentScripts() for voice learning
 *   - iOS API routes — calls getPerformanceSummary(), getLearnedPatterns()
 *   - portal dashboard — calls getArtifactChain() for pipeline inspection
 */

import { getDb } from './database';
import { logger } from '../utils/logger';
import {
  contentScopeForInsert,
  contentScopeOrderExpr,
  contentScopeParams,
  contentScopePredicate,
  ensureContentTenantScopeColumns,
} from './content-tenant-scope';
import { recordContentPerformanceMemory } from './content-memory-profile';

const CONTENT_OWNER_SCOPE_SQL = "COALESCE(owner_scope, CASE WHEN user_id = 0 THEN 'system' ELSE 'user' END)";

function effectiveContentOwnerScope(row: { owner_scope?: string | null; user_id?: number | null }): 'system' | 'user' {
  if (row.owner_scope === 'system') return 'system';
  if (row.owner_scope === 'user') return 'user';
  return row.user_id === 0 ? 'system' : 'user';
}

function isUserOwnedContentRow(
  row: { owner_scope?: string | null; user_id?: number | null },
  userId: number,
): boolean {
  return row.user_id === userId && effectiveContentOwnerScope(row) === 'user';
}

function dedupeLearnedPatterns<T extends { category: string; pattern_text: string; owner_scope?: string | null; user_id?: number | null }>(
  rows: T[],
  userId: number,
): T[] {
  if (userId === 0) return rows;
  const deduped = new Map<string, T>();
  for (const row of rows) {
    const key = `${row.category}::${row.pattern_text}`;
    const existing = deduped.get(key);
    if (!existing || (isUserOwnedContentRow(row, userId) && !isUserOwnedContentRow(existing, userId))) {
      deduped.set(key, row);
    }
  }
  return Array.from(deduped.values());
}

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

export interface StoredScript {
  id: number;
  pipelineId: number | null;
  topicFeedbackId: number | null;
  topic: string;
  format: string;
  scriptText: string;
  hook: string | null;
  titleOptions: string[];
  sourcesUsed: any[];
  hashtags: string[];
  caption: string | null;
  cta: string | null;
  estimatedDuration: string | null;
  niche: string | null;
  generationDurationMs: number | null;
  userId: number;
  createdAt: string;
}

export interface PerformanceFeedback {
  id: number;
  pipelineId: number | null;
  videoUrl: string | null;
  views: number;
  retentionPct: number;
  likes: number;
  comments: number;
  subsGained: number;
  hookUsed: string | null;
  selectedTitle: string | null;
  finalCaption: string | null;
  finalCta: string | null;
  finalScriptVariant: string | null;
  publishedHashtags: string[];
  notes: string | null;
  analysis: any | null;
  userId: number;
  loggedAt: string;
}

export interface LearnedPattern {
  id: number;
  category: string;
  patternText: string;
  examples: string[];
  confidence: number;
  frequency: number;
  sourceAgent: string | null;
  firstDetectedAt: string;
  lastSeenAt: string;
  userId: number;
}

export interface ArtifactChain {
  idea: { id: number; title: string; status: string; source: string } | null;
  topicFeedback: {
    id: number; topic: string; niche: string; format: string;
    sentiment: string; hookIdea: string; whyNow: string;
  } | null;
  pipeline: {
    id: number; stage: string; scriptPath: string | null;
    youtubeVideoId: string | null; publishedAt: string | null;
  } | null;
  script: {
    id: number; scriptText: string; hook: string | null;
    titleOptions: string[]; hashtags: string[]; caption: string | null; cta: string | null; estimatedDuration: string | null;
  } | null;
  performance: PerformanceFeedback[];
  patterns: LearnedPattern[];
}

// ═══════════════════════════════════════════════════════════════════
// Script Storage
// ═══════════════════════════════════════════════════════════════════

/**
 * Store raw script text durably after generation.
 * Called by content-workflow.ts right after getScript() returns.
 */
export function storeScript(opts: {
  pipelineId?: number;
  topicFeedbackId?: number;
  topic: string;
  format: string;
  scriptText: string;
  hook?: string;
  titleOptions?: string[];
  sourcesUsed?: any[];
  hashtags?: string[];
  caption?: string;
  cta?: string;
  estimatedDuration?: string;
  niche?: string;
  generationDurationMs?: number;
  userId: number;
  tenantId?: number;
}): number {
  const db = getDb();
  ensureContentTenantScopeColumns(db);
  const scope = contentScopeForInsert(opts.userId, opts.tenantId);
  const result = db.prepare(`
    INSERT INTO content_scripts
      (pipeline_id, topic_feedback_id, topic, format, script_text, hook,
       title_options, sources_used, hashtags, caption, cta, estimated_duration, niche,
       generation_duration_ms, user_id, tenant_id, owner_user_id, visibility_scope,
       lifecycle_state, scope_status, created_by, updated_by, audit_metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.pipelineId ?? null,
    opts.topicFeedbackId ?? null,
    opts.topic,
    opts.format,
    opts.scriptText,
    opts.hook ?? null,
    JSON.stringify(opts.titleOptions ?? []),
    JSON.stringify(opts.sourcesUsed ?? []),
    JSON.stringify(opts.hashtags ?? []),
    opts.caption ?? null,
    opts.cta ?? null,
    opts.estimatedDuration ?? null,
    opts.niche ?? null,
    opts.generationDurationMs ?? null,
    opts.userId,
    scope.tenantId,
    scope.ownerUserId,
    scope.visibilityScope,
    scope.lifecycleState,
    scope.scopeStatus,
    scope.createdBy,
    scope.updatedBy,
    scope.auditMetadataJson,
  );
  logger.info({ scriptId: result.lastInsertRowid, topic: opts.topic }, 'Script text stored durably');
  return Number(result.lastInsertRowid);
}

/**
 * Retrieve recent scripts for voice learning. Returns raw script text
 * that the voice-evolution-agent can compare against published transcripts.
 */
export function getRecentScripts(userId: number, days = 30, limit = 20, tenantId?: number): StoredScript[] {
  const db = getDb();
  ensureContentTenantScopeColumns(db);
  const rows = db.prepare(`
    SELECT id, pipeline_id, topic_feedback_id, topic, format, script_text,
           hook, title_options, sources_used, hashtags, caption, cta, estimated_duration, niche,
           generation_duration_ms, user_id, created_at
    FROM content_scripts
    WHERE ${contentScopePredicate()} AND created_at > datetime('now', '-' || ? || ' days')
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...contentScopeParams(userId, tenantId), days, limit) as any[];

  return rows.map(mapScript);
}

/**
 * Get a single script by pipeline ID.
 */
export function getScriptByPipelineId(pipelineId: number, userId: number, tenantId: number): StoredScript | null {
  const db = getDb();
  ensureContentTenantScopeColumns(db);
  const row = db.prepare(`
    SELECT id, pipeline_id, topic_feedback_id, topic, format, script_text,
           hook, title_options, sources_used, hashtags, caption, cta, estimated_duration, niche,
           generation_duration_ms, user_id, created_at
    FROM content_scripts
    WHERE pipeline_id = ?
      AND ${contentScopePredicate()}
  `).get(pipelineId, ...contentScopeParams(userId, tenantId)) as any;
  return row ? mapScript(row) : null;
}

function mapScript(row: any): StoredScript {
  return {
    id: row.id,
    pipelineId: row.pipeline_id,
    topicFeedbackId: row.topic_feedback_id,
    topic: row.topic,
    format: row.format,
    scriptText: row.script_text,
    hook: row.hook,
    titleOptions: safeParseJSON(row.title_options, []),
    sourcesUsed: safeParseJSON(row.sources_used, []),
    hashtags: safeParseJSON(row.hashtags, []),
    caption: row.caption,
    cta: row.cta,
    estimatedDuration: row.estimated_duration,
    niche: row.niche,
    generationDurationMs: row.generation_duration_ms,
    userId: row.user_id,
    createdAt: row.created_at,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Performance Feedback
// ═══════════════════════════════════════════════════════════════════

/**
 * Record performance feedback for a video.
 * Replaces content-engine/data/feedback.json with durable DB storage.
 */
export function logPerformanceFeedback(opts: {
  pipelineId?: number;
  videoUrl?: string;
  views: number;
  retentionPct: number;
  likes?: number;
  comments?: number;
  subsGained?: number;
  hookUsed?: string;
  selectedTitle?: string;
  finalCaption?: string;
  finalCta?: string;
  finalScriptVariant?: string;
  publishedHashtags?: string[];
  notes?: string;
  analysis?: any;
  userId: number;
  tenantId?: number;
}): number {
  const db = getDb();
  ensureContentTenantScopeColumns(db);
  const scope = contentScopeForInsert(opts.userId, opts.tenantId);
  const result = db.prepare(`
    INSERT INTO content_performance
      (pipeline_id, video_url, views, retention_pct, likes, comments,
       subs_gained, hook_used, selected_title, final_caption, final_cta,
       final_script_variant, published_hashtags, notes, analysis, user_id,
       tenant_id, owner_user_id, visibility_scope, lifecycle_state, scope_status,
       created_by, updated_by, audit_metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.pipelineId ?? null,
    opts.videoUrl ?? null,
    opts.views,
    opts.retentionPct,
    opts.likes ?? 0,
    opts.comments ?? 0,
    opts.subsGained ?? 0,
    opts.hookUsed ?? null,
    opts.selectedTitle ?? null,
    opts.finalCaption ?? null,
    opts.finalCta ?? null,
    opts.finalScriptVariant ?? null,
    JSON.stringify(opts.publishedHashtags ?? []),
    opts.notes ?? null,
    opts.analysis ? JSON.stringify(opts.analysis) : null,
    opts.userId,
    scope.tenantId,
    scope.ownerUserId,
    scope.visibilityScope,
    scope.lifecycleState,
    scope.scopeStatus,
    scope.createdBy,
    scope.updatedBy,
    scope.auditMetadataJson,
  );
  const performanceMemory = derivePerformanceMemory(opts);
  if (performanceMemory) {
    try {
      recordContentPerformanceMemory({
        tenantId: scope.tenantId,
        userId: opts.userId,
        scope: 'user_private',
        source: 'content_performance_feedback',
        confidence: performanceMemory.confidence,
        successfulTopics: performanceMemory.successfulTopics,
        weakTopics: performanceMemory.weakTopics,
        successfulHooks: performanceMemory.successfulHooks,
        successfulFormats: performanceMemory.successfulFormats,
        rejectedPatterns: performanceMemory.rejectedPatterns,
        audienceResponseSignals: performanceMemory.audienceResponseSignals,
      });
    } catch (error) {
      logger.warn(
        {
          feedbackId: result.lastInsertRowid,
          userId: opts.userId,
          tenantId: scope.tenantId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Performance feedback stored but content memory update failed',
      );
    }
  }
  logger.info({ feedbackId: result.lastInsertRowid }, 'Performance feedback stored');
  return Number(result.lastInsertRowid);
}

/**
 * Get performance summary for reporting.
 */
export function getPerformanceSummary(userId: number, days = 30, tenantId?: number): {
  count: number;
  avgViews: number;
  avgRetention: number;
  totalLikes: number;
  totalComments: number;
  totalSubsGained: number;
  entries: PerformanceFeedback[];
} {
  const db = getDb();
  ensureContentTenantScopeColumns(db);
  const rows = db.prepare(`
    SELECT id, pipeline_id, video_url, views, retention_pct, likes,
           comments, subs_gained, hook_used, selected_title, final_caption,
           final_cta, final_script_variant, published_hashtags, notes, analysis, user_id, logged_at
    FROM content_performance
    WHERE ${contentScopePredicate()} AND logged_at > datetime('now', '-' || ? || ' days')
    ORDER BY logged_at DESC
  `).all(...contentScopeParams(userId, tenantId), days) as any[];

  const entries = rows.map(mapPerformance);
  const count = entries.length;

  return {
    count,
    avgViews: count > 0 ? Math.round(entries.reduce((s, e) => s + e.views, 0) / count) : 0,
    avgRetention: count > 0 ? Math.round(entries.reduce((s, e) => s + e.retentionPct, 0) / count * 10) / 10 : 0,
    totalLikes: entries.reduce((s, e) => s + e.likes, 0),
    totalComments: entries.reduce((s, e) => s + e.comments, 0),
    totalSubsGained: entries.reduce((s, e) => s + e.subsGained, 0),
    entries,
  };
}

function mapPerformance(row: any): PerformanceFeedback {
  return {
    id: row.id,
    pipelineId: row.pipeline_id,
    videoUrl: row.video_url,
    views: row.views,
    retentionPct: row.retention_pct,
    likes: row.likes,
    comments: row.comments,
    subsGained: row.subs_gained,
    hookUsed: row.hook_used,
    selectedTitle: row.selected_title,
    finalCaption: row.final_caption,
    finalCta: row.final_cta,
    finalScriptVariant: row.final_script_variant,
    publishedHashtags: safeParseJSON(row.published_hashtags, []),
    notes: row.notes,
    analysis: safeParseJSON(row.analysis, null),
    userId: row.user_id,
    loggedAt: row.logged_at,
  };
}

function derivePerformanceMemory(opts: {
  views: number;
  retentionPct: number;
  likes?: number;
  comments?: number;
  subsGained?: number;
  hookUsed?: string;
  selectedTitle?: string;
  finalScriptVariant?: string;
  publishedHashtags?: string[];
  analysis?: any;
}): {
  successfulTopics?: string[];
  weakTopics?: string[];
  successfulHooks?: string[];
  successfulFormats?: string[];
  rejectedPatterns?: string[];
  audienceResponseSignals: string[];
  confidence: number;
} | null {
  const views = Math.max(0, Number(opts.views) || 0);
  const retentionPct = Math.max(0, Math.min(100, Number(opts.retentionPct) || 0));
  const likes = Math.max(0, Number(opts.likes ?? 0) || 0);
  const comments = Math.max(0, Number(opts.comments ?? 0) || 0);
  const subsGained = Math.max(0, Number(opts.subsGained ?? 0) || 0);
  const highSignal = (
    (retentionPct >= 55 && views >= 500)
    || views >= 5000
    || likes >= 300
    || comments >= 50
    || subsGained >= 10
  );
  const weakSignal = (
    (views >= 250 && retentionPct > 0 && retentionPct < 25)
    || (views >= 1000 && likes < 10 && comments === 0)
  );
  if (!highSignal && !weakSignal) return null;

  const title = sanitizeMemoryText(opts.selectedTitle);
  const hook = sanitizeMemoryText(opts.hookUsed);
  const hashtags = (opts.publishedHashtags ?? [])
    .map((tag) => sanitizeMemoryText(String(tag).replace(/^#/, '')))
    .filter((tag): tag is string => Boolean(tag))
    .slice(0, 3);
  const format = extractPerformanceFormat(opts);
  const audienceResponseSignals = [
    views >= 5000 ? 'views_high' : views >= 1000 ? 'views_moderate' : null,
    retentionPct >= 55 ? 'retention_high' : retentionPct < 25 && retentionPct > 0 ? 'retention_low' : null,
    likes >= 300 ? 'likes_high' : null,
    comments >= 50 ? 'comments_high' : null,
    subsGained >= 10 ? 'subscriber_gain_high' : null,
  ].filter((signal): signal is string => Boolean(signal));

  if (highSignal) {
    const successfulTopics = [...new Set([title, ...hashtags].filter((item): item is string => Boolean(item)))].slice(0, 4);
    return {
      successfulTopics,
      successfulHooks: hook ? [hook] : undefined,
      successfulFormats: format ? [format] : undefined,
      audienceResponseSignals,
      confidence: retentionPct >= 55 && views >= 1000 ? 0.82 : 0.72,
    };
  }

  const weakTopics = [...new Set([title, ...hashtags].filter((item): item is string => Boolean(item)))].slice(0, 4);
  return {
    weakTopics,
    rejectedPatterns: hook ? [hook] : undefined,
    audienceResponseSignals,
    confidence: views >= 1000 ? 0.72 : 0.62,
  };
}

function sanitizeMemoryText(value?: string | null): string | undefined {
  const cleaned = String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return cleaned || undefined;
}

function extractPerformanceFormat(opts: { finalScriptVariant?: string; analysis?: any }): string | undefined {
  const candidates = [
    opts.analysis?.format,
    opts.analysis?.platform,
    opts.analysis?.contentFormat,
    opts.finalScriptVariant,
  ];
  const knownFormats = new Set(['youtube', 'reel', 'short', 'shorts', 'tiktok', 'newsletter', 'carousel', 'thread', 'article']);
  for (const candidate of candidates) {
    const normalized = sanitizeMemoryText(candidate)?.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (normalized && knownFormats.has(normalized)) return normalized;
  }
  return undefined;
}

// ═══════════════════════════════════════════════════════════════════
// Learned Patterns
// ═══════════════════════════════════════════════════════════════════

/**
 * Upsert a learned pattern. Uses INSERT OR REPLACE on the unique
 * (category, pattern_text, user_id) index so repeated detections
 * increment frequency and update last_seen_at instead of duplicating.
 */
export function upsertLearnedPattern(opts: {
  category: string;
  patternText: string;
  examples?: string[];
  confidence?: number;
  sourceAgent?: string;
  userId: number;
  tenantId?: number;
}): void {
  const db = getDb();
  ensureContentTenantScopeColumns(db);
  const ownerScope = opts.userId === 0 ? 'system' : 'user';
  const scope = contentScopeForInsert(opts.userId, opts.tenantId);

  // Try to update existing pattern first
  const existing = db.prepare(`
    SELECT id, frequency, examples FROM content_learned_patterns
    WHERE category = ? AND pattern_text = ? AND user_id = ?
  `).get(opts.category, opts.patternText, opts.userId) as any;

  if (existing) {
    // Merge examples (deduplicate)
    const existingExamples = safeParseJSON(existing.examples, []) as string[];
    const newExamples = opts.examples ?? [];
    const merged = [...new Set([...existingExamples, ...newExamples])].slice(0, 10);

    db.prepare(`
      UPDATE content_learned_patterns
      SET frequency = frequency + 1,
          examples = ?,
          confidence = MAX(confidence, ?),
          last_seen_at = datetime('now'),
          source_agent = COALESCE(?, source_agent),
          tenant_id = ?,
          owner_user_id = ?,
          visibility_scope = ?,
          lifecycle_state = ?,
          scope_status = ?,
          updated_by = ?
      WHERE id = ?
    `).run(
      JSON.stringify(merged),
      opts.confidence ?? 0.5,
      opts.sourceAgent ?? null,
      scope.tenantId,
      scope.ownerUserId,
      scope.visibilityScope,
      scope.lifecycleState,
      scope.scopeStatus,
      scope.updatedBy,
      existing.id,
    );
  } else {
    db.prepare(`
      INSERT INTO content_learned_patterns
        (category, pattern_text, examples, confidence, source_agent, user_id, owner_scope,
         tenant_id, owner_user_id, visibility_scope, lifecycle_state, scope_status,
         created_by, updated_by, audit_metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      opts.category,
      opts.patternText,
      JSON.stringify(opts.examples ?? []),
      opts.confidence ?? 0.5,
      opts.sourceAgent ?? null,
      opts.userId,
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
}

/**
 * Get all learned patterns for a user, optionally filtered by category.
 */
export function getLearnedPatterns(
  userId: number,
  category?: string,
  tenantId?: number,
): LearnedPattern[] {
  const db = getDb();
  ensureContentTenantScopeColumns(db);
  if (userId === 0) {
    const systemQuery = category
      ? `SELECT * FROM content_learned_patterns
          WHERE ${CONTENT_OWNER_SCOPE_SQL} = 'system' AND category = ?
          ORDER BY confidence DESC, frequency DESC`
      : `SELECT * FROM content_learned_patterns
          WHERE ${CONTENT_OWNER_SCOPE_SQL} = 'system'
          ORDER BY confidence DESC, frequency DESC`;
    const rows = category
      ? db.prepare(systemQuery).all(category) as any[]
      : db.prepare(systemQuery).all() as any[];
    return rows.map(mapPattern);
  }

  const query = category
    ? `SELECT * FROM content_learned_patterns
        WHERE category = ?
          AND ${contentScopePredicate()}
        ORDER BY ${contentScopeOrderExpr(undefined, userId)},
                 confidence DESC,
                 frequency DESC`
    : `SELECT * FROM content_learned_patterns
        WHERE ${contentScopePredicate()}
        ORDER BY ${contentScopeOrderExpr(undefined, userId)},
                 confidence DESC,
                 frequency DESC`;

  const rows = category
    ? db.prepare(query).all(category, ...contentScopeParams(userId, tenantId)) as any[]
    : db.prepare(query).all(...contentScopeParams(userId, tenantId)) as any[];

  return dedupeLearnedPatterns(rows, userId).map(mapPattern);
}

function mapPattern(row: any): LearnedPattern {
  return {
    id: row.id,
    category: row.category,
    patternText: row.pattern_text,
    examples: safeParseJSON(row.examples, []),
    confidence: row.confidence,
    frequency: row.frequency,
    sourceAgent: row.source_agent,
    firstDetectedAt: row.first_detected_at,
    lastSeenAt: row.last_seen_at,
    userId: row.user_id,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Artifact Chain — Full Linkage
// ═══════════════════════════════════════════════════════════════════

/**
 * Build the complete artifact chain for a pipeline entry.
 * This is the canonical tracing function: given a pipeline ID, it
 * returns every linked object from idea to learned patterns.
 */
export function getArtifactChain(pipelineId: number, userId: number, tenantId: number): ArtifactChain {
  const db = getDb();
  ensureContentTenantScopeColumns(db);

  // Pipeline entry
  const pipeline = db.prepare(`
    SELECT id, topic_feedback_id, topic_title, niche, stage, script_path,
           youtube_video_id, published_at, user_id, tenant_id
    FROM content_pipeline
    WHERE id = ?
      AND ${contentScopePredicate()}
  `).get(pipelineId, ...contentScopeParams(userId, tenantId)) as any;

  if (!pipeline) {
    return { idea: null, topicFeedback: null, pipeline: null, script: null, performance: [], patterns: [] };
  }

  // Topic feedback
  let topicFeedback = null;
  if (pipeline.topic_feedback_id) {
    const tf = db.prepare(`
      SELECT id, topic, niche, format, sentiment, hook_idea, why_now
      FROM content_topic_feedback
      WHERE id = ?
        AND ${contentScopePredicate()}
    `).get(pipeline.topic_feedback_id, ...contentScopeParams(userId, tenantId)) as any;
    if (tf) {
      topicFeedback = {
        id: tf.id, topic: tf.topic, niche: tf.niche, format: tf.format,
        sentiment: tf.sentiment, hookIdea: tf.hook_idea, whyNow: tf.why_now,
      };
    }
  }

  // Saved idea (linked via topic title match)
  let idea = null;
  try {
    const ideaRow = db.prepare(`
      SELECT id, title, status, source FROM saved_ideas
      WHERE title = ?
        AND ${contentScopePredicate()}
      LIMIT 1
    `).get(pipeline.topic_title, ...contentScopeParams(userId, tenantId)) as any;
    if (ideaRow) {
      idea = { id: ideaRow.id, title: ideaRow.title, status: ideaRow.status, source: ideaRow.source };
    }
  } catch { /* table might not exist in test env */ }

  // Script (durable text)
  const scriptRow = db.prepare(`
    SELECT id, script_text, hook, title_options, estimated_duration
           , hashtags, caption, cta
    FROM content_scripts
    WHERE pipeline_id = ?
      AND ${contentScopePredicate()}
  `).get(pipelineId, ...contentScopeParams(userId, tenantId)) as any;
  const script = scriptRow ? {
    id: scriptRow.id,
    scriptText: scriptRow.script_text,
    hook: scriptRow.hook,
    titleOptions: safeParseJSON(scriptRow.title_options, []),
    hashtags: safeParseJSON(scriptRow.hashtags, []),
    caption: scriptRow.caption,
    cta: scriptRow.cta,
    estimatedDuration: scriptRow.estimated_duration,
  } : null;

  // Performance feedback
  const perfRows = db.prepare(`
    SELECT id, pipeline_id, video_url, views, retention_pct, likes,
           comments, subs_gained, hook_used, selected_title, final_caption,
           final_cta, final_script_variant, published_hashtags, notes, analysis, user_id, logged_at
    FROM content_performance
    WHERE pipeline_id = ?
      AND ${contentScopePredicate()}
    ORDER BY logged_at DESC
  `).all(pipelineId, ...contentScopeParams(userId, tenantId)) as any[];
  const performance = perfRows.map(mapPerformance);

  // Learned patterns (from the same niche)
  const patterns = pipeline.niche
    ? db.prepare(`
        SELECT * FROM content_learned_patterns
        WHERE ${contentScopePredicate()}
        ORDER BY confidence DESC LIMIT 10
      `).all(...contentScopeParams(userId, tenantId)).map(mapPattern) as LearnedPattern[]
    : [];

  return {
    idea,
    topicFeedback,
    pipeline: {
      id: pipeline.id,
      stage: pipeline.stage,
      scriptPath: pipeline.script_path,
      youtubeVideoId: pipeline.youtube_video_id,
      publishedAt: pipeline.published_at,
    },
    script,
    performance,
    patterns,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

function safeParseJSON(val: any, fallback: any): any {
  if (val === null || val === undefined) return fallback;
  if (typeof val !== 'string') return val;
  try { return JSON.parse(val); } catch { return fallback; }
}
