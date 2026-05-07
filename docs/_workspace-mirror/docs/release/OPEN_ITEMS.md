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
Verdict: READY_WITH_CONDITIONS on the source branch after the P0 cluster
closures below and the 2026-05-07 hostile-validation remediation. Operator-only
device/APNs/deploy validation remains before broad beta.

**2026-05-07 late-day hostile QA on `5bbe1b40` + `a4b4be8`** — `docs/archive/2026-05/secretary-notification-orchestrator/remaining-open-tasks-hostile-qa.md`. Verdict: **NOT_READY**. Multiple "CLOSED IN SOURCE BRANCH" claims are downgraded:

- **GAP-CONT-3 → FALSE-CLAIM**: `content-performance-aggregate.ts` reads `content_radar_feedback`, not `content_performance`. Performance-feedback adaptation loop is still a silent dead-end. **REOPEN**.
- **GAP-CONT-4 → PARTIAL**: TopicSchedulerView is a real publishing calendar ✓; ContentIntelligenceView is NOT a performance dashboard (renders `optimization.recentSignals` and `activeInsightCount` only — zero views/retention/likes/comments). **Performance half REOPEN**.
- **GAP-CONT-1 → PARTIAL / OPEN WRITER GAP**: Global env leak closed ✓ and resolver fails closed, but `youtube-channel-scope.ts` still needs an explicit OAuth/owned-channel writer before Performance/SEO can use live creator analytics. Do not mark production analytics adaptation closed until that writer exists.
- **GAP-CONT-2 → CLOSED IN SOURCE BRANCH**: Neutrality scanner now covers `src/agents/**`, `src/services/**`, and Python `content-engine/services/intelligence|creative/**/*.py`; YouTube global-channel detection now uses a bypass-resistant pattern. Closed by engine commit `16b23cc9`.
- **GAP-SEC-AUTH-1 → CLOSED IN SOURCE BRANCH**: `runContentDiscovery` now requires a named positive `userId`/`tenantId`, removes the `userId ?? 0 as any` escape, and manual report dispatch passes named values. Closed by engine commit `16b23cc9`.
- **GAP-CHAT-1 → CLOSED IN SOURCE BRANCH**: Telegram command/callback/media handlers now inherit one central bot-level `runWithChatToolAuthorization` context, and the legacy helper rejects `0/-1/NaN/Infinity/unsafe` ids via `isValidTenantUserId`. Closed by engine commit `16b23cc9`.
- **GAP-CAL-1 → PARTIAL**: conflict-detection NotificationIntent emission now has per-user try/catch containment and dedupe keys include a conflict signature. The other Telegram-only crons remain a separate migration workstream. Partial closure by engine commit `16b23cc9`.
- **GAP-FIN-1 → CLOSED FOR HOSTILE CITATIONS**: receipt OCR no longer logs merchant/amount, tax calculation no longer logs `taxDue`, invoice collector no longer logs vendor names, and logger redaction includes finance PII/amount paths. Closed by engine commit `16b23cc9`.
- **GAP-REL-3 → CLOSED IN SOURCE BRANCH**: iOS release-hardening workflow now lists simulator runtimes, verifies an iPhone 16 Pro destination for GitHub runners, runs `xcodebuild test`, and asserts a non-zero xcresult test summary. Closed by iOS commit `f43fc5b`.
- **GAP-IOS-5 → CLOSED IN SOURCE BRANCH**: `AppState.signOut` and scope reconciliation now await process-wide cache clearing, invalidate `InboxSnapshotStore`, clear `URLCache`, and reorder auth logout after cache invalidation. Closed by iOS commit `f43fc5b`.

**New P0 from this hostile pass:**
| ID | Description |
|---|---|
| HOSTILE-CHAT-1A | Callback queries + commands/media now inherit central Telegram bot chat-tool authorization middleware. CLOSED IN SOURCE BRANCH via engine commit `16b23cc9`; coverage in `__tests__/handlers/chat-tool-auth-middleware.test.ts`. |
| HOSTILE-CHAT-1B | `runTelegramDomainHandlerWithToolAuthorization` now uses `isValidTenantUserId` and records tenant-scope anomalies for invalid ids. CLOSED IN SOURCE BRANCH via engine commit `16b23cc9`; coverage in `__tests__/handlers/chat-tool-auth-context.test.ts`. |

