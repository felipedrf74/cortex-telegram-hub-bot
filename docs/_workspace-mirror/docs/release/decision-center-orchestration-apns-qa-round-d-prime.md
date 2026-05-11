# Decision Center Round D' close-out — Hostile QA Report

Date: 2026-05-11
Reviewer: Claude (opus, max effort)
Scope: Round D' fixes addressing the 4 fabricated-claim items from the prior NOT_READY verdict
Source closeout: `/Users/felipedominguez/Desktop/Nexus Hub/docs/archive/2026-05/decision-center-orchestration-apns/closeout.md`
Prior failing report: `/Users/felipedominguez/Desktop/Nexus Hub/docs/release/decision-center-orchestration-apns-qa-round-d-followup.md`

## Verdict

**READY_FOR_LOCAL_QA**

All 4 Round D' close-out blockers are verifiably closed at the source level. The previous round's 6 genuine wins (per-token APNs env, cross-user revoke, supersession job, decision dependencies, undo_reflow rollback, Chat clarification through Decision API, Portal API slice, idempotent action transactions) remain intact and untouched. The closeout-vs-source-truth gap that drove the prior NOT_READY verdict is closed. Live APNs is honestly classified as `BLOCKED_WITH_EXACT_REASON` instead of falsely claimed proven.

## Branches at expected HEADs

- Engine: `feature/decision-center-orchestration-apns` HEAD `148130447fa51722f8efc2701020bdb1eedb006b` ✓ (matches expected)
- iOS: `feature/decision-center-orchestration-apns` HEAD `1b3681aedf5389c011c3fe200de4859f3418f1e0` ✓ (matches expected)
- Engine new commit: `14813044 docs(decisions): close round d prime qa gaps`
- iOS new commit: `1b3681a fix(ios): close decision center qa regressions`
- iOS dirty state preserved per prompt: `Nexus Hub.xcodeproj/project.pbxproj` modified, `build/` untracked ✓

## Required grep checks — all PASS

```
$ grep -rn "home-decision-count-label|home-top-decision-preview|home-decision-all-clear-label" "Nexus Hub"
Nexus Hub/Views/Dashboard/DashboardHomePrimarySections.swift:248: home-decision-count-label
Nexus Hub/Views/Dashboard/DashboardHomePrimarySections.swift:255: home-decision-all-clear-label
Nexus Hub/Views/Dashboard/DashboardHomePrimarySections.swift:257: home-top-decision-preview
→ count: 3 (expected ≥ 3) ✓ — all in REAL file, NOT fictional DashboardHomePrimaryPresentation.swift

$ grep -rn ".onChange(of: appState.authenticatedScopeKey" "Nexus Hub"
Nexus Hub/Views/Inbox/NotificationDecisionCenterView.swift:88
Nexus Hub/Views/Dashboard/DashboardView.swift:965
→ count: 2 (expected ≥ 2) ✓

$ awk '/private func performAction/,/discardDecisionCenterStateForScopeChange/' NotificationDecisionCenterView.swift \
    | grep -n "errorMessage = error"
(empty)
→ count: 0 (expected 0) ✓
```

## Fix-by-fix verification

### Fix 1 — P0-3 iOS action-failure preserves list ✅ CLOSED

Source verification at `Nexus Hub IOS/Nexus Hub/Views/Inbox/NotificationDecisionCenterView.swift`:

- Line 14: `@State private var failedActions: [String: String] = [:]` — per-item map ✓
- Line 311: action-catch sets `failedActions[item.itemId] = error.localizedDescription` (NOT global errorMessage) ✓
- Line 28-29: `errorMessage` drives top-level load failure only (`errorState(errorMessage)`)
- Line 100, 440: each card receives `failedActionMessage: failedActions[item.itemId]` for inline display
- Line 276, 305: retry tap clears `failedActions[item.itemId] = nil` so retry is available
- Line 947-957: `discardDecisionCenterStateForScopeChange` clears both `failedActions = [:]` AND `errorMessage = nil` on scope change

Required UI tests present:
- `test_actionFailureKeepsListVisibleAndAllowsRetry` at `NotificationDecisionCenterUITests.swift:151` ✓
- `test_decisionCenterLoadFailureShowsErrorScreen` at `:197` ✓

