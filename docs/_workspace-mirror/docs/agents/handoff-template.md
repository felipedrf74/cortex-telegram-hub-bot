# Agent Handoff — <session-title-here>

> **Use this template at session end** to hand off to the next agent (Claude, Codex, or future-self). Keep it under 30 lines. The next agent's "session bootstrap" (per `CLAUDE.md > Agent Bootloader`) reads the most recent handoff doc.
>
> File-name convention: `docs/agents/handoffs/<YYYY-MM-DD>-<short-slug>.md`. Most recent file wins.

## Session summary

**Started**: <ISO date or "fresh session">
**Ended**: <ISO date>
**Branch**: `<branch-name>`
**Worktree**: `<absolute-path>`
**Agent**: <Claude Opus / Codex / etc.>

## What shipped

- <One-line bullet per delivery. Include commit shas. Link to evidence doc.>
- <Update the Feature Delivery Ledger: rows added/changed.>

## What's still pending

- <Bullet per open follow-up. Include severity (P0 / P1 / P2) where applicable.>

## QA verdict

- <Self-QA pass / hostile-QA verdict (PASS / PASS WITH MINOR ISSUES / PARTIAL / FAIL / NOT VERIFIED).>
- <Link to the QA evidence doc or the prompt sent to the QA reviewer.>

## Verifiable Reward Summary

- **Verdict**: <PASS / WARN / FAIL / MANUAL_REQUIRED / NOT_APPLICABLE>
- **Score**: <0-100 or "not scored">
- **Area**: <backend / ios / docs / release / research / auto>
- **Changed-area classifier**: <command + short result>
- **Hard failures**: <none / list>
- **Mandatory checks**: <pass/fail/skipped summary>
- **Skipped checks and reasons**: <acceptable skip / warning / manual review required / hard failure>
- **Evidence commands**: <commands actually run or evidence inspected>
- **Evidence artifacts**: <paths to tracked evidence; raw reward JSON stays in `.local/reward-runs/`>
- **Export eligibility**: <eligible / ineligible + reason>
- **Prompt/process improvement**: <one durable improvement or "none">

## Prod-promote authorization

- **Authorized**: <yes / no / explicit-string-from-user>
- **Last green smoke**: <staging-smoke evidence path + version>
- **Reservations**: <"the user said hold prod" / "ready when CI passes" / etc.>

## Next agent's first 3 actions

1. <Highest-priority action, with file paths if relevant.>
2. <Second action.>
3. <Third action.>

## Open questions / decisions deferred to user

- <Anything you didn't decide on the agent's behalf. Includes options + recommendation.>

## Files not committed (working tree)

- <Any uncommitted state the next agent should know about. Empty if working tree is clean.>

## Ledger updates

- <Specific rows added or changed in `docs/release/feature-delivery-ledger.md`. Empty if no ledger touches.>

## Definition of done — verification (check those that landed)

- [ ] `npm run typecheck` passed
- [ ] `npm run verify` (vitest) passed
- [ ] `bash scripts/cannot-skip-gate-dashboard.sh --json --no-evidence` all gates pass
- [ ] `node scripts/vi-mock-completeness-lint.mjs --strict` exit 0
- [ ] `npm run docs:audit` ≤ baseline
- [ ] iOS `xcodebuild build` (if iOS touched)
- [ ] iOS `xcodebuild test` via `scripts/ios-changed-area-runner.sh` (if iOS touched)
- [ ] Feature Delivery Ledger updated (if a new flag / feature shipped)
- [ ] Evidence doc landed under `docs/release/eval-evidence/`
- [ ] Staging deployed + 18/18 smoke pass (if shipping to prod path)
- [ ] Production promoted + `/health` confirms version (only when authorized)
