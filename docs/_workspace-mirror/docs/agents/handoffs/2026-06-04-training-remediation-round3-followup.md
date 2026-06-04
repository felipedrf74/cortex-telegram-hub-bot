# Agent Handoff — Training Remediation Round 3 (QA fast-follow patch)

**From**: Claude Code (independent QA)
**To**: Codex (implementer)
**Date**: 2026-06-04
**Backend base**: `main` (prod runtime `ddb8eec4` = `4.14.201`); functional source HEAD `e758d6ab`.
**iOS base**: `main` @ `c0c3f39`.
**Scope**: residual open items from the round-2 closure QA. Round-2 QA closed 23 of 31 prior findings. This doc = the remaining open items, each with an apply-ready fix + test + verify step.

> Caveman density in the per-fix mechanics. Full prose kept for security + multi-step parts (per `docs/skills/caveman/SKILL.md` auto-clarity exception).

## Context (read first)

- Production is live + healthy at `4.14.201`. Reviewed source `e758d6ab` IS the prod artifact (only delta to `ddb8eec4` = version bump). These fixes are a **fast-follow**, not an incident.
- Two items (FIX-1, FIX-2) are **multi-tenant existence oracles currently live in prod**. Info-disclosure only (which sequential IDs exist in other tenants). No data read, no cross-tenant mutation. Patch them first.
- Gold-standard no-oracle pattern already exists in repo: `resolveOwnedPlan` / `resolveOwnedWeek` in `src/api/routes/training-coach-v2.ts:329-364` — uniform `404 PLAN_NOT_FOUND` for both missing + foreign, with a server-side `logger.warn` carrying `ownerIdHash: hashOwnerIdForLog(row.user_id)`. **Mirror that pattern.** If `hashOwnerIdForLog` is local to `training-coach-v2.ts`, extract it to a shared util (e.g. `src/api/routes/_ownership-audit.ts`) and import from all sites.

## Priority order

- **P0 (security, live in prod)**: FIX-1 reflow oracle, FIX-2 cancel timing/body oracle.
- **P1 (correctness)**: FIX-3 cancel tenantId, FIX-4 acute-injury copy, FIX-5 injury_safe_swap wiring (needs product decision), FIX-6 iOS Garmin-freshness honesty, FIX-7 iOS low-adherence transient.
- **P2 (docs/tests/release-identity)**: FIX-8 release-identity, FIX-9 doc staleness, FIX-10 ACWR boundary tests, FIX-11 inferred-pain route test, FIX-12 stale doc comments.
- **P3 (info)**: FIX-13 migration DB test, FIX-14 WeekProtection 0% surface.

---

## FIX-1 (P0) — Reflow endpoints leak 403-vs-404 ownership oracle

**Security finding.** `/sessions/:id/reflow-preview` + `/reflow-confirm` return `403 FORBIDDEN` + "This training session does not belong to the current user." for a foreign session, vs `404` for missing. Same defect class F1 already fixed for `/complete` + `/skip`. File was never touched by round-2 (`git diff 6d1914a6 e758d6ab -- src/api/routes/training-plan-calendar-sync.ts` = empty). Globally-sequential session IDs → cross-tenant enumeration.

**File**: `engine/src/api/routes/training-plan-calendar-sync.ts`

Collapse the foreign-owned (`'forbidden'`) result into the missing (`'not_found'`) result so both produce an identical 404 body. Audit foreign-owner server-side only.

`previewTrainingSessionReflow` (~line 364):
```ts
-  if (scope === 'forbidden') {
-    return { status: 'forbidden', data: { message: 'This training session does not belong to the current user.', sessionId } };
-  }
-  if (!scope) {
-    return { status: 'not_found', data: { message: 'Training session not found.', sessionId } };
-  }
+  if (scope === 'forbidden' || !scope) {
+    // No-oracle: foreign-owned and missing both return an identical 404.
+    return { status: 'not_found', data: { message: 'Training session not found.', sessionId } };
+  }
```

`confirmTrainingSessionReflowLocked` (~line 569) — same collapse:
```ts
-  if (scope === 'forbidden') return { status: 'forbidden', data: { message: 'This training session does not belong to the current user.', sessionId: input.sessionId } };
-  if (!scope) return { status: 'not_found', data: { message: 'Training session not found.', sessionId: input.sessionId } };
+  if (scope === 'forbidden' || !scope) {
+    return { status: 'not_found', data: { message: 'Training session not found.', sessionId: input.sessionId } };
+  }
```

