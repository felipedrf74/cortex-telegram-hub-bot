# Codex QA Prompt — Option 3 (Dedicated small classifier on Ollama)

This prompt drives an independent QA pass against the merged
Option-3 candidate commit. Each item maps 1:1 to a numbered
acceptance criterion in the approved plan (25 items total: Round 1
O3-A1..A16 + Round 2 O3-A17..A24). Codex should verify each item
against the actual code, the running staging deploy, the running
production deploy, and the SQLite database. Report PASS/FAIL with the
evidence command output for each item.

## Scope and intent

Option 3 changes the classifier path. The 35B-A3B model that Phase K
left on the chat / script-generation paths is unchanged. Specifically
Option 3:

1. Pulls a small dedicated classifier model
   (`qwen2.5:3b-instruct-q4_K_M`, ~1.9 GB).
2. Wires a fire-and-forget shadow-eval that runs Ollama classify
   alongside the live Gemini classify, comparing outputs in a new
   `classify_shadow_runs` table.
3. Adds a `ClassifyOptions` interface across all 4 providers
   (Gemini/OpenAI/Anthropic/Ollama) with `source`, `recordUsage`,
   `timeoutMs`, `abortSignal`.
4. Plumbs the abort signal through to the underlying `fetch()` so
   timeouts actually cancel daemon-side generation.
5. Compacts the classifier prompt for Ollama from ~1032 tokens to
   <400 tokens, versioned by `OLLAMA_CLASSIFIER_PROMPT_VERSION`.
   Two versions ship: `v1` (initial compact, 95% golden-eval) and
   `v2` (post-eval refinement with budget/price disambiguation,
   99.2% golden-eval, fixes 4 of 5 v1 gate failures). Production
   stays on `v1` until Mac sync lands; operator flips to `v2` after.
6. Adds a daily retention prune cron.
7. Keeps live classify on Gemini until shadow data and manual review
   per O3-A24 unblock a cutover.

Things Option 3 does NOT change:
- `AI_DOMAIN_PROVIDER_OVERRIDES` is still empty in production (Phase K
  rollback). Cooking/content/finance still route to Gemini.
- Secretary/triathlon still bypass Ollama via the Phase K runtime
  hard-block.
- The 35B-A3B model is still loaded for script-gen / local-reasoning.

## Setup

```
# On Mac after pulling the Option-3 patch:
cd cortex-telegram-hub-bot
git checkout <option-3-candidate-commit>
npm ci
npx tsc --noEmit
npx vitest run __tests__/services/option-3-classifier.test.ts \
               __tests__/services/ollama-provider.test.ts \
               __tests__/services/provider-fallback.test.ts \
               __tests__/services/domain-provider-router.test.ts
```

If any of those four fail, stop and report — the candidate commit
isn't even L1.

Then deploy candidate through the normal pipeline:
```
bash scripts/deploy-staging.sh
sleep 300
bash scripts/staging-smoke.sh
```

VPS reference state (where Codex can `ssh` to verify production):
- `/home/dominguez/telegram-hub-bot/` — production
- `/home/dominguez/telegram-hub-bot-staging/` — staging
- `/home/dominguez/snapshots/pre-ollama-v3.2-20260526-164248/option-3/` — pre-Option-3 snapshots (env, source, dist, patch)

## Acceptance verification (25 items)

### Round 1 — O3-A1..A16

### 1. Shadow Ollama classify NEVER blocks the live Gemini response (O3-A1).
```
grep -n "runOllamaShadowClassification" src/router/classifier.ts
# Expected: `void runOllamaShadowClassification(...)` with .catch — fire-and-forget.
grep -n "await runOllamaShadowClassification" src/router/classifier.ts
# Expected: ZERO matches. Any `await` here is a regression.

# End-to-end timing check:
# Send a synthetic classify, measure round-trip vs same call with shadow OFF.
# Expected: identical latency within noise (shadow adds ~0ms to user response).
```

