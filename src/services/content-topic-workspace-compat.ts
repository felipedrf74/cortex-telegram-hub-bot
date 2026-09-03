// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Temporary /content/topics compatibility projection.
 *
 * content_domain_objects is the only writable item root. This adapter keeps
 * the old numeric topic contract usable while migration 247 and the iOS
 * workspace rollout retire the content_topics table. It never writes that
 * legacy table and never infers publication or an external Secretary action
 * from a deadline.
 */

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { DateTime } from 'luxon';
import { config } from '../config';
import { getDb } from './database';
import {
  ContentWorkspaceError,
  createContentArtifact,
  createContentWorkspaceItem,
  getContentArtifact,
  getContentWorkspaceItem,
  saveContentRevision,
  softDeleteContentWorkspaceItem,
  transitionContentWorkspaceItem,
  updateContentWorkspaceItem,
  type ContentProductionState,
  type ContentWorkspaceItem,
  type ContentWorkspaceScope,
} from './content-workspace';
import type { ContentTopic, ContentTopicStatus } from './content-scheduler';

export const CONTENT_TOPIC_COMPATIBILITY_SCHEMA_VERSION = 'content-topic-compatibility-v1';

export const CONTENT_TOPIC_COMPATIBILITY_EXIT = Object.freeze({
  canonicalRoot: 'content_domain_objects',
  legacyTable: 'content_topics',
  legacyTableMode: 'read_only',
  writeMode: 'canonical_workspace_only',
  rollbackMode: 'exact_runtime_and_pre_247_database_snapshot',
  removalCriteria: [
    'supported_ios_builds_use_content_workspace_routes',
    'no_supported_client_calls_content_topics_mutations',
    'legacy_secretary_references_are_retired_or_explicitly_reconciled',
    'compatibility_route_traffic_is_zero_for_the_release_observation_window',
  ],
} as const);

export interface ContentTopicCompatibilityView extends ContentTopic {
  workspace_item_id: number;
  compatibility_artifact_id: number;
  compatibility_schema_version: typeof CONTENT_TOPIC_COMPATIBILITY_SCHEMA_VERSION;
  compatibility_mode: 'canonical_workspace';
  schedule_semantics: 'none' | 'workspace_deadline' | 'legacy_external_reference';
}

export interface CreateContentTopicCompatibilityInput {
  scope: ContentWorkspaceScope;
  title: string;
  notes?: string | null;
  scheduledDate?: string | null;
  scheduledAt?: string | null;
  status?: ContentTopicStatus;
  source?: string | null;
  idempotencyKey?: string | null;
}

export type ContentTopicCompatibilityCreatePayload = Omit<
  CreateContentTopicCompatibilityInput,
  'scope' | 'idempotencyKey'
>;

export interface UpdateContentTopicCompatibilityInput {
  scope: ContentWorkspaceScope;
  compatTopicId: number;
  title?: string;
  notes?: string | null;
  scheduledDate?: string | null;
  scheduledAt?: string | null;
  status?: ContentTopicStatus;
  retireLegacySchedule?: boolean;
  idempotencyKey?: string | null;
}

export interface ListContentTopicCompatibilityInput {
  scope: ContentWorkspaceScope;
  status?: ContentTopicStatus;
  from?: string;
  to?: string;
  scheduledOnly?: boolean;
  includeTerminal?: boolean;
  limit?: number;
}

export interface ContentTopicCompatibilityMutation {
  topic: ContentTopicCompatibilityView;
  replayed: boolean;
  created: boolean;
}

