# WO-ollama-local-llm — Mac transport handoff (v3.2 + Phase K)

**Status as of 2026-05-26 20:40 UTC:**
- **v3.2** Codex round-8 verdict: APPROVE (8 adversarial rounds, v1.0 → v3.2).
- **Phase K** Codex round-9 verdict: REJECT then fixed (F1+F2+F3+F4+F5).
- **VPS production is currently running v3.2 + Phase K (with round-9 fixes).**
- Two bundles + two patches to apply on Mac. ORDER MATTERS:
  1. Apply v3.2 bundle FIRST (`data/ollama-deliverables-20260526-153154.tar.gz`, SHA `f3315336b804d3baf19583b4b525a39d26423290ffb11321814e796b3df16b63`).
  2. Then apply Phase K patch + Phase K post-round-9 patch.

> **URGENT — Mac source out of sync.** The Mac source repo
> (`cortex-telegram-hub-bot`) has NEITHER v3.2 NOR Phase K. The next
> routine `deploy.sh` from Mac → VPS will SILENTLY OVERWRITE both. Land
> both on Mac main before any future deploy. See "Phase K section"
> below for the post-round-9 patch path.

This document explains every step the operator runs on their Mac to land
v3.2 in the Mac source repo (`cortex-telegram-hub-bot`). Nothing in this
flow has been auto-executed — the standing "no commit, push, merge,
deploy, or promote unless explicitly instructed" rule was honored on
the VPS side and continues to apply on Mac.

---

## What v3.2 contains (one-line summary)

Local Ollama provider (Qwen3.6 35B-A3B) integrated as a first-class
`AIProvider`, three new task types (`scriptGeneration`, `localReasoning`,
plus reuse of `classify`), quality-gated cloud reasoning fallback,
**no redactor on the privacy path** (mode=`redacted_only` fail-closes —
this is the architecture Codex finally approved at round 8). Eight
rounds of adversarial review caught and forced fixes for: 1 model-output
leak (v2.5), 1 thinking-trace stripper bug (v2.5), 1 sandbox mkdir race
(v2.5), 1 cost-accounting drop (v2.5), 1 silent-fallback regression
(v2.5), 1 CJK undercount (v2.5), 1 case-sensitive approved-model
matcher (v2.6), 1 `.env.example` clobber (v2.6), 1 staging/prod
distinguisher (v2.7), 1 doc overstatement (v2.7), 4 encoding-attack
classes that broke the v3.0 static redactor (round 6 → architectural
pivot to v3.1), 1 logger-snippet leak (round 6), 1 ai-provider type
residual (round 7), and 2 doc-drift residuals (round 7).

The bundle is the result, not a draft.

---

## Step 0 — Sanity check on Mac before pulling

```bash
cd "$HOME/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot"
git status              # working tree should be clean OR on a known WIP branch
git fetch origin
git log --oneline -3 origin/main
```

Note your current `main` commit — you'll record this as `base_commit` in
the Work Order.

---

## Step 1 — Pull the bundle from the VPS

```bash
# From Mac:
scp dominguez@serverdominguez:/home/dominguez/telegram-hub-bot/data/ollama-deliverables-20260526-153154.tar.gz /tmp/
scp dominguez@serverdominguez:/home/dominguez/telegram-hub-bot/data/ollama-deliverables-20260526-153154.sha256   /tmp/

cd /tmp
shasum -a 256 -c ollama-deliverables-20260526-153154.sha256
# MUST print: ollama-deliverables-20260526-153154.tar.gz: OK
```

If the SHA check fails, STOP. Re-fetch.

---

## Step 2 — Branch, extract, inspect, commit

```bash
cd "$HOME/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot"

# Create feature branch off current main
git checkout main
git pull origin main
git checkout -b feat/ollama-local-llm

# Extract the bundle (relative paths land in repo root)
tar -xzvf /tmp/ollama-deliverables-20260526-153154.tar.gz

# Inspect what landed
git status
git diff --stat main...

# Expected files (some new, some edited):
#   NEW:
#     src/services/local-llm-error.ts
#     src/services/token-estimator.ts
#     src/services/ollama-provider.ts
#     src/services/local-llm-rate-limiter.ts
#     src/services/cloud-reasoning-gate.ts
#     src/services/script-generation.ts
#     migrations/169_local_request_units.sql
#     migrations/170_script_generation_runs.sql
#     __tests__/services/ollama-provider.test.ts
#     __tests__/services/cloud-reasoning-gate.test.ts
#     __tests__/services/privacy-redacted-flow.test.ts
#     __tests__/services/v26-hardening.test.ts
#     __tests__/services/dispatch-privacy-e2e.test.ts
#     scripts/install-ollama.sh
#     scripts/staging-smoke-ollama.sh
#     scripts/llm/local-llm-smoke.ts
#     docs/runbooks/ollama-local-llm.md
#     docs/qa/work-orders/WO-ollama-local-llm.md
#     docs/qa/work-orders/WO-ollama-local-llm-mac-handoff.md  (this file)
#     docs/qa/prompts/codex-ollama-local-llm-qa.md
#     docs/qa/prompts/codex-angry-qa-pre-promote.md
#
#   EDITED:
#     src/config.ts
#     src/services/ai-provider.ts
#     src/services/model-config.ts
#     src/services/domain-provider-router.ts
#     src/services/provider-registry.ts
#     src/services/provider-fallback.ts
#     src/services/gemini-provider.ts
#     src/services/openai-provider.ts
#     src/services/anthropic.ts
#     src/services/cost-guardrail.ts
#     src/services/model-pricing.ts
#     src/services/api-usage-fallback.ts
#     src/services/integration-health.ts
#
# .env.example is INTENTIONALLY NOT shipped. Append the OLLAMA_* block
# from docs/runbooks/ollama-local-llm.md manually if you want it in
# .env.example. The VPS .env already has OLLAMA_ENABLED=true and the
# bot has been running on it.
```

