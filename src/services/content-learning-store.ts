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
 *   4. Links measured outcomes to canonical workspace artifacts
 *
 * All functions accept a userId parameter for multi-tenant isolation.
 * The workspace is the artifact/revision/source lineage authority. Legacy
 * `pipeline_id` columns on learning tables are compatibility aliases only;
 * the frozen pipeline root is never read for live artifact guidance.
 *
 * Consumers:
 *   - content-workspace-capture.ts — owns positive-user script persistence
 *   - voice-evolution-agent.ts — persists scoped patterns after canonical revision-pair analysis
 *   - iOS API routes — calls getPerformanceSummary(), getLearnedPatterns()
 *   - portal dashboard — calls getArtifactChain() for pipeline inspection
 */

import { createHash } from 'node:crypto';
import { getDb } from './database';
import { logger } from '../utils/logger';
import {
  contentScopeForInsert,
  contentScopeOrderExpr,
  contentScopeParams,
  contentScopePredicate,
  ensureContentTenantScopeColumns,
} from './content-tenant-scope';
import {
  getContentWorkspaceItemDetail,
  type ContentRevisionContent,
  type ContentWorkspaceItemDetail,
} from './content-workspace';
import { getContentRevisionLineage, type ContentRevisionLineageReadModel } from './content-workspace-lineage';
import { resolveContentWorkspaceIdentifier } from './content-workspace-read-models';

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
  workspaceItemId: number | null;
  artifactId: number | null;
  revisionId: number | null;
  association: 'canonical_revision' | 'legacy_pipeline_alias' | 'unlinked_legacy';
  linkOrigin: 'canonical_api' | 'legacy_pipeline_backfill' | null;
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
  schemaVersion: 'content-workspace-artifact-chain-v1';
  availability: 'available' | 'not_found';
  source: 'content_workspace';
  identifier: {
    requestedId: number;
    workspaceItemId: number | null;
    resolvedAs: 'workspace_item' | 'legacy_pipeline_binding' | 'not_found';
  };
  workspaceItem: ContentWorkspaceItemDetail | null;
  revisionLineage: ContentRevisionLineageReadModel[];
  idea: { id: number; title: string; status: string; source: string } | null;
  topicFeedback: {
    id: number; topic: string; niche: string; format: string;
    sentiment: string; hookIdea: string; whyNow: string;
  } | null;
  pipeline: {
    id: number; stage: string; scriptPath: string | null;
    youtubeVideoId: string | null; publishedAt: null;
    publicationTracking: {
      availability: 'unavailable';
      reasonCode: 'CONTENT_PUBLICATION_TRACKING_NOT_SUPPORTED';
      publicationExecution: 'not_supported';
    };
  } | null;
  script: {
    id: number; scriptText: string | null; hook: string | null;
    titleOptions: string[]; hashtags: string[]; caption: string | null; cta: string | null; estimatedDuration: string | null;
    content: ContentRevisionContent;
  } | null;
  performance: PerformanceFeedback[];
  patterns: LearnedPattern[];
  compatibility: {
    legacyIdentifierAccepted: boolean;
    legacyArchiveRead: false;
    performanceAssociation: 'canonical_revision' | 'legacy_identifier_alias' | 'not_modeled';
    learnedPatternAssociation: 'not_modeled';
  };
}

// ═══════════════════════════════════════════════════════════════════
// Script Storage
// ═══════════════════════════════════════════════════════════════════

/**
 * Legacy/system script ingress retained only for compatibility fixtures and
 * ownerless system rows. Positive-user writers are frozen once migration 252
 * proves canonical body parity; use saveGeneratedScriptToWorkspace instead.
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
  if (opts.userId > 0 && tableExists(db, 'content_legacy_script_ingress_bindings')) {
    throw new Error('content_scripts is read-only after canonical script parity; use content workspace capture');
  }
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
  logger.info({
    scriptId: result.lastInsertRowid,
    topicLength: opts.topic.length,
    topicHash: createHash('sha256').update(opts.topic).digest('hex').slice(0, 16),
  }, 'Script text stored durably');
  return Number(result.lastInsertRowid);
}

/**
 * Retrieve recent scripts for scoped consumers. A script snapshot alone is
 * not creator-authorship or publication evidence; voice learning uses direct
 * canonical agent-to-user revision lineage instead.
 */