### 2. Shadow rows do not store raw or lightly-previewed message text; HMAC hash only (O3-A5).
```
grep -n "message_preview_redacted" migrations/171_classify_shadow_runs.sql
# Expected: column declared but always NULL on insert.
grep -n "message_preview_redacted" src/services/classify-shadow.ts
# Expected: NOT populated in any INSERT/UPDATE.

sqlite3 staging-db "SELECT message_hash, message_preview_redacted FROM classify_shadow_runs LIMIT 5;"
# Expected: message_hash is 64-char lowercase hex; message_preview_redacted is NULL for every row.
```

### 3. Shadow calls do not consume per-user local LLM rate-limit quota (O3-A12 OPTION 1).
```
grep -n "recordUsage" src/services/ollama-provider.ts
# Expected: `if (recordUsage)` guards both checkAndConsumeLocalLLMRateLimit AND logOllamaUsage.

# Live check:
sqlite3 staging-db "SELECT COUNT(*) FROM api_usage WHERE category='classify_shadow';"
# Expected: 0 (O3-A12 OPTION 1 — no api_usage rows at all for shadow).

# Quota check: send 200 classify calls (live Gemini, shadow Ollama).
# Confirm via local_llm_call_log or equivalent that the per-user daily
# call-count is NOT incremented by 200.
```

### 4. Classifier output uses strict enum schema with `additionalProperties=false` (O3-A6).
```
grep -n "CLASSIFICATION_JSON_SCHEMA\|additionalProperties" src/services/ollama-provider.ts
# Expected: schema with `enum: [secretary, triathlon, content, finance, cooking]`
# AND `additionalProperties: false` AND `required: [domain, confidence]`.

# Same schema must appear in scripts/llm/classifier-golden-eval.ts:
grep -n "additionalProperties" scripts/llm/classifier-golden-eval.ts
# Expected: same strict-format schema.
```

### 5. Invalid JSON / low confidence / timeout / out-of-enum → Gemini fallback (O3-A7).
```
grep -n "LocalLLMError\|invalid_json\|capacity_exceeded" src/services/ollama-provider.ts
# Expected: schema-mismatch errors throw with retry-once-then-throw.
# TaskRoutingProvider.classify catches in executeWithFallback and routes to fallback.

# Confidence-based fallback (post-cutover):
grep -n "OLLAMA_CLASSIFIER_MIN_CONFIDENCE\|OLLAMA_CLASSIFIER_TOOL_DOMAIN_MIN_CONFIDENCE" \
  src/services/provider-fallback.ts src/services/ollama-provider.ts src/router/classifier.ts
# Expected: confidence read from env, low-confidence falls back to Gemini.
# NOTE: cutover-time logic. May still be only env-defined, not yet enforced —
# OK if `AI_CLASSIFY_PRIMARY=gemini` (current state).
```

### 6. Tool-domains require higher confidence (≥0.80) than non-tool (≥0.65) (O3-A7).
```
grep -nE 'OLLAMA_CLASSIFIER_TOOL_DOMAIN_MIN_CONFIDENCE=0\.8|=0\.80' .env
# Expected: present in production .env.
grep -nE 'OLLAMA_CLASSIFIER_MIN_CONFIDENCE=0\.65' .env
# Expected: present.
```

### 7. `OLLAMA_MAX_LOADED_MODELS=2` is verified in systemd override when Stage 3B applies (O3-A3, O3-A22).
```
grep -n "OLLAMA_MAX_LOADED_MODELS" scripts/install-ollama.sh
# Expected: `OLLAMA_MAX_LOADED_MODELS="${OLLAMA_MAX_LOADED_MODELS:-1}"` (parameterized).
# Stage 3A default 1 is fine. Stage 3B applies only if explicitly invoked.

ssh staging-vps 'systemctl show ollama.service | grep MAX_LOADED'
# Stage 3A (current): MAX_LOADED_MODELS=1.
# Stage 3B (if active): MAX_LOADED_MODELS=2.

# Verify O3-A22 — the install script must NOT hardcode 35B in Stage 3B prompts/docs:
grep -n "qwen3.6:35b-a3b-q4_K_M" scripts/install-ollama.sh
# Expected: present only in default PRIMARY_MODEL ENV var (line ~27).
# Stage 3B docs in runbook/handoff should read OLLAMA_MODEL/_CLASSIFIER_MODEL from .env, not hardcode.
```

