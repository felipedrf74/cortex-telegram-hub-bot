-- Migration 247 crosses a writable-root boundary. A code-only rollback is
-- intentionally unsupported; production rollback restores the exact pre-247
-- DB snapshot together with the older runtime. This down path is available
-- only for an untouched rehearsal migration.

CREATE TEMP TABLE _content_topics_workspace_exit_rollback_guard (
  value INTEGER NOT NULL CHECK (value = 0)
);

INSERT INTO _content_topics_workspace_exit_rollback_guard(value)
SELECT COUNT(*)
  FROM content_topic_workspace_links link
  JOIN content_domain_objects item
    ON item.id = link.workspace_item_id
   AND item.tenant_id = link.tenant_id
   AND item.owner_user_id = link.owner_user_id
  JOIN content_artifacts artifact
    ON artifact.id = link.compatibility_artifact_id
   AND artifact.tenant_id = link.tenant_id
   AND artifact.owner_user_id = link.owner_user_id
   AND artifact.item_id = link.workspace_item_id
 WHERE link.origin <> 'legacy_backfill'
    OR link.legacy_schedule_retired_at IS NOT NULL
    OR NOT EXISTS (
      SELECT 1 FROM content_topics topic
       WHERE topic.id = link.legacy_topic_id
         AND topic.tenant_id = link.tenant_id
         AND topic.owner_user_id = link.owner_user_id
    )
    OR item.workflow_version <> 1
    OR item.current_artifact_id <> link.compatibility_artifact_id
    OR item.scope_status <> 'active'
    OR item.deleted_at IS NOT NULL
    OR artifact.scope_status <> 'active'
    OR artifact.current_revision_id IS NOT NULL
    OR artifact.revision_count <> 0
    OR EXISTS (
      SELECT 1 FROM content_revisions revision
       WHERE revision.tenant_id = link.tenant_id
         AND revision.owner_user_id = link.owner_user_id
         AND revision.artifact_id = link.compatibility_artifact_id
    )
    OR EXISTS (
      SELECT 1 FROM content_mutation_receipts receipt
       WHERE receipt.tenant_id = link.tenant_id
         AND receipt.owner_user_id = link.owner_user_id
         AND receipt.resource_id IN (
           CAST(link.workspace_item_id AS TEXT),
           CAST(link.compatibility_artifact_id AS TEXT)
         )
    )
    OR EXISTS (
      SELECT 1 FROM content_item_tags item_tag
       WHERE item_tag.tenant_id = link.tenant_id
         AND item_tag.owner_user_id = link.owner_user_id
         AND item_tag.item_id = link.workspace_item_id
    )
    OR EXISTS (
      SELECT 1 FROM content_item_relationships relationship
       WHERE relationship.tenant_id = link.tenant_id
         AND relationship.owner_user_id = link.owner_user_id
         AND (relationship.from_item_id = link.workspace_item_id OR relationship.to_item_id = link.workspace_item_id)
    )
    OR EXISTS (
      SELECT 1 FROM content_schedule_previews preview
       WHERE preview.tenant_id = link.tenant_id
         AND preview.owner_user_id = link.owner_user_id
         AND preview.item_id = link.workspace_item_id
    )
    OR EXISTS (
      SELECT 1 FROM content_workflow_events event
       WHERE event.tenant_id = link.tenant_id
         AND event.owner_user_id = link.owner_user_id
         AND event.object_type = 'content_item'
         AND event.object_id = CAST(link.workspace_item_id AS TEXT)
    );

DROP TABLE _content_topics_workspace_exit_rollback_guard;

DROP TRIGGER IF EXISTS trg_content_topics_canonical_exit_delete;
DROP TRIGGER IF EXISTS trg_content_topics_canonical_exit_update;
DROP TRIGGER IF EXISTS trg_content_topics_canonical_exit_insert;
DROP TRIGGER IF EXISTS trg_content_topic_workspace_links_retirement_once;
DROP TRIGGER IF EXISTS trg_content_topic_workspace_links_immutable_identity;

DELETE FROM content_domain_objects
 WHERE id IN (
   SELECT workspace_item_id
     FROM content_topic_workspace_links
    WHERE origin = 'legacy_backfill'
 );

DROP INDEX IF EXISTS idx_content_topic_workspace_links_scope;
DROP TABLE IF EXISTS content_topic_workspace_links;
