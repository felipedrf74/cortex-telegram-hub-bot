// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';
import { getDb } from './database';

export const CONTENT_EDITORIAL_COMPATIBILITY_SCHEMA_VERSION = 'content-editorial-compatibility-v1' as const;

export const CONTENT_EDITORIAL_WORKFLOW_EXIT = Object.freeze({
  schemaVersion: CONTENT_EDITORIAL_COMPATIBILITY_SCHEMA_VERSION,
  lifecycle: 'deprecated',
  canonicalRoot: 'content_domain_objects',
  canonicalRoutes: {
    item: '/api/v1/content/workspace/items/:itemId',
    state: '/api/v1/content/workspace/items/:itemId/state',
    artifacts: '/api/v1/content/workspace/items/:itemId/artifacts',
    revisions: '/api/v1/content/workspace/artifacts/:artifactId/revisions',
    sources: '/api/v1/content/workspace/sources',
    lineage: '/api/v1/content/workspace/revisions/:revisionId/lineage',
    schedulePreview: '/api/v1/content/workspace/items/:itemId/schedule-previews',
    scheduleConfirm: '/api/v1/content/workspace/schedule-previews/:previewKey/confirm',
    relationships: '/api/v1/content/workspace/relationships',
  },
  publicationExecution: 'not_performed',
  rollbackMode: 'exact_runtime_and_pre_249_database_snapshot',
  removalCriteria: [
    'legacy_editorial_compatibility_reads_are_zero_for_two_supported_release_windows',
    'legacy_editorial_compatibility_mutations_are_zero_for_two_supported_release_windows',
    'decision_center_targets_canonical_workspace_item_versions',
    'supported_clients_use_workspace_artifact_revision_and_schedule_contracts',
    'historical_approval_and_source_review_ledgers_are_exported_without_runtime_writes',
    'release_policy_no_longer_requires_exact_snapshot_rollback',
  ],
} as const);

/**
 * Fail readiness if migration 249 did not establish a single canonical root,
 * immutable historical ledgers, or conservative trust-state normalization.
 */
export function assertContentEditorialWorkspaceExitReady(
  db: Database.Database = getDb(),
): void {
  const bindingTable = db.prepare(`
    SELECT 1 FROM sqlite_master
     WHERE type = 'table' AND name = 'content_editorial_workspace_exit_bindings'
     LIMIT 1
  `).get();
  const guards = db.prepare(`
    SELECT COUNT(*) AS count
      FROM sqlite_master
     WHERE type = 'trigger'
       AND name IN (
         'trg_content_domain_objects_canonical_type_insert',
         'trg_content_domain_objects_canonical_type_update',
         'trg_content_approval_records_archive_insert',
         'trg_content_approval_records_archive_update',
         'trg_content_approval_records_archive_delete',
         'trg_content_source_review_records_archive_insert',
         'trg_content_source_review_records_archive_update',
         'trg_content_source_review_records_archive_delete'
       )
  `).get() as { count: number };
  if (!bindingTable || Number(guards.count) !== 8) {
    throw new Error('content_editorial_workspace_exit_schema_not_ready');
  }

  const legacyRoots = db.prepare(`
    SELECT COUNT(*) AS count
      FROM content_domain_objects
     WHERE scope_status = 'active'
       AND object_type NOT IN ('content_item', 'project')
  `).get() as { count: number };
  const brokenBindings = db.prepare(`
    SELECT COUNT(*) AS count
      FROM content_editorial_workspace_exit_bindings AS binding
      LEFT JOIN content_domain_objects AS item
        ON item.id = binding.item_id
       AND item.tenant_id = binding.tenant_id
       AND item.owner_user_id = binding.owner_user_id
       AND item.visibility_scope = 'user_private'
       AND item.scope_status = 'active'
       AND item.object_type = 'content_item'
     WHERE item.id IS NULL
        OR item.current_artifact_id IS NOT NULL
        OR item.artifact_phase <> 'idea'
        OR item.secretary_intent_id IS NOT NULL
        OR item.secretary_agenda_item_id IS NOT NULL
        OR item.scheduled_for IS NOT NULL
        OR (
          lower(binding.legacy_editorial_state) IN ('approved', 'scheduled', 'published')
          AND (
            item.production_state <> 'review'
            OR item.approval_state <> 'required'
            OR item.review_required <> 1
          )
        )
  `).get() as { count: number };
  if (Number(legacyRoots.count) !== 0 || Number(brokenBindings.count) !== 0) {
    throw new Error('content_editorial_workspace_exit_integrity_failed');
  }
}
