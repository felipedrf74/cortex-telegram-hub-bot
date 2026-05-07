# Open Items

Status: canonical
Owner: release lead (Felipe)
Last verified: 2026-05-07
Update policy: update when a current carryover opens or closes. Monthly
historical detail for the 2026-05 tech-debt sweep lives in
`docs/release/OPEN_ITEMS_ARCHIVE_2026-05.md`.

Last sweep complete: 2026-05-07.
Closeout dossier:
`engine/docs/archive/2026-05/tech-debt-validation/sweep-closeout-dossier.md`.

Latest closed-beta gap analysis: 2026-05-07 (mid-day Europe/Lisbon).
Report: `docs/archive/2026-05/closed-beta-gap-analysis/all-skills-gap-analysis-report.md`
Verdict: NOT_READY → READY_WITH_CONDITIONS once the P0 cluster closes.

Secretary Notification Orchestrator source branch: 2026-05-07.
Report:
`docs/archive/2026-05/secretary-notification-orchestrator/secretary-notification-orchestrator-report.md`.
Verdict: READY_WITH_CONDITIONS on local/mock validation. Production APNs
credentials, signed-device push/action validation, and deploy remain
operator-only; no push or deploy was performed.

## 2026-05-07 Closed-Beta Gap Analysis — New P0/P1 Items

These items came from the all-skills gap analysis run on 2026-05-07 by Claude Code
on Opus 4.7 with 8 specialist Opus subagents. Detailed evidence (file:line, expected vs
actual, recommended fix-prompts) is in the archive report linked above.

### P0 — closed-beta blockers

| ID | Area | Description |
|---|---|---|
| GAP-CONT-1 | content runtime | Performance + SEO agents read a single global `YOUTUBE_CHANNEL_ID` (`engine/src/agents/performance-agent.ts:39-40,211-212`; `seo-agent.ts:236`). All users see Felipe's channel. — OPEN |
| GAP-COOK-1 | cooking | `applyMealPlanSubstitution`, `addRecipe`, `setMealPlan` accept allergens; `assessCookingMealPlan` is read-only/advisory (`engine/src/services/cooking-chef.ts:170-545`). Life-safety. — OPEN |
| GAP-REL-3 | iOS CI | `ios/.github/workflows/ios-release-hardening.yml` runs zero `xcodebuild test`. — OPEN |
| GAP-REL-4 | backend health | `/health` does not actually probe the DB; reads cached runtime state (`engine/src/portal/health-routes.ts:60-79`). — OPEN |
| GAP-REL-5 | release pipeline | Notification orchestrator security gate is empty: classifier glob `__tests__/security/notification-*.test.ts` expands to nothing; cannot-skip dashboard does not include orchestrator file. — CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator` via `__tests__/security/notification-orchestrator-security.test.ts`, changed-area classifier mapping, and cannot-skip dashboard representative. |
| GAP-IOS-2 | iOS APNs | `ReportService.swift:111` hardcodes `environment: "sandbox"` for ALL builds → TestFlight/prod tokens mis-tagged → APNs delivery fails. — CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator`; debug builds register `sandbox`, release/TestFlight builds register `production`. |
| GAP-IOS-1 | iOS WIP | `SettingsView.swift:83-89` switch non-exhaustive after `SettingsDestination.notificationCenter` was added. — CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator`; settings navigation handles `.notificationCenter`. |
| GAP-IOS-3 | iOS WIP | `nexus://notifications/<id>` deep-link dead-ends (no view consumes `.notificationCenter`). — CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator`; `DeepLinkRouter` and Settings navigation consume notification-center routes. |
| GAP-IOS-4 | iOS WIP | `AppDelegate.swift didReceive response` ignores `actionIdentifier` (mark_done/snooze/approve_script/reject_reflow are no-ops). — CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator`; custom notification actions are queued and consumed by Decision Center action handling. |

### P1 — high priority before beta-launch

| ID | Area | Description |
|---|---|---|
| GAP-SEC-AUTH-1 | auth/state | Legacy 2-arg `saveIdea(title, sourceDate)` writes `user_id=0`; `markIdeaPromoted/Used/deleteIdea` mutate by id only with no scope (`engine/src/state/saved-ideas.ts:33-67`). — OPEN |
| GAP-CHAT-1 | chat | Telegram chat-tool path may not establish `runWithChatToolAuthorization` ALS context. P0 if Telegram is in active prod use; P3 if iOS-only. **Verify deployment.** — OPEN |
| GAP-TRN-1 | training | Plan-linter blockers remain advisor-only (logs but persists). Promote `equipment_compatibility`, `no_heavy_lower_before_long_run`, `race_specific_plan_requires_race_date` to strict gates. — OPEN (known) |
| GAP-CONT-2 | content tests | Neutrality test covers 3 of 6 runtime agents (`engine/__tests__/security/content-agent-neutrality.test.ts:7-15`). — OPEN |
| GAP-CONT-3 | content loop | Performance feedback collected but no code consumes it for adaptation — silent dead-end loop. — OPEN |
| GAP-CONT-4 | iOS content | iOS lacks Performance + Calendar/Scheduler views entirely (`ios/Nexus Hub/Views/Content/`). — OPEN |
| GAP-SEC-NOTIF-1 | notif orch | Quiet-hours-delayed and digest items persisted with `scheduled_for` but no scheduler/release loop consumes them. — CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator`; scheduler now runs the orchestrator release loop. |
| GAP-SEC-NOTIF-2 | notif orch | `POST /api/v1/notifications/intents` accepts arbitrary `priority`/`sourceSkill`/`type` from client body; iOS could fabricate `security/critical`. — CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator`; arbitrary intent creation now requires internal secret authorization and fixture route remains deterministic. |
| GAP-SEC-NOTIF-3 | notif orch | `migrations/113_*.sql` schema diverges from runtime `ensureNotificationTables()`; `ios_devices` only at runtime. — CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator`; migration/runtime table setup now cover orchestrator tables and existing APNs compatibility storage is preserved. |
| GAP-SEC-NOTIF-4 | notif orch | `isInQuietHours` uses server-local time, not `profile.timezone`. — CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator`; quiet-hours policy now evaluates in the profile timezone. |
| GAP-CAL-1 | secretary | Conflict-detection cron sends Telegram only, no orchestrator intent emitted (`engine/src/services/scheduler.ts:1083-1095`). — OPEN |
| GAP-FIN-1 | finance privacy | Pino logs leak transaction `category, amount` despite encryption-at-rest (`engine/src/services/finance-tracker.ts:552`; `engine/src/api/routes/finance.ts:116`). — OPEN |
| GAP-FIN-2 | finance | Hard-coded Brazilian tax (IRPF Carnê-Leão / INSS rates) — single-tenant by jurisdiction. — OPEN |
| GAP-PORT-3 | portal | New `/api/notifications` and `/api/notification-preferences` lack tenant filter at route boundary (`engine/src/portal/document-routes.ts:13-50,52-64`). — CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator`; portal routes validate scoped user/tenant headers/query and reject cross-tenant scope. |
| GAP-REL-1 | docs/identity | Workspace `docs/release/release-identity.md` stale at 4.14.132 (prod is 4.14.134). — OPEN |
| GAP-REL-2 | docs/release | Engine `docs/release/CURRENT_RELEASE_STATE.md` frozen at 4.14.127 — 7 production releases unsynced. — OPEN |
| GAP-REL-6 | mock-lint | Trajectory off-target: ~70 months at 10/month vs `<100 by 2026-08-01`. Need ~242/month or commitment downgrade. — OPEN |
| GAP-REL-7 | release gate | Two-account E5 self-policed; no CI gate prevents promote-to-prod without TestFlight evidence. — OPEN |
| GAP-IOS-5 | iOS cache | `ResponseCache.shared.clear()` never called on signOut/scope-change in `AppState.swift:504/617`. Cross-account leak risk. — OPEN |

