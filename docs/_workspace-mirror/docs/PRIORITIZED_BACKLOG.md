# Prioritized Backlog — Nexus Hub

Status: canonical
Last verified: 2026-05-10
Owner: workspace lead (Felipe)
Update policy: rebuild from open work-stream files when a new round closes or starts. This is a snapshot consolidating the active items across all task-execution md files in the project.

Source coverage: 12 PENDING task-execution files identified in `docs/done/INDEX.md` triage. ~45 actionable items extracted across these files.

Navigation:
- Done work-streams catalog: `docs/done/INDEX.md`
- Production state: `docs/release/CURRENT_RELEASE_STATE.md`
- Active dashboards: `docs/release/OPEN_ITEMS.md`, `docs/release/release-identity.md`

---

## P0 — Wave 1 launch blockers (must fix before TestFlight cut)

### Decision Center hostile QA findings (Round D)

Source: `docs/release/decision-center-orchestration-apns-qa.md` verdict NOT_READY (2026-05-10)

- [x] **P0** — APNs sandbox/production environment ignored at send time. Closed by Round E; see `docs/archive/2026-05/round-e-launch-blockers/closeout.md`.
- [x] **P0** — User switch keeps old user's push tokens active (tenant-leak class). Closed by Round E; see `docs/archive/2026-05/round-e-launch-blockers/closeout.md`.
- [x] **P0** — iOS action-failure destroys the in-progress list and pretends nothing failed. Closed by Round E; see `docs/archive/2026-05/round-e-launch-blockers/closeout.md`.
- [x] **P0** — Claimed accessibility identifiers do NOT exist on Home. Closed by Round E; see `docs/archive/2026-05/round-e-launch-blockers/closeout.md`.
- [x] **P0** — Decision Center state NOT scope-discarded on user switch. Closed by Round E; see `docs/archive/2026-05/round-e-launch-blockers/closeout.md`.

### Existing iOS Wave 1 launch blockers (sixth-pass opus audit findings still open)

These were identified in the post-promote fifth-pass audit (`docs/archive/2026-05/p0-tenant-and-safety-and-perf-2026-05/post-promote-audit-fifth-pass.md`) and have NOT yet been worked on.

- [x] **P0 (App Store)** — iOS Sign in with Apple revocation listener missing. Closed by Round E; see `docs/archive/2026-05/round-e-launch-blockers/closeout.md`.
- [x] **P0 (GDPR)** — Account deletion missing tables. Closed by Round E; see `docs/archive/2026-05/round-e-launch-blockers/closeout.md`.
- [x] **P0 (GDPR)** — No third-party OAuth revocation on account deletion. Closed by Round E; see `docs/archive/2026-05/round-e-launch-blockers/closeout.md`.
- [x] **P0 (LLM injection)** — Indirect prompt injection via stored task/event/memory titles. Closed by Round E; see `docs/archive/2026-05/round-e-launch-blockers/closeout.md`.
- [x] **P0 (lifecycle)** — iOS half-cleared keychain on mid-sign-out termination. Closed by Round E; see `docs/archive/2026-05/round-e-launch-blockers/closeout.md`.
- [x] **P0 (tenant)** — iOS BackgroundSyncManager has no user-bound identity check. Closed by Round E; see `docs/archive/2026-05/round-e-launch-blockers/closeout.md`.

### Infrastructure / CI gates

- [x] **P0 (CI gate bypass)** — Release classifier didn't recognize Decision Center files. Closed by Round E; see `docs/archive/2026-05/round-e-launch-blockers/closeout.md`.

---

## P1 — Wave 1 high priority (should fix before Wave 1 invites)

### Decision Center Round D follow-on

Source: same hostile QA report

- [x] **P1** — Concurrent two-tap idempotency TOCTOU race. Closed by Round E; see `docs/archive/2026-05/round-e-launch-blockers/closeout.md`.
- [x] **P1** — Default idempotency key conflates distinct payloads. Closed by Round E; see `docs/archive/2026-05/round-e-launch-blockers/closeout.md`.
- [x] **P1** — Fixtures route open to any authenticated user in non-production. Closed by Round E; see `docs/archive/2026-05/round-e-launch-blockers/closeout.md`.
- [x] **P1** — Migration 119 not idempotent on replay. Closed by Round E; see `docs/archive/2026-05/round-e-launch-blockers/closeout.md`.
- [x] **P1** — `verifiedStatusEffect` trusts writer's return value, not fresh DB SELECT. Closed by Round E; see `docs/archive/2026-05/round-e-launch-blockers/closeout.md`.
- [x] **P1** — APNs `apns-collapse-id` never set on decision pushes. Closed by Round E; see `docs/archive/2026-05/round-e-launch-blockers/closeout.md`.
- [x] **P1** — APNs badge count never set. Closed by Round E; see `docs/archive/2026-05/round-e-launch-blockers/closeout.md`.
- [x] **P1** — Foreground APNs duplicates the in-app card. Closed by Round E; see `docs/archive/2026-05/round-e-launch-blockers/closeout.md`.

