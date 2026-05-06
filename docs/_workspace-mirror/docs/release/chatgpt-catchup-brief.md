# ChatGPT catch-up brief — Nexus Hub release pipeline

Status: canonical
Owner: release lead (Felipe)
Last verified: 2026-05-06
Update policy: update when release-pipeline handoff context changes.

This file is the self-contained snapshot for any LLM (ChatGPT, a fresh
Claude session, etc.) that needs to catch up on the current state of
Nexus Hub: what shipped, what's in flight, where the work lives, what
performance gains were measured, and what's still pending owner action.

**Paste the prompt block at the bottom of this file** to a new chat
when you want the assistant to come up to speed. Everything before
that block is reference for Felipe.

---

## How to send this to ChatGPT

The prompt block below is self-contained. Paste it as the first
message of a new conversation. ChatGPT will then have the same mental
model that the previous Claude session built up.

Quick clipboard command (macOS):

```bash
sed -n '/^# Nexus Hub release pipeline — catch-up/,$p' \
  "/Users/felipedominguez/Desktop/Nexus Hub/docs/release/chatgpt-catchup-brief.md" \
  | pbcopy
```

---

# Nexus Hub release pipeline — catch-up brief

You are joining a Nexus Hub session in progress. Read this brief once,
then ask Felipe what he wants to do next. Do NOT take destructive
actions or assume context beyond what's stated here.

## What Nexus Hub is

Nexus Hub is an AI-powered personal operating system. Backend is a
TypeScript/Node.js engine (`@nexushub/core`) running under PM2 on a
single Linux VPS, with a Python FastAPI content engine, a Swift/SwiftUI
iOS client, SQLite data, and a Cloudflare Tunnel for HTTPS. Domains:
secretary, training (gym/running/cycle/swim), content creator, finance,
cooking. Live-configurable model routing (Gemini primary, Anthropic
fallback, OpenAI secondary fallback) — never hardcode a provider.

## Workspace layout

- Workspace root: `/Users/felipedominguez/Desktop/Nexus Hub`
- Backend repo: `engine` (symlink to `…/cortex-telegram-hub-bot`)
- iOS repo: `ios` (symlink to `…/Nexus Hub IOS/Nexus Hub`)
- iOS specs: `ios-specs` (symlink to `…/Nexus Hub IOS/specs`)
- Canonical workspace docs: `docs/release/`, `docs/agent/`, `docs/archive/`
- Canonical workspace docs are NOT in a git repo themselves; the engine
  and iOS repos are tracked separately.

Read first when you need context:

- `docs/release/release-pipeline-optimization-report.md` — the canonical
  audit + redesign report (this whole pipeline overhaul)
- `docs/release/CURRENT_RELEASE_STATE.md` — production state
- `docs/release/OPEN_ITEMS.md` — open items, P0–P3
- `docs/release/release-identity.md` — auto-generated current branch /
  SHA / version snapshot (refreshed by every current-verdict commit)
- `docs/release/codex-deploy-process-brief.md` — operator brief for
  Codex (or any agent) to run the next release

## Current production state (as of 2026-05-03)

- Backend production version: **`4.14.123`**
- Production HEAD: `396b8f0` (a version-bump commit on top of
  `058b0de`, `b06cbb7`, `0ab56a8`)
- Production status: deployed, health-checked. Both `nexus-hub` and
  `content-engine` PM2 processes are online. Staging aligns to the
  same SHA.
- iOS `main` last pushed at `255522d` (pre-pipeline-overhaul state).

## Where the work-in-flight lives (NOT pushed)

Two feature branches with backup tags exist for one-command rollback.
Nothing has been pushed to `origin`.

### Engine

- Branch: `feature/release-pipeline-risk-based-optimization`
- Backup tag: `backup/pre-release-pipeline-optimization-2026-05-03`
- 18 commits ahead of `main` (newest first):
  ```
  3bf9a37 fix(training): harden local coach profile and equipment planning   ← Codex
  2603162 feat(release-pipeline): weekly housekeeping (prune + identity refresh)
  80c4506 feat(release-pipeline): wrap content-full-nexus-local smoke for JSON evidence
  466eaf5 feat(deploy): --dry-run mode for gate rehearsal
  aa2a89e feat(release-pipeline): smoke-evidence summary + prune tools
  37e3dff feat(release-identity): --persist mode + pre-commit auto-injection
  5bc7386 ci: wire vi-mock-completeness-lint + release-doc drift check (advisor + nightly)
  f8694c2 feat(staging-smoke): classifier-driven domain probes (bonus tier)
  2135bfe feat(promote-to-prod): reuse recent smoke-evidence for same staging SHA
  ff42e65 feat(release-pipeline): with-smoke-evidence wrapper + domain smokes
  f354b7d fix(release-doc-drift-check): strip UUIDs + allow cross-repo SHA refs
  1b8a0de fix(docs-audit): ignore git worktrees (false positives)
  5007b25 feat(release-pipeline): smoke-evidence JSON + release-doc drift checker
  9e2c890 perf(vitest): lift singleFork — 9 m 36 s → 1 m 20 s (7.22× speedup)
  82b4c78 feat(release-pipeline): vi.mock completeness lint (singleFork precondition)
  53d95b6 feat(deploy): NEXUS_DEPLOY_SKIP_VERIFY env-flag for risk-based deploy
  8cdb8c0 feat(release-pipeline): parallel CI matrix + nightly + archive dead workflow
  b304367 feat(release-pipeline): add changed-area classifier + risk-based hooks
  ```

