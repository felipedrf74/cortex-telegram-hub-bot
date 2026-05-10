# Decision Center Orchestration + APNs — Hostile QA Report

Date: 2026-05-10
Reviewer: Claude (opus, max effort across 5 specialist subagents)

## Verdict

**NOT_READY**

The closeout self-classified as `READY_WITH_CONDITIONS`. After hostile review, the conditions list materially understates what's missing. **Five P0 issues** were found across APNs delivery semantics, tenant safety, iOS UX correctness, and a closeout claim that does not match source. Eight more P1 issues span idempotency races, migration fragility, CI gate bypass, and missing test coverage that the closeout implied existed. Decision Center is conceptually well-designed and the Content approval slice is real — but the surface around it has multiple defects that must close before local QA can produce signal.

## Branches verified

- Engine: `feature/decision-center-orchestration-apns` HEAD `364b1b18` (single commit, 7 files, 1625+/3- LoC)
- iOS: `feature/decision-center-orchestration-apns` HEAD `bd66b2f1` (single commit, 12 files, 589+/159- LoC)
- Engine `origin/main` at `8ceb99e1` (v4.14.148) — production untouched ✓
- iOS `origin/main` at `13a5fa9` — production untouched ✓
- Backup tags exist on both repos ✓

## Validation gates re-run

- Engine typecheck: **PASS**
- Engine focused suite (`decision-center` + `decisions-routes` + `notification-orchestrator` + `notification-orchestrator-security` + `apns-sender` + `notifications-routes`): **71 passed / 71 total in 1.15s** ✓
- The closeout's "2 files / 8 tests" + "3 files / 49 tests" + "2 files / 35 tests" reconciles to 71 once you sum (8 decision + 49 notification/APNs + 14 notification routes) — closeout's "35" for notification route/auth smoke is overstated; my rerun shows only 14 in `notifications-routes.test.ts`. **Minor narrative drift, P3.**
- iOS focused tests not re-run (no simulator booted in this QA window); xcresult bundles cited in closeout exist on disk per agent verification.

## Closeout claims that do NOT survive verification

| Claim (closeout line) | Reality | Severity |
|---|---|---|
| "accessibility IDs: `home-decision-count-label`, `home-top-decision-preview`, `home-decision-all-clear-label`" (lines 114-116) | None of these three identifiers exist in the iOS source. Only `home-open-chat-button` and `home-decision-center-button` are present. UI tests rely on the latter only. | **P0** |
| "user/tenant isolation IMPLEMENTED_AND_VALIDATED in decision routes/service tests for list/detail/action denial" (line 218-219) | The single isolation test uses different `userId` only — never tests **same-tenant different-user** OR **cross-tenant with same userId**. The canonical isolation pattern is missing. | **P1** |
| "Expired/superseded IMPLEMENTED_AND_VALIDATED for action denial in service logic" (line 220-221) | `guardActionable` at `decision-center.ts:701-713` exists but **no test exercises any of the four error branches** (`DECISION_EXPIRED`, `DECISION_SUPERSEDED`, `DECISION_DISMISSED`, `DECISION_ALREADY_ACTIONED`). Code present, coverage absent. | **P1** |
| "Duplicate tap IMPLEMENTED_AND_VALIDATED through idempotent content action test" (line 222-223) | Test uses **sequential** calls with the same idempotency key. Real concurrent two-tap race is untested AND the code has a TOCTOU window between `getExistingExecution` and `insertExecution`. See P0-3 below. | **P1** |
| "iOS focused unit suite: PASS, 10 tests" (line 233) | xcresult bundle exists; not re-run in this QA window. Trust = E5. | accept |
| "Backend notification route/auth smoke: PASS, 2 files / 35 tests" (line 232) | My rerun shows 14 tests in `notifications-routes.test.ts`. The other file expected to bring the total to 35 wasn't included in my run set. Could be `device-token-routes.test.ts` or similar. | **P3** narrative drift |

## P0 — launch blockers (5)

### P0-1 — APNs sandbox/production environment is ignored at send time `apns-blocker`

**File:** `src/services/apns-sender.ts:204-223, 464`; `src/services/notification-orchestrator.ts:390, 1069, 1094`

