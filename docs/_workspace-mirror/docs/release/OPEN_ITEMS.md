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

Event backbone / read models / delta sync source branch: 2026-05-07.
Report:
`docs/release/event-backbone-readmodels-delta-sync-report.md`.
Verdict: **READY_WITH_CONDITIONS** after source remediation. Do not push or
deploy from this branch yet.

**2026-05-07 hostile QA on event backbone** —
`docs/archive/2026-05/event-backbone-readmodels-delta-sync/hostile-qa-report.md`.
Original hostile verdict was **NOT_READY** and was correct at audit time.
Source remediation now landed in engine `2e896435` and iOS `82abbea`; Claude
hostile re-QA remains the next evidence gate.

**Hostile P0 cluster — REMEDIATED IN SOURCE BRANCH**
| ID | Source-branch remediation | Hostile re-QA verdict |
|---|---|---|
| HOSTILE-OUTBOX-1 | Runtime emit paths now use transactional outbox via `runOutboxTransaction`; business state and event rows commit together when the DB is initialized. | **WEAK CLOSURE** — 8 wrapped sites correct, `emitDomainEventSafely` removed; but new `fallbackWhenDatabaseUnavailable` parameter re-introduces silent-drop on DB-unavailable race (HOSTILE-OUTBOX-1A); notification-orchestrator + finance PATCH hand-roll their own transactions bypassing canonical wrapper (HOSTILE-OUTBOX-1C); transactional-rollback test missing (HOSTILE-OUTBOX-1B). |
| HOSTILE-PRIV-1 | Event payloads and decision-log summaries now use recursive privacy sanitization before persistence/sync. | **VERIFIED CLOSED** — `src/utils/privacy-sanitizer.ts` (54 lines) recurses with `maxDepth: 4` + 26-key expanded regex; used by event-outbox, product-decision-log, AND delta-sync (defense-in-depth at appSafeSummary, tighter `maxStringLength: 160`); behavioral test pins nested redaction. |
| HOSTILE-BUDGET-1 | Resource budgets now use atomic SQLite `UPDATE ... RETURNING` counters keyed by tenant/user/window. | **VERIFIED CLOSED** — `UPDATE ... WHERE count + ? <= ? RETURNING count` is single-statement atomic; 100-caller concurrency test asserts final count <= 10 AND exactly 10 succeed. |
| HOSTILE-OBS-1 | Event/job workers and budget exhaustion emit structured, scoped logs with processed/failed/dead-letter counts. | **VERIFIED CLOSED** — 3 batch-summary log lines (`event_outbox_batch`, `background_job_batch`, `event_backbone_worker_tick`) with `claimed/processed/failed/deadLetter/durationMs`; spy tests assert schema; PII-safe. |

**P1 cluster outcomes:**
- HOSTILE-OUTBOX-2 (lease atomicity) — VERIFIED CLOSED
- HOSTILE-OUTBOX-3/JOB-3 (orphan reaper) — WEAK (code present, behavioral test missing)
- HOSTILE-OUTBOX-7 (dead-letter operator surface) — WEAK (102-line admin router, ZERO behavioral tests)
- HOSTILE-OUTBOX-9 (replay tenant scope) — VERIFIED CLOSED
- HOSTILE-JOB-2 (cancel processing) — WEAK / asymmetric (job side guards correct; **event side `markEventFailed`/`markEventProcessed` overwrite canceled** — HOSTILE-EVENT-CANCEL-RACE)
- HOSTILE-JOB-4 (decision-log retention) — VERIFIED CLOSED
- HOSTILE-SYNC-1 (deviceId no query trust) — VERIFIED CLOSED with strong behavioral test
- HOSTILE-SYNC-2 (retention vs offline device) — VERIFIED CLOSED with `protectFloor` + behavioral test
- HOSTILE-SYNC-4 (reset not advance cursor) — VERIFIED CLOSED with idempotent-reset test
- HOSTILE-OBS-2 (budget log + Retry-After) — VERIFIED CLOSED
- HOSTILE-TEST-1 (real 429 test) — VERIFIED CLOSED (drives 121 requests through live consume)

**iOS hardening outcomes:**
- HOSTILE-IOS-DS-1 (parallel fan-out): CLOSED structurally, but **validation test crashes** — HOSTILE-IOS-DS-NEW-1
- HOSTILE-IOS-DS-2 (cold-launch race): WEAK (fragile MainActor invariant, undocumented)
- HOSTILE-IOS-DS-3 (cancellation propagation): OPEN (no `Task.checkCancellation()`)
- HOSTILE-IOS-DS-4 (test coverage): WEAK (parallel test broken; cancellation/duplicate/cap untested)
- HOSTILE-IOS-DS-5 (duplicate changeId): WEAK (semantic flip last→first-write-wins, no test)
- HOSTILE-IOS-DS-6 (cache bound): CLOSED-with-caveat (magic 500, no constant/comment)
- HOSTILE-IOS-DS-9 (scenePhase TTL): WEAK / partial — only cold-launch gated; `onChange(of: scenePhase)` at DashboardView:214 still un-gated

