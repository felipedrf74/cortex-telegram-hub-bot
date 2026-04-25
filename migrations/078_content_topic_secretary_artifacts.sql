-- Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
--
-- Migration 078 — Content topic Secretary artifacts
--
-- A content topic with only a date creates a Secretary task. A topic
-- with date + time also reserves a calendar agenda block. These nullable
-- columns keep the sync idempotent and auditable without changing the
-- existing topic lifecycle.

ALTER TABLE content_topics ADD COLUMN scheduled_at TEXT;
ALTER TABLE content_topics ADD COLUMN secretary_task_list_id TEXT;
ALTER TABLE content_topics ADD COLUMN secretary_task_list_name TEXT;
ALTER TABLE content_topics ADD COLUMN secretary_task_external_id TEXT;
ALTER TABLE content_topics ADD COLUMN calendar_event_id TEXT;
ALTER TABLE content_topics ADD COLUMN calendar_source TEXT;
ALTER TABLE content_topics ADD COLUMN secretary_sync_status TEXT;
ALTER TABLE content_topics ADD COLUMN secretary_sync_error TEXT;

CREATE INDEX IF NOT EXISTS idx_content_topics_user_scheduled_at
    ON content_topics (user_id, scheduled_at);