Add the audit log inside `resolveOwnedSessionScope` (~line 228-231), where the parent `plan` is in scope, before `return 'forbidden'`:
```ts
  if (!plan || plan.user_id !== userId) {
    if (plan) {
      logger.warn(
        { actor: userId, sessionId, ownerIdHash: hashOwnerIdForLog(plan.user_id), reason: 'foreign_owner' },
        'training_reflow.ownership_denied',
      );
    }
    return 'forbidden';
  }
```

**Route handlers** (`engine/src/api/routes/training-plan-routes.ts:492-495` and `549-552`): the `result.status === 'forbidden'` branch is now dead (reflow fns never return `'forbidden'`). Delete both dead 403 branches.

**Test**: `engine/__tests__/api/training-plan-routes.test.ts` (or a new `training-session-reflow-no-oracle.test.ts`). For BOTH reflow-preview + reflow-confirm: seed tenant B's session, auth as tenant A, POST tenant B's sessionId AND a non-existent sessionId. Assert identical `status=404`, `code=NOT_FOUND`, `message='Training session not found.'` for both.

---

## FIX-2 (P0) — `/plan/cancel` residual timing + body oracle

**Security finding.** Round-2 removed the 403 message but left two side-channels distinguishing a foreign planId from a missing one:
- **Timing**: foreign returns synchronously; missing runs `cleanupOrphanedTrainingCalendarEventsForUser(userId)` → remote Google/Outlook enumeration over ~254 days → measurable latency delta.
- **Body**: missing returns `removedEvents` = caller's own orphan count; foreign always `removedEvents:0`. Attacker seeds one own orphan marker → reliable boolean oracle.

**File**: `engine/src/api/routes/training-plan-cancellation.ts` (`cancelTrainingPlanForUserLocked`, lines 180-201)

Route the foreign-owned case through the SAME no-op path as missing: run the same orphan cleanup, return the same payload. Never touch the foreign plan. Audit server-side.

First, DRY the no-op result into a helper (the current `plans.length === 0` block, lines 184-201):
```ts
async function buildNoActivePlanResult(userId: number): Promise<TrainingPlanCancellationResult> {
  const removedEvents = await cleanupOrphanedTrainingCalendarEventsForUser(userId);
  return {
    status: 'not_found',
    data: {
      cancelled: false,
      removedEvents,
      removedSessions: 0,
      removedWeeks: 0,
      removedCompletions: 0,
      removedPlans: 0,
      totalSessions: 0,
      message: removedEvents > 0 ? buildCancellationMessage(removedEvents, 0) : 'No active training plan to cancel.',
    },
  };
}
```

Then replace lines 180-201:
```ts
-  if (requestedPlan && (requestedPlan.user_id !== userId || !planTenantMatches(requestedPlan, tenantId))) {
-    return { status: 'forbidden' };
-  }
-
-  if (plans.length === 0) {
-    const removedEvents = await cleanupOrphanedTrainingCalendarEventsForUser(userId);
-    return { status: 'not_found', data: { /* ...noop... */ } };
-  }
+  const foreignOwned = !!requestedPlan && (requestedPlan.user_id !== userId || !planTenantMatches(requestedPlan, tenantId));
+  if (foreignOwned) {
+    // No-oracle: foreign planId must be indistinguishable (timing AND body)
+    // from a missing one. Run the same cleanup + return the same payload.
+    // The foreign plan is never read or mutated below this point.
+    logger.warn(
+      { actor: userId, planId: parsedPlanId, ownerIdHash: hashOwnerIdForLog(requestedPlan!.user_id), reason: 'foreign_owner' },
+      'training_cancel.ownership_denied',
+    );
+    return buildNoActivePlanResult(userId);
+  }
+
+  if (plans.length === 0) {
+    return buildNoActivePlanResult(userId);
+  }
```

**Route** (`engine/src/api/routes/training-plan-routes.ts`, `/plan/cancel`): the `'forbidden'` → hardcoded-200 branch is now dead. Delete it; `'not_found'` already maps to `200 sendSuccess(result.data)`.

**Caution**: keep the early `foreignOwned` return ABOVE the actual cancel/`deletePlanHard` path. The foreign plan must never reach a mutation. Verify by test.

**Test**: `engine/__tests__/api/training-plan-cancellation.test.ts`. For a caller WITH and WITHOUT a seeded orphan training-marker event: assert a foreign planId and a non-existent planId return byte-identical bodies. Assert `deletePlanHard` not called for foreign. (Timing parity is structural via shared path — no flaky timing assertion needed.)

---

## FIX-3 (P1) — Cancellation active-plan reads omit tenantId