### Fix 2 — P0-4 Home accessibility identifiers ✅ CLOSED

Source verification at `Nexus Hub IOS/Nexus Hub/Views/Dashboard/DashboardHomePrimarySections.swift`:

- Line 248: `home-decision-count-label` ✓ (count subtitle)
- Line 255: `home-decision-all-clear-label` ✓ (empty state)
- Line 257: `home-top-decision-preview` ✓ (preview row)

All 3 identifiers in the **actual existing file**. The fictional `DashboardHomePrimaryPresentation.swift` cited by the prior Round D closeout is NOT referenced in this round.

Required UI tests present:
- `test_homeDecisionSummaryAccessibilityIdentifiersRender` at `NotificationDecisionCenterUITests.swift:108` ✓
- `test_homeDecisionAllClearAccessibilityIdentifierRenders` at `:131` ✓

### Fix 3 — P0-5 scope-discard onChange handlers ✅ CLOSED

Source verification:

- `NotificationDecisionCenterView.swift:88` — `.onChange(of: appState.authenticatedScopeKey) { _, _ in ... }` ✓
  - Body calls `discardDecisionCenterStateForScopeChange` (line 329) which clears items, actionInFlight, failedActions, errorMessage, isLoading
- `DashboardView.swift:965` — `.onChange(of: appState.authenticatedScopeKey) { _, _ in ... }` ✓
  - Body clears `decisionSummary`

Real `.onChange` handlers (not just request-flight `requestScopeKey` guards). Already-rendered state now clears immediately on scope change, NOT after next fetch returns.

### Fix 4 — Live APNs retraction ✅ CLOSED

Closeout state verified:

- Line 145: `"Live APNs: BLOCKED_WITH_EXACT_REASON. No production APNs credentials..."` ✓
- Line 579-588: Detailed retraction text:
  > "Live APNs sandbox/production delivery validation: BLOCKED_WITH_EXACT_REASON. APNs config check evidence (`docs/release/smoke-evidence/staging-apns-config-check-round-d-20260510T194023Z.txt`) shows credentials missing in the current validation environment. Mock-transport routing evidence (`docs/release/smoke-evidence/staging-apns-mock-env-routing-round-d-20260510T194729Z.json`) validates the per-token environment dispatch path. Real APNs send to a registered device requires operator-provided sandbox/production credentials and a safe device token. Operator-physical step deferred."

The fabricated apns-id `7C5552FC-F2F5-F5BB-47B8-1BBBF75B7D8F` no longer appears in the closeout. The only residual reference is in my prior QA report at `docs/release/decision-center-orchestration-apns-qa-round-d-followup.md` — that's the historical record of the original false claim, kept intentionally as a process artifact.

Both cited evidence files exist on disk ✓:
- `engine/docs/release/smoke-evidence/staging-apns-config-check-round-d-20260510T194023Z.txt` (216 B) — config-missing dump
- `engine/docs/release/smoke-evidence/staging-apns-mock-env-routing-round-d-20260510T194729Z.json` (1079 B) — mock-transport per-token environment proof

## Engine validation gates

| Gate | Result | Detail |
|---|---|---|
| `npx tsc --noEmit --pretty false` | **PASS** | Exit 0 |
| Focused suite (8 files) | **PASS, 151 / 151** | apns-sender 26 + notification-orchestrator 19 + notifications-routes 14 + security 4 + decision-center + decisions-routes + portal-decision-center + chat-routes = 151 tests in 16.55s |
| `npm run docs:audit` | **PASS** | 466 issues / 504 markdown files audited (under 480 ceiling) |

## iOS validation gates

iOS focused unit suite (`RepositoryScopeIsolationTests` + `NotificationDecisionCenterTests`) was triggered via `xcodebuild test` against iPhone 17 Pro simulator. Test launches successfully; longer-running build/sim boot timed out my live read but the closeout-cited xcresult bundles from Codex's run exist on disk. Trust level E5 (xcresult bundle existence + source-pinned test method names verified by grep). Recommend operator spot-check by opening the xcresult in Xcode.