**NEW findings introduced by remediation — REMEDIATED IN SOURCE BRANCH**
- **HOSTILE-OUTBOX-1A (P1)** — CLOSED via engine `e82bbdae`; `runOutboxTransaction` no longer has a DB-unavailable fallback and fails closed without initialized storage.
- **HOSTILE-OUTBOX-1B (P1)** — CLOSED via engine `e82bbdae`; rollback tests prove business rows roll back when event emit fails and event rows roll back when the callback throws.
- **HOSTILE-OUTBOX-1C (P2)** — CLOSED via engine `e82bbdae`; notification intent creation and Finance PATCH use `runOutboxTransaction`.
- **HOSTILE-EVENT-CANCEL-RACE (P1)** — CLOSED via engine `e82bbdae`; event processed/failed paths preserve `canceled`.
- **HOSTILE-MIGRATION-114-EDITED (P2)** — CLOSED via engine `e82bbdae`; migration 114 was restored and migration 115 rebuilds `event_outbox` with `canceled`.
- **HOSTILE-IOS-DS-NEW-1 (P1)** — CLOSED via iOS `12a9d95`; URLProtocol mock state is lock-protected.
- **HOSTILE-ADMIN-NO-TESTS (P1)** — CLOSED via engine `e82bbdae` plus `ca2e0cd9`; admin auth, tenant scope, replay, cancel, and attempts reset are behavior-tested.
- **HOSTILE-ORPHAN-REAPER-NO-TEST (P2)** — CLOSED via engine `e82bbdae`; stale event/job lease reclaim paths are behavior-tested.
- **HOSTILE-IOS-DS-9 (P1)** — CLOSED via iOS `12a9d95`; Dashboard scenePhase active refresh is TTL-gated.
- **HOSTILE-IOS-DS-3 (P1)** — CLOSED via iOS `12a9d95`; summary refreshes include cancellation checkpoints and regression coverage.
- **HOSTILE-IOS-DS-5 (P1/P2)** — CLOSED via iOS `12a9d95`; duplicate `changeId` first-write-wins is documented and tested.

**Hostile re-QA closeout addendum**: `docs/archive/2026-05/event-backbone-readmodels-delta-sync/hostile-qa-report.md` (post-remediation § + v2 closeout §).

**Independent gates after remediation**: tsc PASS · full `npm run verify` PASS 481 files / 7074 tests · focused event-backbone/security vitest PASS 52/52 · chat/admin follow-up vitest PASS 9/9 · Python pytest PASS 135/135 · iPhone Felipe DeltaSync tests PASS 11/11 · cannot-skip dashboard 23/23 · mock lint baseline 827.

**Process improvement observed**: this is the FIRST hostile wave where Codex's closure narrative matched the source on architectural primitives. The pre-claim probe was adopted. Remaining gaps are now narrower and behavioral (fallback-path bug, asymmetric guards, missing rollback test, broken mock thread-safety) rather than "headline architectural property is fabricated."

**Promoted P1 cluster — REMEDIATED IN SOURCE BRANCH**
- Atomic event/job claims, stuck-lock recovery, dead-letter list/replay/cancel
  operator routes, tenant-scoped replay/cancel, and processing-job cancellation.
- Cleanup preserves dead-letter forensic evidence and processed events needed by
  active sync cursors.
- Sync no longer trusts query-string `deviceId`; authenticated request device
  scope is required, reset-required paths do not advance the cursor, and iOS
  reset handling clears scope without storing an unacknowledged cursor.
- Route/budget tests now exercise real 429 paths and `Retry-After`; iOS
  repository/store tests now cover coalescing, parallel summaries, reset cursor
  safety, duplicate handling, and bounded cache history.

Remaining conditions:
- P1: independent Claude hostile re-QA against `2e896435` + `82abbea`.
- P1: authenticated iOS product-surface interaction smoke remains required
  before treating summary/delta app integration as UI-validated. Physical iPhone
  behavior tests passed, but no authenticated screen walkthrough is claimed.
- P1: release/deploy operator must explicitly confirm event-backbone worker and
  cleanup env flags before staging/prod (`EVENT_BACKBONE_WORKER_DISABLED`,
  batch limits, `EVENT_BACKBONE_CLEANUP_APPLY`).
- P2: gradually render Home, Week/Semana, Training, Content, and Notifications
  from summary read models where product value is clear.
- P2: expand budgets to provider, calendar, content radar, and live
  notification-delivery attempts.

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