### Decision Center missing test coverage (closeout claimed but absent)

- [x] **P1** — Two-user same-tenant isolation test. Closed by Round E.
- [x] **P1** — Two-tenant same-userId boundary test. Closed by Round E.
- [x] **P1** — Concurrent duplicate-action TOCTOU test. Closed by Round E.
- [x] **P1** — Expired/superseded/dismissed/already-actioned action denial tests. Closed by Round E.
- [x] **P1** — Read-back mismatch test. Closed by Round E.
- [x] **P1** — APNs payload privacy test. Closed by Round E.
- [x] **P1** — Wrong-user notification action denial test. Closed by Round E.
- [x] **P1** — Device-token registration with body-injected userId/tenantId test. Closed by Round E.

### Round C (P0/P1 follow-ups not yet started)

Source: `docs/release/decision-center-orchestration-apns-qa.md` Round C prompt + sixth-pass opus audit findings

- [x] **P1** — iOS deep-link router scope-key awareness extension to action queueing path. Closed by Round E via pending notification action scope validation.
- [ ] **P1** — iOS keychain user-scoped tokens (migrate global → user-scoped keys; first-launch migration).
- [ ] **P1** — iOS APNs revoke device-to-user binding on sign-out (engine route + iOS call).
- [x] **P1** — Audit trail retention policy decision. Closed by Round E; retain-with-pseudonymize/retain for legal proof documented.
- [ ] **P1** — Push notification routed during sign-out gap. Gate `userNotificationCenter(_:didReceive:)` body on `currentUser?.id == notificationUserId`.
- [x] **P1** — Onboarding step UserDefaults user-scoped (mid-signOut-termination edge case). Closed by Round E.
- [x] **P1** — Push token deletion chain on iOS account-deletion path. Closed by Round E.

### OPEN_ITEMS.md carry-overs

Source: `docs/release/OPEN_ITEMS.md`

- [ ] **P1 (HOSTILE-CONT-F1)** — OAuth/owned-channel writer required before live creator analytics enabled (owner decision)
- [ ] **P1 (GAP-TRN-1)** — Training plan-linter blockers remain advisor-only (owner decision: promote to strict)
- [ ] **P1 (GAP-CONT-3)** — Performance-feedback adaptation loop is silent dead-end (`engine/src/services/content-performance-aggregate.ts` reads wrong table)
- [ ] **P1 (GAP-CONT-4)** — Performance dashboard remains OPEN: ContentIntelligenceView lacks views/retention/likes/comments
- [ ] **P1 (GAP-CAL-1-C)** — Broader Telegram-only cron migration intentionally unbatched
- [ ] **P1 (GAP-FIN-2)** — Non-BR tax jurisdiction model (owner decision)
- [ ] **P1 (GAP-REL-1)** — Workspace `release-identity.md` is stale (4.14.132 vs 4.14.148 prod). Auto-regenerator needed.
- [ ] **P1 (GAP-REL-2)** — Engine `docs/release/CURRENT_RELEASE_STATE.md` frozen at 4.14.127 (8 releases unsynced)
- [ ] **P1 (GAP-REL-6)** — Mock-lint trajectory off-target: ~70 months at 10/month vs `<100 by 2026-08-01` (owner decision)
- [ ] **P1 (GAP-REL-7)** — Two-account E5 release gate hardening (owner decision)

### Operator-physical / pre-TestFlight

These items are operator-only and gate Wave 1 invites going out.

- [ ] **P1 (operator-physical)** — Sign and cut TestFlight build (Xcode → Archive → Upload to App Store Connect)
- [ ] **P1 (operator-physical)** — Wave 1 ToS document
- [ ] **P1 (operator-physical)** — Closed-beta application form (Typeform / Google Forms)
- [ ] **P1 (operator-physical)** — Wave 1 invite list management
- [ ] **P1 (operator-physical)** — Real-device walkthrough on iPhone + Jaqueline's iPhone
- [ ] **P1 (operator-physical)** — APNs token + delivery validation on real devices
- [ ] **P1 (operator-physical)** — Two-account switch test on real hardware (the P0 regression test on actual iPhones)
- [ ] **P1 (operator-physical)** — Real Gmail/Outlook/Apple Health provider validation
- [ ] **P1 (operator-physical)** — Interrupted onboarding flow on real device
- [ ] **P1 (operator-physical)** — Garmin MFA + live session test (if a real Garmin account is ready)

---

## P2 — Wave 1 recommended / Wave 2 prep

### Decision Center Round D P2 items

Source: same hostile QA report

