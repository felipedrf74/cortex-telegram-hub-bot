# Codex prompt — Sync VPS production source to Mac main (lands v3.2 + Phase K + Option 3 as one PR)

You are running on the **operator's Mac** with full filesystem access to
`/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot`
and SSH access to the VPS as `dominguez@serverdominguez`.

**Context — why this prompt exists.** Three layers of work currently live ONLY on the VPS production:

1. **v3.2** — Ollama integration baseline (Qwen3.6 35B-A3B). Originally
   shipped as a tarball that's been deleted from VPS snapshots, so we
   can't apply it as a clean patch anymore.
2. **Phase K** — `CREATIVE_TEXT_OWNERS` quality-gate exemption +
   runtime hard-block. Tracked as `phase-k-src.patch` on VPS.
3. **Option 3** — qwen2.5:3b shadow-eval classifier. Tracked as
   `option-3-src.patch` on VPS.

Mac `main` (last commit `fb1ca66d…`) has NONE of these. The right path
is a single **sync PR** that brings Mac `main` byte-equivalent to VPS
production for the touched files, while preserving any Mac-only files
that aren't part of these three layers (e.g., your dirty-tree work on
`codex/chat_improvement_goal`, the new `docs/templates/`,
`docs/ways-of-working/`, `AGENTS.md`, etc.).

Your job: rsync a curated file list from VPS to a fresh Mac worktree,
verify, and report. Do NOT commit, push, deploy, or promote — stop at
the report so the operator can review and decide.

## Prerequisites

```bash
# Where you are
hostname
uname -a | grep -q Darwin && echo "running on Mac (expected)" || { echo "FAIL: not Mac"; exit 1; }

# SSH to VPS works
ssh -o BatchMode=yes -o ConnectTimeout=5 dominguez@serverdominguez 'echo ok' \
  || { echo "FAIL: cannot ssh to serverdominguez"; exit 1; }

# rsync is installed (default on macOS)
which rsync || { echo "FAIL: rsync missing"; exit 1; }
```

## Step 0 — Create a fresh worktree from main

You may already have the sibling worktree from the prior attempt:
`~/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot-option3`.
Re-use it if its tree is clean and it points at `main` (or a branch
off main). Otherwise:

```bash
cd ~/Desktop/Custom\ Connectors/Cortex/cortex-telegram-hub-bot

# Verify main is reachable
git fetch origin

# Create a fresh worktree off origin/main (use a different sibling path if
# the prior one is in a weird state — the operator doesn't mind a re-create)
WORKTREE=~/Desktop/Custom\ Connectors/Cortex/cortex-telegram-hub-bot-vps-sync
git worktree add "$WORKTREE" origin/main || \
  { echo "FAIL: worktree create"; exit 1; }
cd "$WORKTREE"

# Create the feature branch
git checkout -b feat/ollama-stack-vps-sync-2026-05-26
git status --porcelain    # expect empty
git rev-parse HEAD        # capture this — it's your base commit for the report
```

## Step 1 — Curated rsync from VPS

The file list below covers everything v3.2 + Phase K + Option 3 touched.
Files NOT in this list (e.g., `CLAUDE.md`, `AGENTS.md`, `docs/templates/`,
`scripts/verify-agent-lanes.mjs`, your in-flight tests in
`__tests__/scripts/`, etc.) are NEVER touched by rsync — your other work
is safe.

