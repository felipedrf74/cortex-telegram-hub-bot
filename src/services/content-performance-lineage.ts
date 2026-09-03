// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from './database';
import { logger } from '../utils/logger';
import { assertContentWorkspaceWriteEnabled } from './content-workspace-capabilities';
import {
  getContentArtifact,
  getContentRevision,
  type ContentWorkspaceScope,
} from './content-workspace';
import { recordContentPerformanceMemory } from './content-memory-profile';
import { safeContentLogErrorFields } from './content-log-safety';

export const CONTENT_PERFORMANCE_LINEAGE_SCHEMA_VERSION = 'content-performance-lineage-v1';
const RECORD_OUTCOME_OPERATION = 'record_content_performance';

export class ContentPerformanceLineageError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ContentPerformanceLineageError';
  }
}

export interface ContentPerformanceOutcome {
  id: number;
  workspaceItemId: number;
  artifactId: number;
  revisionId: number;
  association: 'canonical_revision';
  linkOrigin: 'canonical_api' | 'legacy_pipeline_backfill';
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
  analysis: unknown | null;
  userId: number;
  loggedAt: string;
}

export interface RecordContentPerformanceOutcomeInput {
  scope: ContentWorkspaceScope;
  itemId: number;
  artifactId: number;
  revisionId: number;
  idempotencyKey: string;
  videoUrl?: string | null;
  views: number;
  retentionPct: number;
  likes?: number;
  comments?: number;
  subsGained?: number;
  hookUsed?: string | null;
  selectedTitle?: string | null;
  finalCaption?: string | null;
  finalCta?: string | null;
  finalScriptVariant?: string | null;
  publishedHashtags?: string[];
  notes?: string | null;
  analysis?: unknown;
}

export interface ContentPerformanceOutcomeMutation {
  value: ContentPerformanceOutcome;
  replayed: boolean;
  created: boolean;
}