---

## Step 3 — Compile + test on Mac

```bash
npm ci                              # match lockfile
npx tsc --noEmit                    # MUST be clean
npx vitest run                      # expect 725+ files, all green

# Focused privacy/Ollama surface (the 11 files Codex re-ran):
npx vitest run \
  __tests__/services/v26-hardening.test.ts \
  __tests__/services/cloud-reasoning-gate.test.ts \
  __tests__/services/privacy-redacted-flow.test.ts \
  __tests__/services/dispatch-privacy-e2e.test.ts \
  __tests__/services/ollama-provider.test.ts \
  __tests__/services/provider-fallback.test.ts \
  __tests__/services/openai-provider.test.ts \
  __tests__/services/gemini-provider.test.ts \
  __tests__/services/anthropic-language.test.ts \
  __tests__/services/anthropic-lazy-client.test.ts \
  __tests__/services/provider-fallback-domain-routing.test.ts
# Expected: 231 tests passing across 11 files (matches the v3.2 VPS run).
```

If any of these fail on Mac but passed on VPS, the most likely cause is
better-sqlite3 native binding mismatch — run `npm rebuild better-sqlite3`
and re-test.

---

## Step 4 — Commit

```bash
git add -A
git commit -m "feat(ollama): integrate local Ollama provider (Qwen3.6 35B-A3B)

Implements WO-ollama-local-llm Revision 4 architecture, after 8 rounds
of adversarial Codex angry-QA (final verdict v3.2: APPROVE).

- OllamaProvider with classify + chat (non-tool) + scriptGeneration + localReasoning
- local-llm-error taxonomy (capacity_exceeded NOT a circuit-breaker fault)
- cloud-reasoning-gate (quality + privacy gates, disallow overrides approved)
- v3.1 pivot: mode='redacted_only' fail-closes; no redactor on privacy path
- script-generation 2-step pipeline (plan -> artifacts, sandboxed validation)
- local-llm-rate-limiter (call-count, separate from \$-based cost guardrail)
- token-estimator (conservative max(chars/3, utf8_bytes/3))
- 2 migrations: api_usage.local_request_units + script_generation_runs
- vitest coverage on ollama-provider + cloud-reasoning-gate matrix + dispatch privacy E2E
- install + smoke scripts + runbook + Codex QA prompts + Mac transport handoff

Co-Authored-By: Claude Opus 4.7 (VPS session 2026-05-26)"
```

---

## Step 5 — Open PR

```bash
git push -u origin feat/ollama-local-llm
gh pr create --title "feat(ollama): integrate local Ollama provider (Qwen3.6 35B-A3B)" \
  --body "$(cat <<'EOF'
## Summary
- Adds Ollama (Qwen3.6 35B-A3B) as a first-class AIProvider in Nexus Hub
- Three new routings: classify (flippable, kept on cloud by default), scriptGeneration, localReasoning
- Quality-gated cloud reasoning fallback with disallow-list AND privacy gate
- v3.1 architectural pivot: redactor REMOVED from privacy path (8 rounds of Codex angry-QA)

## v3.2 final state (Codex round-8 APPROVE)
- Bundle SHA256: f3315336b804d3baf19583b4b525a39d26423290ffb11321814e796b3df16b63
- VPS staging: deployed, healthy, Ollama probe firing OK on 5-min interval
- All 32 plan acceptance criteria satisfied per round-8 review

## Test plan
- [ ] tsc --noEmit clean
- [ ] full vitest green (725+ files)
- [ ] focused privacy suite green (231 tests / 11 files)
- [ ] deploy to staging via existing scripts/deploy-staging.sh
- [ ] staging-smoke.sh passes
- [ ] staging-smoke-ollama.sh passes (new)
- [ ] 50+ classify call shadow-eval with AI_CLASSIFY_PRIMARY=ollama vs cloud baseline (Phase 2)

## NOT in this PR
- Production routing flip (separate operator decision after shadow-eval)
- Phase 4 cloud-reasoning-fallback enable (separate operator decision)

🤖 Generated with Claude Code
EOF
)"
```

---

## Step 6 — Deploy chain (after PR review & merge, operator's discretion)

```bash
# After PR merged to main:
git checkout main && git pull
./scripts/deploy-staging.sh
sleep 300                                # 5-min soak
./scripts/staging-smoke.sh               # 17/17 must pass
./scripts/staging-smoke-ollama.sh        # 9/9 must pass (new)

# Phase 2 shadow-eval on STAGING (not prod):
# Edit staging .env on the VPS to add:
#   AI_CLASSIFY_PRIMARY=ollama
#   AI_CLASSIFY_FALLBACK=gemini
#   LOCAL_LLM_EVALUATION_MODE=true
#   CLOUD_REASONING_FALLBACK_ENABLED=false
# pm2 restart nexus-hub-staging
# Observe 50+ classify calls; compare provider distribution vs cloud baseline.
# DO NOT flip these on production until shadow-eval shows acceptable agreement.

# Production promote — SEPARATE OPERATOR DECISION after shadow-eval data lands.
# When ready:
# ./scripts/promote-to-prod.sh
```

