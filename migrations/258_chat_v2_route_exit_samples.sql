-- 258: ChatV2 legacy route-exit evidence samples (Chat M20).
--
-- chat_v2_route_exit_samples persists per-route evidence rows converted from
-- existing capture sources by src/services/chat-route-exit-sampler.ts:
--   * kind='routing_diagnostic' — shadow-route replay bundles
--     (chat_v2_replay_bundles). Agreement is the legacy-vs-v2 ROUTING
--     comparison derived from the M4
--     routingDivergence record's surfaces (live legacy surface domain vs the
--     v2 shadow route domains). routing_agreement is 1/0/NULL. This is a
--     routing diagnostic only: it never feeds behavior parity and can never
--     produce a retirement PASS.
--   * kind='health'  — online-eval sampler captures
--     (chat_v2_online_eval_samples). These are v2-health/quality signals,
--     NOT behavior-parity observations: they are stored as context only and
--     never feed the retirement gate.
--
-- Eval-history per-scenario rows (chat_eval_scenario_results) are
-- deliberately NOT a source: the eval-history writer persists numeric
-- scores_json and free-text notes with no per-scenario routeMethod, so no
-- honest route attribution exists (see the module comment in
-- chat-route-exit-sampler.ts).
--
-- Rows are deduped by (source, source_key) — the natural id of the source row
-- (replay_bundle_id / sample_id). Both source tables upsert IN PLACE under
-- their natural key (ON CONFLICT ... DO UPDATE) and carry no updated_at
-- column, so the sampler performs a FULL rescan on every sync and refreshes
-- existing rows via ON CONFLICT(source, source_key) DO UPDATE — correctness
-- beats incrementality; there is no high-water-mark state table.
--
-- The retirement gate reads signed paired response evidence from
-- chat_v2_legacy_retirement_evidence instead. This table is diagnostic
-- campaign machinery only; flag flipping stays owner-gated production work.

CREATE TABLE IF NOT EXISTS chat_v2_route_exit_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL CHECK (source IN (
    'shadow_replay_bundle', 'online_eval_sample'
  )),
  source_row_id INTEGER NOT NULL,
  source_key TEXT NOT NULL,
  route_id TEXT NOT NULL,
  route_method TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('routing_diagnostic', 'health')),
  -- 1 = legacy and v2 routing decisions agreed; 0 = diverged; NULL = no
  -- usable comparison. Diagnostic only; never behavior parity evidence.
  routing_agreement INTEGER CHECK (routing_agreement IN (0, 1)),
  -- 1 = clean v2 capture; 0 = v2 failure capture. Health context only.
  health_ok INTEGER CHECK (health_ok IN (0, 1)),
  reason TEXT,
  sampled_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source, source_key),
  -- Health rows never carry routing agreement; diagnostics never carry health.
  CHECK (kind <> 'health' OR routing_agreement IS NULL),
  CHECK (kind <> 'routing_diagnostic' OR health_ok IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_chat_v2_route_exit_samples_route
  ON chat_v2_route_exit_samples(route_id, kind, sampled_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_v2_route_exit_samples_source
  ON chat_v2_route_exit_samples(source, source_row_id DESC);
