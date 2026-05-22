-- Migration 153: Structured Decision Center explanations.
--
-- Handled-by-Nexus history keeps the old summary/why_brief fields for older
-- clients and stores a richer render-ready explanation for current iOS.

ALTER TABLE handled_by_nexus_items ADD COLUMN explanation_json TEXT;