export function getRecentScripts(userId: number, days = 30, limit = 20, tenantId?: number): StoredScript[] {
  const db = getDb();
  ensureContentTenantScopeColumns(db);
  if (userId > 0 && tableExists(db, 'content_legacy_script_ingress_bindings')) {
    const canonicalRows = db.prepare(`
      SELECT artifact.id,
             item.title AS topic,
             artifact.format_id,
             artifact.metadata_json,
             revision.content_text AS script_text,
             artifact.owner_user_id AS user_id,
             artifact.created_at
        FROM content_artifacts AS artifact
        JOIN content_domain_objects AS item
          ON item.id = artifact.item_id
         AND item.tenant_id = artifact.tenant_id
         AND item.owner_user_id = artifact.owner_user_id
        JOIN content_revisions AS revision
          ON revision.id = artifact.current_revision_id
         AND revision.artifact_id = artifact.id
         AND revision.tenant_id = artifact.tenant_id
         AND revision.owner_user_id = artifact.owner_user_id
       WHERE artifact.tenant_id = ?
         AND artifact.owner_user_id = ?
         AND artifact.visibility_scope = 'user_private'
         AND artifact.scope_status = 'active'
         AND artifact.artifact_type = 'script'
         AND item.visibility_scope = 'user_private'
         AND item.scope_status = 'active'
         AND item.deleted_at IS NULL
         AND revision.content_format IN ('plain_text', 'markdown')
         AND artifact.created_at > datetime('now', '-' || ? || ' days')
       ORDER BY artifact.created_at DESC, artifact.id DESC
       LIMIT ?
    `).all(tenantId ?? userId, userId, days, limit) as any[];
    return canonicalRows.map(mapCanonicalScript);
  }
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

function mapCanonicalScript(row: any): StoredScript {
  const metadata = safeParseJSON(row.metadata_json, {}) as Record<string, unknown>;
  return {
    id: Number(row.id),
    pipelineId: positiveMetadataInteger(metadata.legacyPipelineId),
    topicFeedbackId: positiveMetadataInteger(metadata.topicFeedbackId),
    topic: String(row.topic),
    format: typeof row.format_id === 'string' && row.format_id.trim()
      ? row.format_id
      : 'script',
    scriptText: String(row.script_text),
    hook: typeof metadata.hook === 'string' ? metadata.hook : null,
    titleOptions: Array.isArray(metadata.titleOptions) ? metadata.titleOptions as string[] : [],
    sourcesUsed: Array.isArray(metadata.sourcesUsed) ? metadata.sourcesUsed : [],
    hashtags: Array.isArray(metadata.hashtags) ? metadata.hashtags as string[] : [],
    caption: typeof metadata.caption === 'string' ? metadata.caption : null,
    cta: typeof metadata.cta === 'string' ? metadata.cta : null,
    estimatedDuration: typeof metadata.estimatedDuration === 'string' ? metadata.estimatedDuration : null,
    niche: typeof metadata.niche === 'string' ? metadata.niche : null,
    generationDurationMs: typeof metadata.generationDurationMs === 'number'
      ? metadata.generationDurationMs
      : null,
    userId: Number(row.user_id),
    createdAt: String(row.created_at),
  };
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
  const rows = tableExists(db, 'content_performance_workspace_links')
    ? db.prepare(`
    SELECT performance.id, performance.pipeline_id, performance.video_url,
           performance.views, performance.retention_pct, performance.likes,
           performance.comments, performance.subs_gained, performance.hook_used,
           performance.selected_title, performance.final_caption,
           performance.final_cta, performance.final_script_variant,
           performance.published_hashtags, performance.notes, performance.analysis,
           performance.user_id, performance.logged_at,
           link.item_id AS workspace_item_id,
           link.artifact_id AS workspace_artifact_id,
           link.revision_id AS workspace_revision_id,
           link.origin AS performance_link_origin
      FROM content_performance AS performance
      LEFT JOIN content_performance_workspace_links AS link
        ON link.performance_id = performance.id
       AND link.tenant_id = performance.tenant_id
       AND link.owner_user_id = performance.owner_user_id
     WHERE ${contentScopePredicate('performance')}
       AND performance.logged_at > datetime('now', '-' || ? || ' days')
     ORDER BY performance.logged_at DESC, performance.id DESC
  `).all(...contentScopeParams(userId, tenantId), days) as any[]
    : db.prepare(`
    SELECT performance.id, performance.pipeline_id, performance.video_url,
           performance.views, performance.retention_pct, performance.likes,
           performance.comments, performance.subs_gained, performance.hook_used,
           performance.selected_title, performance.final_caption,
           performance.final_cta, performance.final_script_variant,
           performance.published_hashtags, performance.notes, performance.analysis,
           performance.user_id, performance.logged_at,
           NULL AS workspace_item_id,
           NULL AS workspace_artifact_id,
           NULL AS workspace_revision_id,
           NULL AS performance_link_origin
      FROM content_performance AS performance
     WHERE ${contentScopePredicate('performance')}
       AND performance.logged_at > datetime('now', '-' || ? || ' days')
     ORDER BY performance.logged_at DESC, performance.id DESC
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
    workspaceItemId: row.workspace_item_id == null ? null : Number(row.workspace_item_id),
    artifactId: row.workspace_artifact_id == null ? null : Number(row.workspace_artifact_id),
    revisionId: row.workspace_revision_id == null ? null : Number(row.workspace_revision_id),
    association: row.workspace_revision_id != null
      ? 'canonical_revision'
      : row.pipeline_id != null
        ? 'legacy_pipeline_alias'
        : 'unlinked_legacy',
    linkOrigin: row.performance_link_origin === 'canonical_api'
      ? 'canonical_api'
      : row.performance_link_origin === 'legacy_pipeline_backfill'
        ? 'legacy_pipeline_backfill'
        : null,
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

  // Try to update an existing pattern first. User rows are scoped by both
  // user and tenant so same numeric user IDs in different tenants cannot
  // rewrite each other's learned patterns.
  const existing = opts.userId === 0
    ? db.prepare(`
        SELECT id, frequency, examples FROM content_learned_patterns
        WHERE category = ? AND pattern_text = ? AND user_id = 0
      `).get(opts.category, opts.patternText) as any
    : db.prepare(`
        SELECT id, frequency, examples FROM content_learned_patterns
        WHERE category = ? AND pattern_text = ?
          AND ${contentScopePredicate()}
      `).get(opts.category, opts.patternText, ...contentScopeParams(opts.userId, opts.tenantId)) as any;

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
 * Build the tenant-scoped artifact chain for a canonical workspace item.
 *
 * `contentIdentifier` may be a current workspace item ID or a migration-246
 * compatibility ID. Resolution uses the immutable ingress binding; the frozen
 * legacy row itself is never read. Missing and foreign identifiers are
 * intentionally indistinguishable.
 */
export function getArtifactChain(
  contentIdentifier: number,
  userId: number,
  tenantId: number,
): ArtifactChain {
  const db = getDb();
  const scope = { tenantId, userId };
  const resolved = resolveContentWorkspaceIdentifier(scope, contentIdentifier, db);
  if (!resolved) return emptyArtifactChain(contentIdentifier);
  const item = getContentWorkspaceItemDetail(scope, resolved.itemId, db);
  if (!item) return emptyArtifactChain(contentIdentifier);

  const currentScripts = item.artifacts
    .filter((artifact) => artifact.artifactType === 'script' && artifact.currentRevision != null)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id - left.id);
  const scriptArtifact = currentScripts[0] ?? null;
  const currentRevision = scriptArtifact?.currentRevision ?? null;
  const script = scriptArtifact && currentRevision ? {
    id: scriptArtifact.id,
    scriptText: currentRevision.content.format === 'plain_text'
      || currentRevision.content.format === 'markdown'
      ? currentRevision.content.text
      : null,
    hook: null,
    titleOptions: [],
    hashtags: [],
    caption: null,
    cta: null,
    estimatedDuration: null,
    content: currentRevision.content,
  } : null;

  const performanceLinksAvailable = tableExists(db, 'content_performance_workspace_links');
  const canonicalPerfRows = performanceLinksAvailable ? db.prepare(`
    SELECT performance.id, performance.pipeline_id, performance.video_url,
           performance.views, performance.retention_pct, performance.likes,
           performance.comments, performance.subs_gained, performance.hook_used,
           performance.selected_title, performance.final_caption,
           performance.final_cta, performance.final_script_variant,
           performance.published_hashtags, performance.notes, performance.analysis,
           performance.user_id, performance.logged_at,
           link.item_id AS workspace_item_id,
           link.artifact_id AS workspace_artifact_id,
           link.revision_id AS workspace_revision_id,
           link.origin AS performance_link_origin
      FROM content_performance_workspace_links AS link
      JOIN content_performance AS performance
        ON performance.id = link.performance_id
       AND performance.tenant_id = link.tenant_id
       AND performance.owner_user_id = link.owner_user_id
     WHERE link.item_id = ?
       AND link.tenant_id = ? AND link.owner_user_id = ?
       AND ${contentScopePredicate('performance')}
  `).all(item.id, tenantId, userId, ...contentScopeParams(userId, tenantId)) as any[] : [];

  const legacyPerfRows = resolved.resolvedAs === 'legacy_pipeline_binding'
    ? performanceLinksAvailable
      ? db.prepare(`
        SELECT performance.id, performance.pipeline_id, performance.video_url,
               performance.views, performance.retention_pct, performance.likes,
               performance.comments, performance.subs_gained, performance.hook_used,
               performance.selected_title, performance.final_caption,
               performance.final_cta, performance.final_script_variant,
               performance.published_hashtags, performance.notes, performance.analysis,
               performance.user_id, performance.logged_at,
               NULL AS workspace_item_id,
               NULL AS workspace_artifact_id,
               NULL AS workspace_revision_id,
               NULL AS performance_link_origin
          FROM content_performance AS performance
         WHERE performance.pipeline_id = ?
           AND ${contentScopePredicate('performance')}
           AND NOT EXISTS (
             SELECT 1
               FROM content_performance_workspace_links AS link
              WHERE link.performance_id = performance.id
                AND link.tenant_id = performance.tenant_id
                AND link.owner_user_id = performance.owner_user_id
           )
      `).all(contentIdentifier, ...contentScopeParams(userId, tenantId)) as any[]
      : db.prepare(`
        SELECT performance.id, performance.pipeline_id, performance.video_url,
               performance.views, performance.retention_pct, performance.likes,
               performance.comments, performance.subs_gained, performance.hook_used,
               performance.selected_title, performance.final_caption,
               performance.final_cta, performance.final_script_variant,
               performance.published_hashtags, performance.notes, performance.analysis,
               performance.user_id, performance.logged_at,
               NULL AS workspace_item_id,
               NULL AS workspace_artifact_id,
               NULL AS workspace_revision_id,
               NULL AS performance_link_origin
          FROM content_performance AS performance
         WHERE performance.pipeline_id = ?
           AND ${contentScopePredicate('performance')}
      `).all(contentIdentifier, ...contentScopeParams(userId, tenantId)) as any[]
    : [];
  const perfRows = [...canonicalPerfRows, ...legacyPerfRows]
    .sort((left, right) => String(right.logged_at).localeCompare(String(left.logged_at)) || right.id - left.id);

  const revisionLineage = item.artifacts.flatMap((artifact) => artifact.currentRevision
    ? [getContentRevisionLineage(scope, artifact.currentRevision.id, db)]
    : []);

  return {
    schemaVersion: 'content-workspace-artifact-chain-v1',
    availability: 'available',
    source: 'content_workspace',
    identifier: {
      requestedId: contentIdentifier,
      workspaceItemId: item.id,
      resolvedAs: resolved.resolvedAs,
    },
    workspaceItem: item,
    revisionLineage,
    idea: {
      id: item.id,
      title: item.title,
      status: item.productionState,
      source: 'content_workspace',
    },
    topicFeedback: null,
    pipeline: {
      id: item.id,
      stage: item.productionState,
      scriptPath: null,
      youtubeVideoId: null,
      // `published` is an internal production state, not proof that Nexus
      // executed or observed an external platform publication.
      publishedAt: null,
      publicationTracking: {
        availability: 'unavailable',
        reasonCode: 'CONTENT_PUBLICATION_TRACKING_NOT_SUPPORTED',
        publicationExecution: 'not_supported',
      },
    },
    script,
    performance: perfRows.map(mapPerformance),
    patterns: [],
    compatibility: {
      legacyIdentifierAccepted: resolved.resolvedAs === 'legacy_pipeline_binding',
      legacyArchiveRead: false,
      performanceAssociation: canonicalPerfRows.length > 0
        ? 'canonical_revision'
        : legacyPerfRows.length > 0
          ? 'legacy_identifier_alias'
          : 'not_modeled',
      learnedPatternAssociation: 'not_modeled',
    },
  };
}

function emptyArtifactChain(contentIdentifier: number): ArtifactChain {
  return {
    schemaVersion: 'content-workspace-artifact-chain-v1',
    availability: 'not_found',
    source: 'content_workspace',
    identifier: {
      requestedId: contentIdentifier,
      workspaceItemId: null,
      resolvedAs: 'not_found',
    },
    workspaceItem: null,
    revisionLineage: [],
    idea: null,
    topicFeedback: null,
    pipeline: null,
    script: null,
    performance: [],
    patterns: [],
    compatibility: {
      legacyIdentifierAccepted: false,
      legacyArchiveRead: false,
      performanceAssociation: 'not_modeled',
      learnedPatternAssociation: 'not_modeled',
    },
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

function positiveMetadataInteger(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function tableExists(db: ReturnType<typeof getDb>, table: string): boolean {
  return Boolean(db.prepare(`
    SELECT 1
      FROM sqlite_master
     WHERE type = 'table' AND name = ?
     LIMIT 1
  `).get(table));
}
