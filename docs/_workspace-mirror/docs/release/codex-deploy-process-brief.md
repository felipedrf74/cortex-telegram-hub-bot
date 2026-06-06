# Codex deploy brief — v2 release pipeline

Status: canonical
Owner: release lead (Felipe)
Last verified: 2026-05-06
Update policy: update when release-pipeline commands or gates change.

This file is the self-contained operator brief for executing a Nexus Hub
release using the v2 risk-based release pipeline (designed and
implemented on 2026-05-03 under
`docs/release/release-pipeline-optimization-report.md`).

Paste the **prompt block at the bottom of this file** to Codex when you
want it to take the next release through the full chain. Everything
before that block is reference for Felipe.

---

## What's already built (no action needed)

Sixteen engine commits + three iOS commits sit on local
`feature/release-pipeline-risk-based-optimization` branches in both
repos, with `backup/pre-release-pipeline-optimization-2026-05-03`
tags for one-command rollback. Nothing has been pushed.

The new tooling that Codex will USE:

- `engine/scripts/changed-area-classifier.sh` — diff-aware classifier; emits JSON or markdown
- `engine/scripts/release-identity.sh --persist` — atomic write of `docs/release/release-identity.{json,md}`
- `engine/.husky/pre-commit` and `pre-push` — classifier-driven, full Vitest only when needed (`vitest.config.ts` now `singleFork: false`, full suite ~1 m 25 s)
- `engine/scripts/staging-smoke.sh` — 17 generic checks + classifier-driven domain probes; writes per-check JSON evidence
- `engine/scripts/with-smoke-evidence.sh` — wrapper for any smoke; writes JSON envelope (training-calendar, training-cross-skill, cooking-portal, content-full-nexus-local already wired)
- `engine/scripts/promote-to-prod.sh` — reads recent (≤30 min) smoke-evidence; skips redundant rerun for same SHA
- `engine/scripts/deploy.sh` — `--dry-run` mode + `NEXUS_DEPLOY_SKIP_VERIFY=1|auto-when-staged` env-flag
- `engine/scripts/smoke-evidence-summary.sh` — read-only dashboard over `docs/release/smoke-evidence/`
- `engine/scripts/smoke-evidence-prune.sh` — 60-day retention, always keeps 5 newest per smokeName
- `engine/scripts/release-pipeline-housekeeping.sh` — weekly maintenance bundle
- `engine/scripts/vi-mock-completeness-lint.mjs` — pollution diagnostic
- `engine/scripts/release-doc-drift-check.sh` — cross-repo SHA reachability check
- iOS `ios-tests.yml` — focused XCTest on PR (Swift / xcconfig / xcodeproj diff trigger)
- iOS `ios-nightly.yml` — XCUITest nightly (UDID-pinned, 14-day artifact retention)
- iOS `beta-smoke-local.sh` — `IOS_SIM_UDID` opt-in, `IOS_REQUIRE_UDID=1` fail-closed

## What still needs an owner action (NOT done by me)

These four items require Felipe's explicit approval and can't be done
inside the audit's git-config + push restrictions:

| # | Action | Why owner-only |
| --- | --- | --- |
| 1 | `cd engine && git config core.hooksPath .husky` (each clone) | Workspace rule forbids me from changing git config |
| 2 | Decide whether to set `export NEXUS_DEPLOY_SKIP_VERIFY=1` (or `auto-when-staged`) in `~/.zshrc` / `~/.bashrc` / project `.env` | Default-off env-flag flip is owner-approved |
| 3 | Push the engine + iOS feature branches to origin (`git push origin feature/release-pipeline-risk-based-optimization` in each repo) | Workspace rule forbids me from pushing without approval |
| 4 | Merge into `main` in each repo (after CI green on the PR) | Owner approval gate |

The Codex prompt below assumes (1) is already done and walks Codex
through (2)–(4) explicitly so Codex doesn't have to make those calls.

## Branches to merge before the next release

- engine `feature/release-pipeline-risk-based-optimization` → `main` (16 commits)
- iOS `feature/release-pipeline-risk-based-optimization` → `main` (3 commits)