---

## Rollback (any tier)

| Tier | Action | Recovery |
|---|---|---|
| 1   | Env flip: `AI_CLASSIFY_PRIMARY=gemini` → PM2 restart | ~5 s |
| 1b  | Operational rollback to 27B: `OLLAMA_MODEL=qwen3.6:27b-q4_K_M` + PM2 restart | ~5 s + warm load |
| 2   | `OLLAMA_ENABLED=false` → PM2 restart | ~5 s |
| 3   | `sudo systemctl stop ollama` on VPS | ~2 s |
| 4   | Revert PR + redeploy | minutes |

---

## What's still pending from the original plan

- Live shadow-eval data on staging (50+ classify calls vs cloud baseline) — operator runs this in Phase 2 once they've decided to deploy.
- Phase 4 cloud reasoning fallback enablement — operator chooses `mode='never'` (block all private cloud escalation, recommended default) or `mode='allow_raw' + allowRawPrivateData=true` (explicit raw-private opt-in). `mode='redacted_only'` no longer forwards anything.
- Optional follow-up CLIs (`scripts/llm/generate-script-local.ts`, `evaluate-script-local.ts`, `prune-local-llm-runs.ts`) — de-scoped in v1, easy follow-up.
- Optional scheduler.ts 5-minute Ollama cron + memory-pressure pre-OOM scraper — de-scoped pending real Phase 3 traffic to size thresholds.

These were all explicitly listed in `docs/qa/work-orders/WO-ollama-local-llm.md` Section "Known gaps".

---

# Phase K (post-Codex-round-9) — additional changes on top of v3.2

**Deployed to VPS production**: 2026-05-26 20:32 UTC.
**Codex round-9 status**: REJECT issued (F1 BLOCKING + 5 others), all fixes
applied + verified, awaiting round-10 sign-off.

## What Phase K adds

Routes the three pure-text domains (`cooking`, `content`, `finance`) to
Ollama as primary, with Gemini fallback for transient failures. Secretary
and triathlon stay on cloud (tool-required; v1 OllamaProvider has no safe
tool-orchestration). Includes:

1. Quality-gate hot-fix for the Portuguese cooking recipe regression
   (`chat-response-quality-gate.ts` — `CREATIVE_TEXT_OWNERS` skip, applied
   to BOTH the answer_only and execute first-tier checks; side-effect
   verbs in `claimsSuccess` to catch content workflow false-success
   claims).
2. Config-parse hard-block (`domain-provider-router.ts`) — drops
   `secretary=ollama` / `triathlon=ollama` overrides at parse time with
   warn log.
3. Runtime hard-block (`provider-fallback.ts shouldBypassOllamaForToolOrWrite`)
   — re-routes Ollama → cloud fallback when domain/ownerSkill/taskType/
   executeIntent signals a tool-or-write shape. **filteredTools is NOT a
   bypass trigger** (Codex F1 — auto-populated tools previously
   misclassified every Phase K request).
4. Finance fail-closed: domain=finance routes to Ollama ONLY when
   `ownerSkill='finance'` is set; otherwise → cloud.
5. Prompt guards in `OllamaProvider.callDomain` — `PHASE_K_ANSWER_ONLY_GUARD`
   for cooking/content (English + Portuguese verb list to discourage
   past-tense self-success), `PHASE_K_FINANCE_GUARD` (stricter — no
   fabricated access to accounts/balances/transactions).
6. Observability: every Ollama chat call surfaces `domain, temperature,
   think, numCtx, numPredict` (from ACTUAL request payload, not literals)
   in `providerMetadata`. Quality gate surfaces `qualityGateSkipped,
   qualityGateReason` (e.g., `creative_text_owner:cooking:execute`).
7. Auto-derived `ownerSkill` in `handleSimpleDomain` from `domain`
   (cooking→cooking, content→content, finance→finance, triathlon→training,
   secretary→secretary).

## Phase K files changed (7 source files + 1 test + 1 env)

| File | Change |
|---|---|
| `src/services/chat-response-quality-gate.ts` | CREATIVE_TEXT_OWNERS + SIDE_EFFECT_SUCCESS_VERBS in claimsSuccess + first-tier skip + result fields (qualityGateSkipped/Reason) |
| `src/services/domain-provider-router.ts` | Config-parse hard-block for secretary/triathlon→ollama |
| `src/services/ollama-provider.ts` | Prompt guards + actual-value metadata + drop the unsupported_capability throw on auto-populated tools |
| `src/services/ai-provider.ts` | Type extensions (CallDomainOptions adds ownerSkill+executeIntent, AICallResult.providerMetadata adds Phase K fields) |
| `src/services/provider-fallback.ts` | shouldBypassOllamaForToolOrWrite + runtime guard in callDomain + buildOptimizedOptions preserves ownerSkill/executeIntent + fallback chain fix (F5) |
| `src/api/routes/chat-message-routes.ts` | Copy qualityGateSkipped/Reason into responseQuality |
| `src/domains/domain-handler.ts` | Optional phaseKHints param + auto-derived ownerSkill |
| `__tests__/services/phase-k-quality-gate.test.ts` | NEW — 21 regression tests |
| `/home/dominguez/telegram-hub-bot/.env` (VPS-only) | `AI_DOMAIN_PROVIDER_OVERRIDES=cooking=ollama,content=ollama,finance=ollama` |