```bash
cd "$WORKTREE"

# Generate the file list. Each path is relative to the repo root and exists
# on BOTH the VPS (always) and the Mac (only some — that's fine, rsync
# creates them as needed).
cat > /tmp/vps-sync-files.txt << 'EOF'
src/config.ts
src/router/classifier.ts
src/services/ai-provider.ts
src/services/anthropic.ts
src/services/anthropic-provider.ts
src/services/api-usage-fallback.ts
src/services/chat-response-quality-gate.ts
src/services/classify-shadow.ts
src/services/cloud-reasoning-gate.ts
src/services/cost-guardrail.ts
src/services/database-migrations.ts
src/services/domain-provider-router.ts
src/services/gemini-provider.ts
src/services/integration-health.ts
src/services/local-llm-error.ts
src/services/local-llm-rate-limiter.ts
src/services/model-config.ts
src/services/model-pricing.ts
src/services/ollama-provider.ts
src/services/openai-provider.ts
src/services/provider-fallback.ts
src/services/provider-registry.ts
src/services/scheduler.ts
src/services/script-generation.ts
src/services/token-estimator.ts
src/utils/hmac.ts
src/api/routes/chat-message-routes.ts
src/domains/domain-handler.ts
migrations/169_local_request_units.sql
migrations/170_script_generation_runs.sql
migrations/171_classify_shadow_runs.sql
scripts/install-ollama.sh
scripts/staging-smoke-ollama.sh
scripts/llm/local-llm-smoke.ts
scripts/llm/classifier-golden-eval.ts
data/classifier-golden-set.json
__tests__/services/ollama-provider.test.ts
__tests__/services/cloud-reasoning-gate.test.ts
__tests__/services/privacy-redacted-flow.test.ts
__tests__/services/v26-hardening.test.ts
__tests__/services/dispatch-privacy-e2e.test.ts
__tests__/services/script-generation.test.ts
__tests__/services/local-llm-rate-limiter.test.ts
__tests__/services/option-3-classifier.test.ts
__tests__/services/chat-response-quality-gate.test.ts
docs/runbooks/ollama-local-llm.md
docs/qa/work-orders/WO-ollama-local-llm.md
docs/qa/work-orders/WO-ollama-local-llm-mac-handoff.md
docs/qa/work-orders/OPEN_ITEMS_STATUS.md
docs/qa/prompts/codex-ollama-local-llm-qa.md
docs/qa/prompts/codex-option-3-classifier-qa.md
docs/qa/prompts/codex-mac-apply-option-3.md
docs/qa/prompts/codex-mac-apply-vps-sync.md
docs/ai/model-routing-current-state.md
EOF

# Sanity: how many files
wc -l /tmp/vps-sync-files.txt

# Pull from VPS. --files-from limits transfer to the explicit list. The
# `--ignore-missing-args` lets rsync skip any list entry that doesn't
# exist on VPS without aborting. Trailing slashes matter — keep them.
rsync -av --files-from=/tmp/vps-sync-files.txt --ignore-missing-args \
  dominguez@serverdominguez:/home/dominguez/telegram-hub-bot/ \
  "$WORKTREE/"

# Verify
echo
echo "=== Files synced ==="
git status --porcelain | head -60
echo
echo "=== Counts by category ==="
echo "Modified: $(git status --porcelain | grep -c '^ M')"
echo "Added (untracked → tracked): $(git status --porcelain | grep -c '^??')"
echo "Deleted: $(git status --porcelain | grep -c '^ D')"
```

**Expected:** ~50 files modified or added. ZERO deletions — rsync without
`--delete` never removes Mac-only files.

## Step 2 — Add the env vars (v3.2 + Option 3 keys)

`.env` is NOT in the rsync list (sensitive). Add the keys manually.