## Recovery, if anything goes wrong

```bash
# In each repo:
git reset --hard backup/pre-release-pipeline-optimization-2026-05-03
```

That single command reverts every change. Nothing was deployed; the
backup tag predates all 16+3 commits.

---

# Prompt to send to Codex (paste the block below)

> Copy everything from the next horizontal rule to the end of file.

---

You are taking the next Nexus Hub release through the v2 risk-based
release pipeline that was implemented on 2026-05-03. The full design
brief is at `docs/release/release-pipeline-optimization-report.md` and
the close-out items are at `docs/release/OPEN_ITEMS.md`. Read both
before you start.

## Working environment

- Workspace root: `/Users/felipedominguez/Desktop/Nexus Hub`
- Backend repo: `engine` (symlink to the Cortex backend checkout)
- iOS repo: `ios` (symlink to the Nexus Hub IOS checkout)
- Both repos have a current feature branch named
  `feature/release-pipeline-risk-based-optimization` containing the
  v2-pipeline changes; both repos have a backup tag
  `backup/pre-release-pipeline-optimization-2026-05-03` for rollback.

## Constraints (NON-NEGOTIABLE)

- Do not deploy to production without explicit owner approval.
- Do not push to `main` without explicit owner approval.
- Do not skip the staging smoke gate.
- Do not run `git config core.hooksPath` (Felipe handles that — see step 1).
- Do not amend, force-push, rebase, or remove CI jobs.
- Do not weaken tenant / auth / memory / calendar / provider isolation.
- Operational reads use REST endpoints, never fake chat commands.

## Step 1 — Activate the new hooks (Felipe-confirmed)

If `git config core.hooksPath` is not set in `engine/`, ask Felipe to
run: `cd engine && git config core.hooksPath .husky`. Then verify:

```bash
cd engine
git config core.hooksPath
# expected: .husky
```

If it returns nothing, the per-clone delegate at `.git/hooks/pre-commit`
is already in place (installed during the audit). Either is fine.

## Step 2 — Decide on `NEXUS_DEPLOY_SKIP_VERIFY`

The new `deploy.sh` skips its full-Vitest re-run when this env-flag is
set, because pre-push has already enforced the same gate on the same
SHA. Two safe modes:

- `1` (or `true` / `yes`) — typecheck only; trust the chain. Saves ~9 min.
- `auto-when-staged` — typecheck-only iff local↔staging dist hashes match (verified by `promote-to-prod.sh` before `deploy.sh` runs). Falls back to full verify otherwise.

Recommend `auto-when-staged` for the first release through the new
pipeline; promote to `1` after one stable week. Ask Felipe which mode
to use, then `export NEXUS_DEPLOY_SKIP_VERIFY=<mode>` for the session.

## Step 3 — Merge the v2 feature branches into `main`

For BOTH `engine` and `ios`:

1. `git fetch origin` and verify nothing pushed elsewhere supersedes the local branch.
2. Confirm the branch is on top of the latest `main`:
   - `git log --oneline main..feature/release-pipeline-risk-based-optimization`
   - Should show 16 engine commits or 3 iOS commits, no merge bubbles.