interface CompatibilityRow {
  compat_topic_id: number;
  workspace_item_id: number;
  compatibility_artifact_id: number;
  legacy_topic_id: number | null;
  origin: 'legacy_backfill' | 'compatibility_create';
  legacy_snapshot_json: string;
  legacy_schedule_retired_at: string | null;
  tenant_id: number;
  owner_user_id: number;
  item_title: string;
  item_summary: string | null;
  deadline_at: string | null;
  production_state: ContentProductionState;
  artifact_phase: 'idea' | 'brief' | 'outline' | 'draft' | 'final';
  current_artifact_id: number | null;
  workflow_version: number;
  item_scope_status: 'active' | 'archived' | 'deleted';
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

interface LegacySnapshot {
  title?: string | null;
  notes?: string | null;
  status?: string | null;
  scheduledDate?: string | null;
  scheduledAt?: string | null;
  secretaryTaskListId?: string | null;
  secretaryTaskListName?: string | null;
  secretaryTaskExternalId?: string | null;
  calendarEventId?: string | null;
  calendarSource?: string | null;
  secretarySyncStatus?: string | null;
  secretarySyncError?: string | null;
}

const COMPATIBILITY_ROW_SELECT = `
  SELECT link.compat_topic_id,
         link.workspace_item_id,
         link.compatibility_artifact_id,
         link.legacy_topic_id,
         link.origin,
         link.legacy_snapshot_json,
         link.legacy_schedule_retired_at,
         item.tenant_id,
         item.owner_user_id,
         item.title AS item_title,
         item.summary AS item_summary,
         item.deadline_at,
         item.production_state,
         item.artifact_phase,
         item.current_artifact_id,
         item.workflow_version,
         item.scope_status AS item_scope_status,
         item.deleted_at,
         item.created_at,
         item.updated_at
    FROM content_topic_workspace_links link
    JOIN content_domain_objects item
      ON item.id = link.workspace_item_id
     AND item.tenant_id = link.tenant_id
     AND item.owner_user_id = link.owner_user_id
`;

export function createContentTopicCompatibility(
  input: CreateContentTopicCompatibilityInput,
  db: Database.Database = getDb(),
): ContentTopicCompatibilityMutation {
  const scope = normalizeScope(input.scope);
  const status = input.status ?? 'planned';
  assertLegacyStatus(status);
  if (status === 'published') {
    throw publicationConfirmationRequired();
  }
  const idempotencyKey = normalizeOptionalIdempotencyKey(input.idempotencyKey)
    ?? `server-${crypto.randomUUID()}`;
  const canonicalKey = `content-topic-compat:${idempotencyKey}`;
  const deadlineAt = resolveDeadline(input.scheduledDate, input.scheduledAt);
  const source = normalizeCompatibilitySource(input.source);
  const requestHash = compatibilityRequestHash({
    title: input.title,
    notes: input.notes ?? null,
    deadlineAt,
    status,
    source,
  });

  return db.transaction(() => {
    const replayItemId = getCompatibilityReceipt(
      db,
      scope,
      'create_topic_compatibility',
      canonicalKey,
      requestHash,
    );
    if (replayItemId != null) {
      const replay = findCompatibilityRowByItem(scope, replayItemId, db, false);
      if (!replay) throw compatibilityReceiptIntegrityError();
      return { topic: mapCompatibilityTopic(replay), replayed: true, created: false };
    }

    const itemMutation = createContentWorkspaceItem({
      scope,
      itemType: 'content_item',
      title: input.title,
      summary: input.notes ?? null,
      deadlineAt,
      idempotencyKey: `${canonicalKey}:item`,
    }, db);
    const item = itemMutation.value;
    const artifactMutation = createContentArtifact({
      scope,
      itemId: item.id,
      expectedWorkflowVersion: item.workflowVersion,
      artifactType: 'idea_note',
      title: item.title,
      initialContent: compatibilityRevision(item.title, item.summary, item.deadlineAt),
      changeSummary: 'Captured through the legacy topic compatibility route.',
      actorType: 'user',
      provenance: {
        compatibilitySchemaVersion: CONTENT_TOPIC_COMPATIBILITY_SCHEMA_VERSION,
        source,
      },
      idempotencyKey: `${canonicalKey}:artifact`,
    }, db);

    let current = getContentWorkspaceItem(scope, item.id, db)!;
    current = applyLegacyStatus(scope, current, status, `${canonicalKey}:state`, db);

    let row = findCompatibilityRowByItem(scope, item.id, db, true);
    if (!row) {
      db.prepare(`
        INSERT INTO content_topic_workspace_links (
          tenant_id, owner_user_id, workspace_item_id,
          compatibility_artifact_id, legacy_topic_id, origin,
          legacy_snapshot_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, 'compatibility_create', '{}', ?, ?)
      `).run(
        scope.tenantId,
        scope.userId,
        item.id,
        artifactMutation.value.id,
        current.createdAt,
        current.updatedAt,
      );
      row = findCompatibilityRowByItem(scope, item.id, db, true);
    }
    if (!row) {
      throw new ContentWorkspaceError(
        'CONTENT_TOPIC_COMPATIBILITY_WRITE_FAILED',
        'The canonical idea was saved but its compatibility identity was not readable.',
        500,
      );
    }
    putCompatibilityReceipt(
      db,
      scope,
      'create_topic_compatibility',
      canonicalKey,
      requestHash,
      row.workspace_item_id,
    );
    return {
      topic: mapCompatibilityTopic(row),
      replayed: false,
      created: true,
    };
  }).immediate();
}

export function findContentTopicCompatibilityByClientRequestId(
  scopeInput: ContentWorkspaceScope,
  clientRequestId: string,
  db: Database.Database = getDb(),
  expected?: ContentTopicCompatibilityCreatePayload,
): ContentTopicCompatibilityView | null {
  const scope = normalizeScope(scopeInput);
  if (typeof clientRequestId !== 'string' || clientRequestId.trim().length === 0) return null;
  const idempotencyKey = normalizeOptionalIdempotencyKey(clientRequestId);
  if (!idempotencyKey) return null;
  const canonicalKey = `content-topic-compat:${idempotencyKey}`;
  const compatibilityReceipt = db.prepare(`
    SELECT request_hash, resource_id
      FROM content_mutation_receipts
     WHERE tenant_id = ? AND owner_user_id = ?
       AND operation = 'create_topic_compatibility'
       AND idempotency_key = ?
     LIMIT 1
  `).get(scope.tenantId, scope.userId, canonicalKey) as {
    request_hash: string;
    resource_id: string;
  } | undefined;
  if (compatibilityReceipt) {
    if (expected) {
      const status = expected.status ?? 'planned';
      assertLegacyStatus(status);
      const expectedHash = compatibilityRequestHash({
        title: expected.title,
        notes: expected.notes ?? null,
        deadlineAt: resolveDeadline(expected.scheduledDate, expected.scheduledAt),
        status,
        source: normalizeCompatibilitySource(expected.source),
      });
      assertCompatibilityReceiptHash(compatibilityReceipt.request_hash, expectedHash, 'create_topic_compatibility');
    }
    const itemId = parseReceiptResourceId(compatibilityReceipt.resource_id);
    const replay = findCompatibilityRowByItem(scope, itemId, db, false);
    if (!replay) {
      if (expected) throw compatibilityReceiptIntegrityError();
      return null;
    }
    return mapCompatibilityTopic(replay);
  }
  const receipt = db.prepare(`
    SELECT resource_id
      FROM content_mutation_receipts
     WHERE tenant_id = ? AND owner_user_id = ?
       AND operation = 'create_item'
       AND idempotency_key = ?
     LIMIT 1
  `).get(scope.tenantId, scope.userId, `${canonicalKey}:item`) as { resource_id: string } | undefined;
  if (!receipt || !/^\d+$/.test(receipt.resource_id)) return null;
  const row = findCompatibilityRowByItem(scope, Number(receipt.resource_id), db, false);
  return row ? mapCompatibilityTopic(row) : null;
}

export function getContentTopicCompatibility(
  scopeInput: ContentWorkspaceScope,
  compatTopicId: number,
  db: Database.Database = getDb(),
): ContentTopicCompatibilityView | null {
  const scope = normalizeScope(scopeInput);
  const row = findCompatibilityRow(scope, compatTopicId, db, false);
  return row ? mapCompatibilityTopic(row) : null;
}

export function listContentTopicCompatibility(
  input: ListContentTopicCompatibilityInput,
  db: Database.Database = getDb(),
): ContentTopicCompatibilityView[] {
  const scope = normalizeScope(input.scope);
  if (input.status !== undefined) assertLegacyStatus(input.status);
  const limit = normalizeLimit(input.limit);
  const rows = db.prepare(`
    ${COMPATIBILITY_ROW_SELECT}
   WHERE link.tenant_id = ? AND link.owner_user_id = ?
     AND item.visibility_scope = 'user_private'
     AND item.scope_status = 'active'
     AND item.deleted_at IS NULL
     AND item.object_type = 'content_item'
   ORDER BY item.updated_at DESC, link.compat_topic_id DESC
   LIMIT 1000
  `).all(scope.tenantId, scope.userId) as CompatibilityRow[];

  return rows
    .map(mapCompatibilityTopic)
    .filter((topic) => input.status ? topic.status === input.status : input.includeTerminal ? true : topic.status !== 'cancelled')
    .filter((topic) => input.scheduledOnly ? topic.scheduled_date != null : true)
    .filter((topic) => input.from ? topic.scheduled_date == null || topic.scheduled_date >= input.from : true)
    .filter((topic) => input.to ? topic.scheduled_date == null || topic.scheduled_date <= input.to : true)
    .sort(compareCompatibilityTopics)
    .slice(0, limit);
}

export function countUpcomingContentTopicCompatibility(
  scopeInput: ContentWorkspaceScope,
  daysAhead: number = 14,
  db: Database.Database = getDb(),
): number {
  const scope = normalizeScope(scopeInput);
  const today = DateTime.now().setZone(config.app.timezone).startOf('day');
  const end = today.plus({ days: Math.max(0, Math.min(Math.floor(daysAhead), 365)) });
  return listContentTopicCompatibility({ scope, includeTerminal: true, limit: 1000 }, db)
    .filter((topic) => topic.scheduled_date != null
      && topic.scheduled_date >= today.toISODate()!
      && topic.scheduled_date <= end.toISODate()!
      && topic.status !== 'cancelled'
      && topic.status !== 'published')
    .length;
}

export function updateContentTopicCompatibility(
  input: UpdateContentTopicCompatibilityInput,
  db: Database.Database = getDb(),
): ContentTopicCompatibilityView | null {
  const scope = normalizeScope(input.scope);
  if (input.status !== undefined) assertLegacyStatus(input.status);
  const idempotencyKey = normalizeOptionalIdempotencyKey(input.idempotencyKey) ?? `server-${crypto.randomUUID()}`;
  const canonicalKey = `content-topic-compat-update:${idempotencyKey}`;
  const requestHash = updateCompatibilityRequestHash(input);
  const editsContent = input.title !== undefined || input.notes !== undefined;

  return db.transaction(() => {
    const replayItemId = getCompatibilityReceipt(
      db,
      scope,
      'update_topic_compatibility',
      canonicalKey,
      requestHash,
    );
    if (replayItemId != null) {
      const replay = findCompatibilityRowByItem(scope, replayItemId, db, false);
      if (!replay) throw compatibilityReceiptIntegrityError();
      return mapCompatibilityTopic(replay);
    }

    const row = findCompatibilityRow(scope, input.compatTopicId, db, false);
    if (!row) return null;
    if (editsContent && row.current_artifact_id !== row.compatibility_artifact_id) {
      throw new ContentWorkspaceError(
        'CONTENT_TOPIC_COMPATIBILITY_EDIT_MOVED',
        'This idea has developed beyond the legacy topic editor. Continue editing it in the Content workspace.',
        409,
        { workspaceItemId: row.workspace_item_id, recovery: 'open_content_workspace_item' },
      );
    }
    if (input.status === 'published' && row.production_state !== 'published') {
      throw publicationConfirmationRequired();
    }

    let item = getContentWorkspaceItem(scope, row.workspace_item_id, db);
    if (!item) return null;
    const patch: Parameters<typeof updateContentWorkspaceItem>[0] = {
      scope,
      itemId: item.id,
      expectedWorkflowVersion: item.workflowVersion,
      idempotencyKey: `${canonicalKey}:metadata`,
    };
    if (input.title !== undefined) patch.title = input.title;
    if (input.notes !== undefined) patch.summary = input.notes;
    if (input.scheduledDate !== undefined || input.scheduledAt !== undefined) {
      patch.deadlineAt = resolveUpdatedDeadline(item.deadlineAt, input.scheduledDate, input.scheduledAt);
    }
    const hasPatch = input.title !== undefined
      || input.notes !== undefined
      || input.scheduledDate !== undefined
      || input.scheduledAt !== undefined;
    if (hasPatch) {
      item = updateContentWorkspaceItem(patch, db).value;
    }

    if (editsContent) {
      const artifact = getContentArtifact(scope, row.compatibility_artifact_id, db);
      if (!artifact) {
        throw new ContentWorkspaceError('CONTENT_TOPIC_COMPATIBILITY_INTEGRITY_FAILED', 'The idea note is unavailable.', 500);
      }
      saveContentRevision({
        scope,
        artifactId: artifact.id,
        baseRevision: artifact.currentRevision?.revisionNumber ?? 0,
        content: compatibilityRevision(item.title, item.summary, item.deadlineAt),
        changeSummary: 'Updated through the legacy topic compatibility route.',
        changeReason: 'legacy_topic_compatibility_edit',
        actorType: 'user',
        provenance: { compatibilitySchemaVersion: CONTENT_TOPIC_COMPATIBILITY_SCHEMA_VERSION },
        idempotencyKey: `${canonicalKey}:revision`,
      }, db);
      item = getContentWorkspaceItem(scope, item.id, db)!;
    }

    if (input.status !== undefined) {
      item = applyLegacyStatus(scope, item, input.status, `${canonicalKey}:state`, db);
    }
    if (input.retireLegacySchedule === true) {
      retireLegacySchedule(row, db);
    }
    const updated = findCompatibilityRow(scope, row.compat_topic_id, db, false);
    if (!updated) throw compatibilityReceiptIntegrityError();
    putCompatibilityReceipt(
      db,
      scope,
      'update_topic_compatibility',
      canonicalKey,
      requestHash,
      updated.workspace_item_id,
    );
    return mapCompatibilityTopic(updated);
  }).immediate();
}

/** Read-only retry preflight so HTTP routes do not charge or repeat cleanup. */
export function findContentTopicCompatibilityUpdateReplay(
  input: UpdateContentTopicCompatibilityInput,
  db: Database.Database = getDb(),
): ContentTopicCompatibilityView | null {
  const scope = normalizeScope(input.scope);
  if (input.status !== undefined) assertLegacyStatus(input.status);
  const idempotencyKey = normalizeOptionalIdempotencyKey(input.idempotencyKey);
  if (!idempotencyKey) return null;
  const itemId = getCompatibilityReceipt(
    db,
    scope,
    'update_topic_compatibility',
    `content-topic-compat-update:${idempotencyKey}`,
    updateCompatibilityRequestHash(input),
  );
  if (itemId == null) return null;
  const row = findCompatibilityRowByItem(scope, itemId, db, false);
  if (!row) throw compatibilityReceiptIntegrityError();
  return mapCompatibilityTopic(row);
}

export function deleteContentTopicCompatibility(
  scopeInput: ContentWorkspaceScope,
  compatTopicId: number,
  options: { retireLegacySchedule?: boolean; idempotencyKey?: string | null } = {},
  db: Database.Database = getDb(),
): boolean {
  const scope = normalizeScope(scopeInput);
  const idempotencyKey = normalizeOptionalIdempotencyKey(options.idempotencyKey) ?? `server-${crypto.randomUUID()}`;
  const canonicalKey = `content-topic-compat-delete:${idempotencyKey}`;
  const requestHash = deleteCompatibilityRequestHash(compatTopicId);
  return db.transaction(() => {
    const replayItemId = getCompatibilityReceipt(
      db,
      scope,
      'delete_topic_compatibility',
      canonicalKey,
      requestHash,
    );
    if (replayItemId != null) {
      const replay = findCompatibilityRowByItem(scope, replayItemId, db, true);
      if (!replay) throw compatibilityReceiptIntegrityError();
      return true;
    }

    const row = findCompatibilityRow(scope, compatTopicId, db, true);
    if (!row) return false;
    if (options.retireLegacySchedule === true) retireLegacySchedule(row, db);
    if (row.item_scope_status !== 'deleted' || !row.deleted_at) {
      const item = getContentWorkspaceItem(scope, row.workspace_item_id, db);
      if (!item) return false;
      softDeleteContentWorkspaceItem({
        scope,
        itemId: item.id,
        expectedWorkflowVersion: item.workflowVersion,
        idempotencyKey: `${canonicalKey}:item`,
      }, db);
    }
    putCompatibilityReceipt(
      db,
      scope,
      'delete_topic_compatibility',
      canonicalKey,
      requestHash,
      row.workspace_item_id,
    );
    return true;
  }).immediate();
}

/** Read-only retry preflight so HTTP routes do not charge or repeat cleanup. */
export function hasContentTopicCompatibilityDeleteReplay(
  scopeInput: ContentWorkspaceScope,
  compatTopicId: number,
  options: { retireLegacySchedule?: boolean; idempotencyKey?: string | null },
  db: Database.Database = getDb(),
): boolean {
  const scope = normalizeScope(scopeInput);
  const idempotencyKey = normalizeOptionalIdempotencyKey(options.idempotencyKey);
  if (!idempotencyKey) return false;
  const itemId = getCompatibilityReceipt(
    db,
    scope,
    'delete_topic_compatibility',
    `content-topic-compat-delete:${idempotencyKey}`,
    deleteCompatibilityRequestHash(compatTopicId),
  );
  if (itemId == null) return false;
  const row = findCompatibilityRowByItem(scope, itemId, db, true);
  if (!row) throw compatibilityReceiptIntegrityError();
  return true;
}

export function assertContentTopicCompatibilityCanArchive(
  scopeInput: ContentWorkspaceScope,
  compatTopicId: number,
  db: Database.Database = getDb(),
): void {
  const scope = normalizeScope(scopeInput);
  const row = findCompatibilityRow(scope, compatTopicId, db, false);
  if (!row) return;
  const schedule = db.prepare(`
    SELECT state
      FROM content_schedule_bindings
     WHERE tenant_id = ? AND owner_user_id = ? AND item_id = ?
       AND state IN ('scheduled', 'provider_synced', 'sync_failed', 'cancel_pending', 'cancel_failed')
     ORDER BY id DESC
     LIMIT 1
  `).get(scope.tenantId, scope.userId, row.workspace_item_id) as { state: string } | undefined;
  if (schedule) {
    throw new ContentWorkspaceError(
      'CONTENT_SCHEDULE_CANCELLATION_REQUIRED',
      'Cancel the active Content work block before archiving or deleting this item.',
      409,
      { workspaceItemId: row.workspace_item_id, scheduleState: schedule.state, recovery: 'cancel_content_work_schedule' },
    );
  }
}

export function isCanonicalContentTopicCompatibilityId(
  scopeInput: ContentWorkspaceScope,
  compatTopicId: number,
  db: Database.Database = getDb(),
): boolean {
  const scope = normalizeScope(scopeInput);
  return Boolean(findCompatibilityRow(scope, compatTopicId, db, true));
}

/** Fail startup/readiness when migration 247 is incomplete or was bypassed. */
export function assertContentTopicWorkspaceCompatibilityReady(
  db: Database.Database = getDb(),
): void {
  const table = db.prepare(`
    SELECT 1 FROM sqlite_master
     WHERE type = 'table' AND name = 'content_topic_workspace_links'
  `).get();
  const guards = db.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_master
     WHERE type = 'trigger'
       AND name IN (
         'trg_content_topics_canonical_exit_insert',
         'trg_content_topics_canonical_exit_update',
         'trg_content_topics_canonical_exit_delete'
       )
  `).get() as { count: number };
  if (!table || Number(guards.count) !== 3) {
    throw new Error('content_topic_workspace_compatibility_schema_not_ready');
  }
  const unlinked = db.prepare(`
    SELECT COUNT(*) AS count
      FROM content_topics topic
     WHERE topic.user_id > 0
       AND topic.tenant_id = topic.user_id
       AND topic.owner_user_id = topic.user_id
       AND topic.visibility_scope = 'user_private'
       AND COALESCE(topic.scope_status, 'active') = 'active'
       AND NOT EXISTS (
         SELECT 1 FROM content_topic_workspace_links link
          WHERE link.legacy_topic_id = topic.id
            AND link.tenant_id = topic.tenant_id
            AND link.owner_user_id = topic.owner_user_id
       )
  `).get() as { count: number };
  const broken = db.prepare(`
    SELECT COUNT(*) AS count
      FROM content_topic_workspace_links link
      LEFT JOIN content_domain_objects item
        ON item.id = link.workspace_item_id
       AND item.tenant_id = link.tenant_id
       AND item.owner_user_id = link.owner_user_id
      LEFT JOIN content_artifacts artifact
        ON artifact.id = link.compatibility_artifact_id
       AND artifact.tenant_id = link.tenant_id
       AND artifact.owner_user_id = link.owner_user_id
       AND artifact.item_id = link.workspace_item_id
     WHERE item.id IS NULL OR artifact.id IS NULL
  `).get() as { count: number };
  if (Number(unlinked.count) !== 0 || Number(broken.count) !== 0) {
    throw new Error('content_topic_workspace_compatibility_integrity_failed');
  }
}

function findCompatibilityRow(
  scope: ContentWorkspaceScope,
  compatTopicId: number,
  db: Database.Database,
  includeDeleted: boolean,
): CompatibilityRow | null {
  if (!Number.isInteger(compatTopicId) || compatTopicId <= 0) return null;
  const row = db.prepare(`
    ${COMPATIBILITY_ROW_SELECT}
   WHERE link.compat_topic_id = ?
     AND link.tenant_id = ? AND link.owner_user_id = ?
     AND item.visibility_scope = 'user_private'
     AND item.object_type = 'content_item'
     ${includeDeleted ? '' : "AND item.scope_status = 'active' AND item.deleted_at IS NULL"}
   LIMIT 1
  `).get(compatTopicId, scope.tenantId, scope.userId) as CompatibilityRow | undefined;
  return row ?? null;
}

function findCompatibilityRowByItem(
  scope: ContentWorkspaceScope,
  itemId: number,
  db: Database.Database,
  includeDeleted: boolean,
): CompatibilityRow | null {
  const row = db.prepare(`
    ${COMPATIBILITY_ROW_SELECT}
   WHERE link.workspace_item_id = ?
     AND link.tenant_id = ? AND link.owner_user_id = ?
     AND item.visibility_scope = 'user_private'
     AND item.object_type = 'content_item'
     ${includeDeleted ? '' : "AND item.scope_status = 'active' AND item.deleted_at IS NULL"}
   LIMIT 1
  `).get(itemId, scope.tenantId, scope.userId) as CompatibilityRow | undefined;
  return row ?? null;
}

function mapCompatibilityTopic(row: CompatibilityRow): ContentTopicCompatibilityView {
  const snapshot = parseLegacySnapshot(row.legacy_snapshot_json);
  const hasLegacySchedule = row.legacy_schedule_retired_at == null && Boolean(
    snapshot.secretaryTaskExternalId || snapshot.calendarEventId,
  );
  const deadline = normalizeStoredDeadline(row.deadline_at);
  const status = compatibilityStatus(row.production_state, row.artifact_phase);
  return {
    id: Number(row.compat_topic_id),
    user_id: Number(row.owner_user_id),
    tenant_id: Number(row.tenant_id),
    owner_user_id: Number(row.owner_user_id),
    visibility_scope: 'user_private',
    lifecycle_state: row.production_state,
    scope_status: row.item_scope_status,
    title: row.item_title,
    notes: row.item_summary,
    scheduled_date: deadline?.date ?? null,
    scheduled_at: deadline?.dateTime ?? null,
    status,
    secretary_task_list_id: hasLegacySchedule ? stringOrNull(snapshot.secretaryTaskListId) : null,
    secretary_task_list_name: hasLegacySchedule ? stringOrNull(snapshot.secretaryTaskListName) : null,
    secretary_task_external_id: hasLegacySchedule ? stringOrNull(snapshot.secretaryTaskExternalId) : null,
    calendar_event_id: hasLegacySchedule ? stringOrNull(snapshot.calendarEventId) : null,
    calendar_source: hasLegacySchedule ? stringOrNull(snapshot.calendarSource) : null,
    secretary_sync_status: hasLegacySchedule
      ? stringOrNull(snapshot.secretarySyncStatus)
      : deadline
        ? 'workspace_confirmation_required'
        : null,
    secretary_sync_error: hasLegacySchedule ? stringOrNull(snapshot.secretarySyncError) : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    workspace_item_id: Number(row.workspace_item_id),
    compatibility_artifact_id: Number(row.compatibility_artifact_id),
    compatibility_schema_version: CONTENT_TOPIC_COMPATIBILITY_SCHEMA_VERSION,
    compatibility_mode: 'canonical_workspace',
    schedule_semantics: hasLegacySchedule
      ? 'legacy_external_reference'
      : deadline
        ? 'workspace_deadline'
        : 'none',
  };
}

function applyLegacyStatus(
  scope: ContentWorkspaceScope,
  initial: ContentWorkspaceItem,
  status: ContentTopicStatus,
  keyPrefix: string,
  db: Database.Database,
): ContentWorkspaceItem {
  let item = initial;
  const transition = (targetState: ContentProductionState, suffix: string): void => {
    if (item.productionState === targetState) return;
    item = transitionContentWorkspaceItem({
      scope,
      itemId: item.id,
      targetState,
      expectedWorkflowVersion: item.workflowVersion,
      idempotencyKey: `${keyPrefix}:${suffix}`,
    }, db).value;
  };

  if (status === 'published') {
    if (item.productionState !== 'published') throw publicationConfirmationRequired();
    return item;
  }
  if (status === 'cancelled') {
    if (item.productionState === 'rejected') transition('archived', 'archive-rejected');
    else if (item.productionState !== 'archived') transition('archived', 'archive');
    return item;
  }
  if (status === 'drafting') {
    if (item.productionState === 'rejected') transition('inbox', 'restore-rejected');
    if (item.productionState === 'inbox' || item.productionState === 'archived') transition('active', 'activate');
    else if (item.productionState === 'review' || item.productionState === 'approved' || item.productionState === 'scheduled') transition('active', 'resume');
    else if (item.productionState === 'published') throw compatibilityStateError(item, status);
    return item;
  }
  if (status === 'ready') {
    if (item.productionState === 'rejected') transition('inbox', 'restore-rejected');
    if (item.productionState === 'inbox' || item.productionState === 'archived') transition('active', 'activate');
    if (item.productionState === 'approved' || item.productionState === 'review') return item;
    if (item.productionState === 'active') transition('review', 'review');
    else if (item.productionState === 'published' || item.productionState === 'scheduled') throw compatibilityStateError(item, status);
    return item;
  }
  // planned
  if (item.productionState === 'archived' || item.productionState === 'rejected') {
    transition('inbox', 'restore-inbox');
  } else if (item.productionState !== 'inbox') {
    throw compatibilityStateError(item, status);
  }
  return item;
}

function retireLegacySchedule(row: CompatibilityRow, db: Database.Database): void {
  if (row.legacy_schedule_retired_at != null) return;
  db.prepare(`
    UPDATE content_topic_workspace_links
       SET legacy_schedule_retired_at = ?, updated_at = ?
     WHERE compat_topic_id = ? AND tenant_id = ? AND owner_user_id = ?
       AND legacy_schedule_retired_at IS NULL
  `).run(
    new Date().toISOString(),
    new Date().toISOString(),
    row.compat_topic_id,
    row.tenant_id,
    row.owner_user_id,
  );
}

function compatibilityRevision(title: string, notes: string | null, deadlineAt: string | null) {
  return {
    format: 'structured_json' as const,
    document: {
      schemaVersion: CONTENT_TOPIC_COMPATIBILITY_SCHEMA_VERSION,
      kind: 'idea_note',
      title,
      notes,
      deadlineAt,
    },
  };
}

function compatibilityStatus(
  state: ContentProductionState,
  phase: CompatibilityRow['artifact_phase'],
): ContentTopicStatus {
  if (state === 'published') return 'published';
  if (state === 'archived' || state === 'rejected') return 'cancelled';
  if (state === 'review' || state === 'approved' || state === 'scheduled' || phase === 'final') return 'ready';
  if (state === 'active' || phase === 'brief' || phase === 'outline' || phase === 'draft') return 'drafting';
  return 'planned';
}

function normalizeStoredDeadline(value: string | null): { date: string; dateTime: string | null } | null {
  if (!value) return null;
  const date = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (!value.includes('T') && !value.includes(' ')) return { date, dateTime: null };
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return { date, dateTime: null };
  const iso = parsed.toISOString();
  const midnight = iso.endsWith('T00:00:00.000Z');
  return { date, dateTime: midnight ? null : value };
}

function resolveDeadline(scheduledDate?: string | null, scheduledAt?: string | null): string | null {
  return scheduledAt ?? scheduledDate ?? null;
}

function resolveUpdatedDeadline(
  current: string | null,
  scheduledDate?: string | null,
  scheduledAt?: string | null,
): string | null {
  if (scheduledAt !== undefined) {
    if (scheduledAt != null) return scheduledAt;
    if (scheduledDate !== undefined) return scheduledDate;
  }
  if (scheduledDate !== undefined) return scheduledDate;
  return current;
}

function compareCompatibilityTopics(a: ContentTopicCompatibilityView, b: ContentTopicCompatibilityView): number {
  if (a.scheduled_date && b.scheduled_date) {
    const date = a.scheduled_date.localeCompare(b.scheduled_date);
    if (date !== 0) return date;
    return a.id - b.id;
  }
  if (a.scheduled_date) return -1;
  if (b.scheduled_date) return 1;
  return b.updated_at.localeCompare(a.updated_at) || b.id - a.id;
}

function parseLegacySnapshot(value: string): LegacySnapshot {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as LegacySnapshot : {};
  } catch {
    return {};
  }
}

function updateCompatibilityRequestHash(input: UpdateContentTopicCompatibilityInput): string {
  return compatibilityRequestHash({
    compatTopicId: input.compatTopicId,
    title: input.title,
    notes: input.notes,
    scheduledDate: input.scheduledDate,
    scheduledAt: input.scheduledAt,
    status: input.status,
  });
}

function deleteCompatibilityRequestHash(compatTopicId: number): string {
  return compatibilityRequestHash({ compatTopicId });
}

function compatibilityRequestHash(value: unknown): string {
  return crypto.createHash('sha256').update(stableCompatibilityJson(value)).digest('hex');
}

function stableCompatibilityJson(value: unknown): string {
  return JSON.stringify(canonicalizeCompatibilityValue(value));
}

function canonicalizeCompatibilityValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeCompatibilityValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalizeCompatibilityValue(entry)]),
    );
  }
  return value;
}

function getCompatibilityReceipt(
  db: Database.Database,
  scope: ContentWorkspaceScope,
  operation: 'create_topic_compatibility' | 'update_topic_compatibility' | 'delete_topic_compatibility',
  idempotencyKey: string,
  requestHash: string,
): number | null {
  const row = db.prepare(`
    SELECT request_hash, resource_id
      FROM content_mutation_receipts
     WHERE tenant_id = ? AND owner_user_id = ?
       AND operation = ? AND idempotency_key = ?
     LIMIT 1
  `).get(scope.tenantId, scope.userId, operation, idempotencyKey) as {
    request_hash: string;
    resource_id: string;
  } | undefined;
  if (!row) return null;
  assertCompatibilityReceiptHash(row.request_hash, requestHash, operation);
  return parseReceiptResourceId(row.resource_id);
}

function putCompatibilityReceipt(
  db: Database.Database,
  scope: ContentWorkspaceScope,
  operation: 'create_topic_compatibility' | 'update_topic_compatibility' | 'delete_topic_compatibility',
  idempotencyKey: string,
  requestHash: string,
  workspaceItemId: number,
): void {
  db.prepare(`
    INSERT INTO content_mutation_receipts (
      tenant_id, owner_user_id, operation, idempotency_key,
      request_hash, resource_type, resource_id, result_metadata_json
    ) VALUES (?, ?, ?, ?, ?, 'content_topic_compatibility', ?, '{}')
  `).run(
    scope.tenantId,
    scope.userId,
    operation,
    idempotencyKey,
    requestHash,
    String(workspaceItemId),
  );
}

function assertCompatibilityReceiptHash(actual: string, expected: string, operation: string): void {
  if (actual === expected) return;
  throw new ContentWorkspaceError(
    'CONTENT_IDEMPOTENCY_KEY_REUSED',
    'This idempotency key was already used for a different request.',
    409,
    { operation },
  );
}

function parseReceiptResourceId(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) <= 0) throw compatibilityReceiptIntegrityError();
  return Number(value);
}

function compatibilityReceiptIntegrityError(): ContentWorkspaceError {
  return new ContentWorkspaceError(
    'CONTENT_IDEMPOTENCY_RECEIPT_INCONSISTENT',
    'The saved compatibility mutation could not be reconstructed safely.',
    500,
  );
}

function normalizeScope(scope: ContentWorkspaceScope): ContentWorkspaceScope {
  if (!scope
    || !Number.isSafeInteger(scope.tenantId)
    || scope.tenantId <= 0
    || !Number.isSafeInteger(scope.userId)
    || scope.userId <= 0) {
    throw new ContentWorkspaceError('CONTENT_SCOPE_REQUIRED', 'A valid tenant and user scope is required.', 401);
  }
  if (scope.tenantId !== scope.userId) {
    throw new ContentWorkspaceError('CONTENT_SCOPE_MISMATCH', 'Content topic compatibility requires the authenticated owner scope.', 403);
  }
  return scope;
}

function assertLegacyStatus(status: ContentTopicStatus): void {
  if (!['planned', 'drafting', 'ready', 'published', 'cancelled'].includes(status)) {
    throw new ContentWorkspaceError('CONTENT_VALIDATION_FAILED', 'Unsupported legacy topic status.', 400, { field: 'status' });
  }
}

function normalizeOptionalIdempotencyKey(value?: string | null): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') {
    throw new ContentWorkspaceError('CONTENT_VALIDATION_FAILED', 'idempotencyKey must be a string.', 400, { field: 'idempotencyKey' });
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 128 || /[\u0000-\u001F\u007F-\u009F]/u.test(normalized)) {
    throw new ContentWorkspaceError('CONTENT_VALIDATION_FAILED', 'idempotencyKey must contain 1 to 128 visible characters.', 400, {
      field: 'idempotencyKey',
    });
  }
  return normalized;
}

function normalizeLimit(value?: number): number {
  if (value === undefined) return 100;
  if (!Number.isInteger(value) || value < 1 || value > 1000) {
    throw new ContentWorkspaceError('CONTENT_VALIDATION_FAILED', 'limit must be an integer from 1 to 1000.', 400, { field: 'limit' });
  }
  return value;
}

function normalizeCompatibilitySource(value?: string | null): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || 'legacy_topic_route';
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function publicationConfirmationRequired(): ContentWorkspaceError {
  return new ContentWorkspaceError(
    'CONTENT_PUBLICATION_CONFIRMATION_REQUIRED',
    'Publication cannot be inferred from a legacy topic status, and external publication tracking is not supported.',
    409,
    { publicationExecution: 'not_performed', recovery: 'publication_tracking_not_supported' },
  );
}

function compatibilityStateError(item: ContentWorkspaceItem, status: ContentTopicStatus): ContentWorkspaceError {
  return new ContentWorkspaceError(
    'CONTENT_TOPIC_COMPATIBILITY_STATE_CONFLICT',
    'This item has progressed beyond the legacy topic state controls. Continue in the Content workspace.',
    409,
    {
      workspaceItemId: item.id,
      currentProductionState: item.productionState,
      requestedLegacyStatus: status,
      recovery: 'open_content_workspace_item',
    },
  );
}
