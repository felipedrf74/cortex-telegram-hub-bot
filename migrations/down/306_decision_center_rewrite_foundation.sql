-- Test/rehearsal inverse for migration 306.
-- Production rollback keeps the additive schema and restores the matching
-- predecessor runtime plus its governed database snapshot.

DROP TABLE IF EXISTS planning_recompute_receipts;
DROP TABLE IF EXISTS scheduled_report_completion_receipts;
DROP TABLE IF EXISTS report_document_dispatch_receipts;

DROP INDEX IF EXISTS idx_report_documents_scoped_dispatch;
ALTER TABLE report_documents_scoped DROP COLUMN dispatch_key;

DROP INDEX IF EXISTS idx_agent_signals_scoped_identity;
ALTER TABLE agent_signals DROP COLUMN provenance_json;
ALTER TABLE agent_signals DROP COLUMN signal_identity;

DROP TABLE IF EXISTS decision_center_rank_snapshot_entries;
DROP TABLE IF EXISTS decision_center_rank_snapshots;
