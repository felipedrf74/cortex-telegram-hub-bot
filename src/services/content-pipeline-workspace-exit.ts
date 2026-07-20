// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Runtime guard for migration 246.
 *
 * `content_pipeline` is retained as a read-only compatibility archive while
 * canonical artifact parity is completed. The application must not serve if
 * the immutable ingress map or any legacy writer guard is absent, or if an
 * active private legacy root is not bound to a tenant-scoped workspace item.
 */

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from './database';

const SQLITE_UNICODE_WHITESPACE = [
  9, 10, 11, 12, 13, 32, 133, 160, 5760,
  8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202,
  8232, 8233, 8239, 8287, 12288,
].map((codePoint) => `char(${codePoint})`).join(' || ');

export const CONTENT_PIPELINE_WORKSPACE_EXIT = Object.freeze({
  canonicalRoot: 'content_domain_objects',
  legacyTable: 'content_pipeline',
  legacyTableMode: 'read_only',
  writeMode: 'canonical_workspace_only',
  rollbackMode: 'exact_runtime_and_pre_246_database_snapshot',
  removalCriteria: [
    'all_active_private_legacy_rows_have_scoped_ingress_bindings',
    'compatibility_reads_are_zero_for_the_release_observation_window',
    'metadata_only_bindings_with_legacy_content_have_canonical_artifact_and_lineage_parity',
    'all_active_private_legacy_script_bodies_have_lossless_artifact_revision_parity',
    'supported_clients_and_exports_use_workspace_item_artifact_and_revision_ids',
    'release_policy_no_longer_requires_exact_snapshot_rollback',
  ],
} as const);

