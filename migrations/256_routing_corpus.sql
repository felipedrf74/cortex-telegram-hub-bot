-- 256: Golden routing corpus + calibration tooling (Chat M7).
--
-- routing_corpus_items collects candidate utterances for human routing
-- labels. Sources are deterministic exports (classify-shadow disagreements,
-- online-eval samples, bilingual eval fixtures, unmatched chat-history turns,
-- manual additions) deduped by utterance HMAC. The ~300-item human labeling
-- pass is owner-gated and happens through the portal labeling page.
--
-- Privacy: utterance_hash reuses the classify-shadow HMAC-SHA256 scheme
-- (CLASSIFY_SHADOW_HASH_SECRET over trim().toLowerCase()). utterance_text is
-- nullable — hash-only sources whose text cannot be recovered from local
-- chat history are never inserted with raw text fabricated from elsewhere.
--
-- routing_llm_classify_cache stores the flash-lite classify result per
-- utterance hash so accuracy replays are LLM-free by default; only the
-- explicitly gated --refresh-llm pass may write new rows.
--
-- accepted_accuracy_snapshots stores owner-accepted per-surface/per-domain
-- accuracy reports; the deterministic --gate mode compares against the
-- latest accepted row.

CREATE TABLE IF NOT EXISTS routing_corpus_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 0,
  user_id INTEGER,                                 -- NULL for synthetic (fixture/manual) items
  utterance_hash TEXT NOT NULL UNIQUE CHECK (length(utterance_hash) = 64),
  utterance_text TEXT,
  source TEXT NOT NULL CHECK (source IN (
    'classify_shadow_disagreement',
    'online_eval_sampler',
    'bilingual_fixture',
    'history_unmatched',
    'manual'
  )),
  suggested_domain TEXT,
  suggested_skill TEXT,
  label_domain TEXT,
  label_skill TEXT,
  label_status TEXT NOT NULL DEFAULT 'pending' CHECK (label_status IN ('pending', 'labeled', 'skipped')),
  labeled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (label_status = 'pending' AND label_domain IS NULL AND label_skill IS NULL AND labeled_at IS NULL)
    OR (label_status = 'labeled' AND label_domain IS NOT NULL AND labeled_at IS NOT NULL)
    OR (label_status = 'skipped' AND label_domain IS NULL AND label_skill IS NULL AND labeled_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_routing_corpus_items_status
  ON routing_corpus_items(label_status, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_routing_corpus_items_tenant_status
  ON routing_corpus_items(tenant_id, label_status);
CREATE INDEX IF NOT EXISTS idx_routing_corpus_items_source
  ON routing_corpus_items(source, label_status);

CREATE TABLE IF NOT EXISTS routing_llm_classify_cache (
  utterance_hash TEXT PRIMARY KEY CHECK (length(utterance_hash) = 64),
  domain TEXT NOT NULL,
  confidence REAL NOT NULL,
  model TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accepted_accuracy_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  snapshot_json TEXT NOT NULL,
  accepted INTEGER NOT NULL DEFAULT 0 CHECK (accepted IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_accepted_accuracy_snapshots_accepted
  ON accepted_accuracy_snapshots(accepted, created_at DESC, id DESC);
