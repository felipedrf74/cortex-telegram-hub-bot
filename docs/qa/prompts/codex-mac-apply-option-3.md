# Codex prompt — Apply Option 3 on Mac main, verify, and report

You are running on the **operator's Mac** with full filesystem access to
`/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot`
and SSH access to the VPS as `dominguez@serverdominguez` (via Tailscale).

Your job: apply the Option-3 patch bundle that lives on the VPS, run
the verification gate, and report. Do NOT commit, push, deploy, or
promote — stop at the report so the operator can review your output
and decide the next move.

## Prerequisites (verify before doing anything)

```bash
# Where you are
hostname                    # expect: a Mac name, NOT ServerDominguez
uname -a | grep -q Darwin && echo "running on Mac (expected)" || { echo "FAIL: not Mac"; exit 1; }

# SSH to VPS works
ssh -o BatchMode=yes -o ConnectTimeout=5 dominguez@serverdominguez 'echo ok' \
  || { echo "FAIL: cannot ssh to serverdominguez. Operator must fix Tailscale / SSH config."; exit 1; }

# Verify the Mac source repo exists
cd ~/Desktop/Custom\ Connectors/Cortex/cortex-telegram-hub-bot \
  || { echo "FAIL: Mac source repo missing"; exit 1; }

# Git tree must be clean on main
git status --porcelain
test -z "$(git status --porcelain)" || { echo "FAIL: dirty git tree — operator must commit or stash first"; exit 1; }

git rev-parse --abbrev-ref HEAD
# Expected: main. If not, ask operator before continuing.
```

If any of the four checks above fail, STOP and report. Do not improvise.

## Detect state (which stacks are already on Mac main?)

```bash
cd ~/Desktop/Custom\ Connectors/Cortex/cortex-telegram-hub-bot

# v3.2 (Ollama integration baseline)
if [ -f src/services/ollama-provider.ts ]; then
  echo "v3.2: APPLIED (src/services/ollama-provider.ts exists)"
  V32_APPLIED=1
else
  echo "v3.2: MISSING"
  V32_APPLIED=0
fi

# Phase K (CREATIVE_TEXT_OWNERS + runtime hard-block)
if grep -q 'CREATIVE_TEXT_OWNERS' src/services/chat-response-quality-gate.ts 2>/dev/null; then
  echo "Phase K: APPLIED"
  PHASEK_APPLIED=1
else
  echo "Phase K: MISSING"
  PHASEK_APPLIED=0
fi

# Option 3 (classify-shadow + qwen2.5:3b classifier)
if [ -f src/services/classify-shadow.ts ]; then
  echo "Option 3: ALREADY APPLIED — nothing to do here. Run vitest only."
  OPT3_APPLIED=1
else
  echo "Option 3: MISSING (this prompt will apply it)"
  OPT3_APPLIED=0
fi
```

**Branching logic:**
- If `V32_APPLIED=0` OR `PHASEK_APPLIED=0`: STOP. This prompt only handles
  Option 3. Tell the operator to land v3.2 + Phase K first (separate
  bundles documented in `docs/qa/work-orders/WO-ollama-local-llm-mac-handoff.md`).
  Do NOT try to apply Option 3 on top of a missing prerequisite — patch
  hunks would fail and partially-apply.
- If `OPT3_APPLIED=1`: skip the patch steps, go straight to the verify step.
- If `V32_APPLIED=1 && PHASEK_APPLIED=1 && OPT3_APPLIED=0`: proceed with
  the apply below.

## Create a feature branch

```bash
cd ~/Desktop/Custom\ Connectors/Cortex/cortex-telegram-hub-bot
git checkout -b feat/option-3-classifier-shadow-2026-05-26 main
```

## Step 1 — Pull the patch bundle from VPS

```bash
BUNDLE_DIR=~/Downloads/option-3-bundle
rm -rf "$BUNDLE_DIR"
mkdir -p "$BUNDLE_DIR/new-files"

VPS_SRC=/home/dominguez/snapshots/pre-ollama-v3.2-20260526-164248/option-3

# Three patches
scp dominguez@serverdominguez:"$VPS_SRC/option-3-src.patch" "$BUNDLE_DIR/"
scp dominguez@serverdominguez:"$VPS_SRC/install-ollama.sh.patch" "$BUNDLE_DIR/"
scp dominguez@serverdominguez:"$VPS_SRC/ollama-provider.test.ts.patch" "$BUNDLE_DIR/"

# Seven new files
scp dominguez@serverdominguez:"$VPS_SRC/new-files/171_classify_shadow_runs.sql" "$BUNDLE_DIR/new-files/"
scp dominguez@serverdominguez:"$VPS_SRC/new-files/classify-shadow.ts"         "$BUNDLE_DIR/new-files/"
scp dominguez@serverdominguez:"$VPS_SRC/new-files/hmac.ts"                    "$BUNDLE_DIR/new-files/"
scp dominguez@serverdominguez:"$VPS_SRC/new-files/classifier-golden-set.json" "$BUNDLE_DIR/new-files/"
scp dominguez@serverdominguez:"$VPS_SRC/new-files/classifier-golden-eval.ts"  "$BUNDLE_DIR/new-files/"
scp dominguez@serverdominguez:"$VPS_SRC/new-files/option-3-classifier.test.ts"            "$BUNDLE_DIR/new-files/"
scp dominguez@serverdominguez:"$VPS_SRC/new-files/chat-response-quality-gate.test.ts"     "$BUNDLE_DIR/new-files/"

# Verify
ls -la "$BUNDLE_DIR"/*.patch "$BUNDLE_DIR/new-files/"
wc -l "$BUNDLE_DIR"/option-3-src.patch
# Expected: ~3919 lines for option-3-src.patch.
```