**New P1 from this hostile pass:**
- HOSTILE-AUTH-1 — CLOSED via engine commit `16b23cc9`; coverage in `__tests__/services/content-discovery-scope.test.ts` and `__tests__/services/manual-report-triggers.test.ts`.
- HOSTILE-CONT-F1 — OPEN / OWNER DECISION REQUIRED: resolver remains fail-closed until an OAuth/owned-channel writer marks creator-owned channels.
- GAP-CAL-1-A — CLOSED via engine commit `16b23cc9`; conflict intent emit is now isolated per user.
- GAP-CAL-1-C — OPEN / FOLLOW-UP: broader Telegram-only cron migration remains intentionally unbatched.
- GAP-FIN-1-A/D — CLOSED via engine commit `16b23cc9`; coverage in finance route/tracker tests plus `__tests__/utils/logger-redaction-finance.test.ts`.
- HOSTILE-IOS-REL3 — CLOSED via iOS commit `f43fc5b`; coverage in `Nexus HubTests/ReleaseHardeningConfigTests.swift`.
- HOSTILE-IOS-5A/B — CLOSED via iOS commit `f43fc5b`; coverage in `Nexus HubTests/RepositoryScopeChangeTests.swift`.
- P1-CHAT-1C — CLOSED via engine commit `16b23cc9`; destructive and external-send confirmation are pinned.
- P1-CHAT-1D — CLOSED / NARRATIVE CORRECTED in this section; central bot middleware is the closure mechanism.

P2/P3 (~15 more) live only in the hostile QA archive report; surface to OPEN_ITEMS only when promoted by a fix prompt or new evidence.

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
| GAP-CONT-1 | content runtime | Performance + SEO agents no longer read global `YOUTUBE_CHANNEL_ID` as a fallback. PARTIAL IN SOURCE BRANCH `feature/secretary-notification-orchestrator`; `src/services/youtube-channel-scope.ts` resolves only explicitly user-owned channels and fails closed. OPEN WRITER GAP: OAuth/owned-channel writer still needs owner authorization before live creator analytics can be considered enabled. Coverage in `__tests__/services/youtube-channel-scope.test.ts` and `__tests__/security/content-agent-neutrality.test.ts`. |
| GAP-COOK-1 | cooking | `applyMealPlanSubstitution`, `addRecipe`, `updateRecipe`, and `setMealPlan` now enforce stored allergy memory before writes; unsafe substitutions are rejected before mutation. CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator` via `6b6e74cb`; coverage in `__tests__/services/cooking-chef.test.ts` and `__tests__/api/cooking-routes.test.ts`. |
| GAP-REL-3 | iOS CI | `ios/.github/workflows/ios-release-hardening.yml` now runs real `xcodebuild test` on the Nexus Hub scheme, verifies the GitHub-runner simulator destination, writes an xcresult bundle, and asserts a non-zero test count before release-hardening completion. CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator` via iOS commit `f43fc5b`; coverage in `Nexus HubTests/ReleaseHardeningConfigTests.swift`. |
| GAP-REL-4 | backend health | `/health` and `/health/detailed` now run a live `SELECT 1` DB probe and return degraded/503 on failure. CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator` via `6b6e74cb`; coverage in `__tests__/portal/health-endpoints.test.ts`. |
| GAP-REL-5 | release pipeline | Notification orchestrator security gate is empty: classifier glob `__tests__/security/notification-*.test.ts` expands to nothing; cannot-skip dashboard does not include orchestrator file. — CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator` via `__tests__/security/notification-orchestrator-security.test.ts`, changed-area classifier mapping, and cannot-skip dashboard representative. |
| GAP-IOS-2 | iOS APNs | `ReportService.swift:111` hardcodes `environment: "sandbox"` for ALL builds → TestFlight/prod tokens mis-tagged → APNs delivery fails. — CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator`; debug builds register `sandbox`, release/TestFlight builds register `production`. |
| GAP-IOS-1 | iOS WIP | `SettingsView.swift:83-89` switch non-exhaustive after `SettingsDestination.notificationCenter` was added. — CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator`; settings navigation handles `.notificationCenter`. |
| GAP-IOS-3 | iOS WIP | `nexus://notifications/<id>` deep-link dead-ends (no view consumes `.notificationCenter`). — CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator`; `DeepLinkRouter` and Settings navigation consume notification-center routes. |
| GAP-IOS-4 | iOS WIP | `AppDelegate.swift didReceive response` ignores `actionIdentifier` (mark_done/snooze/approve_script/reject_reflow are no-ops). — CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator`; custom notification actions are queued and consumed by Decision Center action handling. |

