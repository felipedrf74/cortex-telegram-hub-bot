-- Migration 251: close canonical Content workspace pointer and lineage gaps.
--
-- Migration 240 introduced immutable revision bytes, but its optional lineage
-- foreign keys were not tenant/artifact scoped and could be cleared by any
-- direct update. Migration 242 similarly allowed accepted agent-result
-- pointers to be cleared without proving that account/legal erasure was in
-- progress. This migration validates predecessor data before replacing those
-- permissive guards and adds database-boundary checks for the workspace's
-- current item/artifact/revision pointers.

-- Fail before changing durable schema when predecessor data cannot satisfy the
-- stronger invariants. The temporary guard is recreated on every attempt so a
-- repaired database can safely retry a migration that previously stopped here.
DROP TABLE IF EXISTS temp.content_workspace_251_validation_guard;
CREATE TEMP TABLE content_workspace_251_validation_guard (
  violation TEXT NOT NULL
);

CREATE TEMP TRIGGER content_workspace_251_invalid_revision_scope
BEFORE INSERT ON content_workspace_251_validation_guard
WHEN NEW.violation = 'revision_scope'
BEGIN
  SELECT RAISE(ABORT, 'content_workspace_251_invalid_revision_scope');
END;

CREATE TEMP TRIGGER content_workspace_251_invalid_parent_lineage
BEFORE INSERT ON content_workspace_251_validation_guard
WHEN NEW.violation = 'parent_lineage'
BEGIN
  SELECT RAISE(ABORT, 'content_workspace_251_invalid_parent_lineage');
END;

CREATE TEMP TRIGGER content_workspace_251_invalid_restore_lineage
BEFORE INSERT ON content_workspace_251_validation_guard
WHEN NEW.violation = 'restore_lineage'
BEGIN
  SELECT RAISE(ABORT, 'content_workspace_251_invalid_restore_lineage');
END;

CREATE TEMP TRIGGER content_workspace_251_invalid_current_artifact
BEFORE INSERT ON content_workspace_251_validation_guard
WHEN NEW.violation = 'current_artifact'
BEGIN
  SELECT RAISE(ABORT, 'content_workspace_251_invalid_current_artifact');
END;

CREATE TEMP TRIGGER content_workspace_251_invalid_current_revision
BEFORE INSERT ON content_workspace_251_validation_guard
WHEN NEW.violation = 'current_revision'
BEGIN
  SELECT RAISE(ABORT, 'content_workspace_251_invalid_current_revision');
END;

CREATE TEMP TRIGGER content_workspace_251_invalid_agent_result
BEFORE INSERT ON content_workspace_251_validation_guard
WHEN NEW.violation = 'agent_result'
BEGIN
  SELECT RAISE(ABORT, 'content_workspace_251_invalid_agent_result');
END;

INSERT INTO content_workspace_251_validation_guard(violation)
SELECT 'revision_scope'
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
 );

INSERT INTO content_workspace_251_validation_guard(violation)
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
 );

INSERT INTO content_workspace_251_validation_guard(violation)
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
 );

INSERT INTO content_workspace_251_validation_guard(violation)
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
 );

INSERT INTO content_workspace_251_validation_guard(violation)
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
 );

INSERT INTO content_workspace_251_validation_guard(violation)
SELECT 'agent_result'
 WHERE EXISTS (
   SELECT 1
     FROM content_agent_proposals AS proposal
    WHERE (proposal.status <> 'accepted'
           AND (proposal.accepted_artifact_id IS NOT NULL OR proposal.accepted_revision_id IS NOT NULL))
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
 );

DROP TABLE content_workspace_251_validation_guard;

-- Every revision after revision 1 must point to the immediately preceding
-- revision of the same artifact and scope. Restore provenance may point to any
-- strictly older revision, but never across an artifact, owner, or tenant.
DROP TRIGGER IF EXISTS trg_content_revisions_lineage_scope_insert;
CREATE TRIGGER trg_content_revisions_lineage_scope_insert
BEFORE INSERT ON content_revisions
BEGIN
  SELECT RAISE(ABORT, 'content revision parent must be null for revision 1')
   WHERE NEW.revision_number = 1
     AND NEW.parent_revision_id IS NOT NULL;

  SELECT RAISE(ABORT, 'content revision parent scope or sequence mismatch')
   WHERE NEW.revision_number > 1
     AND NOT EXISTS (
       SELECT 1
         FROM content_revisions AS parent
        WHERE parent.id = NEW.parent_revision_id
          AND parent.tenant_id = NEW.tenant_id
          AND parent.owner_user_id = NEW.owner_user_id
          AND parent.artifact_id = NEW.artifact_id
          AND parent.revision_number = NEW.revision_number - 1
     );

  SELECT RAISE(ABORT, 'content revision restore source scope or sequence mismatch')
   WHERE NEW.restored_from_revision_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM content_revisions AS restored
        WHERE restored.id = NEW.restored_from_revision_id
          AND restored.tenant_id = NEW.tenant_id
          AND restored.owner_user_id = NEW.owner_user_id
          AND restored.artifact_id = NEW.artifact_id
          AND restored.revision_number < NEW.revision_number
     );