### iOS

- Branch: `feature/release-pipeline-risk-based-optimization`
- Backup tag: `backup/pre-release-pipeline-optimization-2026-05-03`
- 3 commits ahead of `main` (newest first):
  ```
  945567d ci: add nightly XCUITest workflow
  672a0fc ci: add focused XCTest lane on macOS runner
  36e76d7 feat(beta-smoke): UDID-aware simulator destination
  ```

## What we built (the v2 risk-based release pipeline)

Before the audit, every release re-ran the full Vitest suite (~9 min,
thousands of cases under `singleFork: true`) at four layers: pre-commit,
pre-push, GitHub Actions CI, and `deploy.sh`. Quadruple redundancy on
the same artifact. At ~5 deploys per day cadence (244 cumulative
version-bump commits), this was hours per day of redundant compute.

The redesign:

### 1. Classifier-driven hooks (`engine/.husky/{pre-commit,pre-push}`)

`engine/scripts/changed-area-classifier.sh` reads `git diff` and emits
JSON listing the recommended Tier 0–6 lanes, Vitest globs, XCTest
classes, and required staging-smoke domain checks. Hooks consume that:

- Docs-only diff → skip Vitest entirely (5–7 s typecheck only)
- Source/test diff → focused Vitest against domain-scoped globs
- Test config / package.json → full Vitest (shared-behavior risk)
- Failure-safe: classifier failure → fall back to full Vitest

Escape hatches: `NEXUS_PRECOMMIT_FULL_VITEST=1`,
`NEXUS_PREPUSH_FULL_VITEST=1`, `NEXUS_PREPUSH_SKIP_VITEST=1`.

### 2. Lifted `singleFork: true` (`engine/vitest.config.ts`)

Empirical experiment: full Vitest **9 m 35 s → 1 m 20 s (7.22× speedup)**,
**6,557 / 6,557 pass** (vs 6,562 / 6,563 with `singleFork: true` —
the flake under `singleFork: true` was actually CAUSED by the shared
module cache, not despite it). Per-file fork isolation eliminates
cross-file mock pollution structurally.

The `engine/scripts/vi-mock-completeness-lint.mjs` lint is the
diagnostic for any future re-emergence; runs nightly with JSON
artifact upload.

### 3. `deploy.sh` env-flag + dry-run

- `NEXUS_DEPLOY_SKIP_VERIFY=1|auto-when-staged|0`: skip the redundant
  `npm run verify` (default off; `auto-when-staged` skips iff
  local↔staging dist hashes match).
- `--dry-run` / `NEXUS_DEPLOY_DRY_RUN=1`: exits after build phase,
  prints the full mutation surface (Steps 1a → 9). Useful for
  rehearsing risky deploys.

### 4. Parallel CI matrix + nightly

- `engine/.github/workflows/ci.yml` rewritten as classifier-driven
  parallel matrix: `lint ‖ test (focused/full/changed-only) ‖ build ‖
  python-test (only if content-engine/** changed) ‖ migrations (only
  if migrations/** changed)`.
- `engine/.github/workflows/nightly.yml` carries full Vitest with
  coverage, full Python compile, full migration rehearsal, strict
  drift check, and the vi-mock lint with JSON artifact upload. 04:15
  UTC daily.
- `engine/.github/workflows/cd-production.yml` archived (was dead
  code per its own header — IPv6-only VPS unreachable from GitHub
  runners).

### 5. Smoke-evidence ecosystem

- `engine/scripts/with-smoke-evidence.sh` — generic wrapper that
  captures exit code, duration, stdout/stderr tails, writes JSON
  evidence to `engine/docs/release/smoke-evidence/<smoke>-<sha>-<utc>.json`.
- `engine/scripts/staging-smoke.sh` writes per-check evidence + has
  classifier-driven domain probes (training, coach-kernel, calendar,
  cooking, content, secretary, migration).
- `engine/scripts/promote-to-prod.sh` reads recent (≤30 min) evidence
  and skips redundant smoke rerun on the same SHA.
