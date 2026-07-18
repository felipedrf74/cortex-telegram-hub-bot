// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';

export const CONTENT_WORK_SCHEDULE_SUMMARY_SCHEMA_VERSION = 'content-work-schedule-summary-v1';

export const CONTENT_WORK_SCHEDULE_SUMMARY_STATES = [
  'scheduled',
  'provider_synced',
  'sync_failed',
  'cancel_pending',
  'cancel_failed',
  'cancelled',
  'completed',
  'stale',
] as const;
export type ContentWorkScheduleSummaryState = typeof CONTENT_WORK_SCHEDULE_SUMMARY_STATES[number];

export const CONTENT_WORK_SCHEDULE_SUMMARY_PROVIDER_STATES = [
  'pending',
  'synced',
  'failed',
  'deletion_pending',
  'deletion_failed',
  'removed',
] as const;
export type ContentWorkScheduleSummaryProviderState = typeof CONTENT_WORK_SCHEDULE_SUMMARY_PROVIDER_STATES[number];

export const CONTENT_WORK_SCHEDULE_SUMMARY_KINDS = [
  'write',
  'revise',
  'record',
  'edit',
  'review',
  'publish_prep',
] as const;
export type ContentWorkScheduleSummaryKind = typeof CONTENT_WORK_SCHEDULE_SUMMARY_KINDS[number];

/**
 * Safe, compact scheduling projection for workspace list and detail reads.
 * Secretary remains the scheduling authority; provider and Secretary record
 * identifiers are deliberately absent from this contract.
 */
export interface ContentWorkScheduleSummary {
  schemaVersion: typeof CONTENT_WORK_SCHEDULE_SUMMARY_SCHEMA_VERSION;
  state: ContentWorkScheduleSummaryState;
  workKind: ContentWorkScheduleSummaryKind;
  scheduledStart: string;
  scheduledEnd: string;
  scheduledRevisionNumber: number;
  contentChangedSinceScheduling: boolean;
  providerSyncState: ContentWorkScheduleSummaryProviderState;
  authority: 'secretary';
  authorityStatus: 'current' | 'unavailable';
  recoverable: boolean;
  publicationExecution: 'not_performed';
}

interface ScheduleSummaryScope {
  tenantId: number;
  userId: number;
}

interface ScheduleSummaryRow {
  item_id: number;
  artifact_id: number;
  revision_id: number;
  base_revision_number: number;
  binding_state: string;
  binding_provider_sync_state: string;
  cancellation_idempotency_key: string | null;
  scheduled_start_at: string;
  scheduled_end_at: string;
  work_kind: string;
  current_artifact_id: number | null;
  current_revision_id: number | null;
  agenda_present: number;
  agenda_lifecycle_state: string | null;
  agenda_provider_sync_state: string | null;
  agenda_provider_event_present: number;
  agenda_start_at: string | null;
  agenda_end_at: string | null;
}

const ACTIVE_BINDING_STATES = [
  'scheduled',
  'provider_synced',
  'sync_failed',
  'cancel_pending',
  'cancel_failed',
] as const;

const ACTIVE_AGENDA_STATES = new Set([
  'scheduled',
  'synced',
  'reflowed',
  'compressed',
  'failed_sync',
]);

const PROVIDER_FAILURE_STATES = new Set([
  'create_failed',
  'update_failed',
  'readback_failed',
]);