**File**: `engine/src/api/routes/training-plan-cancellation.ts:172,175`. Functions already accept optional `tenantId`; caller doesn't pass it → warn-path fires + SQL stays userId-only.
```ts
-    : (trainingPlans.getActivePlans?.(userId) ?? []).filter((plan) => planTenantMatches(plan, tenantId));
+    : (trainingPlans.getActivePlans?.(userId, tenantId) ?? []).filter((plan) => planTenantMatches(plan, tenantId));
...
-    : trainingPlans.getActivePlan(userId);
+    : trainingPlans.getActivePlan(userId, tenantId);
```
Isolation already held via in-memory filter; this removes log noise + tenant-scopes the SQL. **Test**: existing cancellation suite must stay green; optionally assert no `P0-3 follow-up` warn is logged.

---

## FIX-4 (P1) — Acute injury + high pain score loses acute_injury copy (F9 over-correction)

**File**: `engine/src/services/coach-kernel/safety-wiring.ts:145-150`. The chest-precedence reorder now routes `{injuryStatus:'acute', painScore>=7, painLocation:'ankle'}` → `worsening_localized_pain` (overuse copy) instead of `acute_injury` (traumatic). Both hard-pause; copy-only. Defer to acute_injury inside the pain branch, after the chest check:
```ts
   if (
     typeof signal.painScore === 'number' &&
     signal.painScore >= 7 &&
     painLocation.length > 0
   ) {
     if (painLocation.includes('chest') || painLocation.includes('peito')) {
       return { source: 'structured_intake', triggerType: 'chest_pain' };
     }
+    if (signal.injuryStatus === 'acute') {
+      return { source: 'structured_intake', triggerType: 'acute_injury' };
+    }
     return { source: 'structured_intake', triggerType: 'worsening_localized_pain' };
   }
```
**Test**: `engine/__tests__/services/coach-kernel-safety-wiring.test.ts` — `{injuryStatus:'acute', painScore:9, painLocation:'ankle'}` → `acute_injury`; chest still `chest_pain`; non-acute high-pain non-chest still `worsening_localized_pain`.

---

## FIX-5 (P1, needs product decision) — `injury_safe_swap` dead at its only caller

**File**: `engine/src/api/routes/training-read-models.ts:267`. `adaptDtoSessionForReadiness(...)` called with 2 args → `injuryAffectsSession` undefined → `adaptation-engine.ts:153` swap (`injuryAffectsSession === true`) never fires on the live today-session surface. Moderate injuries get no auto session swap. (Severe injuries still hard-pause — unaffected.)

**Decision needed (ask Felipe):**
- **(a) Wire it**: derive `injuryAffectsSession` from the latest structured-intake injury signal for the user/today (same signal source the safety layer reads) and pass as the 3rd arg at line 267. Add a positive end-to-end test: structured intake `painScore` 4-6 + typed location → today session adapted to `injury_safe_swap`, NOT `pause_training`, NOT no-op.
- **(b) Defer**: add a code comment at the call site + a Feature Delivery Ledger note that injury-aware swap is intentionally not wired on the read-model, so reviewers stop treating it as live.

Default recommendation: (b) document-as-deferred unless product wants moderate-injury auto-swap now. Do not ship a half-wired swap.

---

## FIX-6 (P1) — iOS Garmin-freshness lies "fresh" on a missing marker (F13 over-correction)

**Files**: `Nexus Hub IOS/.../Core/Services/PlanService.swift` + `.../Views/Training/WeeklyPlanView.swift`.
A missing `degraded`/`garmin_stale` now decodes to `false` → green "Garmin fresh" chip on a broken/truncated payload. The new test `PlanCoordinationDecodingTests.swift:214-253` pins this masking default as correct. Backend ALWAYS sends both fields (`weekly-plan-orchestrator.ts:128`, `daily-brief-orchestrator.ts:22`) → absence = real contract break and should fail honestly, not render a healthy lie.

**Preferred fix (minimal, lowest churn)**: make the two honesty-critical markers required again (hard-decode), keep all OTHER resilient decodes (arrays / optional copy stay lenient).

`PlanService.swift` weekly init (`MeshWeeklyPlanResponse`, lines 565,567):
```swift
-            degraded: (try? c.decodeIfPresent(Bool.self, forKey: .degraded)) ?? false,
+            degraded: try c.decode(Bool.self, forKey: .degraded),
...
-            garmin_stale: (try? c.decodeIfPresent(Bool.self, forKey: .garmin_stale)) ?? false,
+            garmin_stale: try c.decode(Bool.self, forKey: .garmin_stale),
```

