# Agent Handoff — Test-Infra Plan Landed (Scoped Runner + Ledger + Worktree Hygiene)

> Seed handoff for the `handoffs/` directory. Subsequent agents add files at `docs/agents/handoffs/<YYYY-MM-DD>-<slug>.md` using `docs/agents/handoff-template.md` as the boilerplate. The bootloader (`CLAUDE.md` / `AGENTS.md`) reads the most-recent file in this directory first.

## Session summary

**Started**: 2026-05-18 (continuation of a multi-day Phase 16 / Phase 17 / test-infra arc)
**Ended**: 2026-05-18
**Branch**: `feat/test-infra-scoped-runner` (backend) + `feat/test-infra-scoped-runner` (iOS)
**Worktree**: `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot-test-infra/` (backend) and `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub-test-infra/` (iOS)
**Agent**: Claude Opus 4.7 (1M context)

## What shipped

- **Backend** (`b1f264ee` + `34dcf75e`, both merged to `main`):
  - `scripts/changed-area-classifier.sh` extended with 11 new iOS feature flags (`iosHome`, `iosDecisionCenter`, `iosTraining`, `iosContent`, `iosCooking`, `iosFinance`, `iosChat`, `iosSettings`, `iosTasks`, `iosCalendar`, `iosSharedBehavior`) + per-feature XCTest class map. Also: `migrations.collisions[]` field (scans sibling local worktrees for prefix collisions).
  - `__tests__/scripts/changed-area-classifier.test.ts` +9 tests pinning the per-feature mapping (Home-only diff → 7 classes; Training/Decision Center pinned out).
  - `scripts/worktree-inventory.sh` (NEW) — list worktrees by age + merge state. `--stale`, `--prune-merged`, `--json` flags.
  - `scripts/gate-dashboard-parity.sh` (NEW) — compare local `cannot-skip-gate-dashboard.sh` count to `origin/main`; warn on drift.
  - `docs/release/feature-delivery-ledger.md` (NEW) — canonical "what's shipped, who owns it" registry. 9 seed rows. Mirrored to workspace.
  - `docs/agents/handoff-template.md` (NEW) — 30-line session-end boilerplate. Mirrored to workspace.
  - `docs/agents/handoffs/` (NEW directory) — this file is the seed entry.
  - `CLAUDE.md` updated to read the ledger + most-recent handoff first.

- **iOS** (`63b6bef`, merged to `main`):
  - `scripts/ios-changed-area-runner.sh` (NEW) — reads backend classifier's `xctest.{mode,classes}`, builds `-only-testing:` args, invokes `ios-single-simulator-test.sh`. Last-green cache at `~/.cache/nexus-ios-last-green/`.
  - `scripts/ios-single-simulator-test.sh` — per-worktree `simctl clone` strategy. `iPhone 17 Pro — <worktree-slug>`. Removed `simctl shutdown all` and other cross-worktree-destructive cleanups when `IOS_SIM_PER_WORKTREE=1` (default).
  - `.husky/pre-commit` (NEW) — invokes the focused runner. Escape hatches: `NEXUS_IOS_FOCUSED=0`, `NEXUS_IOS_NO_CACHE=1`, `NEXUS_IOS_PRECOMMIT_SKIP=1`.
  - `AGENTS.md` updated to lead with the focused runner + per-worktree clones, plus reads of the workspace ledger and most-recent handoff.

- **Workspace docs mirror** (`/Users/felipedominguez/Desktop/Nexus Hub/docs/`):
  - `release/feature-delivery-ledger.md` (mirrored)
  - `agents/handoff-template.md` (mirrored)

## What's still pending

- **P1 — `__tests__/scripts/feature-ledger-consistency.test.ts`** — deferred from Phase G. The ledger has no automatic enforcement test yet. The plan calls for a vitest that parses the markdown table and asserts: every flag in `runtime-flags.ts` has a row; every `tests` field references files that exist; every `in_prod` row's `current_version` is ≤ `package.json` version; every commit SHA resolves via `git cat-file -e`.
- **P1 — `scripts/sort-feature-ledger.sh`** — auto-sort the ledger by `flag` column on commit to minimize merge conflicts when two worktrees both edit it. Mentioned in the ledger doc as a Phase G follow-up.
- **P2 — Pre-commit nudge for `runtime-flags.ts` without a ledger touch** — soft warning when those files diverge. Mentioned in `CLAUDE.md`.

## QA verdict

