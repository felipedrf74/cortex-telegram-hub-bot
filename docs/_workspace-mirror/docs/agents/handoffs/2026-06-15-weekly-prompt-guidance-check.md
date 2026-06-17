# Agent Handoff — Weekly Prompt Guidance Check

## Session summary

**Started**: 2026-06-15T09:00:00Z
**Ended**: 2026-06-15T09:06:00Z
**Branch**: `training-redesign/retirement`
**Worktree**: `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub`
**Agent**: Codex

## What shipped

- Completed the weekly official-source prompt guidance audit for OpenAI Codex/GPT guidance and Anthropic Claude prompting guidance.
- Wrote automation memory at `/Users/felipedominguez/.codex/automations/weekly-prompt-guidance-check/memory.md`.

## What's still pending

- No product/code follow-up from this audit.
- Keep Claude Fable 5 as a migration-prep item only until Anthropic restores official access.

## QA verdict

- NOT VERIFIED for app behavior; this was docs/source research only.
- `npm run docs:audit` exited 0 with the existing warning-heavy baseline plus an expected mirror-missing warning for this new handoff.
- Sources checked: official OpenAI API docs/changelog/models and official Anthropic Claude docs/news/release notes.

## Prod-promote authorization

- **Authorized**: no
- **Last green smoke**: not applicable
- **Reservations**: no code, backend, iOS, or production release action was performed.

## Next agent's first 3 actions

1. On the next weekly run, compare current page hashes against the memory file.
2. Check official OpenAI and Anthropic changelogs/news for new model or prompt-guidance changes since 2026-06-15.
3. If Anthropic restores Fable 5 access, reassess Claude Code default-model guidance before changing any workflow rules.

## Open questions / decisions deferred to user

- None.

## Files not committed (working tree)

- Pre-existing unrelated iOS checkout changes were present before this audit; they were not modified.
- New handoff file: `/Users/felipedominguez/Desktop/Nexus Hub/docs/agents/handoffs/2026-06-15-weekly-prompt-guidance-check.md`.
- Automation memory file outside the repo: `/Users/felipedominguez/.codex/automations/weekly-prompt-guidance-check/memory.md`.

## Ledger updates

- None; no feature flag or user-facing surface shipped.

## Definition of done — verification

- [ ] `npm run typecheck` passed
- [ ] `npm run verify` passed
- [ ] `bash scripts/cannot-skip-gate-dashboard.sh --json --no-evidence` all gates pass
- [ ] `node scripts/vi-mock-completeness-lint.mjs --strict` exit 0
- [x] `npm run docs:audit` <= baseline
- [ ] iOS `xcodebuild build` passed
- [ ] iOS `xcodebuild test` passed
- [ ] Feature Delivery Ledger updated
- [ ] Evidence doc landed under `docs/release/eval-evidence/`
- [ ] Staging deployed + smoke pass
- [ ] Production promoted + `/health` confirms version