## Step 2 — Apply the three patches via `patch -p1`

```bash
cd ~/Desktop/Custom\ Connectors/Cortex/cortex-telegram-hub-bot
BUNDLE_DIR=~/Downloads/option-3-bundle

# Dry-run all three first. If ANY rejects appear, ABORT and report.
patch -p1 --dry-run -i "$BUNDLE_DIR/option-3-src.patch"               || { echo "FAIL: option-3-src.patch dry-run"; exit 1; }
patch -p1 --dry-run -i "$BUNDLE_DIR/install-ollama.sh.patch"          || { echo "FAIL: install-ollama.sh.patch dry-run"; exit 1; }
patch -p1 --dry-run -i "$BUNDLE_DIR/ollama-provider.test.ts.patch"    || { echo "FAIL: ollama-provider.test.ts.patch dry-run"; exit 1; }

# Real apply.
patch -p1 -i "$BUNDLE_DIR/option-3-src.patch"
patch -p1 -i "$BUNDLE_DIR/install-ollama.sh.patch"
patch -p1 -i "$BUNDLE_DIR/ollama-provider.test.ts.patch"

# Sanity: no reject files
find . -name '*.rej' -type f 2>/dev/null | head
test -z "$(find . -name '*.rej' -type f 2>/dev/null)" || { echo "FAIL: reject files present"; exit 1; }
```

## Step 3 — Copy the seven new files

```bash
cd ~/Desktop/Custom\ Connectors/Cortex/cortex-telegram-hub-bot
BUNDLE_DIR=~/Downloads/option-3-bundle

# The patch already creates src/services/classify-shadow.ts and src/utils/hmac.ts.
# The remaining FIVE new files need explicit copy.
cp "$BUNDLE_DIR/new-files/171_classify_shadow_runs.sql"             migrations/
cp "$BUNDLE_DIR/new-files/classifier-golden-set.json"               data/
cp "$BUNDLE_DIR/new-files/classifier-golden-eval.ts"                scripts/llm/
chmod +x scripts/llm/classifier-golden-eval.ts
cp "$BUNDLE_DIR/new-files/option-3-classifier.test.ts"              __tests__/services/
cp "$BUNDLE_DIR/new-files/chat-response-quality-gate.test.ts"       __tests__/services/

# Verify all 14 expected new/modified files exist
ls -la src/services/classify-shadow.ts \
       src/utils/hmac.ts \
       migrations/171_classify_shadow_runs.sql \
       data/classifier-golden-set.json \
       scripts/llm/classifier-golden-eval.ts \
       __tests__/services/option-3-classifier.test.ts \
       __tests__/services/chat-response-quality-gate.test.ts
```

## Step 4 — Add the 12 env vars to Mac `.env`