### P1 — high priority before beta-launch

| ID | Area | Description |
|---|---|---|
| GAP-SEC-AUTH-1 | auth/state | Legacy 2-arg `saveIdea(title, sourceDate)` no longer writes `user_id=0`; saved-idea writes and promote/use/delete mutations now require and scope by positive `userId`. CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator`; coverage in `__tests__/state/saved-ideas-scope.test.ts`. |
| GAP-CHAT-1 | chat | Telegram domain routing now runs skill handlers inside `runWithChatToolAuthorization` ALS context with the canonical user/tenant. CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator`; coverage in `__tests__/handlers/chat-tool-auth-context.test.ts`. |
| GAP-TRN-1 | training | Plan-linter blockers remain advisor-only after persistence; promoting to strict requires a dedicated pre-persist or rollback-safe training batch. OPEN / OWNER DECISION REQUIRED. |
| GAP-CONT-2 | content tests | Neutrality coverage now scans TypeScript content agents/services and Python content-engine intelligence/creative services, and pins that runtime code does not read global `config.youtube?.channelId` / `YOUTUBE_CHANNEL_ID`. CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator` via engine commit `16b23cc9`; coverage in `__tests__/security/content-agent-neutrality.test.ts`. |
| GAP-CONT-3 | content loop | Radar feedback currently feeds `content_radar_feedback` and source-side aggregate state, but the hostile re-check confirmed the performance-feedback adaptation loop is not wired to live `content_performance`. OPEN / PRODUCT WORKSTREAM REQUIRED; do not describe this as verified closed. |
| GAP-CONT-4 | iOS content | TopicSchedulerView covers the publishing calendar half. Performance dashboard remains OPEN: ContentIntelligenceView does not expose views/retention/likes/comments performance truth. PARTIAL; physical/UI beta smoke remains operator validation after the performance surface exists. |
| GAP-SEC-NOTIF-1 | notif orch | Quiet-hours-delayed and digest items persisted with `scheduled_for` but no scheduler/release loop consumes them. — CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator`; scheduler now runs the orchestrator release loop. |
| GAP-SEC-NOTIF-2 | notif orch | `POST /api/v1/notifications/intents` accepts arbitrary `priority`/`sourceSkill`/`type` from client body; iOS could fabricate `security/critical`. — CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator`; arbitrary intent creation now requires internal secret authorization and fixture route remains deterministic. |
| GAP-SEC-NOTIF-3 | notif orch | `migrations/113_*.sql` schema diverges from runtime `ensureNotificationTables()`; `ios_devices` only at runtime. — CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator`; migration/runtime table setup now cover orchestrator tables and existing APNs compatibility storage is preserved. |
| GAP-SEC-NOTIF-4 | notif orch | `isInQuietHours` uses server-local time, not `profile.timezone`. — CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator`; quiet-hours policy now evaluates in the profile timezone. |
| GAP-CAL-1 | secretary | Conflict-detection cron now emits a Secretary `conflict_detected` NotificationIntent before Telegram delivery, isolates failures per user, and dedupes by conflict signature. PARTIAL via engine commit `16b23cc9`; broader Telegram-only cron migration remains OPEN as a separate workstream. Coverage in `__tests__/services/scheduler-user-scope.test.ts`. |
| GAP-FIN-1 | finance privacy | Hostile-cited finance logs no longer include raw transaction `category`/`amount`, receipt merchant/amount, tax due, or vendor names; logger redaction now includes finance PII/amount paths. CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator` via engine commit `16b23cc9`; coverage in `__tests__/services/finance-tracker.test.ts`, `__tests__/api/finance-routes.test.ts`, and `__tests__/utils/logger-redaction-finance.test.ts`. |
| GAP-FIN-2 | finance | Brazilian tax support is still the only implemented jurisdiction for tax calculation. OPEN / OWNER DECISION REQUIRED for a finance jurisdiction model and non-BR behavior contract. |
| GAP-PORT-3 | portal | New `/api/notifications` and `/api/notification-preferences` lack tenant filter at route boundary (`engine/src/portal/document-routes.ts:13-50,52-64`). — CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator`; portal routes validate scoped user/tenant headers/query and reject cross-tenant scope. |
| GAP-REL-1 | docs/identity | Workspace `docs/release/release-identity.md` stale at 4.14.132 (prod is 4.14.134). — OPEN |
| GAP-REL-2 | docs/release | Engine `docs/release/CURRENT_RELEASE_STATE.md` frozen at 4.14.127 — 7 production releases unsynced. — OPEN |
| GAP-REL-6 | mock-lint | Trajectory off-target: ~70 months at 10/month vs `<100 by 2026-08-01`. OPEN / OWNER DECISION REQUIRED: either authorize a larger mock-factory reduction batch or downgrade the commitment date. |
| GAP-REL-7 | release gate | Two-account E5 remains operator-evidence gated; adding a hard CI/deploy gate needs an explicit release-process decision to avoid blocking emergency deploys without physical-device evidence. OPEN / OWNER DECISION REQUIRED. |
| GAP-IOS-5 | iOS cache | `ResponseCache.shared.clear()` is now awaited on signOut and scope reconciliation/account switch paths, `InboxSnapshotStore` is invalidated, `URLCache` is cleared, and logout runs after local cache invalidation. CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator` via iOS commit `f43fc5b`; coverage in `Nexus HubTests/ResponseCacheTests.swift` and `Nexus HubTests/RepositoryScopeChangeTests.swift`. |