`getPushTokensForUser` reads `push_token` from legacy `ios_devices` (no environment column). Dispatch always uses `config.apns.environment` and only retries the alternate environment after a 4xx (`apns-sender.ts:398-403`). The per-token `environment` stored in the new `notification_device_tokens` table is **never read**. A TestFlight (sandbox) token registered against a production-configured server will fail the primary send and recover only via a 400-then-retry round trip — doubling latency and lighting up "Permanent APNs error" telemetry for any unrelated 400.

**Fix:** join `notification_device_tokens` and pass per-token `environment` into `dispatchOne` instead of using the global config value. Update `apns-sender.test.ts` to assert sandbox tokens use sandbox APNs even when global env is production.

### P0-2 — User switch keeps old user's push tokens active `tenant-leak`

**File:** `src/services/notification-orchestrator.ts:1073-1080`; `src/api/routes/settings.ts:140-144`

`ON CONFLICT(device_id) DO UPDATE SET user_id = excluded.user_id` re-binds atomically — but does NOT revoke prior `notification_device_tokens` rows tied to the same `device_id` for the previous user, nor cancel queued notifications scoped to the prior `(user_id, device_id)`. A device that switches accounts still has historical `notification_device_tokens` rows with `revoked_at IS NULL` for user A, so any in-flight quiet-hours / digest release for user A will still target this device.

**Fix:** in `registerNotificationDeviceToken`, mark all other tokens for that `device_id` revoked AND cascade-cancel pending decision logs/notification intents scoped to the prior `(user_id, device_id)`. Add a regression test mirroring the Garmin P0 pattern.

### P0-3 — iOS action-failure path destroys the in-progress list and pretends nothing failed `wave-1-blocker`

**File:** `Nexus Hub/Views/Inbox/NotificationDecisionCenterView.swift:26, 273-277`

On `executeAction` failure, only `errorMessage` is set; `items[]` is never updated. But the `errorMessage` branch at line 26 short-circuits the entire body and **replaces the list with the error screen** — every other in-progress decision the user can see disappears. Worse, the action is not marked `failed`, so `decisionStatusMessage` (`:709-714`) shows nothing to indicate retry is needed.

**Fix:** keep `items` on screen, surface a localized inline error (toast or per-card banner), do not blow away the whole list on a single action failure. Mark the failed action as `failed` so the persistent status row reflects truth.

### P0-4 — Claimed accessibility identifiers do NOT exist on Home `wave-1-blocker`

**File:** `Nexus Hub/Views/Dashboard/DashboardHomePrimarySections.swift` (expected `:212` and adjacent)

Closeout claims `home-decision-count-label`, `home-top-decision-preview`, `home-decision-all-clear-label`. Source grep returns zero hits. UI tests cannot verify Home preview behavior because the identifiers are not bound. Closeout's evidence inventory is wrong.

**Fix:** add `.accessibilityIdentifier("home-decision-count-label")` to the subtitle, `.accessibilityIdentifier("home-top-decision-preview")` to the preview row, `.accessibilityIdentifier("home-decision-all-clear-label")` to the empty state. Add UI test that asserts each is reachable.

### P0-5 — Decision Center state is NOT scope-discarded on user switch `wave-1-blocker / tenant-leak`

**File:** `Nexus Hub/Views/Inbox/NotificationDecisionCenterView.swift:10`; `Nexus Hub/Views/Dashboard/DashboardView.swift:366, 959, 1008-1014`; `Nexus Hub/Core/AppState.swift:529-565`

`signOut() → handleScopeChange()` resets repositories but Decision Center state lives in transient SwiftUI `@State` (`items`, `decisionSummary`). On user A → user B switch without a process restart, the Home CTA `decisionSummary` from user A remains visible until the new `task {}` re-fires. Same for the Decision Center list. The scope-key guard in DashboardView (`:1008-1014`) prevents late-arriving network responses from polluting B, but the **already-rendered** user-A summary persists for the entire bridging window.

**Fix:** add `.onChange(of: appState.authenticatedScopeKey)` handlers in both views that immediately clear `items = []` / `decisionSummary = nil` on scope change. Add a regression test under `RepositoryScopeIsolationTests` for Decision Center state.

## P1 — high priority (8)

### P1-1 — Concurrent two-tap idempotency race (TOCTOU)