### 8. `/api/ps` verification checks model names, not exact `expires_at` (O3-A13).
```
grep -n "expires_at" docs/runbooks/ollama-local-llm.md docs/qa/work-orders/WO-ollama-local-llm-mac-handoff.md scripts/staging-smoke-ollama.sh scripts/llm/local-llm-smoke.ts
# Expected: ZERO matches against `expires_at` as a verification condition.
# `.models[].name` is the canonical check.
```

### 9. Golden set passes BEFORE real shadow starts (O3-A8).
```
ls -la data/classifier-golden-set.json
# Expected: file exists with 120 examples (20/domain + 10 ambig + 10 followup).
test -x scripts/llm/classifier-golden-eval.ts
# Expected: executable shebang.

# Run golden eval; record results.
OLLAMA_BASE_URL=http://127.0.0.1:11434 OLLAMA_CLASSIFIER_MODEL=qwen2.5:3b-instruct-q4_K_M \
  npx tsx scripts/llm/classifier-golden-eval.ts
# Expected: at least overall ≥92%, no NaN failures, run JSON saved to data/classifier-golden-runs/.

# Last known result (2026-05-26 23:09 UTC): 95% overall, 5 gates failed
# (secretary/triathlon recall, finance precision, ambiguous, p95). These
# failures are acceptable per O3-A24 — real shadow + manual review is the
# actual cutover gate, not the golden set alone.
```

### 10. `ClassifyOptions` interface is added to ALL provider `classify()` signatures (O3-A11).
```
grep -n "options?: ClassifyOptions" src/services/ai-provider.ts \
                                     src/services/anthropic-provider.ts \
                                     src/services/openai-provider.ts \
                                     src/services/gemini-provider.ts \
                                     src/services/ollama-provider.ts \
                                     src/services/provider-fallback.ts
# Expected: all 6 files have classify(..., options?: ClassifyOptions).
grep -n "export interface ClassifyOptions" src/services/ai-provider.ts
# Expected: interface declared with userId, tenantId, requestId, source, recordUsage, timeoutMs, abortSignal.
```

### 11. `userId`/`tenantId` attributed correctly on ALL classify rows (F-new-6).
```
# Live: trigger a classify; check that the resulting api_usage row has user_id != 0.
sqlite3 staging-db "SELECT user_id, tenant_id, category, provider FROM api_usage WHERE category='classify_message' ORDER BY ts DESC LIMIT 3;"
# Expected: user_id matches the actual sender (not 0).

# Same check on classify_shadow_runs (note: shadow rows record user_id even though no api_usage written):
sqlite3 staging-db "SELECT user_id, tenant_id, gemini_domain, ollama_domain FROM classify_shadow_runs ORDER BY ts DESC LIMIT 3;"
# Expected: user_id is the same sender id (not 0).
```

### 12. Docs accurately describe post-Option-3 reality (F-new-7).
```
grep -n "Option 3\|classify_shadow_runs\|qwen2.5:3b" \
  docs/runbooks/ollama-local-llm.md \
  docs/ai/model-routing-current-state.md \
  docs/qa/work-orders/WO-ollama-local-llm-mac-handoff.md
# Expected: all three docs have Option-3 sections describing the
# shadow-eval architecture, cutover gates, and rollback tiers.

# Specifically the model-routing doc must clearly state the CURRENT effective state:
grep -nE "AI_CLASSIFY_PRIMARY.*gemini|classify.*gemini.*openai" docs/ai/model-routing-current-state.md
# Expected: current state explicitly described as gemini live + Ollama shadow.
```