- `engine/scripts/smoke-evidence-summary.sh` — read-only dashboard.
- `engine/scripts/smoke-evidence-prune.sh` — 60-day retention; always
  preserves the 5 newest records per smokeName.

### 6. Release identity (drift made impossible by construction)

- `engine/scripts/release-identity.sh --persist` writes
  `docs/release/release-identity.{json,md}` atomically.
- The pre-commit hook auto-refreshes that artifact when any
  current-verdict doc is staged, and auto-stages the artifact. No
  manual SHA / version / test-count typing.
- Workspace `CURRENT_RELEASE_STATE.md` migrated to reference the
  artifact instead of typing volatile fields by hand.

### 7. iOS test signal added

- `ios/.github/workflows/ios-tests.yml` — focused XCTest on PRs that
  touch Swift / xcconfig / xcodeproj / plist. Runs `Nexus HubTests`
  (161 unit-class tests) on a macos-latest runner with UDID-pinned
  simulator. (Previously iOS CI ran ZERO tests.)
- `ios/.github/workflows/ios-nightly.yml` — `Nexus HubUITests`
  nightly at 05:45 UTC. UDID-pinned, sequential, simulator-log
  capture on failure, 14-day artifact retention.
- `ios/scripts/beta-smoke-local.sh` — `IOS_SIM_UDID` opt-in path,
  `IOS_REQUIRE_UDID=1` fail-closed mode.

### 8. Weekly housekeeping

- `engine/scripts/release-pipeline-housekeeping.sh` — bundles
  `smoke-evidence-prune.sh` + `release-identity.sh --persist` +
  `docs:audit` advisory.
- `engine/.github/workflows/weekly-housekeeping.yml` — Sundays
  06:00 UTC. Does not push back to git.

### 9. Drift detection + cleanup

- `engine/scripts/release-doc-drift-check.sh` — cross-repo SHA
  reachability check for the seven canonical "current-verdict"
  docs. UUID-stripping + cross-repo SHA acceptance built in.
  Advisor mode in PR CI; strict mode runs nightly.
- `engine/scripts/audit-docs.mjs` — extended to ignore
  `worktrees/` directories (Codex-style parallel checkouts no
  longer inflate the issue count).

## Performance gains measured (anchored on real wall-clock)

| Gate | OLD config | NEW config | Reduction |
| --- | --- | --- | --- |
| Full Vitest | 9 m 35.63 s (with flake) | **1 m 19.76 – 1 m 25.61 s** (3 measurements; no flake) | **85 % · 7.2× speedup** |
| Pre-commit on docs/scripts/workflow change | 9 m 35 s | 5–7 s | **98.8 %** |
| Pre-commit on test-config / package.json | 9 m 35 s | ~1 m 25 s | **85 %** |
| `deploy.sh` `npm run verify` | 9 m 35 s | 1 m 25 s (or skip with env flag) | **85 % – 99 %** |
| `promote-to-prod.sh` smoke step | ~30 s SSH rerun | <1 s evidence-file read (when reuse fires) | **~97 %** |
| Audit "is the smoke green?" | ~30–60 s rerun | <1 s `smoke-evidence-summary.sh` | **~99 %** |

Per-deploy aggregate (post-adoption, ~5 deploys/day cadence):

- **Per day**: ~115–135 min recovered
- **Per week**: ~9.5–11 hours
- **Per month**: ~40–50 hours

Single-session anchor (this audit pass landed 18 engine + 3 iOS
commits): **~175 min recovered** vs the OLD config equivalent.
Approximately **97 % reduction on the same work**.

## What's pending owner action (NOT done by me)

| # | Action | Why owner-only |
| --- | --- | --- |
| 1 | `cd engine && git config core.hooksPath .husky` (each clone) | Workspace rule forbids the audit from changing git config. Per-clone delegate at `.git/hooks/pre-commit` is already in place on Felipe's Mac as a fallback. |
| 2 | Decide whether to set `export NEXUS_DEPLOY_SKIP_VERIFY=1` (or `auto-when-staged`) globally | Default-off env-flag flip is owner-approved |
| 3 | Push the engine + iOS feature branches to origin | Workspace rule forbids pushing without approval |
| 4 | Merge into `main` in each repo (after CI green on the PR) | Owner approval gate |
| 5 | Promote vi-mock lint + drift-check from advisor → strict on PRs | Soak-window decision; partial mocks remain (1,020 today) |

The `docs/release/codex-deploy-process-brief.md` covers (1)–(4)
explicitly as a step-by-step operator manual for Codex.

## Constraints (NON-NEGOTIABLE)

- Token-zero: operational reads/writes use REST `/api/v1/*` endpoints,
  not fake chat commands.
- Live-configurable model routing — never hardcode GPT, Claude,
  Gemini, or any provider as the product default.
- Multi-tenant isolation: tenant / auth / memory / calendar /
  provider boundaries are release blockers.