P2/P3 items (~30 more) live only in the archive report; surface to OPEN_ITEMS only when promoted by a fix prompt or new evidence.

## 2026-05-07 Hostile QA on Notification Orchestrator — New Findings

Hostile QA report: `docs/archive/2026-05/secretary-notification-orchestrator/hostile-qa-report.md`
Verdict: **SOURCE REMEDIATION COMPLETE FOR HOSTILE P0/P1 CLUSTER** on `feature/secretary-notification-orchestrator`; original hostile verdict was **NOT_READY** until the P0/P1 cluster closed.
Scope: 5 specialist Opus subagents in parallel; independent vitest run 37/37 passed; manual probes.

### P0 NEW

| ID | Area | Description |
|---|---|---|
| HOSTILE-POLICY-1 | notif policy | `quietHoursPolicy: 'send_now'` bypass hardened. CLOSED IN SOURCE BRANCH via `29ceb44f`; `send_now` is trusted only for security/system urgent paths and otherwise delays through quiet-hours logic. Behavioral coverage added in `__tests__/services/notification-orchestrator.test.ts`. |
| HOSTILE-PORTAL-1 | portal | Missing portal scope no longer falls back to all tenants. CLOSED IN SOURCE BRANCH via `3d66339b`; notification portal routes require admin token plus explicit user/tenant scope and return 400 on first-paint empty scope. |
| HOSTILE-PORTAL-2 | portal | Legacy content notifications are now scoped. CLOSED IN SOURCE BRANCH via `3d66339b`; `getAllNotifications(limit, scope)` requires validated user/tenant scope and portal tests pin no cross-tenant blend. |
| HOSTILE-PRIVACY-1 | privacy | Lock-screen body redaction now defaults safe. CLOSED IN SOURCE BRANCH via `8b79faaa`; `sensitiveBody` is persisted/read for authenticated detail and standard/security bodies no longer expose raw content. |
| P0-IOS-NOTIF-1 + HOSTILE-BACKEND-1 | iOS+auth lifecycle | Orphan notification tokens closed. CLOSED IN SOURCE BRANCH via backend `b50cc162` and iOS `f7a940b`; logout/logout-all revoke `notification_device_tokens`, and iOS signOut DELETEs the registered token before local reset. |
| P0-IOS-NOTIF-2 | iOS APNs entitlement | Time-sensitive support is no longer UI-only. CLOSED IN SOURCE BRANCH via engine `29ceb44f` and iOS `f7a940b`; APNs payload includes `interruption-level`, local reminders set interruption level, and debug/release entitlements include `com.apple.developer.usernotifications.time-sensitive`. |
| P0-IOS-NOTIF-3 | iOS test confidence | Decision action UI test is no longer fixture-only. CLOSED IN SOURCE BRANCH via iOS `d55367f`; the UI test launches against a local HTTP stub and verifies the action POST reaches `/api/v1/notifications/:id/actions`. |