### 13. Model license check (O3-A16).
```
# Verify the operator has acknowledged the qwen2.5:3b license (Qwen license, NOT Apache).
grep -ni "qwen license\|license" docs/qa/work-orders/WO-ollama-local-llm-mac-handoff.md docs/runbooks/ollama-local-llm.md
# Expected: at minimum a note mentioning the license status of the
# chosen classifier model. (If the operator hasn't, this is non-blocking
# documentation drift — flag as `minor`.)
```

### 14. Rollback tiers do NOT default to 35B classifier (O3-A15).
```
grep -nE "rollback.*35B|qwen3.6:35b.*classify|qwen3.6:35b-a3b.*classifier" \
  docs/runbooks/ollama-local-llm.md docs/qa/work-orders/WO-ollama-local-llm-mac-handoff.md
# Expected: ZERO matches. 35B at classify = 60s latency = unusable.
# Tier 1 must be `AI_CLASSIFY_PRIMARY=gemini`. Tier 1b is gemma2:2b.
```

### 15. Env-edit safety per O3-A10 (replace-or-append, no duplicates).
```
ssh production-vps 'grep -c "^AI_CLASSIFY_PRIMARY=" .env'
# Expected: 1 (not 0, not 2+).
ssh production-vps 'for k in OLLAMA_CLASSIFIER_MODEL OLLAMA_CLASSIFIER_MIN_CONFIDENCE OLLAMA_CLASSIFIER_TOOL_DOMAIN_MIN_CONFIDENCE OLLAMA_CLASSIFY_TIMEOUT_MS OLLAMA_CLASSIFIER_NUM_CTX OLLAMA_CLASSIFIER_NUM_PREDICT OLLAMA_CLASSIFIER_PROMPT_VERSION LOCAL_LLM_CLASSIFY_SHADOW LOCAL_LLM_CLASSIFY_SHADOW_MAX_IN_FLIGHT LOCAL_LLM_CLASSIFY_SHADOW_MAX_QUEUE CLASSIFY_SHADOW_RETENTION_DAYS CLASSIFY_SHADOW_HASH_SECRET; do echo "$k=$(grep -c "^$k=" .env)"; done'
# Expected: every count is exactly 1.
```

### 16. PII-safe storage (O3-A5 reinforce).
```
# Confirm no raw message text appears in classify_shadow_runs:
sqlite3 staging-db "SELECT message_preview_redacted FROM classify_shadow_runs WHERE message_preview_redacted IS NOT NULL LIMIT 1;"
# Expected: NULL or empty result set.
# Confirm message_hash is HMAC, not plain SHA — test determinism with two
# different `CLASSIFY_SHADOW_HASH_SECRET` values produces different hashes:
npx vitest run __tests__/services/option-3-classifier.test.ts -t "hmacSha256"
# Expected: hmac determinism + key-sensitivity tests pass.
```

### Round 2 — O3-A17..A24

### 17. Shadow uses `getProvider('ollama')` explicitly, NOT `getActiveProvider()` (O3-A17).
```
grep -n "getProvider\|getActiveProvider" src/services/classify-shadow.ts
# Expected: getProvider('ollama') for the actual classify call.
#           getActiveProvider() ONLY for the anti-recursion check (skip if active is ollama).

# Vitest:
npx vitest run __tests__/services/option-3-classifier.test.ts -t "O3-A17"
# Expected: passes — verifies explicit ollama lookup even when active is gemini.
```

### 18. Shadow timeout aborts the underlying Ollama HTTP request (O3-A18).
```
grep -n "abortSignal\|AbortController\|AbortSignal" \
  src/services/classify-shadow.ts \
  src/services/ollama-provider.ts \
  src/services/ai-provider.ts
# Expected:
#   - ai-provider.ts: ClassifyOptions has abortSignal?: AbortSignal
#   - ollama-provider.ts: callOllamaForTask accepts externalSignal,
#     ollamaChat composes externalSignal+timeout into fetch signal
#   - classify-shadow.ts: AbortController created, abort scheduled on
#     setTimeout(SHADOW_TIMEOUT_MS), cleared in finally

# Vitest verifies signal is wired and abort fires:
npx vitest run __tests__/services/option-3-classifier.test.ts -t "O3-A18"
# Expected: capturedSignal.aborted === true after timeout, ollama_duration_ms <= SHADOW_TIMEOUT_MS + tolerance.
```