END;

-- Lineage remains immutable. ON DELETE SET NULL may clear one or both pointers
-- only while the same owner has a live, explicitly classified account/legal
-- erasure authorization. This preserves account deletion without making NULL
-- a general-purpose lineage rewrite escape hatch.
DROP TRIGGER IF EXISTS trg_content_revisions_immutable_lineage_update;
CREATE TRIGGER trg_content_revisions_immutable_lineage_update
BEFORE UPDATE OF parent_revision_id, restored_from_revision_id ON content_revisions
WHEN (
  NEW.parent_revision_id IS NOT OLD.parent_revision_id
  OR NEW.restored_from_revision_id IS NOT OLD.restored_from_revision_id
)
AND NOT (
  (
    NEW.parent_revision_id IS OLD.parent_revision_id
    OR (OLD.parent_revision_id IS NOT NULL AND NEW.parent_revision_id IS NULL)
  )
  AND (
    NEW.restored_from_revision_id IS OLD.restored_from_revision_id
    OR (OLD.restored_from_revision_id IS NOT NULL AND NEW.restored_from_revision_id IS NULL)
  )
  AND EXISTS (
    SELECT 1
      FROM training_revision_erasure_authorizations AS authorization
     WHERE authorization.subject_user_id = OLD.owner_user_id
       AND authorization.reason IN ('ACCOUNT_DELETION', 'LEGAL_ERASURE')
       AND datetime(authorization.expires_at) >= datetime('now')
  )
)
BEGIN
  SELECT RAISE(ABORT, 'content revision lineage is immutable outside authorized erasure');
END;

-- Keep selected artifact pointers inside the owning item scope. Clearing a
-- selection is valid; assigning a selection must always resolve to that item.
DROP TRIGGER IF EXISTS trg_content_domain_objects_current_artifact_insert;
CREATE TRIGGER trg_content_domain_objects_current_artifact_insert
BEFORE INSERT ON content_domain_objects
WHEN NEW.current_artifact_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1
     FROM content_artifacts AS artifact
    WHERE artifact.id = NEW.current_artifact_id
      AND artifact.item_id = NEW.id
      AND artifact.tenant_id = NEW.tenant_id
      AND artifact.owner_user_id = NEW.owner_user_id
 )
BEGIN
  SELECT RAISE(ABORT, 'content item current artifact scope mismatch');
END;

DROP TRIGGER IF EXISTS trg_content_domain_objects_current_artifact_update;
CREATE TRIGGER trg_content_domain_objects_current_artifact_update
BEFORE UPDATE OF current_artifact_id, id, tenant_id, owner_user_id ON content_domain_objects
WHEN NEW.current_artifact_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1
     FROM content_artifacts AS artifact
    WHERE artifact.id = NEW.current_artifact_id
      AND artifact.item_id = NEW.id
      AND artifact.tenant_id = NEW.tenant_id
      AND artifact.owner_user_id = NEW.owner_user_id
 )
BEGIN
  SELECT RAISE(ABORT, 'content item current artifact scope mismatch');
END;

-- Prevent deleting a selected artifact while its item survives. During a real
-- item cascade SQLite removes the parent row before invoking child DELETE
-- triggers, so ordinary item/account deletion remains available.
DROP TRIGGER IF EXISTS trg_content_artifacts_current_selection_delete;
CREATE TRIGGER trg_content_artifacts_current_selection_delete
BEFORE DELETE ON content_artifacts
WHEN EXISTS (
  SELECT 1
    FROM content_domain_objects AS item
   WHERE item.id = OLD.item_id
     AND item.tenant_id = OLD.tenant_id
     AND item.owner_user_id = OLD.owner_user_id
     AND item.current_artifact_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'selected content artifact must be unselected before deletion');
END;

-- An artifact's item/scope identity participates in current selections, agent
-- result provenance, schedule pins, and relationship lineage. Moving the row
-- would invalidate those references without updating their guarded pointers.
DROP TRIGGER IF EXISTS trg_content_artifacts_scoped_identity_immutable;
CREATE TRIGGER trg_content_artifacts_scoped_identity_immutable
BEFORE UPDATE OF id, tenant_id, owner_user_id, item_id ON content_artifacts
WHEN NEW.id IS NOT OLD.id
  OR NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.owner_user_id IS NOT OLD.owner_user_id
  OR NEW.item_id IS NOT OLD.item_id