- [ ] **P2** — Decision Center policy false-positives reminders with action chips into decisions. File: `engine/src/services/decision-center.ts:192, 205`. Tighten `requiresUserAction` to require explicit flag.
- [ ] **P2** — Re-action of `actioned` decision asymmetry vs orchestrator (Decision Center 409s; orchestrator returns idempotent). Align contracts.
- [ ] **P2** — Portal admin returns raw `item.title` instead of safe-title helper. File: `engine/src/portal/document-routes.ts:86`.
- [ ] **P2** — Stale `notification_device_tokens` rows not revoked on rebind (defense-in-depth on top of P0 fix).
- [ ] **P2** — Decision actions reachable via two endpoints (`/decisions/:id/actions` and `/notifications/:id/actions`). Second bypasses idempotency + read-back. Delete or forward to canonical.
- [ ] **P2** — `markViewed` only fires on notification tap, not when Home opens Decision Center. Add `.task { markViewed }` on Decision Center appear.
- [ ] **P2** — `consumePendingNotificationAction` does NOT validate `pendingUserScope == currentUserScope()`. File: `Nexus Hub IOS/.../DeepLinkRouter.swift:107-112`.
- [ ] **P2** — Scope-mismatch guard in Decision Center does not clear `items`. File: `Nexus Hub IOS/.../NotificationDecisionCenterView.swift:191-196`.

### Sixth-pass opus audit P2 items

- [ ] **P2 (UX leak)** — Badge count leaks across user switches on shared device. iOS calls `setBadgeCount` on sign-in to overwrite stale count.
- [ ] **P2 (perf)** — api_cache safety valve on cleanup tail (Round C: add LIMIT 10000 fallback).
- [ ] **P2 (data correctness)** — Partial Apple Health sufficiency parametric tests (6 cases: hrvOnly, sleepOnly, rhrOnly, hrvSleep, hrvRhr, sleepRhr).
- [ ] **P2 (provider audit)** — Amazon/Uber collector tenant-safety scoped round (per `docs/archive/2026-05/launch-readiness-sweep/provider-filesystem-session-audit.md`). Manual `/amazon` and `/uber` Telegram commands invoke global Playwright sessions.

### Active iOS specs trackers (need verification + retirement)

These are iOS spec trackers with mixed open/closed states. After verifying against current production at v4.14.148, candidates for retirement to `docs/done/`:

- [ ] **P2** — `Nexus Hub IOS/specs/15-SKILL-INTELLIGENCE-IMPLEMENTATION-TRACKER.md` — all 16 items show "Done"; reclassify to reference or retire
- [ ] **P2** — `Nexus Hub IOS/specs/16-FULL-STACK-QA-VALIDATION-TRACKER.md` — final report draft pending; remaining risks (long-scroll a11y, manual token acquisition)
- [ ] **P2** — `Nexus Hub IOS/specs/25-TENANT-READINESS-TRACKER.md` — 4+ "in progress" rows; verify against v4.14.148
- [ ] **P2** — `Nexus Hub IOS/specs/22-TRAINING-EXPERT-AUDIT.md`, `17-ARCHITECTURE-ENGINE-AUDIT-TRACKER.md`, `19-CROSS-SKILL-COLLABORATION-AUDIT.md`, `20-BACKEND-CONTRACT-AUDIT.md`, `21-IOS-PRODUCT-FLOW-AUDIT.md`, `23-STATE-SYNC-AUDIT.md`, `24-RESILIENCE-AUDIT.md` — 2026-04 audit trackers, retire if findings closed post-4.14.148
- [ ] **P2** — `Nexus Hub IOS/specs/06-IMPLEMENTATION-PLAN.md` — items 1-5 plausibly closed; items 6-7 (Training typed coach-state, file size reductions) likely still in flight
- [ ] **P2** — `Nexus Hub IOS/specs/09-APNS-SETUP.md` — sync with OPEN_ITEMS line 790 closure
- [ ] **P2** — `Nexus Hub IOS/specs/12-MARKETING-TRUTH-BACKLOG.md` — multiple "still incomplete/Partial/Hybrid" rows
- [ ] **P2** — `Nexus Hub IOS/specs/12-TASK-ENHANCEMENTS.md` — Tiimo-inspired task feature backlog; verify P0 "Create Lists" current state

### Active engine specs

- [ ] **P2** — `engine/docs/training/training-engine-orchestration-overhaul-spec.md` — DRAFT, Phase 0 audit in progress
- [ ] **P2** — `engine/docs/content/content-upgrade-execution-plan.md` — multiple "Status: In progress" sections
- [ ] **P2** — `engine/docs/chat/chat-upgrade-execution-plan.md` — partial attachment/tool-call/skill-invocation/vector/streaming/background-job tables; portal metadata-only diagnostics partial

