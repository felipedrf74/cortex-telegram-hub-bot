// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Canonical idea projections used by Content workflow consumers.
 *
 * Discovery ideas live in the Content workspace as private `idea_note`
 * artifacts. Consumption is represented by an immutable mutation receipt and
 * matching workflow event; no second mutable idea status/root is introduced.
 */

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from './database';
import type { ContentWorkspaceScope } from './content-workspace';
import { assertContentWorkspaceWriteEnabled } from './content-workspace-capabilities';

export const CONTENT_WORKSPACE_IDEA_CONSUMER_SCHEMA_VERSION =
  'content-workspace-idea-consumer-v1' as const;

const DISCOVERY_CONSUMPTION_OPERATION = 'consume_discovery_idea_for_topic_inventory';

export interface ContentWorkspaceIdeaCandidate {
  itemId: number;
  artifactId: number;
  title: string;
  angleTag: string | null;
  score: number;
  createdAt: string;
}

export interface RecordDiscoveryIdeaConsumptionInput {
  scope: ContentWorkspaceScope;
  ideas: ReadonlyArray<Pick<ContentWorkspaceIdeaCandidate, 'itemId' | 'artifactId'>>;
  sourceJob: string;
  candidateFeedbackIds: readonly number[];
}

export interface DiscoveryIdeaConsumptionResult {
  recorded: number;
  replayed: number;
}

/** Return recent, current, unconsumed Discovery ideas for workflow enrichment. */
export function getWorkflowEligibleDiscoveryIdeas(
  scopeInput: ContentWorkspaceScope,
  limit = 10,
  db: Database.Database = getDb(),
): ContentWorkspaceIdeaCandidate[] {
  const scope = normalizeScope(scopeInput);
  const boundedLimit = normalizeLimit(limit, 1, 50);
  return db.prepare(`
    SELECT item.id AS item_id,
           artifact.id AS artifact_id,
           COALESCE(NULLIF(TRIM(revision.content_text), ''), artifact.title, item.title) AS title,
           json_extract(artifact.metadata_json, '$.angleTag') AS angle_tag,
           COALESCE(json_extract(artifact.metadata_json, '$.score'), 0) AS score,
           artifact.created_at
      FROM content_domain_objects AS item
      JOIN content_artifacts AS artifact
        ON artifact.id = item.current_artifact_id
       AND artifact.item_id = item.id
       AND artifact.tenant_id = item.tenant_id
       AND artifact.owner_user_id = item.owner_user_id
      JOIN content_revisions AS revision
        ON revision.id = artifact.current_revision_id
       AND revision.artifact_id = artifact.id
       AND revision.tenant_id = artifact.tenant_id
       AND revision.owner_user_id = artifact.owner_user_id
     WHERE item.tenant_id = ?
       AND item.owner_user_id = ?
       AND item.visibility_scope = 'user_private'
       AND item.scope_status = 'active'
       AND item.object_type = 'content_item'
       AND item.deleted_at IS NULL
       AND item.production_state IN ('inbox', 'active')
       AND artifact.visibility_scope = 'user_private'
       AND artifact.scope_status = 'active'
       AND artifact.artifact_type = 'idea_note'
       AND json_valid(artifact.metadata_json) = 1
       AND json_extract(artifact.metadata_json, '$.captureOrigin') = 'discovery'
       AND json_extract(artifact.metadata_json, '$.workflowEligible') = 1
       AND artifact.created_at > datetime('now', '-7 days')
       AND NOT EXISTS (
         SELECT 1
           FROM content_mutation_receipts AS receipt
          WHERE receipt.tenant_id = item.tenant_id
            AND receipt.owner_user_id = item.owner_user_id
            AND receipt.operation = ?
            AND receipt.resource_type = 'artifact'
            AND receipt.resource_id = CAST(artifact.id AS TEXT)
       )
     ORDER BY score DESC, artifact.created_at DESC, artifact.id DESC
     LIMIT ?
  `).all(
    scope.tenantId,
    scope.userId,
    DISCOVERY_CONSUMPTION_OPERATION,
    boundedLimit,
  ).map(mapIdeaCandidate);
}

/**
 * Record source consumption after generated candidates have been inserted.
 * Callers should invoke this in the same transaction, after candidate writes,
 * so a receipt/event failure rolls the candidate write back as one unit.
 */