**File:** `src/services/decision-center.ts:355, 715-721, 376-380`; `migrations/119_decision_center_facade.sql:22`

`getExistingExecution` then `insertExecution` is read-then-write without a transaction. The UNIQUE constraint on `(decision_id, action_id, user_id, tenant_id, idempotency_key)` saves us *only if both calls use the same key*. With the **default key** at line 355 (`${decisionId}:${actionId}:${userId}:${tenantId}`), two concurrent taps will race past the existence check; both call `insertExecution`; the second fails the UNIQUE constraint with an unhandled exception that propagates as 500 to the client; the first proceeds to executor and `markExecutionSucceeded`. **One mutation succeeds; one returns 500.** Acceptable functionally but the 500 will trigger client retry logic.

**Fix:** wrap in `db.transaction()` with `INSERT OR IGNORE INTO decision_action_executions ... RETURNING id`; if no row returned, `SELECT` the existing row and treat as duplicate. Add a concurrent test using `Promise.all` of two `performDecisionAction` calls.

### P1-2 — Default idempotency key collapses distinct payloads (P1) AND distinct keys re-execute (P1)

**File:** `src/services/decision-center.ts:355, 715-721`

Same key construction has two opposing failure modes:
- Two retries with **same** payload + no client key → collapse correctly (good)
- Two distinct legitimate intents (e.g. user explicitly chose option A then changed mind to option B before A's read-back finished) → **collapse and lose the second mutation** (bad)
- Two retries with **different** client-supplied keys for the same `(decisionId, actionId)` → **executor runs twice** (bad)

**Fix:** require client `idempotencyKey` for mutating actions and reject if absent; OR include payload-hash in the fallback key. iOS already calls without a key (`ReportService.swift:111-113`) — make iOS supply a per-tap UUID and document the contract.

### P1-3 — Fixtures route is open to any authenticated user in non-production `privacy-blocker`

**File:** `src/api/routes/decisions.ts:107, 113-120`

Production gate at line 107 is `(NOT internal-secret AND NODE_ENV === 'production')`. In **staging/dev**, the gate is OFF — any authenticated user can `POST /api/v1/decisions/intents/fixtures/:sourceSkill`. The override args object at line 116 is `{ tenantId, ...req.body }` — body's `tenantId` overrides server-derived tenantId. A staging user can write a decision row with `(user_id=self, tenant_id=ARBITRARY_INT)`. Functionally orphaned but generates noise/integrity issues.

**Fix:** require internal-secret OR admin role in **all** environments. Reorder the override object to `{ ...(req.body ?? {}), tenantId }` so server values override body values.

### P1-4 — Migration 119 is NOT idempotent on replay

**File:** `migrations/119_decision_center_facade.sql:4-5`

Bare `ALTER TABLE notification_center_items ADD COLUMN snoozed_until` raises "duplicate column name" on replay. The runtime safety in `decision-center.ts:163-164` (PRAGMA-checked `ensureColumn`) hides this, but the migration file itself crashes if applied twice. CI/staging replay will fail.

**Fix:** wrap ALTER in PRAGMA check OR use the `ensureColumn` pattern in SQL; the rest of the migration uses `IF NOT EXISTS` correctly.

### P1-5 — `verifiedStatusEffect` trusts the writer's return value, not a fresh DB read

**File:** `src/services/decision-center.ts:745-746, 750-752, 782-801`

`verifiedStatusEffect` reads `item?.status` from the *return value of the same write call* rather than re-SELECTing from the DB. If the writer's return path drifts from the persisted state (e.g. the writer composes the return object from input rather than re-reading), read-back becomes a no-op.

**Fix:** in `verifiedStatusEffect`, do `getNotificationCenterItem(tenantId, decisionId)` from a fresh SELECT and compare. Add a test that mocks the writer to return success but DB shows different state — `DECISION_READBACK_MISMATCH` should fire.

### P1-6 — Release classifier does NOT recognize Decision Center files (CI gate bypass)

**File:** `scripts/changed-area-classifier.sh:307, 485`

Verified: `bash scripts/changed-area-classifier.sh --json --files src/services/decision-center.ts` returns `cannotSkip: []`, `vitest.globs: []`, `notification: false`. The classifier regex matches `^src/services/notification` and `^src/api/routes/notifications` — neither catches `decision-center.ts` or `decisions.ts`. **The notification-apns-delivery-and-tenant cannot-skip gate is bypassed on Decision Center changes.**

**Fix:** add `decision-center` and `decisions` to the area regex; add the new test files (`__tests__/services/decision-center.test.ts`, `__tests__/api/decisions-routes.test.ts`) to VITEST_GLOBS; update cannot-skip gate JSON.

### P1-7 — No collapse-id and no badge count on decision pushes

**File:** `src/services/apns-sender.ts:71, 338, 350-360`; `src/services/notification-orchestrator.ts:1388-1403`

Closeout claims duplicate decision updates collapse via `collapse-id = decision:<decisionId>`. Source has zero `apns-collapse-id` set. A second push for the same decision (snooze-then-unsnooze, evaluator runs twice) creates a second banner. Separately, `apns-sender` accepts `badge` but the orchestrator never passes one — closeout's "urgent+today open decisions" badge semantic is unimplemented.

**Fix:** in `attemptPushDelivery`, when payload is decision-derived, set `apns-collapse-id: decision:${decisionId}` and `badge = countOpenUrgentDecisionsForUser(userId)`. Add tests in `apns-sender.test.ts` and `notification-orchestrator.test.ts` asserting both.

### P1-8 — Foreground APNs duplicates the in-app card

**File:** `Nexus Hub/Core/AppDelegate.swift:108-118`

Returns `[.banner, .sound, .badge, .list]` for every foreground notification including decision payloads. If the user is on the Decision Center screen, an APNs decision arrives → banner shows + the `.task` refresh hasn't fired → user sees a banner AND a duplicate card on next pull-to-refresh. There is no in-app dedup by `dedupeKey`.

**Fix:** suppress banner for matching `decisionId` payloads when the Decision Center is foregrounded; let in-app refresh handle the update.

## P2 — Wave-1 recommended (10)

| # | Severity | File:line | Issue |
|---|---|---|---|
| P2-1 | wave-1-recommended | `src/services/decision-center.ts:192, 205` | Policy false-positives reminders with action chips into decisions |
| P2-2 | wave-1-recommended | `src/services/decision-center.ts:712` vs `notification-orchestrator.ts:1037` | Re-action of `actioned` decision — Decision Center 409s, Orchestrator returns idempotent. Inconsistent |
| P2-3 | wave-1-recommended | `src/portal/document-routes.ts:86` | Portal admin returns raw `item.title` instead of safe-title helper. Future-skill leak risk |
| P2-4 | wave-1-recommended | `src/services/notification-orchestrator.ts:1080-1094` | Stale `notification_device_tokens` rows not revoked on rebind |
| P2-5 | wave-1-recommended | `src/api/routes/notifications.ts:1004` | Decision actions reachable via two endpoints (`/decisions/:id/actions` + `/notifications/:id/actions`). Second bypasses idempotency + read-back |
| P2-6 | wave-1-recommended | `Nexus Hub/Views/Inbox/NotificationDecisionCenterView.swift:225-238` | `markViewed` only fires on notification tap, not when Home opens Decision Center → undercounts read metrics |
| P2-7 | wave-1-recommended | `Nexus Hub/Core/DeepLinkRouter.swift:107-112` | `consumePendingNotificationAction` does NOT validate `pendingUserScope == currentUserScope()`. Cross-user replay possible |
| P2-8 | wave-1-recommended | `Nexus Hub/Views/Inbox/NotificationDecisionCenterView.swift:191-196` | Scope-mismatch guard does not clear `items` — user A's items linger until B's first fetch returns |
| P2-9 | wave-1-recommended | `__tests__/api/decisions-routes.test.ts:169-189` | Routes test mocks every facade function; only verifies wiring, not real branching |
| P2-10 | wave-1-recommended | `Nexus Hub/Views/Inbox/NotificationDecisionCenterView.swift:241-278` | iOS does NOT optimistic-update — confirmed clean. (counter-finding: this is correctly implemented) |

## P3 — defer to Wave 2 (selected)

- `INTERNAL_API_SECRET` no minimum-length validation (`src/api/routes/decisions.ts:38` config path)
- `ios_devices.push_token` no UNIQUE constraint
- `Date.now()` in `urgencyForPriority` (`decision-center.ts:497`) makes tests nondeterministic; inject clock
- Snooze can outlive expiry (`decision-center.ts:411`) — accept and document
- History pagination silent truncation at 200 (`decision-center.ts:292`)
- Backend hardcodes English action labels; iOS works around for known IDs only
- No analytics emission for `decision_action_executions` (Wave-2 telemetry gap)
- Dead `'viewed'` notification status introduced this PR but never written

## What Codex got RIGHT

- **Real read-back verification on Content path** (`decision-center.ts:803-856`): action applied, then re-read, then status mismatch throws — not just trusting the writer
- **Idempotency table with composite UNIQUE** on `(decision_id, action_id, user_id, tenant_id, idempotency_key)` — correct columns
- **Refusing unknown mutating actions** with `UNSUPPORTED_DECISION_EXECUTOR` — failure is loud, decision marked `failed` not `actioned`
- **iOS does NOT optimistic-update** — server is source of truth; only spinner + server-confirmed `replaceItem`
- **Privacy posture is conservative**: Home/APNs/iOS list all use `safePreviewTitle/safePreviewBody` from declared sources; `displayBody` falls through to `summary` last; raw token never logged (`apns-sender.ts:339, 384` truncate to `tokenSuffix`)
- **Tenant scope on every storage read** is correct: `(user_id = ? AND tenant_id = ?)` everywhere; auth middleware never lets body override server identity
- **Sentry/error-log redaction** via `stringifySanitizedLogContext` and `sanitizeSentryEvent` covers decision context
- **Owner/admin scope** is uniformly `'user_private'` — query shape prevents cross-user listing today
- **`dedupeKey` mechanism** in notification-orchestrator suppresses recurring decisions correctly via `findActiveDuplicate:1513-1526`

## End-to-end scenarios

| Scenario | Expected | Actual | Status |
|---|---|---|---|
| Training conflict → decision appears | Yes via Secretary intent | Yes; reflow executor honestly blocks with `UNSUPPORTED_DECISION_EXECUTOR` | READY_WITH_CONDITIONS |
| Training missing input → decision appears | Yes via fixture | Yes; real Training executor deferred | DEFERRED with reason |
| Content approval → decision + action | Yes; deterministic execute + read-back | **IMPLEMENTED_AND_VALIDATED** (only verified end-to-end path) | ✅ |
| Overcapacity week → reflow | Decision + Secretary executor | Decision yes, executor deferred | DEFERRED with reason |
| Calendar sync issue → retry | Decision + retry executor | Decision yes, retry deferred | DEFERRED with reason |
| Chat ambiguity → clarification | Decision + Chat bridge | Category exists, bridge deferred | DEFERRED with reason |
| Finance reminder → privacy-safe | Decision yes, mark_paid executor | Privacy classification yes, executor deferred | DEFERRED with reason |
| User/tenant isolation | Cross-tenant, cross-user denied | Cross-tenant denied; **same-tenant different-user untested** | INCOMPLETE |
| Expired/superseded action denied | Yes; specific error codes | Code yes, **tests absent** | INCOMPLETE |
| Duplicate tap idempotent | One mutation only | **TOCTOU race window exists**; sequential idempotency works | INCOMPLETE |
| Missing APNs credentials | Decision Center still works | ✅ verified clean | ✅ |
| User switch → no stale state | iOS clears summary + list | **Items linger until B's first fetch** | INCOMPLETE |

## APNs delivery scorecard

| Check | Status | Detail |
|---|---|---|
| Visible payload safe copy | ✅ | `safeNotificationTitle` + `buildPrivacySafeBody` in orchestrator |
| Background payload privacy | ✅ | `data` field has only IDs + sourceSkill + type + deeplink |
| Categories registered server-side | ✅ | All 4 emit correctly |
| Categories registered iOS-side | ⚠ | Source not located by initial grep; agent flagged `wave-2-prep` — verify in next round |
| Actions call DecisionAction endpoint | ⚠ | Possible (closeout claims yes); the `/notifications/:id/actions` shortcut bypasses this and is reachable |
| Sandbox/production env honored | ❌ | **P0 — not honored at send time** |
| Raw token absent from logs | ✅ | `tokenSuffix` only |
| Stale token cross-user delivery | ❌ | **P0 — old user's `notification_device_tokens` rows survive rebind** |
| collapse-id on decision pushes | ❌ | **P1 — never set** |
| Badge count semantics | ❌ | **P1 — never set** |
| Foreground duplication | ❌ | **P1 — banner + in-app card** |
| Missing-credentials handling | ✅ | Skip-and-log-once, in-app item still created |

## Test quality scorecard

**Strong** (3/8 backend tests):
- `decision-center.test.ts:64-91` classification of true decisions vs notifications/insights — strong for asserted cases
- `decision-center.test.ts:93-114` Home summary safe-preview construction
- `decision-center.test.ts:116-144` content approval round-trip with read-back AND idempotency on same key

**Shape-only** (3/8):
- `decision-center.test.ts:158-166` "denies wrong-user" — only one user pair, no two-tenant case
- `decisions-routes.test.ts:191-203` fixtures gating — only prod gate, doesn't verify staging/dev hardening
- `decisions-routes.test.ts:205-215` device-tokens no raw-echo — strong for assertion but minimal

**Mock-the-test** (1/8):
- `decisions-routes.test.ts:169-189` summary/list/detail/actions — every facade function stubbed; verifies wiring only

**Strong/borderline** (1/8):
- `decisions-routes.test.ts:191-203` borderline strong (asserts production gating) but doesn't cover staging

**Missing entirely:**
- Two-user same-tenant isolation
- Two-tenant same-userId boundary
- Concurrent duplicate-action TOCTOU
- Expired/superseded/dismissed action denial (all four error branches uncovered)
- Read-back mismatch
- APNs payload privacy (sensitive content NOT in alert.body)
- Wrong-user notification action denial
- Device-token registration with body-injected userId/tenantId

## Cleanup contract

- ✅ Production NOT touched (engine `origin/main` at `8ceb99e1`, iOS `origin/main` at `13a5fa9`)
- ✅ Branches pushed to origin for evidence preservation
- ✅ TestFlight NOT cut
- ✅ Backup tags exist on both repos
- ⚠ iOS working tree has dirty `xcodeproj`/`xcscheme` files — per prompt, not reverted

## Future prompt improvements

For next Decision Center prompt:
1. Be explicit about which executors must be implemented end-to-end vs which can be honest-blocked
2. Mandate that the release classifier (`changed-area-classifier.sh`) is updated as part of any new domain
3. Mandate that "claimed accessibility identifiers" are verified by source grep before closeout
4. Mandate two-user same-tenant + two-tenant same-userId isolation tests as standard, not optional
5. Mandate concurrent idempotency test (Promise.all) for any action endpoint
6. Mandate `apns-collapse-id` and `badge` test pins for any new APNs surface

For next Claude QA prompt:
1. Always verify accessibility identifiers via `grep` against the source rather than trusting closeout
2. Always re-run focused suite locally and reconcile test counts vs closeout claims
3. Always run `changed-area-classifier.sh` against the new files to verify CI gate coverage
4. Always test concurrent-tap race for any action endpoint with idempotency claims

## Final recommendation

**NOT_READY**

The implementation has good bones — the policy facade, idempotency table, read-back design, privacy posture, and "honest blocked" non-executor handling are conceptually correct. But the surface around the Content slice has 5 P0 defects (APNs env mismatch, stale-token tenant leak, iOS action-failure UX bug, missing accessibility IDs, and Decision Center state not scope-discarded on user switch) plus 8 P1 defects spanning idempotency races, migration fragility, CI gate bypass, and missing test coverage that the closeout implied existed. **Multiple closeout claims do not survive verification.**

Local QA will produce noise rather than signal until at minimum the 5 P0 items close and the release classifier is updated to keep the cannot-skip gate covering this domain. Recommend a Round-D fix prompt focused on:

1. P0 fixes (APNs environment + stale tokens + iOS action-failure UX + accessibility IDs + scope-discard)
2. P1 fixes (idempotency transaction + fixtures route hardening + migration idempotence + verifiedStatusEffect re-SELECT + release classifier + collapse-id + badge + foreground dedupe)
3. The 8 missing test coverage items the closeout claimed existed

After those land, the slice converges with what the closeout described and `READY_FOR_LOCAL_QA` becomes achievable.