### Sentry / observability

- [ ] **P2** — Sentry `beforeSend` PII redaction (Round C item) — currently only IP stripped; expand to headers, request body, contexts, extra
- [ ] **P2** — Felipe-volume 100-calendar-event seeding mode for staging fixture harness (so wall-time deltas are repeatable)

---

## P3 — Wave 2 backlog (defer)

### Decision Center P3

- [ ] **P3** — `INTERNAL_API_SECRET` no minimum-length validation in config
- [ ] **P3** — `ios_devices.push_token` no UNIQUE constraint
- [ ] **P3** — `Date.now()` in `urgencyForPriority` makes tests nondeterministic; inject clock
- [ ] **P3** — Snooze can outlive expiry (clamp to expiresAt)
- [ ] **P3** — Decision history pagination silent truncation at 200
- [ ] **P3** — Backend hardcodes English action labels (PT/EN parity)
- [ ] **P3** — No analytics emission for `decision_action_executions`
- [ ] **P3** — Dead `'viewed'` notification status introduced but never written

### Sixth-pass P3

- [ ] **P3** — APNs payload `data` field carries `sourceSkill`/`type` in cleartext (encrypted in transit but NSE could log)
- [ ] **P3** — Per-user notification rate limiting absent (per-source only)
- [ ] **P3** — Backup retention documentation for GDPR (ICO guidance)
- [ ] **P3** — UserDefaults `isExcludedFromBackup` for iCloud (subscription snapshots in iCloud backup)
- [ ] **P3** — Account deletion data-export streaming (OOM risk for heavy users)

### Operator follow-ups (carryover)

- [ ] **P3** — Self-hosted GitHub Actions runner (only if SSH-only promote workflows require)
- [ ] **P3** — Non-prod Google/Outlook OAuth credentials provisioning
- [ ] **P3** — iOS fastlane setup (only if Felipe wants frequent automated cuts)
- [ ] **P3** — Content portal smoke window

---

## Recently closed

### Round E launch blockers — source and staging complete

Closeout: `docs/archive/2026-05/round-e-launch-blockers/closeout.md`

- [x] F-A Python content-engine `tenantId` source audit clean for Wave 1; downgraded to Wave 2 prep.
- [x] Decision Center Round D P0: APNs environment, token rebind revocation, iOS action failure, Home a11y IDs, and scope-discard fixed.
- [x] Decision Center Round D P1: idempotency transaction/keys, fixtures hardening, migration replay, DB read-back, classifier gate, APNs collapse/badge, and foreground duplicate suppression fixed.
- [x] Decision Center missing coverage M-1 through M-8 added.
- [x] App Store/GDPR/LLM P0/P1: Apple credential revocation, account deletion table coverage, OAuth revocation, audit retention policy, prompt sanitizer, destructive memory write reclassification, sign-out atomicity, background sync binding, push-token delete chain, and deep-link action scope validation fixed.
- [x] Sentry/cache/onboarding carryovers: Sentry redaction pinned, api_cache safety valve covered, onboarding progress scoped by user, and strict mock lint restored below baseline.

---

## Track summary

| Track | P0 | P1 | P2 | P3 | Total |
|---|---:|---:|---:|---:|---:|
| Backend / engine | 8 | 14 | 8 | 5 | 35 |
| iOS | 6 | 7 | 9 | 3 | 25 |
| Operator-physical | 0 | 10 | 0 | 4 | 14 |
| Documentation / specs | 0 | 0 | 11 | 0 | 11 |
| **Totals** | **14** | **31** | **28** | **12** | **85** |

(Counts include both Decision Center Round D items and pre-existing audit findings; some items span tracks.)

## Recommended sequencing

1. **Round D — Decision Center fixes** (5 P0 + 8 P1 + 8 missing tests): blocks TestFlight cut. Prompt already drafted in chat history.
2. **Round C — Apple revocation + GDPR + LLM injection** (5 P0 + 7 P1): blocks TestFlight cut via App Store policy. Prompt already drafted in chat history.
3. **F-A verification** — Python content-engine `tenantId` source (30-min audit; if clean, downgrade; if spoofable, P0 fix).
4. **Operator-physical Wave 1** — TestFlight cut + walkthroughs + invites.
5. **Wave 2 prep** — P2 items (after 2-4 weeks of Wave 1 cohort feedback).
6. **Wave 2 backlog** — P3 items.

Round C and Round D can run in parallel (different surfaces); both must close before TestFlight cut.

## How to use this backlog

- Items are checkboxes; tick them when corresponding closeout lands and Claude hostile QA confirms.
- Each closed item moves to the catalog at `docs/done/INDEX.md` with its closeout link.
- Re-run the triage in `docs/done/INDEX.md` cross-reference section before any mass move; this backlog stays here as the source of truth for active work.