3. Push the feature branch to origin (with Felipe's approval):
   - `git push origin feature/release-pipeline-risk-based-optimization`
4. Open a PR in each repo. CI runs the new parallel matrix (engine) and the new XCTest lane (iOS).
5. After CI green AND Felipe's review, merge to `main`.

If CI flags new partial-mock findings (engine `vi-mock-completeness-lint`
advisor) or doc drift, do NOT block on advisor-mode warnings. They
become strict in nightly only. The vi-mock JSON artifact is uploaded
nightly for trend tracking.

## Step 4 — Run the v2 release loop for the next change set

Once `main` carries the v2 pipeline, the loop for any subsequent change is:

1. **Classify**: `engine/scripts/changed-area-classifier.sh --base origin/main --format markdown`. Read what tier and gates apply.
2. **Make the change** on a feature branch. The new pre-commit hook auto-classifies and runs only the necessary tests.
3. **Push the feature branch**. The new pre-push hook runs full Vitest on RC-class branches (`main`, `release/*`, `rc/*`, `feature/p0-*`, `feature/release-*`); focused on regular feature branches.
4. **Open a PR**. CI matrix runs in parallel: lint ‖ test (focused/full/changed-only) ‖ build ‖ python-test (only if `content-engine/**` changed) ‖ migrations (only if `migrations/**` changed).
5. **Refresh release identity** if a current-verdict doc is being touched: the pre-commit hook auto-runs `engine/scripts/release-identity.sh --persist` and auto-stages the artifact. No manual SHA typing.
6. **Merge to `main`** after green CI + owner approval.
7. **Deploy to staging**: `cd engine && ./scripts/deploy-staging.sh`.
8. **Smoke staging**: `./scripts/staging-smoke.sh`. The 17 generic checks + classifier-driven domain probes run; per-check JSON evidence lands in `engine/docs/release/smoke-evidence/`.
9. **Optional smoke summary**: `./scripts/smoke-evidence-summary.sh --latest --sha $(git rev-parse --short HEAD)` to show the latest run's verdict for THIS SHA.
10. **Promote to prod (only on owner approval)**: `./scripts/promote-to-prod.sh`. The script reads recent (≤30 min) smoke-evidence and skips redundant rerun if the SHA matches.
11. **Production deploy** runs through `deploy.sh`. With `NEXUS_DEPLOY_SKIP_VERIFY` set per Step 2, the full-Vitest re-run is skipped (it already ran in pre-push and CI).
12. **Postdeploy health**: deploy.sh does its built-in curl + PM2 jlist check. Watch the rollback window for 15 min.
13. **Run housekeeping** (Sunday or after a busy week): `./scripts/release-pipeline-housekeeping.sh --apply`.

## Step 5 — Risky-deploy rehearsal (use this any time)

Before any deploy you're nervous about, run:

```bash
cd engine
NEXUS_DEPLOY_SKIP_VERIFY=auto-when-staged ./scripts/deploy.sh --dry-run
```

This exercises typecheck + build + the verify-decision logic without
touching the server, git, or PM2. It prints the full mutation surface
(Steps 1a → 9 of the real deploy). If anything looks wrong, fix on the
feature branch before invoking the real deploy.

## Step 6 — If anything fails

- **Pre-commit too strict**: `NEXUS_PRECOMMIT_FULL_VITEST=1 git commit -m "..."` forces legacy full Vitest. Use sparingly.
- **Pre-push false-negative**: `NEXUS_PREPUSH_FULL_VITEST=1 git push ...`.
- **deploy.sh env-flag misclassifies**: unset `NEXUS_DEPLOY_SKIP_VERIFY` (or set to `0`); legacy full-verify behavior returns.
- **CI matrix breaks**: `gh workflow run "CI — Risk-based parallel matrix" -f mode=full`.
- **Need to fully revert**: `git reset --hard backup/pre-release-pipeline-optimization-2026-05-03` on each repo's branch (engine + ios). All pipeline changes are local; nothing was pushed to origin in the audit pass.

## Step 7 — When you finish

Update these canonical docs (the pre-commit hook auto-refreshes
release-identity for you):

- `docs/release/CURRENT_RELEASE_STATE.md` — production version, deploy outcome
- `docs/release/OPEN_ITEMS.md` — close any P1 items the release resolved
- `docs/release/release-pipeline-optimization-report.md` — append a Round-N section with the actually-observed wall-clock times so the team can validate the model against reality

## What to report back

- Engine + iOS branches merged + their final commit SHAs (read from `release-identity.md`, do not type by hand)
- Production version after deploy
- Wall-clock breakdown of the deploy: pre-commit / pre-push / CI / staging-smoke / promote-to-prod / postdeploy
- Any gate that fired unexpectedly (advisor-mode warnings, classifier surprises)
- Any non-negotiable safety gate that needed manual intervention