BEGIN
  SELECT RAISE(ABORT, 'content artifact scoped identity is immutable');
END;

-- revision_count is the number of immutable revisions and the selected
-- revision must be the last numbered revision. Artifact creation starts at
-- (NULL, 0); a save inserts the immutable revision first and then advances
-- both pointer fields in one update.
DROP TRIGGER IF EXISTS trg_content_artifacts_current_revision_insert;
CREATE TRIGGER trg_content_artifacts_current_revision_insert
BEFORE INSERT ON content_artifacts
WHEN NEW.revision_count <> 0 OR NEW.current_revision_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'new content artifact must start without revisions');
END;

DROP TRIGGER IF EXISTS trg_content_artifacts_current_revision_update;
CREATE TRIGGER trg_content_artifacts_current_revision_update
BEFORE UPDATE OF current_revision_id, revision_count, id, tenant_id, owner_user_id, item_id ON content_artifacts
WHEN NEW.revision_count <> (
       SELECT COUNT(*)
         FROM content_revisions AS revision
        WHERE revision.artifact_id = NEW.id
          AND revision.tenant_id = NEW.tenant_id
          AND revision.owner_user_id = NEW.owner_user_id
     )
  OR (NEW.current_revision_id IS NULL AND NEW.revision_count <> 0)
  OR (
    NEW.current_revision_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
        FROM content_revisions AS revision
       WHERE revision.id = NEW.current_revision_id
         AND revision.artifact_id = NEW.id
         AND revision.tenant_id = NEW.tenant_id
         AND revision.owner_user_id = NEW.owner_user_id
         AND revision.revision_number = NEW.revision_count
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'content artifact current revision or count mismatch');
END;

-- Prevent a direct latest-revision delete from leaving an artifact with a
-- dangling current pointer. Artifact/item cascades remain valid because the
-- parent artifact is already absent when SQLite invokes this child trigger.
DROP TRIGGER IF EXISTS trg_content_revisions_current_selection_delete;
CREATE TRIGGER trg_content_revisions_current_selection_delete
BEFORE DELETE ON content_revisions
WHEN EXISTS (
  SELECT 1
    FROM content_artifacts AS artifact
   WHERE artifact.id = OLD.artifact_id
     AND artifact.tenant_id = OLD.tenant_id
     AND artifact.owner_user_id = OLD.owner_user_id
     AND artifact.current_revision_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'current content revision cannot be deleted while its artifact survives');
END;

-- Replace migration-242's permissive accepted-result scope and immutability
-- guards. Result assignment is allowed only as part of the original proposed
-- -> accepted decision. Later nulling is allowed only for authorized erasure;
-- a result can never be silently rewritten or reattached.
DROP TRIGGER IF EXISTS trg_content_agent_proposals_accepted_revision_scope_insert;
DROP TRIGGER IF EXISTS trg_content_agent_proposals_accepted_revision_scope_update;
DROP TRIGGER IF EXISTS trg_content_agent_proposals_accepted_result_scope_insert;
DROP TRIGGER IF EXISTS trg_content_agent_proposals_accepted_result_scope_update;

CREATE TRIGGER trg_content_agent_proposals_accepted_result_scope_insert
BEFORE INSERT ON content_agent_proposals
BEGIN
  SELECT RAISE(ABORT, 'content agent accepted artifact scope mismatch')
   WHERE NEW.accepted_artifact_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM content_artifacts AS accepted
         JOIN content_artifacts AS source ON source.id = NEW.artifact_id
        WHERE accepted.id = NEW.accepted_artifact_id
          AND accepted.tenant_id = NEW.tenant_id
          AND accepted.owner_user_id = NEW.owner_user_id
          AND source.tenant_id = NEW.tenant_id
          AND source.owner_user_id = NEW.owner_user_id
          AND accepted.item_id = source.item_id
     );

  SELECT RAISE(ABORT, 'content agent accepted revision scope mismatch')
   WHERE NEW.accepted_revision_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM content_revisions AS revision
         JOIN content_artifacts AS accepted ON accepted.id = NEW.accepted_artifact_id
         JOIN content_artifacts AS source ON source.id = NEW.artifact_id
        WHERE revision.id = NEW.accepted_revision_id
          AND revision.artifact_id = accepted.id
          AND revision.tenant_id = NEW.tenant_id
          AND revision.owner_user_id = NEW.owner_user_id
          AND accepted.tenant_id = NEW.tenant_id
          AND accepted.owner_user_id = NEW.owner_user_id
          AND source.tenant_id = NEW.tenant_id
          AND source.owner_user_id = NEW.owner_user_id
          AND accepted.item_id = source.item_id
     );