P2/P3 items (~30 more) live only in the archive report; surface to OPEN_ITEMS only when promoted by a fix prompt or new evidence.



## Standing Authorizations

- `BATCH-24-CLOSEOUT-AUTHORIZED`: honored by Batch 24 U1/U2/U5.
- `BATCH-24-CLAUDE-MD-PRODUCTION-TRUTH-UPDATE-AUTHORIZED`: honored as staged
  text only at `docs/release/staged-claude-md-update-after-2026-05-deploy.md`;
  `CLAUDE.md` was not modified.
- `BATCH-24-OPEN-ITEMS-ROTATION-AUTHORIZED`: honored manually because
  `engine/scripts/rotate-open-items.mjs` was absent in the Batch 24 checkout.

## Operator-Only Carryovers

These require Felipe/operator action and are not Codex-closable without live
credentials, devices, or deployment authority.

- Push local `main` to `origin/main` after Felipe's merge review.
- Deploy staging and run staging smoke.
- Promote production and run production health.
- Signed TestFlight and two-account walkthrough.
- APNs validation.
- Secretary Notification Orchestrator APNs live-provider setup and physical-device
  push/action validation.
- Real Gmail/Outlook/Health provider-state checks.
- Non-prod Google/Outlook OAuth credentials provisioning.
- Garmin MFA/live-session validation, which remains the closure path for P2-35.
- Content portal smoke window.
- iOS fastlane setup, if Felipe chooses to pursue it.
- Self-hosted runner provisioning, only if SSH-only promote workflows require it.

## Authorization-Gated Codex Workstreams

These are Codex-addressable but remain deferred until Felipe explicitly
authorizes the next batch.

| Queue | Status | Notes |
|---|---|---|
| Batch 25 | pending authorization | Content lifecycle unification phase 1: audit and plan. |
| Batch 26 | pending authorization | Content lifecycle schema migration phase. |
| Batch 27 | pending authorization | Content lifecycle service/API migration phase. |
| Batch 28 | pending authorization | Content lifecycle iOS/Python contract and cleanup phase. |

## Evidence Gaps

- Batch 17 iOS P2 remediation report was not reconstructable in the Batch 24
  archive pass. Revalidation exists at
  `docs/archive/2026-05/tech-debt-validation/codex-batch-17-revalidation.md`.
- Batch 1 does not have a standalone remediation artifact; evidence is
  preserved in
  `docs/archive/2026-05/tech-debt-validation/codex-tech-debt-pass.md` and
  `docs/archive/2026-05/tech-debt-validation/codex-validation-matrix.md`.
