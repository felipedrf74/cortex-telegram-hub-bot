# Agent Handoff — Weekly Prompt Guidance Check

## Session summary

**Started**: 2026-06-01T08:01:45Z automation wakeup
**Ended**: 2026-06-01T08:04:16Z
**Branch**: workspace root is not a git repo; iOS/engine worktrees inspected only
**Worktree**: `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub`
**Agent**: Codex

## What shipped

- Ran the weekly official-source prompt guidance audit for OpenAI Codex/GPT-5.5 and Anthropic Claude Code/Opus 4.8.
- Updated automation memory at `/Users/felipedominguez/.codex/automations/weekly-prompt-guidance-check/memory.md`.

## What's still pending

- P2: Apply the Claude Opus 4.8 working-rule note to shared agent prompt docs if Felipe wants the guidance promoted from automation memory to canonical docs.

## QA verdict

- Self-QA PASS: source links and observed headers/content were checked against official OpenAI and Anthropic pages only.

## Prod-promote authorization

- **Authorized**: no production work requested
- **Last green smoke**: not applicable
- **Reservations**: no deploy, code, or iOS runtime change

## Next agent's first 3 actions

1. If asked to update canonical prompts, add a concise Claude Opus 4.8 note to the shared agent docs.
2. Keep GPT-5.5 Codex guidance unchanged unless OpenAI releases a newer official model or materially changes prompt guidance.
3. Re-run this audit from official pages on the next scheduled Monday.

## Open questions / decisions deferred to user

- Whether to promote the Claude Opus 4.8 notes into canonical Nexus agent workflow docs now or wait for the next agent-doc refresh.

## Files not committed (working tree)

- Existing iOS and engine worktrees were already dirty with unrelated user/agent changes; this run did not modify those files.

## Ledger updates

- None. No feature flag or user-facing product surface shipped.

## Definition of done — verification (check those that landed)

- [ ] `npm run typecheck` passed
- [ ] `npm run verify` (vitest) passed
- [ ] `bash scripts/cannot-skip-gate-dashboard.sh --json --no-evidence` all gates pass
- [ ] `node scripts/vi-mock-completeness-lint.mjs --strict` exit 0
- [x] `npm run docs:audit` passed with existing baseline warnings
- [ ] iOS `xcodebuild build` (if iOS touched)
- [ ] iOS `xcodebuild test` via `scripts/ios-changed-area-runner.sh` (if iOS touched)
- [ ] Feature Delivery Ledger updated (if a new flag / feature shipped)
- [ ] Evidence doc landed under `docs/release/eval-evidence/`
- [ ] Staging deployed + 18/18 smoke pass (if shipping to prod path)
- [ ] Production promoted + `/health` confirms version (only when authorized)