- No production data in any local validation flow.
- Don't push, deploy, force-push, rebase, amend, or remove CI jobs
  without explicit owner approval.
- Don't weaken any non-negotiable safety gate (tenant probes,
  prompt-injection defense, calendar lifecycle, model-routing
  fallback, owner approval, postdeploy health).

## Files added or changed in this audit pass

Tracked in engine repo:
- `engine/scripts/changed-area-classifier.sh` (new)
- `engine/scripts/vi-mock-completeness-lint.mjs` (new)
- `engine/scripts/release-doc-drift-check.sh` (new)
- `engine/scripts/with-smoke-evidence.sh` (new)
- `engine/scripts/smoke-evidence-summary.sh` (new)
- `engine/scripts/smoke-evidence-prune.sh` (new)
- `engine/scripts/release-pipeline-housekeeping.sh` (new)
- `engine/scripts/release-identity.sh` (edit — `--persist` mode)
- `engine/scripts/audit-docs.mjs` (edit — worktrees ignored)
- `engine/scripts/staging-smoke.sh` (edit — JSON evidence + domain probes)
- `engine/scripts/promote-to-prod.sh` (edit — evidence reuse)
- `engine/scripts/deploy.sh` (edit — env-flag + dry-run)
- `engine/scripts/training-calendar-staging-smoke.sh` (edit — wrap)
- `engine/scripts/training-cross-skill-staging-smoke.sh` (edit — wrap)
- `engine/.husky/pre-commit` (rewritten)
- `engine/.husky/pre-push` (rewritten)
- `engine/.github/workflows/ci.yml` (rewritten — parallel matrix)
- `engine/.github/workflows/nightly.yml` (new)
- `engine/.github/workflows/weekly-housekeeping.yml` (new)
- `engine/.github/workflows/cd-production.yml` → `.archived` (renamed)
- `engine/vitest.config.ts` (edit — `singleFork: false`)
- `engine/package.json` (edit — npm scripts wired through wrappers)

Tracked in iOS repo:
- `ios/scripts/beta-smoke-local.sh` (edit — UDID-aware)
- `ios/.github/workflows/ios-tests.yml` (new)
- `ios/.github/workflows/ios-nightly.yml` (new)
- `ios/.github/workflows/ios-release-hardening.yml` (edit — header annotation)

Workspace docs (not git-tracked, just files):
- `docs/release/release-pipeline-optimization-report.md` (the canonical report)
- `docs/release/OPEN_ITEMS.md` (updated)
- `docs/release/CURRENT_RELEASE_STATE.md` (migrated to identity reference)
- `docs/release/release-identity.json` (auto-generated)
- `docs/release/release-identity.md` (auto-generated)
- `docs/release/codex-deploy-process-brief.md` (operator brief for Codex)
- `docs/release/chatgpt-catchup-brief.md` (this file)

## Recovery if anything goes wrong

```bash
# In each repo:
git reset --hard backup/pre-release-pipeline-optimization-2026-05-03
```

That single command reverts every change. Nothing was deployed;
the backup tag predates all 18+3 commits.

## How to be useful from here

When Felipe asks you something, do these things first:

1. Re-read this brief.
2. Check the actual filesystem state if needed:
   - read the persisted release-identity file under
     `docs/release/release-identity.md` (workspace docs root) for the
     current branch, SHA, and version
   - `cd /Users/felipedominguez/Desktop/Nexus\ Hub/engine && git log --oneline -5`
     for recent engine commits
3. Don't propose changes that would push, deploy, force-push, rebase,
   amend, or remove CI jobs without Felipe's explicit approval.
4. If a question is operational ("how do I run X?"), point at the
   tool that does it. The pipeline now has tooling for almost
   everything.
5. If Felipe asks you to take the next release through the v2
   pipeline, use `docs/release/codex-deploy-process-brief.md` as
   the operator manual.

## Quick reference — common operations

| Question | Where to look |
| --- | --- |
| "What's deployed in production right now?" | `docs/release/release-identity.md` (auto-generated) |
| "What changed in this branch?" | `git log main..HEAD --oneline` (engine or ios) |
| "Did the staging smoke pass?" | `engine/scripts/smoke-evidence-summary.sh --latest` |
| "Is the new pipeline causing partial-mock issues?" | `engine/scripts/vi-mock-completeness-lint.mjs --top` |
| "Is the doc-drift check clean?" | `engine/scripts/release-doc-drift-check.sh` |
| "Rehearse a risky deploy" | `cd engine && ./scripts/deploy.sh --dry-run` |
| "Run weekly maintenance" | `cd engine && ./scripts/release-pipeline-housekeeping.sh --apply` |
| "How do I ship the next release?" | `docs/release/codex-deploy-process-brief.md` |

End of brief. Ask Felipe what's next.
