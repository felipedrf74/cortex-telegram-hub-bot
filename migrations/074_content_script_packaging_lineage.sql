-- Migration 074: Content script packaging lineage
--
-- Adds durable packaging fields so content learning can track the actual
-- generated and published packaging choices that drove performance.

ALTER TABLE content_scripts ADD COLUMN hashtags TEXT DEFAULT '[]';
ALTER TABLE content_scripts ADD COLUMN caption TEXT;
ALTER TABLE content_scripts ADD COLUMN cta TEXT;

ALTER TABLE content_performance ADD COLUMN selected_title TEXT;
ALTER TABLE content_performance ADD COLUMN final_caption TEXT;
ALTER TABLE content_performance ADD COLUMN final_cta TEXT;
ALTER TABLE content_performance ADD COLUMN final_script_variant TEXT;
ALTER TABLE content_performance ADD COLUMN published_hashtags TEXT DEFAULT '[]';
