# Single-Agent Beta Status

Date: 2026-04-25

Active branch: `beta/single-agent-rc`

Active worktree: `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/beta-codex-single-agent`

## Tracker

| Gap | Status | Evidence | Remaining Work | Tests Needed | Notes |
|---|---|---|---|---|---|
| Gap 1: Live TestFlight smoke | Complete with manual verification required | iOS worktree has smoke matrix, manual checklist, local smoke script, focused smoke tests, 2026-04-25 simulator smoke with Felipe's persisted account, backend production live at `4.14.73`, and staging live at `4.14.72`. | Signed TestFlight/device smoke, APNs proof, fresh auth, true two-account switching, and latest Content/Training TestFlight bugfix proof. | Physical-device/TestFlight checklist. | Backend is ready for the smoke gate; iOS distribution proof remains. |
| Gap 2: Tenant/data isolation | Complete with manual verification required | `docs/beta/security-foundation-handoff.md`; targeted isolation/admin/auth/integration suite passed 41 files / 439 tests; latest full deploy verification passed 345 files / 5,456 tests; staging wrong-tenant/operator-scope smoke passed; founder users verified in staging and production. | True app-level two-account switching on device with safe seeded data. | Device account-switching smoke for fiscal/vendor, finance, integrations, health/wearable, plan, and skill data. | Backend isolation proof is complete. |
| Gap 3: Auth + onboarding reliability | Partial | `docs/beta/agent-3-auth-onboarding-handoff.md`; backend auth/onboarding tests exist; full backend verify passed; iOS existing-session simulator restore succeeded. | Fresh Apple/Google/email auth and interrupted onboarding on signed iOS build/device. | Real-device auth/onboarding smoke. | Backend promotion completed; iOS live auth proof remains. |
| Gap 4: iOS degraded/error states | Complete with manual verification required | Implemented in the iOS single-agent worktree; simulator smoke showed honest missing calendar/email/Training setup states. | Physical-device visual pass for backend unavailable, retry success/failure, and account-switch loading. | iOS degraded-state smoke. | Out of scope for backend code, but backend returns canonical envelopes for iOS. |
| Gap 5: Portal/admin operator sessions | Complete | `docs/beta/security-foundation-handoff.md`; signed session/admin scope tests passed; hardened staging smoke passed valid, expired, tampered, unauthorized role/scope, wrong-tenant, and static-token rejection paths. | Optional production env flip to require signed sessions only if desired. | Optional production hardening smoke after final env flip. | Production code is live at `4.14.73`. |
| Gap 6: Gmail/Outlook/Health integration truth | Partial | `docs/beta/agent-6-integration-truth-handoff.md`; backend canonical provider-state tests passed; iOS simulator showed one-provider connected truth with Garmin only. | Real/provider-backed Gmail-only, Outlook-only, Health-only, revoked, and degraded checks. | Device/provider-state smoke. | Backend contract is in place; live provider proof remains. |
| Gap 7: Observability/on-call loop | Complete | Durable alert lifecycle, delivery states, portal ack/resolve/retry, beta-critical telemetry, `docs/OBSERVABILITY-ONCALL.md`, focused tests, full verify, and staging external webhook drill passed. | Configure/drill final production alert receiver if different from staging. | Optional production receiver drill. | Handoff: `docs/beta/observability-oncall-handoff.md`. |
| Gap 8: Release/runbook discipline | Complete with manual verification required | iOS release checklist/config/rollback docs exist; backend deploy scripts were fixed for worktree `.git` and local agent/worktree artifacts; production promoted to `4.14.73`; production health checks passed for content engine, status portal, and bot online. | Signed TestFlight/device gate before broad public beta. | TestFlight/APNs/physical-device release rehearsal. | Backend production is live; iOS distribution proof remains. |
| Gap 9: Frontend architecture debt | Partial | Implemented in the iOS single-agent worktree with safe SwiftUI extractions and passing focused tests/build. | Continue incremental extractions only when backed by focused tests/previews. | iOS focused tests/build. | Out of scope for backend code. |
| Gap 10: Product polish consistency | Complete with manual verification required | Implemented in the iOS single-agent worktree with skill card, chat shortcut, retry copy, accessibility, and spacing polish. | Visual simulator/TestFlight pass for skill cards, chat shortcuts, degraded states, and empty/error copy. | Visual smoke/accessibility pass. | Out of scope for backend code. |

## Production / Staging Update - 2026-04-25

- Backend production is live at `4.14.73`; staging remains live at `4.14.72`.
- Production deploy health passed for content engine, status portal, and bot
  online at deploy commit `61f9d1c`; code commit `1300b20` is the follow-up
  content script prompt-architecture release.
- `content-engine` and `nexus-hub` were online after promotion/recovery.
- Founder accounts verified in production:
  `felipedrf74@gmail.com` and `vieira.jaqueline@gmail.com`.
- Hardened staging operator-session smoke passed.
- External webhook/on-call staging drill passed alert creation, delivery,
  acknowledgement, resolution, and audit verification.
- Deploy scripts exclude worktree `.git` files and local agent/worktree
  artifacts so branch worktrees can deploy safely.