export function recordDiscoveryIdeaConsumption(
  input: RecordDiscoveryIdeaConsumptionInput,
  db: Database.Database = getDb(),
): DiscoveryIdeaConsumptionResult {
  const scope = normalizeScope(input.scope);
  assertContentWorkspaceWriteEnabled(scope, 'core');
  const sourceJob = normalizeText(input.sourceJob, 'sourceJob', 120);
  const candidateFeedbackIds = Array.from(new Set(input.candidateFeedbackIds.map(normalizePositiveId))).sort((a, b) => a - b);
  if (candidateFeedbackIds.length === 0) {
    return { recorded: 0, replayed: 0 };
  }
  assertCandidateInventoryPersisted(scope, sourceJob, candidateFeedbackIds, db);

  const ideas = uniqueIdeas(input.ideas);
  let recorded = 0;
  let replayed = 0;
  for (const idea of ideas) {
    const current = getScopedDiscoveryArtifact(scope, idea, db);
    if (!current) continue;

    const idempotencyKey = `content-workflow-discovery-consume:${current.artifactId}`;
    const requestHash = hashJson({
      schemaVersion: CONTENT_WORKSPACE_IDEA_CONSUMER_SCHEMA_VERSION,
      itemId: current.itemId,
      artifactId: current.artifactId,
    });
    const existing = db.prepare(`
      SELECT request_hash
        FROM content_mutation_receipts
       WHERE tenant_id = ? AND owner_user_id = ?
         AND operation = ? AND idempotency_key = ?
       LIMIT 1
    `).get(
      scope.tenantId,
      scope.userId,
      DISCOVERY_CONSUMPTION_OPERATION,
      idempotencyKey,
    ) as { request_hash: string } | undefined;
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw new Error('CONTENT_DISCOVERY_CONSUMPTION_RECEIPT_CONFLICT');
      }
      replayed += 1;
      continue;
    }

    const metadata = stableJson({
      schemaVersion: CONTENT_WORKSPACE_IDEA_CONSUMER_SCHEMA_VERSION,
      sourceJob,
      candidateFeedbackIds,
      candidateCount: candidateFeedbackIds.length,
      itemId: current.itemId,
      artifactId: current.artifactId,
    });
    db.prepare(`
      INSERT INTO content_mutation_receipts (
        tenant_id, owner_user_id, operation, idempotency_key,
        request_hash, resource_type, resource_id, result_metadata_json
      ) VALUES (?, ?, ?, ?, ?, 'artifact', ?, ?)
    `).run(
      scope.tenantId,
      scope.userId,
      DISCOVERY_CONSUMPTION_OPERATION,
      idempotencyKey,
      requestHash,
      String(current.artifactId),
      metadata,
    );
    db.prepare(`
      INSERT INTO content_workflow_events (
        tenant_id, owner_user_id, visibility_scope, scope_status,
        object_type, object_id, action, from_state, to_state,
        approval_state, review_required, reason_codes_json,
        actor_user_id, metadata_json
      ) VALUES (?, ?, 'user_private', 'active', 'content_item', ?,
        'discovery_idea_consumed', ?, ?, 'not_required', 0, '[]', ?, ?)
    `).run(
      scope.tenantId,
      scope.userId,
      String(current.itemId),
      current.productionState,
      current.productionState,
      scope.userId,
      metadata,
    );
    recorded += 1;
  }
  return { recorded, replayed };
}

function assertCandidateInventoryPersisted(
  scope: ContentWorkspaceScope,
  sourceJob: string,
  candidateFeedbackIds: readonly number[],
  db: Database.Database,
): void {
  const placeholders = candidateFeedbackIds.map(() => '?').join(', ');
  const row = db.prepare(`
    SELECT COUNT(DISTINCT id) AS count
      FROM content_topic_feedback
     WHERE id IN (${placeholders})
       AND user_id = ?
       AND tenant_id = ?
       AND owner_user_id = ?
       AND source_job = ?
       AND visibility_scope = 'user_private'
       AND scope_status = 'active'
  `).get(
    ...candidateFeedbackIds,
    scope.userId,
    scope.tenantId,
    scope.userId,
    sourceJob,
  ) as { count: unknown } | undefined;
  if (safeCount(row?.count) !== candidateFeedbackIds.length) {
    throw new Error('CONTENT_DISCOVERY_CONSUMPTION_CANDIDATES_NOT_PERSISTED');
  }
}