`CLASSIFY_SHADOW_HASH_SECRET` is **generate-once on Mac** (do NOT
reuse the VPS secret — they're independent installs).

```bash
cd ~/Desktop/Custom\ Connectors/Cortex/cortex-telegram-hub-bot

# Pre-flight: check that none of these are already set with conflicting values
for k in OLLAMA_CLASSIFIER_MODEL OLLAMA_CLASSIFIER_MIN_CONFIDENCE \
         OLLAMA_CLASSIFIER_TOOL_DOMAIN_MIN_CONFIDENCE OLLAMA_CLASSIFY_TIMEOUT_MS \
         OLLAMA_CLASSIFIER_NUM_CTX OLLAMA_CLASSIFIER_NUM_PREDICT \
         OLLAMA_CLASSIFIER_PROMPT_VERSION LOCAL_LLM_CLASSIFY_SHADOW \
         LOCAL_LLM_CLASSIFY_SHADOW_MAX_IN_FLIGHT LOCAL_LLM_CLASSIFY_SHADOW_MAX_QUEUE \
         CLASSIFY_SHADOW_RETENTION_DAYS CLASSIFY_SHADOW_HASH_SECRET; do
  count=$(grep -c "^${k}=" .env 2>/dev/null || echo 0)
  case "$count" in
    0) echo "  $k: not set (will add)" ;;
    1) echo "  $k: already set (will REPLACE — except hash secret, see below)" ;;
    *) echo "FAIL: $k has $count duplicate lines — operator must clean manually"; exit 1 ;;
  esac
done

# Group 1: idempotent key=value pairs (replace-or-append; abort on duplicates)
for kv in \
  'OLLAMA_CLASSIFIER_MODEL=qwen2.5:3b-instruct-q4_K_M' \
  'OLLAMA_CLASSIFIER_MIN_CONFIDENCE=0.65' \
  'OLLAMA_CLASSIFIER_TOOL_DOMAIN_MIN_CONFIDENCE=0.80' \
  'OLLAMA_CLASSIFY_TIMEOUT_MS=5000' \
  'OLLAMA_CLASSIFIER_NUM_CTX=2048' \
  'OLLAMA_CLASSIFIER_NUM_PREDICT=32' \
  'OLLAMA_CLASSIFIER_PROMPT_VERSION=v1' \
  'LOCAL_LLM_CLASSIFY_SHADOW=true' \
  'LOCAL_LLM_CLASSIFY_SHADOW_MAX_IN_FLIGHT=1' \
  'LOCAL_LLM_CLASSIFY_SHADOW_MAX_QUEUE=4' \
  'CLASSIFY_SHADOW_RETENTION_DAYS=30'; do
  key="${kv%%=*}"
  count=$(grep -c "^${key}=" .env 2>/dev/null || echo 0)
  if [ "$count" = "0" ]; then
    echo "${kv}" >> .env
    echo "APPEND: $key"
  elif [ "$count" = "1" ]; then
    # macOS sed needs -i ''
    sed -i '' "s|^${key}=.*|${kv}|" .env
    echo "REPLACE: $key"
  else
    echo "FAIL: duplicate ${key} lines"; exit 1
  fi
done

# Group 2: GENERATE-ONCE for CLASSIFY_SHADOW_HASH_SECRET (per O3-A20)
count=$(grep -c '^CLASSIFY_SHADOW_HASH_SECRET=' .env 2>/dev/null || echo 0)
if [ "$count" = "0" ]; then
  NEW_SECRET=$(openssl rand -hex 32)
  echo "CLASSIFY_SHADOW_HASH_SECRET=${NEW_SECRET}" >> .env
  echo "GENERATED Mac CLASSIFY_SHADOW_HASH_SECRET (do NOT rotate on subsequent deploys)"
elif [ "$count" = "1" ]; then
  echo "PRESERVED existing Mac CLASSIFY_SHADOW_HASH_SECRET (per O3-A20)"
else
  echo "FAIL: duplicate CLASSIFY_SHADOW_HASH_SECRET lines"; exit 1
fi

# Post-edit verification
echo
echo "=== Post-edit verification ==="
grep -cE '^(OLLAMA_CLASSIFIER|LOCAL_LLM_CLASSIFY_SHADOW|CLASSIFY_SHADOW|OLLAMA_CLASSIFY_TIMEOUT_MS)' .env
# Expected: 12 (the 11 from Group 1 plus the secret from Group 2).
```

## Step 5 — Build and typecheck

```bash
cd ~/Desktop/Custom\ Connectors/Cortex/cortex-telegram-hub-bot

# Install deps first if Mac doesn't have them already.
test -d node_modules || npm ci

npx tsc --noEmit
# Expected: clean exit (no errors).

npm run build
# Expected: completes; dist/ is regenerated.
```

If either fails, stop and report the exact error.

## Step 6 — Run the 5-file regression vitest

```bash
cd ~/Desktop/Custom\ Connectors/Cortex/cortex-telegram-hub-bot

npx vitest run --pool=forks --poolOptions.forks.singleFork=true \
  __tests__/services/option-3-classifier.test.ts \
  __tests__/services/chat-response-quality-gate.test.ts \
  __tests__/services/ollama-provider.test.ts \
  __tests__/services/provider-fallback.test.ts \
  __tests__/services/domain-provider-router.test.ts
```

**Expected: `Tests  97 passed (97)` in ~7 seconds.**

If you get any other count or any failures, stop. Do NOT try to silence
them — the patch wasn't applied to the right baseline OR a prior layer
is missing.

## Step 7 — Run the broader verify (operator's standard floor)

```bash
cd ~/Desktop/Custom\ Connectors/Cortex/cortex-telegram-hub-bot

npm run verify
# Expected per CLAUDE.md current-truth: 718 vitest files / 10,525 tests passing.
# (If the floor has moved since CLAUDE.md last updated, that's fine — the
# important thing is that the count post-Option-3 is >= pre-Option-3 and
# all suites pass.)
```

If the verify floor drops, stop and report.

## Step 8 — Inspect what landed (for the report)

```bash
cd ~/Desktop/Custom\ Connectors/Cortex/cortex-telegram-hub-bot

git status
git diff --stat main..HEAD
git log --oneline main..HEAD
# Expected: no commits yet (we haven't committed); status shows modifications +
# untracked new files matching the bundle.
```

## Stop here

Do not commit, do not push, do not merge, do not deploy. The operator
reviews your report, then decides whether to:

1. Squash to a single feature commit + open a PR.
2. Run the Codex angry-QA prompt
   (`docs/qa/prompts/codex-option-3-classifier-qa.md`) against the candidate.
3. Deploy via the standard `scripts/deploy-staging.sh` →
   `scripts/promote-to-prod.sh` flow.

## Report format

Return:

```
Option-3 Mac apply report
mac_branch: feat/option-3-classifier-shadow-2026-05-26
base_commit: <sha that main was at when you branched>

Pre-flight:
  hostname: <mac name>
  ssh_to_vps: OK | FAILED
  git_tree_clean: YES | NO
  on_main: YES | NO (was on <branch>)

Pre-existing layers:
  v3.2:     APPLIED | MISSING
  Phase K:  APPLIED | MISSING
  Option 3: ALREADY APPLIED | MISSING (now applied)

Patch apply:
  option-3-src.patch:              clean | FAIL (rejects: <n>)
  install-ollama.sh.patch:         clean | FAIL
  ollama-provider.test.ts.patch:   clean | FAIL (offset: <n>)

New files copied (5):
  migrations/171_classify_shadow_runs.sql
  data/classifier-golden-set.json
  scripts/llm/classifier-golden-eval.ts
  __tests__/services/option-3-classifier.test.ts
  __tests__/services/chat-response-quality-gate.test.ts

Env vars in Mac .env:
  12 expected, <N> present, <duplicate keys>: <none|list>
  CLASSIFY_SHADOW_HASH_SECRET: generated_new | preserved_existing

Build:
  npx tsc --noEmit: PASS | FAIL (<error excerpt>)
  npm run build:    PASS | FAIL (<error excerpt>)

5-file regression vitest:
  result: 97 passed (97) | <X> passed (<Y> total, <Z> failed)
  duration: <s>

Broader verify (npm run verify):
  before (CLAUDE.md baseline): 718 files / 10,525 tests
  after this branch:           <X> files / <Y> tests
  floor_maintained: YES | NO
  any newly-failing tests outside the 5-file regression list:
    - <file:line:test name>  reason: <one line>

Git state:
  uncommitted changes: <N> files modified, <M> files untracked
  log main..HEAD: <empty — nothing committed yet>

Recommendation: READY for commit + PR | RETURN — fix <thing> first
```

## Safety constraints (do not deviate)

- **Never commit, push, or amend without explicit operator approval.**
- **Never run** `git checkout .`, `git reset --hard`, `git clean -fd`,
  `rm -rf src/`, or anything destructive to the work tree.
- **Never edit `.env` for any key outside the 12 listed above.**
- **Never connect to production** — this prompt is Mac-side only. Do
  not `ssh` to the VPS for anything other than `scp` of the patch
  bundle files listed in Step 1.
- **If a patch fails to apply,** capture the exact failure output and
  report. Do NOT try to manually edit the source to "fix" the patch —
  that creates source drift between Mac and VPS that's nearly
  impossible to reconcile later.
- **If `npm ci` or `npm run build` fails on Mac,** do not delete
  `node_modules` and retry without saying so. Report the failure and
  let the operator decide.
- **If the verify floor drops,** the patch probably broke an unrelated
  test. Report exactly which test, do not silence or skip.

## Rollback (if something irrecoverable happens)

```bash
cd ~/Desktop/Custom\ Connectors/Cortex/cortex-telegram-hub-bot

# Abort the branch entirely — main is untouched:
git checkout main
git branch -D feat/option-3-classifier-shadow-2026-05-26

# Restore Mac .env from the most recent operator backup if needed.
# (Operator's responsibility — this prompt does not modify the secret.)
```

## Context references

- Full Mac handoff doc on VPS (read for prior-layer context):
  `/home/dominguez/telegram-hub-bot/docs/qa/work-orders/WO-ollama-local-llm-mac-handoff.md`
- VPS patch bundle directory:
  `/home/dominguez/snapshots/pre-ollama-v3.2-20260526-164248/option-3/`
- VPS source-of-truth (the patched state you're aiming to reproduce):
  `/home/dominguez/telegram-hub-bot/src/`
- Codex angry-QA prompt (run AFTER this apply succeeds):
  `/home/dominguez/telegram-hub-bot/docs/qa/prompts/codex-option-3-classifier-qa.md`
