// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type Database from 'better-sqlite3';
import { getDb } from './database';
import { getContentRevisionClaimPolicy } from './content-workspace-lineage';
import {
  recordContentWorkspaceProductSignal,
  startContentWorkspaceObservation,
} from './content-workspace-observability';
import { assertContentWorkspaceWriteEnabled } from './content-workspace-capabilities';
import {
  loadContentWorkScheduleSummaries,
  type ContentWorkScheduleSummary,
} from './content-workspace-schedule-summary';
export type { ContentWorkScheduleSummary } from './content-workspace-schedule-summary';

export const CONTENT_WORKSPACE_SCHEMA_VERSION = 'content-workspace-v1';

export const CONTENT_WORKSPACE_ITEM_TYPES = ['content_item', 'project'] as const;
export type ContentWorkspaceItemType = typeof CONTENT_WORKSPACE_ITEM_TYPES[number];

export const CONTENT_PRODUCTION_STATES = [
  'inbox',
  'active',
  'review',
  'approved',
  'scheduled',
  'published',
  'archived',
  'rejected',
] as const;
export type ContentProductionState = typeof CONTENT_PRODUCTION_STATES[number];

export const CONTENT_ARTIFACT_PHASES = ['idea', 'brief', 'outline', 'draft', 'final'] as const;
export type ContentArtifactPhase = typeof CONTENT_ARTIFACT_PHASES[number];

export const CONTENT_ARTIFACT_TYPES = [
  'idea_note',
  'brief',
  'outline',
  'script',
  'caption',
  'shot_list',
  'platform_variant',
  'research_notes',
  'other',
] as const;
export type ContentArtifactType = typeof CONTENT_ARTIFACT_TYPES[number];

export const CONTENT_RELATIONSHIP_TYPES = [
  'contains',
  'derived_from',
  'variant_of',
  'remix_of',
  'related_to',
] as const;
export type ContentRelationshipType = typeof CONTENT_RELATIONSHIP_TYPES[number];

export const CONTENT_WORKSPACE_COPY_MODES = ['duplicate', 'remix'] as const;
export type ContentWorkspaceCopyMode = typeof CONTENT_WORKSPACE_COPY_MODES[number];

export const CONTENT_NEXT_ACTIONS = [
  'add_content_item',
  'develop_brief',
  'create_outline',
  'draft_content',
  'revise_content',
  'submit_for_review',
  'review_content',
  'schedule_work',
  'view_work_schedule',
  'prepare_scheduled_work',
  'recover_work_schedule',
  'cancel_work_schedule',
  'prepare_publish',
  'repurpose_content',
  'restore_to_inbox',
  'none',
] as const;
export type ContentNextActionId = typeof CONTENT_NEXT_ACTIONS[number];

export const CONTENT_WORKSPACE_SORTS = [
  'updated_desc',
  'created_desc',
  'title_asc',
  'deadline_asc',
  'priority_asc',
  'priority_desc',
] as const;
export type ContentWorkspaceSort = typeof CONTENT_WORKSPACE_SORTS[number];

export interface ContentWorkspaceScope {
  tenantId: number;
  userId: number;
}

export interface ContentNextAction {
  action: ContentNextActionId;
  label: string;
  reason: string;
}