/** Count private, active canonical Content items for daily context. */
export function countActiveContentWorkspaceItems(
  scopeInput: ContentWorkspaceScope,
  db: Database.Database = getDb(),
): number {
  const scope = normalizeScope(scopeInput);
  const row = db.prepare(`
    SELECT COUNT(*) AS count
      FROM content_domain_objects
     WHERE tenant_id = ?
       AND owner_user_id = ?
       AND visibility_scope = 'user_private'
       AND scope_status = 'active'
       AND object_type = 'content_item'
       AND deleted_at IS NULL
       AND production_state NOT IN ('published', 'archived', 'rejected')
  `).get(scope.tenantId, scope.userId) as { count: unknown } | undefined;
  return safeCount(row?.count);
}

/** Return current canonical idea titles for deterministic recent-title dedup. */
export function getRecentContentWorkspaceIdeas(
  scopeInput: ContentWorkspaceScope,
  days = 14,
  limit = 30,
  db: Database.Database = getDb(),
): Array<{ title: string; angle_tag: string | null }> {
  const scope = normalizeScope(scopeInput);
  const boundedDays = normalizeLimit(days, 1, 3650);
  const boundedLimit = normalizeLimit(limit, 1, 200);
  return db.prepare(`
    SELECT COALESCE(NULLIF(TRIM(revision.content_text), ''), artifact.title, item.title) AS title,
           CASE WHEN json_valid(artifact.metadata_json) = 1
             THEN json_extract(artifact.metadata_json, '$.angleTag')
             ELSE NULL END AS angle_tag
      FROM content_domain_objects AS item
      JOIN content_artifacts AS artifact
        ON artifact.item_id = item.id
       AND artifact.tenant_id = item.tenant_id
       AND artifact.owner_user_id = item.owner_user_id
      JOIN content_revisions AS revision
        ON revision.id = artifact.current_revision_id
       AND revision.artifact_id = artifact.id
       AND revision.tenant_id = artifact.tenant_id
       AND revision.owner_user_id = artifact.owner_user_id
     WHERE item.tenant_id = ?
       AND item.owner_user_id = ?
       AND item.visibility_scope = 'user_private'
       AND item.scope_status = 'active'
       AND item.object_type = 'content_item'
       AND item.deleted_at IS NULL
       AND item.current_artifact_id = artifact.id
       AND artifact.visibility_scope = 'user_private'
       AND artifact.scope_status = 'active'
       AND artifact.artifact_type = 'idea_note'
       AND artifact.created_at > datetime('now', ?)
     ORDER BY artifact.created_at DESC, artifact.id DESC
     LIMIT ?
  `).all(
    scope.tenantId,
    scope.userId,
    `-${boundedDays} days`,
    boundedLimit,
  ).map((row: any) => ({
    title: String(row.title),
    angle_tag: typeof row.angle_tag === 'string' && row.angle_tag.trim() ? row.angle_tag : null,
  }));
}

/** Aggregate current canonical idea angles for diversity prompts. */
export function getContentWorkspaceIdeaAngleCounts(
  scopeInput: ContentWorkspaceScope,
  days = 30,
  db: Database.Database = getDb(),
): Array<{ angle_tag: string; cnt: number }> {
  const scope = normalizeScope(scopeInput);
  const boundedDays = normalizeLimit(days, 1, 3650);
  return db.prepare(`
    SELECT json_extract(artifact.metadata_json, '$.angleTag') AS angle_tag,
           COUNT(*) AS cnt
      FROM content_domain_objects AS item
      JOIN content_artifacts AS artifact
        ON artifact.item_id = item.id
       AND artifact.tenant_id = item.tenant_id
       AND artifact.owner_user_id = item.owner_user_id
      JOIN content_revisions AS revision
        ON revision.id = artifact.current_revision_id
       AND revision.artifact_id = artifact.id
       AND revision.tenant_id = artifact.tenant_id
       AND revision.owner_user_id = artifact.owner_user_id
     WHERE item.tenant_id = ?
       AND item.owner_user_id = ?
       AND item.visibility_scope = 'user_private'
       AND item.scope_status = 'active'
       AND item.object_type = 'content_item'
       AND item.deleted_at IS NULL
       AND item.current_artifact_id = artifact.id
       AND artifact.visibility_scope = 'user_private'
       AND artifact.scope_status = 'active'
       AND artifact.artifact_type = 'idea_note'
       AND json_valid(artifact.metadata_json) = 1
       AND NULLIF(TRIM(json_extract(artifact.metadata_json, '$.angleTag')), '') IS NOT NULL
       AND artifact.created_at > datetime('now', ?)
     GROUP BY angle_tag
  `).all(
    scope.tenantId,
    scope.userId,
    `-${boundedDays} days`,
  ).map((row: any) => ({ angle_tag: String(row.angle_tag), cnt: safeCount(row.cnt) }));
}