### 19. Shadow does NOT recurse when live path is already Ollama (O3-A19).
```
grep -nE "active\?\.name === 'ollama'|startsWith\('routing\(ollama" src/services/classify-shadow.ts
# Expected: explicit early-return when getActiveProvider().name === 'ollama' (or
# its router string starts with 'routing(ollama').

# Vitest:
npx vitest run __tests__/services/option-3-classifier.test.ts -t "O3-A19"
# Expected: when mocked active is ollama, runOllamaShadowClassification
# returns immediately without inserting any row.

# Defense-in-depth — live classify path always passes source: 'live':
grep -n "source: 'live'" src/router/classifier.ts
# Expected: present on the user-facing classify call.
```

### 20. `CLASSIFY_SHADOW_HASH_SECRET` is generate-once; preserved on redeploy (O3-A20).
```
# Snapshot the current value:
ssh production-vps 'grep "^CLASSIFY_SHADOW_HASH_SECRET=" .env | sha256sum'
# Then simulate a redeploy of Step 5 (the env-population block):
ssh production-vps 'bash -lc "(cd /home/dominguez/telegram-hub-bot && \
   for kv in OLLAMA_CLASSIFIER_MODEL=qwen2.5:3b-instruct-q4_K_M; do \
     key=\${kv%%=*}; count=\$(grep -nc \"^\${key}=\" .env); echo \"\$key=\$count\"; \
   done; \
   count=\$(grep -nc \"^CLASSIFY_SHADOW_HASH_SECRET=\" .env); echo \"hash secret count=\$count (must be 1)\"; \
)"'
# Re-grep:
ssh production-vps 'grep "^CLASSIFY_SHADOW_HASH_SECRET=" .env | sha256sum'
# Expected: hashes match (secret preserved across the re-run).

# The deploy script logic must include an explicit "PRESERVE if exists" branch:
grep -n "PRESERVED\|preserving existing secret" docs/qa/work-orders/WO-ollama-local-llm-mac-handoff.md
# Expected: documented.
```

### 21. `classify_shadow_runs` schema includes O3-A21 + O3-A24 fields.
```
sqlite3 staging-db ".schema classify_shadow_runs"
# Expected fields:
#   request_id, schema_version, ollama_model, ollama_prompt_version, gemini_model,
#   manually_reviewed, manual_review_verdict, message_hash, message_preview_redacted,
#   gemini_domain, gemini_confidence, gemini_duration_ms,
#   ollama_domain, ollama_confidence, ollama_duration_ms, ollama_error, agree, ts, id, user_id, tenant_id

# Indexes:
sqlite3 staging-db ".indexes classify_shadow_runs"
# Expected: idx_classify_shadow_ts, idx_classify_shadow_agree,
#           idx_classify_shadow_request_id, idx_classify_shadow_review

# Inserted rows are populated:
sqlite3 staging-db "SELECT request_id, ollama_model, ollama_prompt_version, gemini_model, schema_version
                    FROM classify_shadow_runs ORDER BY ts DESC LIMIT 3;"
# Expected: all five non-null.
```

### 22. Stage 3B uses active model from .env, NOT hardcoded 35B (O3-A22).
```
grep -nE "qwen3.6:35b-a3b-q4_K_M|ACTIVE_MAIN|ACTIVE_CLASS|OLLAMA_MODEL.*cut -d" \
  docs/qa/work-orders/WO-ollama-local-llm-mac-handoff.md \
  docs/runbooks/ollama-local-llm.md
# Expected:
#   - Stage 3B install snippet reads ACTIVE_MAIN via `grep '^OLLAMA_MODEL=' .env`
#     and ACTIVE_CLASS via `grep '^OLLAMA_CLASSIFIER_MODEL=' .env`.
#   - Memory cap bumps explicitly described as gate-driven, NOT automatic.
#   - 35B mentioned only as the v3.2 default — not as a hardcoded Stage 3B target.
```