### P1 NEW

| ID | Area | Description |
|---|---|---|
| HOSTILE-POLICY-2 | notif policy | Equal quiet-hours bounds are rejected. CLOSED IN SOURCE BRANCH via `29ceb44f`; `updateNotificationProfile` throws when `quietHours.start === quietHours.end`. |
| HOSTILE-POLICY-3 | privacy | `public` no longer bypasses per-skill scrubs. CLOSED IN SOURCE BRANCH via `8b79faaa`; finance/training/content/security redaction branches win before any raw-public body path. |
| HOSTILE-POLICY-4 | digest | Digest release now groups due passive items. CLOSED IN SOURCE BRANCH via `29ceb44f`; `assembleDailyDigest` emits one digest attempt for grouped rows. |
| HOSTILE-POLICY-5 | spam | Push rate limiting added. CLOSED IN SOURCE BRANCH via `29ceb44f`; excess active pushes become in-app-only with a decision-log reason instead of spamming APNs. |
| HOSTILE-POLICY-6 | APNs | APNs `interruption-level` support added. CLOSED IN SOURCE BRANCH via `29ceb44f` plus iOS `f7a940b`; backend, local notifications, and entitlement tests cover the contract. |
| HOSTILE-POLICY-7 | cross-skill | Cooking and Finance now have production intent emission paths. CLOSED IN SOURCE BRANCH via `29ceb44f`; meal-prep scheduling and tax due calculation emit orchestrated intents without direct push delivery. |
| HOSTILE-PRIVACY-2 | security | Security defaults are sensitive. CLOSED IN SOURCE BRANCH via `8b79faaa`; security lock-screen copy routes through the sensitive safe-title branch. |
| HOSTILE-PORTAL-3 | portal scope | Notification portal routes require admin token. CLOSED IN SOURCE BRANCH via `3d66339b`; read-token-only access is rejected. |
| P1-IOS-NOTIF-4 | iOS lifecycle | Queued notification actions now persist until consumed. CLOSED IN SOURCE BRANCH via iOS `676b7ed`; `DeepLinkRouter` restores pending action IDs from `UserDefaults` and clears them after matching consumption. |
| P1-IOS-NOTIF-5 | iOS scope guard | Decision Center load is scope-key guarded. CLOSED IN SOURCE BRANCH via iOS `f7a940b`; stale async responses after signOut/account switch are dropped. |
| P1-IOS-NOTIF-6 | iOS contract | Notification ID contract is standardized around string `itemId` while tolerating legacy numeric payloads. CLOSED IN SOURCE BRANCH via iOS `f814541` and existing router coverage; local notification payloads include both string `notificationId` and `itemId`. |

### Test-quality findings

- `__tests__/security/notification-orchestrator-security.test.ts`: CLOSED IN SOURCE BRANCH via `0a51d881`; replaced source-grep checks with behavior-bearing SQLite/route tests.
- `__tests__/portal/portal-notifications-ui.test.ts`: CLOSED IN SOURCE BRANCH via `0a51d881`; portal notification reads now exercise admin/scope behavior and safe serialization.
- `Nexus HubTests/NotificationDecisionCenterTests.swift`: CLOSED IN SOURCE BRANCH via iOS `f814541`; source-grep cases were replaced with DTO/action contract tests.
- `Nexus HubUITests/NotificationDecisionCenterUITests.swift`: CLOSED IN SOURCE BRANCH via iOS `d55367f`; added a non-fixture local-backend action round-trip UI test.

### Override notes

- **GAP-PORT-3** hostile downgrade is now CLOSED AGAIN IN SOURCE BRANCH via `3d66339b`; both empty route scope and legacy notification-array bypasses have behavioral tests.
- **GAP-SEC-NOTIF-3** hostile privacy downgrade is now CLOSED AGAIN IN SOURCE BRANCH via `8b79faaa`; `sensitive_body` is stored, mapped, serialized only where safe, and lock-screen bodies redact by default.

Codex remediation prompt: `docs/archive/2026-05/secretary-notification-orchestrator/notification-orchestrator-codex-remediation-prompt.md`.




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
