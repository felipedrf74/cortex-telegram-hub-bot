-- Roll back the additive Phase 7 manifest-prompt action-skill cache.
-- The legacy domain-routing cache and its accepted snapshots are untouched.

DROP INDEX IF EXISTS idx_routing_manifest_skill_cache_usage;
DROP TABLE IF EXISTS routing_manifest_skill_classify_cache;
DROP TABLE IF EXISTS routing_manifest_skill_refresh_plan_claims;
DROP TABLE IF EXISTS routing_manifest_skill_refresh_runs;