### 23. `CLASSIFY_SHADOW_RETENTION_DAYS` and prune cron job (O3-A23).
```
grep -nE "classify_shadow_prune|CLASSIFY_SHADOW_RETENTION_DAYS" \
  src/services/scheduler.ts
# Expected:
#   - registerJob('classify_shadow_prune', '...', '17 4 * * *', 'system');
#   - cron.schedule('17 4 * * *', wrapJob('classify_shadow_prune', ...))
#   - DELETE WHERE ts < datetime('now', '-' || days || ' days') AND manually_reviewed = 0

# Env present:
ssh production-vps 'grep "^CLASSIFY_SHADOW_RETENTION_DAYS=" .env'
# Expected: =30 (or operator-set).

# Manually-reviewed rows are exempt:
sqlite3 staging-db "INSERT INTO classify_shadow_runs (ts, message_hash, gemini_domain, agree, manually_reviewed, manual_review_verdict) VALUES (datetime('now', '-90 days'), 'aaaa', 'cooking', 0, 1, 'gemini_correct');"
# Trigger the prune handler manually (via admin endpoint or by waiting for the cron tick).
sqlite3 staging-db "SELECT COUNT(*) FROM classify_shadow_runs WHERE manually_reviewed=1 AND ts < datetime('now','-30 days');"
# Expected: row survives the prune.
```

### 24. Gemini is BASELINE not GROUND TRUTH; manual review required pre-cutover (O3-A24).
```
grep -nE "Gemini is baseline|baseline.*not.*truth|manually_reviewed" docs/runbooks/ollama-local-llm.md docs/qa/work-orders/WO-ollama-local-llm-mac-handoff.md
# Expected: explicit statement + SQL pattern for manual review + cutover gate.

# Cutover gate SQL must be the "effective_agree_pct" pattern, NOT raw agree_pct:
grep -nE "effective_agree_pct|manually_reviewed=0 AND agree=0" docs/runbooks/ollama-local-llm.md
# Expected: present.

# Golden set carries reviewer-decided labels, not Gemini's:
head -1 data/classifier-golden-set.json
# Expected: the `_meta.notes` section explicitly says "reviewer-decided ground truth, NOT Gemini output".

# Ambiguous + follow-up coverage:
grep -c '"id":"ambig-' data/classifier-golden-set.json
# Expected: ≥10.
grep -c '"id":"followup-' data/classifier-golden-set.json
# Expected: ≥10.
```

### 25. Confidence-based fallback is exercised by test.
```
# Cutover-time test that ensures low-confidence Ollama → Gemini fallback
# with fallbackUsed=true, fallbackReason='low_confidence' in provider metadata.
#
# IMPORTANT: production is still on Gemini-first; this test is forward-looking
# infrastructure. If the test exists and passes, item 25 is PASS. If it doesn't
# exist yet (deferred to cutover work), flag as MINOR — not blocking, but the
# operator must add it before flipping AI_CLASSIFY_PRIMARY=ollama.

grep -rn "fallbackReason.*low_confidence\|low_confidence.*fallbackReason\|confidence.*MIN_CONFIDENCE" \
  src/services/provider-fallback.ts src/router/classifier.ts __tests__/services/
# Expected: implementation + test. OK to be deferred to cutover.
```

### 26. v2 prompt exists, env-versioned, back-compat with v1.
```
grep -n "OLLAMA_CLASSIFIER_PROMPT_VERSION\|version === 'v2'\|COMPACT_PROMPT_V2" \
  src/services/anthropic.ts scripts/llm/classifier-golden-eval.ts
# Expected:
#   - anthropic.ts: getOllamaClassifierSystemPromptCompact returns v1 string OR
#     v2 string OR null. v1 is the safe default for unknown versions.
#   - eval script: COMPACT_PROMPT_V2 constant present, selected when
#     PROMPT_VERSION === 'v2'.

# Verify v1 and v2 prompts are BOTH present and v2 contains the new
# disambiguation rules (budget-as-task, ingredient-price-as-cooking, etc.):
grep -A2 "IMPORTANT DISAMBIGUATION" src/services/anthropic.ts | head -5
# Expected: v2 prompt block contains the IMPORTANT DISAMBIGUATION header
# and the four explicit rules.
```

