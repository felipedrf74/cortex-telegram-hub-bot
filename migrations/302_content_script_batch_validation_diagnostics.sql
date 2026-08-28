-- 302: content-free OpenAI Batch validation diagnostics.
--
-- Provider Batch validation errors can identify an input line and parameter
-- without retaining the provider message or any request/output content. These
-- runtime-bounded fields let operators diagnose contract failures while
-- preserving the private-material boundary of the durable Batch ledger.

ALTER TABLE content_script_provider_batches
  ADD COLUMN last_error_line INTEGER;

ALTER TABLE content_script_provider_batches
  ADD COLUMN last_error_param TEXT;
