-- Aggregate-only metrics are disposable and have no workflow dependencies.
DROP TABLE IF EXISTS content_workspace_quality_metrics;
DROP TABLE IF EXISTS content_workspace_product_metrics;
DROP TABLE IF EXISTS content_workspace_reason_metrics;
DROP TABLE IF EXISTS content_workspace_operation_metrics;
DROP TABLE IF EXISTS content_workspace_reliability_metrics;