export function derivePerformanceMemory(opts: {
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

interface NormalizedInput extends Omit<RecordContentPerformanceOutcomeInput,
  'scope' | 'videoUrl' | 'likes' | 'comments' | 'subsGained' | 'hookUsed'
  | 'selectedTitle' | 'finalCaption' | 'finalCta' | 'finalScriptVariant'
  | 'publishedHashtags' | 'notes' | 'analysis'> {
  scope: ContentWorkspaceScope;
  videoUrl: string | null;
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
  analysis: unknown | null;
  analysisJson: string | null;
}

interface ReceiptRow {
  request_hash: string;
  resource_id: string;
  result_metadata_json: string;
}

/**
 * Persist a measured outcome, its immutable revision link, and the canonical
 * mutation receipt in one IMMEDIATE transaction. This records user-reported
 * performance only; it does not publish content or claim provider verification.
 */
export function recordContentPerformanceOutcome(
  rawInput: RecordContentPerformanceOutcomeInput,
  db: Database.Database = getDb(),
): ContentPerformanceOutcomeMutation {
  const input = normalizeInput(rawInput);
  assertContentWorkspaceWriteEnabled(input.scope, 'core');
  const requestHash = hashPayload({
    schemaVersion: CONTENT_PERFORMANCE_LINEAGE_SCHEMA_VERSION,
    itemId: input.itemId,
    artifactId: input.artifactId,
    revisionId: input.revisionId,
    videoUrl: input.videoUrl,
    views: input.views,
    retentionPct: input.retentionPct,
    likes: input.likes,
    comments: input.comments,
    subsGained: input.subsGained,
    hookUsed: input.hookUsed,
    selectedTitle: input.selectedTitle,
    finalCaption: input.finalCaption,
    finalCta: input.finalCta,
    finalScriptVariant: input.finalScriptVariant,
    publishedHashtags: input.publishedHashtags,
    notes: input.notes,
    analysis: input.analysis,
  });

  const mutation = db.transaction((): ContentPerformanceOutcomeMutation => {
    const receipt = db.prepare(`
      SELECT request_hash, resource_id, result_metadata_json
        FROM content_mutation_receipts
       WHERE tenant_id = ? AND owner_user_id = ?
         AND operation = ? AND idempotency_key = ?
       LIMIT 1
    `).get(
      input.scope.tenantId,
      input.scope.userId,
      RECORD_OUTCOME_OPERATION,
      input.idempotencyKey,
    ) as ReceiptRow | undefined;

    if (receipt) {
      if (receipt.request_hash !== requestHash) {
        throw new ContentPerformanceLineageError(
          'CONTENT_PERFORMANCE_IDEMPOTENCY_KEY_REUSED',
          'This idempotency key was already used for a different performance outcome.',
          409,
          { operation: RECORD_OUTCOME_OPERATION },
        );
      }
      const outcome = getContentPerformanceOutcome(
        input.scope,
        normalizeReceiptResourceId(receipt.resource_id),
        db,
      );
      const metadata = parseRecord(receipt.result_metadata_json);
      if (
        !outcome
        || outcome.workspaceItemId !== input.itemId
        || outcome.artifactId !== input.artifactId
        || outcome.revisionId !== input.revisionId
        || metadata.itemId !== input.itemId
        || metadata.artifactId !== input.artifactId
        || metadata.revisionId !== input.revisionId
      ) {
        throw new ContentPerformanceLineageError(
          'CONTENT_PERFORMANCE_RECEIPT_INCONSISTENT',
          'The saved performance receipt no longer matches its canonical revision.',
          500,
        );
      }
      return { value: outcome, replayed: true, created: false };
    }

    assertCanonicalTarget(input, db);

    const performance = db.prepare(`
      INSERT INTO content_performance (
        pipeline_id, video_url, views, retention_pct, likes, comments,
        subs_gained, hook_used, selected_title, final_caption, final_cta,
        final_script_variant, published_hashtags, notes, analysis, user_id,
        tenant_id, owner_user_id, visibility_scope, lifecycle_state, scope_status,
        created_by, updated_by, audit_metadata_json
      ) VALUES (
        NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, 'user_private', 'active', 'active', ?, ?, ?
      )
    `).run(
      input.videoUrl,
      input.views,
      input.retentionPct,
      input.likes,
      input.comments,
      input.subsGained,
      input.hookUsed,
      input.selectedTitle,
      input.finalCaption,
      input.finalCta,
      input.finalScriptVariant,
      JSON.stringify(input.publishedHashtags),
      input.notes,
      input.analysisJson,
      input.scope.userId,
      input.scope.tenantId,
      input.scope.userId,
      input.scope.userId,
      input.scope.userId,
      JSON.stringify({
        origin: 'canonical_api',
        lineageSchemaVersion: CONTENT_PERFORMANCE_LINEAGE_SCHEMA_VERSION,
      }),
    );
    const performanceId = Number(performance.lastInsertRowid);

    const link = db.prepare(`
      INSERT INTO content_performance_workspace_links (
        tenant_id, owner_user_id, performance_id, item_id,
        artifact_id, revision_id, origin
      ) VALUES (?, ?, ?, ?, ?, ?, 'canonical_api')
    `).run(
      input.scope.tenantId,
      input.scope.userId,
      performanceId,
      input.itemId,
      input.artifactId,
      input.revisionId,
    );
    const linkId = Number(link.lastInsertRowid);

    db.prepare(`
      INSERT INTO content_mutation_receipts (
        tenant_id, owner_user_id, operation, idempotency_key,
        request_hash, resource_type, resource_id, result_metadata_json
      ) VALUES (?, ?, ?, ?, ?, 'content_performance', ?, ?)
    `).run(
      input.scope.tenantId,
      input.scope.userId,
      RECORD_OUTCOME_OPERATION,
      input.idempotencyKey,
      requestHash,
      String(performanceId),
      JSON.stringify({
        itemId: input.itemId,
        artifactId: input.artifactId,
        revisionId: input.revisionId,
        linkId,
        lineageSchemaVersion: CONTENT_PERFORMANCE_LINEAGE_SCHEMA_VERSION,
      }),
    );

    const outcome = getContentPerformanceOutcome(input.scope, performanceId, db);
    if (!outcome) {
      throw new ContentPerformanceLineageError(
        'CONTENT_PERFORMANCE_WRITE_FAILED',
        'The performance outcome was not readable after it was saved.',
        500,
      );
    }
    return { value: outcome, replayed: false, created: true };
  }).immediate();

  if (mutation.created) updatePerformanceMemoryBestEffort(input, mutation.value.id);
  return mutation;
}

export function getContentPerformanceOutcome(
  scopeInput: ContentWorkspaceScope,
  performanceId: number,
  db: Database.Database = getDb(),
): ContentPerformanceOutcome | null {
  const scope = normalizeScope(scopeInput);
  const id = positiveInteger(performanceId, 'performanceId');
  const row = db.prepare(`${outcomeSelectSql()}
    WHERE performance.id = ?
      AND performance.tenant_id = ?
      AND performance.owner_user_id = ?
      AND performance.user_id = ?
      AND performance.visibility_scope = 'user_private'
      AND performance.scope_status = 'active'
    LIMIT 1
  `).get(id, scope.tenantId, scope.userId, scope.userId) as Record<string, unknown> | undefined;
  return row ? mapOutcome(row) : null;
}

export function listContentPerformanceOutcomesForItem(
  scopeInput: ContentWorkspaceScope,
  itemId: number,
  db: Database.Database = getDb(),
): ContentPerformanceOutcome[] {
  const scope = normalizeScope(scopeInput);
  const id = positiveInteger(itemId, 'itemId');
  const rows = db.prepare(`${outcomeSelectSql()}
    WHERE link.item_id = ?
      AND link.tenant_id = ?
      AND link.owner_user_id = ?
      AND performance.user_id = ?
      AND performance.visibility_scope = 'user_private'
      AND performance.scope_status = 'active'
    ORDER BY performance.logged_at DESC, performance.id DESC
  `).all(id, scope.tenantId, scope.userId, scope.userId) as Array<Record<string, unknown>>;
  return rows.map(mapOutcome);
}

/** Fail startup if migration 250's schema or writer guards are incomplete. */
export function assertContentPerformanceWorkspaceLineageReady(
  db: Database.Database = getDb(),
): void {
  const table = db.prepare(`
    SELECT 1 FROM sqlite_master
     WHERE type = 'table' AND name = 'content_performance_workspace_links'
  `).get();
  const requiredTriggers = new Set([
    'trg_content_performance_workspace_links_scope_insert',
    'trg_content_performance_workspace_links_immutable',
    'trg_content_performance_pipeline_alias_insert_blocked',
    'trg_content_performance_pipeline_alias_update_blocked',
  ]);
  const triggerRows = db.prepare(`
    SELECT name FROM sqlite_master
     WHERE type = 'trigger' AND name LIKE 'trg_content_performance_%'
  `).all() as Array<{ name: string }>;
  const present = new Set(triggerRows.map((row) => row.name));
  if (!table || [...requiredTriggers].some((name) => !present.has(name))) {
    throw new Error('Content performance workspace lineage migration 250 is incomplete');
  }

  const invalidCanonical = db.prepare(`
    SELECT performance.id
      FROM content_performance AS performance
      LEFT JOIN content_performance_workspace_links AS link
        ON link.performance_id = performance.id
       AND link.tenant_id = performance.tenant_id
       AND link.owner_user_id = performance.owner_user_id
     WHERE json_extract(performance.audit_metadata_json, '$.origin') = 'canonical_api'
       AND (
         performance.pipeline_id IS NOT NULL
         OR link.performance_id IS NULL
         OR link.origin <> 'canonical_api'
       )
     LIMIT 1
  `).get();
  if (invalidCanonical) {
    throw new Error('Canonical Content performance outcome is missing immutable workspace lineage');
  }

  const invalidLink = db.prepare(`
    SELECT link.id
      FROM content_performance_workspace_links AS link
      LEFT JOIN content_performance AS performance
        ON performance.id = link.performance_id
       AND performance.tenant_id = link.tenant_id
       AND performance.owner_user_id = link.owner_user_id
      LEFT JOIN content_domain_objects AS item
        ON item.id = link.item_id
       AND item.tenant_id = link.tenant_id
       AND item.owner_user_id = link.owner_user_id
      LEFT JOIN content_artifacts AS artifact
        ON artifact.id = link.artifact_id
       AND artifact.item_id = link.item_id
       AND artifact.tenant_id = link.tenant_id
       AND artifact.owner_user_id = link.owner_user_id
      LEFT JOIN content_revisions AS revision
        ON revision.id = link.revision_id
       AND revision.artifact_id = link.artifact_id
       AND revision.tenant_id = link.tenant_id
       AND revision.owner_user_id = link.owner_user_id
     WHERE performance.id IS NULL
        OR performance.user_id <> link.owner_user_id
        OR performance.visibility_scope <> 'user_private'
        OR performance.scope_status <> 'active'
        OR item.id IS NULL
        OR item.object_type <> 'content_item'
        OR item.visibility_scope <> 'user_private'
        OR item.scope_status <> 'active'
        OR artifact.id IS NULL
        OR artifact.visibility_scope <> 'user_private'
        OR artifact.scope_status <> 'active'
        OR revision.id IS NULL
        OR (link.origin = 'canonical_api' AND performance.pipeline_id IS NOT NULL)
     LIMIT 1
  `).get();
  if (invalidLink) {
    throw new Error('Content performance workspace lineage contains an invalid scoped link');
  }
}

function assertCanonicalTarget(input: NormalizedInput, db: Database.Database): void {
  const item = db.prepare(`
    SELECT id
      FROM content_domain_objects
     WHERE id = ? AND tenant_id = ? AND owner_user_id = ?
       AND visibility_scope = 'user_private'
       AND scope_status = 'active'
       AND object_type = 'content_item'
     LIMIT 1
  `).get(input.itemId, input.scope.tenantId, input.scope.userId);
  const artifact = getContentArtifact(input.scope, input.artifactId, db);
  const revision = getContentRevision(input.scope, input.revisionId, db);
  if (!item || !artifact || artifact.itemId !== input.itemId || !revision || revision.artifactId !== input.artifactId) {
    throw new ContentPerformanceLineageError(
      'CONTENT_PERFORMANCE_TARGET_NOT_FOUND',
      'Content item, artifact, or revision not found.',
      404,
    );
  }
}

function outcomeSelectSql(): string {
  return `
    SELECT performance.*,
           link.item_id AS workspace_item_id,
           link.artifact_id AS workspace_artifact_id,
           link.revision_id AS workspace_revision_id,
           link.origin AS link_origin
      FROM content_performance AS performance
      JOIN content_performance_workspace_links AS link
        ON link.performance_id = performance.id
       AND link.tenant_id = performance.tenant_id
       AND link.owner_user_id = performance.owner_user_id
  `;
}

function mapOutcome(row: Record<string, unknown>): ContentPerformanceOutcome {
  return {
    id: Number(row.id),
    workspaceItemId: Number(row.workspace_item_id),
    artifactId: Number(row.workspace_artifact_id),
    revisionId: Number(row.workspace_revision_id),
    association: 'canonical_revision',
    linkOrigin: row.link_origin === 'legacy_pipeline_backfill' ? 'legacy_pipeline_backfill' : 'canonical_api',
    pipelineId: row.pipeline_id == null ? null : Number(row.pipeline_id),
    videoUrl: nullableString(row.video_url),
    views: Number(row.views ?? 0),
    retentionPct: Number(row.retention_pct ?? 0),
    likes: Number(row.likes ?? 0),
    comments: Number(row.comments ?? 0),
    subsGained: Number(row.subs_gained ?? 0),
    hookUsed: nullableString(row.hook_used),
    selectedTitle: nullableString(row.selected_title),
    finalCaption: nullableString(row.final_caption),
    finalCta: nullableString(row.final_cta),
    finalScriptVariant: nullableString(row.final_script_variant),
    publishedHashtags: parseStringArray(row.published_hashtags),
    notes: nullableString(row.notes),
    analysis: parseUnknown(row.analysis),
    userId: Number(row.user_id),
    loggedAt: String(row.logged_at),
  };
}

function normalizeInput(raw: RecordContentPerformanceOutcomeInput): NormalizedInput {
  if (!raw || typeof raw !== 'object') {
    throw validationError('body', 'A performance outcome body is required.');
  }
  const scope = normalizeScope(raw.scope);
  const itemId = positiveInteger(raw.itemId, 'itemId');
  const artifactId = positiveInteger(raw.artifactId, 'artifactId');
  const revisionId = positiveInteger(raw.revisionId, 'revisionId');
  const idempotencyKey = requiredText(raw.idempotencyKey, 'idempotencyKey', 200);
  const views = nonNegativeInteger(raw.views, 'views');
  const retentionPct = boundedNumber(raw.retentionPct, 'retentionPct', 0, 100);
  const likes = optionalNonNegativeInteger(raw.likes, 'likes');
  const comments = optionalNonNegativeInteger(raw.comments, 'comments');
  const subsGained = optionalNonNegativeInteger(raw.subsGained, 'subsGained');
  const videoUrl = normalizeUrl(raw.videoUrl);
  const hookUsed = optionalText(raw.hookUsed, 'hookUsed', 2_000);
  const selectedTitle = optionalText(raw.selectedTitle, 'selectedTitle', 500);
  const finalCaption = optionalText(raw.finalCaption, 'finalCaption', 10_000);
  const finalCta = optionalText(raw.finalCta, 'finalCta', 2_000);
  const finalScriptVariant = optionalText(raw.finalScriptVariant, 'finalScriptVariant', 50_000);
  const publishedHashtags = normalizeHashtags(raw.publishedHashtags);
  const notes = optionalText(raw.notes, 'notes', 20_000);
  const analysisJson = raw.analysis == null ? null : boundedJson(raw.analysis, 'analysis', 20_000);
  const analysis = analysisJson == null ? null : JSON.parse(analysisJson);
  return {
    scope,
    itemId,
    artifactId,
    revisionId,
    idempotencyKey,
    videoUrl,
    views,
    retentionPct,
    likes,
    comments,
    subsGained,
    hookUsed,
    selectedTitle,
    finalCaption,
    finalCta,
    finalScriptVariant,
    publishedHashtags,
    notes,
    analysis,
    analysisJson,
  };
}

function normalizeScope(scope: ContentWorkspaceScope): ContentWorkspaceScope {
  if (!scope || !Number.isSafeInteger(scope.tenantId) || scope.tenantId <= 0) {
    throw validationError('tenantId', 'A valid tenant scope is required.');
  }
  if (!Number.isSafeInteger(scope.userId) || scope.userId <= 0) {
    throw validationError('userId', 'A valid user scope is required.');
  }
  return { tenantId: scope.tenantId, userId: scope.userId };
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw validationError(field, `${field} must be a positive integer.`);
  }
  return Number(value);
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw validationError(field, `${field} must be a non-negative integer.`);
  }
  return Number(value);
}

