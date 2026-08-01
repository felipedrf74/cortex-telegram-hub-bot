-- 266: Prompt-bound action-skill classifier replay cache (Chat Phase 7).
--
-- These tables are deliberately separate from routing_llm_classify_cache. The
-- accepted Phase 4 domain-routing ratchet must not be rewritten by the
-- manifest-prompt action-skill evaluation. Refresh runs bind one immutable
-- runtime/artifact identity to one shared hard budget and api_usage run id.
-- Plan claims serialize an exact authorized mutation while allowing a failed
-- attempt to resume under that same release budget. A nullable predicted_skill
-- is a covered classifier abstention; absence of an exact-identity row is an
-- uncovered corpus item.

CREATE TABLE IF NOT EXISTS routing_manifest_skill_refresh_runs (
  runtime_sha TEXT NOT NULL CHECK (length(runtime_sha) = 40),
  artifact_digest TEXT NOT NULL CHECK (length(artifact_digest) = 64),
  run_id TEXT NOT NULL CHECK (trim(run_id) != '' AND length(run_id) <= 160),
  budget_usd REAL NOT NULL CHECK (budget_usd > 0 AND budget_usd <= 0.50),
  prompt_sha256 TEXT NOT NULL CHECK (length(prompt_sha256) = 64),
  request_builder_version TEXT NOT NULL CHECK (trim(request_builder_version) != ''),
  provider TEXT NOT NULL CHECK (trim(provider) != ''),
  model TEXT NOT NULL CHECK (trim(model) != ''),
  usage_category TEXT NOT NULL CHECK (trim(usage_category) != ''),
  request_source TEXT NOT NULL CHECK (trim(request_source) != ''),
  base_category TEXT NOT NULL CHECK (trim(base_category) != ''),
  job_name TEXT NOT NULL CHECK (trim(job_name) != ''),
  user_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (runtime_sha, artifact_digest),
  UNIQUE (run_id),
  UNIQUE (runtime_sha, artifact_digest, run_id)
);

CREATE TABLE IF NOT EXISTS routing_manifest_skill_refresh_plan_claims (
  plan_digest TEXT PRIMARY KEY
    CHECK (length(plan_digest) = 71 AND substr(plan_digest, 1, 7) = 'sha256:'),
  plan_sequence INTEGER NOT NULL CHECK (plan_sequence >= 1),
  corpus_identity_digest TEXT NOT NULL
    CHECK (length(corpus_identity_digest) = 71
      AND substr(corpus_identity_digest, 1, 7) = 'sha256:'),
  runtime_sha TEXT NOT NULL CHECK (length(runtime_sha) = 40),
  artifact_digest TEXT NOT NULL CHECK (length(artifact_digest) = 64),
  run_id TEXT NOT NULL CHECK (trim(run_id) != '' AND length(run_id) <= 160),
  status TEXT NOT NULL CHECK (status IN ('active', 'failed', 'completed')),
  claim_token TEXT,
  claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (status = 'active' AND claim_token IS NOT NULL AND trim(claim_token) != '')
    OR (status IN ('failed', 'completed') AND claim_token IS NULL)
  ),
  FOREIGN KEY (runtime_sha, artifact_digest, run_id)
    REFERENCES routing_manifest_skill_refresh_runs(runtime_sha, artifact_digest, run_id)
    ON DELETE RESTRICT,
  UNIQUE (
    plan_digest, corpus_identity_digest, runtime_sha, artifact_digest, run_id
  ),
  UNIQUE (runtime_sha, artifact_digest, plan_sequence)
);

CREATE TABLE IF NOT EXISTS routing_manifest_skill_classify_cache (
  runtime_sha TEXT NOT NULL CHECK (length(runtime_sha) = 40),
  artifact_digest TEXT NOT NULL CHECK (length(artifact_digest) = 64),
  plan_digest TEXT NOT NULL
    CHECK (length(plan_digest) = 71 AND substr(plan_digest, 1, 7) = 'sha256:'),
  corpus_identity_digest TEXT NOT NULL
    CHECK (length(corpus_identity_digest) = 71
      AND substr(corpus_identity_digest, 1, 7) = 'sha256:'),
  utterance_hash TEXT NOT NULL CHECK (length(utterance_hash) = 64),
  prompt_sha256 TEXT NOT NULL CHECK (length(prompt_sha256) = 64),
  request_builder_version TEXT NOT NULL CHECK (trim(request_builder_version) != ''),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
  provider TEXT NOT NULL CHECK (trim(provider) != ''),
  model TEXT NOT NULL CHECK (trim(model) != ''),
  usage_category TEXT NOT NULL CHECK (trim(usage_category) != ''),
  predicted_domain TEXT NOT NULL CHECK (trim(predicted_domain) != ''),
  predicted_skill TEXT CHECK (predicted_skill IS NULL OR trim(predicted_skill) != ''),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  api_usage_id INTEGER NOT NULL,
  run_id TEXT NOT NULL CHECK (trim(run_id) != '' AND length(run_id) <= 160),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (
    runtime_sha,
    artifact_digest,
    corpus_identity_digest,
    utterance_hash,
    prompt_sha256,
    request_builder_version,
    request_sha256,
    provider,
    model,
    usage_category
  ),
  FOREIGN KEY (api_usage_id) REFERENCES api_usage(id) ON DELETE RESTRICT,
  FOREIGN KEY (runtime_sha, artifact_digest, run_id)
    REFERENCES routing_manifest_skill_refresh_runs(runtime_sha, artifact_digest, run_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (
    plan_digest, corpus_identity_digest, runtime_sha, artifact_digest, run_id
  )
    REFERENCES routing_manifest_skill_refresh_plan_claims(
      plan_digest, corpus_identity_digest, runtime_sha, artifact_digest, run_id
    ) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_routing_manifest_skill_cache_usage
  ON routing_manifest_skill_classify_cache(api_usage_id);