export function loadContentWorkScheduleSummaries(
  scope: ScheduleSummaryScope,
  itemIdsInput: number[],
  db: Database.Database,
): Map<number, ContentWorkScheduleSummary> {
  const itemIds = [...new Set(itemIdsInput.filter((id) => Number.isInteger(id) && id > 0))];
  const summaries = new Map<number, ContentWorkScheduleSummary>();
  if (itemIds.length === 0 || !hasScheduleProjectionTables(db)) return summaries;

  const placeholders = itemIds.map(() => '?').join(', ');
  const rows = db.prepare(`
    WITH scoped_bindings AS (
      SELECT binding.*
        FROM content_schedule_bindings binding
       WHERE binding.tenant_id = ?
         AND binding.owner_user_id = ?
         AND binding.item_id IN (${placeholders})
         AND binding.state IN (${ACTIVE_BINDING_STATES.map(() => '?').join(', ')})
    ),
    binding_intents AS (
      SELECT DISTINCT secretary_source_intent_id
        FROM scoped_bindings
    ),
    latest_agenda AS (
      SELECT agenda.source_intent_id,
             agenda.lifecycle_state,
             agenda.provider_sync_state,
             agenda.provider_event_id,
             agenda.start_at,
             agenda.end_at,
             ROW_NUMBER() OVER (
               PARTITION BY agenda.source_intent_id
               ORDER BY agenda.version DESC, agenda.updated_at DESC, agenda.agenda_item_id DESC
             ) AS agenda_rank
        FROM secretary_agenda_items agenda
        JOIN binding_intents binding_intent
          ON binding_intent.secretary_source_intent_id = agenda.source_intent_id
       WHERE agenda.owner_user_id = ?
         AND agenda.tenant_id = ?
         AND agenda.source_skill = 'content'
    )
    SELECT binding.item_id,
           binding.artifact_id,
           binding.revision_id,
           binding.base_revision_number,
           binding.state AS binding_state,
           binding.provider_sync_state AS binding_provider_sync_state,
           binding.cancellation_idempotency_key,
           binding.scheduled_start_at,
           binding.scheduled_end_at,
           preview.work_kind,
           item.current_artifact_id,
           current_artifact.current_revision_id,
           CASE WHEN agenda.source_intent_id IS NULL THEN 0 ELSE 1 END AS agenda_present,
           agenda.lifecycle_state AS agenda_lifecycle_state,
           agenda.provider_sync_state AS agenda_provider_sync_state,
           CASE WHEN agenda.provider_event_id IS NULL THEN 0 ELSE 1 END AS agenda_provider_event_present,
           agenda.start_at AS agenda_start_at,
           agenda.end_at AS agenda_end_at
      FROM scoped_bindings binding
      JOIN content_schedule_previews preview
        ON preview.id = binding.preview_id
       AND preview.tenant_id = binding.tenant_id
       AND preview.owner_user_id = binding.owner_user_id
       AND preview.item_id = binding.item_id
      JOIN content_domain_objects item
        ON item.id = binding.item_id
       AND item.tenant_id = binding.tenant_id
       AND item.owner_user_id = binding.owner_user_id
      LEFT JOIN content_artifacts current_artifact
        ON current_artifact.id = item.current_artifact_id
       AND current_artifact.tenant_id = item.tenant_id
       AND current_artifact.owner_user_id = item.owner_user_id
       AND current_artifact.item_id = item.id
       AND current_artifact.scope_status = 'active'
      LEFT JOIN latest_agenda agenda
        ON agenda.source_intent_id = binding.secretary_source_intent_id
       AND agenda.agenda_rank = 1
     WHERE item.visibility_scope = 'user_private'
       AND item.scope_status = 'active'
       AND item.deleted_at IS NULL
       AND item.object_type IN ('content_item', 'project')
     ORDER BY binding.id DESC
  `).all(
    scope.tenantId,
    scope.userId,
    ...itemIds,
    ...ACTIVE_BINDING_STATES,
    scope.userId,
    String(scope.tenantId),
  ) as ScheduleSummaryRow[];

  for (const row of rows) {
    const itemId = Number(row.item_id);
    if (summaries.has(itemId)) continue;
    summaries.set(itemId, mapScheduleSummary(row));
  }
  return summaries;
}

/**
 * Distinguish "no scheduled work" from "the Secretary schedule authority is
 * unavailable". Returning an empty map for both is convenient for optional
 * item decoration but unsafe for Today and aggregate truth contracts.
 */
export function isContentWorkScheduleAuthorityAvailable(db: Database.Database): boolean {
  return hasScheduleProjectionTables(db);
}

