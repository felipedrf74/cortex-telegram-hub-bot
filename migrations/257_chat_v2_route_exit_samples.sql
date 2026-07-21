-- 257: ChatV2 legacy route-exit evidence samples (Chat M20).
--
-- chat_v2_route_exit_samples persists per-route evidence rows converted from
-- existing capture sources by src/services/chat-route-exit-sampler.ts:
--   * kind='parity'  — shadow-route replay bundles (chat_v2_replay_bundles).
--     Parity is the legacy-vs-v2 ROUTING comparison derived from the M4
--     routingDivergence record's surfaces (live legacy surface domain vs the
--     v2 shadow route domains). parity is 1/0/NULL: NULL means the bundle
--     carried no usable legacy-vs-v2 comparison (parity_unknown) and such
--     rows are EXCLUDED from both the retirement gate's 50-sample floor and
--     the parity rate — they can never produce a vacuous pass.
--   * kind='health'  — online-eval sampler captures
--     (chat_v2_online_eval_samples). These are v2-health/quality signals,
--     NOT parity observations: they are stored as context only and are
--     EXCLUDED from the route_shadow_parity retirement gate.
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
-- Parity rows feed evaluateChatLegacyRetirementReadiness (the pure retirement
-- gate: >=50 known-parity samples per route at >=0.95 parity). This table is
-- campaign MACHINERY only: it never flips route flags — flag flipping stays
-- owner-gated production work.

CREATE TABLE IF NOT EXISTS chat_v2_route_exit_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL CHECK (source IN (
    'shadow_replay_bundle', 'online_eval_sample'
  )),
  source_row_id INTEGER NOT NULL,
  source_key TEXT NOT NULL,
  route_id TEXT NOT NULL,
  route_method TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('parity', 'health')),
  -- 1 = legacy and v2 routing decisions agreed; 0 = diverged; NULL =
  -- parity_unknown (no usable legacy-vs-v2 comparison in the source row).
  parity INTEGER CHECK (parity IN (0, 1)),
  -- 1 = clean v2 capture; 0 = v2 failure capture. Health context only.
  health_ok INTEGER CHECK (health_ok IN (0, 1)),
  reason TEXT,
  sampled_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source, source_key),
  -- Health rows never carry parity; parity rows never carry health_ok.
  CHECK (kind <> 'health' OR parity IS NULL),
  CHECK (kind <> 'parity' OR health_ok IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_chat_v2_route_exit_samples_route
  ON chat_v2_route_exit_samples(route_id, kind, sampled_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_v2_route_exit_samples_source
  ON chat_v2_route_exit_samples(source, source_row_id DESC);
