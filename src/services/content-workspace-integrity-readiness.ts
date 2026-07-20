// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Runtime authority for migration 251.
 *
 * Migration 251 closes tenant/artifact lineage gaps and makes the workspace's
 * selected item/artifact/revision pointers database-enforced. Startup pins the
 * reviewed trigger definitions and repeats the migration preflight so a forged
 * migration ledger, same-name no-op trigger, or restored invalid database
 * cannot silently reopen those integrity boundaries.
 */

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from './database';

const CONTENT_WORKSPACE_INTEGRITY_TRIGGERS: Readonly<Record<string, string>> = Object.freeze({
  trg_content_agent_proposals_accepted_result_scope_insert:
    'd554939413fb7ebf1b20cb5a28cf79c86299b74fadc7aa3ba56a71bfe39c0c26',
  trg_content_agent_proposals_accepted_result_scope_update:
    '94f81b3d2d49f03727d0c0e07be9668c5a1e2759e485eeddbb13d2bb5bf3228e',
  trg_content_agent_proposals_artifact_pointer:
    '2da1fc5d3c090d5af89c216b1892c48d0b9931ba0b853042980354688dde5ed9',
  trg_content_agent_proposals_revision_pointer:
    '5f641484d1a2382959f068ac4c4cdd585778852c120659ddffc285e336f9d986',
  trg_content_artifacts_current_revision_insert:
    '2d80c71442395c8efebd7928b98b9ba391023c820560e87246419477bde2514c',
  trg_content_artifacts_current_revision_update:
    'fda4c607a39f0caf559120b72b0cbc5c9f21921ef6ecd02fc1ce2265b7ea5ec6',
  trg_content_artifacts_current_selection_delete:
    'b5cd1d33c0380d718b5d946231ff51e55e2c2e9572f32fd80608ef86c10a1ff7',
  trg_content_artifacts_scoped_identity_immutable:
    'ca507efd097c7df287ad3b4bd7549514fb0a40e2e0c00718be88b072e156603e',
  trg_content_domain_objects_current_artifact_insert:
    '3193b8e4afe1c23deb646a166ed59c3e0adc0dba155481db95e2a27f38e753eb',
  trg_content_domain_objects_current_artifact_update:
    '690372f5c2ba2a01f21b6699cd3a1b61672f171a75e98b85e2dab36522337541',
  trg_content_revisions_current_selection_delete:
    '8a830a9ef4bc8ec7731d2f7f179630eb0c7ce254d73767c3338f3318db38562c',
  trg_content_revisions_immutable_lineage_update:
    'd169286bdee2ef6b3d9324832d052be114d6f3fc48c476e5d3f12f20a941d5c8',
  trg_content_revisions_lineage_scope_insert:
    'ac74dca3c2e5d58f38b917270407efb76c96a6379af6339defab9e6136ea4536',
});

export const CONTENT_WORKSPACE_INTEGRITY_READINESS = Object.freeze({
  migration: '251_content_workspace_integrity.sql',
  rollbackMode: 'exact_runtime_and_pre_251_database_snapshot',
  requiredTriggers: Object.freeze(Object.keys(CONTENT_WORKSPACE_INTEGRITY_TRIGGERS)),
} as const);

type IntegrityViolation =
  | 'revision_scope'
  | 'parent_lineage'
  | 'restore_lineage'
  | 'current_artifact'
  | 'current_revision'
  | 'agent_result';