## Phase K patches on VPS

```
/home/dominguez/snapshots/pre-ollama-v3.2-20260526-164248/
├── src-pre-phase-k/                    # Pre-edit source (6 files)
├── dist-pre-phase-k/                   # Pre-edit dist (rollback Tier 4)
├── env-pre-phase-k                     # Pre-edit .env
├── env-post-phase-k                    # Post-edit .env (current prod)
└── phase-k-src.patch                   # Initial Phase K diff (517 lines, 23.8 KB)
```

The post-round-9 fixes are not yet captured as a separate patch (since
they're on top of the same pre-snapshot). To produce the round-9 diff:

```bash
SNAP=/home/dominguez/snapshots/pre-ollama-v3.2-20260526-164248
for f in \
  src/services/chat-response-quality-gate.ts \
  src/services/domain-provider-router.ts \
  src/services/ollama-provider.ts \
  src/services/ai-provider.ts \
  src/services/provider-fallback.ts \
  src/api/routes/chat-message-routes.ts; do
  diff -u "$SNAP/src-pre-phase-k/$f" "/home/dominguez/telegram-hub-bot/$f"
done > "$SNAP/phase-k-round-9-final.patch"
```

## Mac sync procedure for Phase K

After landing v3.2 on Mac main (see top of this doc):

```bash
cd "$HOME/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot"

# 1. Branch off the v3.2 PR's merge commit (or main if already merged):
git checkout main && git pull
git checkout -b feat/ollama-phase-k

# 2. Pull the Phase K patch (regenerated above):
scp dominguez@serverdominguez:/home/dominguez/snapshots/pre-ollama-v3.2-20260526-164248/phase-k-round-9-final.patch /tmp/

# 3. Apply:
git apply --check /tmp/phase-k-round-9-final.patch  # dry-run
git apply /tmp/phase-k-round-9-final.patch

# 4. Pull the Phase K test file separately (it's new, not in the diff):
scp dominguez@serverdominguez:/home/dominguez/telegram-hub-bot/__tests__/services/phase-k-quality-gate.test.ts \
    __tests__/services/phase-k-quality-gate.test.ts

# 5. Add the domain-handler.ts edits manually (the snapshot doesn't have
#    a pre-edit copy of this file). The change is:
#    - Add optional `phaseKHints?: { ownerSkill?: string; executeIntent?: boolean }` parameter
#    - Auto-derive ownerSkill from domain inside the function
#    See live source: /home/dominguez/telegram-hub-bot/src/domains/domain-handler.ts:451-525

# 6. Add the .env documentation (NOT shipping a clobber-prone .env.example):
#    Document that `AI_DOMAIN_PROVIDER_OVERRIDES=cooking=ollama,content=ollama,finance=ollama`
#    should be set on the operator's deployed .env to activate Phase K
#    routing. The plan file's "Phase K" section documents this in detail.

# 7. Compile + test:
npm ci
npx tsc --noEmit
npx vitest run __tests__/services/phase-k-quality-gate.test.ts  # 21/21 expected
npx vitest run __tests__/services/chat-response-quality-gate.test.ts  # if any pre-existed
npx vitest run  # full suite — verification floor 718+/10,525+

# 8. Commit + push + PR
git add -A
git commit -m "feat(ollama-phase-k): route cooking/content/finance to Ollama

After Codex angry-QA round 9 (REJECT → fixes → verify):

- chat-response-quality-gate.ts: CREATIVE_TEXT_OWNERS skip applied
  to both answer_only AND execute first-tier checks
- SIDE_EFFECT_SUCCESS_VERBS included in claimsSuccess so content
  workflow verbs (publiquei/postei/agendei) still trip the gate
- provider-fallback.ts: shouldBypassOllamaForToolOrWrite — bypasses
  on domain/ownerSkill/taskType/executeIntent (NOT filteredTools —
  those are auto-populated availability, not intent)
- buildOptimizedOptions preserves ownerSkill+executeIntent
- Bypass swap clears fallback slot (no same-provider retry)
- ollama-provider.ts: silently ignores auto-populated tools, prompt
  guards for cooking/content/finance, actual-value metadata
- ai-provider.ts: type extensions for CallDomainOptions + metadata
- domain-handler.ts: auto-derived ownerSkill from domain
- 21 new regression tests in __tests__/services/phase-k-quality-gate.test.ts

Operator must set AI_DOMAIN_PROVIDER_OVERRIDES=cooking=ollama,content=ollama,finance=ollama
in their deployed .env to activate.

Co-Authored-By: Claude Opus 4.7 (VPS session 2026-05-26)"

git push -u origin feat/ollama-phase-k
gh pr create --title "feat(ollama): Phase K — route cooking/content/finance to Ollama (post-Codex-r9)" --body "..."
```

## Phase K rollback (if needed after Mac sync + deploy)

| Tier | Trigger | Command |
|---|---|---|
| 1 | Single-domain quality regression | Remove that domain from `AI_DOMAIN_PROVIDER_OVERRIDES`, PM2 restart |
| 2 | All Phase K domains regressed | Comment out the entire `AI_DOMAIN_PROVIDER_OVERRIDES` line, PM2 restart |
| 3 | Code-level regression after Phase K deploy | Restore `dist-pre-phase-k` snapshot + `env-pre-phase-k`, PM2 restart |

**Snapshot paths** (on VPS):
- `dist-pre-phase-k`: `/home/dominguez/snapshots/pre-ollama-v3.2-20260526-164248/dist-pre-phase-k`
- `env-pre-phase-k`: `/home/dominguez/snapshots/pre-ollama-v3.2-20260526-164248/env-pre-phase-k`

## Outstanding TODOs after Mac sync

1. Update production .env if the operator wants to enable `AI_DOMAIN_PROVIDER_OVERRIDES` (this is currently set on VPS; needs to be set on whichever Mac→VPS deploy mechanism replaces the VPS .env on each deploy).
2. Run Codex round-10 against the final v3.2 + Phase K combined diff on Mac.
3. Production observation window — 24-72h after Mac promotion to confirm no regressions.

---

# Option 3 — Dedicated small Ollama classifier model (2026-05-26 late)

**STATUS:** Applied to VPS production at 23:04 UTC 2026-05-26. Same urgency as Phase K — the next routine Mac→VPS rsync deploy will silently overwrite Option 3 unless these patches land on Mac main FIRST.

## Why this exists

After Phase K shipped, classify latency in production hit 50–60s wall-clock per call because `AI_CLASSIFY_PRIMARY=ollama` was routing the live classifier through the 35B-A3B model with a ~1032-token prompt. Codex flagged this as F-new-5. Option 3 fixes it architecturally: load a small dedicated classifier model (`qwen2.5:3b-instruct-q4_K_M`, 1.9 GB) and let the 35B stay reserved for script-generation / local-reasoning.

The cutover from Gemini → Ollama for classify is gated on shadow-eval comparison: every live Gemini classify call now also fires (fire-and-forget) an Ollama classify call and writes the comparison to a new `classify_shadow_runs` table. Per O3-A24, Gemini is BASELINE not GROUND TRUTH — the operator manually labels disagreements before cutover.

## Files changed (12 source files + 1 test + 1 migration + 2 data/scripts + 12 env vars)

EDITED on VPS (must be applied to Mac source before next rsync):

| # | File | Purpose |
|---|------|---------|
| 1 | `src/services/ai-provider.ts` | Add `ClassifyOptions` interface (userId, tenantId, requestId, source, recordUsage, timeoutMs, abortSignal). Extend `AIProvider.classify` signature. Extend `FallbackProvider.classify` to forward options. |
| 2 | `src/services/anthropic-provider.ts` | Accept ClassifyOptions; forward userId/tenantId to legacy classifyMessage. |
| 3 | `src/services/openai-provider.ts` | Accept ClassifyOptions (compliance only — attribution via trackedCompletion). |
| 4 | `src/services/gemini-provider.ts` | Accept ClassifyOptions (compliance only — attribution via logGeminiUsage). |
| 5 | `src/services/ollama-provider.ts` | (a) Accept ClassifyOptions. (b) Plumb `abortSignal` into `ollamaChat` → fetch (O3-A18 real cancellation). (c) Skip api_usage write + bypass rate-limiter when `source='shadow'` or `recordUsage=false` (O3-A12 OPTION 1). (d) Use compact classifier prompt when `OLLAMA_CLASSIFIER_PROMPT_VERSION=v1` (O3-A14). (e) Read `OLLAMA_CLASSIFIER_NUM_CTX` / `_NUM_PREDICT` from env. (f) New `readPositiveInt` helper. |
| 6 | `src/services/anthropic.ts` | Add `getOllamaClassifierSystemPromptCompact()` returning a <400-token classifier prompt versioned by `OLLAMA_CLASSIFIER_PROMPT_VERSION` (default returns null → long prompt fallback for back-compat). |
| 7 | `src/services/provider-fallback.ts` | TaskRoutingProvider.classify forwards ClassifyOptions to the underlying provider via executeWithFallback. |
| 8 | `src/services/scheduler.ts` | Register `classify_shadow_prune` daily cron at 04:17 UTC — deletes shadow rows older than `CLASSIFY_SHADOW_RETENTION_DAYS` (default 30) EXCEPT manually-reviewed rows. |
| 9 | `src/router/classifier.ts` | After live classify returns, fire-and-forget `runOllamaShadowClassification`. Pass `source: 'live'` to the live path explicitly (O3-A19 default-safe). |
| 10 | `src/config.ts` | New `localLLM.classifyShadow` block reading `LOCAL_LLM_CLASSIFY_SHADOW` env. |
| 11 | `scripts/install-ollama.sh` | Parameterize `OLLAMA_MAX_LOADED_MODELS` (default 1). O3-A3 — Stage 3B can pass `=2` to load main + classifier simultaneously. |
| 12 | `__tests__/services/ollama-provider.test.ts` | Add `getOllamaClassifierSystemPromptCompact: () => null` to existing anthropic mock (otherwise test fails on missing export). |

NEW on VPS (must be created on Mac):

| # | File | Purpose |
|---|------|---------|
| 1 | `src/services/classify-shadow.ts` | Fire-and-forget Ollama shadow classify. Explicit `getProvider('ollama')` lookup (O3-A17). AbortController timeout (O3-A18). Recursion guard when live path is Ollama (O3-A19). HMAC-SHA256 message hashing with `CLASSIFY_SHADOW_HASH_SECRET`. Concurrency cap via `LOCAL_LLM_CLASSIFY_SHADOW_MAX_IN_FLIGHT/_MAX_QUEUE`. Writes baseline row UPFRONT, UPDATEs with Ollama result when complete. |
| 2 | `src/utils/hmac.ts` | `hmacSha256(secret, message)` helper. |
| 3 | `migrations/171_classify_shadow_runs.sql` | New table with O3-A21 + O3-A24 fields (request_id, schema_version, ollama_model, ollama_prompt_version, gemini_model, manually_reviewed, manual_review_verdict). |
| 4 | `data/classifier-golden-set.json` | 120 reviewer-decided examples (20/domain + 10 ambiguous + 10 follow-up). Ground truth for offline evaluation per O3-A24. |
| 5 | `scripts/llm/classifier-golden-eval.ts` | Offline evaluator. Talks to Ollama daemon directly. Outputs per-domain precision/recall + acceptance gates. |
| 6 | `__tests__/services/option-3-classifier.test.ts` | 14 unit tests covering O3-A17, O3-A18, O3-A19, O3-A21, hmac determinism, compact prompt versioning, recordUsage flag, classifyShadow disable. All passing on staging. |

EDITED env vars (12 new lines in `.env`):
```
OLLAMA_CLASSIFIER_MODEL=qwen2.5:3b-instruct-q4_K_M
OLLAMA_CLASSIFIER_MIN_CONFIDENCE=0.65
OLLAMA_CLASSIFIER_TOOL_DOMAIN_MIN_CONFIDENCE=0.80
OLLAMA_CLASSIFY_TIMEOUT_MS=5000
OLLAMA_CLASSIFIER_NUM_CTX=2048
OLLAMA_CLASSIFIER_NUM_PREDICT=32
OLLAMA_CLASSIFIER_PROMPT_VERSION=v1
LOCAL_LLM_CLASSIFY_SHADOW=true
LOCAL_LLM_CLASSIFY_SHADOW_MAX_IN_FLIGHT=1
LOCAL_LLM_CLASSIFY_SHADOW_MAX_QUEUE=4
CLASSIFY_SHADOW_RETENTION_DAYS=30
CLASSIFY_SHADOW_HASH_SECRET=<256-bit hex — GENERATE-ONCE on Mac, NEVER rotate>
```

`AI_CLASSIFY_PRIMARY` was flipped from `ollama` (60s latency) back to `gemini` (the production stop-gap from Step 1). Cutover to ollama is gated on shadow data + O3-A24 manual review.

## Patches on VPS

- **Source patch (12 files):** `/home/dominguez/snapshots/pre-ollama-v3.2-20260526-164248/option-3/option-3-src.patch` (~3,800 lines).
- **New files directory:** `/home/dominguez/snapshots/pre-ollama-v3.2-20260526-164248/option-3/new-files/` (6 files).
- **Pre-Option-3 dist snapshot:** `/home/dominguez/snapshots/pre-ollama-v3.2-20260526-164248/option-3/dist-pre-option-3/`.
- **Pre-Option-3 .env snapshot:** `/home/dominguez/snapshots/pre-ollama-v3.2-20260526-164248/option-3/env-pre-option-3`.
- **Pre-Step5 .env snapshot:** `/home/dominguez/snapshots/pre-ollama-v3.2-20260526-164248/option-3/env-pre-step5`.
- **Post-Option-3 .env (with redacted secret):** `/home/dominguez/snapshots/pre-ollama-v3.2-20260526-164248/option-3/env-post-option-3.redacted`.

## How to apply on Mac

### Bundle contents (transport everything below to Mac):

| File | Source on VPS | Apply via |
|------|--------------|-----------|
| `option-3-src.patch` | `/home/dominguez/snapshots/.../option-3/option-3-src.patch` | `patch -p1` from repo root |
| `install-ollama.sh.patch` | `/home/dominguez/snapshots/.../option-3/install-ollama.sh.patch` | `patch -p1` from repo root |
| `ollama-provider.test.ts.patch` | `/home/dominguez/snapshots/.../option-3/ollama-provider.test.ts.patch` | `patch -p1` from repo root |
| `171_classify_shadow_runs.sql` | `/home/dominguez/snapshots/.../option-3/new-files/171_classify_shadow_runs.sql` | copy to `migrations/` |
| `classifier-golden-set.json` | `/home/dominguez/snapshots/.../option-3/new-files/classifier-golden-set.json` | copy to `data/` |
| `classifier-golden-eval.ts` | `/home/dominguez/snapshots/.../option-3/new-files/classifier-golden-eval.ts` | copy to `scripts/llm/` |
| `option-3-classifier.test.ts` | `/home/dominguez/snapshots/.../option-3/new-files/option-3-classifier.test.ts` | copy to `__tests__/services/` |
| `chat-response-quality-gate.test.ts` | `/home/dominguez/snapshots/.../option-3/new-files/chat-response-quality-gate.test.ts` | copy to `__tests__/services/` (Phase K backfill — 12 tests covering CREATIVE_TEXT_OWNERS + SIDE_EFFECT_SUCCESS_VERBS) |

> Note: `classify-shadow.ts` and `hmac.ts` appear in BOTH `option-3-src.patch` AND `new-files/`. The patch is authoritative — applying the patch creates these files. The `new-files/` copies are redundant fallbacks. Use the patch.

### Apply on Mac:

```bash
# From Mac, after pulling latest cortex-telegram-hub-bot main:
cd ~/Desktop/Custom\ Connectors/Cortex/cortex-telegram-hub-bot

# 1. Apply the three patches (use -p1 from repo root, NOT -p3 or -p6):
patch -p1 < ~/Downloads/option-3-src.patch
patch -p1 < ~/Downloads/install-ollama.sh.patch
patch -p1 < ~/Downloads/ollama-provider.test.ts.patch

# 2. Copy the new files (migration + golden set + eval + test):
cp ~/Downloads/option-3-new-files/171_classify_shadow_runs.sql migrations/
cp ~/Downloads/option-3-new-files/classifier-golden-set.json data/
cp ~/Downloads/option-3-new-files/classifier-golden-eval.ts scripts/llm/
chmod +x scripts/llm/classifier-golden-eval.ts
cp ~/Downloads/option-3-new-files/option-3-classifier.test.ts __tests__/services/
cp ~/Downloads/option-3-new-files/chat-response-quality-gate.test.ts __tests__/services/

# 3. Generate the hash secret ONCE on Mac (do NOT reuse the VPS secret —
# generate fresh; the VPS preserves its own; only the runtime that wrote
# the rows needs the matching secret).
if ! grep -q '^CLASSIFY_SHADOW_HASH_SECRET=' .env; then
  echo "CLASSIFY_SHADOW_HASH_SECRET=$(openssl rand -hex 32)" >> .env
  echo "Generated Mac CLASSIFY_SHADOW_HASH_SECRET (preserve forever; do NOT rotate)."
else
  echo "Mac .env already has CLASSIFY_SHADOW_HASH_SECRET — preserved."
fi

# 4. Add the other 11 env vars from the list at the top of this doc.

# 5. Verify build + tests:
npm run build
npx vitest run __tests__/services/option-3-classifier.test.ts \
               __tests__/services/chat-response-quality-gate.test.ts \
               __tests__/services/ollama-provider.test.ts \
               __tests__/services/provider-fallback.test.ts \
               __tests__/services/domain-provider-router.test.ts
# Expected: 97 passed (97)

# 6. Run Codex angry-QA against the merged candidate commit:
#    docs/qa/prompts/codex-option-3-classifier-qa.md

# 7. Commit and deploy via the standard staging→promote-to-prod pipeline.
```

### Patch verification on VPS (already done — proof bundle is consistent):

```bash
# On VPS: dry-run applied the patch against the pre-Option-3 snapshot
# and verified the result is byte-identical to the post-Option-3 state.
diff -r /tmp/o3-apply/src /home/dominguez/snapshots/pre-ollama-v3.2-20260526-164248/option-3/src-post-option-3/src
# (empty output = identical)
```

## Golden-set evaluation results

Ran on the live VPS daemon at 23:09 UTC 2026-05-26 against `qwen2.5:3b-instruct-q4_K_M`:

- **Overall agreement: 95%** (gate ≥92%) ✓
- **Per-domain precision: 100%** on secretary, triathlon, content, cooking
- **Failures** (5 gates):
  - Secretary recall **87.5%** (gate 95%) — 2 budget-keyword tasks → finance
  - Triathlon recall **92%** (gate 95%) — 2 ambiguous nutrition/Garmin-price → finance
  - Finance precision **79.3%** (gate 85%) — 6 false positives (all anchored on money/price keywords)
  - Ambiguous agreement **60%** (gate 70%) — 4 of 10 (mostly the budget/price overlap above)
  - p95 latency **3816ms** (gate 3000ms) — follow-up examples (with activeContext) ran 3.6–4.7s

These failures cluster on a budget/cost keyword overlap — qwen2.5:3b strongly anchors `budget`/`preço`/`custa` to finance. The production cutover gate (Step 7) requires real shadow data + manual review per O3-A24, not the golden set alone. The operator can choose to (a) accept and accumulate ≥50 real shadow rows for manual review, (b) try `gemma2:2b-instruct-q4_K_M` per Tier 1b rollback, or (c) defer cutover indefinitely.

Run output saved at: `/home/dominguez/telegram-hub-bot/data/classifier-golden-runs/2026-05-26T22-09-47-371Z.json`.

## Verification on VPS (post-deploy)

| Check | Command | Result |
|-------|---------|--------|
| Stop-gap intact | `grep ^AI_CLASSIFY_PRIMARY= .env` | `=gemini` ✓ |
| Migration applied | `sqlite3 data/bot.db ".schema classify_shadow_runs"` | full schema with O3-A21 + O3-A24 fields ✓ |
| Generate-once secret | `grep -c ^CLASSIFY_SHADOW_HASH_SECRET= .env` | `1` ✓ |
| 12 new env vars set | `grep -cE 'OLLAMA_CLASSIFIER\|LOCAL_LLM_CLASSIFY_SHADOW\|CLASSIFY_SHADOW' .env` | `12` ✓ |
| /health | `curl :8200/health` | HTTP 200 in 5.6 ms ✓ |
| qwen2.5:3b pulled | `ollama list \| grep qwen2.5:3b` | one line, 1.9 GB ✓ |
| Provider routing | `pm2 logs nexus-hub` | `classify: gemini→openai` (cloud), `OllamaProvider initialized` (for shadow + script-gen) ✓ |
| Production node version | n/a | unchanged from v3.2/Phase K |

## Rollback paths (per O3-A15 — do NOT default to 35B classifier)

| Tier | Trigger | Action |
|------|---------|--------|
| 1 | Small model unacceptable in shadow | `AI_CLASSIFY_PRIMARY=gemini` stays. Already the state. |
| 1b | Try alternate small model | `OLLAMA_CLASSIFIER_MODEL=gemma2:2b-instruct-q4_K_M` + restart. Re-run golden eval. |
| 1c | Disable Ollama classify entirely | `LOCAL_LLM_CLASSIFY_SHADOW=false`. Production classify on Gemini unchanged. |
| 2 | Memory pressure / swap thrash | Stay at `OLLAMA_MAX_LOADED_MODELS=1` (already the default). Skip Stage 3B. |
| 3 | Code regression | Restore `dist-pre-option-3` from snapshot, PM2 restart. ~2 min recovery. |

## Pending after Option 3

1. **Real shadow accumulation** — ≥50 live classify calls hit production; `classify_shadow_runs` populates. Operator inspects.
2. **Manual review of disagreements** per O3-A24 — every `agree=0` row gets a verdict (`gemini_correct`, `ollama_correct`, `both_wrong`, `either_acceptable`) before cutover gate evaluates.
3. **Cutover decision** — if effective_agree_pct ≥90 AND tool-domain recall ≥95 AND no unreviewed disagreements: flip `AI_CLASSIFY_PRIMARY=ollama`. Else stay on Gemini, optionally try `gemma2:2b` (Tier 1b).
4. **Mac source-of-truth sync** — operator applies this Option-3 patch on Mac main before the next regular Mac→VPS deploy.

## v2 classifier prompt — promotion path

The compact classifier prompt is versioned via `OLLAMA_CLASSIFIER_PROMPT_VERSION` in `.env`. Currently `=v1` in production.

`v2` was added 2026-05-26 to address the budget/price keyword anchoring that the golden eval surfaced on qwen2.5:3b. v2 explicit changes over v1:

- Explicit secretary signal for "Add a task / Mark as done / Anota" REGARDLESS of topic — even when the topic is financial ("budget review", "pay invoice").
- Explicit cooking signal for ingredient prices ("Quanto custa um quilo de carne?") — these are ingredient questions, not personal finance.
- Explicit triathlon signal for athlete-nutrition framing ("Preciso parar de comer pão?") — these are athletic coaching questions.
- Explicit triathlon signal for Garmin device/price questions — these are training-tool research, not personal finance.
- Clarifies finance is about MANAGING the user's OWN money (records, budgets, invoices, taxes), NOT about the cost of things in the world.

**To promote v2 on Mac source (after this transport patch is applied):**

```bash
# 1. Test v2 against the golden set first:
OLLAMA_CLASSIFIER_PROMPT_VERSION=v2 \
  OLLAMA_CLASSIFIER_MODEL=qwen2.5:3b-instruct-q4_K_M \
  npx tsx scripts/llm/classifier-golden-eval.ts

# Inspect data/classifier-golden-runs/<latest>.json — confirm v2 is
# STRICTLY better than v1 on overall agreement AND tool-domain recall.

# 2. If v2 wins: flip the .env, restart, observe:
sed -i 's|^OLLAMA_CLASSIFIER_PROMPT_VERSION=.*|OLLAMA_CLASSIFIER_PROMPT_VERSION=v2|' .env
pm2 restart nexus-hub --update-env

# 3. Verify shadow rows pick up v2:
sqlite3 data/bot.db "SELECT ollama_prompt_version, COUNT(*) FROM classify_shadow_runs WHERE ts >= datetime('now','-1 hour') GROUP BY ollama_prompt_version;"
# Expected: 'v2' rows accumulating; the old 'v1' rows remain for diff/audit.

# 4. Continue O3-A24 manual review against v2 rows.
```

**Rollback v2 → v1 (if v2 regresses):** flip the env back to `=v1` + restart. The v1 prompt code stays in place — no source change required.

## Tier 1b — gemma2:2b as alternate classifier model

Per O3-A15 Tier 1b, if qwen2.5:3b (under either prompt) doesn't reach the cutover gate, try `gemma2:2b-instruct-q4_K_M` (1.7 GB on disk, Gemma license — verify acceptability before production).

```bash
# Pull (one-time):
ollama pull gemma2:2b-instruct-q4_K_M

# Evaluate against the golden set:
OLLAMA_CLASSIFIER_MODEL=gemma2:2b-instruct-q4_K_M \
  OLLAMA_CLASSIFIER_PROMPT_VERSION=v1 \
  npx tsx scripts/llm/classifier-golden-eval.ts
# And:
OLLAMA_CLASSIFIER_MODEL=gemma2:2b-instruct-q4_K_M \
  OLLAMA_CLASSIFIER_PROMPT_VERSION=v2 \
  npx tsx scripts/llm/classifier-golden-eval.ts

# Compare the 4 quadrants (qwen+v1, qwen+v2, gemma+v1, gemma+v2).
# Pick the winning (model, prompt) pair. Flip via .env:
sed -i 's|^OLLAMA_CLASSIFIER_MODEL=.*|OLLAMA_CLASSIFIER_MODEL=gemma2:2b-instruct-q4_K_M|' .env
sed -i 's|^OLLAMA_CLASSIFIER_PROMPT_VERSION=.*|OLLAMA_CLASSIFIER_PROMPT_VERSION=v2|' .env  # or v1
pm2 restart nexus-hub --update-env
```

VPS-side comparison data (when run): `/home/dominguez/telegram-hub-bot/data/classifier-golden-runs/*.json` carries per-quadrant per-domain stats.

5. **Doc updates** — `docs/runbooks/ollama-local-llm.md` and `docs/ai/model-routing-current-state.md` should describe the post-Option-3 routing (DONE 2026-05-26).
