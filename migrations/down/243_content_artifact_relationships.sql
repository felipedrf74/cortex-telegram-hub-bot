-- Migration 243 is intentionally forward-only.
--
-- Platform-variant, remix, and derivation relationships are durable lineage.
-- Dropping them can leave artifacts present while destroying the user's only
-- explanation of what they were derived from. Application rollback must
-- ignore the additive read surface while preserving its schema; replacement
-- requires a separately reviewed forward migration with relationship-parity
-- proof.

SELECT rollback_blocked
  FROM content_artifact_relationships_243_forward_only_rollback_is_not_supported;
