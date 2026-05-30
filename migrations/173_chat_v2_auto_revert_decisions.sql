-- WP-07 (2026-05-30): Chat Core v2 auto-revert decision ledger.
--
-- This file is the SOLE creator of `chat_v2_auto_revert_decisions`. WP-08 only
-- adds a retention/cleanup stanza against this table; it does NOT recreate it.
--
-- MIGRATION NUMBER = 173 (not 172). Why 173 and not the next-free 172:
--   The migration RUNNER (`src/services/database.ts > runMigrations`) tracks
--   applied migrations by FILENAME in the `_migrations` table
--   (`filename TEXT NOT NULL UNIQUE`). It sorts every *.sql file by name and
--   applies ANY file whose filename is not already in `_migrations` —
--   `if (applied.has(file)) continue;`. There is NO "only apply files numbered
--   above the max applied" gate. So a file numbered 173 is applied even though
--   172 does not yet exist, because tracking is per-filename, not above-max.
--   The build plan (§5.C) therefore reserves 172 for WP-08's trace `expires_at`
--   column and assigns this table to 173. Because the runner is filename-based,
--   173 lands safely now; WP-08 will later add 172 and it, too, will be applied
--   (its filename is simply not yet in `_migrations`). The only hard rule the
--   runner enforces is no duplicate numeric prefix
--   (`assertNoUnexpectedMigrationPrefixCollisions`), which 173 satisfies (171 is
--   the current max; 172/173 are both free, non-colliding).
--
-- Privacy (§1.3 / §5.J): `tenant_id` is stored raw (per the schema contract — it
-- is the per-tenant audit key). The `metrics_snapshot_json` column stores ONLY
-- SAFE SCALARS (numbers / enums / booleans) — NEVER raw message text, user input,
-- or other PII. The executor allowlists the snapshot fields before writing.
--
-- Audit completeness: a `keep_current_mode` (no-op) decision is also persisted —
-- the ledger records every evaluation that produced a decision, not only reverts,
-- so the operator has a complete per-tenant timeline.

CREATE TABLE IF NOT EXISTS chat_v2_auto_revert_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,                          -- per-tenant audit key (§5.J)
  actions_json TEXT NOT NULL DEFAULT '[]',          -- ChatCoreV2AutoRevertAction[]
  affected_languages_json TEXT NOT NULL DEFAULT '[]',
  reason_codes_json TEXT NOT NULL DEFAULT '[]',
  metrics_snapshot_json TEXT NOT NULL DEFAULT '{}', -- SAFE SCALARS ONLY (no PII)
  decided_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chat_v2_auto_revert_tenant
  ON chat_v2_auto_revert_decisions(tenant_id, decided_at);
CREATE INDEX IF NOT EXISTS idx_chat_v2_auto_revert_decided_at
  ON chat_v2_auto_revert_decisions(decided_at);