/** Fail startup when migration 251's reviewed guards or validated invariants are absent. */
export function assertContentWorkspaceIntegrityReady(
  db: Database.Database = getDb(),
): void {
  assertReviewedTriggerIdentity(db);

  let row: { violation: IntegrityViolation } | undefined;
  try {
    row = db.prepare(`
      SELECT violation
        FROM (
          SELECT 'revision_scope' AS violation
           WHERE EXISTS (
             SELECT 1
               FROM content_revisions AS revision
              WHERE NOT EXISTS (
                SELECT 1
                  FROM content_artifacts AS artifact
                 WHERE artifact.id = revision.artifact_id
                   AND artifact.tenant_id = revision.tenant_id
                   AND artifact.owner_user_id = revision.owner_user_id
              )
           )

          UNION ALL

          SELECT 'parent_lineage'
           WHERE EXISTS (
             SELECT 1
               FROM content_revisions AS revision
               LEFT JOIN content_revisions AS parent
                 ON parent.id = revision.parent_revision_id
              WHERE (revision.revision_number = 1 AND revision.parent_revision_id IS NOT NULL)
                 OR (
                   revision.revision_number > 1
                   AND (
                     parent.id IS NULL
                     OR parent.tenant_id <> revision.tenant_id
                     OR parent.owner_user_id <> revision.owner_user_id
                     OR parent.artifact_id <> revision.artifact_id
                     OR parent.revision_number <> revision.revision_number - 1
                   )
                 )
           )

          UNION ALL

          SELECT 'restore_lineage'
           WHERE EXISTS (
             SELECT 1
               FROM content_revisions AS revision
               LEFT JOIN content_revisions AS restored
                 ON restored.id = revision.restored_from_revision_id
              WHERE revision.restored_from_revision_id IS NOT NULL
                AND (
                  restored.id IS NULL
                  OR restored.tenant_id <> revision.tenant_id
                  OR restored.owner_user_id <> revision.owner_user_id
                  OR restored.artifact_id <> revision.artifact_id
                  OR restored.revision_number >= revision.revision_number
                )
           )

          UNION ALL

          SELECT 'current_artifact'
           WHERE EXISTS (
             SELECT 1
               FROM content_domain_objects AS item
              WHERE item.current_artifact_id IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1
                    FROM content_artifacts AS artifact
                   WHERE artifact.id = item.current_artifact_id
                     AND artifact.item_id = item.id
                     AND artifact.tenant_id = item.tenant_id
                     AND artifact.owner_user_id = item.owner_user_id
                )
           )

          UNION ALL

          SELECT 'current_revision'
           WHERE EXISTS (
             SELECT 1
               FROM content_artifacts AS artifact
              WHERE artifact.revision_count <> (
                      SELECT COUNT(*)
                        FROM content_revisions AS revision
                       WHERE revision.artifact_id = artifact.id
                         AND revision.tenant_id = artifact.tenant_id
                         AND revision.owner_user_id = artifact.owner_user_id
                    )
                 OR (artifact.current_revision_id IS NULL AND artifact.revision_count <> 0)
                 OR (
                   artifact.current_revision_id IS NOT NULL
                   AND NOT EXISTS (
                     SELECT 1
                       FROM content_revisions AS revision
                      WHERE revision.id = artifact.current_revision_id
                        AND revision.artifact_id = artifact.id
                        AND revision.tenant_id = artifact.tenant_id
                        AND revision.owner_user_id = artifact.owner_user_id
                        AND revision.revision_number = artifact.revision_count
                   )
                 )
           )

          UNION ALL

          SELECT 'agent_result'
           WHERE EXISTS (
             SELECT 1
               FROM content_agent_proposals AS proposal
              WHERE (
                    proposal.status <> 'accepted'
                    AND (
                      proposal.accepted_artifact_id IS NOT NULL
                      OR proposal.accepted_revision_id IS NOT NULL
                    )
                  )
                 OR (
                   proposal.accepted_artifact_id IS NOT NULL
                   AND NOT EXISTS (
                     SELECT 1
                       FROM content_artifacts AS accepted
                       JOIN content_artifacts AS source ON source.id = proposal.artifact_id
                      WHERE accepted.id = proposal.accepted_artifact_id
                        AND accepted.tenant_id = proposal.tenant_id
                        AND accepted.owner_user_id = proposal.owner_user_id
                        AND source.tenant_id = proposal.tenant_id
                        AND source.owner_user_id = proposal.owner_user_id
                        AND accepted.item_id = source.item_id
                   )
                 )
                 OR (
                   proposal.accepted_revision_id IS NOT NULL
                   AND NOT EXISTS (
                     SELECT 1
                       FROM content_revisions AS accepted_revision
                       JOIN content_artifacts AS accepted_artifact
                         ON accepted_artifact.id = proposal.accepted_artifact_id
                       JOIN content_artifacts AS source ON source.id = proposal.artifact_id
                      WHERE accepted_revision.id = proposal.accepted_revision_id
                        AND accepted_revision.artifact_id = accepted_artifact.id
                        AND accepted_revision.tenant_id = proposal.tenant_id
                        AND accepted_revision.owner_user_id = proposal.owner_user_id
                        AND accepted_artifact.tenant_id = proposal.tenant_id
                        AND accepted_artifact.owner_user_id = proposal.owner_user_id
                        AND source.tenant_id = proposal.tenant_id
                        AND source.owner_user_id = proposal.owner_user_id
                        AND accepted_artifact.item_id = source.item_id
                   )
                 )
           )
        )
       LIMIT 1
    `).get() as { violation: IntegrityViolation } | undefined;
  } catch (error) {
    throw readinessError('content_workspace_integrity_schema_not_ready', error);
  }

  if (row) {
    throw new Error(`content_workspace_integrity_failed:${row.violation}`);
  }
}

function assertReviewedTriggerIdentity(db: Database.Database): void {
  const names = Object.keys(CONTENT_WORKSPACE_INTEGRITY_TRIGGERS);
  const placeholders = names.map(() => '?').join(', ');
  let rows: Array<{ name: string; type: string; sql: string | null }>;
  try {
    rows = db.prepare(`
      SELECT name, type, sql
        FROM sqlite_master
       WHERE name IN (${placeholders})
    `).all(...names) as Array<{ name: string; type: string; sql: string | null }>;
  } catch (error) {
    throw readinessError('content_workspace_integrity_schema_not_ready', error);
  }

  const byName = new Map(rows.map((row) => [row.name, row]));
  for (const [name, expectedSha256] of Object.entries(CONTENT_WORKSPACE_INTEGRITY_TRIGGERS)) {
    const actual = byName.get(name);
    if (
      !actual
      || actual.type !== 'trigger'
      || typeof actual.sql !== 'string'
      || sha256(actual.sql) !== expectedSha256
    ) {
      throw new Error('content_workspace_integrity_schema_not_ready');
    }
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function readinessError(message: string, cause: unknown): Error {
  const error = new Error(message);
  (error as Error & { cause?: unknown }).cause = cause;
  return error;
}
