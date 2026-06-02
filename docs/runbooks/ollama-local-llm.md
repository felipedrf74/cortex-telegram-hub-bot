# Ollama Local LLM Runbook

**Owners:** Felipe (operator) · Claude Code session 2026-05-26 (install + smoke)
**Related:** `docs/qa/work-orders/WO-ollama-local-llm.md` · `docs/qa/prompts/codex-ollama-local-llm-qa.md`
**Plan (approved):** `/home/dominguez/.claude/plans/you-are-claude-code-frolicking-panda.md` (Revision 4, final)

> **NOTE ON THIS FILE'S LIFECYCLE.** This runbook lives in the deployed copy
> at `/home/dominguez/telegram-hub-bot/docs/runbooks/`. The next `rsync` deploy
> from the Mac source repo will overwrite this directory. **Mirror this file
> into the Mac source repo** at the equivalent path and commit so it survives
> deploys. Same applies to `scripts/install-ollama.sh`,
> `scripts/staging-smoke-ollama.sh`,
> `docs/qa/work-orders/WO-ollama-local-llm.md`, and
> `docs/qa/prompts/codex-ollama-local-llm-qa.md`.

## Purpose

Run a local Ollama daemon on the production VPS to absorb `classify`, `scriptGeneration`, and `localReasoning` workloads at zero marginal cost and zero data-egress, while keeping cloud providers (Gemini/OpenAI/Anthropic) as quality-gated and privacy-gated fallbacks.

---

## Pre-implementation audit findings (2026-05-26)

These findings are captured here because the Mac-side TypeScript implementation must respect them. They inform A1, A2, A5, and migration items 12/13 of the plan.

