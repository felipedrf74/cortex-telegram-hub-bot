-- Migration 242 is intentionally forward-only.
--
-- Agent jobs, step summaries, proposals, terminal accept/reject decisions,
-- and their mutation receipts are user evidence and revision provenance.
-- Dropping the additive graph would silently erase both pending work and the
-- explanation of how an accepted revision was produced. Application rollback
-- must retain this schema; a future replacement requires a separately
-- reviewed forward migration with export/parity proof.

SELECT rollback_blocked
  FROM content_agent_jobs_242_forward_only_rollback_is_not_supported;