`PlanService.swift` daily init (`MeshDailyPlanResponse`, lines 626,628):
```swift
-        let degraded = (try? container.decodeIfPresent(Bool.self, forKey: .degraded)) ?? false
+        let degraded = try container.decode(Bool.self, forKey: .degraded)
...
-        let garminStale = (try? container.decodeIfPresent(Bool.self, forKey: .garmin_stale)) ?? false
+        let garminStale = try container.decode(Bool.self, forKey: .garmin_stale)
```
Leave `gated`, `conflicts`, `creativeCopy`, `summary`, `days` lenient — those are genuinely optional-presentation, the resilience win stays.

**Alternative (if product wants to keep rendering the plan on a truncated payload)**: add `let garminStaleKnown: Bool` to both structs (decode `c.contains(.garmin_stale)`), update memberwise inits + fixtures, and in `WeeklyPlanView.swift:671-677` only show the green "Garmin fresh"/"Garmin atual" chip when `garminStaleKnown && !garmin_stale`; hide the Garmin chip when unknown. More churn; choose only if hard-decode's "discard plan on break" is unacceptable.

**Test**: rewrite `PlanCoordinationDecodingTests.test_decodesDailyPlanWithMissingRolloutFieldsAsSafeDefaults` (lines 214-253). Split into two: (1) payload omitting `gated/conflicts/creativeCopy` (but WITH `degraded`+`garmin_stale`) → still decodes with safe defaults; (2) payload omitting `garmin_stale`/`degraded` → `XCTAssertThrowsError` (honest contract enforcement). Remove the `XCTAssertFalse(decoded.garmin_stale)`-on-missing assertion that pins the lie.

---

## FIX-7 (P1, LOW) — iOS remote low-adherence card transient false-negative

**Files**: `.../Views/Training/TrainingHomeContractResolver.swift:72-81` + `.../Views/Training/TrainingCoachViewState.swift:606-611`.
`sanitizedLowAdherenceCard` re-applies the local `weekActiveSessionCount(input.weekSessions) > 0` guard to the REMOTE card. `weekSessions` loads on a separate async task → during the cold-load window it's empty → a backend-validated card is hidden. Self-heals on next render, so LOW.

**Root-cause fix (preferred)**: the local guard exists only because the BACKEND low-adherence builder also false-positives on zero-session weeks (round-1 backend gap, `engine/src/services/.../training-home-view-state.ts:~916`). Fix the backend builder to require scheduled volume > 0 (mirror the iOS `weekActiveSessionCount` logic). Then trust the remote card in iOS: in `sanitizedLowAdherenceCard`, pass the remote `card` through unchanged; keep the `weekActiveSessionCount` guard ONLY on the local `buildLowAdherenceCard` fallback path.

**Minimal alternative**: thread `weekSessionsLoaded: Bool` into `TrainingHomeViewStateInput` (from repository load state) and only apply the `weekActiveSessionCount > 0` guard to the remote card when `weekSessionsLoaded == true`.

Pick one. If neither is worth it now, document as accepted (transient, self-heals).

---

## FIX-8 (P2) — Release-identity still doesn't point at the deployed commit (F17 residual)

Root-cause script fix landed (`scripts/release-identity.sh` `-d`→`-e` for worktree `.git`-as-file). Residuals:
1. Main/workspace `release-identity.json` backend commit = `6f3487cd` (a DUPLICATE sibling "docs(release): close training production promotion" commit) — NOT the documented prod runtime `ddb8eec4`, NOT the docs commit `d5e6332a`. Investigate why two sibling promote commits exist; collapse to one canonical commit.
2. Engine feature-branch (`e758d6ab`) committed copy `docs/_workspace-mirror/docs/release/release-identity.json` is stale (`6d1914a6`/`4.14.198`/186 migrations/dirty).
3. The `-e` fix is absent from the prod artifact `ddb8eec4` (only in `d5e6332a`).

**Actions**: regenerate identity via `cd engine && bash scripts/release-identity.sh --persist` from the ACTUAL deployed worktree; ensure `backend.commit` == the deployed runtime commit (or add an explicit field naming which commit it represents); re-sync the engine mirror; reconcile/remove the duplicate promote commit. Goal: identity provably names the deployed artifact.

---

## FIX-9 (P2) — Engine-worktree release docs deploy-cycle stale

`docs/_workspace-mirror/docs/release/*` (and any engine `docs/release/*` lagging) still state production `4.14.200 @ 30285bb3` / staging `4.14.199`. Reality: prod `4.14.201 @ ddb8eec4`, staging `4.14.200`. Update mirror to match canonical; run `scripts/workspace-docs-mirror.sh`; then `cd engine && npm run docs:audit` (expect baseline warnings only).