```bash
cd "$WORKTREE"

# Pre-flight: scan for duplicates
for k in OLLAMA_ENABLED OLLAMA_BASE_URL OLLAMA_MODEL OLLAMA_CLASSIFIER_MODEL \
         OLLAMA_OPERATIONAL_ROLLBACK_MODEL OLLAMA_TIMEOUT_MS \
         OLLAMA_CLASSIFY_MAX_INPUT_TOKENS OLLAMA_CLASSIFY_MAX_OUTPUT_TOKENS \
         OLLAMA_SCRIPT_GEN_MAX_INPUT_TOKENS OLLAMA_SCRIPT_GEN_MAX_OUTPUT_TOKENS \
         OLLAMA_LOCAL_REASONING_MAX_INPUT_TOKENS OLLAMA_LOCAL_REASONING_MAX_OUTPUT_TOKENS \
         LOCAL_LLM_QUEUE_BACKEND LOCAL_LLM_USER_DAILY_CALL_LIMIT \
         LOCAL_LLM_USER_HOURLY_CALL_LIMIT LOCAL_LLM_SCRIPT_DAILY_CALL_LIMIT \
         LOCAL_LLM_ARTIFACT_RETENTION_DAYS LOCAL_LLM_STORE_PROMPTS \
         LOCAL_LLM_STORE_GENERATED_ARTIFACTS AI_SCRIPT_GENERATION_PRIMARY \
         AI_SCRIPT_GENERATION_FALLBACK AI_LOCAL_REASONING_PRIMARY \
         AI_LOCAL_REASONING_FALLBACK CLOUD_REASONING_FALLBACK_ENABLED \
         CLOUD_REASONING_PROVIDER CLOUD_REASONING_MODEL \
         APPROVED_REASONING_MODELS DISALLOWED_COMPLEX_FALLBACK_MODELS \
         CLOUD_REASONING_PRIVACY_MODE LOCAL_LLM_EVALUATION_MODE \
         AI_SCRIPT_GENERATION_REQUIRE_LOCAL \
         OLLAMA_CLASSIFIER_MIN_CONFIDENCE OLLAMA_CLASSIFIER_TOOL_DOMAIN_MIN_CONFIDENCE \
         OLLAMA_CLASSIFY_TIMEOUT_MS OLLAMA_CLASSIFIER_NUM_CTX \
         OLLAMA_CLASSIFIER_NUM_PREDICT OLLAMA_CLASSIFIER_PROMPT_VERSION \
         LOCAL_LLM_CLASSIFY_SHADOW LOCAL_LLM_CLASSIFY_SHADOW_MAX_IN_FLIGHT \
         LOCAL_LLM_CLASSIFY_SHADOW_MAX_QUEUE CLASSIFY_SHADOW_RETENTION_DAYS \
         CLASSIFY_SHADOW_HASH_SECRET; do
  count=$(grep -c "^${k}=" .env 2>/dev/null || echo 0)
  case "$count" in
    0) echo "  $k: not set" ;;
    1) echo "  $k: already set (will REPLACE — except hash secret)" ;;
    *) echo "FAIL: $k duplicate"; exit 1 ;;
  esac
done

# Append the full env block. The values below are the production defaults
# from the VPS .env (excluding secrets). Adjust per your Mac-side needs.
cat >> .env << 'EOF'

# ── Local LLM (Ollama) — v3.2 ─────────────────────────────────────
OLLAMA_ENABLED=false
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3.6:35b-a3b-q4_K_M
OLLAMA_OPERATIONAL_ROLLBACK_MODEL=qwen3.6:27b-q4_K_M
OLLAMA_TIMEOUT_MS=360000
OLLAMA_CLASSIFY_MAX_INPUT_TOKENS=1500
OLLAMA_CLASSIFY_MAX_OUTPUT_TOKENS=128
OLLAMA_SCRIPT_GEN_MAX_INPUT_TOKENS=6000
OLLAMA_SCRIPT_GEN_MAX_OUTPUT_TOKENS=1800
OLLAMA_LOCAL_REASONING_MAX_INPUT_TOKENS=6000
OLLAMA_LOCAL_REASONING_MAX_OUTPUT_TOKENS=1200
LOCAL_LLM_QUEUE_BACKEND=memory
LOCAL_LLM_USER_DAILY_CALL_LIMIT=200
LOCAL_LLM_USER_HOURLY_CALL_LIMIT=40
LOCAL_LLM_SCRIPT_DAILY_CALL_LIMIT=20
LOCAL_LLM_ARTIFACT_RETENTION_DAYS=14
LOCAL_LLM_STORE_PROMPTS=false
LOCAL_LLM_STORE_GENERATED_ARTIFACTS=true
AI_SCRIPT_GENERATION_PRIMARY=ollama
AI_SCRIPT_GENERATION_FALLBACK=none
AI_LOCAL_REASONING_PRIMARY=ollama
AI_LOCAL_REASONING_FALLBACK=approved_cloud_reasoning
CLOUD_REASONING_FALLBACK_ENABLED=false
CLOUD_REASONING_PROVIDER=
CLOUD_REASONING_MODEL=
APPROVED_REASONING_MODELS=gemini-2.5-pro,claude-sonnet-4-6
DISALLOWED_COMPLEX_FALLBACK_MODELS=flash,flash-lite,nano,mini,haiku,lite,classifier,fast
CLOUD_REASONING_PRIVACY_MODE=redacted_only
LOCAL_LLM_EVALUATION_MODE=true
AI_SCRIPT_GENERATION_REQUIRE_LOCAL=true

# ── Option 3: dedicated small classifier + shadow-eval ────────────
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
EOF

# GENERATE-ONCE hash secret (per O3-A20) — Mac gets its OWN, NOT the VPS one
if ! grep -q '^CLASSIFY_SHADOW_HASH_SECRET=' .env; then
  echo "CLASSIFY_SHADOW_HASH_SECRET=$(openssl rand -hex 32)" >> .env
  echo "GENERATED Mac CLASSIFY_SHADOW_HASH_SECRET"
fi

# Verify counts: ~40 new lines added
grep -cE '^(OLLAMA_|LOCAL_LLM_|AI_SCRIPT_GENERATION_|AI_LOCAL_REASONING_|CLOUD_REASONING_|APPROVED_REASONING_|DISALLOWED_COMPLEX_|CLASSIFY_SHADOW_)' .env
```

## Step 3 — Build and typecheck