### 27. 4-quadrant golden-eval comparison documented.
```
ls /home/dominguez/telegram-hub-bot/data/classifier-golden-runs/*.json | wc -l
# Expected: ≥4 result files (qwen+v1, qwen+v2, gemma+v1, gemma+v2).

cat /home/dominguez/telegram-hub-bot/data/classifier-golden-runs/CLASSIFIER-COMPARISON-2026-05-26.md
# Expected: side-by-side table showing qwen2.5:3b + v2 wins on overall
# agreement (99.2%) and clears 10 of 11 gates. Recommendation aligned
# with the data.
```

## Acceptance criteria summary (27 items)

| # | Item | Notes |
|---|------|-------|
| 1 | Shadow never blocks live (O3-A1) | |
| 2 | No raw message in shadow rows (O3-A5) | |
| 3 | Shadow skips api_usage + rate-limit (O3-A12) | |
| 4 | Strict enum schema (O3-A6) | |
| 5 | Invalid JSON/timeout → Gemini fallback (O3-A7) | |
| 6 | Tool-domain higher confidence floor (O3-A7) | |
| 7 | `OLLAMA_MAX_LOADED_MODELS` parameterized (O3-A3) | |
| 8 | `/api/ps` checks names not expires_at (O3-A13) | |
| 9 | Golden set runs before real shadow (O3-A8) | |
| 10 | `ClassifyOptions` on all providers (O3-A11) | |
| 11 | userId/tenantId attribution (F-new-6) | |
| 12 | Docs accurate post-Option-3 (F-new-7) | |
| 13 | Model license check (O3-A16) | non-blocking |
| 14 | Rollback NOT default to 35B (O3-A15) | |
| 15 | Replace-or-append env safety (O3-A10) | |
| 16 | PII-safe hash (O3-A5) | |
| 17 | Explicit `getProvider('ollama')` (O3-A17) | |
| 18 | AbortSignal cancels fetch (O3-A18) | |
| 19 | No shadow recursion (O3-A19) | |
| 20 | Generate-once hash secret (O3-A20) | |
| 21 | Enriched shadow schema (O3-A21) | |
| 22 | Stage 3B reads active model (O3-A22) | |
| 23 | Retention prune cron (O3-A23) | |
| 24 | Manual review before cutover (O3-A24) | |
| 25 | Confidence-based fallback test | may be deferred to cutover |
| 26 | v2 compact prompt exists, env-versioned, back-compat with v1 | added post-golden-eval |
| 27 | 4-quadrant golden-eval comparison documented | qwen+v2 winner @ 99.2% |

## Things to red-team aggressively

Codex should consider hostile scenarios that the acceptance criteria
might not cover head-on:

1. **Race conditions** — what happens if the live Gemini classify
   returns AND a second concurrent classify enters before the first
   shadow completes? The semaphore in `classify-shadow.ts` should
   handle this; verify by hammering with N concurrent requests > MAX_IN_FLIGHT.

2. **Shadow path leaking PII into logs** — every `logger.warn`/`logger.info`
   call in classify-shadow.ts must NEVER log raw `input.message`.
   `grep -n "input.message\|message:" src/services/classify-shadow.ts` should show
   message only inside the hmacSha256 call and the ollama.classify call,
   never directly logged.

3. **AbortSignal that's already aborted at entry** — what if the caller
   passes a pre-aborted signal? `ollamaChat` checks
   `if (externalSignal.aborted) ctrl.abort()`. Verify the fetch never
   fires in that case.

4. **`getProvider('ollama')` returning a Gemini-typed provider via
   misconfig** — provider-registry must NEVER return a non-Ollama
   provider for the 'ollama' key. Test by mocking misconfigured
   provider-registry and verify shadow refuses to write rows.