END;

CREATE TRIGGER trg_content_agent_proposals_accepted_result_scope_update
BEFORE UPDATE OF accepted_artifact_id, accepted_revision_id ON content_agent_proposals
WHEN NOT (
  (
    (OLD.accepted_artifact_id IS NOT NULL AND NEW.accepted_artifact_id IS NULL)
    OR (OLD.accepted_revision_id IS NOT NULL AND NEW.accepted_revision_id IS NULL)
  )
  AND EXISTS (
    SELECT 1
      FROM training_revision_erasure_authorizations AS authorization
     WHERE authorization.subject_user_id = OLD.owner_user_id
       AND authorization.reason IN ('ACCOUNT_DELETION', 'LEGAL_ERASURE')
       AND datetime(authorization.expires_at) >= datetime('now')
  )
)
BEGIN
  SELECT RAISE(ABORT, 'content agent accepted artifact scope mismatch')
   WHERE NEW.accepted_artifact_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM content_artifacts AS accepted
         JOIN content_artifacts AS source ON source.id = NEW.artifact_id
        WHERE accepted.id = NEW.accepted_artifact_id
          AND accepted.tenant_id = NEW.tenant_id
          AND accepted.owner_user_id = NEW.owner_user_id
          AND source.tenant_id = NEW.tenant_id
          AND source.owner_user_id = NEW.owner_user_id
          AND accepted.item_id = source.item_id
     );

  SELECT RAISE(ABORT, 'content agent accepted revision scope mismatch')
   WHERE NEW.accepted_revision_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM content_revisions AS revision
         JOIN content_artifacts AS accepted ON accepted.id = NEW.accepted_artifact_id
         JOIN content_artifacts AS source ON source.id = NEW.artifact_id
        WHERE revision.id = NEW.accepted_revision_id
          AND revision.artifact_id = accepted.id
          AND revision.tenant_id = NEW.tenant_id
          AND revision.owner_user_id = NEW.owner_user_id
          AND accepted.tenant_id = NEW.tenant_id
          AND accepted.owner_user_id = NEW.owner_user_id
          AND source.tenant_id = NEW.tenant_id
          AND source.owner_user_id = NEW.owner_user_id
          AND accepted.item_id = source.item_id
     );
END;

DROP TRIGGER IF EXISTS trg_content_agent_proposals_revision_pointer;
CREATE TRIGGER trg_content_agent_proposals_revision_pointer
BEFORE UPDATE OF accepted_revision_id ON content_agent_proposals
WHEN NEW.accepted_revision_id IS NOT OLD.accepted_revision_id
 AND NOT (
   OLD.status = 'proposed'
   AND NEW.status = 'accepted'
   AND OLD.accepted_revision_id IS NULL
   AND NEW.accepted_revision_id IS NOT NULL
 )
 AND NOT (
   OLD.accepted_revision_id IS NOT NULL
   AND NEW.accepted_revision_id IS NULL
   AND EXISTS (
     SELECT 1
       FROM training_revision_erasure_authorizations AS authorization
      WHERE authorization.subject_user_id = OLD.owner_user_id
        AND authorization.reason IN ('ACCOUNT_DELETION', 'LEGAL_ERASURE')
        AND datetime(authorization.expires_at) >= datetime('now')
   )
 )
BEGIN
  SELECT RAISE(ABORT, 'content agent proposal revision pointer is immutable outside authorized erasure');
END;

DROP TRIGGER IF EXISTS trg_content_agent_proposals_artifact_pointer;
CREATE TRIGGER trg_content_agent_proposals_artifact_pointer
BEFORE UPDATE OF accepted_artifact_id ON content_agent_proposals
WHEN NEW.accepted_artifact_id IS NOT OLD.accepted_artifact_id
 AND NOT (
   OLD.status = 'proposed'
   AND NEW.status = 'accepted'
   AND OLD.accepted_artifact_id IS NULL
   AND NEW.accepted_artifact_id IS NOT NULL
 )
 AND NOT (
   OLD.accepted_artifact_id IS NOT NULL
   AND NEW.accepted_artifact_id IS NULL
   AND EXISTS (
     SELECT 1
       FROM training_revision_erasure_authorizations AS authorization
      WHERE authorization.subject_user_id = OLD.owner_user_id
        AND authorization.reason IN ('ACCOUNT_DELETION', 'LEGAL_ERASURE')
        AND datetime(authorization.expires_at) >= datetime('now')
   )
 )
BEGIN
  SELECT RAISE(ABORT, 'content agent proposal artifact pointer is immutable outside authorized erasure');
END;