function optionalNonNegativeInteger(value: unknown, field: string): number {
  return value === undefined ? 0 : nonNegativeInteger(value, field);
}

function boundedNumber(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw validationError(field, `${field} must be between ${min} and ${max}.`);
  }
  return value;
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  const normalized = optionalText(value, field, maxLength);
  if (!normalized) throw validationError(field, `${field} is required.`);
  return normalized;
}

function optionalText(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw validationError(field, `${field} must be a string.`);
  const normalized = value.replace(/\u0000/g, '').trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) {
    throw validationError(field, `${field} is too long.`, { maxLength });
  }
  return normalized;
}

function normalizeUrl(value: unknown): string | null {
  const normalized = optionalText(value, 'videoUrl', 2_048);
  if (!normalized) return null;
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw validationError('videoUrl', 'videoUrl must be a valid HTTP or HTTPS URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw validationError('videoUrl', 'videoUrl must be a valid HTTP or HTTPS URL.');
  }
  if (url.username || url.password) {
    throw validationError('videoUrl', 'videoUrl must not contain embedded credentials.');
  }
  return url.toString();
}

function normalizeHashtags(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 30) {
    throw validationError('publishedHashtags', 'publishedHashtags must contain at most 30 strings.');
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw validationError('publishedHashtags', `publishedHashtags[${index}] must be a string.`);
    }
    const normalized = entry.replace(/\u0000/g, '').trim();
    if (!normalized || normalized.length > 200) {
      throw validationError('publishedHashtags', `publishedHashtags[${index}] must contain 1 to 200 characters.`);
    }
    return normalized;
  });
}