```bash
cd "$WORKTREE"

test -d node_modules || npm ci

npx tsc --noEmit
# Expected: clean.

npm run build
# Expected: completes.
```

If either fails, stop and report exact error.

## Step 4 — Targeted vitest (Option-3 + Phase K regression — 5 files, 97 tests)

```bash
cd "$WORKTREE"

npx vitest run --pool=forks --poolOptions.forks.singleFork=true \
  __tests__/services/option-3-classifier.test.ts \
  __tests__/services/chat-response-quality-gate.test.ts \
  __tests__/services/ollama-provider.test.ts \
  __tests__/services/provider-fallback.test.ts \
  __tests__/services/domain-provider-router.test.ts
```

**Expected: `Tests  97 passed (97)` in ~7 seconds.**

## Step 5 — v3.2 privacy/Ollama surface vitest (11 files, ~231 tests)

```bash
cd "$WORKTREE"

npx vitest run --pool=forks --poolOptions.forks.singleFork=true \
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
```

**Expected: 231 tests passing across 11 files (the v3.2 Codex round-8 floor).**

If any fail and the cause is `better-sqlite3 NODE_MODULE_VERSION` mismatch:
```bash
npm rebuild better-sqlite3
# then re-run.
```

## Step 6 — Full verify

```bash
cd "$WORKTREE"
npm run verify
# Expected (per CLAUDE.md current truth): 718 vitest files / 10,525 tests.
# After this PR, count should be ≥ 718 (a few of our test files are new).
```

## Step 7 — Inspect what landed

```bash
cd "$WORKTREE"

# Show the full diff against main
git status
git diff --stat main..HEAD       # nothing yet — no commits
git diff --stat                  # shows the working-tree diff

# Sample inspect — confirm a few key files are present + non-empty
ls -la src/services/ollama-provider.ts \
       src/services/classify-shadow.ts \
       src/utils/hmac.ts \
       migrations/171_classify_shadow_runs.sql \
       data/classifier-golden-set.json \
       __tests__/services/option-3-classifier.test.ts

# Check that Mac-only files were NOT touched
git status -- CLAUDE.md AGENTS.md docs/templates/ docs/ways-of-working/ \
              scripts/verify-agent-lanes.mjs scripts/verify-deliverable.mjs \
              __tests__/scripts/ 2>&1 | head -10
# Expected: empty (these aren't in our sync list and weren't touched).
```

## Stop here

Do NOT commit. The operator reviews your report. They'll decide:

1. Squash + commit as one PR titled
   `feat(ollama): land v3.2 + Phase K + Option 3 (VPS production sync 2026-05-26)`
2. Run the Codex angry-QA prompt
   (`docs/qa/prompts/codex-option-3-classifier-qa.md` — already in this tree)
   against the candidate before merging.
3. Standard staging → promote-to-prod flow.

## Report format

```
VPS-sync Mac apply report

worktree:    <absolute path to the worktree you used>
base_commit: <sha that origin/main was at when you branched>
mac_branch:  feat/ollama-stack-vps-sync-2026-05-26

Pre-flight:
  hostname: <mac name>
  ssh_to_vps: OK | FAILED
  rsync_present: YES | NO
  fresh_worktree: YES | NO (reason: <one line>)

rsync from VPS:
  files synced: <N> (expected ~50)
  modified:    <N>
  added:       <N>
  deleted:     0 (must be 0 — rsync ran without --delete)
  ANY MAC-ONLY FILE TOUCHED: NO | YES (list)

Env additions:
  v3.2 keys appended: <count>
  Option-3 keys appended: <count>
  CLASSIFY_SHADOW_HASH_SECRET: generated_new | preserved_existing
  duplicates aborted: <list or "none">

Build:
  npx tsc --noEmit: PASS | FAIL (<error excerpt>)
  npm run build:    PASS | FAIL (<error excerpt>)

Targeted vitest (5 files):
  result: 97 passed (97) | <X>/<Y> (<Z> failed)
  duration: <s>

v3.2 surface vitest (11 files):
  result: 231 passed (231) | <X>/<Y> (<Z> failed)
  duration: <s>

Full verify (npm run verify):
  before (CLAUDE.md baseline): 718 files / 10,525 tests
  after this branch:           <X> files / <Y> tests
  floor_maintained: YES | NO
  any newly-failing tests outside the 16 above:
    - <file:line:test name>  reason: <one line>

Files in working tree (sample):
  src/services/ollama-provider.ts:        <size> bytes
  src/services/classify-shadow.ts:        <size> bytes
  src/utils/hmac.ts:                      <size> bytes
  migrations/171_classify_shadow_runs.sql: <size> bytes
  data/classifier-golden-set.json:        <size> bytes
  __tests__/services/option-3-classifier.test.ts: <size> bytes

Mac-only files preserved (must show unchanged):
  CLAUDE.md:                              UNCHANGED | MODIFIED (<unexpected!>)
  AGENTS.md:                              UNCHANGED | MODIFIED
  docs/templates/:                        UNCHANGED | MODIFIED
  docs/ways-of-working/:                  UNCHANGED | MODIFIED
  scripts/verify-agent-lanes.mjs:         UNCHANGED | MODIFIED
  __tests__/scripts/:                     UNCHANGED | MODIFIED

Git state:
  uncommitted changes: <N> files modified, <M> files untracked
  log main..HEAD: <empty — nothing committed yet>

Recommendation: READY for commit + PR | RETURN — fix <thing> first
```

