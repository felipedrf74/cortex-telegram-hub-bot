-- Roll back the routing corpus + calibration tables introduced by
-- migration 256. Corpus labels are advisory tooling state, not release
-- evidence; dropping them is safe.

DROP INDEX IF EXISTS idx_accepted_accuracy_snapshots_accepted;
DROP TABLE IF EXISTS accepted_accuracy_snapshots;
DROP TABLE IF EXISTS routing_llm_classify_cache;
DROP INDEX IF EXISTS idx_routing_corpus_items_source;
DROP INDEX IF EXISTS idx_routing_corpus_items_tenant_status;
DROP INDEX IF EXISTS idx_routing_corpus_items_status;
DROP TABLE IF EXISTS routing_corpus_items;