- Priority 7 production recheck passed focus recommendation day selection:
  `/api/v1/calendar/focus-recommendation` returned HTTP `200` and recommended
  today for Felipe's production account.
- Priority 7 production recheck found Google Calendar truly degraded:
  production connections report Google `degraded`, dashboard emits
  `GOOGLE_CALENDAR_UNAVAILABLE`, and Google refresh fails with
  `unauthorized_client` / `invalid_grant`. Rerun Google dashboard/write smoke
  after reconnecting Google from TestFlight.
- Outlook token-zero calendar write smoke passed create/update/delete
  `200/200/200` and auto-deleted the temporary event.
- Priority 8 Home-to-Inbox latency pass was verified live in production
  `4.14.66` and remains part of `4.14.68`.
  Pre-fix production `4.14.64` measured cached inbox at ~3ms and a cold cache
  key at ~10.3s. The first fix bounded unified inbox sources with soft
  deadlines; the final fix moved task reads to the normalized local task store
  so Inbox no longer waits on Microsoft Graph for task data. Post-deploy
  production measurement: unread count ~1.286s, cold inbox `limit=33` ~2.455s,
  immediate repeat ~2ms, with only real Google/Gmail OAuth warning codes
  remaining. Focused notifications route tests, typecheck, staging smoke, and
  full `npm test` passed 342 files / 5,438 tests.
- Priority 9 task-list count truth was verified in production `4.14.66` and
  remains part of `4.14.68`.
  `/api/v1/tasks/lists` returned HTTP `200` for Felipe's production account in
  ~21ms with 10 task lists and real `taskCount` values; no `-1` placeholders
  were present. Focused task route/store regression tests passed 3 files / 62
  tests.
- 2026-04-25 Content + Training TestFlight bugfix pass is deployed in backend
  `4.14.68`, pushed in iOS `main`, and focused-test validated: content script
  style/Voice DNA/cache-key contract,
  Python proxy JSON mode for synthesis, Python degraded fallback distinction,
  iOS topic-write cache invalidation, Training athlete-profile finish action,
  and Training complete/skip fallback to backend `"today"`. Still needs a fresh
  signed TestFlight/device pass before closing user-facing QA.
- Follow-up Content scheduling/pipeline + Training readiness pass is deployed
  in backend `4.14.68`, pushed in iOS `main`, and focused-test validated:
  topic `scheduledDateTime`, date-only
  Secretary task sync, date+time calendar agenda sync, Content Tasks scheduled
  topic visibility, Pipeline cancellation handling, and Training renderable-data
  readiness during refresh. iOS Home secondary previews now fan out in parallel
  after the primary dashboard render. Migration
  `078_content_topic_secretary_artifacts.sql` is deployed with `4.14.68`; still
  needs a fresh signed TestFlight/device pass before closing user-facing QA.
- Second Training TestFlight bugfix pass is deployed in backend `4.14.68`,
  pushed in iOS `main` at `7f722da`, and focused-test validated: setup loop
  prevention, optional/skipped profile completion, readable coach adjustments,
  recovery-run detail access, post-plan calendar refresh, deterministic coach
  fallback, and workout-adjustment refresh. Full deploy gate passed 345 files /
  5,456 tests; staging signed-session smoke passed 17/17. Still needs a fresh
  signed TestFlight/device pass before closing user-facing QA.
- Content script AI delivery fixes are deployed through backend `4.14.73` and
  focused/full-test validated. `4.14.71` fixed the TS AI bridge/json-mode
  degradation path. `4.14.73` carries the deeper script-quality architecture:
  Python script generation now builds the system prompt per request from the
  authenticated user's scoped creator profile/Voice DNA, removes the global
  founder/operator persona, replaces literal hook/setup/body/CTA templates with
  outcome-based guidance, sets an explicit script temperature, returns
  topic-aware degraded drafts without founder hashtags or generic
  speed-vs-judgment hooks, and supports `forceRefresh`/`regenerate` with a
  regeneration seed. The script generation cache key is now `script-v7`; full
  backend verification passed 345 files / 5,459 tests. Production script smoke
  should return `degraded=false` unless a real provider outage is occurring.
- Training coach engine hardening is implemented on backend `main` and
  full-test validated, pending the next staging/prod deploy. It removes
  founder-specific Felipe/carnivore/high-volume defaults from Training prompts,
  makes daily coach briefing generation per active canonical tenant instead of
  owner-only, fixes ACWR to use actual training-load values with a 14-day
  sample guard, makes no-wearable readiness conservative instead of
  `full_intensity`, combines sleep quality with duration as a safety floor, and
  downshifts orange/red/injury states deterministically. Handoff:
  `docs/beta/training-coach-engine-hardening-handoff.md`. Full backend
  verification passed 345 files / 5,468 tests.

## Single-Agent Rules

- Use branch `beta/single-agent-rc`.
- Do not merge into `beta/rc`.
- Commit after each phase.
- Update this status file after each phase.
- Prefer reusing safe previous work, but never blindly merge stale branches.
- If credentials or staging access are missing, document exact commands and env vars.