## Safety constraints (do not deviate)

- **Never commit, push, or amend without explicit operator approval.**
- **Never run** `git checkout .`, `git reset --hard`, `git clean -fd`,
  `rm -rf src/`, or anything destructive.
- **Never edit `.env` for any key outside the explicit list above.**
- **rsync MUST NOT use `--delete`** — that would remove Mac-only files.
- **If rsync fails for any individual file**, capture the exact error
  and report — do NOT silently skip and continue. (Some files may not
  exist on VPS if our file list is wrong; flag those so the operator
  can fix the prompt.)
- **If the 5-file regression vitest doesn't return 97/97**, the rsync
  pulled an incomplete file set — re-run rsync after confirming the
  file list matches the VPS source. Do NOT silence test failures.
- **If `npm ci` fails on Mac** (esp. native modules), do not delete
  `node_modules` and retry without reporting — let the operator see the
  exact error.
- **Never touch the operator's other worktree(s)** at
  `~/Desktop/Custom\ Connectors/Cortex/cortex-telegram-hub-bot` (the
  `codex/chat_improvement_goal` branch) — work only in your sibling
  worktree.

## Rollback (if something irrecoverable happens)

```bash
# Abort the sibling worktree entirely:
cd ~/Desktop/Custom\ Connectors/Cortex/cortex-telegram-hub-bot
git worktree remove --force ~/Desktop/Custom\ Connectors/Cortex/cortex-telegram-hub-bot-vps-sync 2>/dev/null
git branch -D feat/ollama-stack-vps-sync-2026-05-26 2>/dev/null

# Operator's chat_improvement_goal worktree is untouched.
# Mac main is untouched (we never pushed).
```

## Why a single sync PR instead of three layered patches

- The v3.2 tarball is no longer on VPS (deleted to save disk). The
  pre-v3.2 baseline doesn't exist as a snapshot. Reconstructing v3.2
  as a clean diff vs Mac main requires us to take the current
  production source and reverse-apply Phase K + Option 3 — fragile.
- The three layers are deeply intertwined: Phase K modified files v3.2
  created; Option 3 modified files Phase K modified. A three-PR landing
  order would require maintaining intermediate states that don't naturally
  exist in any history.
- The VPS production source IS the source of truth as of 2026-05-26.
  Syncing it to Mac via curated rsync, then opening one PR that reflects
  the actual production state, is the simplest reviewable unit.
- The PR title + body explicitly call out the three layers so the audit
  trail is clear. Future readers grep "v3.2", "Phase K", or "Option 3"
  in commit history and find this PR.

## Context references

- VPS source-of-truth (the target state):
  `dominguez@serverdominguez:/home/dominguez/telegram-hub-bot/src/`
- VPS pre-Phase-K snapshot (for forensic audit if needed):
  `/home/dominguez/snapshots/pre-ollama-v3.2-20260526-164248/src-pre-phase-k/`
- VPS pre-Option-3 snapshot:
  `/home/dominguez/snapshots/pre-ollama-v3.2-20260526-164248/option-3/src-pre-option-3/`
- VPS Mac handoff doc (read for the detailed v3.2 / Phase K / Option 3
  history this prompt collapses):
  `dominguez@serverdominguez:/home/dominguez/telegram-hub-bot/docs/qa/work-orders/WO-ollama-local-llm-mac-handoff.md`
- Codex angry-QA prompt (run AFTER this sync succeeds):
  `dominguez@serverdominguez:/home/dominguez/telegram-hub-bot/docs/qa/prompts/codex-option-3-classifier-qa.md`