---

## FIX-10 (P2) — Pin ACWR shared-boundary classification (F8)

**File**: `engine/__tests__/services/coach-kernel-load-model.test.ts`. Add, under DEFAULT/contiguous thresholds, assertions: `classifyAcwr(1.3)` → `'moderateRisk'`, `classifyAcwr(1.5)` → `'highRisk'` (the round-2 boundary behavior — feeds deload risk scoring, currently untested at the boundary). No source change; lock the intended assignment.

---

## FIX-11 (P2) — Route test for inferred high pain_score staying warning-only (F10)

**File**: `engine/__tests__/api/training-coach-v2-routes.test.ts`. Mirror the positive structured-intake case (~line 841) but with `source='wearable'`, `pain_score=9`, `pain_location='chest'`, `consent_scope='pain'`; assert NO `pause_training` action. Locks the `deriveSafetyTriggerFromSignal` line-120 `!isStructured` early-return at the route boundary.

---

## FIX-12 (P2) — Stale doc comments

- `engine/src/api/routes/training-coach-v2.ts` `resolveOwnedPlan` header (~lines 310-323): rewrite to describe uniform `404` for both missing + foreign (remove the stale "403 FORBIDDEN … status code differs" language the code no longer does). F19.
- iOS two-a-day stale comments claiming default `'optional'` / backend rejects `'auto'` (`TrainingView.swift` prefill area + `TrainingServiceTwoADayPreferenceTests.swift` header): update to `'auto'`.

---

## FIX-13 (P3, INFO) — Migration 199 DB-level test

Migration 199 (`DROP INDEX IF EXISTS idx_training_agenda_ownership_unique`) verified safe by inspection (099's `idx_training_agenda_ownership_unique_tenant` preserves uniqueness). Add a real DB test: apply migrations through 199 on a seeded copy; `PRAGMA index_list(training_agenda_event_ownership)` → old index gone, tenant index present; insert a cross-tenant duplicate (must succeed) + an intra-tenant duplicate (must fail).

---

## FIX-14 (P3, INFO) — WeekProtection "0%" on a zero-session active week

`WeekProtection` "Weekly adherence at 0%" impact line still shows on a zero-scheduled active week (same class as F14, different surface). Apply the same `weekActiveSessionCount > 0` guard to that surface.

---

## Verification (run after each batch, then full at the end)

Backend:
```bash
cd "/Users/felipedominguez/Desktop/Nexus Hub/engine"
npm run typecheck
npx vitest run __tests__/api/training-plan-cancellation.test.ts \
  __tests__/api/training-plan-routes.test.ts \
  __tests__/api/training-coach-v2-routes.test.ts \
  __tests__/services/coach-kernel-safety-wiring.test.ts \
  __tests__/services/coach-kernel-load-model.test.ts
npm run verify   # full: typecheck + science-policy + Vitest
```
iOS:
```bash
cd "/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub"
bash scripts/ios-single-simulator-test.sh \
  -only-testing:"Nexus HubTests/PlanCoordinationDecodingTests" \
  -only-testing:"Nexus HubTests/ModelDecodingTests" \
  -only-testing:"Nexus HubTests/TrainingHomeContractResolverTests" \
  -only-testing:"Nexus HubTests/TrainingServiceTwoADayPreferenceTests"
# then the full helper before push
```
Docs:
```bash
cd "/Users/felipedominguez/Desktop/Nexus Hub" && bash scripts/workspace-docs-mirror.sh
cd engine && npm run docs:audit
```

## Release / branch guidance

- Branch from `main` (prod shipped from `main`). Group as `training_skill_hardening_v3` fast-follow.
- FIX-1 + FIX-2 are live-prod security oracles → after green, bump `4.14.202`, deploy staging, smoke, promote.
- Operator gates UNCHANGED + still open: signed TestFlight/device proof, prod APNs, HealthKit/Apple Watch, Garmin provider-state, two-account device walkthrough. Do not claim these.
- After merge: regenerate release-identity from the deployed worktree (FIX-8) so docs name the real artifact.

## Independent QA re-run (for the next QA agent)

Re-verify FIX-1/FIX-2 are no-oracle: foreign vs missing IDs return identical status+code+message (and, for cancel, identical body for callers with/without seeded orphans). Re-verify FIX-6 test asserts honest-throw on missing freshness marker, not a healthy default. Confirm `release-identity.backend.commit` == deployed runtime commit.