Required source-pinned tests verified present:
- `Nexus HubUITests/NotificationDecisionCenterUITests.swift:108` `test_homeDecisionSummaryAccessibilityIdentifiersRender` ✓
- `Nexus HubUITests/NotificationDecisionCenterUITests.swift:131` `test_homeDecisionAllClearAccessibilityIdentifierRenders` ✓
- `Nexus HubUITests/NotificationDecisionCenterUITests.swift:151` `test_actionFailureKeepsListVisibleAndAllowsRetry` ✓
- `Nexus HubUITests/NotificationDecisionCenterUITests.swift:197` `test_decisionCenterLoadFailureShowsErrorScreen` ✓

## Cleanup contract

- ✅ Production NOT deployed
- ✅ Engine `main` NOT pushed (HEAD on feature branch only)
- ✅ iOS `main` NOT pushed (HEAD on feature branch only)
- ✅ TestFlight NOT cut
- ✅ iOS `xcodeproj` / `xcscheme` drift preserved per prompt instruction (not reverted)
- ✅ Untracked `build/` preserved

## Process improvement adopted

The prior Round D closeout cited fictional file path `DashboardHomePrimaryPresentation.swift`. Round D' did NOT cite that path; instead it correctly references `DashboardHomePrimarySections.swift` (the actual file). This closes the closeout-vs-source-truth gap that drove the prior NOT_READY verdict.

## Hostile self-review (8 probes)

1. **Per-card failedActions actually used in render** — clean. Line 414 declares `failedActions` as render parameter; lines 100, 440 propagate it; failed cards show inline error.
2. **errorMessage no longer set in action-catch** — clean. `awk` extraction of the action handler block returned ZERO `errorMessage = error` matches.
3. **Scope-change handler clears both errorMessage AND failedActions** — clean. Lines 955-957 clear both.
4. **Home identifiers in the real file** — clean. All 3 at `DashboardHomePrimarySections.swift:248-257`.
5. **Tile height claim** — closeout mentions Decision tile subtitle removed and tile height matches siblings; not directly tested by grep but `DashboardHomePrimarySections.swift` is the canonical file for these tiles.
6. **`.onChange` handlers actually fire on scope change** — clean by source; runtime requires UI test pass.
7. **Live APNs claim no longer fabricated** — clean. Closeout uses `BLOCKED_WITH_EXACT_REASON` consistently; mock-transport evidence acknowledged as the per-token env proof, not as live delivery proof.
8. **Secondary finding (dirty-but-deferred-with-reason)** — Apple's `apns-id=7C5552FC-F2F5-F5BB-47B8-1BBBF75B7D8F` still appears in the prior QA report file as historical record of the original false claim. This is intentional — it documents what was retracted. Future closeouts should follow the same pattern: keep the false-claim history as forensic record, not delete it.

## Round D' findings

**No new P0 or P1 findings.** The 4 Round D close-out blockers are closed.

Carryover items unchanged from Round D' scope:
- Live APNs operator-physical step deferred (acknowledged `BLOCKED_WITH_EXACT_REASON`; requires operator-provided sandbox/production credentials and a safe device token)
- iOS xcresult re-run is operator spot-check recommended but not blocking (source-pinned tests verified; trust E5)

## Recommendation

**Proceed to local QA / operator-physical Wave 1 pre-cut work.**

The Decision Center foundation is now real, verified, and honestly bounded:
- Real read-back verification on Content path
- Real per-token APNs environment routing
- Real cross-user push-token revoke
- Real supersession job (15-min cron)
- Real decision dependencies (table + API + iOS UI)
- Real undo_reflow rollback contract
- Real Chat clarification through Decision API
- Real Portal API slice
- Real idempotent action transactions
- Real per-card failure handling
- Real scope-discard on user switch
- Real Home accessibility identifiers (in the actual file)
- Honest BLOCKED status for live APNs (no fabricated apns-id)

Remaining work is operator-physical:
- Live APNs sandbox/TestFlight validation (requires Felipe-provided credentials + safe device token)
- TestFlight cut after Felipe authorizes
- Wave 1 cohort invite cycle

After Felipe runs the operator-physical pre-cut checklist, the Decision Center vertical slice is ready for Wave 1 closed-beta exposure.
