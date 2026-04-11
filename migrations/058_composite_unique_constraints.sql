-- Migration 058: Fix global uniqueness constraints to be per-user.
-- SQLite doesn't support DROP CONSTRAINT, so we recreate indexes
-- as composite (user_id + field) to allow the same channel/book/category
-- per different users.

-- content_ref_channels: UNIQUE(channel_url) → allow same URL for different users
-- Drop the old unique index (if it exists) and create a composite one
DROP INDEX IF EXISTS idx_content_ref_channels_url;
CREATE UNIQUE INDEX IF NOT EXISTS idx_content_ref_channels_user_url
  ON content_ref_channels(user_id, channel_url);

-- content_knowledge: UNIQUE(category) → per-user categories
DROP INDEX IF EXISTS idx_content_knowledge_category;
CREATE UNIQUE INDEX IF NOT EXISTS idx_content_knowledge_user_category
  ON content_knowledge(user_id, category);

-- invoice_vendors: UNIQUE(sender_pattern) → per-user vendors
DROP INDEX IF EXISTS idx_invoice_vendors_sender;
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_vendors_user_sender
  ON invoice_vendors(user_id, sender_pattern);

-- video_transcripts: UNIQUE(video_id) → per-user transcripts
DROP INDEX IF EXISTS idx_video_transcripts_video_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_video_transcripts_user_video
  ON video_transcripts(user_id, video_id);