function boundedJson(value: unknown, field: string, maxLength: number): string {
  let encoded: string;
  try {
    encoded = stableJson(value);
  } catch {
    throw validationError(field, `${field} must be JSON-serializable.`);
  }
  if (encoded.length > maxLength) throw validationError(field, `${field} is too large.`, { maxLength });
  return encoded;
}

function validationError(field: string, message: string, details: Record<string, unknown> = {}): ContentPerformanceLineageError {
  return new ContentPerformanceLineageError(
    'CONTENT_PERFORMANCE_VALIDATION_FAILED',
    message,
    400,
    { field, ...details },
  );
}

function normalizeReceiptResourceId(value: string): number {
  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ContentPerformanceLineageError(
      'CONTENT_PERFORMANCE_RECEIPT_INCONSISTENT',
      'The saved performance receipt is invalid.',
      500,
    );
  }
  return parsed;
}

function updatePerformanceMemoryBestEffort(input: NormalizedInput, performanceId: number): void {
  const memory = derivePerformanceMemory({
    views: input.views,
    retentionPct: input.retentionPct,
    likes: input.likes,
    comments: input.comments,
    subsGained: input.subsGained,
    hookUsed: input.hookUsed ?? undefined,
    selectedTitle: input.selectedTitle ?? undefined,
    finalScriptVariant: input.finalScriptVariant ?? undefined,
    publishedHashtags: input.publishedHashtags,
    analysis: input.analysis,
  });
  if (!memory) return;
  try {
    recordContentPerformanceMemory({
      tenantId: input.scope.tenantId,
      userId: input.scope.userId,
      scope: 'user_private',
      source: 'content_performance_feedback',
      confidence: memory.confidence,
      successfulTopics: memory.successfulTopics,
      weakTopics: memory.weakTopics,
      successfulHooks: memory.successfulHooks,
      successfulFormats: memory.successfulFormats,
      rejectedPatterns: memory.rejectedPatterns,
      audienceResponseSignals: memory.audienceResponseSignals,
    });
  } catch (error) {
    logger.warn(
      {
        performanceId,
        tenantId: input.scope.tenantId,
        userId: input.scope.userId,
        ...safeContentLogErrorFields(error),
      },
      'Canonical Content performance outcome stored but memory update failed',
    );
  }
}

function hashPayload(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('Non-finite number');
  }
  return value;
}

function parseRecord(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseStringArray(raw: unknown): string[] {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function parseUnknown(raw: unknown): unknown | null {
  if (raw == null) return null;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
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