function getScopedDiscoveryArtifact(
  scope: ContentWorkspaceScope,
  idea: { itemId: number; artifactId: number },
  db: Database.Database,
): { itemId: number; artifactId: number; productionState: string } | null {
  const row = db.prepare(`
    SELECT item.id AS item_id, artifact.id AS artifact_id,
           item.production_state
      FROM content_domain_objects AS item
      JOIN content_artifacts AS artifact
        ON artifact.id = ?
       AND artifact.item_id = item.id
       AND artifact.tenant_id = item.tenant_id
       AND artifact.owner_user_id = item.owner_user_id
      JOIN content_revisions AS revision
        ON revision.id = artifact.current_revision_id
       AND revision.artifact_id = artifact.id
       AND revision.tenant_id = artifact.tenant_id
       AND revision.owner_user_id = artifact.owner_user_id
     WHERE item.id = ?
       AND item.tenant_id = ?
       AND item.owner_user_id = ?
       AND item.visibility_scope = 'user_private'
       AND item.scope_status = 'active'
       AND item.object_type = 'content_item'
       AND item.deleted_at IS NULL
       AND item.current_artifact_id = artifact.id
       AND item.production_state IN ('inbox', 'active')
       AND artifact.visibility_scope = 'user_private'
       AND artifact.scope_status = 'active'
       AND artifact.artifact_type = 'idea_note'
       AND json_valid(artifact.metadata_json) = 1
       AND json_extract(artifact.metadata_json, '$.captureOrigin') = 'discovery'
       AND json_extract(artifact.metadata_json, '$.workflowEligible') = 1
     LIMIT 1
  `).get(
    idea.artifactId,
    idea.itemId,
    scope.tenantId,
    scope.userId,
  ) as { item_id: number; artifact_id: number; production_state: string } | undefined;
  return row ? {
    itemId: Number(row.item_id),
    artifactId: Number(row.artifact_id),
    productionState: row.production_state,
  } : null;
}

function uniqueIdeas(
  ideas: ReadonlyArray<Pick<ContentWorkspaceIdeaCandidate, 'itemId' | 'artifactId'>>,
): Array<{ itemId: number; artifactId: number }> {
  const byArtifact = new Map<number, { itemId: number; artifactId: number }>();
  for (const idea of ideas) {
    const itemId = normalizePositiveId(idea.itemId);
    const artifactId = normalizePositiveId(idea.artifactId);
    const existing = byArtifact.get(artifactId);
    if (existing && existing.itemId !== itemId) {
      throw new Error('CONTENT_DISCOVERY_CONSUMPTION_IDENTITY_CONFLICT');
    }
    byArtifact.set(artifactId, { itemId, artifactId });
  }
  return Array.from(byArtifact.values()).sort((left, right) => left.artifactId - right.artifactId);
}

function mapIdeaCandidate(row: any): ContentWorkspaceIdeaCandidate {
  return {
    itemId: Number(row.item_id),
    artifactId: Number(row.artifact_id),
    title: String(row.title),
    angleTag: typeof row.angle_tag === 'string' && row.angle_tag.trim() ? row.angle_tag : null,
    score: Number.isFinite(Number(row.score)) ? Number(row.score) : 0,
    createdAt: String(row.created_at),
  };
}

function normalizeScope(scope: ContentWorkspaceScope): ContentWorkspaceScope {
  return {
    tenantId: normalizePositiveId(scope?.tenantId),
    userId: normalizePositiveId(scope?.userId),
  };
}

function normalizePositiveId(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error('CONTENT_WORKSPACE_IDEA_SCOPE_INVALID');
  }
  return Number(value);
}

function normalizeLimit(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error('CONTENT_WORKSPACE_IDEA_LIMIT_INVALID');
  }
  return value;
}

function normalizeText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw new Error(`CONTENT_WORKSPACE_IDEA_${field.toUpperCase()}_INVALID`);
  }
  return value.trim();
}

function safeCount(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]));
  }
  return value;
}
