# Agent Handoff — Training Bug-Fixes + Outlook Default Production Promote

## Session summary

**Started**: 2026-05-25 fresh session (catch-up after worktree cleanup)
**Ended**: 2026-05-25T16:24Z
**Branches**: `claude/training-bugfix-cancel-volume-body-20260525` (PR #137) and `claude/training-outlook-default-enabled-20260525` (PR #138), both merged to `main`.
**Worktree**: `/Users/felipedominguez/Desktop/Nexus Hub/worktrees/confirmation-main-promote-20260523`
**Agent**: Claude Opus 4.7 (1M context)

## What shipped

- **PR #137 → 4.14.194 (`fb1f844e`)** — Training bug-fix triplet promoted via standard `promote-to-prod.sh` after 17/17 staging smoke and a clean `npm run verify` (10,544 tests). Closed three concurrent user-reported bugs:
  - Cancel cascade match broadened to all `plan_version`s (`source_intent_id LIKE 'training:${planId}:%'`) plus new `findSecretaryAgendaCalendarEventsForPlan` helper for Secretary-owned events without ownership rows. Files: `src/services/training-plan-cancellation-cascade.ts`, `src/api/routes/training-plan-cancellation.ts`.
  - `twoADayPreference: "auto"` now accepted by route validator; first-class `'auto'` branch in `resolveMaxSessionsPerDay`; hybrid `resolveWeeklyTargets` respects explicit per-sport asks when both `runSessionsPerWeek` and `strengthSessionsPerWeek > 0`; volume enforcer sums explicit per-sport totals regardless of `planSport`. Files: `src/api/routes/training-plan-routes.ts`, `src/services/training-coach-kernel-plan-generator.ts`, `src/services/training-plan-volume-enforcement.ts`, types in `coach-kernel/types.ts` + `training-profile-model.ts` + `training-plan-generation.ts`.
  - Calendar event body Stage 1 — `sourceBodyForSecretaryCalendarEvent` hydrates from `description_json` via existing `renderSectionsAsText`, then falls back to `title · intensity · duration min`; body now puts workout content first, then `────────────` divider, then markers. `extractSecretaryAgendaMarker` unchanged so legacy events still resolve. File: `src/services/secretary-unified-calendar-provider-adapter.ts`.
- **PR #138 → 4.14.195 (`0682b34b`)** — Removed the opt-in `TRAINING_CALENDAR_OUTLOOK_ENABLED` env requirement: Outlook now ON by default for training plan creation, matching Google's contract. `TRAINING_CALENDAR_OUTLOOK_DISABLED=1` retained as kill switch. Behavior side-effect: `createTrainingCalendarEvent` no longer forces `'google'` in the auto-target path. Files: `src/services/training-operational-switches.ts` + 5 test files updated to pin the new default-on contract.
- Smoke evidence committed: `staging-smoke-d94c2d1a-20260525T101747Z.json` (PR #137) and `staging-smoke-0bae01cb-20260525T161058Z.json` (PR #138).
- Release-state docs updated: `docs/release/CURRENT_RELEASE_STATE.md` + `docs/release/current-release-index.md` (this commit).

## What's still pending

- **P2** — Track C Stage 2 for the calendar body architecture: move `NEXUS_SECRETARY_*` markers entirely to Google `extendedProperties.private` + Outlook `singleValueExtendedProperties` so the visible body is 100% workout content. Deferred because there's zero existing extended-properties plumbing in either calendar adapter; doing it would have doubled PR #137's size + needed cross-provider integration testing. Stage 1 (workout content first, divider, then markers) already solves the user-visible symptom.
- **P3** — Operator runbook docs: `TRAINING_CALENDAR_OUTLOOK_ENABLED` is no longer required in `.env` for Outlook to be reachable. Update any runbook still referencing the legacy opt-in. Mentioned in PR #138 commit body as queued work.
- **P3** — `nexushub-landing-deploy` and Cloudflare Tunnel supervised-service follow-ups from the prior briefing are still open (not touched this session).

## QA verdict

- PASS. Both deploys verified end-to-end:
  - `npx tsc --noEmit` clean.
  - `npm run verify` 718 files / 10,544 tests (PR #137) and 718 files / 10,555 tests (PR #138).
  - Staging smoke 17/17 each cycle.
  - `promote-to-prod.sh` completed cleanly; PM2 restarted; `/health` returned `status: healthy` with fresh uptime after each deploy.

## Prod-promote authorization

- **Authorized**: yes — Felipe said "push to prod the changes" (PR #137 chain) and chose "Push smoke evidence to main + promote to prod (Recommended)" via AskUserQuestion for PR #138.
- **Last green smoke**: `docs/release/smoke-evidence/staging-smoke-0bae01cb-20260525T161058Z.json` (4.14.195).
- **Reservations**: production stable at 4.14.195. If the Outlook integration surfaces a regression, the kill switch `TRAINING_CALENDAR_OUTLOOK_DISABLED=1` reverts behavior without a redeploy.

## Next agent's first 3 actions

1. **Verify user-facing outcome** on Felipe's iOS: create a new training plan with Outlook selected and `Two-a-day = Auto` + `5 gym + 5 run + Saturday long` → assert it succeeds and produces ≥3 two-a-day weekdays with sessions appearing in Outlook with workout content (no NEXUS_SECRETARY_* in the visible body when description_json is populated).
2. **If a regression appears**, the rollback for Outlook is fast: `ssh dominguez@serverdominguez "echo 'TRAINING_CALENDAR_OUTLOOK_DISABLED=1' >> /home/dominguez/telegram-hub-bot/.env && pm2 restart nexus-hub"`. Production code stays at 4.14.195; the kill switch just disables the gate.
3. **Pick up Track C Stage 2** (markers → provider-private fields) only when ready to add net-new extended-properties plumbing to `google-calendar.ts` + `outlook-calendar.ts` + `unified-calendar.ts`. Smaller path: just dual-mode `extractSecretaryAgendaMarker` to prefer private fields when present.

## Open questions / decisions deferred to user

- Whether to lift `TRAINING_CALENDAR_OUTLOOK_DISABLED` env var entirely from `training-operational-switches.ts` once the deploy has soaked for a week (the kill switch is useful, but only one direction now). Recommendation: keep it, low cost.
- Whether the same-sport-twice-per-day filter at `capacity-reconciliation.ts:194` should also be relaxed for users who genuinely want two same-sport workouts in one day (e.g., AM/PM run pair). Recommendation: leave as-is — mixed pairs already cover the user's 5+5 case after the hybrid + volume-enforcement fixes.

## Files not committed (working tree)

- `docs/release/CURRENT_RELEASE_STATE.md`, `docs/release/current-release-index.md`, and this handoff file are committed in the same docs-update commit on this session. Working tree clean after.

## Ledger updates

- No new feature flag rows; the bugs closed are runtime behavior fixes. `TRAINING_CALENDAR_OUTLOOK_DISABLED` is operational, not a feature flag.

## Definition of done — verification

- [x] `npm run typecheck` passed (both PRs)
- [x] `npm run verify` (vitest) passed: 10,544 (PR #137) / 10,555 (PR #138)
- [x] `npm run docs:audit` run after docs updates (see commit log)
- [ ] iOS `xcodebuild build` — N/A (backend-only)
- [ ] iOS `xcodebuild test` — N/A (backend-only)
- [x] Feature Delivery Ledger — N/A (no new flag rows; runtime fixes only)
- [x] Evidence docs landed under `docs/release/smoke-evidence/`: `staging-smoke-d94c2d1a-20260525T101747Z.json` and `staging-smoke-0bae01cb-20260525T161058Z.json`
- [x] Staging deployed + 17/17 smoke pass for both promotes
- [x] Production promoted + `/health` confirms version `4.14.195`