/** Fail startup/readiness when migration 246 is missing or internally unsafe. */
export function assertContentPipelineWorkspaceExitReady(
  db: Database.Database = getDb(),
): void {
  const table = db.prepare(`
    SELECT 1
      FROM sqlite_master
     WHERE type = 'table'
       AND name = 'content_workspace_ingress_bindings'
  `).get();
  const scriptParityTable = db.prepare(`
    SELECT 1
      FROM sqlite_master
     WHERE type = 'table'
       AND name = 'content_legacy_script_ingress_bindings'
  `).get();
  const guards = db.prepare(`
    SELECT COUNT(*) AS count
      FROM sqlite_master
     WHERE type = 'trigger'
       AND name IN (
         'trg_content_pipeline_legacy_insert_blocked',
         'trg_content_pipeline_legacy_update_blocked'
       )
  `).get() as { count: number };
  const scriptParityGuards = db.prepare(`
    SELECT COUNT(*) AS count
      FROM sqlite_master
     WHERE type = 'trigger'
       AND name IN (
         'trg_content_legacy_script_ingress_scope_insert',
         'trg_content_legacy_script_ingress_immutable'
       )
  `).get() as { count: number };
  const legacyScriptWriteGuards = db.prepare(`
    SELECT COUNT(*) AS count
      FROM sqlite_master
     WHERE type = 'trigger'
       AND name IN (
         'trg_content_scripts_legacy_user_insert_blocked',
         'trg_content_scripts_legacy_user_update_blocked'
       )
  `).get() as { count: number };
  if (
    !table
    || !scriptParityTable
    || Number(guards.count) !== 2
    || Number(scriptParityGuards.count) !== 2
    || Number(legacyScriptWriteGuards.count) !== 2
  ) {
    throw new Error('content_pipeline_workspace_exit_schema_not_ready');
  }

  const unbound = db.prepare(`
    SELECT COUNT(*) AS count
      FROM content_pipeline AS pipeline
     WHERE pipeline.visibility_scope = 'user_private'
       AND pipeline.scope_status = 'active'
       AND (
         COALESCE(pipeline.tenant_id, 0) <= 0
         OR COALESCE(pipeline.owner_user_id, 0) <= 0
         OR trim(COALESCE(pipeline.topic_title, '')) = ''
         OR NOT EXISTS (
           SELECT 1
             FROM content_workspace_ingress_bindings AS binding
            WHERE binding.tenant_id = pipeline.tenant_id
              AND binding.owner_user_id = pipeline.owner_user_id
              AND binding.source_kind = 'legacy_pipeline'
              AND binding.source_id = CAST(pipeline.id AS TEXT)
         )
       )
  `).get() as { count: number };
  const broken = db.prepare(`
    SELECT COUNT(*) AS count
      FROM content_workspace_ingress_bindings AS binding
      LEFT JOIN content_domain_objects AS item
        ON item.id = binding.item_id
       AND item.tenant_id = binding.tenant_id
       AND item.owner_user_id = binding.owner_user_id
       AND item.object_type = 'content_item'
      LEFT JOIN content_artifacts AS artifact
        ON artifact.id = binding.artifact_id
       AND artifact.item_id = binding.item_id
       AND artifact.tenant_id = binding.tenant_id
       AND artifact.owner_user_id = binding.owner_user_id
      LEFT JOIN content_revisions AS revision
        ON revision.id = binding.revision_id
       AND revision.artifact_id = binding.artifact_id
       AND revision.tenant_id = binding.tenant_id
       AND revision.owner_user_id = binding.owner_user_id
     WHERE item.id IS NULL
        OR (binding.artifact_id IS NOT NULL AND artifact.id IS NULL)
        OR (binding.revision_id IS NOT NULL AND revision.id IS NULL)
  `).get() as { count: number };
  const legacyScripts = db.prepare(`
    SELECT script.id,
           script.tenant_id,
           script.owner_user_id,
           script.pipeline_id,
           script.script_text,
           binding.source_hash,
           binding.item_id,
           binding.artifact_id,
           binding.revision_id,
           binding.content_parity_status,
           item.id AS scoped_item_id,
           artifact.id AS scoped_artifact_id,
           artifact.current_revision_id,
           artifact.revision_count,
           revision.id AS scoped_revision_id,
           revision.revision_number,
           revision.content_format,
           revision.content_text,
           revision.content_hash
      FROM content_scripts AS script
      LEFT JOIN content_legacy_script_ingress_bindings AS binding
        ON binding.tenant_id = script.tenant_id
       AND binding.owner_user_id = script.owner_user_id
       AND binding.source_script_id = script.id
      LEFT JOIN content_domain_objects AS item
        ON item.id = binding.item_id
       AND item.tenant_id = binding.tenant_id
       AND item.owner_user_id = binding.owner_user_id
       AND item.object_type = 'content_item'
       AND item.visibility_scope = 'user_private'
      LEFT JOIN content_artifacts AS artifact
        ON artifact.id = binding.artifact_id
       AND artifact.item_id = binding.item_id
       AND artifact.tenant_id = binding.tenant_id
       AND artifact.owner_user_id = binding.owner_user_id
      LEFT JOIN content_revisions AS revision
        ON revision.id = binding.revision_id
       AND revision.artifact_id = binding.artifact_id
       AND revision.tenant_id = binding.tenant_id
       AND revision.owner_user_id = binding.owner_user_id
     WHERE script.tenant_id > 0
       AND script.owner_user_id > 0
       AND script.visibility_scope = 'user_private'
       AND script.scope_status = 'active'
       AND trim(COALESCE(script.script_text, ''), ${SQLITE_UNICODE_WHITESPACE}) <> ''
  `).all() as Array<Record<string, unknown>>;
  const scriptParityBroken = legacyScripts.some((row) => {
    const body = String(row.script_text);
    const rawHash = createHash('sha256').update(body).digest('hex');
    const revisionHash = createHash('sha256')
      .update(JSON.stringify({ format: 'plain_text', text: body }))
      .digest('hex');
    return row.content_parity_status !== 'artifact_pinned'
      || row.scoped_item_id == null
      || row.scoped_artifact_id == null
      || row.scoped_revision_id == null
      || Number(row.current_revision_id) !== Number(row.revision_id)
      || Number(row.revision_count) !== 1
      || Number(row.revision_number) !== 1
      || row.content_format !== 'plain_text'
      || row.content_text !== body
      || row.source_hash !== rawHash
      || row.content_hash !== revisionHash;
  });
  const unpinnedLinkedPipeline = db.prepare(`
    SELECT COUNT(*) AS count
      FROM content_scripts AS script
      JOIN content_legacy_script_ingress_bindings AS script_binding
        ON script_binding.tenant_id = script.tenant_id
       AND script_binding.owner_user_id = script.owner_user_id
       AND script_binding.source_script_id = script.id
     WHERE script.pipeline_id IS NOT NULL
       AND script.tenant_id > 0
       AND script.owner_user_id > 0
       AND script.visibility_scope = 'user_private'
       AND script.scope_status = 'active'
       AND trim(COALESCE(script.script_text, ''), ${SQLITE_UNICODE_WHITESPACE}) <> ''
       AND EXISTS (
         SELECT 1
           FROM content_workspace_ingress_bindings AS scoped_pipeline
          WHERE scoped_pipeline.tenant_id = script.tenant_id
            AND scoped_pipeline.owner_user_id = script.owner_user_id
            AND scoped_pipeline.source_kind = 'legacy_pipeline'
            AND scoped_pipeline.source_id = CAST(script.pipeline_id AS TEXT)
       )
       AND NOT EXISTS (
         SELECT 1
           FROM content_workspace_ingress_bindings AS pinned_pipeline
           JOIN content_legacy_script_ingress_bindings AS pinned_script
             ON pinned_script.tenant_id = pinned_pipeline.tenant_id
            AND pinned_script.owner_user_id = pinned_pipeline.owner_user_id
            AND pinned_script.item_id = pinned_pipeline.item_id
            AND pinned_script.artifact_id = pinned_pipeline.artifact_id
            AND pinned_script.revision_id = pinned_pipeline.revision_id
          WHERE pinned_pipeline.tenant_id = script.tenant_id
            AND pinned_pipeline.owner_user_id = script.owner_user_id
            AND pinned_pipeline.source_kind = 'legacy_pipeline'
            AND pinned_pipeline.source_id = CAST(script.pipeline_id AS TEXT)
            AND pinned_pipeline.content_parity_status = 'artifact_pinned'
       )
  `).get() as { count: number };
  if (
    Number(unbound.count) !== 0
    || Number(broken.count) !== 0
    || scriptParityBroken
    || Number(unpinnedLinkedPipeline.count) !== 0
  ) {
    throw new Error('content_pipeline_workspace_exit_integrity_failed');
  }
}