5. **Migration 171 running on a DB that already has a (different)
   classify_shadow_runs table** — `CREATE TABLE IF NOT EXISTS` is
   idempotent but doesn't reconcile schema mismatch. Verify by
   dropping the table, re-creating with FEWER columns, then running
   the migration runner — expected behavior is "no-op (table exists)"
   with a follow-up migration required for upgrade.

6. **CLASSIFY_SHADOW_HASH_SECRET rotation during a deploy** — if the
   operator accidentally rotates the secret (e.g., via a careless
   sed-replace), historical message_hash values become uncorrelatable.
   The deploy script must REFUSE to overwrite — confirm by re-running
   Step 5.

7. **Daemon-side OOM during a shadow call** — if the daemon dies
   mid-generation, what does `ollamaChat` see? Expected:
   `LocalLLMError('provider_unhealthy')` recorded in
   `classify_shadow_runs.ollama_error`. The live Gemini path is
   unaffected.

8. **PM2 cluster mode (NODE_APP_INSTANCE > 0) with memory queue
   backend** — the OllamaProvider's startup guard fails fast. Verify
   shadow concurrency cap isn't bypassed by running multiple
   instances.

9. **classify_shadow_prune deleting too aggressively** — if
   CLASSIFY_SHADOW_RETENTION_DAYS is set to a negative or absurd
   value, the DELETE could wipe everything. The handler should clamp
   to `[1, 365]`. Test by setting `=0` and observing — expect the
   default 30 to apply.

10. **The compact prompt being too short for unusual classify inputs**
    — qwen2.5:3b on the compact prompt may misclassify a long
    Portuguese chat history (>1500 tokens). `OLLAMA_CLASSIFIER_NUM_CTX=2048`
    is the cap; what happens at 1800+ token inputs? Verify the input
    truncation behavior in `enforceInputTokenCap`.

## Report format

Codex should report:
```
WO-option-3-classifier QA report
candidate_commit: <sha>
base_commit:      <sha>

Acceptance criteria summary:  PASS X / 27, FAIL Z

[for each failing item]:
  Item N: <criterion>
  Evidence command(s):
    $ <cmd>
    <output>
  Expected: <what should have happened>
  Observed: <what actually happened>
  Severity: blocking | major | minor

Red-team findings (1–10):
  [for each finding]:
    Finding: <one-line>
    Repro: <commands>
    Severity: blocking | major | minor
    Suggested fix: <one-line>

Verification floor (vitest):
  Before: 718 files / 10,525 tests passing
  After:  <X> files / <Y> tests passing
  Floor maintained: YES | NO

Production state at QA time:
  AI_CLASSIFY_PRIMARY = <gemini | ollama>
  LOCAL_LLM_CLASSIFY_SHADOW = <true | false>
  classify_shadow_runs row count = <N>
  classify_shadow_runs disagreement rate = <pct>
  classify_shadow_runs unreviewed disagreements = <N>

Cutover readiness (informational, not gating):
  - n >= 50: <yes | no>
  - unreviewed_disagreements == 0: <yes | no>
  - effective_agree_pct >= 90: <pct>
  - secretary recall_pct >= 95: <pct>
  - triathlon recall_pct >= 95: <pct>
  - p95 ollama_duration_ms <= 3000: <ms>

Recommendation: APPROVE for L3 promotion | RETURN for fixes
```

## Standing constraints (carried from prior rounds)

- **Token-zero** — Codex MUST NOT mint fake chat turns to validate
  classify. Use the real iOS path (or call `classifyWithClaude`
  directly via a test harness) so the resulting `api_usage` /
  `classify_shadow_runs` rows reflect real production behavior.
- **No production .env mutations by Codex** — Codex inspects, does not
  change. Any required env change → flag and return.
- **Beta users must not be blocked** — Option 3 is a read-side change
  (shadow eval). If anything in this review surfaces a path that could
  delay user-facing classify, escalate immediately.
- **Cost cap unchanged** — Option 3 must add zero $-spend (shadow
  Ollama is local). Verify by diffing daily $ spend before/after
  deploy.