- Self-QA: PASS. Backend `npm run typecheck` clean; `npx vitest run __tests__/scripts/` 4 files / 41 tests pass (was 18; +23 net). iOS `xcodebuild build` not re-run this session (no source changes, only scripts + docs).
- Classifier dry-run on a simulated Home-only diff: returns 7 classes (5 Home-specific + 2 always-on pins). Zero Training/Decision Center/Content classes — the per-feature scoping works as designed.

## Prod-promote authorization

- **Authorized**: no (and not needed — test-infra is local tooling; nothing deploys).
- **Last green smoke**: N/A for this work.
- **Reservations**: Felipe held the Phase 17 Home Orchestration Focus prod promote on `4.14.168` earlier. That decision is unchanged; the test-infra merge to main does NOT trigger a deploy.

## Next agent's first 3 actions

1. **Read this handoff first**, then `docs/release/feature-delivery-ledger.md`. The ledger lists what's `in_worktree` so you don't fork overlapping work.
2. **Run `bash scripts/worktree-inventory.sh --stale`** to see the current worktree landscape. ~22 backend + ~12 iOS worktrees exist; several are merged candidates for pruning.
3. **Check for in-flight work on `main`** via `git status --short` in both repos. As of this handoff there are uncommitted deploy-script + script + doc changes from a previous session ("deploy-latency plan 2026-05-17") that are NOT mine. Do not touch them without asking Felipe — they look like Codex work in progress.

## Open questions / decisions deferred to user

- **The Phase 17 / Home Orchestration Focus prod promote** is still held by Felipe ("hold prod for now"). Backend `4.14.168` is on the `codex/home-orchestration-focus` worktree, staging is current with it. Promote needs Felipe's explicit "type YES" authorization.
- **Migration 136 rename** (Phase 17 hostile-QA P0-2) — classifier blocked the rename mid-session. Operator action at merge time. The new `migrations.collisions[]` classifier field surfaces this automatically now.

## Files not committed (working tree at handoff time)

**Backend `main` worktree** — substantial WIP from another session (deploy-latency plan 2026-05-17):

- Modified: `package.json` (+ test:full, test:changed scripts), `scripts/deploy-staging.sh` (+14 -1), `scripts/deploy.sh` (+191 -36), `scripts/promote-to-prod.sh` (+96 -5), `scripts/staging-smoke.sh` (+14 -1)
- New (untracked): `.github/pull_request_template.md`, `docs/_workspace-mirror/docs/claude_code_qa_prompt_home_orchestration_focus.md`, `docs/release/qa-validation-merge-queue.md`, `docs/release/skill-hardening-plan-2026-05-17.md`, `docs/release/smoke-evidence/staging-smoke-0fb3b3f5-*.json`, `scripts/check-deploy-budget.sh`, `scripts/check-test-count.mjs`, `scripts/raise-test-ceiling.mjs`, `scripts/setup-ssh-controlmaster.sh`

**Backend `codex/training-google-validation` worktree**: 18 dirty files (separate Codex session).

**iOS `main` worktree** — small WIP:

- Modified: `Nexus Hub.xcodeproj/xcshareddata/xcschemes/Nexus Hub.xcscheme`
- New (untracked): `.github/workflows/ios-ui-chunked.yml`, `scripts/ios-feature-test-convention-check.sh`, `scripts/ios-session-test.sh`

These look like deploy-latency / test-pipeline hardening from another agent. Felipe should triage which to commit and to which branch before they accumulate further.

## Ledger updates

- 9 seed rows added in this session covering `chat_response_blocks`, `chat_response_cards`, the 5 Home Orchestration Focus flags, ES locale, and score-based intent. Phase 17 hostile-QA fixes referenced in the `notes` column of the Home Orchestration Focus rows.

## Definition of done — verification

- [x] `npm run typecheck` passed
- [x] `npm run verify` not re-run end-to-end this session (only the changed scripts/ tests); pre-commit hook on commit ran focused vitest (217 tests, PASS)
- [x] `bash scripts/cannot-skip-gate-dashboard.sh --json --no-evidence` 35/35 pass (via `gate-dashboard-parity.sh`)
- [x] iOS `xcodebuild build` skipped (no source changes)
- [x] iOS `xcodebuild test` skipped (no source changes — pure scripts + docs + AGENTS.md)
- [x] Feature Delivery Ledger seeded with 9 rows
- [x] Workspace docs mirror updated (`/Users/felipedominguez/Desktop/Nexus Hub/docs/release/feature-delivery-ledger.md` + `/agents/handoff-template.md`)
- [x] This handoff written
- [ ] Staging deploy — not applicable (local tooling)
- [ ] Production promote — not applicable (local tooling)