| Audit item | Finding | Implication |
|---|---|---|
| `zod`, `zod-to-json-schema`, `tsx` in `package.json` | **None present** | (a) Add `zod` as a dep for `script-generation.ts` schema validation — small, widely used, type-safe. (b) Skip `zod-to-json-schema` — hand-write the JSON schemas inline (they're short and stable). (c) `tsx` works via `npx tsx` shebang per `scripts/cost-baseline.ts`; no install needed for `scripts/llm/*.ts`. |
| PM2 `instances` in `ecosystem.config.js` | `instances: 1` (hardcoded with comment: "CRITICAL: only 1 instance — Telegram long-polling allows only one") | Single-instance posture already correct. `LOCAL_LLM_QUEUE_BACKEND=memory` is safe. A5 fail-fast and A6 deploy-time check are defensive — they should never trigger in current deployment but stay as guards. |
| Migration runner ALTER TABLE behavior | **Already PRAGMA-guards**: `src/services/database.ts:204` logs a warning and skips when `ADD COLUMN` is duplicate. | R3 item 12's "small EDIT to migration runner" becomes a **no-op confirmation** — no code change to `database-migrations.ts`. The new migration file `migrations/0XX_local_request_units.sql` can be a plain `ALTER TABLE ADD COLUMN`. |
| `api_usage` write path | Each provider writes its own row (`openai-provider.ts:161`, `gemini-provider.ts:123`, `api-usage-fallback.ts:65`). | Per-provider pattern. New `OllamaProvider` follows the same pattern: writes its own row with `provider='ollama'`, `cost_usd=0`, `pricing_status='zero-cost'`, `local_request_units=1`. Single-writer invariant (A2) maintained as long as no upstream wrapper ALSO writes for the same call. |
| TS script runner pattern | `scripts/cost-baseline.ts` uses `#!/usr/bin/env npx tsx` shebang. | Use the same shebang for `scripts/llm/*.ts`. No `tsx` dep needed in `package.json`. |

---

## Install

Run on the VPS (requires `sudo`):

```bash
bash /home/dominguez/telegram-hub-bot/scripts/install-ollama.sh
```

The script:
1. Pre-flight: asserts ≥ 40 GB free on `/`, prints RAM total.
2. Installs Ollama if missing (`curl -fsSL https://ollama.com/install.sh | sh`).
3. Creates `/var/lib/ollama/models` and chowns to `ollama:ollama`.
4. Writes `/etc/systemd/system/ollama.service.d/override.conf` with the operator-approved daemon flags and resource limits.
5. `systemctl daemon-reload && enable --now ollama && restart ollama`.
6. Waits for `/api/version` to come up (up to 30 s).
7. **Loopback-bind verification** via `ss -ltnH` — fails if anything binds to a non-loopback address on :11434.
8. Pulls primary model `qwen3.6:35b-a3b-q4_K_M` (fatal on failure — no silent substitution).
9. Pulls operational-rollback model `qwen3.6:27b-q4_K_M` (fatal on failure — runbook depends on it being pre-pulled).
10. One smoke `/api/chat` round-trip with `think:false`, `num_predict=16`, `temperature=0`, `Content-Type: application/json`.

### Tunables (env vars accepted by the install script)

| Var | Default | Notes |
|---|---|---|
| `OLLAMA_PRIMARY_MODEL` | `qwen3.6:35b-a3b-q4_K_M` | Primary model tag. |
| `OLLAMA_OPERATIONAL_ROLLBACK_MODEL` | `qwen3.6:27b-q4_K_M` | Pre-pulled for fast manual rollback (NOT auto-retry). |
| `OLLAMA_MEMORY_HIGH` | `25G` | Soft pressure; kernel reclaims pages. |
| `OLLAMA_MEMORY_MAX` | `28G` | Hard cap; daemon OOM-killed at this RSS. |
| `OLLAMA_MEMORY_SWAP_MAX` | `1G` | Blocks runaway swap thrash on CPU-only host. |
| `OLLAMA_CONTEXT_LENGTH` | `8192` | Promote to `16384` only after benchmark proves no swap I/O. |
| `OLLAMA_MAX_QUEUE` | `8` | Daemon-side queue depth. |
| `OLLAMA_LOAD_TIMEOUT` | `15m` | Cold load timeout for 24 GB weights off NVMe. |
| `OLLAMA_NICE` | `5` | Cooperate with nexus-hub and content-engine. |
| `OLLAMA_CPUWEIGHT` | `70` | Same. |
| `REQUIRED_FREE_GB` | `40` | Pre-flight disk gate. |

Re-runnable safely: `daemon-reload` + `restart` on each run; pulls are idempotent.

---

## Verify

```bash
# Daemon up?
curl -s http://127.0.0.1:11434/api/version

# Loaded models?
curl -s http://127.0.0.1:11434/api/ps | jq .

# Loopback only?
ss -ltnp | grep ':11434'   # must show ONLY 127.0.0.1:11434

# Models on disk?
ollama list

# systemd resource limits?
systemctl show ollama.service | grep -E '^(MemoryHigh|MemoryMax|MemorySwapMax|Restart|Nice|CPUWeight)='
```

After the backend deploys with `OLLAMA_ENABLED=true`:

```bash
curl -s http://127.0.0.1:8200/health/detailed | jq '.providers.ollama'
# Expected: { healthy: true, latencyMs: <num>, queueDepth: 0, ... }
```

---

## Phased rollout

### Phase 0 — Install (done by this runbook)
- `bash scripts/install-ollama.sh`. Verify daemon + loopback + both models + smoke.

### Phase 1 — Provider enable (after Mac code lands and deploys)
- `.env`: `OLLAMA_ENABLED=true`. Routing knobs left at cloud defaults.
- `pm2 restart nexus-hub`.
- Acceptance: `/health/detailed.providers.ollama.healthy === true`. No `api_usage` rows for `provider='ollama'` yet.

### Phase 2 — Shadow-evaluation only (NOT a routing flip)

> **v2.9 update (angry-QA finding):** the earlier wording of "Immediate
> local flip" contradicted the rest of the WO, which says the model is
> only EVALUATION-safe (5/5 schema-valid on a 5-case sample, 4/5
> domain-accuracy). Do NOT flip `AI_CLASSIFY_PRIMARY=ollama` in production
> until a wider-sample shadow eval (50+ real classify calls compared
> against the existing cloud provider) shows acceptable agreement. The
> Phase 2 actions below are STAGING-ONLY for that evaluation.
Add to `.env`:
```
AI_CLASSIFY_PRIMARY=ollama
AI_CLASSIFY_FALLBACK=gemini
AI_SCRIPT_GENERATION_PRIMARY=ollama
AI_SCRIPT_GENERATION_FALLBACK=none
AI_LOCAL_REASONING_PRIMARY=ollama
AI_LOCAL_REASONING_FALLBACK=approved_cloud_reasoning
LOCAL_LLM_EVALUATION_MODE=true
LOCAL_LLM_SHOW_PROVIDER_METADATA=true
AI_SCRIPT_GENERATION_REQUIRE_LOCAL=true
CLOUD_REASONING_FALLBACK_ENABLED=false
```
`pm2 restart nexus-hub`.

Acceptance: 5 classify calls land on ollama (`SELECT provider FROM api_usage ...`).
ScriptGeneration on CPU is realistically a 4–7-minute call; the smoke evidence
run shows 1/3 plan cases completing inside the (then) 5-min Node fetch ceiling.
For Phase 2 enablement, scriptGeneration is OPTIONAL — only flip
`AI_SCRIPT_GENERATION_PRIMARY=ollama` after you've confirmed latency tolerance
for your specific workload. localReasoning behaves similarly.

### Phase 3 — Evaluate real traffic (24–72 h)
Metrics to watch:
- Provider distribution per task type (`SELECT provider, COUNT(*) FROM api_usage WHERE ts >= datetime('now','-24 hours') GROUP BY category, provider`).
- Latency p50/p95/p99 from `duration_ms`.
- `script_generation_runs.validation_status` distribution.
- Invalid-JSON rate (from logger error_log tagged `invalid_json`).
- Queue wait p95 (logged per call by the provider).
- Memory pressure: `MemAvailable` and `pswpin`/`pswpout` deltas.
- Cloud fallback reasons (from `providerMetadata.fallbackReason` in logs).

Promote `OLLAMA_CONTEXT_LENGTH=16384` only after 24 h of zero `pswpin`/`pswpout` growth above the noise floor. Re-run install script with `OLLAMA_CONTEXT_LENGTH=16384` to apply.

### Phase 4 — Enable approved cloud reasoning fallback

> **v3.1 architectural pivot (Codex angry-QA round 6).** The
> `redacted_only` privacy mode is REMOVED. v3.0 shipped a
> deterministic regex PII scrubber (`staticRedactPrompt`); Codex
> reproduced raw AWS keys, IBANs, OpenSSH key markers, full names,
> and addresses reaching the cloud SDK boundary via PII classes the
> regex didn't anticipate. Structural finding: any "redact-then-
> forward" design treats unmatched bytes as safe, but PII coverage is
> infinite.
>
> v3.1 takes the honest posture: there is no redactor in the privacy
> path. `CLOUD_REASONING_PRIVACY_MODE` behaves as follows on requests
> marked `containsPrivateData=true`:
>
> | mode + flags | Behavior |
> |---|---|
> | `mode=never` | REJECT (privacy_never) — unchanged |
> | missing `allowCloudEscalation` | REJECT (request_disallows_cloud) — unchanged |
> | `mode=redacted_only` (any flags) | **REJECT (redaction_unsupported)** — v3.1 change; operator should migrate to `allow_raw` + opt-in, or stay on `never` |
> | `mode=allow_raw` + `allowRawPrivateData=true` + `allowCloudEscalation=true` | FORWARD raw |
> | any other combo with private data | REJECT (privacy_default_block) |
>
> Callers that have already redacted their content BEFORE calling the
> gate should pass `containsPrivateData=false` — that signals the
> operator has taken responsibility for redaction, and the gate
> forwards raw without further checks.

After enough Phase-3 data to trust local-first:
- Pick `CLOUD_REASONING_MODEL` (e.g., `gemini-2.5-pro` or `claude-sonnet-4-6` if Anthropic is re-enabled).
- `.env`:
  ```
  CLOUD_REASONING_FALLBACK_ENABLED=true
  CLOUD_REASONING_PROVIDER=gemini    # or anthropic
  CLOUD_REASONING_MODEL=gemini-2.5-pro
  APPROVED_REASONING_MODELS=gemini-2.5-pro,claude-sonnet-4-6
  # Pick ONE of:
  CLOUD_REASONING_PRIVACY_MODE=never       # block all private cloud escalation (safest)
  # CLOUD_REASONING_PRIVACY_MODE=allow_raw # forward raw — also set CLOUD_REASONING_ALLOW_RAW_PRIVATE_DATA=true
  LOCAL_LLM_EVALUATION_MODE=false
  ```
- `pm2 restart nexus-hub`.
- Acceptance: a deliberately complex `localReasoning` request that the local model marks `requires_cloud_reasoning=true` AND is marked `containsPrivateData=false` AND has `allowCloudEscalation=true` escalates; `providerMetadata` shows `fallbackUsed=true`, `providerUsed='<cloud>'`, `modelUsed='gemini-2.5-pro'`, `privacyAction='sent_raw'` (proves `modelOverride` works).

---

## Monitor

### Daily glance
```bash
# Provider distribution last 24 h
sqlite3 ./data/cortex.db "SELECT provider, category, COUNT(*) AS n, ROUND(AVG(duration_ms)) AS avg_ms FROM api_usage WHERE ts >= datetime('now','-24 hours') GROUP BY provider, category ORDER BY provider, n DESC;"

# Local cost saved (rough)
sqlite3 ./data/cortex.db "SELECT SUM(local_request_units) AS local_calls FROM api_usage WHERE provider='ollama' AND ts >= datetime('now','-24 hours');"

# Script-gen validation status mix
sqlite3 ./data/cortex.db "SELECT validation_status, COUNT(*) FROM script_generation_runs WHERE ts >= strftime('%s','now','-24 hours') GROUP BY validation_status;"
```

### Real-time pressure
```bash
# RSS + swap deltas during inference
watch -n 2 "free -m; cat /proc/vmstat | grep -E 'pswpin|pswpout'"

# Loaded model + KV cache footprint
curl -s http://127.0.0.1:11434/api/ps | jq .

# systemd memory accounting (live)
systemctl status ollama --no-pager | grep -E 'Memory|Tasks'
```

### Cold-load vs warm-generation
Look in `providerMetadata`: `isColdLoad=true` flags a load that took > 1 s. Frequent cold loads despite `OLLAMA_KEEP_ALIVE=-1` mean the daemon has been restarted or another model preempted (shouldn't happen with `OLLAMA_MAX_LOADED_MODELS=1`, but worth checking).

---

## Rollback

| Tier | Action | Recovery time | Use when |
|---|---|---|---|
| 1 | Flip one task primary back to cloud, e.g. `AI_CLASSIFY_PRIMARY=gemini`, then `pm2 restart nexus-hub` | ~5 s | One task type's quality regressed |
| 1b | **Primary local chat/script model alternate**: `sed -i 's/^OLLAMA_MODEL=.*/OLLAMA_MODEL=qwen3.6:27b-q4_K_M/' .env && pm2 restart nexus-hub`. Do **not** change `OLLAMA_CLASSIFIER_MODEL` here; classifier rollback is Tier 1 (`AI_CLASSIFY_PRIMARY=gemini`) or the Option-3 small-model Tier 1b below. Optional systemd retune: `OLLAMA_MEMORY_HIGH=20G OLLAMA_MEMORY_MAX=23G bash scripts/install-ollama.sh` | ~5 s + warm-load | Main local chat/script generation has OOM, swap thrash, or generation_tokens_per_sec < 1 sustained |
| 2 | `OLLAMA_ENABLED=false`, `pm2 restart nexus-hub` | ~5 s | Provider system-wide failure |
| 3 | `sudo systemctl stop ollama` | ~2 s | Daemon-level instability — circuit breaker + rate limiter handle the rest |
| 4 | Revert PR + redeploy via `scripts/promote-to-prod.sh` | minutes | Code-level regression env flips can't fix |

---

## Common failures

### "Ollama daemon not up after install"
```bash
sudo journalctl -u ollama -n 100 --no-pager
sudo systemctl status ollama --no-pager
# Common causes: port 11434 already bound (check ss), MemoryMax too low (OOM during load), models dir permissions.
```

### "OOM kill" or "manifest not found"
```bash
# OOM
sudo journalctl -u ollama --since '1 hour ago' | grep -iE 'oom|kill|signal 9'
# → tier-1b rollback to 27B.

# Manifest not found (only when re-pulling)
ollama list                                # what's there?
sudo cat /tmp/ollama-pull-primary.log      # what the install said
# → confirm tag still exists in upstream library; substitute if needed via OLLAMA_PRIMARY_MODEL env override.
```

### "Swap thrash during inference"
```bash
# Sample pswpin/pswpout over the call
before=$(awk '/^pswpin/{a=$2} /^pswpout/{b=$2} END{print a,b}' /proc/vmstat)
# ... trigger a call ...
after=$(awk '/^pswpin/{a=$2} /^pswpout/{b=$2} END{print a,b}' /proc/vmstat)
echo "delta: $before -> $after"
# If both deltas grow by >> 1000 pages, the model is paging.
# → tier-1b rollback or drop OLLAMA_CONTEXT_LENGTH to 4096.
```

### "Invalid JSON loop"
- Check `script_generation_runs.meta_json` for the failing prompt structure.
- Confirm the JSON schema sent to Ollama matches what the Zod schema validates. Mismatches between optional/required fields are the most common drift.

### "Daemon restart mid-request → ECONNRESET"
- Expected; `provider-fallback.ts:isRetryableError` retries via the configured fallback (classify→gemini). No action needed unless it's continuous (then the restart loop is the real problem — check `journalctl`).

### "Cloud reasoning gate keeps rejecting"
- `/health/detailed` providerMetadata warnings will say the reason. Common: `configured_cloud_model_matches_disallowed_substring` (operator set `CLOUD_REASONING_MODEL=gemini-2.5-flash` thinking "flash is fast"; gate rejects because `flash` is disallowed for complex reasoning). Switch to `gemini-2.5-pro` or `claude-sonnet-4-6`.

---

## Diagnostics quick-dump

```bash
# All-in-one
{
  echo '=== ollama version ==='; curl -s http://127.0.0.1:11434/api/version
  echo; echo '=== loaded models ==='; curl -s http://127.0.0.1:11434/api/ps | jq .
  echo; echo '=== systemctl ==='; systemctl status ollama --no-pager | head -30
  echo; echo '=== systemd memory ==='; systemctl show ollama.service | grep -E '^(Memory|Tasks|CPU)'
  echo; echo '=== /proc/meminfo ==='; grep -E 'MemTotal|MemAvailable|SwapTotal|SwapFree' /proc/meminfo
  echo; echo '=== /proc/vmstat (swap) ==='; grep -E 'pswpin|pswpout' /proc/vmstat
  echo; echo '=== journalctl tail ==='; sudo journalctl -u ollama -n 50 --no-pager
} > /tmp/ollama-diag-$(date +%Y%m%d-%H%M%S).txt
```

---

## When to promote `OLLAMA_CONTEXT_LENGTH` 8K → 16K

Rule of thumb: after 24 h of zero `pswpin`/`pswpout` growth above the noise floor (call it < 100 pages per 5-min sample). Then:
```bash
OLLAMA_CONTEXT_LENGTH=16384 bash scripts/install-ollama.sh
```
The script's tunables let this be a single-command bump.

---

## Promote context (escape hatch)

If a use case needs more than 8 K tokens before the 24-h soak completes, the API call itself can override per-request via Ollama's `options.num_ctx`. But `OLLAMA_CONTEXT_LENGTH` caps the daemon-side default; per-request `num_ctx` above the cap is silently clamped. So promote the cap deliberately, not per-request.

---

# Option 3 — Dedicated small classifier (2026-05-26 late evening)

Phase K shipped the 35B-A3B model as Nexus Hub's local LLM for script-generation and local-reasoning. The classify path briefly ran through 35B too (when `AI_CLASSIFY_PRIMARY=ollama` was set), but the ~1032-token classifier prompt × 35B on this CPU = 50–60s wall-clock per classify, which made chat unusable. Codex flagged this as F-new-5.

Option 3 fixes the problem architecturally: load a small dedicated classifier model (`qwen2.5:3b-instruct-q4_K_M`, 1.9 GB) alongside the 35B. The classifier runs in 1.5–2.0s warm; the 35B stays reserved for script-gen / local-reasoning paths that aren't user-blocking. The cutover from Gemini → Ollama for classify is gated on shadow-eval comparison (live Gemini + fire-and-forget Ollama, logged to `classify_shadow_runs`), then manual operator review per O3-A24.

## State (2026-05-26 23:04 UTC)

| Setting | Value | Source |
|---------|-------|--------|
| `AI_CLASSIFY_PRIMARY` | `gemini` | Step 1 stop-gap (rollback from `ollama` to recover from 60s latency) |
| `OLLAMA_CLASSIFIER_MODEL` | `qwen2.5:3b-instruct-q4_K_M` | Stage 3A |
| `OLLAMA_CLASSIFIER_PROMPT_VERSION` | `v1` | Step 4a — compact <400-token prompt |
| `LOCAL_LLM_CLASSIFY_SHADOW` | `true` | Step 5 — fire-and-forget Ollama classify alongside live Gemini |
| `OLLAMA_MAX_LOADED_MODELS` | `1` (systemd) | Stage 3A — daemon swaps on-demand. Stage 3B `=2` is OPTIONAL and gate-driven. |
| `CLASSIFY_SHADOW_HASH_SECRET` | (generate-once 256-bit hex) | Step 5 — preserve on every deploy (O3-A20). |
| `LOCAL_LLM_CLASSIFY_SHADOW_MAX_IN_FLIGHT` | `1` | Shadow concurrency cap |
| `LOCAL_LLM_CLASSIFY_SHADOW_MAX_QUEUE` | `4` | Over-capacity shadow calls dropped silently |
| `CLASSIFY_SHADOW_RETENTION_DAYS` | `30` | Daily prune at 04:17 UTC; manually-reviewed rows exempt |
| `OLLAMA_CLASSIFIER_NUM_CTX` | `2048` | Classifier-specific Ollama option |
| `OLLAMA_CLASSIFIER_NUM_PREDICT` | `32` | JSON output is ~20 tokens; cap at 32 |
| `OLLAMA_CLASSIFY_TIMEOUT_MS` | `5000` | Shadow path AbortController timeout |
| `OLLAMA_CLASSIFIER_MIN_CONFIDENCE` | `0.65` | Non-tool-domain confidence floor (used post-cutover) |
| `OLLAMA_CLASSIFIER_TOOL_DOMAIN_MIN_CONFIDENCE` | `0.80` | Higher bar for secretary/triathlon |

## Model license — review BEFORE production cutover (O3-A16)

Per Operator amendment O3-A16, verify the active classifier model's
license is acceptable for Nexus Hub's distribution / commercial policy
BEFORE flipping `AI_CLASSIFY_PRIMARY=ollama`.

- **`qwen2.5:3b-instruct-q4_K_M`** (default — current Stage 3A) and
  **`qwen2.5:72b-instruct`** are under the **Qwen license**, NOT
  Apache 2.0. Read the Qwen license at
  <https://huggingface.co/Qwen/Qwen2.5-3B-Instruct/blob/main/LICENSE>
  before declaring production-acceptable. The Qwen license has terms
  around commercial use, redistribution attribution, and downstream
  modification that differ from Apache 2.0.
- The rest of the Qwen2.5 family (`qwen2.5:0.5b/1.5b/7b/14b/32b`) is
  **Apache 2.0** — `qwen2.5:1.5b-instruct-q4_K_M` (1.0 GB, slightly
  lower-quality than 3B) is the natural Apache fallback if the 3B
  Qwen license is unacceptable.
- **`gemma2:2b-instruct-q4_K_M`** (Tier 1b alternative) is under the
  **Gemma Terms of Use** — read <https://ai.google.dev/gemma/terms>
  before adopting. Gemma terms are commercial-friendly but include
  prohibited-use language Nexus Hub must agree with.

If the operator decides the Qwen 3B license is not acceptable, the
rollback path is:
1. `ollama pull qwen2.5:1.5b-instruct-q4_K_M` (Apache 2.0) OR
   `ollama pull gemma2:2b-instruct-q4_K_M` (Gemma terms).
2. Replace `OLLAMA_CLASSIFIER_MODEL` in `.env` via the O3-A10 safety
   pattern (replace-or-append, never duplicate).
3. Re-run `scripts/llm/classifier-golden-eval.ts` against the new
   model — the Apache 1.5B and Gemma 2B both fall outside the golden
   set used to validate Qwen 3B; expect a fresh eval cycle.
4. PM2 restart `nexus-hub`.

This decision is **deferred until cutover** — the shadow window only
fires Ollama as a non-blocking secondary, so the Qwen license is not
yet a production-blocker. It IS a hard gate before
`AI_CLASSIFY_PRIMARY=ollama` flips.

## Shadow eval review SQL (operator workflow)

Real shadow rows accumulate as production traffic flows. Periodically (≥50 calls in), the operator runs the review SQL:

```sql
-- Inspect unreviewed disagreements:
SELECT id, request_id, message_hash, ollama_model, ollama_prompt_version,
       gemini_domain, gemini_confidence, gemini_duration_ms,
       ollama_domain, ollama_confidence, ollama_duration_ms, ollama_error
FROM classify_shadow_runs
WHERE agree=0 AND manually_reviewed=0
ORDER BY ts ASC;

-- For each row, retrieve the original message via request_id:
--   SELECT * FROM audit_trail WHERE request_id = ?;
-- Then label:
UPDATE classify_shadow_runs
SET manually_reviewed=1,
    manual_review_verdict='gemini_correct|ollama_correct|both_wrong|either_acceptable'
WHERE id = ?;
```

Cutover gate (replaces the naïve `agree_pct >= 90` of an earlier draft):
```sql
SELECT
  COUNT(*) AS n,
  SUM(CASE WHEN manually_reviewed=0 AND agree=0 THEN 1 ELSE 0 END) AS unreviewed_disagreements,
  ROUND(100.0 * (
    SUM(agree)
    + SUM(CASE WHEN manually_reviewed=1 AND manual_review_verdict IN ('ollama_correct','either_acceptable') THEN 1 ELSE 0 END)
  ) / COUNT(*), 1) AS effective_agree_pct,
  ROUND(AVG(ollama_duration_ms)) AS ollama_avg_ms,
  MAX(ollama_duration_ms) AS ollama_max_ms,
  SUM(CASE WHEN ollama_error IS NOT NULL THEN 1 ELSE 0 END) AS errors
FROM classify_shadow_runs;

-- Tool-domain recall (must be ≥95% per O3-A24):
SELECT gemini_domain, COUNT(*) AS total,
       SUM(CASE WHEN agree=1 OR manual_review_verdict='either_acceptable' THEN 1 ELSE 0 END) AS recalled,
       ROUND(100.0 * SUM(CASE WHEN agree=1 OR manual_review_verdict='either_acceptable' THEN 1 ELSE 0 END) / COUNT(*), 1) AS recall_pct
FROM classify_shadow_runs
WHERE gemini_domain IN ('secretary','triathlon') AND manually_reviewed=1
GROUP BY gemini_domain;
```

Cutover pass criteria (ALL):
- `n >= 50`
- `unreviewed_disagreements = 0`
- `effective_agree_pct >= 90`
- Tool-domain recall ≥ 95% (secretary, triathlon)
- `ollama_avg_ms <= 3000`
- `errors/n < 0.05`

Pass → `AI_CLASSIFY_PRIMARY=ollama` + PM2 restart. Fail → stay on Gemini; iterate on prompt or try `gemma2:2b-instruct-q4_K_M` (Tier 1b).

## Golden-set offline eval

`scripts/llm/classifier-golden-eval.ts` runs 120 reviewer-decided examples (`data/classifier-golden-set.json`) directly against the Ollama daemon. Per O3-A24, the golden labels are reviewer truth — NOT Gemini output. Use this before each prompt or model change to catch regressions in <5 minutes.

Most recent run (2026-05-26 23:09 UTC, qwen2.5:3b, prompt v1):
- Overall 95% (gate ≥92%) ✓
- Per-domain precision 100% on secretary, triathlon, content, cooking ✓
- Failed gates: secretary recall 87.5% / triathlon recall 92% / finance precision 79.3% / ambiguous 60% / p95 3816ms
- Failures clustered on budget/cost keyword overlap → finance attractor

Real production shadow data will give a more accurate picture than the golden set's intentionally-ambiguous edge cases.

## Stage 3B — both models resident (OPTIONAL, gate-driven)

Stage 3A keeps `OLLAMA_MAX_LOADED_MODELS=1`. The daemon swaps models on-demand when a different model is requested. For the shadow window — where Phase K is rolled back and 35B isn't actually serving production chat — this is fine.

Promote to Stage 3B (`=2`) ONLY when ALL gates pass:
- `MemAvailable >= 1.5 GB` after both models warmed
- `pswpin + pswpout` delta < 200 over 5 classify smokes
- `nexus-hub` PM2 status remains online

```bash
# Read active models from .env first (O3-A22 — do NOT hardcode 35B):
ACTIVE_MAIN=$(grep '^OLLAMA_MODEL=' .env | cut -d= -f2-)
ACTIVE_CLASS=$(grep '^OLLAMA_CLASSIFIER_MODEL=' .env | cut -d= -f2-)
sudo OLLAMA_MAX_LOADED_MODELS=2 bash scripts/install-ollama.sh
curl -s http://127.0.0.1:11434/api/chat -d "{\"model\":\"$ACTIVE_MAIN\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"keep_alive\":-1,\"options\":{\"num_predict\":4}}" -H "Content-Type: application/json" >/dev/null
curl -s http://127.0.0.1:11434/api/chat -d "{\"model\":\"$ACTIVE_CLASS\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"keep_alive\":-1,\"options\":{\"num_predict\":4}}" -H "Content-Type: application/json" >/dev/null
curl -s http://127.0.0.1:11434/api/ps | jq '[.models[].name]'
# Expected: both names present.
free -g       # MemAvailable >= 1.5 GB
cat /proc/vmstat | grep ^pswp   # delta should be near zero over a smoke window
```

Memory cap bumps (`MemoryHigh=27G`, `MemoryMax=29G`) are SEPARATE from Stage 3B and require their own justification — only if Stage 3B baseline shows OOM-killer risk.

## Rollback (per O3-A15)

| Tier | Trigger | Action |
|------|---------|--------|
| 1 | Small model accuracy unacceptable in shadow | `AI_CLASSIFY_PRIMARY=gemini` (already the state) |
| 1b | Try alternate small model | `OLLAMA_CLASSIFIER_MODEL=gemma2:2b-instruct-q4_K_M` + restart, re-run golden eval |
| 1c | Restrict 35B to offline only | `LOCAL_LLM_CLASSIFY_SHADOW=false`, do not enable Ollama classify |
| 2 | Memory pressure | Stay at `OLLAMA_MAX_LOADED_MODELS=1` (default) |
| 3 | Post-cutover quality regression | Flip `AI_CLASSIFY_PRIMARY=gemini`; shadow stays for diagnostics |
| 4 | Code regression | Restore `dist-pre-option-3` snapshot, PM2 restart |

DO NOT use the primary large model on the live classify path as a "rollback"; that path has unusable chat latency.

## Pending after Option 3

1. Real shadow accumulation — wait for ≥50 production classify calls.
2. Operator manual review of disagreements per O3-A24.
3. Cutover decision based on the review SQL.
4. Mac source-of-truth sync — see `docs/qa/work-orders/WO-ollama-local-llm-mac-handoff.md` Option-3 section.