export interface ContentTag {
  id: number;
  name: string;
  normalizedName: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContentWorkspaceItem {
  id: number;
  itemType: ContentWorkspaceItemType;
  title: string;
  summary: string | null;
  productionState: ContentProductionState;
  artifactPhase: ContentArtifactPhase;
  priority: number;
  deadlineAt: string | null;
  favorite: boolean;
  platformId: string | null;
  formatId: string | null;
  currentArtifactId: number | null;
  workflowVersion: number;
  workSchedule: ContentWorkScheduleSummary | null;
  nextAction: ContentNextAction;
  tags: ContentTag[];
  artifactCount: number;
  createdAt: string;
  updatedAt: string;
}

export type ContentRevisionContent =
  | { format: 'plain_text' | 'markdown'; text: string }
  | { format: 'structured_json'; document: Record<string, unknown> };

export type ContentRevisionActorType = 'user' | 'agent' | 'system' | 'import';

export interface ContentRevision {
  id: number;
  artifactId: number;
  revisionNumber: number;
  parentRevisionId: number | null;
  restoredFromRevisionId: number | null;
  content: ContentRevisionContent;
  contentHash: string;
  changeSummary: string | null;
  changeReason: string | null;
  actorType: ContentRevisionActorType;
  actorId: string | null;
  provenance: Record<string, unknown>;
  createdAt: string;
}

export interface ContentArtifact {
  id: number;
  itemId: number;
  artifactType: ContentArtifactType;
  title: string | null;
  platformId: string | null;
  formatId: string | null;
  revisionCount: number;
  currentRevisionId: number | null;
  currentRevision: ContentRevision | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ContentItemRelationship {
  id: number;
  fromItemId: number;
  toItemId: number;
  relationshipType: ContentRelationshipType;
  position: number | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ContentArtifactRelationship {
  id: number;
  fromArtifactId: number;
  toArtifactId: number;
  relationshipType: 'variant_of' | 'derived_from' | 'remix_of';
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ContentWorkspaceItemDetail extends ContentWorkspaceItem {
  artifacts: ContentArtifact[];
  relationships: ContentItemRelationship[];
  artifactRelationships: ContentArtifactRelationship[];
}

export interface ContentWorkspaceItemPage {
  items: ContentWorkspaceItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ContentRevisionPage {
  revisions: ContentRevision[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ContentWorkspaceDeletion {
  itemId: number;
  workflowVersion: number;
  deletedAt: string;
  recoverable: true;
  nextAction: ContentNextAction;
}

export interface ContentWorkspaceTrashEntry {
  item: ContentWorkspaceItem;
  deletedAt: string;
  recoverable: true;
  nextAction: ContentNextAction;
}

export interface ContentWorkspaceTrashPage {
  entries: ContentWorkspaceTrashEntry[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface CreateContentWorkspaceItemInput {
  scope: ContentWorkspaceScope;
  itemType: ContentWorkspaceItemType;
  title: string;
  summary?: string | null;
  platformId?: string | null;
  formatId?: string | null;
  priority?: number;
  deadlineAt?: string | null;
  favorite?: boolean;
  idempotencyKey: string;
}

export interface CreateContentArtifactInput {
  scope: ContentWorkspaceScope;
  itemId: number;
  /** CAS guard for selecting or adding an artifact to this item. */
  expectedWorkflowVersion: number;
  artifactType: ContentArtifactType;
  title?: string | null;
  platformId?: string | null;
  formatId?: string | null;
  metadata?: Record<string, unknown>;
  initialContent?: ContentRevisionContent;
  changeSummary?: string | null;
  actorType?: ContentRevisionActorType;
  actorId?: string | null;
  provenance?: Record<string, unknown>;
  /** Optional immutable predecessor within the same content item. */
  sourceArtifactId?: number;
  /** Keep the existing primary artifact selected when creating a derivative. */
  makeCurrent?: boolean;
  idempotencyKey: string;
}

export interface SaveContentRevisionInput {
  scope: ContentWorkspaceScope;
  artifactId: number;
  baseRevision: number;
  content: ContentRevisionContent;
  changeSummary?: string | null;
  changeReason?: string | null;
  actorType?: ContentRevisionActorType;
  actorId?: string | null;
  provenance?: Record<string, unknown>;
  idempotencyKey: string;
}

export interface RestoreContentRevisionInput {
  scope: ContentWorkspaceScope;
  artifactId: number;
  sourceRevisionId: number;
  baseRevision: number;
  changeSummary?: string | null;
  actorId?: string | null;
  idempotencyKey: string;
}

export interface TransitionContentWorkspaceItemInput {
  scope: ContentWorkspaceScope;
  itemId: number;
  targetState: ContentProductionState;
  expectedWorkflowVersion: number;
  idempotencyKey: string;
  reasonCode?: 'changes_requested';
  auditContext?: {
    source: 'decision_center' | 'decision_center_command_bus';
    action: 'request_rewrite';
    decisionId?: string;
  };
}

export interface UpdateContentWorkspaceItemInput {
  scope: ContentWorkspaceScope;
  itemId: number;
  expectedWorkflowVersion: number;
  title?: string;
  summary?: string | null;
  priority?: number;
  deadlineAt?: string | null;
  favorite?: boolean;
  platformId?: string | null;
  formatId?: string | null;
  idempotencyKey: string;
}

export interface CreateContentTagInput {
  scope: ContentWorkspaceScope;
  name: string;
  idempotencyKey: string;
}

export interface MutateContentItemTagInput {
  scope: ContentWorkspaceScope;
  itemId: number;
  tagId: number;
  expectedWorkflowVersion: number;
  idempotencyKey: string;
}

export interface SoftDeleteContentWorkspaceItemInput {
  scope: ContentWorkspaceScope;
  itemId: number;
  expectedWorkflowVersion: number;
  idempotencyKey: string;
}

export interface RestoreDeletedContentWorkspaceItemInput {
  scope: ContentWorkspaceScope;
  itemId: number;
  expectedWorkflowVersion: number;
  idempotencyKey: string;
}

export interface CreateContentRelationshipInput {
  scope: ContentWorkspaceScope;
  fromItemId: number;
  toItemId: number;
  relationshipType: ContentRelationshipType;
  position?: number | null;
  metadata?: Record<string, unknown>;
  idempotencyKey: string;
}

export interface RemoveContentRelationshipInput {
  scope: ContentWorkspaceScope;
  relationshipId: number;
  expectedFromWorkflowVersion: number;
  idempotencyKey: string;
}

export interface ReorderContentRelationshipInput {
  scope: ContentWorkspaceScope;
  relationshipId: number;
  expectedFromWorkflowVersion: number;
  position: number;
  idempotencyKey: string;
}

export interface ContentRelationshipRemoval {
  relationshipId: number;
  fromItemId: number;
  toItemId: number;
  relationshipType: ContentRelationshipType;
  removedAt: string;
}

export interface DuplicateContentWorkspaceItemInput {
  scope: ContentWorkspaceScope;
  sourceItemId: number;
  expectedWorkflowVersion: number;
  mode: ContentWorkspaceCopyMode;
  title?: string;
  idempotencyKey: string;
}

export interface ContentArtifactCopyMapping {
  sourceArtifactId: number;
  sourceRevisionId: number | null;
  copiedArtifactId: number;
  copiedRevisionId: number | null;
  contentHash: string | null;
}

export interface ContentWorkspaceCopy {
  mode: ContentWorkspaceCopyMode;
  sourceItemId: number;
  sourceWorkflowVersion: number;
  item: ContentWorkspaceItemDetail;
  relationship: ContentItemRelationship;
  artifactMappings: ContentArtifactCopyMapping[];
  copiedAt: string;
}

export interface ContentMutationResult<T> {
  value: T;
  replayed: boolean;
  created: boolean;
}

export interface ContentChangeResult<T> {
  value: T;
  replayed: boolean;
  changed: boolean;
}

/**
 * A delete receipt is immutable, while the item can subsequently be restored
 * by another client. These additive fields describe the authoritative current
 * state so a retry never mistakes a historical successful delete for a live
 * tombstone.
 */
export interface ContentWorkspaceDeletionResult extends ContentChangeResult<ContentWorkspaceDeletion> {
  deletionCurrent: boolean;
  item: ContentWorkspaceItem | null;
}

export interface ListContentWorkspaceItemsInput {
  scope: ContentWorkspaceScope;
  itemType?: ContentWorkspaceItemType;
  productionState?: ContentProductionState;
  artifactPhase?: ContentArtifactPhase;
  priority?: number;
  favorite?: boolean;
  platformId?: string;
  formatId?: string;
  tag?: string;
  projectId?: number;
  search?: string;
  includeArchived?: boolean;
  sort?: ContentWorkspaceSort;
  cursor?: string;
  limit?: number;
}

export interface ListContentWorkspaceTrashInput {
  scope: ContentWorkspaceScope;
  cursor?: string;
  limit?: number;
}

export class ContentWorkspaceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ContentWorkspaceError';
  }
}

const ITEM_SCOPE_SQL = `
  tenant_id = ?
  AND owner_user_id = ?
  AND visibility_scope = 'user_private'
  AND scope_status = 'active'
  AND deleted_at IS NULL
  AND object_type IN ('content_item', 'project')
`;

const DELETED_ITEM_SCOPE_SQL = `
  tenant_id = ?
  AND owner_user_id = ?
  AND visibility_scope = 'user_private'
  AND scope_status = 'deleted'
  AND deleted_at IS NOT NULL
  AND object_type IN ('content_item', 'project')
`;

const ARTIFACT_SCOPE_SQL = `
  tenant_id = ?
  AND owner_user_id = ?
  AND visibility_scope = 'user_private'
  AND scope_status = 'active'
`;

const ALLOWED_STATE_TRANSITIONS: Record<ContentProductionState, readonly ContentProductionState[]> = {
  inbox: ['active', 'archived', 'rejected'],
  active: ['review', 'archived', 'rejected'],
  review: ['active', 'approved', 'archived', 'rejected'],
  approved: ['active', 'scheduled', 'archived'],
  scheduled: ['active', 'approved', 'published', 'archived'],
  published: ['archived'],
  archived: ['inbox', 'active'],
  rejected: ['inbox', 'archived'],
};

const LIBRARY_SORT_SQL: Record<ContentWorkspaceSort, string> = {
  updated_desc: 'o.updated_at DESC, o.id DESC',
  created_desc: 'o.created_at DESC, o.id DESC',
  title_asc: 'o.title COLLATE NOCASE ASC, o.id ASC',
  deadline_asc: 'CASE WHEN o.deadline_at IS NULL THEN 1 ELSE 0 END ASC, o.deadline_at ASC, o.id ASC',
  priority_asc: 'o.workspace_priority ASC, o.updated_at DESC, o.id DESC',
  priority_desc: 'o.workspace_priority DESC, o.updated_at DESC, o.id DESC',
};

export function createContentWorkspaceItem(
  input: CreateContentWorkspaceItemInput,
  db: Database.Database = getDb(),
): ContentMutationResult<ContentWorkspaceItem> {
  const observation = startContentWorkspaceObservation('item_create');
  try {
  const scope = normalizeScope(input.scope);
  assertContentWorkspaceWriteEnabled(scope, 'core');
  const itemType = requireEnum(input.itemType, CONTENT_WORKSPACE_ITEM_TYPES, 'itemType');
  const title = requireText(input.title, 'title', 240);
  const summary = optionalText(input.summary, 'summary', 20_000);
  const platformId = optionalText(input.platformId, 'platformId', 120);
  const formatId = optionalText(input.formatId, 'formatId', 120);
  const priority = normalizePriority(input.priority);
  const deadlineAt = normalizeOptionalDate(input.deadlineAt, 'deadlineAt');
  const favorite = input.favorite === true;
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const productionState: ContentProductionState = itemType === 'project' ? 'active' : 'inbox';
  const operation = 'create_item';
  const requestHash = hashPayload({
    itemType,
    title,
    summary,
    platformId,
    formatId,
    priority,
    deadlineAt,
    favorite,
  });

  const mutation = db.transaction(() => {
    const receipt = getReceipt(db, scope, operation, idempotencyKey, requestHash);
    if (receipt) {
      const item = getContentWorkspaceItem(scope, Number(receipt.resourceId), db);
      if (!item) throw inconsistentReceiptError();
      return { value: item, replayed: true, created: false };
    }

    const now = new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO content_domain_objects (
        tenant_id, owner_user_id, visibility_scope, scope_status,
        object_type, lifecycle_state, production_state, artifact_phase,
        title, summary, platform_id, format_id, workspace_priority,
        deadline_at, is_favorite, next_action_json,
        ontology_metadata_json, ontology_schema_version,
        workspace_schema_version, created_by, updated_by,
        audit_metadata_json, created_at, updated_at
      ) VALUES (
        ?, ?, 'user_private', 'active',
        ?, ?, ?, 'idea',
        ?, ?, ?, ?, ?,
        ?, ?, '{}',
        '{}', 'content-ontology-v1',
        ?, ?, ?,
        '{}', ?, ?
      )
    `).run(
      scope.tenantId,
      scope.userId,
      itemType,
      productionState,
      productionState,
      title,
      summary,
      platformId,
      formatId,
      priority,
      deadlineAt,
      favorite ? 1 : 0,
      CONTENT_WORKSPACE_SCHEMA_VERSION,
      scope.userId,
      scope.userId,
      now,
      now,
    );
    const itemId = Number(result.lastInsertRowid);
    writeWorkspaceEvent(db, scope, itemType, itemId, 'workspace_item_created', null, productionState, {
      workspaceSchemaVersion: CONTENT_WORKSPACE_SCHEMA_VERSION,
    });
    putReceipt(db, scope, operation, idempotencyKey, requestHash, itemType, itemId, {});
    const item = getContentWorkspaceItem(scope, itemId, db);
    if (!item) throw new ContentWorkspaceError('CONTENT_WORKSPACE_WRITE_FAILED', 'Content item was not readable after creation.', 500);
    return { value: item, replayed: false, created: true };
  }).immediate();
  if (mutation.replayed) {
    observation.complete('replayed');
  } else {
    observation.complete('success');
    recordContentWorkspaceProductSignal(itemType === 'project' ? 'project_created' : 'idea_captured');
  }
  return mutation;
  } catch (error) {
    observation.completeFromError(error);
    throw error;
  }
}

export function getContentWorkspaceItem(
  scopeInput: ContentWorkspaceScope,
  itemId: number,
  db: Database.Database = getDb(),
): ContentWorkspaceItem | null {
  const scope = normalizeScope(scopeInput);
  const id = normalizePositiveInteger(itemId, 'itemId');
  const row = db.prepare(`
    SELECT o.*,
           (SELECT COUNT(*)
              FROM content_artifacts a
             WHERE a.item_id = o.id
               AND a.tenant_id = o.tenant_id
               AND a.owner_user_id = o.owner_user_id
               AND a.scope_status = 'active') AS artifact_count
      FROM content_domain_objects o
     WHERE o.id = ? AND ${qualifiedItemScopeSql('o')}
     LIMIT 1
  `).get(id, scope.tenantId, scope.userId) as WorkspaceItemRow | undefined;
  if (!row) return null;
  return mapItem(
    row,
    loadTagsForItems(scope, [id], db).get(id) ?? [],
    loadContentWorkScheduleSummaries(scope, [id], db).get(id) ?? null,
  );
}

export function getContentWorkspaceItemDetail(
  scopeInput: ContentWorkspaceScope,
  itemId: number,
  db: Database.Database = getDb(),
): ContentWorkspaceItemDetail | null {
  const scope = normalizeScope(scopeInput);
  const item = getContentWorkspaceItem(scope, itemId, db);
  if (!item) return null;
  const artifacts = listContentArtifacts(scope, item.id, db);
  const relationships = (db.prepare(`
    SELECT rel.*
      FROM content_item_relationships rel
      JOIN content_domain_objects from_item
        ON from_item.id = rel.from_item_id
       AND from_item.tenant_id = rel.tenant_id
       AND from_item.owner_user_id = rel.owner_user_id
      JOIN content_domain_objects to_item
        ON to_item.id = rel.to_item_id
       AND to_item.tenant_id = rel.tenant_id
       AND to_item.owner_user_id = rel.owner_user_id
     WHERE rel.tenant_id = ? AND rel.owner_user_id = ?
       AND (rel.from_item_id = ? OR rel.to_item_id = ?)
       AND from_item.visibility_scope = 'user_private'
       AND from_item.scope_status = 'active'
       AND from_item.deleted_at IS NULL
       AND from_item.object_type IN ('content_item', 'project')
       AND to_item.visibility_scope = 'user_private'
       AND to_item.scope_status = 'active'
       AND to_item.deleted_at IS NULL
       AND to_item.object_type IN ('content_item', 'project')
     ORDER BY rel.relationship_type ASC, COALESCE(rel.position, 2147483647) ASC, rel.id ASC
  `).all(scope.tenantId, scope.userId, item.id, item.id) as RelationshipRow[]).map(mapRelationship);
  const artifactIds = artifacts.map((artifact) => artifact.id);
  const artifactRelationships = artifactIds.length === 0
    ? []
    : (db.prepare(`
      SELECT rel.*
        FROM content_artifact_relationships rel
       WHERE rel.tenant_id = ? AND rel.owner_user_id = ?
         AND (rel.from_artifact_id IN (${artifactIds.map(() => '?').join(', ')})
           OR rel.to_artifact_id IN (${artifactIds.map(() => '?').join(', ')}))
       ORDER BY rel.id ASC
    `).all(scope.tenantId, scope.userId, ...artifactIds, ...artifactIds) as ArtifactRelationshipRow[])
      .map(mapArtifactRelationship);
  return { ...item, artifacts, relationships, artifactRelationships };
}

export function listContentWorkspaceItems(
  input: ListContentWorkspaceItemsInput,
  db: Database.Database = getDb(),
): ContentWorkspaceItem[] {
  return queryContentWorkspaceItems(input, db).items;
}

export function queryContentWorkspaceItems(
  input: ListContentWorkspaceItemsInput,
  db: Database.Database = getDb(),
): ContentWorkspaceItemPage {
  const scope = normalizeScope(input.scope);
  const filters = [qualifiedItemScopeSql('o')];
  const params: unknown[] = [scope.tenantId, scope.userId];
  const itemType = input.itemType === undefined
    ? undefined
    : requireEnum(input.itemType, CONTENT_WORKSPACE_ITEM_TYPES, 'itemType');
  const productionState = input.productionState === undefined
    ? undefined
    : requireEnum(input.productionState, CONTENT_PRODUCTION_STATES, 'productionState');
  const artifactPhase = input.artifactPhase === undefined
    ? undefined
    : requireEnum(input.artifactPhase, CONTENT_ARTIFACT_PHASES, 'artifactPhase');
  const priority = input.priority === undefined ? undefined : normalizePriority(input.priority);
  const favorite = normalizeOptionalBoolean(input.favorite, 'favorite');
  const platformId = optionalText(input.platformId, 'platformId', 120);
  const formatId = optionalText(input.formatId, 'formatId', 120);
  const tag = input.tag === undefined ? undefined : normalizeTagName(input.tag);
  const projectId = input.projectId === undefined
    ? undefined
    : normalizePositiveInteger(input.projectId, 'projectId');
  const search = optionalText(input.search, 'search', 200);
  const includeArchived = normalizeOptionalBoolean(input.includeArchived, 'includeArchived') ?? false;
  const sort = input.sort === undefined
    ? 'updated_desc'
    : requireEnum(input.sort, CONTENT_WORKSPACE_SORTS, 'sort');

  if (input.itemType !== undefined) {
    filters.push('o.object_type = ?');
    params.push(itemType);
  }
  if (productionState !== undefined) {
    filters.push('o.production_state = ?');
    params.push(productionState);
  } else if (!includeArchived) {
    filters.push("o.production_state <> 'archived'");
  }
  if (artifactPhase !== undefined) {
    filters.push('o.artifact_phase = ?');
    params.push(artifactPhase);
  }
  if (priority !== undefined) {
    filters.push('o.workspace_priority = ?');
    params.push(priority);
  }
  if (favorite !== undefined) {
    filters.push('o.is_favorite = ?');
    params.push(favorite ? 1 : 0);
  }
  if (platformId != null) {
    filters.push('o.platform_id = ?');
    params.push(platformId);
  }
  if (formatId != null) {
    filters.push('o.format_id = ?');
    params.push(formatId);
  }
  if (tag !== undefined) {
    filters.push(`EXISTS (
      SELECT 1
        FROM content_item_tags it
        JOIN content_tags t
          ON t.id = it.tag_id
         AND t.tenant_id = it.tenant_id
         AND t.owner_user_id = it.owner_user_id
       WHERE it.tenant_id = o.tenant_id
         AND it.owner_user_id = o.owner_user_id
         AND it.item_id = o.id
         AND t.visibility_scope = 'user_private'
         AND t.scope_status = 'active'
         AND t.normalized_name = ?
    )`);
    params.push(tag.normalized);
  }
  if (projectId !== undefined) {
    filters.push(`EXISTS (
      SELECT 1
        FROM content_item_relationships rel
        JOIN content_domain_objects project
          ON project.id = rel.from_item_id
         AND project.tenant_id = rel.tenant_id
         AND project.owner_user_id = rel.owner_user_id
       WHERE rel.tenant_id = o.tenant_id
         AND rel.owner_user_id = o.owner_user_id
         AND rel.from_item_id = ?
         AND rel.to_item_id = o.id
         AND rel.relationship_type = 'contains'
         AND project.visibility_scope = 'user_private'
         AND project.scope_status = 'active'
         AND project.deleted_at IS NULL
         AND project.object_type = 'project'
    )`);
    params.push(projectId);
  }
  if (search != null) {
    const pattern = `%${escapeLikePattern(search)}%`;
    filters.push(`(
      LOWER(o.title) LIKE LOWER(?) ESCAPE '\\'
      OR LOWER(COALESCE(o.summary, '')) LIKE LOWER(?) ESCAPE '\\'
      OR EXISTS (
        SELECT 1
          FROM content_artifacts search_artifact
          JOIN content_revisions search_revision
            ON search_revision.id = search_artifact.current_revision_id
           AND search_revision.artifact_id = search_artifact.id
           AND search_revision.tenant_id = search_artifact.tenant_id
           AND search_revision.owner_user_id = search_artifact.owner_user_id
         WHERE search_artifact.tenant_id = o.tenant_id
           AND search_artifact.owner_user_id = o.owner_user_id
           AND search_artifact.item_id = o.id
           AND search_artifact.visibility_scope = 'user_private'
           AND search_artifact.scope_status = 'active'
           AND (
             LOWER(COALESCE(search_revision.content_text, '')) LIKE LOWER(?) ESCAPE '\\'
             OR LOWER(COALESCE(search_revision.structured_content_json, '')) LIKE LOWER(?) ESCAPE '\\'
           )
      )
    )`);
    params.push(pattern, pattern, pattern, pattern);
  }
  const limit = normalizeLimit(input.limit);
  const queryHash = hashPayload({
    itemType,
    productionState,
    artifactPhase,
    priority,
    favorite,
    platformId,
    formatId,
    tag: tag?.normalized,
    projectId,
    search,
    includeArchived,
    sort,
  });
  const cursor = decodeLibraryCursor(input.cursor, queryHash, sort);
  const snapshot = cursor ?? createLibrarySnapshot(scope, queryHash, sort, db);
  filters.push('o.id <= ?', 'o.updated_at <= ?');
  params.push(snapshot.snapshotMaxId, snapshot.snapshotAt);
  if (cursor) {
    const continuation = libraryContinuationPredicate(sort, cursor.key);
    filters.push(continuation.sql);
    params.push(...continuation.params);
  }
  params.push(limit + 1);
  const rows = db.prepare(`
    SELECT o.*,
           (SELECT COUNT(*)
              FROM content_artifacts a
             WHERE a.item_id = o.id
               AND a.tenant_id = o.tenant_id
               AND a.owner_user_id = o.owner_user_id
               AND a.scope_status = 'active') AS artifact_count
     FROM content_domain_objects o
     WHERE ${filters.join(' AND ')}
     ORDER BY ${LIBRARY_SORT_SQL[sort]}
     LIMIT ?
  `).all(...params) as WorkspaceItemRow[];
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const pageItemIds = pageRows.map((row) => Number(row.id));
  const tagsByItem = loadTagsForItems(scope, pageItemIds, db);
  const schedulesByItem = loadContentWorkScheduleSummaries(scope, pageItemIds, db);
  return {
    items: pageRows.map((row) => mapItem(
      row,
      tagsByItem.get(Number(row.id)) ?? [],
      schedulesByItem.get(Number(row.id)) ?? null,
    )),
    nextCursor: hasMore && pageRows.length > 0
      ? encodeLibraryCursor({
          ...snapshot,
          key: libraryCursorKey(sort, pageRows[pageRows.length - 1]),
        })
      : null,
    hasMore,
  };
}

export function listDeletedContentWorkspaceItems(
  input: ListContentWorkspaceTrashInput,
  db: Database.Database = getDb(),
): ContentWorkspaceTrashPage {
  const scope = normalizeScope(input.scope);
  const limit = normalizeLimit(input.limit);
  const queryHash = hashPayload({ trash: true });
  const sort = 'trash_deleted_desc' as const;
  const cursor = decodeLibraryCursor(input.cursor, queryHash, sort);
  const snapshot = cursor ?? createLibrarySnapshot(scope, queryHash, sort, db);
  const continuation = cursor
    ? libraryContinuationPredicate(sort, cursor.key)
    : null;
  const rows = db.prepare(`
    SELECT o.*,
           (SELECT COUNT(*)
              FROM content_artifacts a
             WHERE a.item_id = o.id
               AND a.tenant_id = o.tenant_id
               AND a.owner_user_id = o.owner_user_id
               AND a.scope_status = 'active') AS artifact_count
      FROM content_domain_objects o
     WHERE ${qualifiedDeletedItemScopeSql('o')}
       AND o.id <= ?
       AND o.updated_at <= ?
       ${continuation ? `AND ${continuation.sql}` : ''}
     ORDER BY o.deleted_at DESC, o.id DESC
     LIMIT ?
  `).all(
    scope.tenantId,
    scope.userId,
    snapshot.snapshotMaxId,
    snapshot.snapshotAt,
    ...(continuation?.params ?? []),
    limit + 1,
  ) as WorkspaceItemRow[];
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const tagsByItem = loadTagsForItems(scope, pageRows.map((row) => Number(row.id)), db);
  const entries = pageRows.map((row): ContentWorkspaceTrashEntry => {
    if (!row.deleted_at || Number.isNaN(new Date(row.deleted_at).getTime())) {
      throw new ContentWorkspaceError('CONTENT_WORKSPACE_INTEGRITY_FAILED', 'A deleted item is missing its recovery timestamp.', 500, {
        itemId: Number(row.id),
      });
    }
    return {
      item: mapItem(row, tagsByItem.get(Number(row.id)) ?? []),
      deletedAt: row.deleted_at,
      recoverable: true,
      nextAction: deletedItemNextAction(),
    };
  });
  return {
    entries,
    nextCursor: hasMore && pageRows.length > 0
      ? encodeLibraryCursor({
          ...snapshot,
          key: libraryCursorKey(sort, pageRows[pageRows.length - 1]),
        })
      : null,
    hasMore,
  };
}

export function updateContentWorkspaceItem(
  input: UpdateContentWorkspaceItemInput,
  db: Database.Database = getDb(),
): ContentChangeResult<ContentWorkspaceItem> {
  const scope = normalizeScope(input.scope);
  assertContentWorkspaceWriteEnabled(scope, 'core');
  const itemId = normalizePositiveInteger(input.itemId, 'itemId');
  const expectedWorkflowVersion = normalizePositiveInteger(input.expectedWorkflowVersion, 'expectedWorkflowVersion');
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const patch: Partial<Pick<ContentWorkspaceItem,
    'title' | 'summary' | 'priority' | 'deadlineAt' | 'favorite' | 'platformId' | 'formatId'>> = {};
  if (input.title !== undefined) patch.title = requireText(input.title, 'title', 240);
  if (input.summary !== undefined) patch.summary = optionalText(input.summary, 'summary', 20_000);
  if (input.priority !== undefined) patch.priority = normalizePriority(input.priority);
  if (input.deadlineAt !== undefined) patch.deadlineAt = normalizeOptionalDate(input.deadlineAt, 'deadlineAt');
  if (input.favorite !== undefined) patch.favorite = requireBoolean(input.favorite, 'favorite');
  if (input.platformId !== undefined) patch.platformId = optionalText(input.platformId, 'platformId', 120);
  if (input.formatId !== undefined) patch.formatId = optionalText(input.formatId, 'formatId', 120);
  const changedFieldCandidates = Object.keys(patch);
  if (changedFieldCandidates.length === 0) {
    throw new ContentWorkspaceError('CONTENT_VALIDATION_FAILED', 'At least one editable field is required.', 400, {
      field: 'metadata',
    });
  }
  const operation = `update_item:${itemId}`;
  const requestHash = hashPayload({ itemId, expectedWorkflowVersion, patch });

  return db.transaction(() => {
    const receipt = getReceipt(db, scope, operation, idempotencyKey, requestHash);
    if (receipt) {
      const item = getContentWorkspaceItem(scope, Number(receipt.resourceId), db);
      if (!item) throw inconsistentReceiptError();
      return { value: item, replayed: true, changed: receipt.metadata.changed === true };
    }
    const item = requireWorkspaceItem(scope, itemId, db);
    if (item.workflowVersion !== expectedWorkflowVersion) {
      throw workflowConflict(item, expectedWorkflowVersion);
    }
    const changedFields = changedFieldCandidates.filter((field) => {
      const key = field as keyof typeof patch;
      return patch[key] !== item[key as keyof ContentWorkspaceItem];
    });
    if (changedFields.length === 0) {
      putReceipt(db, scope, operation, idempotencyKey, requestHash, item.itemType, item.id, { changed: false });
      return { value: item, replayed: false, changed: false };
    }

    const now = new Date().toISOString();
    const update = db.prepare(`
      UPDATE content_domain_objects
         SET title = ?,
             summary = ?,
             workspace_priority = ?,
             deadline_at = ?,
             is_favorite = ?,
             platform_id = ?,
             format_id = ?,
             updated_by = ?,
             updated_at = ?,
             workflow_version = workflow_version + 1
       WHERE id = ? AND ${ITEM_SCOPE_SQL}
         AND workflow_version = ?
    `).run(
      patch.title ?? item.title,
      Object.prototype.hasOwnProperty.call(patch, 'summary') ? patch.summary : item.summary,
      patch.priority ?? item.priority,
      Object.prototype.hasOwnProperty.call(patch, 'deadlineAt') ? patch.deadlineAt : item.deadlineAt,
      (patch.favorite ?? item.favorite) ? 1 : 0,
      Object.prototype.hasOwnProperty.call(patch, 'platformId') ? patch.platformId : item.platformId,
      Object.prototype.hasOwnProperty.call(patch, 'formatId') ? patch.formatId : item.formatId,
      scope.userId,
      now,
      item.id,
      scope.tenantId,
      scope.userId,
      expectedWorkflowVersion,
    );
    if (update.changes !== 1) {
      throw workflowConflict(requireWorkspaceItem(scope, item.id, db), expectedWorkflowVersion);
    }
    writeWorkspaceEvent(db, scope, item.itemType, item.id, 'workspace_item_metadata_updated', item.productionState, item.productionState, {
      changedFields,
      expectedWorkflowVersion,
    });
    putReceipt(db, scope, operation, idempotencyKey, requestHash, item.itemType, item.id, { changed: true, changedFields });
    return { value: requireWorkspaceItem(scope, item.id, db), replayed: false, changed: true };
  }).immediate();
}

export function createContentTag(
  input: CreateContentTagInput,
  db: Database.Database = getDb(),
): ContentMutationResult<ContentTag> {
  const scope = normalizeScope(input.scope);
  assertContentWorkspaceWriteEnabled(scope, 'core');
  const name = normalizeTagName(input.name);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const operation = 'create_tag';
  const requestHash = hashPayload({ normalizedName: name.normalized });

  return db.transaction(() => {
    const receipt = getReceipt(db, scope, operation, idempotencyKey, requestHash);
    if (receipt) {
      const tag = getContentTag(scope, Number(receipt.resourceId), db);
      if (!tag) throw inconsistentReceiptError();
      return { value: tag, replayed: true, created: false };
    }
    const existing = getContentTagByNormalizedName(scope, name.normalized, db);
    if (existing) {
      putReceipt(db, scope, operation, idempotencyKey, requestHash, 'tag', existing.id, { created: false });
      return { value: existing, replayed: false, created: false };
    }
    const now = new Date().toISOString();
    const insert = db.prepare(`
      INSERT INTO content_tags (
        tenant_id, owner_user_id, visibility_scope, scope_status,
        display_name, normalized_name, created_by, updated_by,
        created_at, updated_at
      ) VALUES (?, ?, 'user_private', 'active', ?, ?, ?, ?, ?, ?)
    `).run(
      scope.tenantId,
      scope.userId,
      name.display,
      name.normalized,
      scope.userId,
      scope.userId,
      now,
      now,
    );
    const tagId = Number(insert.lastInsertRowid);
    putReceipt(db, scope, operation, idempotencyKey, requestHash, 'tag', tagId, { created: true });
    const tag = getContentTag(scope, tagId, db);
    if (!tag) throw new ContentWorkspaceError('CONTENT_WORKSPACE_WRITE_FAILED', 'Tag was not readable after creation.', 500);
    return { value: tag, replayed: false, created: true };
  }).immediate();
}

export function listContentTags(
  scopeInput: ContentWorkspaceScope,
  db: Database.Database = getDb(),
): ContentTag[] {
  const scope = normalizeScope(scopeInput);
  return (db.prepare(`
    SELECT *
      FROM content_tags
     WHERE tenant_id = ? AND owner_user_id = ?
       AND visibility_scope = 'user_private' AND scope_status = 'active'
     ORDER BY normalized_name ASC, id ASC
     LIMIT 200
  `).all(scope.tenantId, scope.userId) as ContentTagRow[]).map(mapTag);
}

export function attachContentTag(
  input: MutateContentItemTagInput,
  db: Database.Database = getDb(),
): ContentChangeResult<ContentWorkspaceItem> {
  assertContentWorkspaceWriteEnabled(normalizeScope(input.scope), 'core');
  return mutateContentItemTag(input, true, db);
}

export function detachContentTag(
  input: MutateContentItemTagInput,
  db: Database.Database = getDb(),
): ContentChangeResult<ContentWorkspaceItem> {
  assertContentWorkspaceWriteEnabled(normalizeScope(input.scope), 'core');
  return mutateContentItemTag(input, false, db);
}

export function softDeleteContentWorkspaceItem(
  input: SoftDeleteContentWorkspaceItemInput,
  db: Database.Database = getDb(),
): ContentWorkspaceDeletionResult {
  const scope = normalizeScope(input.scope);
  assertContentWorkspaceWriteEnabled(scope, 'core');
  const itemId = normalizePositiveInteger(input.itemId, 'itemId');
  const expectedWorkflowVersion = normalizePositiveInteger(input.expectedWorkflowVersion, 'expectedWorkflowVersion');
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const operation = `soft_delete_item:${itemId}`;
  const requestHash = hashPayload({ itemId, expectedWorkflowVersion });

  return db.transaction(() => {
    const receipt = getReceipt(db, scope, operation, idempotencyKey, requestHash);
    if (receipt) {
      const deletion = deletionFromReceipt(receipt, itemId);
      const item = getContentWorkspaceItem(scope, itemId, db);
      if (item) {
        return {
          value: deletion,
          replayed: true,
          changed: true,
          deletionCurrent: false,
          item,
        };
      }
      if (!getDeletedContentWorkspaceItem(scope, itemId, db)) throw inconsistentReceiptError();
      return {
        value: deletion,
        replayed: true,
        changed: true,
        deletionCurrent: true,
        item: null,
      };
    }
    const item = requireWorkspaceItem(scope, itemId, db);
    if (item.workflowVersion !== expectedWorkflowVersion) {
      throw workflowConflict(item, expectedWorkflowVersion);
    }
    assertNoOpenContentWorkSchedule(scope, item.id, 'trash', db);
    const now = new Date().toISOString();
    const update = db.prepare(`
      UPDATE content_domain_objects
         SET scope_status = 'deleted',
             deleted_at = ?,
             updated_by = ?,
             updated_at = ?,
             workflow_version = workflow_version + 1
       WHERE id = ? AND ${ITEM_SCOPE_SQL}
         AND workflow_version = ?
    `).run(now, scope.userId, now, item.id, scope.tenantId, scope.userId, expectedWorkflowVersion);
    if (update.changes !== 1) {
      const current = getContentWorkspaceItem(scope, item.id, db);
      if (current) throw workflowConflict(current, expectedWorkflowVersion);
      throw new ContentWorkspaceError('CONTENT_ITEM_NOT_FOUND', 'Content item not found.', 404);
    }
    const deletion: ContentWorkspaceDeletion = {
      itemId: item.id,
      workflowVersion: expectedWorkflowVersion + 1,
      deletedAt: now,
      recoverable: true,
      nextAction: deletedItemNextAction(),
    };
    writeWorkspaceEvent(db, scope, item.itemType, item.id, 'workspace_item_soft_deleted', item.productionState, item.productionState, {
      expectedWorkflowVersion,
      recoverable: true,
    });
    putReceipt(db, scope, operation, idempotencyKey, requestHash, item.itemType, item.id, { ...deletion });
    return {
      value: deletion,
      replayed: false,
      changed: true,
      deletionCurrent: true,
      item: null,
    };
  }).immediate();
}

export function restoreDeletedContentWorkspaceItem(
  input: RestoreDeletedContentWorkspaceItemInput,
  db: Database.Database = getDb(),
): ContentChangeResult<ContentWorkspaceItem> {
  const scope = normalizeScope(input.scope);
  assertContentWorkspaceWriteEnabled(scope, 'restore_deleted_items');
  const itemId = normalizePositiveInteger(input.itemId, 'itemId');
  const expectedWorkflowVersion = normalizePositiveInteger(input.expectedWorkflowVersion, 'expectedWorkflowVersion');
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const operation = `restore_deleted_item:${itemId}`;
  const requestHash = hashPayload({ itemId, expectedWorkflowVersion });

  return db.transaction(() => {
    const receipt = getReceipt(db, scope, operation, idempotencyKey, requestHash);
    if (receipt) {
      const item = getContentWorkspaceItem(scope, Number(receipt.resourceId), db);
      if (!item) throw inconsistentReceiptError();
      return { value: item, replayed: true, changed: true };
    }
    const item = getDeletedContentWorkspaceItem(scope, itemId, db);
    if (!item) {
      throw new ContentWorkspaceError('CONTENT_DELETED_ITEM_NOT_FOUND', 'Recoverable content item not found.', 404);
    }
    if (item.workflowVersion !== expectedWorkflowVersion) {
      throw workflowConflict(item, expectedWorkflowVersion);
    }
    const now = new Date().toISOString();
    const update = db.prepare(`
      UPDATE content_domain_objects
         SET scope_status = 'active',
             deleted_at = NULL,
             updated_by = ?,
             updated_at = ?,
             workflow_version = workflow_version + 1
       WHERE id = ? AND ${DELETED_ITEM_SCOPE_SQL}
         AND workflow_version = ?
    `).run(scope.userId, now, item.id, scope.tenantId, scope.userId, expectedWorkflowVersion);
    if (update.changes !== 1) {
      const current = getDeletedContentWorkspaceItem(scope, item.id, db);
      if (current) throw workflowConflict(current, expectedWorkflowVersion);
      throw new ContentWorkspaceError('CONTENT_DELETED_ITEM_NOT_FOUND', 'Recoverable content item not found.', 404);
    }
    writeWorkspaceEvent(db, scope, item.itemType, item.id, 'workspace_item_restored', item.productionState, item.productionState, {
      expectedWorkflowVersion,
    });
    putReceipt(db, scope, operation, idempotencyKey, requestHash, item.itemType, item.id, { changed: true });
    return { value: requireWorkspaceItem(scope, item.id, db), replayed: false, changed: true };
  }).immediate();
}

export function createContentArtifact(
  input: CreateContentArtifactInput,
  db: Database.Database = getDb(),
): ContentMutationResult<ContentArtifact> {
  const scope = normalizeScope(input.scope);
  assertContentWorkspaceWriteEnabled(scope, 'core');
  if (input.initialContent !== undefined) {
    assertContentWorkspaceWriteEnabled(scope, 'revisions');
  }
  const itemId = normalizePositiveInteger(input.itemId, 'itemId');
  const expectedWorkflowVersion = normalizePositiveInteger(input.expectedWorkflowVersion, 'expectedWorkflowVersion');
  const artifactType = requireEnum(input.artifactType, CONTENT_ARTIFACT_TYPES, 'artifactType');
  const title = optionalText(input.title, 'title', 240);
  const platformId = optionalText(input.platformId, 'platformId', 120);
  const formatId = optionalText(input.formatId, 'formatId', 120);
  const metadata = normalizeRecord(input.metadata, 'metadata');
  const initialContent = input.initialContent === undefined ? undefined : normalizeRevisionContent(input.initialContent);
  const changeSummary = optionalText(input.changeSummary, 'changeSummary', 2_000);
  const actorType = input.actorType ?? 'user';
  requireEnum(actorType, ['user', 'agent', 'system', 'import'] as const, 'actorType');
  const actorId = optionalText(input.actorId, 'actorId', 200);
  const provenance = normalizeRecord(input.provenance, 'provenance');
  const sourceArtifactId = input.sourceArtifactId === undefined
    ? null
    : normalizePositiveInteger(input.sourceArtifactId, 'sourceArtifactId');
  const makeCurrent = input.makeCurrent ?? true;
  if (typeof makeCurrent !== 'boolean') {
    throw new ContentWorkspaceError('CONTENT_VALIDATION_FAILED', 'makeCurrent must be a boolean.', 400, { field: 'makeCurrent' });
  }
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const operation = `create_artifact:${itemId}`;
  const requestHash = hashPayload({
    itemId,
    expectedWorkflowVersion,
    artifactType,
    title,
    platformId,
    formatId,
    metadata,
    initialContent,
    changeSummary,
    actorType,
    actorId,
    provenance,
    sourceArtifactId,
    makeCurrent,
  });

  return db.transaction(() => {
    const receipt = getReceipt(db, scope, operation, idempotencyKey, requestHash);
    if (receipt) {
      const artifact = getContentArtifact(scope, Number(receipt.resourceId), db);
      if (!artifact) throw inconsistentReceiptError();
      return { value: artifact, replayed: true, created: false };
    }
    const item = requireWorkspaceItem(scope, itemId, db);
    if (item.workflowVersion !== expectedWorkflowVersion) {
      throw workflowConflict(item, expectedWorkflowVersion);
    }
    if (item.itemType !== 'content_item') {
      throw new ContentWorkspaceError(
        'CONTENT_ARTIFACT_PARENT_INVALID',
        'Artifacts must belong to a content item. Projects organize content items through relationships.',
        400,
      );
    }
    const sourceArtifact = sourceArtifactId == null
      ? null
      : getContentArtifact(scope, sourceArtifactId, db);
    if (sourceArtifactId != null && !sourceArtifact) {
      throw new ContentWorkspaceError(
        'CONTENT_SOURCE_ARTIFACT_NOT_FOUND',
        'The source content version was not found.',
        404,
      );
    }
    if (sourceArtifact && sourceArtifact.itemId !== item.id) {
      throw new ContentWorkspaceError(
        'CONTENT_SOURCE_ARTIFACT_INVALID',
        'A progressive content artifact must derive from the same content item.',
        409,
      );
    }
    const now = new Date().toISOString();
    const insert = db.prepare(`
      INSERT INTO content_artifacts (
        tenant_id, owner_user_id, visibility_scope, scope_status,
        item_id, artifact_type, title, platform_id, format_id,
        metadata_json, schema_version, created_by, updated_by,
        created_at, updated_at
      ) VALUES (?, ?, 'user_private', 'active', ?, ?, ?, ?, ?, ?, 'content-artifact-v1', ?, ?, ?, ?)
    `).run(
      scope.tenantId,
      scope.userId,
      item.id,
      artifactType,
      title,
      platformId,
      formatId,
      stableJson(metadata),
      scope.userId,
      scope.userId,
      now,
      now,
    );
    const artifactId = Number(insert.lastInsertRowid);
    if (initialContent) {
      const revisionId = insertRevision(db, {
        scope,
        artifactId,
        revisionNumber: 1,
        parentRevisionId: null,
        restoredFromRevisionId: null,
        content: initialContent,
        changeSummary,
        changeReason: 'artifact_created',
        actorType,
        actorId,
        provenance,
        now,
      });
      db.prepare(`
        UPDATE content_artifacts
           SET current_revision_id = ?, revision_count = 1, updated_at = ?
         WHERE id = ? AND ${ARTIFACT_SCOPE_SQL}
      `).run(revisionId, now, artifactId, scope.tenantId, scope.userId);
    }
    if (sourceArtifact) {
      db.prepare(`
        INSERT INTO content_artifact_relationships (
          tenant_id, owner_user_id, from_artifact_id, to_artifact_id,
          relationship_type, metadata_json, created_by, created_at
        ) VALUES (?, ?, ?, ?, 'derived_from', ?, ?, ?)
      `).run(
        scope.tenantId,
        scope.userId,
        artifactId,
        sourceArtifact.id,
        stableJson({ source: 'progressive_content_development' }),
        scope.userId,
        now,
      );
    }
    const newPhase = phaseForArtifactType(artifactType);
    const itemMutation = advanceItemAfterContentMutation(db, scope, item, {
      expectedWorkflowVersion,
      now,
      selectedArtifactId: makeCurrent ? artifactId : item.currentArtifactId,
      selectedArtifactPhase: makeCurrent ? newPhase : item.artifactPhase,
      activateFromInbox: makeCurrent && newPhase !== 'idea',
    });
    writeWorkspaceEvent(db, scope, item.itemType, item.id, 'workspace_artifact_created', item.productionState, itemMutation.productionState, {
      artifactId,
      artifactType,
      hasInitialRevision: Boolean(initialContent),
      makeCurrent,
      approvalInvalidated: itemMutation.approvalInvalidated,
      expectedWorkflowVersion,
      ...(sourceArtifact ? { sourceArtifactId: sourceArtifact.id } : {}),
    });
    putReceipt(db, scope, operation, idempotencyKey, requestHash, 'artifact', artifactId, {});
    const artifact = getContentArtifact(scope, artifactId, db);
    if (!artifact) throw new ContentWorkspaceError('CONTENT_WORKSPACE_WRITE_FAILED', 'Artifact was not readable after creation.', 500);
    return { value: artifact, replayed: false, created: true };
  }).immediate();
}

export function getContentArtifact(
  scopeInput: ContentWorkspaceScope,
  artifactId: number,
  db: Database.Database = getDb(),
): ContentArtifact | null {
  const scope = normalizeScope(scopeInput);
  const id = normalizePositiveInteger(artifactId, 'artifactId');
  const row = db.prepare(`
    SELECT a.*,
           r.id AS revision_id,
           r.revision_number,
           r.parent_revision_id,
           r.restored_from_revision_id,
           r.content_format,
           r.content_text,
           r.structured_content_json,
           r.content_hash,
           r.change_summary,
           r.change_reason,
           r.actor_type,
           r.actor_id,
           r.provenance_json,
           r.created_at AS revision_created_at
      FROM content_artifacts a
      JOIN content_domain_objects o
        ON o.id = a.item_id
       AND o.tenant_id = a.tenant_id
       AND o.owner_user_id = a.owner_user_id
      LEFT JOIN content_revisions r
        ON r.id = a.current_revision_id
       AND r.tenant_id = a.tenant_id
       AND r.owner_user_id = a.owner_user_id
       AND r.artifact_id = a.id
     WHERE a.id = ?
       AND ${qualifiedArtifactScopeSql('a')}
       AND ${qualifiedItemScopeSql('o')}
     LIMIT 1
  `).get(id, scope.tenantId, scope.userId, scope.tenantId, scope.userId) as ArtifactRow | undefined;
  return row ? mapArtifact(row) : null;
}

export function listContentArtifacts(
  scopeInput: ContentWorkspaceScope,
  itemId: number,
  db: Database.Database = getDb(),
): ContentArtifact[] {
  const scope = normalizeScope(scopeInput);
  const id = normalizePositiveInteger(itemId, 'itemId');
  if (!getContentWorkspaceItem(scope, id, db)) return [];
  const rows = db.prepare(`
    SELECT a.*,
           r.id AS revision_id,
           r.revision_number,
           r.parent_revision_id,
           r.restored_from_revision_id,
           r.content_format,
           r.content_text,
           r.structured_content_json,
           r.content_hash,
           r.change_summary,
           r.change_reason,
           r.actor_type,
           r.actor_id,
           r.provenance_json,
           r.created_at AS revision_created_at
      FROM content_artifacts a
      LEFT JOIN content_revisions r
        ON r.id = a.current_revision_id
       AND r.tenant_id = a.tenant_id
       AND r.owner_user_id = a.owner_user_id
       AND r.artifact_id = a.id
     WHERE a.item_id = ? AND ${qualifiedArtifactScopeSql('a')}
     ORDER BY a.created_at ASC, a.id ASC
  `).all(id, scope.tenantId, scope.userId) as ArtifactRow[];
  return rows.map(mapArtifact);
}

export function saveContentRevision(
  input: SaveContentRevisionInput,
  db: Database.Database = getDb(),
): ContentMutationResult<ContentRevision> {
  const observation = startContentWorkspaceObservation('revision_save');
  try {
  const scope = normalizeScope(input.scope);
  assertContentWorkspaceWriteEnabled(scope, 'revisions');
  const artifactId = normalizePositiveInteger(input.artifactId, 'artifactId');
  const baseRevision = normalizeNonNegativeInteger(input.baseRevision, 'baseRevision');
  const content = normalizeRevisionContent(input.content);
  const changeSummary = optionalText(input.changeSummary, 'changeSummary', 2_000);
  const changeReason = optionalText(input.changeReason, 'changeReason', 2_000);
  const actorType = input.actorType ?? 'user';
  requireEnum(actorType, ['user', 'agent', 'system', 'import'] as const, 'actorType');
  const actorId = optionalText(input.actorId, 'actorId', 200);
  const provenance = normalizeRecord(input.provenance, 'provenance');
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const operation = `save_revision:${artifactId}`;
  const requestHash = hashPayload({
    artifactId,
    baseRevision,
    content,
    changeSummary,
    changeReason,
    actorType,
    actorId,
    provenance,
  });

  const mutation = db.transaction(() => {
    const receipt = getReceipt(db, scope, operation, idempotencyKey, requestHash);
    if (receipt) {
      const revision = getContentRevision(scope, Number(receipt.resourceId), db);
      if (!revision) throw inconsistentReceiptError();
      return { value: revision, replayed: true, created: false };
    }
    const artifact = requireArtifactRow(scope, artifactId, db);
    assertBaseRevision(artifact, baseRevision);
    const contentHash = hashRevisionContent(content);
    const current = artifact.current_revision_id == null
      ? null
      : getContentRevision(scope, Number(artifact.current_revision_id), db);
    if (current?.contentHash === contentHash) {
      putReceipt(db, scope, operation, idempotencyKey, requestHash, 'revision', current.id, { created: false });
      return { value: current, replayed: false, created: false };
    }
    const now = new Date().toISOString();
    const revisionId = insertRevision(db, {
      scope,
      artifactId,
      revisionNumber: baseRevision + 1,
      parentRevisionId: artifact.current_revision_id == null ? null : Number(artifact.current_revision_id),
      restoredFromRevisionId: null,
      content,
      changeSummary,
      changeReason,
      actorType,
      actorId,
      provenance,
      now,
    });
    advanceArtifactRevisionPointer(db, scope, artifact, revisionId, baseRevision, now);
    const item = requireWorkspaceItem(scope, Number(artifact.item_id), db);
    const itemMutation = advanceItemAfterContentMutation(db, scope, item, {
      expectedWorkflowVersion: item.workflowVersion,
      now,
      selectedArtifactId: item.currentArtifactId,
      selectedArtifactPhase: item.artifactPhase,
      activateFromInbox: item.currentArtifactId === artifactId,
    });
    writeWorkspaceEvent(db, scope, item.itemType, item.id, 'workspace_revision_saved', item.productionState, itemMutation.productionState, {
      artifactId,
      revisionId,
      revisionNumber: baseRevision + 1,
      actorType,
      approvalInvalidated: itemMutation.approvalInvalidated,
      currentArtifactChanged: false,
    });
    putReceipt(db, scope, operation, idempotencyKey, requestHash, 'revision', revisionId, { created: true });
    const revision = getContentRevision(scope, revisionId, db);
    if (!revision) throw new ContentWorkspaceError('CONTENT_WORKSPACE_WRITE_FAILED', 'Revision was not readable after save.', 500);
    return { value: revision, replayed: false, created: true };
  }).immediate();
  if (mutation.replayed) observation.complete('replayed');
  else if (mutation.created) {
    observation.complete('success');
    recordContentWorkspaceProductSignal('revision_saved');
  } else observation.complete('no_change');
  return mutation;
  } catch (error) {
    observation.completeFromError(error);
    throw error;
  }
}

export function restoreContentRevision(
  input: RestoreContentRevisionInput,
  db: Database.Database = getDb(),
): ContentMutationResult<ContentRevision> {
  const observation = startContentWorkspaceObservation('revision_restore');
  try {
  const scope = normalizeScope(input.scope);
  assertContentWorkspaceWriteEnabled(scope, 'revisions');
  const artifactId = normalizePositiveInteger(input.artifactId, 'artifactId');
  const sourceRevisionId = normalizePositiveInteger(input.sourceRevisionId, 'sourceRevisionId');
  const baseRevision = normalizeNonNegativeInteger(input.baseRevision, 'baseRevision');
  const changeSummary = optionalText(input.changeSummary, 'changeSummary', 2_000)
    ?? `Restored revision ${sourceRevisionId}`;
  const actorId = optionalText(input.actorId, 'actorId', 200);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const operation = `restore_revision:${artifactId}`;
  const requestHash = hashPayload({ artifactId, sourceRevisionId, baseRevision, changeSummary, actorId });

  const mutation = db.transaction(() => {
    const receipt = getReceipt(db, scope, operation, idempotencyKey, requestHash);
    if (receipt) {
      const revision = getContentRevision(scope, Number(receipt.resourceId), db);
      if (!revision) throw inconsistentReceiptError();
      return { value: revision, replayed: true, created: false };
    }
    const artifact = requireArtifactRow(scope, artifactId, db);
    assertBaseRevision(artifact, baseRevision);
    const source = getContentRevision(scope, sourceRevisionId, db);
    if (!source || source.artifactId !== artifactId) {
      throw new ContentWorkspaceError('CONTENT_REVISION_NOT_FOUND', 'Revision not found for this artifact.', 404);
    }
    const current = artifact.current_revision_id == null
      ? null
      : getContentRevision(scope, Number(artifact.current_revision_id), db);
    if (current?.contentHash === source.contentHash) {
      putReceipt(db, scope, operation, idempotencyKey, requestHash, 'revision', current.id, { created: false });
      return { value: current, replayed: false, created: false };
    }
    const now = new Date().toISOString();
    const revisionId = insertRevision(db, {
      scope,
      artifactId,
      revisionNumber: baseRevision + 1,
      parentRevisionId: artifact.current_revision_id == null ? null : Number(artifact.current_revision_id),
      restoredFromRevisionId: source.id,
      content: source.content,
      changeSummary,
      changeReason: 'revision_restored',
      actorType: 'user',
      actorId,
      provenance: { restoredFromRevisionId: source.id },
      now,
    });
    advanceArtifactRevisionPointer(db, scope, artifact, revisionId, baseRevision, now);
    const item = requireWorkspaceItem(scope, Number(artifact.item_id), db);
    const itemMutation = advanceItemAfterContentMutation(db, scope, item, {
      expectedWorkflowVersion: item.workflowVersion,
      now,
      selectedArtifactId: item.currentArtifactId,
      selectedArtifactPhase: item.artifactPhase,
      activateFromInbox: item.currentArtifactId === artifactId,
    });
    writeWorkspaceEvent(db, scope, item.itemType, item.id, 'workspace_revision_restored', item.productionState, itemMutation.productionState, {
      artifactId,
      revisionId,
      restoredFromRevisionId: source.id,
      revisionNumber: baseRevision + 1,
      approvalInvalidated: itemMutation.approvalInvalidated,
      currentArtifactChanged: false,
    });
    putReceipt(db, scope, operation, idempotencyKey, requestHash, 'revision', revisionId, { created: true });
    const revision = getContentRevision(scope, revisionId, db);
    if (!revision) throw new ContentWorkspaceError('CONTENT_WORKSPACE_WRITE_FAILED', 'Restored revision was not readable.', 500);
    return { value: revision, replayed: false, created: true };
  }).immediate();
  if (mutation.replayed) observation.complete('replayed');
  else if (mutation.created) {
    observation.complete('success');
    recordContentWorkspaceProductSignal('revision_restored');
  } else observation.complete('no_change');
  return mutation;
  } catch (error) {
    observation.completeFromError(error);
    throw error;
  }
}

export function getContentRevision(
  scopeInput: ContentWorkspaceScope,
  revisionId: number,
  db: Database.Database = getDb(),
): ContentRevision | null {
  const scope = normalizeScope(scopeInput);
  const id = normalizePositiveInteger(revisionId, 'revisionId');
  const row = db.prepare(`
    SELECT r.*
      FROM content_revisions r
      JOIN content_artifacts a
        ON a.id = r.artifact_id
       AND a.tenant_id = r.tenant_id
       AND a.owner_user_id = r.owner_user_id
      JOIN content_domain_objects o
        ON o.id = a.item_id
       AND o.tenant_id = a.tenant_id
       AND o.owner_user_id = a.owner_user_id
     WHERE r.id = ?
       AND r.tenant_id = ? AND r.owner_user_id = ?
       AND ${qualifiedArtifactScopeSql('a')}
       AND ${qualifiedItemScopeSql('o')}
     LIMIT 1
  `).get(id, scope.tenantId, scope.userId, scope.tenantId, scope.userId, scope.tenantId, scope.userId) as RevisionRow | undefined;
  return row ? mapRevision(row) : null;
}

export function listContentRevisions(
  scopeInput: ContentWorkspaceScope,
  artifactId: number,
  db: Database.Database = getDb(),
): ContentRevision[] {
  const scope = normalizeScope(scopeInput);
  const id = normalizePositiveInteger(artifactId, 'artifactId');
  if (!getContentArtifact(scope, id, db)) {
    throw new ContentWorkspaceError('CONTENT_ARTIFACT_NOT_FOUND', 'Content artifact not found.', 404);
  }
  const rows = db.prepare(`
    SELECT *
      FROM content_revisions
     WHERE artifact_id = ? AND tenant_id = ? AND owner_user_id = ?
     ORDER BY revision_number DESC
  `).all(id, scope.tenantId, scope.userId) as RevisionRow[];
  return rows.map(mapRevision);
}

/**
 * Bounded immutable history traversal for clients. Revisions never change,
 * so a revision-number keyset remains stable even when a newer revision is
 * appended while an older page is being viewed.
 */
export function queryContentRevisions(
  scopeInput: ContentWorkspaceScope,
  artifactId: number,
  options: { cursor?: string; limit?: number } = {},
  db: Database.Database = getDb(),
): ContentRevisionPage {
  const scope = normalizeScope(scopeInput);
  const id = normalizePositiveInteger(artifactId, 'artifactId');
  if (!getContentArtifact(scope, id, db)) {
    throw new ContentWorkspaceError('CONTENT_ARTIFACT_NOT_FOUND', 'Content artifact not found.', 404);
  }
  const limit = normalizeLimit(options.limit);
  const cursor = decodeRevisionCursor(options.cursor, id);
  const continuationSql = cursor
    ? 'AND (revision_number < ? OR (revision_number = ? AND id < ?))'
    : '';
  const rows = db.prepare(`
    SELECT *
      FROM content_revisions
     WHERE artifact_id = ? AND tenant_id = ? AND owner_user_id = ?
       ${continuationSql}
     ORDER BY revision_number DESC, id DESC
     LIMIT ?
  `).all(
    id,
    scope.tenantId,
    scope.userId,
    ...(cursor ? [cursor.revisionNumber, cursor.revisionNumber, cursor.id] : []),
    limit + 1,
  ) as RevisionRow[];
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  return {
    revisions: pageRows.map(mapRevision),
    nextCursor: hasMore && last
      ? encodeRevisionCursor(id, Number(last.revision_number), Number(last.id))
      : null,
    hasMore,
  };
}

export function transitionContentWorkspaceItem(
  input: TransitionContentWorkspaceItemInput,
  db: Database.Database = getDb(),
): ContentMutationResult<ContentWorkspaceItem> {
  const observation = startContentWorkspaceObservation('item_transition');
  let transitionChanged = false;
  try {
  const scope = normalizeScope(input.scope);
  assertContentWorkspaceWriteEnabled(scope, 'core');
  const itemId = normalizePositiveInteger(input.itemId, 'itemId');
  const targetState = requireEnum(input.targetState, CONTENT_PRODUCTION_STATES, 'targetState');
  const expectedWorkflowVersion = normalizePositiveInteger(input.expectedWorkflowVersion, 'expectedWorkflowVersion');
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const reasonCode = input.reasonCode === undefined
    ? undefined
    : requireEnum(input.reasonCode, ['changes_requested'] as const, 'reasonCode');
  const auditContext = normalizeTransitionAuditContext(input.auditContext);
  const operation = `transition_item:${itemId}`;
  const requestHash = hashPayload({ itemId, targetState, expectedWorkflowVersion, reasonCode, auditContext });

  const mutation = db.transaction(() => {
    const receipt = getReceipt(db, scope, operation, idempotencyKey, requestHash);
    if (receipt) {
      const item = getContentWorkspaceItem(scope, Number(receipt.resourceId), db);
      if (!item) throw inconsistentReceiptError();
      return { value: item, replayed: true, created: false };
    }
    const item = requireWorkspaceItem(scope, itemId, db);
    if (item.workflowVersion !== expectedWorkflowVersion) {
      throw workflowConflict(item, expectedWorkflowVersion);
    }
    if (item.productionState === targetState) {
      putReceipt(db, scope, operation, idempotencyKey, requestHash, item.itemType, item.id, { changed: false });
      return { value: item, replayed: false, created: false };
    }
    if (item.productionState === 'scheduled') {
      assertNoOpenContentWorkSchedule(scope, item.id, 'leave_scheduled_state', db);
    }
    if (targetState === 'archived' || targetState === 'rejected') {
      assertNoOpenContentWorkSchedule(scope, item.id, 'archive', db);
    }
    if (!ALLOWED_STATE_TRANSITIONS[item.productionState].includes(targetState)) {
      throw new ContentWorkspaceError('CONTENT_STATE_TRANSITION_INVALID', 'This content state transition is not allowed.', 409, {
        fromState: item.productionState,
        targetState,
      });
    }
    validateItemStateTarget(scope, item, targetState, db);
    const now = new Date().toISOString();
    const artifactPhase: ContentArtifactPhase = targetState === 'approved' ? 'final' : item.artifactPhase;
    const editorialState = editorialStateFor(targetState, artifactPhase);
    const transitionReasonCodes = targetState === 'review'
      ? ['human_review_required']
      : targetState === 'active'
        ? (reasonCode ? [reasonCode] : [])
        : targetState === 'approved'
          ? []
          : targetState === 'rejected' ? ['content_rejected'] : null;
    const update = db.prepare(`
      UPDATE content_domain_objects
         SET production_state = ?,
             lifecycle_state = ?,
             artifact_phase = ?,
             editorial_state = ?,
             approval_state = CASE
               WHEN ? = 'review' THEN 'required'
               WHEN ? = 'approved' THEN 'approved'
               WHEN ? = 'rejected' THEN 'rejected'
               WHEN ? IN ('active', 'inbox') THEN NULL
               ELSE approval_state
             END,
             review_required = CASE
               WHEN ? = 'review' THEN 1
               WHEN ? IN ('active', 'inbox', 'approved', 'rejected') THEN 0
               ELSE review_required
             END,
             review_reason_codes_json = COALESCE(?, review_reason_codes_json),
             approved_by = CASE
               WHEN ? = 'approved' THEN ?
               WHEN ? IN ('active', 'inbox', 'rejected') THEN NULL
               ELSE approved_by
             END,
             approved_at = CASE
               WHEN ? = 'approved' THEN ?
               WHEN ? IN ('active', 'inbox', 'rejected') THEN NULL
               ELSE approved_at
             END,
             archived_at = CASE WHEN ? = 'archived' THEN ? ELSE archived_at END,
             updated_by = ?,
             updated_at = ?,
             workflow_version = workflow_version + 1
       WHERE id = ? AND ${ITEM_SCOPE_SQL}
         AND workflow_version = ?
    `).run(
      targetState,
      targetState,
      artifactPhase,
      editorialState,
      targetState,
      targetState,
      targetState,
      targetState,
      targetState,
      targetState,
      transitionReasonCodes == null ? null : stableJson(transitionReasonCodes),
      targetState,
      scope.userId,
      targetState,
      targetState,
      now,
      targetState,
      targetState,
      now,
      scope.userId,
      now,
      item.id,
      scope.tenantId,
      scope.userId,
      expectedWorkflowVersion,
    );
    if (update.changes !== 1) {
      const current = requireWorkspaceItem(scope, item.id, db);
      throw workflowConflict(current, expectedWorkflowVersion);
    }
    transitionChanged = true;
    writeWorkspaceEvent(
      db,
      scope,
      item.itemType,
      item.id,
      reasonCode === 'changes_requested' ? 'workspace_changes_requested' : 'workspace_state_changed',
      item.productionState,
      targetState,
      {
        expectedWorkflowVersion,
        ...(auditContext ? { auditContext } : {}),
      },
      transitionReasonCodes ?? [],
    );
    putReceipt(db, scope, operation, idempotencyKey, requestHash, item.itemType, item.id, { changed: true });
    const updated = requireWorkspaceItem(scope, item.id, db);
    return { value: updated, replayed: false, created: false };
  }).immediate();
  if (mutation.replayed) observation.complete('replayed');
  else if (transitionChanged) {
    observation.complete('success');
    if (targetState === 'approved') recordContentWorkspaceProductSignal('content_approved');
    if (targetState === 'scheduled') recordContentWorkspaceProductSignal('content_scheduled');
    if (targetState === 'published') recordContentWorkspaceProductSignal('content_published');
  } else observation.complete('no_change');
  return mutation;
  } catch (error) {
    observation.completeFromError(error);
    throw error;
  }
}

export function createContentItemRelationship(
  input: CreateContentRelationshipInput,
  db: Database.Database = getDb(),
): ContentMutationResult<ContentItemRelationship> {
  const scope = normalizeScope(input.scope);
  assertContentWorkspaceWriteEnabled(scope, 'core');
  const fromItemId = normalizePositiveInteger(input.fromItemId, 'fromItemId');
  const toItemId = normalizePositiveInteger(input.toItemId, 'toItemId');
  const relationshipType = requireEnum(input.relationshipType, CONTENT_RELATIONSHIP_TYPES, 'relationshipType');
  const position = input.position == null ? null : normalizeNonNegativeInteger(input.position, 'position');
  const metadata = normalizeRecord(input.metadata, 'metadata');
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  if (fromItemId === toItemId) {
    throw new ContentWorkspaceError('CONTENT_RELATIONSHIP_INVALID', 'A content item cannot relate to itself.', 400);
  }
  const operation = 'create_relationship';
  const requestHash = hashPayload({ fromItemId, toItemId, relationshipType, position, metadata });

  return db.transaction(() => {
    const receipt = getReceipt(db, scope, operation, idempotencyKey, requestHash);
    if (receipt) {
      const relationship = getRelationship(scope, Number(receipt.resourceId), db);
      if (!relationship) throw inconsistentReceiptError();
      return { value: relationship, replayed: true, created: false };
    }
    const from = requireWorkspaceItem(scope, fromItemId, db);
    const to = requireWorkspaceItem(scope, toItemId, db);
    validateRelationshipTypes(from, to, relationshipType);
    const existing = db.prepare(`
      SELECT *
        FROM content_item_relationships
       WHERE tenant_id = ? AND owner_user_id = ?
         AND from_item_id = ? AND to_item_id = ? AND relationship_type = ?
       LIMIT 1
    `).get(scope.tenantId, scope.userId, from.id, to.id, relationshipType) as RelationshipRow | undefined;
    if (existing) {
      putReceipt(db, scope, operation, idempotencyKey, requestHash, 'relationship', existing.id, { created: false });
      return { value: mapRelationship(existing), replayed: false, created: false };
    }
    const now = new Date().toISOString();
    const insert = db.prepare(`
      INSERT INTO content_item_relationships (
        tenant_id, owner_user_id, from_item_id, to_item_id,
        relationship_type, position, metadata_json, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      scope.tenantId,
      scope.userId,
      from.id,
      to.id,
      relationshipType,
      position,
      stableJson(metadata),
      scope.userId,
      now,
    );
    const relationshipId = Number(insert.lastInsertRowid);
    writeWorkspaceEvent(db, scope, from.itemType, from.id, 'workspace_relationship_created', from.productionState, from.productionState, {
      relationshipId,
      relationshipType,
      toItemId: to.id,
    });
    putReceipt(db, scope, operation, idempotencyKey, requestHash, 'relationship', relationshipId, { created: true });
    const relationship = getRelationship(scope, relationshipId, db);
    if (!relationship) throw new ContentWorkspaceError('CONTENT_WORKSPACE_WRITE_FAILED', 'Relationship was not readable after creation.', 500);
    return { value: relationship, replayed: false, created: true };
  }).immediate();
}

export function removeContentItemRelationship(
  input: RemoveContentRelationshipInput,
  db: Database.Database = getDb(),
): ContentChangeResult<ContentRelationshipRemoval> {
  const scope = normalizeScope(input.scope);
  assertContentWorkspaceWriteEnabled(scope, 'core');
  const relationshipId = normalizePositiveInteger(input.relationshipId, 'relationshipId');
  const expectedFromWorkflowVersion = normalizePositiveInteger(
    input.expectedFromWorkflowVersion,
    'expectedFromWorkflowVersion',
  );
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const operation = `remove_relationship:${relationshipId}`;
  const requestHash = hashPayload({ relationshipId, expectedFromWorkflowVersion });

  return db.transaction(() => {
    const receipt = getReceipt(db, scope, operation, idempotencyKey, requestHash);
    if (receipt) {
      return {
        value: relationshipRemovalFromReceipt(receipt, relationshipId),
        replayed: true,
        changed: receipt.metadata.changed === true,
      };
    }

    const relationship = requireRelationship(scope, relationshipId, db);
    const fromItem = requireWorkspaceItem(scope, relationship.fromItemId, db);
    if (fromItem.workflowVersion !== expectedFromWorkflowVersion) {
      throw workflowConflict(fromItem, expectedFromWorkflowVersion);
    }

    const removedAt = new Date().toISOString();
    const removal: ContentRelationshipRemoval = {
      relationshipId: relationship.id,
      fromItemId: relationship.fromItemId,
      toItemId: relationship.toItemId,
      relationshipType: relationship.relationshipType,
      removedAt,
    };
    const deletion = db.prepare(`
      DELETE FROM content_item_relationships
       WHERE id = ? AND tenant_id = ? AND owner_user_id = ?
    `).run(relationship.id, scope.tenantId, scope.userId);
    if (deletion.changes !== 1) {
      throw new ContentWorkspaceError(
        'CONTENT_RELATIONSHIP_CONFLICT',
        'This relationship changed after it was loaded.',
        409,
        { relationshipId, recovery: 'reload_and_retry' },
      );
    }
    advanceRelationshipOwnerVersion(db, scope, fromItem, expectedFromWorkflowVersion, removedAt);
    writeWorkspaceEvent(
      db,
      scope,
      fromItem.itemType,
      fromItem.id,
      'workspace_relationship_removed',
      fromItem.productionState,
      fromItem.productionState,
      {
        relationshipId: relationship.id,
        relationshipType: relationship.relationshipType,
        toItemId: relationship.toItemId,
        expectedFromWorkflowVersion,
      },
    );
    putReceipt(db, scope, operation, idempotencyKey, requestHash, 'relationship', relationship.id, {
      changed: true,
      removal,
    });
    return { value: removal, replayed: false, changed: true };
  }).immediate();
}

export function reorderContentItemRelationship(
  input: ReorderContentRelationshipInput,
  db: Database.Database = getDb(),
): ContentChangeResult<ContentItemRelationship> {
  const scope = normalizeScope(input.scope);
  assertContentWorkspaceWriteEnabled(scope, 'core');
  const relationshipId = normalizePositiveInteger(input.relationshipId, 'relationshipId');
  const expectedFromWorkflowVersion = normalizePositiveInteger(
    input.expectedFromWorkflowVersion,
    'expectedFromWorkflowVersion',
  );
  const position = normalizeNonNegativeInteger(input.position, 'position');
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const operation = `reorder_relationship:${relationshipId}`;
  const requestHash = hashPayload({ relationshipId, expectedFromWorkflowVersion, position });

  return db.transaction(() => {
    const receipt = getReceipt(db, scope, operation, idempotencyKey, requestHash);
    if (receipt) {
      return {
        value: relationshipFromReceipt(receipt, relationshipId),
        replayed: true,
        changed: receipt.metadata.changed === true,
      };
    }

    const relationship = requireRelationship(scope, relationshipId, db);
    const fromItem = requireWorkspaceItem(scope, relationship.fromItemId, db);
    if (fromItem.workflowVersion !== expectedFromWorkflowVersion) {
      throw workflowConflict(fromItem, expectedFromWorkflowVersion);
    }
    const siblings = (db.prepare(`
      SELECT *
        FROM content_item_relationships
       WHERE tenant_id = ? AND owner_user_id = ?
         AND from_item_id = ? AND relationship_type = ?
       ORDER BY COALESCE(position, 2147483647) ASC, id ASC
    `).all(
      scope.tenantId,
      scope.userId,
      relationship.fromItemId,
      relationship.relationshipType,
    ) as RelationshipRow[]).map(mapRelationship);
    if (position >= siblings.length) {
      throw new ContentWorkspaceError(
        'CONTENT_RELATIONSHIP_POSITION_INVALID',
        'position must identify an existing place in this relationship group.',
        400,
        { field: 'position', maximum: Math.max(0, siblings.length - 1) },
      );
    }
    const sourceIndex = siblings.findIndex((candidate) => candidate.id === relationship.id);
    if (sourceIndex < 0) {
      throw new ContentWorkspaceError(
        'CONTENT_RELATIONSHIP_INTEGRITY_FAILED',
        'The relationship could not be found in its organization group.',
        500,
      );
    }
    const ordered = siblings.slice();
    const [moving] = ordered.splice(sourceIndex, 1);
    ordered.splice(position, 0, moving);
    const changed = ordered.some((candidate, index) => candidate.position !== index);
    if (!changed) {
      putReceipt(db, scope, operation, idempotencyKey, requestHash, 'relationship', relationship.id, {
        changed: false,
        relationship,
      });
      return { value: relationship, replayed: false, changed: false };
    }

    const updatedAt = new Date().toISOString();
    const updatePosition = db.prepare(`
      UPDATE content_item_relationships
         SET position = ?
       WHERE id = ? AND tenant_id = ? AND owner_user_id = ?
         AND from_item_id = ? AND relationship_type = ?
    `);
    for (const [index, candidate] of ordered.entries()) {
      const update = updatePosition.run(
        index,
        candidate.id,
        scope.tenantId,
        scope.userId,
        relationship.fromItemId,
        relationship.relationshipType,
      );
      if (update.changes !== 1) {
        throw new ContentWorkspaceError(
          'CONTENT_RELATIONSHIP_CONFLICT',
          'A relationship changed while the organization order was being saved.',
          409,
          { relationshipId, recovery: 'reload_and_retry' },
        );
      }
    }
    advanceRelationshipOwnerVersion(db, scope, fromItem, expectedFromWorkflowVersion, updatedAt);
    const reordered = requireRelationship(scope, relationship.id, db);
    writeWorkspaceEvent(
      db,
      scope,
      fromItem.itemType,
      fromItem.id,
      'workspace_relationship_reordered',
      fromItem.productionState,
      fromItem.productionState,
      {
        relationshipId: relationship.id,
        relationshipType: relationship.relationshipType,
        fromPosition: sourceIndex,
        toPosition: position,
        expectedFromWorkflowVersion,
      },
    );
    putReceipt(db, scope, operation, idempotencyKey, requestHash, 'relationship', reordered.id, {
      changed: true,
      relationship: reordered,
    });
    return { value: reordered, replayed: false, changed: true };
  }).immediate();
}

export function duplicateContentWorkspaceItem(
  input: DuplicateContentWorkspaceItemInput,
  db: Database.Database = getDb(),
): ContentMutationResult<ContentWorkspaceCopy> {
  const scope = normalizeScope(input.scope);
  assertContentWorkspaceWriteEnabled(scope, 'core');
  assertContentWorkspaceWriteEnabled(scope, 'revisions');
  const sourceItemId = normalizePositiveInteger(input.sourceItemId, 'sourceItemId');
  const expectedWorkflowVersion = normalizePositiveInteger(input.expectedWorkflowVersion, 'expectedWorkflowVersion');
  const mode = requireEnum(input.mode, CONTENT_WORKSPACE_COPY_MODES, 'mode');
  const requestedTitle = input.title === undefined ? undefined : requireText(input.title, 'title', 240);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const operation = `copy_item:${sourceItemId}`;
  const requestHash = hashPayload({ sourceItemId, expectedWorkflowVersion, mode, title: requestedTitle ?? null });

  return db.transaction(() => {
    const receipt = getReceipt(db, scope, operation, idempotencyKey, requestHash);
    if (receipt) {
      return {
        value: workspaceCopyFromReceipt(scope, receipt, sourceItemId, mode, db),
        replayed: true,
        created: false,
      };
    }

    const source = requireWorkspaceItem(scope, sourceItemId, db);
    if (source.itemType !== 'content_item') {
      throw new ContentWorkspaceError(
        'CONTENT_COPY_SOURCE_INVALID',
        'Only content items can be duplicated or remixed. Create a new project instead of copying a project lifecycle.',
        400,
      );
    }
    if (source.workflowVersion !== expectedWorkflowVersion) {
      throw workflowConflict(source, expectedWorkflowVersion);
    }
    const sourceArtifacts = listContentArtifacts(scope, source.id, db);
    if (sourceArtifacts.length > 200) {
      throw new ContentWorkspaceError(
        'CONTENT_COPY_TOO_LARGE',
        'This content item has too many artifacts to copy in one safe operation.',
        413,
        { maximumArtifacts: 200 },
      );
    }
    const copiedAt = new Date().toISOString();
    const copyTitle = requestedTitle ?? defaultCopyTitle(source.title, mode);
    const itemInsert = db.prepare(`
      INSERT INTO content_domain_objects (
        tenant_id, owner_user_id, visibility_scope, scope_status,
        object_type, lifecycle_state, production_state, artifact_phase,
        title, summary, platform_id, format_id, workspace_priority,
        deadline_at, is_favorite, next_action_json,
        ontology_metadata_json, ontology_schema_version,
        workspace_schema_version, created_by, updated_by,
        audit_metadata_json, created_at, updated_at
      ) VALUES (
        ?, ?, 'user_private', 'active',
        'content_item', 'inbox', 'inbox', 'idea',
        ?, ?, ?, ?, ?,
        NULL, 0, '{}',
        '{}', 'content-ontology-v1',
        ?, ?, ?,
        ?, ?, ?
      )
    `).run(
      scope.tenantId,
      scope.userId,
      copyTitle,
      source.summary,
      source.platformId,
      source.formatId,
      source.priority,
      CONTENT_WORKSPACE_SCHEMA_VERSION,
      scope.userId,
      scope.userId,
      stableJson({
        source: 'content_workspace_copy',
        mode,
        sourceItemId: source.id,
        sourceWorkflowVersion: source.workflowVersion,
      }),
      copiedAt,
      copiedAt,
    );
    const copiedItemId = Number(itemInsert.lastInsertRowid);
    const artifactIdMap = new Map<number, number>();
    const artifactMappings: ContentArtifactCopyMapping[] = [];
    const artifactRelationshipType: 'derived_from' | 'remix_of' = mode === 'remix' ? 'remix_of' : 'derived_from';

    for (const sourceArtifact of sourceArtifacts) {
      if (sourceArtifact.revisionCount > 0 && sourceArtifact.currentRevision == null) {
        throw new ContentWorkspaceError(
          'CONTENT_REVISION_INTEGRITY_FAILED',
          'A source artifact has revision history but no readable current revision.',
          500,
          { artifactId: sourceArtifact.id },
        );
      }
      const artifactInsert = db.prepare(`
        INSERT INTO content_artifacts (
          tenant_id, owner_user_id, visibility_scope, scope_status,
          item_id, artifact_type, title, platform_id, format_id,
          metadata_json, schema_version, created_by, updated_by,
          created_at, updated_at
        ) VALUES (?, ?, 'user_private', 'active', ?, ?, ?, ?, ?, ?, 'content-artifact-v1', ?, ?, ?, ?)
      `).run(
        scope.tenantId,
        scope.userId,
        copiedItemId,
        sourceArtifact.artifactType,
        sourceArtifact.title,
        sourceArtifact.platformId,
        sourceArtifact.formatId,
        stableJson(sourceArtifact.metadata),
        scope.userId,
        scope.userId,
        copiedAt,
        copiedAt,
      );
      const copiedArtifactId = Number(artifactInsert.lastInsertRowid);
      artifactIdMap.set(sourceArtifact.id, copiedArtifactId);

      let copiedRevisionId: number | null = null;
      let sourceRevisionId: number | null = null;
      let contentHash: string | null = null;
      if (sourceArtifact.currentRevision) {
        const sourceRevision = requireRawCurrentRevision(scope, sourceArtifact, db);
        sourceRevisionId = Number(sourceRevision.id);
        contentHash = sourceRevision.content_hash;
        const provenance = {
          source: 'content_workspace_copy',
          mode,
          sourceItemId: source.id,
          sourceArtifactId: sourceArtifact.id,
          sourceRevisionId,
          sourceRevisionNumber: Number(sourceRevision.revision_number),
          sourceContentHash: sourceRevision.content_hash,
          inheritedProvenance: parseRecord(sourceRevision.provenance_json),
        };
        const revisionInsert = db.prepare(`
          INSERT INTO content_revisions (
            tenant_id, owner_user_id, artifact_id, revision_number,
            parent_revision_id, restored_from_revision_id,
            content_format, content_text, structured_content_json, content_hash,
            change_summary, change_reason, actor_type, actor_id,
            provenance_json, schema_version, created_by, created_at
          ) VALUES (?, ?, ?, 1, NULL, NULL, ?, ?, ?, ?, ?, ?, 'user', ?, ?, 'content-revision-v1', ?, ?)
        `).run(
          scope.tenantId,
          scope.userId,
          copiedArtifactId,
          sourceRevision.content_format,
          sourceRevision.content_text ?? null,
          sourceRevision.structured_content_json ?? null,
          sourceRevision.content_hash,
          mode === 'remix' ? 'Created from a remix snapshot' : 'Created from a duplicate snapshot',
          mode === 'remix' ? 'content_item_remixed' : 'content_item_duplicated',
          String(scope.userId),
          stableJson(provenance),
          scope.userId,
          copiedAt,
        );
        copiedRevisionId = Number(revisionInsert.lastInsertRowid);
        const pointer = db.prepare(`
          UPDATE content_artifacts
             SET current_revision_id = ?, revision_count = 1, updated_at = ?
           WHERE id = ? AND ${ARTIFACT_SCOPE_SQL}
        `).run(
          copiedRevisionId,
          copiedAt,
          copiedArtifactId,
          scope.tenantId,
          scope.userId,
        );
        if (pointer.changes !== 1) {
          throw new ContentWorkspaceError('CONTENT_WORKSPACE_WRITE_FAILED', 'Copied revision could not be selected.', 500);
        }
        copyRevisionLineageSnapshot(
          db,
          scope,
          sourceRevisionId,
          copiedRevisionId,
          copiedAt,
          mode,
        );
      }

      const artifactRelationshipMetadata = {
        mode,
        sourceItemId: source.id,
        sourceRevisionId,
        copiedRevisionId,
        sourceContentHash: contentHash,
        copiedAt,
      };
      db.prepare(`
        INSERT INTO content_artifact_relationships (
          tenant_id, owner_user_id, from_artifact_id, to_artifact_id,
          relationship_type, metadata_json, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        scope.tenantId,
        scope.userId,
        copiedArtifactId,
        sourceArtifact.id,
        artifactRelationshipType,
        stableJson(artifactRelationshipMetadata),
        scope.userId,
        copiedAt,
      );
      artifactMappings.push({
        sourceArtifactId: sourceArtifact.id,
        sourceRevisionId,
        copiedArtifactId,
        copiedRevisionId,
        contentHash,
      });
    }

    const copiedCurrentArtifactId = source.currentArtifactId == null
      ? null
      : artifactIdMap.get(source.currentArtifactId) ?? null;
    if (source.currentArtifactId != null && copiedCurrentArtifactId == null) {
      throw new ContentWorkspaceError(
        'CONTENT_ARTIFACT_INTEGRITY_FAILED',
        'The source item points to an artifact that could not be copied.',
        500,
        { artifactId: source.currentArtifactId },
      );
    }
    const selectedSourceArtifact = source.currentArtifactId == null
      ? null
      : sourceArtifacts.find((artifact) => artifact.id === source.currentArtifactId) ?? null;
    const copiedPhase = selectedSourceArtifact ? phaseForArtifactType(selectedSourceArtifact.artifactType) : 'idea';
    const copiedState: ContentProductionState = copiedCurrentArtifactId != null && copiedPhase !== 'idea' ? 'active' : 'inbox';
    const itemUpdate = db.prepare(`
      UPDATE content_domain_objects
         SET current_artifact_id = ?, artifact_phase = ?,
             production_state = ?, lifecycle_state = ?, editorial_state = ?,
             updated_by = ?, updated_at = ?
       WHERE id = ? AND ${ITEM_SCOPE_SQL}
    `).run(
      copiedCurrentArtifactId,
      copiedPhase,
      copiedState,
      copiedState,
      editorialStateFor(copiedState, copiedPhase),
      scope.userId,
      copiedAt,
      copiedItemId,
      scope.tenantId,
      scope.userId,
    );
    if (itemUpdate.changes !== 1) {
      throw new ContentWorkspaceError('CONTENT_WORKSPACE_WRITE_FAILED', 'Copied item could not select its artifact snapshot.', 500);
    }

    db.prepare(`
      INSERT INTO content_item_tags (
        tenant_id, owner_user_id, item_id, tag_id, created_by, created_at
      )
      SELECT tenant_id, owner_user_id, ?, tag_id, ?, ?
        FROM content_item_tags
       WHERE tenant_id = ? AND owner_user_id = ? AND item_id = ?
    `).run(copiedItemId, scope.userId, copiedAt, scope.tenantId, scope.userId, source.id);

    const itemRelationshipType: ContentRelationshipType = mode === 'remix' ? 'remix_of' : 'derived_from';
    const relationshipInsert = db.prepare(`
      INSERT INTO content_item_relationships (
        tenant_id, owner_user_id, from_item_id, to_item_id,
        relationship_type, position, metadata_json, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)
    `).run(
      scope.tenantId,
      scope.userId,
      copiedItemId,
      source.id,
      itemRelationshipType,
      stableJson({
        mode,
        sourceWorkflowVersion: source.workflowVersion,
        artifactSnapshotCount: artifactMappings.length,
        copiedAt,
      }),
      scope.userId,
      copiedAt,
    );
    const relationship = requireRelationship(scope, Number(relationshipInsert.lastInsertRowid), db);
    writeWorkspaceEvent(
      db,
      scope,
      'content_item',
      copiedItemId,
      mode === 'remix' ? 'workspace_item_remixed' : 'workspace_item_duplicated',
      null,
      copiedState,
      {
        sourceItemId: source.id,
        sourceWorkflowVersion: source.workflowVersion,
        relationshipId: relationship.id,
        artifactSnapshotCount: artifactMappings.length,
      },
    );
    const item = getContentWorkspaceItemDetail(scope, copiedItemId, db);
    if (!item) {
      throw new ContentWorkspaceError('CONTENT_WORKSPACE_WRITE_FAILED', 'Copied item was not readable after creation.', 500);
    }
    const copy: ContentWorkspaceCopy = {
      mode,
      sourceItemId: source.id,
      sourceWorkflowVersion: source.workflowVersion,
      item,
      relationship,
      artifactMappings,
      copiedAt,
    };
    putReceipt(db, scope, operation, idempotencyKey, requestHash, 'content_item', copiedItemId, {
      copy: copyReceiptSnapshot(copy),
    });
    return { value: copy, replayed: false, created: true };
  }).immediate();
}

function mutateContentItemTag(
  input: MutateContentItemTagInput,
  attach: boolean,
  db: Database.Database,
): ContentChangeResult<ContentWorkspaceItem> {
  const scope = normalizeScope(input.scope);
  const itemId = normalizePositiveInteger(input.itemId, 'itemId');
  const tagId = normalizePositiveInteger(input.tagId, 'tagId');
  const expectedWorkflowVersion = normalizePositiveInteger(input.expectedWorkflowVersion, 'expectedWorkflowVersion');
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const operation = `${attach ? 'attach' : 'detach'}_tag:${itemId}`;
  const requestHash = hashPayload({ itemId, tagId, expectedWorkflowVersion });

  return db.transaction(() => {
    const receipt = getReceipt(db, scope, operation, idempotencyKey, requestHash);
    if (receipt) {
      const item = getContentWorkspaceItem(scope, Number(receipt.resourceId), db);
      if (!item) throw inconsistentReceiptError();
      return { value: item, replayed: true, changed: receipt.metadata.changed === true };
    }
    const item = requireWorkspaceItem(scope, itemId, db);
    if (item.workflowVersion !== expectedWorkflowVersion) {
      throw workflowConflict(item, expectedWorkflowVersion);
    }
    if (!getContentTag(scope, tagId, db)) {
      throw new ContentWorkspaceError('CONTENT_TAG_NOT_FOUND', 'Content tag not found.', 404);
    }
    const existing = db.prepare(`
      SELECT id
        FROM content_item_tags
       WHERE tenant_id = ? AND owner_user_id = ?
         AND item_id = ? AND tag_id = ?
       LIMIT 1
    `).get(scope.tenantId, scope.userId, item.id, tagId) as { id: number } | undefined;
    const changed = attach ? existing === undefined : existing !== undefined;
    if (!changed) {
      putReceipt(db, scope, operation, idempotencyKey, requestHash, item.itemType, item.id, { changed: false });
      return { value: item, replayed: false, changed: false };
    }
    const now = new Date().toISOString();
    if (attach) {
      db.prepare(`
        INSERT INTO content_item_tags (
          tenant_id, owner_user_id, item_id, tag_id, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(scope.tenantId, scope.userId, item.id, tagId, scope.userId, now);
    } else {
      db.prepare(`
        DELETE FROM content_item_tags
         WHERE tenant_id = ? AND owner_user_id = ?
           AND item_id = ? AND tag_id = ?
      `).run(scope.tenantId, scope.userId, item.id, tagId);
    }
    const update = db.prepare(`
      UPDATE content_domain_objects
         SET updated_by = ?, updated_at = ?, workflow_version = workflow_version + 1
       WHERE id = ? AND ${ITEM_SCOPE_SQL}
         AND workflow_version = ?
    `).run(scope.userId, now, item.id, scope.tenantId, scope.userId, expectedWorkflowVersion);
    if (update.changes !== 1) {
      throw workflowConflict(requireWorkspaceItem(scope, item.id, db), expectedWorkflowVersion);
    }
    writeWorkspaceEvent(
      db,
      scope,
      item.itemType,
      item.id,
      attach ? 'workspace_tag_attached' : 'workspace_tag_detached',
      item.productionState,
      item.productionState,
      { tagId, expectedWorkflowVersion },
    );
    putReceipt(db, scope, operation, idempotencyKey, requestHash, item.itemType, item.id, { changed: true, tagId });
    return { value: requireWorkspaceItem(scope, item.id, db), replayed: false, changed: true };
  }).immediate();
}

function getContentTag(
  scope: ContentWorkspaceScope,
  tagId: number,
  db: Database.Database,
): ContentTag | null {
  const row = db.prepare(`
    SELECT *
      FROM content_tags
     WHERE id = ? AND tenant_id = ? AND owner_user_id = ?
       AND visibility_scope = 'user_private' AND scope_status = 'active'
     LIMIT 1
  `).get(tagId, scope.tenantId, scope.userId) as ContentTagRow | undefined;
  return row ? mapTag(row) : null;
}

function getContentTagByNormalizedName(
  scope: ContentWorkspaceScope,
  normalizedName: string,
  db: Database.Database,
): ContentTag | null {
  const row = db.prepare(`
    SELECT *
      FROM content_tags
     WHERE tenant_id = ? AND owner_user_id = ?
       AND visibility_scope = 'user_private' AND scope_status = 'active'
       AND normalized_name = ?
     LIMIT 1
  `).get(scope.tenantId, scope.userId, normalizedName) as ContentTagRow | undefined;
  return row ? mapTag(row) : null;
}

function getDeletedContentWorkspaceItem(
  scope: ContentWorkspaceScope,
  itemId: number,
  db: Database.Database,
): ContentWorkspaceItem | null {
  const row = db.prepare(`
    SELECT o.*,
           (SELECT COUNT(*)
              FROM content_artifacts a
             WHERE a.item_id = o.id
               AND a.tenant_id = o.tenant_id
               AND a.owner_user_id = o.owner_user_id
               AND a.scope_status = 'active') AS artifact_count
      FROM content_domain_objects o
     WHERE o.id = ? AND ${qualifiedDeletedItemScopeSql('o')}
     LIMIT 1
  `).get(itemId, scope.tenantId, scope.userId) as WorkspaceItemRow | undefined;
  if (!row) return null;
  return mapItem(row, loadTagsForItems(scope, [itemId], db).get(itemId) ?? []);
}

function loadTagsForItems(
  scope: ContentWorkspaceScope,
  itemIds: number[],
  db: Database.Database,
): Map<number, ContentTag[]> {
  const byItem = new Map<number, ContentTag[]>();
  if (itemIds.length === 0) return byItem;
  const placeholders = itemIds.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT it.item_id, t.*
      FROM content_item_tags it
      JOIN content_tags t
        ON t.id = it.tag_id
       AND t.tenant_id = it.tenant_id
       AND t.owner_user_id = it.owner_user_id
     WHERE it.tenant_id = ? AND it.owner_user_id = ?
       AND it.item_id IN (${placeholders})
       AND t.visibility_scope = 'user_private' AND t.scope_status = 'active'
     ORDER BY t.normalized_name ASC, t.id ASC
  `).all(scope.tenantId, scope.userId, ...itemIds) as Array<ContentTagRow & { item_id: number }>;
  for (const row of rows) {
    const itemId = Number(row.item_id);
    const tags = byItem.get(itemId) ?? [];
    tags.push(mapTag(row));
    byItem.set(itemId, tags);
  }
  return byItem;
}

function requireWorkspaceItem(
  scope: ContentWorkspaceScope,
  itemId: number,
  db: Database.Database,
): ContentWorkspaceItem {
  const item = getContentWorkspaceItem(scope, itemId, db);
  if (!item) throw new ContentWorkspaceError('CONTENT_ITEM_NOT_FOUND', 'Content item not found.', 404);
  return item;
}

function requireArtifactRow(
  scope: ContentWorkspaceScope,
  artifactId: number,
  db: Database.Database,
): ArtifactBaseRow {
  const row = db.prepare(`
    SELECT a.*
      FROM content_artifacts a
      JOIN content_domain_objects o
        ON o.id = a.item_id
       AND o.tenant_id = a.tenant_id
       AND o.owner_user_id = a.owner_user_id
     WHERE a.id = ?
       AND ${qualifiedArtifactScopeSql('a')}
       AND ${qualifiedItemScopeSql('o')}
     LIMIT 1
  `).get(artifactId, scope.tenantId, scope.userId, scope.tenantId, scope.userId) as ArtifactBaseRow | undefined;
  if (!row) throw new ContentWorkspaceError('CONTENT_ARTIFACT_NOT_FOUND', 'Content artifact not found.', 404);
  return row;
}

function assertBaseRevision(artifact: ArtifactBaseRow, supplied: number): void {
  const current = Number(artifact.revision_count ?? 0);
  if (current !== supplied) {
    throw new ContentWorkspaceError('CONTENT_REVISION_CONFLICT', 'This content changed after the editor loaded it.', 409, {
      suppliedBaseRevision: supplied,
      currentRevision: current,
      currentRevisionId: artifact.current_revision_id == null ? null : Number(artifact.current_revision_id),
      recovery: 'reload_compare_and_retry',
    });
  }
}

function advanceArtifactRevisionPointer(
  db: Database.Database,
  scope: ContentWorkspaceScope,
  artifact: ArtifactBaseRow,
  revisionId: number,
  baseRevision: number,
  now: string,
): void {
  const update = db.prepare(`
    UPDATE content_artifacts
       SET current_revision_id = ?,
           revision_count = revision_count + 1,
           updated_by = ?,
           updated_at = ?
     WHERE id = ? AND ${ARTIFACT_SCOPE_SQL}
       AND revision_count = ?
       AND current_revision_id IS ?
  `).run(
    revisionId,
    scope.userId,
    now,
    artifact.id,
    scope.tenantId,
    scope.userId,
    baseRevision,
    artifact.current_revision_id,
  );
  if (update.changes !== 1) {
    const latest = requireArtifactRow(scope, Number(artifact.id), db);
    assertBaseRevision(latest, baseRevision);
    throw new ContentWorkspaceError('CONTENT_REVISION_CONFLICT', 'This content changed during save.', 409, {
      suppliedBaseRevision: baseRevision,
      currentRevision: Number(latest.revision_count),
      currentRevisionId: latest.current_revision_id == null ? null : Number(latest.current_revision_id),
      recovery: 'reload_compare_and_retry',
    });
  }
}

function insertRevision(
  db: Database.Database,
  input: {
    scope: ContentWorkspaceScope;
    artifactId: number;
    revisionNumber: number;
    parentRevisionId: number | null;
    restoredFromRevisionId: number | null;
    content: ContentRevisionContent;
    changeSummary: string | null;
    changeReason: string | null;
    actorType: ContentRevisionActorType;
    actorId: string | null;
    provenance: Record<string, unknown>;
    now: string;
  },
): number {
  const structuredJson = input.content.format === 'structured_json'
    ? stableJson(input.content.document)
    : null;
  const text = input.content.format === 'structured_json' ? null : input.content.text;
  const result = db.prepare(`
    INSERT INTO content_revisions (
      tenant_id, owner_user_id, artifact_id, revision_number,
      parent_revision_id, restored_from_revision_id,
      content_format, content_text, structured_content_json, content_hash,
      change_summary, change_reason, actor_type, actor_id,
      provenance_json, schema_version, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'content-revision-v1', ?, ?)
  `).run(
    input.scope.tenantId,
    input.scope.userId,
    input.artifactId,
    input.revisionNumber,
    input.parentRevisionId,
    input.restoredFromRevisionId,
    input.content.format,
    text,
    structuredJson,
    hashRevisionContent(input.content),
    input.changeSummary,
    input.changeReason,
    input.actorType,
    input.actorId,
    stableJson(input.provenance),
    input.scope.userId,
    input.now,
  );
  return Number(result.lastInsertRowid);
}

function getRelationship(
  scope: ContentWorkspaceScope,
  relationshipId: number,
  db: Database.Database,
): ContentItemRelationship | null {
  const row = db.prepare(`
    SELECT *
      FROM content_item_relationships
     WHERE id = ? AND tenant_id = ? AND owner_user_id = ?
     LIMIT 1
  `).get(relationshipId, scope.tenantId, scope.userId) as RelationshipRow | undefined;
  return row ? mapRelationship(row) : null;
}

function requireRelationship(
  scope: ContentWorkspaceScope,
  relationshipId: number,
  db: Database.Database,
): ContentItemRelationship {
  const relationship = getRelationship(scope, relationshipId, db);
  if (!relationship) {
    throw new ContentWorkspaceError('CONTENT_RELATIONSHIP_NOT_FOUND', 'Content relationship not found.', 404);
  }
  return relationship;
}

function advanceRelationshipOwnerVersion(
  db: Database.Database,
  scope: ContentWorkspaceScope,
  fromItem: ContentWorkspaceItem,
  expectedWorkflowVersion: number,
  updatedAt: string,
): void {
  const update = db.prepare(`
    UPDATE content_domain_objects
       SET workflow_version = workflow_version + 1,
           updated_by = ?,
           updated_at = ?
     WHERE id = ? AND ${ITEM_SCOPE_SQL}
       AND workflow_version = ?
  `).run(
    scope.userId,
    updatedAt,
    fromItem.id,
    scope.tenantId,
    scope.userId,
    expectedWorkflowVersion,
  );
  if (update.changes !== 1) {
    throw workflowConflict(requireWorkspaceItem(scope, fromItem.id, db), expectedWorkflowVersion);
  }
}

function requireRawCurrentRevision(
  scope: ContentWorkspaceScope,
  artifact: ContentArtifact,
  db: Database.Database,
): RevisionRow {
  if (!artifact.currentRevision || artifact.currentRevisionId == null) {
    throw new ContentWorkspaceError(
      'CONTENT_REVISION_INTEGRITY_FAILED',
      'The source artifact does not have a readable current revision.',
      500,
      { artifactId: artifact.id },
    );
  }
  const row = db.prepare(`
    SELECT *
      FROM content_revisions
     WHERE id = ? AND artifact_id = ?
       AND tenant_id = ? AND owner_user_id = ?
     LIMIT 1
  `).get(
    artifact.currentRevisionId,
    artifact.id,
    scope.tenantId,
    scope.userId,
  ) as RevisionRow | undefined;
  if (!row || mapRevision(row).contentHash !== artifact.currentRevision.contentHash) {
    throw new ContentWorkspaceError(
      'CONTENT_REVISION_INTEGRITY_FAILED',
      'The source artifact revision failed its integrity check.',
      500,
      { artifactId: artifact.id },
    );
  }
  return row;
}

function validateRelationshipTypes(
  from: ContentWorkspaceItem,
  to: ContentWorkspaceItem,
  relationshipType: ContentRelationshipType,
): void {
  if (relationshipType === 'contains' && (from.itemType !== 'project' || to.itemType !== 'content_item')) {
    throw new ContentWorkspaceError(
      'CONTENT_RELATIONSHIP_INVALID',
      'A contains relationship must connect a project to a content item.',
      400,
    );
  }
  if (
    ['derived_from', 'variant_of', 'remix_of'].includes(relationshipType)
    && (from.itemType !== 'content_item' || to.itemType !== 'content_item')
  ) {
    throw new ContentWorkspaceError(
      'CONTENT_RELATIONSHIP_INVALID',
      `${relationshipType} relationships are only valid between content items.`,
      400,
    );
  }
}

function assertNoOpenContentWorkSchedule(
  scope: ContentWorkspaceScope,
  itemId: number,
  operation: 'trash' | 'archive' | 'leave_scheduled_state',
  db: Database.Database,
): void {
  const tableExists = db.prepare(`
    SELECT 1
      FROM sqlite_master
     WHERE type = 'table' AND name = 'content_schedule_bindings'
     LIMIT 1
  `).get();
  if (!tableExists) return;
  const schedule = db.prepare(`
    SELECT state
      FROM content_schedule_bindings
     WHERE tenant_id = ? AND owner_user_id = ? AND item_id = ?
       AND state IN ('scheduled', 'provider_synced', 'sync_failed', 'cancel_pending', 'cancel_failed')
     ORDER BY id DESC
     LIMIT 1
  `).get(scope.tenantId, scope.userId, itemId) as { state: string } | undefined;
  if (!schedule) return;
  throw new ContentWorkspaceError(
    'CONTENT_SCHEDULE_CANCELLATION_REQUIRED',
    operation === 'trash'
      ? 'Cancel the active Content work block before moving this item to Trash.'
      : operation === 'archive'
        ? 'Cancel the active Content work block before archiving this item.'
        : 'Use the dedicated Content schedule cancellation flow so Secretary and provider state stay consistent.',
    409,
    {
      scheduleState: schedule.state,
      recovery: 'cancel_content_work_schedule',
      publicationExecution: 'not_performed',
    },
  );
}

function validateItemStateTarget(
  scope: ContentWorkspaceScope,
  item: ContentWorkspaceItem,
  targetState: ContentProductionState,
  db: Database.Database,
): void {
  if (item.itemType === 'project') {
    if (!['inbox', 'active', 'archived'].includes(targetState)) {
      throw new ContentWorkspaceError(
        'CONTENT_STATE_TRANSITION_INVALID',
        'Projects can be active or archived; review and publishing states belong to content items.',
        409,
        { fromState: item.productionState, targetState },
      );
    }
    return;
  }
  if (targetState === 'published') {
    throw new ContentWorkspaceError(
      'CONTENT_PUBLICATION_CONFIRMATION_REQUIRED',
      'Publication cannot be inferred from a status change. Confirm the external publication through the dedicated tracking flow.',
      409,
      {
        publicationExecution: 'not_performed',
        recovery: 'confirm_external_publication',
      },
    );
  }
  if (targetState === 'scheduled') {
    throw new ContentWorkspaceError(
      'CONTENT_PUBLICATION_CONFIRMATION_REQUIRED',
      'A private Content work block does not schedule publication. Use a future dedicated publication confirmation flow.',
      409,
      {
        publicationExecution: 'not_performed',
        recovery: 'schedule_content_work_or_confirm_publication_separately',
      },
    );
  }
  if (!['review', 'approved'].includes(targetState)) return;
  const artifactId = item.currentArtifactId;
  const artifact = artifactId == null ? null : getContentArtifact(scope, artifactId, db);
  if (!artifact?.currentRevision) {
    throw new ContentWorkspaceError(
      'CONTENT_STATE_REQUIRES_SAVED_REVISION',
      'Save a content revision before review, approval, scheduling, or publication tracking.',
      409,
      { itemId: item.id, targetState },
    );
  }
  const policyRevision = artifact.currentRevision;
  if (!policyRevision || policyRevision.artifactId !== artifact.id) {
    throw new ContentWorkspaceError(
      'CONTENT_STATE_REQUIRES_SAVED_REVISION',
      'The current content version is no longer readable.',
      409,
      { recovery: 'save_content_revision' },
    );
  }
  if (targetState === 'approved') {
    const policy = getContentRevisionClaimPolicy(scope, policyRevision.id, db);
    if (policy.status === 'not_recorded' && revisionRequiresLineageReview(scope, policyRevision, db)) {
      throw new ContentWorkspaceError(
        'CONTENT_LINEAGE_REVIEW_REQUIRED',
        'Review sources and claims for AI-generated, imported, restored, or derived content before approval, scheduling, or publication tracking.',
        409,
        {
          reasonCodes: ['CONTENT_LINEAGE_NOT_RECORDED'],
          recovery: 'record_current_revision_lineage',
        },
      );
    }
    if (policy.blocksApproval) {
      throw new ContentWorkspaceError(
        'CONTENT_CLAIM_SAFETY_BLOCKED',
        'Resolve unsupported sensitive claims before approval, scheduling, or publication tracking.',
        409,
        {
          revisionId: policyRevision.id,
          reasonCodes: policy.blockCodes,
          claimIds: policy.unsupportedClaimIds,
          recovery: 'review_sources_or_revise_claims',
        },
      );
    }
  }
}

/**
 * The revision actor records who performed the latest edit; it is not proof
 * that all inherited bytes are user-authored. Follow immutable ancestry and
 * server-authored copy/restore provenance so a cosmetic user edit cannot
 * launder an unreviewed agent or import revision into an approvable draft.
 */
function revisionRequiresLineageReview(
  scope: ContentWorkspaceScope,
  revision: ContentRevision,
  db: Database.Database,
  visited: Set<number> = new Set(),
): boolean {
  if (revision.actorType !== 'user') return true;
  if (visited.has(revision.id) || visited.size >= 200) return true;
  visited.add(revision.id);

  const inheritedIds = new Set<number>();
  if (revision.parentRevisionId != null) inheritedIds.add(revision.parentRevisionId);
  if (revision.restoredFromRevisionId != null) inheritedIds.add(revision.restoredFromRevisionId);
  const provenanceSource = revision.provenance.sourceRevisionId;
  if (typeof provenanceSource === 'number' && Number.isSafeInteger(provenanceSource) && provenanceSource > 0) {
    inheritedIds.add(provenanceSource);
  } else if (typeof provenanceSource === 'string' && /^\d+$/u.test(provenanceSource)) {
    inheritedIds.add(Number(provenanceSource));
  }

  for (const inheritedId of inheritedIds) {
    const inherited = getContentRevision(scope, inheritedId, db);
    // An immutable ancestry pointer that cannot be resolved inside the same
    // private tenant/user scope is an integrity problem, never a trust pass.
    if (!inherited || revisionRequiresLineageReview(scope, inherited, db, visited)) return true;
  }

  // Compatibility defense for older iOS builds that used the generic
  // artifact endpoint for generator output. New clients use the dedicated
  // generated-content capture contract, which stamps the revision as agent.
  const artifact = getContentArtifact(scope, revision.artifactId, db);
  return artifact?.metadata.origin === 'ios_script_generator';
}

function getReceipt(
  db: Database.Database,
  scope: ContentWorkspaceScope,
  operation: string,
  idempotencyKey: string,
  requestHash: string,
): { resourceId: string; metadata: Record<string, unknown> } | null {
  const row = db.prepare(`
    SELECT request_hash, resource_id, result_metadata_json
      FROM content_mutation_receipts
     WHERE tenant_id = ? AND owner_user_id = ?
       AND operation = ? AND idempotency_key = ?
     LIMIT 1
  `).get(scope.tenantId, scope.userId, operation, idempotencyKey) as MutationReceiptRow | undefined;
  if (!row) return null;
  if (row.request_hash !== requestHash) {
    throw new ContentWorkspaceError(
      'CONTENT_IDEMPOTENCY_KEY_REUSED',
      'This idempotency key was already used for a different request.',
      409,
      { operation },
    );
  }
  return { resourceId: row.resource_id, metadata: parseRecord(row.result_metadata_json) };
}

function putReceipt(
  db: Database.Database,
  scope: ContentWorkspaceScope,
  operation: string,
  idempotencyKey: string,
  requestHash: string,
  resourceType: string,
  resourceId: number,
  metadata: Record<string, unknown>,
): void {
  db.prepare(`
    INSERT INTO content_mutation_receipts (
      tenant_id, owner_user_id, operation, idempotency_key,
      request_hash, resource_type, resource_id, result_metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    scope.tenantId,
    scope.userId,
    operation,
    idempotencyKey,
    requestHash,
    resourceType,
    String(resourceId),
    stableJson(metadata),
  );
}

function writeWorkspaceEvent(
  db: Database.Database,
  scope: ContentWorkspaceScope,
  itemType: ContentWorkspaceItemType,
  itemId: number,
  action: string,
  fromState: string | null,
  toState: string | null,
  metadata: Record<string, unknown>,
  reasonCodes: string[] | undefined = undefined,
): void {
  const approvalState = toState === 'review' ? 'required' : toState === 'approved' ? 'approved' : 'not_required';
  const reviewRequired = toState === 'review';
  const storedReasonCodes = reasonCodes ?? (reviewRequired ? ['human_review_required'] : []);
  db.prepare(`
    INSERT INTO content_workflow_events (
      tenant_id, owner_user_id, visibility_scope, scope_status,
      object_type, object_id, action, from_state, to_state,
      approval_state, review_required, reason_codes_json,
      actor_user_id, metadata_json
    ) VALUES (?, ?, 'user_private', 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    scope.tenantId,
    scope.userId,
    itemType,
    String(itemId),
    action,
    fromState,
    toState,
    approvalState,
    reviewRequired ? 1 : 0,
    stableJson(storedReasonCodes),
    scope.userId,
    stableJson(metadata),
  );
}

function mapItem(
  row: WorkspaceItemRow,
  tags: ContentTag[] = [],
  workSchedule: ContentWorkScheduleSummary | null = null,
): ContentWorkspaceItem {
  const itemType = requireEnum(row.object_type, CONTENT_WORKSPACE_ITEM_TYPES, 'stored itemType');
  const productionState = requireEnum(row.production_state, CONTENT_PRODUCTION_STATES, 'stored productionState');
  const artifactPhase = requireEnum(row.artifact_phase, CONTENT_ARTIFACT_PHASES, 'stored artifactPhase');
  const reviewReasonCodes = parseStoredStringArray(row.review_reason_codes_json);
  return {
    id: Number(row.id),
    itemType,
    title: row.title,
    summary: row.summary ?? null,
    productionState,
    artifactPhase,
    priority: Number(row.workspace_priority),
    deadlineAt: row.deadline_at ?? null,
    favorite: row.is_favorite === 1,
    platformId: row.platform_id ?? null,
    formatId: row.format_id ?? null,
    currentArtifactId: row.current_artifact_id == null ? null : Number(row.current_artifact_id),
    workflowVersion: Number(row.workflow_version),
    workSchedule,
    nextAction: deriveNextAction(itemType, productionState, artifactPhase, workSchedule, reviewReasonCodes),
    tags,
    artifactCount: Number(row.artifact_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTag(row: ContentTagRow): ContentTag {
  return {
    id: Number(row.id),
    name: row.display_name,
    normalizedName: row.normalized_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapArtifact(row: ArtifactRow): ContentArtifact {
  if (row.current_revision_id != null && row.revision_id == null) {
    throw new ContentWorkspaceError(
      'CONTENT_REVISION_INTEGRITY_FAILED',
      'The artifact revision pointer is invalid. No content was returned as empty.',
      500,
      { artifactId: Number(row.id) },
    );
  }
  if (row.revision_id != null && Number(row.revision_number) !== Number(row.revision_count)) {
    throw new ContentWorkspaceError(
      'CONTENT_REVISION_INTEGRITY_FAILED',
      'The artifact revision sequence is inconsistent.',
      500,
      { artifactId: Number(row.id) },
    );
  }
  return {
    id: Number(row.id),
    itemId: Number(row.item_id),
    artifactType: requireEnum(row.artifact_type, CONTENT_ARTIFACT_TYPES, 'stored artifactType'),
    title: row.title ?? null,
    platformId: row.platform_id ?? null,
    formatId: row.format_id ?? null,
    revisionCount: Number(row.revision_count),
    currentRevisionId: row.current_revision_id == null ? null : Number(row.current_revision_id),
    currentRevision: row.revision_id == null ? null : mapRevision({
      id: row.revision_id,
      artifact_id: row.id,
      revision_number: row.revision_number!,
      parent_revision_id: row.parent_revision_id,
      restored_from_revision_id: row.restored_from_revision_id,
      content_format: row.content_format!,
      content_text: row.content_text,
      structured_content_json: row.structured_content_json,
      content_hash: row.content_hash!,
      change_summary: row.change_summary,
      change_reason: row.change_reason,
      actor_type: row.actor_type!,
      actor_id: row.actor_id,
      provenance_json: row.provenance_json,
      created_at: row.revision_created_at!,
    }),
    metadata: parseRecord(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRevision(row: RevisionRow): ContentRevision {
  const format = requireEnum(row.content_format, ['plain_text', 'markdown', 'structured_json'] as const, 'stored contentFormat');
  const content: ContentRevisionContent = format === 'structured_json'
    ? { format, document: parseStructuredDocument(row.structured_content_json, Number(row.id)) }
    : { format, text: row.content_text ?? '' };
  if (hashRevisionContent(content) !== row.content_hash) {
    throw new ContentWorkspaceError(
      'CONTENT_REVISION_INTEGRITY_FAILED',
      'The stored revision failed its integrity check.',
      500,
      { revisionId: Number(row.id), artifactId: Number(row.artifact_id) },
    );
  }
  return {
    id: Number(row.id),
    artifactId: Number(row.artifact_id),
    revisionNumber: Number(row.revision_number),
    parentRevisionId: row.parent_revision_id == null ? null : Number(row.parent_revision_id),
    restoredFromRevisionId: row.restored_from_revision_id == null ? null : Number(row.restored_from_revision_id),
    content,
    contentHash: row.content_hash,
    changeSummary: row.change_summary ?? null,
    changeReason: row.change_reason ?? null,
    actorType: requireEnum(row.actor_type, ['user', 'agent', 'system', 'import'] as const, 'stored actorType'),
    actorId: row.actor_id ?? null,
    provenance: parseRecord(row.provenance_json),
    createdAt: row.created_at,
  };
}

function mapRelationship(row: RelationshipRow): ContentItemRelationship {
  return {
    id: Number(row.id),
    fromItemId: Number(row.from_item_id),
    toItemId: Number(row.to_item_id),
    relationshipType: requireEnum(row.relationship_type, CONTENT_RELATIONSHIP_TYPES, 'stored relationshipType'),
    position: row.position == null ? null : Number(row.position),
    metadata: parseRecord(row.metadata_json),
    createdAt: row.created_at,
  };
}

function mapArtifactRelationship(row: ArtifactRelationshipRow): ContentArtifactRelationship {
  return {
    id: Number(row.id),
    fromArtifactId: Number(row.from_artifact_id),
    toArtifactId: Number(row.to_artifact_id),
    relationshipType: requireEnum(
      row.relationship_type,
      ['variant_of', 'derived_from', 'remix_of'] as const,
      'stored artifact relationshipType',
    ),
    metadata: parseRecord(row.metadata_json),
    createdAt: row.created_at,
  };
}

function deriveNextAction(
  itemType: ContentWorkspaceItemType,
  productionState: ContentProductionState,
  artifactPhase: ContentArtifactPhase,
  workSchedule: ContentWorkScheduleSummary | null = null,
  reviewReasonCodes: string[] = [],
): ContentNextAction {
  if (workSchedule?.state === 'cancel_failed') {
    return {
      action: 'cancel_work_schedule',
      label: 'Retry work-block cancellation',
      reason: 'The previous cancellation did not complete. Retry it before scheduling another work block.',
    };
  }
  if (workSchedule?.state === 'cancel_pending') {
    return {
      action: 'view_work_schedule',
      label: 'View cancellation status',
      reason: 'The work block is being removed. Check its status before scheduling another one.',
    };
  }
  if (workSchedule && (
    workSchedule.state === 'sync_failed'
    || workSchedule.state === 'stale'
    || workSchedule.authorityStatus === 'unavailable'
  )) {
    return {
      action: 'recover_work_schedule',
      label: 'Recover work block',
      reason: 'The saved work block needs attention before its calendar state can be trusted.',
    };
  }
  if (
    workSchedule
    && ['scheduled', 'provider_synced'].includes(workSchedule.state)
    && workSchedule.contentChangedSinceScheduling
  ) {
    return {
      action: 'view_work_schedule',
      label: 'Review scheduled version',
      reason: 'The content changed after this work block was scheduled. Review the linked version before starting.',
    };
  }
  if (workSchedule && ['scheduled', 'provider_synced'].includes(workSchedule.state)) {
    return {
      action: 'prepare_scheduled_work',
      label: 'Prepare for work block',
      reason: 'A private work block is confirmed. Prepare the saved version for that session.',
    };
  }
  if (productionState === 'active' && reviewReasonCodes.includes('changes_requested')) {
    return {
      action: 'revise_content',
      label: 'Revise requested changes',
      reason: 'A review requested changes. Revise the saved content before resubmitting it.',
    };
  }
  if (productionState === 'review') {
    return { action: 'review_content', label: 'Review content', reason: 'This item is waiting for a human review decision.' };
  }
  if (productionState === 'approved') {
    return {
      action: 'schedule_work',
      label: 'Reserve work time',
      reason: 'The approved item is ready for a private writing, recording, or editing block.',
    };
  }
  if (productionState === 'scheduled') {
    return { action: 'prepare_publish', label: 'Prepare to publish', reason: 'Complete production checks before the scheduled time.' };
  }
  if (productionState === 'published') {
    return { action: 'repurpose_content', label: 'Create a new version', reason: 'Reuse the published work for another format or platform.' };
  }
  if (productionState === 'archived' || productionState === 'rejected') {
    return { action: 'restore_to_inbox', label: 'Return to inbox', reason: 'Restore this item before continuing work.' };
  }
  if (itemType === 'project') {
    return { action: 'add_content_item', label: 'Add content', reason: 'Capture or connect the next content item for this project.' };
  }
  if (artifactPhase === 'idea') {
    return { action: 'develop_brief', label: 'Develop a brief', reason: 'Clarify the objective, audience, and promise.' };
  }
  if (artifactPhase === 'brief') {
    return { action: 'create_outline', label: 'Create an outline', reason: 'Turn the approved direction into a clear structure.' };
  }
  if (artifactPhase === 'outline') {
    return { action: 'draft_content', label: 'Draft the content', reason: 'Expand the outline into an editable draft.' };
  }
  if (artifactPhase === 'draft' || artifactPhase === 'final') {
    return { action: 'submit_for_review', label: 'Submit for review', reason: 'Review the current draft before approval or scheduling.' };
  }
  return { action: 'none', label: 'No next action', reason: 'No workspace action is available.' };
}

function phaseForArtifactType(type: ContentArtifactType): ContentArtifactPhase {
  switch (type) {
    case 'brief': return 'brief';
    case 'outline':
    case 'shot_list': return 'outline';
    case 'script':
    case 'caption':
    case 'platform_variant':
    case 'other': return 'draft';
    case 'idea_note':
    case 'research_notes': return 'idea';
  }
}

/**
 * Every child-content mutation advances the item's review version. Previously
 * revision saves did not touch workflow_version and silently selected the
 * edited artifact, so a stale review could approve unseen bytes and editing an
 * older artifact could replace the user's current draft. Selection is now
 * explicit, CAS-protected, and any prior approval is conservatively revoked.
 */
function advanceItemAfterContentMutation(
  db: Database.Database,
  scope: ContentWorkspaceScope,
  item: ContentWorkspaceItem,
  input: {
    expectedWorkflowVersion: number;
    now: string;
    selectedArtifactId: number | null;
    selectedArtifactPhase: ContentArtifactPhase;
    activateFromInbox: boolean;
  },
): { productionState: ContentProductionState; approvalInvalidated: boolean } {
  const approvalInvalidated = ['approved', 'scheduled', 'published'].includes(item.productionState);
  const productionState: ContentProductionState = approvalInvalidated
    ? 'review'
    : item.productionState === 'inbox' && input.activateFromInbox
      ? 'active'
      : item.productionState;
  const artifactPhase = approvalInvalidated && input.selectedArtifactPhase === 'final'
    ? 'draft'
    : input.selectedArtifactPhase;
  const clearsRequestedChanges = !approvalInvalidated && item.productionState === 'active';
  const update = db.prepare(`
    UPDATE content_domain_objects
       SET current_artifact_id = ?,
           artifact_phase = ?,
           production_state = ?,
           lifecycle_state = ?,
           editorial_state = ?,
           approval_state = CASE WHEN ? THEN 'required' ELSE approval_state END,
           review_required = CASE WHEN ? THEN 1 ELSE review_required END,
           review_reason_codes_json = CASE
             WHEN ? THEN json_array('content_changed_after_approval')
             WHEN ? THEN json_array()
             ELSE review_reason_codes_json
           END,
           approved_by = CASE WHEN ? THEN NULL ELSE approved_by END,
           approved_at = CASE WHEN ? THEN NULL ELSE approved_at END,
           updated_by = ?,
           updated_at = ?,
           workflow_version = workflow_version + 1
     WHERE id = ? AND ${ITEM_SCOPE_SQL}
       AND workflow_version = ?
  `).run(
    input.selectedArtifactId,
    artifactPhase,
    productionState,
    productionState,
    editorialStateFor(productionState, artifactPhase),
    approvalInvalidated ? 1 : 0,
    approvalInvalidated ? 1 : 0,
    approvalInvalidated ? 1 : 0,
    clearsRequestedChanges ? 1 : 0,
    approvalInvalidated ? 1 : 0,
    approvalInvalidated ? 1 : 0,
    scope.userId,
    input.now,
    item.id,
    scope.tenantId,
    scope.userId,
    input.expectedWorkflowVersion,
  );
  if (update.changes !== 1) {
    throw workflowConflict(requireWorkspaceItem(scope, item.id, db), input.expectedWorkflowVersion);
  }
  return { productionState, approvalInvalidated };
}

function editorialStateFor(state: ContentProductionState, phase: ContentArtifactPhase): string {
  if (state === 'review') return 'reviewed';
  if (state === 'approved') return 'approved';
  if (state === 'scheduled') return 'scheduled';
  if (state === 'published') return 'published';
  if (state === 'archived') return 'archived';
  if (state === 'rejected') return 'rejected';
  if (phase === 'outline') return 'outlined';
  if (phase === 'draft' || phase === 'final') return 'drafted';
  return 'idea';
}

function workflowConflict(item: ContentWorkspaceItem, supplied: number): ContentWorkspaceError {
  return new ContentWorkspaceError('CONTENT_WORKFLOW_VERSION_CONFLICT', 'This item changed after it was loaded.', 409, {
    suppliedWorkflowVersion: supplied,
    currentWorkflowVersion: item.workflowVersion,
    currentProductionState: item.productionState,
    recovery: 'reload_and_retry',
  });
}

function normalizeScope(scope: ContentWorkspaceScope): ContentWorkspaceScope {
  if (!scope || !Number.isInteger(scope.tenantId) || scope.tenantId <= 0 || !Number.isInteger(scope.userId) || scope.userId <= 0) {
    throw new ContentWorkspaceError('CONTENT_SCOPE_REQUIRED', 'A valid tenant and user scope is required.', 401);
  }
  return { tenantId: scope.tenantId, userId: scope.userId };
}

function normalizeIdempotencyKey(value: string): string {
  const key = requireText(value, 'idempotencyKey', 200);
  if (key.length < 8) {
    throw new ContentWorkspaceError('CONTENT_VALIDATION_FAILED', 'idempotencyKey must contain at least 8 characters.', 400, {
      field: 'idempotencyKey',
    });
  }
  return key;
}

function normalizePriority(value: number | undefined): number {
  if (value === undefined) return 3;
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw new ContentWorkspaceError('CONTENT_VALIDATION_FAILED', 'priority must be an integer from 1 to 5.', 400, { field: 'priority' });
  }
  return value;
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return 50;
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    throw new ContentWorkspaceError('CONTENT_VALIDATION_FAILED', 'limit must be an integer from 1 to 200.', 400, { field: 'limit' });
  }
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ContentWorkspaceError('CONTENT_VALIDATION_FAILED', `${field} must be a boolean.`, 400, { field });
  }
  return value;
}

function normalizeOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  return requireBoolean(value, field);
}

function normalizeTagName(value: unknown): { display: string; normalized: string } {
  if (typeof value !== 'string') {
    throw new ContentWorkspaceError('CONTENT_VALIDATION_FAILED', 'tag name is required.', 400, { field: 'name' });
  }
  const display = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (display.length === 0 || display.length > 80 || /[\u0000-\u001F\u007F]/u.test(display)) {
    throw new ContentWorkspaceError('CONTENT_VALIDATION_FAILED', 'tag name must contain 1 to 80 visible characters.', 400, {
      field: 'name',
    });
  }
  return { display, normalized: display.toLowerCase() };
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}

type LibraryCursorSort = ContentWorkspaceSort | 'trash_deleted_desc';

interface LibraryCursorKey {
  id: number;
  value: string | number;
  auxiliary?: string;
}

interface LibraryCursor {
  version: 2;
  queryHash: string;
  sort: LibraryCursorSort;
  snapshotAt: string;
  snapshotMaxId: number;
  key: LibraryCursorKey;
}

function encodeLibraryCursor(cursor: LibraryCursor): string {
  return Buffer.from(stableJson(cursor), 'utf8').toString('base64url');
}

function decodeLibraryCursor(
  value: string | undefined,
  queryHash: string,
  sort: LibraryCursorSort,
): LibraryCursor | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_000 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw invalidCursorError();
  }
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (
      decoded.version !== 2
      || decoded.queryHash !== queryHash
      || decoded.sort !== sort
      || typeof decoded.snapshotAt !== 'string'
      || Number.isNaN(new Date(decoded.snapshotAt).getTime())
      || !Number.isSafeInteger(decoded.snapshotMaxId)
      || Number(decoded.snapshotMaxId) < 0
      || !decoded.key
      || typeof decoded.key !== 'object'
      || Array.isArray(decoded.key)
    ) {
      throw invalidCursorError();
    }
    const key = validateLibraryCursorKey(sort, decoded.key as Record<string, unknown>);
    return {
      version: 2,
      queryHash,
      sort,
      snapshotAt: decoded.snapshotAt,
      snapshotMaxId: Number(decoded.snapshotMaxId),
      key,
    };
  } catch (error) {
    if (error instanceof ContentWorkspaceError) throw error;
    throw invalidCursorError();
  }
}

function createLibrarySnapshot(
  scope: ContentWorkspaceScope,
  queryHash: string,
  sort: LibraryCursorSort,
  db: Database.Database,
): Omit<LibraryCursor, 'key'> {
  const row = db.prepare(`
    SELECT COALESCE(MAX(id), 0) AS max_id
      FROM content_domain_objects
     WHERE tenant_id = ? AND owner_user_id = ?
       AND visibility_scope = 'user_private'
       AND object_type IN ('content_item', 'project')
  `).get(scope.tenantId, scope.userId) as { max_id: number };
  return {
    version: 2,
    queryHash,
    sort,
    snapshotAt: new Date().toISOString(),
    snapshotMaxId: Number(row.max_id),
  };
}

function libraryCursorKey(sort: LibraryCursorSort, row: WorkspaceItemRow): LibraryCursorKey {
  const id = Number(row.id);
  switch (sort) {
    case 'updated_desc':
      return { id, value: row.updated_at };
    case 'created_desc':
      return { id, value: row.created_at };
    case 'title_asc':
      return { id, value: row.title };
    case 'deadline_asc':
      return { id, value: row.deadline_at == null ? 1 : 0, auxiliary: row.deadline_at ?? '' };
    case 'priority_asc':
    case 'priority_desc':
      return { id, value: Number(row.workspace_priority), auxiliary: row.updated_at };
    case 'trash_deleted_desc':
      if (!row.deleted_at) throw invalidCursorError();
      return { id, value: row.deleted_at };
  }
}

function validateLibraryCursorKey(sort: LibraryCursorSort, value: Record<string, unknown>): LibraryCursorKey {
  if (!Number.isSafeInteger(value.id) || Number(value.id) <= 0) throw invalidCursorError();
  const id = Number(value.id);
  if (sort === 'deadline_asc') {
    if ((value.value !== 0 && value.value !== 1) || typeof value.auxiliary !== 'string') throw invalidCursorError();
    return { id, value: Number(value.value), auxiliary: value.auxiliary };
  }
  if (sort === 'priority_asc' || sort === 'priority_desc') {
    if (!Number.isInteger(value.value) || Number(value.value) < 1 || Number(value.value) > 5 || typeof value.auxiliary !== 'string') {
      throw invalidCursorError();
    }
    return { id, value: Number(value.value), auxiliary: value.auxiliary };
  }
  if (typeof value.value !== 'string' || value.value.length > 10_000) throw invalidCursorError();
  return { id, value: value.value };
}

function libraryContinuationPredicate(
  sort: LibraryCursorSort,
  key: LibraryCursorKey,
): { sql: string; params: unknown[] } {
  switch (sort) {
    case 'updated_desc':
      return {
        sql: '(o.updated_at < ? OR (o.updated_at = ? AND o.id < ?))',
        params: [key.value, key.value, key.id],
      };
    case 'created_desc':
      return {
        sql: '(o.created_at < ? OR (o.created_at = ? AND o.id < ?))',
        params: [key.value, key.value, key.id],
      };
    case 'title_asc':
      return {
        sql: '(o.title COLLATE NOCASE > ? COLLATE NOCASE OR (o.title COLLATE NOCASE = ? COLLATE NOCASE AND o.id > ?))',
        params: [key.value, key.value, key.id],
      };
    case 'deadline_asc': {
      const nullRank = key.value;
      const deadline = key.auxiliary ?? '';
      return {
        sql: `(
          CASE WHEN o.deadline_at IS NULL THEN 1 ELSE 0 END > ?
          OR (
            CASE WHEN o.deadline_at IS NULL THEN 1 ELSE 0 END = ?
            AND (
              COALESCE(o.deadline_at, '') > ?
              OR (COALESCE(o.deadline_at, '') = ? AND o.id > ?)
            )
          )
        )`,
        params: [nullRank, nullRank, deadline, deadline, key.id],
      };
    }
    case 'priority_asc':
      return {
        sql: `(
          o.workspace_priority > ?
          OR (o.workspace_priority = ? AND (
            o.updated_at < ? OR (o.updated_at = ? AND o.id < ?)
          ))
        )`,
        params: [key.value, key.value, key.auxiliary, key.auxiliary, key.id],
      };
    case 'priority_desc':
      return {
        sql: `(
          o.workspace_priority < ?
          OR (o.workspace_priority = ? AND (
            o.updated_at < ? OR (o.updated_at = ? AND o.id < ?)
          ))
        )`,
        params: [key.value, key.value, key.auxiliary, key.auxiliary, key.id],
      };
    case 'trash_deleted_desc':
      return {
        sql: '(o.deleted_at < ? OR (o.deleted_at = ? AND o.id < ?))',
        params: [key.value, key.value, key.id],
      };
  }
}

function invalidCursorError(): ContentWorkspaceError {
  return new ContentWorkspaceError(
    'CONTENT_CURSOR_INVALID',
    'The library cursor is invalid or belongs to a different filter.',
    400,
    { field: 'cursor', recovery: 'restart_pagination' },
  );
}

function encodeRevisionCursor(artifactId: number, revisionNumber: number, id: number): string {
  return Buffer.from(stableJson({
    version: 1,
    artifactId,
    revisionNumber,
    id,
  }), 'utf8').toString('base64url');
}

function decodeRevisionCursor(
  value: string | undefined,
  artifactId: number,
): { revisionNumber: number; id: number } | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 500 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw invalidRevisionCursorError();
  }
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (
      decoded.version !== 1
      || decoded.artifactId !== artifactId
      || !Number.isSafeInteger(decoded.revisionNumber)
      || Number(decoded.revisionNumber) <= 0
      || !Number.isSafeInteger(decoded.id)
      || Number(decoded.id) <= 0
    ) {
      throw invalidRevisionCursorError();
    }
    return { revisionNumber: Number(decoded.revisionNumber), id: Number(decoded.id) };
  } catch (error) {
    if (error instanceof ContentWorkspaceError) throw error;
    throw invalidRevisionCursorError();
  }
}

function invalidRevisionCursorError(): ContentWorkspaceError {
  return new ContentWorkspaceError(
    'CONTENT_REVISION_CURSOR_INVALID',
    'The revision-history cursor is invalid or belongs to another artifact.',
    400,
    { field: 'cursor', recovery: 'restart_revision_pagination' },
  );
}

function deletionFromReceipt(
  receipt: { resourceId: string; metadata: Record<string, unknown> },
  expectedItemId: number,
): ContentWorkspaceDeletion {
  const itemId = Number(receipt.resourceId);
  const workflowVersion = receipt.metadata.workflowVersion;
  const deletedAt = receipt.metadata.deletedAt;
  if (
    itemId !== expectedItemId
    || !Number.isInteger(workflowVersion)
    || Number(workflowVersion) <= 0
    || typeof deletedAt !== 'string'
    || Number.isNaN(new Date(deletedAt).getTime())
    || receipt.metadata.recoverable !== true
  ) {
    throw inconsistentReceiptError();
  }
  return {
    itemId,
    workflowVersion: Number(workflowVersion),
    deletedAt,
    recoverable: true,
    nextAction: deletedItemNextAction(),
  };
}

function relationshipRemovalFromReceipt(
  receipt: { resourceId: string; metadata: Record<string, unknown> },
  expectedRelationshipId: number,
): ContentRelationshipRemoval {
  const value = receipt.metadata.removal;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw inconsistentReceiptError();
  const record = value as Record<string, unknown>;
  const relationshipId = Number(record.relationshipId);
  const fromItemId = Number(record.fromItemId);
  const toItemId = Number(record.toItemId);
  const relationshipType = record.relationshipType;
  const removedAt = record.removedAt;
  if (
    Number(receipt.resourceId) !== expectedRelationshipId
    || relationshipId !== expectedRelationshipId
    || !Number.isInteger(fromItemId)
    || fromItemId <= 0
    || !Number.isInteger(toItemId)
    || toItemId <= 0
    || typeof relationshipType !== 'string'
    || !CONTENT_RELATIONSHIP_TYPES.includes(relationshipType as ContentRelationshipType)
    || typeof removedAt !== 'string'
    || Number.isNaN(new Date(removedAt).getTime())
  ) {
    throw inconsistentReceiptError();
  }
  return {
    relationshipId,
    fromItemId,
    toItemId,
    relationshipType: relationshipType as ContentRelationshipType,
    removedAt,
  };
}

function relationshipFromReceipt(
  receipt: { resourceId: string; metadata: Record<string, unknown> },
  expectedRelationshipId: number,
): ContentItemRelationship {
  const relationship = parseRelationshipSnapshot(receipt.metadata.relationship);
  if (Number(receipt.resourceId) !== expectedRelationshipId || relationship.id !== expectedRelationshipId) {
    throw inconsistentReceiptError();
  }
  return relationship;
}

function copyReceiptSnapshot(copy: ContentWorkspaceCopy): Record<string, unknown> {
  return {
    mode: copy.mode,
    sourceItemId: copy.sourceItemId,
    sourceWorkflowVersion: copy.sourceWorkflowVersion,
    relationship: copy.relationship,
    artifactMappings: copy.artifactMappings,
    copiedAt: copy.copiedAt,
  };
}

function workspaceCopyFromReceipt(
  scope: ContentWorkspaceScope,
  receipt: { resourceId: string; metadata: Record<string, unknown> },
  expectedSourceItemId: number,
  expectedMode: ContentWorkspaceCopyMode,
  db: Database.Database,
): ContentWorkspaceCopy {
  const itemId = Number(receipt.resourceId);
  const item = Number.isInteger(itemId) && itemId > 0
    ? getContentWorkspaceItemDetail(scope, itemId, db)
    : null;
  const rawCopy = receipt.metadata.copy;
  if (!item || !rawCopy || typeof rawCopy !== 'object' || Array.isArray(rawCopy)) {
    throw inconsistentReceiptError();
  }
  const record = rawCopy as Record<string, unknown>;
  const mode = record.mode;
  const sourceItemId = Number(record.sourceItemId);
  const sourceWorkflowVersion = Number(record.sourceWorkflowVersion);
  const copiedAt = record.copiedAt;
  const relationship = parseRelationshipSnapshot(record.relationship);
  const artifactMappings = parseArtifactCopyMappings(record.artifactMappings);
  if (
    mode !== expectedMode
    || sourceItemId !== expectedSourceItemId
    || !Number.isInteger(sourceWorkflowVersion)
    || sourceWorkflowVersion <= 0
    || typeof copiedAt !== 'string'
    || Number.isNaN(new Date(copiedAt).getTime())
    || relationship.fromItemId !== item.id
    || relationship.toItemId !== sourceItemId
    || relationship.relationshipType !== (mode === 'remix' ? 'remix_of' : 'derived_from')
  ) {
    throw inconsistentReceiptError();
  }
  const copiedArtifactIds = new Set(item.artifacts.map((artifact) => artifact.id));
  if (artifactMappings.some((mapping) => !copiedArtifactIds.has(mapping.copiedArtifactId))) {
    throw inconsistentReceiptError();
  }
  return {
    mode: mode as ContentWorkspaceCopyMode,
    sourceItemId,
    sourceWorkflowVersion,
    item,
    relationship,
    artifactMappings,
    copiedAt,
  };
}

function parseRelationshipSnapshot(value: unknown): ContentItemRelationship {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw inconsistentReceiptError();
  const record = value as Record<string, unknown>;
  const id = Number(record.id);
  const fromItemId = Number(record.fromItemId);
  const toItemId = Number(record.toItemId);
  const relationshipType = record.relationshipType;
  const position = record.position == null ? null : Number(record.position);
  const metadata = record.metadata;
  const createdAt = record.createdAt;
  if (
    !Number.isInteger(id)
    || id <= 0
    || !Number.isInteger(fromItemId)
    || fromItemId <= 0
    || !Number.isInteger(toItemId)
    || toItemId <= 0
    || typeof relationshipType !== 'string'
    || !CONTENT_RELATIONSHIP_TYPES.includes(relationshipType as ContentRelationshipType)
    || (position !== null && (!Number.isInteger(position) || position < 0))
    || !metadata
    || typeof metadata !== 'object'
    || Array.isArray(metadata)
    || typeof createdAt !== 'string'
  ) {
    throw inconsistentReceiptError();
  }
  return {
    id,
    fromItemId,
    toItemId,
    relationshipType: relationshipType as ContentRelationshipType,
    position,
    metadata: metadata as Record<string, unknown>,
    createdAt,
  };
}

function parseArtifactCopyMappings(value: unknown): ContentArtifactCopyMapping[] {
  if (!Array.isArray(value) || value.length > 200) throw inconsistentReceiptError();
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw inconsistentReceiptError();
    const record = candidate as Record<string, unknown>;
    const sourceArtifactId = Number(record.sourceArtifactId);
    const sourceRevisionId = record.sourceRevisionId == null ? null : Number(record.sourceRevisionId);
    const copiedArtifactId = Number(record.copiedArtifactId);
    const copiedRevisionId = record.copiedRevisionId == null ? null : Number(record.copiedRevisionId);
    const contentHash = record.contentHash == null ? null : String(record.contentHash);
    if (
      !Number.isInteger(sourceArtifactId)
      || sourceArtifactId <= 0
      || !Number.isInteger(copiedArtifactId)
      || copiedArtifactId <= 0
      || (sourceRevisionId !== null && (!Number.isInteger(sourceRevisionId) || sourceRevisionId <= 0))
      || (copiedRevisionId !== null && (!Number.isInteger(copiedRevisionId) || copiedRevisionId <= 0))
      || (contentHash !== null && !/^[a-f0-9]{64}$/u.test(contentHash))
      || (sourceRevisionId === null) !== (copiedRevisionId === null)
      || (sourceRevisionId === null) !== (contentHash === null)
    ) {
      throw inconsistentReceiptError();
    }
    return { sourceArtifactId, sourceRevisionId, copiedArtifactId, copiedRevisionId, contentHash };
  });
}

function defaultCopyTitle(sourceTitle: string, mode: ContentWorkspaceCopyMode): string {
  const suffix = mode === 'remix' ? ' (remix)' : ' (copy)';
  return `${sourceTitle.slice(0, 240 - suffix.length).trimEnd()}${suffix}`;
}

/**
 * A duplicate/remix copies the exact current revision bytes, so its immutable
 * evidence snapshot must travel with those bytes. References remain private
 * registry records; only the revision-scoped provenance and source links are
 * copied, with an audit marker pointing at the source revision.
 */
function copyRevisionLineageSnapshot(
  db: Database.Database,
  scope: ContentWorkspaceScope,
  sourceRevisionId: number,
  copiedRevisionId: number,
  copiedAt: string,
  mode: ContentWorkspaceCopyMode,
): boolean {
  const source = db.prepare(`
    SELECT *
      FROM content_output_provenance
     WHERE tenant_id = ? AND owner_user_id = ?
       AND visibility_scope = 'user_private' AND scope_status = 'active'
       AND output_object_type = 'content_revision' AND output_id = ?
     LIMIT 1
  `).get(scope.tenantId, scope.userId, String(sourceRevisionId)) as Record<string, unknown> | undefined;
  if (!source) return false;

  db.prepare(`
    INSERT INTO content_output_provenance (
      tenant_id, owner_user_id, visibility_scope, scope_status,
      output_object_type, output_id, grounding_status, references_used_json,
      claims_json, unsupported_claims_json, source_summaries_json,
      generated_from_radar_signal_id, reused_from_content_id,
      provenance_status, review_required, created_by, updated_by,
      audit_metadata_json, created_at, updated_at
    ) VALUES (?, ?, 'user_private', 'active', 'content_revision', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    scope.tenantId,
    scope.userId,
    String(copiedRevisionId),
    source.grounding_status,
    source.references_used_json,
    source.claims_json,
    source.unsupported_claims_json,
    source.source_summaries_json,
    source.generated_from_radar_signal_id ?? null,
    source.reused_from_content_id ?? null,
    source.provenance_status,
    source.review_required,
    scope.userId,
    scope.userId,
    stableJson({
      source: 'content_workspace_copy',
      mode,
      sourceRevisionId,
      lineageSnapshotCopied: true,
    }),
    copiedAt,
    copiedAt,
  );

  const links = db.prepare(`
    SELECT source_type, source_id, usage_type, attribution_text,
           claim_ids_json, evidence_ids_json, confidence
      FROM content_source_output_links
     WHERE tenant_id = ? AND owner_user_id = ?
       AND visibility_scope = 'user_private' AND scope_status = 'active'
       AND output_object_type = 'content_revision' AND output_id = ?
     ORDER BY id ASC
  `).all(scope.tenantId, scope.userId, String(sourceRevisionId)) as Array<{
    source_type: string;
    source_id: string;
    usage_type: string;
    attribution_text: string | null;
    claim_ids_json: string;
    evidence_ids_json: string;
    confidence: number;
  }>;
  for (const link of links) {
    db.prepare(`
      INSERT INTO content_source_output_links (
        tenant_id, owner_user_id, visibility_scope, scope_status,
        source_type, source_id, output_object_type, output_id, usage_type,
        attribution_text, claim_ids_json, evidence_ids_json, confidence,
        created_by, audit_metadata_json, created_at
      ) VALUES (?, ?, 'user_private', 'active', ?, ?, 'content_revision', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      scope.tenantId,
      scope.userId,
      link.source_type,
      link.source_id,
      String(copiedRevisionId),
      link.usage_type,
      link.attribution_text,
      link.claim_ids_json,
      link.evidence_ids_json,
      link.confidence,
      scope.userId,
      stableJson({
        source: 'content_workspace_copy',
        mode,
        sourceRevisionId,
        lineageSnapshotCopied: true,
      }),
      copiedAt,
    );

    const registry = db.prepare(`
      SELECT id, related_output_ids_json
        FROM content_reference_registry
       WHERE tenant_id = ? AND owner_user_id = ?
         AND visibility_scope = 'user_private' AND scope_status = 'active'
         AND reference_type = ?
         AND (? = reference_type || ':' || CAST(id AS TEXT))
       LIMIT 1
    `).get(scope.tenantId, scope.userId, link.source_type, link.source_id) as {
      id: number;
      related_output_ids_json: string;
    } | undefined;
    if (registry) {
      const related = Array.from(new Set([
        ...parseStoredStringArray(registry.related_output_ids_json),
        `content_revision:${copiedRevisionId}`,
      ])).slice(-50);
      db.prepare(`
        UPDATE content_reference_registry
           SET related_output_ids_json = ?, last_used_at = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND owner_user_id = ?
      `).run(stableJson(related), copiedAt, copiedAt, registry.id, scope.tenantId, scope.userId);
    }
  }
  return true;
}

function parseStoredStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

function normalizeTransitionAuditContext(
  value: TransitionContentWorkspaceItemInput['auditContext'],
): TransitionContentWorkspaceItemInput['auditContext'] | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContentWorkspaceError(
      'CONTENT_VALIDATION_FAILED',
      'auditContext must be an object.',
      400,
      { field: 'auditContext' },
    );
  }
  const source = requireEnum(
    value.source,
    ['decision_center', 'decision_center_command_bus'] as const,
    'auditContext.source',
  );
  const action = requireEnum(value.action, ['request_rewrite'] as const, 'auditContext.action');
  const decisionId = optionalText(value.decisionId, 'auditContext.decisionId', 200) ?? undefined;
  return {
    source,
    action,
    ...(decisionId ? { decisionId } : {}),
  };
}

function deletedItemNextAction(): ContentNextAction {
  return {
    action: 'restore_to_inbox',
    label: 'Restore item',
    reason: 'Restore this deleted item before continuing work.',
  };
}

function normalizeOptionalDate(value: string | null | undefined, field: string): string | null {
  const normalized = optionalText(value, field, 80);
  if (normalized == null) return null;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw new ContentWorkspaceError('CONTENT_VALIDATION_FAILED', `${field} must be an ISO-8601 date.`, 400, { field });
  }
  return parsed.toISOString();
}

function normalizeRevisionContent(content: ContentRevisionContent): ContentRevisionContent {
  if (!content || typeof content !== 'object') {
    throw new ContentWorkspaceError('CONTENT_VALIDATION_FAILED', 'content is required.', 400, { field: 'content' });
  }
  if (content.format === 'plain_text' || content.format === 'markdown') {
    const text = requireText(content.text, 'content.text', 1_000_000, false);
    return { format: content.format, text };
  }
  if (content.format === 'structured_json') {
    const document = normalizeRecord(content.document, 'content.document');
    const encoded = stableJson(document);
    if (encoded.length > 1_000_000) {
      throw new ContentWorkspaceError('CONTENT_VALIDATION_FAILED', 'Structured content exceeds the 1 MB limit.', 400, {
        field: 'content.document',
      });
    }
    return { format: 'structured_json', document };
  }
  throw new ContentWorkspaceError('CONTENT_VALIDATION_FAILED', 'Unsupported content format.', 400, { field: 'content.format' });
}

function normalizeRecord(value: Record<string, unknown> | undefined, field: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContentWorkspaceError('CONTENT_VALIDATION_FAILED', `${field} must be an object.`, 400, { field });
  }
  try {
    return JSON.parse(stableJson(value)) as Record<string, unknown>;
  } catch {
    throw new ContentWorkspaceError('CONTENT_VALIDATION_FAILED', `${field} must contain JSON-compatible values.`, 400, { field });
  }
}

function requireText(value: unknown, field: string, maxLength: number, trim = true): string {
  if (typeof value !== 'string') {
    throw new ContentWorkspaceError('CONTENT_VALIDATION_FAILED', `${field} is required.`, 400, { field });
  }
  const normalized = trim ? value.trim() : value;
  if (normalized.trim().length === 0 || normalized.length > maxLength) {
    throw new ContentWorkspaceError('CONTENT_VALIDATION_FAILED', `${field} must contain 1 to ${maxLength} characters.`, 400, { field });
  }
  return normalized;
}

function optionalText(value: unknown, field: string, maxLength: number): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') {
    throw new ContentWorkspaceError('CONTENT_VALIDATION_FAILED', `${field} must be a string.`, 400, { field });
  }
  const normalized = value.trim();
  if (normalized.length === 0) return null;
  if (normalized.length > maxLength) {
    throw new ContentWorkspaceError('CONTENT_VALIDATION_FAILED', `${field} exceeds ${maxLength} characters.`, 400, { field });
  }
  return normalized;
}

function normalizePositiveInteger(value: unknown, field: string): number {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(parsed) || Number(parsed) <= 0) {
    throw new ContentWorkspaceError('CONTENT_VALIDATION_FAILED', `${field} must be a positive integer.`, 400, { field });
  }
  return Number(parsed);
}

function normalizeNonNegativeInteger(value: unknown, field: string): number {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(parsed) || Number(parsed) < 0) {
    throw new ContentWorkspaceError('CONTENT_VALIDATION_FAILED', `${field} must be a non-negative integer.`, 400, { field });
  }
  return Number(parsed);
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ContentWorkspaceError('CONTENT_VALIDATION_FAILED', `${field} has an unsupported value.`, 400, {
      field,
      allowedValues: [...allowed],
    });
  }
  return value as T;
}

function hashRevisionContent(content: ContentRevisionContent): string {
  return hashPayload(content);
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
    throw new Error('Non-finite numbers are not JSON-compatible');
  }
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    throw new Error('Value is not JSON-compatible');
  }
  return value;
}

function parseRecord(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseStructuredDocument(value: string | null | undefined, revisionId: number): Record<string, unknown> {
  if (!value) {
    throw new ContentWorkspaceError('CONTENT_REVISION_INTEGRITY_FAILED', 'Structured revision content is missing.', 500, { revisionId });
  }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new ContentWorkspaceError('CONTENT_REVISION_INTEGRITY_FAILED', 'Structured revision content is corrupted.', 500, { revisionId });
  }
}

function qualifiedItemScopeSql(alias: string): string {
  return ITEM_SCOPE_SQL.replace(/\b(tenant_id|owner_user_id|visibility_scope|scope_status|deleted_at|object_type)\b/g, `${alias}.$1`);
}

function qualifiedDeletedItemScopeSql(alias: string): string {
  return DELETED_ITEM_SCOPE_SQL.replace(/\b(tenant_id|owner_user_id|visibility_scope|scope_status|deleted_at|object_type)\b/g, `${alias}.$1`);
}

function qualifiedArtifactScopeSql(alias: string): string {
  return ARTIFACT_SCOPE_SQL.replace(/\b(tenant_id|owner_user_id|visibility_scope|scope_status)\b/g, `${alias}.$1`);
}

function inconsistentReceiptError(): ContentWorkspaceError {
  return new ContentWorkspaceError(
    'CONTENT_IDEMPOTENCY_STATE_INCONSISTENT',
    'The original mutation receipt exists but its scoped resource is unavailable.',
    500,
  );
}

interface WorkspaceItemRow {
  id: number;
  object_type: string;
  title: string;
  summary?: string | null;
  production_state: string;
  artifact_phase: string;
  workspace_priority: number;
  deadline_at?: string | null;
  is_favorite: number;
  platform_id?: string | null;
  format_id?: string | null;
  current_artifact_id?: number | null;
  deleted_at?: string | null;
  workflow_version: number;
  review_reason_codes_json?: string | null;
  artifact_count?: number;
  created_at: string;
  updated_at: string;
}

interface ContentTagRow {
  id: number;
  display_name: string;
  normalized_name: string;
  created_at: string;
  updated_at: string;
}

interface ArtifactBaseRow {
  id: number;
  item_id: number;
  artifact_type: string;
  revision_count: number;
  current_revision_id?: number | null;
}

interface ArtifactRow extends ArtifactBaseRow {
  title?: string | null;
  platform_id?: string | null;
  format_id?: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
  revision_id?: number | null;
  revision_number?: number;
  parent_revision_id?: number | null;
  restored_from_revision_id?: number | null;
  content_format?: string;
  content_text?: string | null;
  structured_content_json?: string | null;
  content_hash?: string;
  change_summary?: string | null;
  change_reason?: string | null;
  actor_type?: string;
  actor_id?: string | null;
  provenance_json?: string;
  revision_created_at?: string;
}

interface RevisionRow {
  id: number;
  artifact_id: number;
  revision_number: number;
  parent_revision_id?: number | null;
  restored_from_revision_id?: number | null;
  content_format: string;
  content_text?: string | null;
  structured_content_json?: string | null;
  content_hash: string;
  change_summary?: string | null;
  change_reason?: string | null;
  actor_type: string;
  actor_id?: string | null;
  provenance_json?: string;
  created_at: string;
}

interface RelationshipRow {
  id: number;
  from_item_id: number;
  to_item_id: number;
  relationship_type: string;
  position?: number | null;
  metadata_json: string;
  created_at: string;
}

interface ArtifactRelationshipRow {
  id: number;
  from_artifact_id: number;
  to_artifact_id: number;
  relationship_type: string;
  metadata_json: string;
  created_at: string;
}

interface MutationReceiptRow {
  request_hash: string;
  resource_id: string;
  result_metadata_json: string;
}