function mapScheduleSummary(row: ScheduleSummaryRow): ContentWorkScheduleSummary {
  const authorityStatus: ContentWorkScheduleSummary['authorityStatus'] = row.agenda_present === 1
    ? 'current'
    : 'unavailable';
  const providerSyncState = projectProviderState(row);
  const state = projectScheduleState(row, providerSyncState, authorityStatus);
  const currentArtifactId = row.current_artifact_id == null ? null : Number(row.current_artifact_id);
  const currentRevisionId = row.current_revision_id == null ? null : Number(row.current_revision_id);
  const contentChangedSinceScheduling = currentArtifactId !== Number(row.artifact_id)
    || currentRevisionId !== Number(row.revision_id);
  return {
    schemaVersion: CONTENT_WORK_SCHEDULE_SUMMARY_SCHEMA_VERSION,
    state,
    workKind: enumValue(row.work_kind, CONTENT_WORK_SCHEDULE_SUMMARY_KINDS, 'work kind'),
    scheduledStart: row.agenda_start_at ?? row.scheduled_start_at,
    scheduledEnd: row.agenda_end_at ?? row.scheduled_end_at,
    scheduledRevisionNumber: Number(row.base_revision_number),
    contentChangedSinceScheduling,
    providerSyncState,
    authority: 'secretary',
    authorityStatus,
    recoverable: authorityStatus === 'unavailable'
      || ['sync_failed', 'cancel_pending', 'cancel_failed', 'stale'].includes(state),
    publicationExecution: 'not_performed',
  };
}

function projectScheduleState(
  row: ScheduleSummaryRow,
  providerState: ContentWorkScheduleSummaryProviderState,
  authorityStatus: ContentWorkScheduleSummary['authorityStatus'],
): ContentWorkScheduleSummaryState {
  if (authorityStatus === 'unavailable') return 'stale';

  const cancellationRequested = row.cancellation_idempotency_key != null
    || row.binding_state === 'cancel_pending'
    || row.binding_state === 'cancel_failed';
  if (cancellationRequested) {
    if (providerState === 'deletion_failed') return 'cancel_failed';
    if (providerState === 'deletion_pending') return 'cancel_pending';
    if (!ACTIVE_AGENDA_STATES.has(row.agenda_lifecycle_state ?? '')) return 'cancelled';
    return row.binding_state === 'cancel_failed' ? 'cancel_failed' : 'cancel_pending';
  }

  if (row.agenda_lifecycle_state === 'completed') return 'completed';

  if (!ACTIVE_AGENDA_STATES.has(row.agenda_lifecycle_state ?? '')) return 'stale';
  if (providerState === 'failed') return 'sync_failed';
  if (providerState === 'synced') return 'provider_synced';
  return 'scheduled';
}

function projectProviderState(row: ScheduleSummaryRow): ContentWorkScheduleSummaryProviderState {
  const providerState = row.agenda_provider_sync_state ?? row.binding_provider_sync_state;
  const cancellationRequested = row.cancellation_idempotency_key != null
    || row.binding_state === 'cancel_pending'
    || row.binding_state === 'cancel_failed';
  if (cancellationRequested) {
    if (providerState === 'delete_failed') return 'deletion_failed';
    if (providerState === 'deleted') return 'removed';
    if (row.agenda_provider_event_present === 1) return 'deletion_pending';
  }
  if (providerState === 'synced') return 'synced';
  if (PROVIDER_FAILURE_STATES.has(providerState)) return 'failed';
  if (providerState === 'delete_failed') return 'deletion_failed';
  if (providerState === 'deleted') return 'removed';
  return 'pending';
}

function hasScheduleProjectionTables(db: Database.Database): boolean {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
      FROM sqlite_master
     WHERE type = 'table'
       AND name IN ('content_schedule_bindings', 'content_schedule_previews', 'secretary_agenda_items')
  `).get() as { count: number };
  return Number(row.count) === 3;
}

function enumValue<T extends readonly string[]>(value: string, allowed: T, field: string): T[number] {
  if (!allowed.includes(value)) throw new Error(`Invalid stored Content schedule ${field}.`);
  return value as T[number];
}
