# Decision Center Logic + Orchestration v2 — hostile QA report

Status: canonical
Owner: workspace lead (Felipe)
Last verified: 2026-05-12
Update policy: append new findings when the v2 branch lands additional commits, or close out items when fixes land. This is the QA companion to `docs/archive/2026-05/decision-center-logic-v2/report.md` (Codex's implementation report).

## Verdict

**READY_FOR_LOCAL_QA**

The v2 quality gate, APNs gate, tenant scope, outcome ledger, and iOS v2-field rendering are real and verifiable. The screenshot-style generic decision is no longer reachable through the v2 entry/list/APNs paths. Follow-up commits closed the original Secretary advisor wiring issue, raw ISO user-facing copy, quality-gate hardening items, and the content-learning tenant-scope proof gap.

## Workspace state

- Engine branch: `feature/decision-center-logic-v2`, HEAD `19f1805c`.
- iOS branch: `feature/decision-center-logic-v2`, HEAD `686a9b6`.
- Production baseline: engine `4.14.154` at `12455c21` on `main`; iOS `1.4.3(17)` at `07a466d` on `main`.
- Engine v2 commits since `12455c21`: 12 (`1c315634` is the foundation; 11 follow-ups Codex did not cover in its report).
- iOS v2 commits since `07a466d`: 4 (`ef39641` renders v2 fields, `349526e` user-scope gate, `d91b3ec` content performance metrics, `686a9b6` keeps action-result evidence visible) — **Codex's earlier report falsely claimed "iOS not touched"**.
- Engine dirty state before QA: 16 untracked staging-smoke evidence files (pre-existing); preserved untouched.
- iOS dirty state before QA: `xcscheme` + `build/` + `docs/agents/` untracked; preserved untouched.

## Executive summary

- Exact generic screenshot issue: **BLOCKED at backend quality gate and APNs gate**. Verified at `src/services/decision-center.ts:371,462` and `src/services/notification-orchestrator.ts:699`.
- Biggest verified improvement: a pure, deterministic decision logic layer (`src/services/decision-center-logic-v2.ts`, 740 LoC) that produces concrete `problemStatement`, `recommendation`, `expectedEffect`, `whatWillChange`, `why`, `urgencyReason`, `safePreviewTitle/Body`, `readBackVerifier`, `automationEligibility`, `autopilotPolicy`, `notificationEligibility`, `collapseKey`, `badgeContribution`, and `qualityScore` per decision.
- Biggest missed issue: CLOSED. Secretary advisor now requires a distinct recommendation and keeps missing-context conflicts internal until enriched.
- Biggest safety/privacy risk: none new. Tenant scope is enforced via `assertScope(userId, tenantId, ...)` at every public function and `WHERE user_id = ? AND tenant_id = ?` at every reader/writer. Outcome ledger feature snapshot is privacy-safe (categorical only).
- Biggest skill-integration gap: closed for this implementation scope. Secretary, Training (race date), Content (approval), Cooking (add meal), Finance (mark paid), Chat (clarification), Sync (retry), overcapacity priority choice, owner/admin ops review, and a generic fallback now have deterministic recipes. Broader production automation remains ask-first or blocked until a verified executor exists.
- Biggest ML-readiness gap: closed for this implementation scope. The outcome ledger schema is privacy-safe and the code now exports a 180-day raw / 730-day aggregate, aggregate-only admin reporting policy. Shadow/eval pipelines remain a future ML product investment, not a launch blocker.
- Safe fixes applied: follow-up commits closed the Secretary advisor wiring, raw ISO copy, quality-gate hardening, content-learning tenant proof gap, overcapacity/owner-admin recipe gaps, and outcome-ledger retention/admin policy gap with focused tests.
- Remaining risk: broader product polish remains around dedicated iOS presentation for every v2 field and full release/device QA, but the 11 hostile QA findings, the follow-up recipe/policy gaps, and the focused Decision Center UI action-result blocker are closed.

## Evidence review (per Codex claim)

| Codex claim | Verdict | Evidence |
|---|---|---|
| Generic screenshot decisions blocked at quality gate | **VERIFIED** | `decision-center-logic-v2.ts:151-162` (10 patterns), `:215-222` (gate checks), `:239-242` (safeToShowUser/safeForHomePreview/safeForAPNs); test `decision-center-logic-v2.test.ts:10-29` passes. E2. |
| Required fields enforced (problemStatement, recommendation, expectedEffect, whySummary, urgencyReason, primaryAction, readBackVerifier, confidence, privacy, …) | **VERIFIED** | `decision-center-logic-v2.ts:195-222`; covered by `decision-center-logic-v2.test.ts:98-114`. E2. |
| Mutating action requires readBackVerifier | **VERIFIED** (with caveat) | Gate at `decision-center-logic-v2.ts:209-211`. Caveat: detection is by a fixed `MUTATING_ACTION_IDS` allowlist (`:138-149`); new mutating action ids would silently bypass. E2. |
| APNs uses safePreview only | **VERIFIED** | `notification-orchestrator.ts:1637-1663` builds quality via `buildDecisionLogicV2`; `:698-701` routes to `in_app_only` when `!decisionQuality.safeForAPNs`; safe titles/bodies from `:1665-1696`. E2 (24 orchestrator tests pass). |
| Pure logic layer is deterministic | **VERIFIED** | `decision-center-logic-v2.ts` has zero IO, no model calls. E1 source. |
| Secretary advisor enriches schedule conflicts | **VERIFIED AFTER FOLLOW-UP** | Advisor logic filters self-move slots, `decision-center.ts` threads candidate/recommended windows from persisted context, and quality fails with `secretaryRecommendation` when no distinct recommendation exists. E2 focused tests. |
| Outcome ledger privacy-safe | **VERIFIED** | `decision-center.ts:2078-2089` records categorical features (`urgency`, `deadlineDistance`, `riskLevel`, `confidence`, `sourceSkill`, `decisionType`, `privacyClassification`, `relatedEntitiesCount`, `optional`, `qualityScore`) — no raw text, no calendar contents, no finance amounts. Schema at `migrations/120_decision_center_logic_v2.sql:26-54`. E1. |
| Handled by Nexus uses safe titles | **VERIFIED** | `decision-center.ts:2050` writes `logic.safePreviewTitle` as the stored title. List query at `:528-538` scoped by `(user_id, tenant_id)`. E1. |
| 10 files / 164 tests PASS | **PARTIAL** | I reproduced 6 of the 10 files: 95/95 PASS. The other 4 files (content-intelligence, content-learning-store, finance tenant-safety, portal-document-routes) are also v2 scope per the classifier output and would have to be re-run to hit Codex's 164 number. E2 (95 verified). |
| iOS not touched | **CONTRADICTED** | 3 iOS commits since `07a466d`. `NotificationDecisionCenterView.swift` +220 LoC renders `recommendationText`, `expectedEffectText`, `impactIfIgnoredText`, `urgencyReasonText`, `previewChanges`, `outcomeText`, `decisionStatusMessage`. `NotificationDecisionCenterTests.swift` +62 LoC + `AppDelegateNotificationScopeTests.swift` +42 LoC. E1 (git log + source read). |
| Skill integration validated for content / Secretary / training / chat / finance / cooking | **PARTIAL** | Recipes exist and are exercised in unit tests. The production call site only enriches Secretary deeply (`decisionContextForRecord` + agenda lookup). Content gets `entityTitle/sourceState` from `getContentWorkflowObject`. Training detects race-date via regex. Cooking/Finance/Chat fall back to base recipes without rich context. E1 + E2. |
| Backend tsc + focused tests + docs:audit pass | **VERIFIED** | `npx tsc --noEmit` exit 0. Focused suite 95/95 pass. `npm run docs:audit` exit 0. |

## Gaps outside Codex's prompt

These are issues the v2 prompt did NOT flag, found during this hostile review:

1. **Secretary advisor degenerate at production wiring** (P1) — CLOSED.
2. **Raw ISO 8601 in user-facing copy** (P1) — CLOSED.
3. **iOS rendering is real but Codex's report claims iOS not touched** (process gap) — CLOSED in report refresh.
4. **`content-learning-store.ts` scope coverage gap** (P2) — CLOSED with dedicated tenant-scope tests and a learned-pattern tenant unique index.
5. **`MUTATING_ACTION_IDS` fixed allowlist** (P2) — CLOSED with explicit `mutating` metadata support.
6. **`rankDecision` omitted-quality APNs default** (P2) — CLOSED.
7. **`title` not subject to `requireConcrete`** (P2) — CLOSED.
8. **Confidence values as magic numbers** (P2) — CLOSED with `DECISION_CONFIDENCE_RUBRIC` and pin tests.
9. **Generic pattern coverage anchored** (P3) — CLOSED with broader known-bad phrase patterns.
10. **Dead `relatedEntityReason` ternaries** (P3) — CLOSED.
11. **`outcomeSummaryForRecord` raw ISO copy** (P3) — CLOSED.

## Findings

### Follow-up closeout — 2026-05-12

Status: **READY_FOR_LOCAL_QA after fixes**. Codex closed all 11 findings in this QA file on `feature/decision-center-logic-v2`.

- QA-DCLV2-001: CLOSED. Secretary production wiring now requires a distinct candidate slot instead of recommending the current window; missing alternatives become `needs_enrichment`.
- QA-DCLV2-002: CLOSED. User-facing Secretary recommendation/problem/effect copy uses human-readable windows rather than raw ISO strings.
- QA-DCLV2-003: CLOSED. The implementation report now acknowledges the existing iOS v2 commits and scopes this follow-up as backend-only.
- QA-DCLV2-004: CLOSED. `content-learning-store` now has same-user/different-tenant tests for scripts, performance summaries, learned patterns, and artifact chains. The learned-pattern store also has a tenant-aware unique index to prevent same-user cross-tenant collisions.
- QA-DCLV2-005: CLOSED. Decision action metadata can explicitly mark `mutating: true`, and the quality gate enforces read-back verification for explicit mutating actions.
- QA-DCLV2-006: CLOSED. `rankDecision` now defaults omitted quality to no Home/APNs eligibility.
- QA-DCLV2-007: CLOSED. The quality gate now requires the enriched title to be concrete.
- QA-DCLV2-008: CLOSED. Secretary outcome summaries use the same human-readable window formatter.
- QA-DCLV2-009: CLOSED. Confidence values are centralized in `DECISION_CONFIDENCE_RUBRIC` and pinned by focused tests.
- QA-DCLV2-010: CLOSED. Generic-copy detection now includes broader known-bad phrases.
- QA-DCLV2-011: CLOSED. Dead `relatedEntityReason: x ? null : null` expressions were removed.

Verification:
- `npx vitest run __tests__/services/decision-center-logic-v2.test.ts __tests__/services/decision-center.test.ts __tests__/services/notification-orchestrator.test.ts __tests__/api/decisions-routes.test.ts __tests__/api/notifications-routes.test.ts __tests__/services/scheduler-user-scope.test.ts __tests__/services/content-learning-store.test.ts --reporter=default` -> 7 files / 136 tests PASS.
- `npx tsc --noEmit` -> PASS.
- iOS focused unit/scope suite -> 13/13 tests PASS. xcresult: `/Users/felipedominguez/Library/Developer/XcodeBuildMCP/workspaces/Nexus-Hub-IOS-08c5774d8857/result-bundles/test_sim_2026-05-12T10-01-54-441Z_pid2834_370d36e2.xcresult`.
- iOS Decision Center UI suite -> 8/8 tests PASS, including fixture action result and visual-matrix action state. xcresult: `/Users/felipedominguez/Library/Developer/XcodeBuildMCP/workspaces/Nexus-Hub-IOS-08c5774d8857/result-bundles/test_sim_2026-05-12T09-55-31-455Z_pid2834_a8a06bdc.xcresult`.
- `npm run docs:audit` -> PASS command execution; 486 current/pre-existing issues.

### QA-DCLV2-001 — Secretary advisor receives only the current slot at production call site

- Severity: **P1**
- File: `src/services/decision-center.ts:1085-1100`
- Confidence: HIGH (read code, walked the data flow, confirmed `feasibleSlots[0] === current` → `alternatives = []` → `recommended = null`)
- Evidence: E1 (source). No production-level test exercises this with a realistic schedule conflict scenario.
- Expected: `availableSlots` includes one or more candidate slots from calendar availability, ideally the recipe-aware feasible windows from `secretary-scheduling-arbitrator.ts` (`compressedSlot`, `reflowed`, etc.).
- Actual: `availableSlots: agenda.startAt && agenda.endAt ? [{ startAt: agenda.startAt, endAt: agenda.endAt, label: 'Proposed slot' }] : []`. The advisor's `alternatives.slice(1, 4)` returns `[]`.
- Impact: The user-facing recommendation collapses to "Use the proposed `<current window>` slot or choose another feasible time" — i.e., recommending the user move the conflicted item to itself. The quality gate still passes because all fields are concrete, so the card reaches the user. This is the exact "decision intelligence" failure the prompt set out to prevent, just at one layer down from where the gate looks.
- Recommendation: Thread the arbitrator's reflow/compress slot output, or compute 2–3 nearby free windows from `unified-calendar`, and pass them as `availableSlots`. Cap at 4 (advisor already does `.slice(1, 4)`).
- Status: CLOSED

### QA-DCLV2-002 — Raw ISO 8601 timestamps in user-facing recommendation copy

- Severity: **P1**
- File: `src/services/decision-center-logic-v2.ts:724-727` (`formatWindow`)
- Confidence: HIGH (read code; verified test fixture at `decision-center-logic-v2.test.ts:54` asserts on `'2026-05-17T08:00:00.000Z'` substring)
- Evidence: E1.
- Expected: User-facing windows should render as "Sun May 17, 8:00–10:00" or similar, localized to the user's timezone.
- Actual: `formatWindow` returns `${startAt} to ${endAt}` — raw `YYYY-MM-DDTHH:mm:ss.sssZ`.
- Impact: Every Secretary-recipe `problemStatement`, `recommendation`, `whatWillChange.effect`, and the outcome summary line bleed raw RFC 3339 into the iOS detail view, which is jarring and dramatically reduces perceived decision quality.
- Recommendation: Add a `formatWindowHuman(start, end, timezone)` helper. The advisor and recipe should use it for user-facing strings; raw ISO can stay in the contract fields (`recommendedStartAt`, `whatWillChange.effect`) only when those are non-user-facing.
- Status: CLOSED

### QA-DCLV2-003 — Codex's report claims "iOS not touched" but 3 iOS commits shipped with v2

- Severity: **P2** (process)
- File: `docs/archive/2026-05/decision-center-logic-v2/report.md:14, 104-108`
- Confidence: HIGH
- Evidence: `git log 07a466d..HEAD` on iOS branch shows 3 commits totaling +721/-19 LoC across 8 files.
- Impact: Closeout artifacts disagree with shipped code. Future agent runs reading the report may under-estimate the iOS surface area.
- Recommendation: Update the report (or re-run a refreshed Codex closeout) to include the iOS surface and tests. Verify the iOS render path for every v2 recipe.
- Status: CLOSED

### QA-DCLV2-004 — `content-learning-store.ts` (792 LoC) is unscoped by Codex's v2 QA

- Severity: **P2**
- File: `src/services/content-learning-store.ts` (new, 792 LoC); `__tests__/services/content-learning-store.test.ts` (74 LoC tests)
- Confidence: MEDIUM (read the module's top 80 LoC and the dedupe path; did not exhaustively audit tenant scope across all functions)
- Evidence: E1.
- Impact: This is the new substrate for "content performance metrics" rendered in iOS commit `d91b3ec`. It handles persisted scripts, performance feedback, learned patterns, artifact chains. Multi-tenant scope helpers (`isUserOwnedContentRow`, `effectiveContentOwnerScope`, `dedupeLearnedPatterns`) exist but require their own adversarial review.
- Recommendation: Dedicated QA pass before broader cohort exposure: assert scope on every public function, no cross-user dedupe, no system-pattern leakage to user accounts.
- Status: CLOSED

### QA-DCLV2-005 — `MUTATING_ACTION_IDS` is a fixed allowlist

- Severity: **P2**
- File: `src/services/decision-center-logic-v2.ts:138-149`
- Confidence: HIGH
- Impact: A future skill that ships a new mutating action id (e.g., `mark_complete`, `confirm_run`, `auto_resolve`) would not trip the `readBackVerifier` requirement — the gate silently allows it.
- Recommendation: Add a `mutating: boolean` flag on `NotificationActionButton` and check `actions.some(a => a.mutating)` instead. Default existing ids to `mutating: true` per the current allowlist as a migration step.
- Status: CLOSED

### QA-DCLV2-006 — `rankDecision`'s `quality?` defaults to APNs-eligible

- Severity: **P2**
- File: `src/services/decision-center-logic-v2.ts:316-331`
- Confidence: HIGH
- Impact: If a caller forgets to pass `quality`, `quality?.safeForAPNs ?? true` makes the decision APNs-eligible by default. Currently the only callers pass quality, but the API allows omission.
- Recommendation: Change default to `false` for both `safeForAPNs` and `safeForHomePreview`. Force callers to opt in.
- Status: CLOSED

### QA-DCLV2-007 — `title` is not subject to `requireConcrete`

- Severity: **P2**
- File: `src/services/decision-center-logic-v2.ts:195-202`
- Confidence: HIGH
- Impact: A recipe could emit `title: 'Test'` and pass the gate (only `safePreviewTitle` is checked). iOS reads `logic.title` and renders it via `formatDecisionItemForApi:903`.
- Recommendation: Add `requireConcrete(recipe.title, 'title', ...)`. Every existing recipe hardcodes a category label so this is a tightening, not a behavior change.
- Status: CLOSED

### QA-DCLV2-008 — `outcomeSummaryForRecord` echoes raw ISO timestamps

- Severity: **P2**
- File: `src/services/decision-center.ts:1118-1124`
- Confidence: HIGH
- Impact: After a Secretary action succeeds, the outcome line reads `"Done — Secretary applied 2026-05-17T08:00:00.000Z to 2026-05-17T10:00:00.000Z and verified the agenda item."`
- Recommendation: Reuse the `formatWindowHuman` helper added for QA-DCLV2-002.
- Status: CLOSED

### QA-DCLV2-009 — Confidence values are magic numbers

- Severity: **P3**
- File: `src/services/decision-center-logic-v2.ts:343-657` (each recipe)
- Confidence: HIGH
- Impact: 14 hardcoded confidence values with no pin tests, no documentation of how they were chosen, no calibration plan. Tuning silently changes which decisions pass `enrichedCopyStillWeak`.
- Recommendation: Document the rubric (what does 0.86 mean? when do you bump to 0.9?). Add a snapshot test that pins each recipe's confidence so changes are visible in diffs.
- Status: CLOSED

### QA-DCLV2-010 — Generic pattern coverage is anchored

- Severity: **P3**
- File: `src/services/decision-center-logic-v2.ts:151-162`
- Confidence: HIGH
- Impact: "Tap to open Nexus", "Please open Nexus", "Open Nexus to review", "needs attention" mid-sentence are not blocked.
- Recommendation: Add unanchored patterns for known-bad sub-phrases ("needs attention", "needs your decision", "open Nexus to" without anchor). Carefully: must NOT block legitimate phrases like the recipe's own `"Open Nexus to review a finance decision."`.
- Status: CLOSED

### QA-DCLV2-011 — Dead `relatedEntityReason: x ? null : null` in 5 recipes

- Severity: **P3** (cosmetic)
- File: `src/services/decision-center-logic-v2.ts:466, 501, 536, 571, 642`
- Confidence: HIGH
- Impact: None at runtime. Signals incomplete logic — the field exists for the case when an entity is missing, but the recipe never populates it. The gate then pushes `relatedEntity` to `missingFields`.
- Recommendation: Either delete the dead expressions or populate a real reason ("workflow id is the affected entity") for cases where `relatedEntityId == null` is acceptable.
- Status: CLOSED

## Phase-by-phase results

### Phase 1 — Decision Quality Gate QA

- Generic blocked: ✅ `decision-center-logic-v2.test.ts:10-29` proves `"Secretary"` + `"Secretary needs your attention…open Nexus to view details"` → `status: 'needs_enrichment'`, `safeToShowUser: false`.
- Concrete passes: ✅ `decision-center-logic-v2.test.ts:31-61` proves a real long-run conflict passes with `problemStatement`, `recommendation`, `expectedEffect`, `why.facts`, `whatWillChange[0].targetSkill === 'secretary'`.
- Missing fields: ✅ `decision-center-logic-v2.test.ts:98-114` proves `privacyClassification: undefined` + `accept_reflow` action → `missingFields` includes `readBackVerifier`, `privacyClassification`.
- Findings: QA-DCLV2-005, QA-DCLV2-007, QA-DCLV2-010.

### Phase 2 — Decision Enrichment QA

- problemStatement / recommendation / expectedEffect / impactIfIgnored / why / whatWillChange all populated per recipe. ✅
- Confidence: hardcoded per recipe (see QA-DCLV2-009).
- automationEligibility: derived (`ask_first` for risky, `safe_auto_handle` for retry, `never` for default).
- Findings: QA-DCLV2-002, QA-DCLV2-008, QA-DCLV2-009, QA-DCLV2-011.

### Phase 3 — Secretary Decision Advisor QA

- Advisor logic in isolation: ✅ `decision-center-logic-v2.test.ts:116-139` covers feasible-slot and missing-slot cases.
- Production wiring: ❌ Single-slot input means alternatives are always empty (see QA-DCLV2-001).
- Overcapacity / multi-skill timing conflicts: NOT covered by a recipe or a test. The advisor accepts `reasonCodes` including `overcapacity` but the recipe's `capacityImpact` line only triggers when overcapacity is supplied. Production call site at `:1090` passes `agenda.decisionReasonCodes` — verify that the secretary arbitrator actually sets that reason code (out of scope for this QA).
- Findings: QA-DCLV2-001.

### Phase 4 — Decision Contract v2 fields QA

- All required fields exposed via `DecisionApiItem` at `decision-center.ts:890-952`. ✅
- Home uses `safePreviewTitle`/`safePreviewBody` via `getDecisionSummary:515-516`. ✅
- iOS detail view renders all expected sections (Phase 13). ✅
- Findings: none net new.

### Phase 5 — Action preview QA

- `whatWillChange: DecisionWhatWillChange[]` populated per recipe with `item`, `effect`, `targetSkill`, `verificationMethod`. ✅
- High-risk default: `ask_first` for `accept_reflow`, `approve_script`, `request_rewrite`, `mark_paid`, `add_meal` (see `evaluateAutopilotPolicy:303-305`). ✅
- Findings: none net new (but the `effect` text bleeds raw ISO when it includes the window — see QA-DCLV2-002).

### Phase 6 — Read-back verification QA

- Mutating action without `readBackVerifier` → blocked at gate (`:209-211`). ✅
- `readBackVerifier` strings per recipe: `secretary_agenda_item_state`, `content_workflow_object_approval_state`, `training_state`, `meal_plan_state`, `finance_state`, `chat_pending_confirmation_store`, `provider_sync_state`. ✅
- Production read-back path: `decision-center.test.ts` covers Secretary reflow/undo, content success, finance/cooking/chat actions, duplicate idempotency, read-back mismatch — 25 tests pass.
- Findings: none net new (allowlist concern captured at QA-DCLV2-005).

### Phase 7 — Handled by Nexus QA

- Table at `migrations/120_decision_center_logic_v2.sql:6-21`, scoped index `:23-24`. ✅
- `listHandledByNexusItems:528-538` filters `WHERE user_id = ? AND tenant_id = ?`. ✅
- Title stored is `logic.safePreviewTitle` (`:2050`). ✅
- Stale-source supersession path at `:2020-2026` records a row and emits an outcome ledger entry.
- Findings: none net new (iOS rendering of Handled by Nexus is API-ready but iOS commits don't yet render a dedicated section — Codex's report flagged this as P2 follow-up).

### Phase 8 — Autopilot Policy QA

- Levels: `never`, `ask_first`, `safe_auto_handle`, `user_opt_in_required` (`decision-center-logic-v2.ts:12`). ✅
- Risky actions ask first: ✅ verified by `decision-center-logic-v2.test.ts:165-192`.
- Sync retry safely auto-handles: ✅ same test.
- Findings: none net new.

### Phase 9 — Ranking + fatigue + APNs QA

- `rankDecision` urgency curve: 100/90/65/20 + deadline boost 12 + risk boost up to 18 − confidence penalty up to 15 − quality penalty 40. Threshold 82 for APNs, 55 for home preview. ✅
- Optional decisions excluded from APNs: ✅ `decision-center-logic-v2.test.ts:194-252`.
- Quality penalty 40 effectively kicks all unsafe-to-show decisions below the APNs threshold. ✅
- Findings: QA-DCLV2-006.

### Phase 10 — Skill recipes QA

- Secretary: ✅ recipe + context enrichment from `getSecretaryAgendaItemById` + `adviseSecretaryDecision` (but degenerate, see QA-DCLV2-001).
- Training: ✅ race-date recipe.
- Content: ✅ workflow-object lookup.
- Cooking: ✅ recipe with `meal_plan_state` verifier.
- Finance: ✅ recipe with privacy-safe preview.
- Chat: ✅ recipe routes ambiguous clarifications through Decision API.
- Sync: ✅ retry recipe is `safe_auto_handle`.
- Owner / Admin: ✅ owner/admin ops review recipe is scoped to `system_admin`/admin visibility and never auto-handles by default.
- Findings: QA-DCLV2-001.

### Phase 11 — Outcome ledger and ML readiness QA

- Schema: `migrations/120_decision_center_logic_v2.sql:26-54`. Tenant-scoped index `:53-54`. ✅
- Feature snapshot at `decision-center.ts:2078-2089` — only categorical / numeric features, no raw payload. ✅
- Future ML plan: deterministic first, offline shadow eval; no auto-handle for risky actions. ✅ per Codex report.
- Retention / admin reporting: ✅ documented in code as `DECISION_OUTCOME_LEDGER_RETENTION_POLICY` (180-day raw outcomes, 730-day aggregate retention, aggregate-only admin reporting, no raw private text).
- Findings: none net new.

### Phase 12 — APNs fatigue and privacy QA

- Quality gate blocks visible push when `safeForAPNs === false` (`notification-orchestrator.ts:699-701`). ✅
- Privacy-safe titles/bodies from `safeNotificationTitle:1684-1696` and `buildPrivacySafeBody:1665-1682`. ✅
- Push rate limit: present (`:702`).
- Findings: none net new.

### Phase 13 — iOS display QA

- iOS WAS touched (3 commits, 220 LoC view changes, 104 LoC test changes).
- `NotificationDecisionCenterView.swift:685-724` renders `recommendation`, `expectedEffect`, `impactIfIgnored`, `urgencyReason`. ✅
- `NotificationDecisionCenterView.swift:694-706` renders `previewChanges` (whatWillChange) or falls back to `expectedEffect`. ✅
- `NotificationDecisionCenterView.swift:726-729` includes `DecisionWhyStructuredSection` (the structured why panel). ✅
- `NotificationDecisionCenterView.swift:731-743` shows `decisionStatusMessage` and `outcomeText`.
- iOS tests cover decoding of v2 fields with curated fixtures. The fixtures use human-readable timestamps ("Move the long run to Sunday at 08:00.") which **does not match** what the production recipe emits (raw ISO). See QA-DCLV2-002.
- Findings: QA-DCLV2-002 (consequence), QA-DCLV2-003 (process).

### Phase 14 — End-to-end scenario QA (source-level)

| Scenario | Result | Evidence |
|---|---|---|
| Training long-run conflict | Recipe produces concrete card, but recommendation contains raw ISO and degenerate slot | QA-DCLV2-001 + 002 |
| Training missing race date | ✅ concrete recipe, race-date specific action | `decision-center-logic-v2.test.ts:82-96` |
| Content approval | ✅ concrete recipe, safe preview, no entity title leak | `decision-center-logic-v2.test.ts:63-80` |
| Overcapacity week | ✅ deterministic "choose priority" recipe; ask-first, Secretary-scoped, read-back required for mutating choice | `decision-center-logic-v2.test.ts` |
| Calendar sync issue | ✅ retry recipe is `safe_auto_handle` | `decision-center-logic-v2.test.ts:141-163` |
| Chat ambiguity | ✅ chat recipe with `chat_pending_confirmation_store` verifier | recipe at `:559-592` |
| Finance reminder | ✅ privacy-safe preview | recipe at `:489-522` |
| Cooking add meal | ✅ low-risk by default, `ask_first` | recipe at `:524-557` |
| Owner / admin scan | ✅ owner/admin ops recipe; scoped review only, no auto-handle | `decision-center-logic-v2.test.ts` |
| Generic incomplete decision | ✅ blocked or `needs_enrichment` | `decision-center-logic-v2.test.ts:10-29` |

### Phase 15 — Test quality review

- ✅ Tests assert on behavior, not shape (e.g., they check `problemStatement.toContain('Saturday long run')`, not just type).
- ✅ Generic screenshot regression test exists (`:10-29`).
- ❌ No test exists for the Secretary production-call-site degenerate. The advisor test feeds it 2 slots directly; no test wires it through `secretaryAgendaDecisionContext`.
- ✅ Two-user / tenant coverage exists in `decision-center.test.ts` and `scheduler-user-scope.test.ts` (17 tests).
- ✅ Read-back mismatch / partial failure / duplicate idempotency in `decision-center.test.ts`.
- ❌ No test pins the recipe-emitted recommendation copy for raw-ISO regression.
- ❌ No iOS UI test asserts that `recommendation` containing raw ISO is rejected at render time.

### Phase 16 — Gap search beyond Codex and ChatGPT

See "Gaps outside Codex's prompt" above for the full list. Highlights not yet covered above:

- The portal redaction commit `cb5fd928 fix(portal): redact decision center titles` is a post-report fix Codex's report does not describe. Worth verifying that the portal admin view does not surface raw entity titles to a non-owner admin.
- The scheduler change `19f1805c fix(scheduler): route training cron alerts through notifications` and `a71367e5 fix(scheduler): deliver shared list notifications in app` widen the surface that emits decision-shaped notifications. Both should be re-validated to ensure they go through the v2 quality gate.
- `645d5cf9 fix(decisions): require explicit user action flag` — verify the new requirement doesn't silently drop legitimate creator flows.
- The `9e60f26e fix(notifications): reject repeated actioned items` is an idempotency fix; verify it doesn't break legitimate retry flows.

## Tests run

- Backend tsc: `cd engine && npx tsc --noEmit` → **PASS** (exit 0). E0.
- Backend focused vitest (Decision Center slice): 6 files / **95 tests PASS** in 844ms. Files: `decision-center-logic-v2`, `decision-center`, `notification-orchestrator`, `decisions-routes`, `notifications-routes`, `scheduler-user-scope`. E2.
- Backend docs: `npm run docs:audit` → **PASS** (exit 0); pre-existing warnings unchanged. E0.
- Backend full v2 slice (per classifier): would also include `content-intelligence-detail.test.ts`, `content-intelligence-routes.test.ts`, `content-learning-store.test.ts`, `portal-document-routes.test.ts`, `portal-notifications-ui.test.ts`, `finance-collector-tenant-safety.test.ts`, `readiness-scorer.test.ts`, and the security `notification-orchestrator-security.test.ts`. Not re-run in this pass — Codex's claimed 164 number is unverified by me but the focused 95 cover the decision center logic, orchestrator gate, and routes.
- iOS: focused simulator suite PASS, 13/13 tests, `NotificationDecisionCenterTests` + `RepositoryScopeIsolationTests`, iPhone 17 Pro. xcresult: `/Users/felipedominguez/Library/Developer/XcodeBuildMCP/workspaces/Nexus-Hub-IOS-08c5774d8857/result-bundles/test_sim_2026-05-12T10-01-54-441Z_pid2834_370d36e2.xcresult`. E2.
- iOS Decision Center UI suite PASS, 8/8 tests, `NotificationDecisionCenterUITests`, iPhone 17 Pro. This closes the fixture action-result visibility gap found after the backend QA closeout. xcresult: `/Users/felipedominguez/Library/Developer/XcodeBuildMCP/workspaces/Nexus-Hub-IOS-08c5774d8857/result-bundles/test_sim_2026-05-12T09-55-31-455Z_pid2834_a8a06bdc.xcresult`. E2.
- Smoke / staging / device / APNs: NOT RUN — feature branch, no deploy.

Confidence impact of not running the remaining test files: LOW — they cover content learning, portal UI, finance tenant safety, and security redaction. None of those are core to the v2 quality / advisor / APNs path the prompt asked me to validate. They should be re-run before any cohort exposure of the content performance metrics surface (QA-DCLV2-004).

## Safe fixes applied

Follow-up commits closed the source findings. Notable fixes: Secretary recommendation wiring, human-readable window formatting, explicit mutating action metadata, safer Home/APNs ranking defaults, concrete title enforcement, broader generic-copy detection, centralized confidence rubric, and tenant-scoped content-learning pattern uniqueness.

## Cleanup status

- Services started: only short-lived `npx tsc`, `npx vitest run`, and `npm run docs:audit`. All completed.
- Local backend: not started.
- Content engine: not started.
- Workers / queues / DBs / tunnels / provider loops: not started.
- Simulators: not started.
- Ports: 8200 / 8201 / 8203 — not touched.
- Orphan process check: only the parent agent process from this session.

## Conditions for promotion

This branch is **READY_FOR_LOCAL_QA** for the Decision Center Logic v2 QA scope. Broader cohort exposure still needs the normal release gates: focused/full backend verification as selected by the classifier, staging smoke if deployed, and iOS simulator/device validation for the v2 render path.

Final recommendation: run local QA against the API payloads and iOS v2 rendering, then use the standard staging gate before any production promote.

## Prompt / process improvements

For the next round (v3 or follow-up polish):

- **The QA prompt should require the QA agent to read `git log <prod>..HEAD` for BOTH engine and iOS branches** at Phase 0. Codex's report claimed iOS untouched; only checking the iOS git log revealed otherwise.
- **The implementation prompt should require Codex to re-publish the report after follow-up commits** rather than leaving a stale Phase-0-of-v2 report when 11 follow-up engine commits land.
- **The unit tests pass concrete fixtures but the production recipe input is degenerate.** Add a "production wiring test" pattern: given a real agenda item with no candidate slots, what does the advisor produce? A unit test that wires through `secretaryAgendaDecisionContext` end-to-end would have caught QA-DCLV2-001.
- **Add a screenshot/snapshot test for recipe output strings** so raw ISO regressions are visible in the diff.
- **Add a release classifier rule** requiring the changed-area classifier output (`scripts/changed-area-classifier.sh`) to be cross-referenced against the implementation report's "files touched" section — they should agree.
- **For multi-skill prompts, require the report to enumerate which recipes were updated and which were NOT.** Codex's report bundles "skill integration: IMPLEMENTED_AND_VALIDATED" without distinguishing recipe coverage from production wiring coverage.

## References

- Implementation report: `docs/archive/2026-05/decision-center-logic-v2/report.md`
- Codex's earlier Decision Center rounds: `docs/release/decision-center-orchestration-apns-qa.md`, `docs/release/decision-center-orchestration-apns-qa-round-d-followup.md`, `docs/release/decision-center-orchestration-apns-qa-round-d-prime.md`
- Engine source: `engine/src/services/decision-center-logic-v2.ts`, `engine/src/services/decision-center.ts`, `engine/src/services/notification-orchestrator.ts`
- Migrations: `engine/migrations/120_decision_center_logic_v2.sql`, `engine/migrations/121_decision_intent_context.sql`, `engine/migrations/122_content_learned_patterns_tenant_unique.sql`
- iOS source: `ios/Nexus Hub/Views/Inbox/NotificationDecisionCenterView.swift`, `ios/Nexus Hub/Core/AppDelegate.swift`
- iOS tests: `ios/Nexus HubTests/NotificationDecisionCenterTests.swift`, `ios/Nexus HubTests/AppDelegateNotificationScopeTests.swift`, `ios/Nexus HubTests/ModelDecodingTests.swift`

---

## Round 2 hostile QA — 2026-05-12 (post Codex closeout)

Date: 2026-05-12
Reviewer: Claude (opus, max effort)
Scope: validate Codex's 2 new commits (`c4959e70`, `456b9d8b`) that claim to close all 11 R1 findings; look for new issues introduced by the fixes.

### Round 2 verdict

**READY_WITH_CONDITIONS** (Codex's edited verdict of `READY_FOR_LOCAL_QA` is acceptable for Wave 1 but understates two real production-broadening risks introduced by the fixes themselves.)

For the **Wave 1 cohort** (Felipe + Jaqueline, both in Lisbon), the v2 branch is ready for local QA. The 11 R1 findings are legitimately closed at source + test level. For **broader cohort exposure** (other timezones, more upstream emitters), two new P-level items below need to land first.

### Round 2 commits inspected

- `c4959e70 fix(decisions): close logic v2 QA gaps` — 8 files, +475/-68 LoC. Centralizes `formatDecisionWindow`, `DECISION_CONFIDENCE_RUBRIC`, `isMutatingAction`, default-false `rankDecision`, `requireConcrete(title)`, broader generic patterns, migration 122, content-learning-store tenant tests.
- `456b9d8b fix(decisions): require concrete secretary recommendations` — 2 files, +44/-1 LoC. New `requiresSecretaryRecommendation` + `hasDistinctSecretaryRecommendation` guard, advisor `sameWindow` self-move filter, advisor returns `recommendedStartAt/End`.

### R1 closure verification

| ID | Claim | Verdict | Evidence |
|---|---|---|---|
| 001 | Secretary advisor wiring | **CONFIRMED CLOSED** | `decision-center-logic-v2.ts:253-255` (new gate), `:281-340` (advisor `sameWindow` filter at `:285`), `decision-center.ts:1099-1120` (`secretaryCandidateSlots` sources from `supplied.candidateSlots` / `supplied.recommendedStartAt/End` / `agenda.scheduledSegments` / fallback current). Test at `decision-center-logic-v2.test.ts:31-49` + `:164-178`. E2. |
| 002 | Raw ISO in user copy | **CONFIRMED CLOSED at the formatter level** | `formatDecisionWindow:792-815` uses `Intl.DateTimeFormat`. Used at `secretaryRecipe:404,405`, `outcomeSummaryForRecord:1141`, advisor. **Caveat: see R2-NEW-001 — no production caller threads the user's timezone.** E1. |
| 003 | iOS not-touched claim | **CONFIRMED CLOSED** | Report and closeout now scope this as backend-only follow-up. E1. |
| 004 | content-learning-store tenant scope | **CONFIRMED CLOSED** | 31 tests in `content-learning-store.test.ts` including 8 explicit tenant-scope tests (lines 146, 155, 259, 271, 348, 437, 448, 584). Migration 122 adds tenant-aware unique index. E2. |
| 005 | mutating allowlist | **CONFIRMED CLOSED** | `NotificationActionButton.mutating?: boolean` (`notification-orchestrator.ts:75`), `isMutatingAction` checks flag OR allowlist (`decision-center-logic-v2.ts:744-746`). Test at `:294-309`. E2. |
| 006 | rankDecision APNs default | **CONFIRMED CLOSED** | `:374-376` defaults to `false`. Test at `:311-330`. E2. |
| 007 | title not requireConcrete | **CONFIRMED CLOSED** | `:224` adds `requireConcrete(recipe.title, …)`. Test at `:332-347`. E2. |
| 008 | outcome ISO copy | **CONFIRMED CLOSED** | `:1141` uses `formatDecisionWindow(startAt, endAt, record.decisionContext?.timezone)`. E1. |
| 009 | confidence magic numbers | **CONFIRMED CLOSED** | `DECISION_CONFIDENCE_RUBRIC` (`:173-189`) with 15 named tiers. All recipes use named values. Pin test at `:349-388` covers content (0.88), chat (0.82), sync (0.78). E2. |
| 010 | generic pattern coverage | **CONFIRMED CLOSED** | `:165-170` adds `/^decision details unavailable$/i` + 3 unanchored `\b…\b` patterns. E1. |
| 011 | dead `relatedEntityReason` | **PARTIALLY CLOSED** | Content/finance/cooking/chat/generic recipes all replaced with plain `null`. **BUT** `genericRecipe:697` still has `readBackVerifier: input.actions.some(isMutatingAction) ? null : null` — both branches return null, still dead. See R2-NEW-005. |

### New findings introduced by the R1 fixes

#### R2-NEW-001 — `formatDecisionWindow` defaults to `'Europe/Lisbon'`; no production caller threads user timezone

- Severity: **P2** (blocks broader cohort; not a Wave 1 blocker)
- File: `src/services/decision-center-logic-v2.ts:794` (`const zone = timezone || 'Europe/Lisbon';`)
- Confidence: HIGH (verified by `grep` across `src/` for callers populating `decisionContext.timezone`; only the formatter itself reads it)
- Evidence: E1.
- Walk:
  - `createDecisionIntent` is called from `decisions.ts:93` (`...req.body` pass-through, no enforced timezone) and `chat-message-routes.ts:363, 493` (explicitly constructed input, **no `decisionContext.timezone`** set).
  - `decision-center.ts:1027-1044` (`decisionContextForIntentInput`) and `:1046-1072` (`decisionContextForRecord`) build context from agenda/state — they do not call `getUserTimezone(userId)`.
  - Infrastructure exists: `domains/secretary.ts:160`, `api/routes/tasks.ts:210/327/467/559`, `services/task-store/task-router.ts:228/462`, `services/secretary-fastpath.ts:423/553/624/687` all call `getUserTimezone(...)`.
- Impact: every Secretary decision's `problemStatement`, `recommendation`, `whatWillChange.effect`, advisor output, and outcome summary renders times in `Europe/Lisbon` regardless of where the user lives. A user in NYC sees their 14:00 NYC long run as "Sat May 16, 19:00-21:00 Lisbon time" — wrong by 5 hours. Could cause missed appointments.
- Recommendation: In `decisionContextForIntentInput`/`decisionContextForRecord`, default `timezone` to `getUserTimezone(record.userId)` when not supplied. Adjust the two `createDecisionIntent` callers to pass timezone explicitly. Add a test where two users in different timezones get different `recommendation` strings for the same conflict.
- Status: CLOSED. `decision-center.ts` now derives user timezone/locale from a real `users` row when caller context does not provide it, and `decision-center.test.ts` proves the same persisted Secretary alternative renders in `America/New_York` instead of Lisbon time.

#### R2-NEW-002 — `Intl.DateTimeFormat` locale fixed to `'en-US'` regardless of user locale

- Severity: **P3** (i18n consistency)
- File: `src/services/decision-center-logic-v2.ts:797, 803`
- Confidence: HIGH
- Evidence: E1.
- Impact: PT-locale iOS users (the L10n.isPT view path) get "Sat May 16, 08:00-10:00" in English inside an otherwise Portuguese UI. Mixed-locale UX.
- Recommendation: Accept `locale` alongside `timezone` in `DecisionLogicContext`, or use `Intl.DateTimeFormat(undefined, …)` to inherit from the runtime (but on server, runtime is `en-US`). Best: thread `getUserLocale(userId)` parallel to `getUserTimezone(userId)`.
- Status: CLOSED. `DecisionLogicContext` now carries optional `locale`; `formatDecisionWindow` accepts it; Decision Center context defaults derive the saved user language when available.

#### R2-NEW-003 — `Intl.DateTimeFormat` instantiated per call in hot list path

- Severity: **P3** (perf hygiene)
- File: `src/services/decision-center-logic-v2.ts:797-808`
- Confidence: MEDIUM (no benchmark; based on general Intl performance characteristics)
- Evidence: E0.
- Impact: `listDecisionItems` returns up to 80 items; each goes through `formatDecisionItemForApi` → `decisionLogicForRecord` → recipe → `formatDecisionWindow` × 2-3. That's 160-480 `Intl.DateTimeFormat` constructions per call. Construction is ~10× slower than reuse.
- Recommendation: cache formatters keyed by `(locale, timezone, fields)` at module scope. Or move format into a memoized helper.
- Status: CLOSED. `decision-center-logic-v2.ts` now caches `Intl.DateTimeFormat` instances by `(locale, timezone, kind)` instead of constructing formatters for every list item.

#### R2-NEW-004 — `DECISION_QUALITY_REQUIRED_FIELD_COUNT = 14` is wrong; there are 17 possible missing-field labels

- Severity: **P3** (score normalization imprecise; not a behavior change)
- File: `src/services/decision-center-logic-v2.ts:191, 257-258`
- Confidence: HIGH (counted by hand)
- Evidence: E1.
- Walk: gate emits up to 17 distinct labels (`title`, `problemStatement`, `recommendation`, `expectedEffect`, `whySummary`, `urgencyReason`, `sourceSkill`, `type`, `primaryActionLabel`, `privacyClassification`, `primaryAction`, `relatedEntity`, `readBackVerifier`, `confidence`, `concreteCopy`, `concretePrimaryActionLabel`, `secretaryRecommendation`).
- Impact: `qualityScore` is computed as `(14 - missingFields.length) / 14 * 100`. With 17 possible, the maximum miss is 17, which produces a `−21%` clamped to 0. The score is mostly OK in the common case (0-2 missing fields) but the rubric of "out of 14" is wrong.
- Recommendation: set constant to 17 (or compute dynamically as `numericFloor + recipe.confidence-derived`), or document the rationale for 14.
- Status: CLOSED. `DECISION_QUALITY_REQUIRED_FIELD_COUNT` is now 17, matching the gate's emitted labels; `decision-center-logic-v2.test.ts` pins the corrected generic-decision score.

#### R2-NEW-005 — One dead `readBackVerifier` ternary remains in `genericRecipe` (QA-DCLV2-011 incompletely closed)

- Severity: **P3** (cosmetic; report-vs-source mismatch)
- File: `src/services/decision-center-logic-v2.ts:697`
- Code: `readBackVerifier: input.actions.some(isMutatingAction) ? null : null,`
- Confidence: HIGH
- Evidence: E1.
- Impact: None at runtime. But the closeout claim "QA-DCLV2-011: CLOSED. Dead `relatedEntityReason: x ? null : null` expressions were removed." is inaccurate — this line is the moral equivalent in a different field and is still dead. Process gap: closeout text is one line ahead of source again.
- Recommendation: replace with `readBackVerifier: null,` and update the closeout claim wording to scope only `relatedEntityReason` (or fix both).
- Status: CLOSED. The remaining dead `readBackVerifier: x ? null : null` expressions in owner/admin and generic recipes were replaced with plain `null`.

#### R2-NEW-006 — Migration 122 has no duplicate-cleanup step before CREATE UNIQUE INDEX

- Severity: **P2** (deploy-time risk)
- File: `migrations/122_content_learned_patterns_tenant_unique.sql`
- Confidence: MEDIUM (depends on whether duplicate data exists in production)
- Evidence: E1.
- Walk: migration drops the legacy `idx_learned_patterns_unique` (keyed on `(category, pattern_text, user_id)`) and creates a new unique index on `(COALESCE(tenant_id, CASE WHEN user_id > 0 THEN user_id ELSE 0 END), COALESCE(owner_user_id, user_id, 0), category, pattern_text)`. If existing rows have duplicate (effective tenant, effective owner, category, pattern_text) tuples — for example because an early row had `tenant_id=null, user_id=5, owner_user_id=null` and a later row has `tenant_id=5, user_id=5, owner_user_id=5` — the `CREATE UNIQUE INDEX IF NOT EXISTS` will FAIL at deploy.
- Impact: deploy break. Easy to detect in staging but easy to miss if staging has no duplicates and prod does.
- Recommendation: add a pre-create DELETE that keeps one row per `(effective_tenant, effective_owner, category, pattern_text)` (deduplicating by `created_at DESC` or `frequency DESC`). Or run a staging pre-flight query that counts violations and fails the migration with a clear message.
- Status: CLOSED. Migration 122 now deletes duplicate effective `(tenant, owner, category, pattern_text)` rows before creating the tenant-aware unique index; `content-learning-store.test.ts` seeds a collision and proves the index can be created.

#### R2-NEW-007 — Upstream emitters do not populate `decisionContext.candidateSlots` or `agenda.scheduledSegments`; Secretary brain will be silent in production

- Severity: **P1** (defeats the v2 "brain" claim in production)
- File: `src/services/decision-center.ts:1099-1120` (`secretaryCandidateSlots`)
- Confidence: MEDIUM (read the new code path; have not traced every Secretary creator)
- Evidence: E1.
- Walk:
  - `secretaryCandidateSlots` sources candidate slots from four places (in order):
    1. `supplied.candidateSlots` — **no production caller populates this**
    2. `supplied.recommendedStartAt/End` — **no production caller populates this**
    3. `agenda.scheduledSegments` — does the Secretary scheduler write these? Out of scope; needs verification.
    4. `agenda.startAt/agenda.endAt` (fallback) — filtered out by advisor's new `sameWindow` self-move guard.
  - If sources 1-3 are empty, only the current slot survives, which is then filtered out → `feasibleSlots = []` → advisor returns `feasibility: 'needs_enrichment'` → `recommendedStartAt: null` → gate pushes `secretaryRecommendation` → `status: 'needs_enrichment'` → `safeToShowUser: false` → user sees nothing.
- Impact: the QA-DCLV2-001 fix prevents misleading recommendations, but if upstream production emitters never populate alternatives, users will receive ZERO Secretary cards even for real conflicts. Silent regression: critical schedule conflicts disappear from Decision Center.
- Recommendation: identify every production caller that emits a Secretary conflict decision (likely Secretary scheduler / arbitrator cron, possibly `unified-calendar` conflict watcher). For each, ensure it computes 2-4 candidate alternative slots and passes them via `decisionContext.candidateSlots`, or that the persisted `secretary_agenda_items.scheduledSegments` contains feasible alternatives. Add a production-wiring integration test: create an agenda item with NO scheduledSegments, no candidateSlots → confirm the gate emits `secretaryRecommendation` to missing fields (already tested) AND confirm that the production scheduler PATH supplies candidates in real use (NEEDED, not yet covered).
- Status: CLOSED. `secretary-scheduling-arbitrator.ts` now persists the selected slot plus alternative slots into `scheduled_segments_json`, `decisionFromExisting` returns persisted alternatives, `notification-orchestrator.ts` preserves supplied candidate slots/reason codes/timezone/locale in `decision_context_json`, and `decision-center.test.ts` proves a production-style persisted agenda item produces a concrete, user-timezone recommendation.

### Round 3 close-out verification

- `npx tsc --noEmit` → **PASS** (exit 0).
- Focused backend suite: 5 files / **112 tests PASS** in 8.68 s. Files: `decision-center-logic-v2`, `decision-center`, `notification-orchestrator`, `secretary-scheduling-arbitrator`, `content-learning-store`. E2.
- New tests verified by name:
  - `derives Secretary recommendations from persisted alternatives using the user timezone` — pins R2-NEW-007 and R2-NEW-001.
  - `persists selected and alternative candidate slots for Decision Center enrichment` — pins upstream Secretary candidate persistence.
  - `persists Decision Center context slots, timezone, locale, and reason codes for downstream enrichment` — pins notification intent context normalization.
  - `formats decision windows with caller timezone and locale using cached Intl formatters` — pins R2-NEW-002 and R2-NEW-003.
  - `migration 122 removes colliding learned-pattern duplicates before creating the tenant unique index` — pins R2-NEW-006.
- `npm run docs:audit` → **PASS**, 486 current warnings (pre-existing canonical-doc/mirror warnings; no new fatal error class observed).

### Round 2 verification

- `npx tsc --noEmit` → **PASS** (exit 0).
- Focused vitest suite (7 files Codex claimed): 7 files / **133 tests PASS** in 8.32 s. Files: `decision-center-logic-v2`, `decision-center`, `notification-orchestrator`, `decisions-routes`, `notifications-routes`, `scheduler-user-scope`, `content-learning-store`. E2. (Codex's report said 132; the extra came from the `456b9d8b` advisor follow-up test.)
- New tests verified by name:
  - `blocks Secretary conflicts without a distinct recommendation even when raw copy is specific` — pins QA-DCLV2-001 fix.
  - `Secretary advisor refuses self-move slots that match the current window` — pins the `sameWindow` filter.
  - `requires explicit mutating actions to declare read-back verification even for unknown action ids` — pins QA-DCLV2-005 fix.
  - `defaults rankDecision to no Home/APNs eligibility when quality is omitted` — pins QA-DCLV2-006 fix.
  - `rejects generic titles even when the body is otherwise concrete` — pins QA-DCLV2-007 fix.
  - `pins recipe confidence tiers so tuning is visible in review` — pins QA-DCLV2-009 rubric.
  - `content-learning-store` 8 tenant-scope tests — pin QA-DCLV2-004 isolation.
- `npm run docs:audit` — not re-run; pre-existing warnings unchanged per Codex's claim.

### Round 2 cleanup status

- Services: only short-lived `npx tsc`, `npx vitest run`. All completed.
- Local backend / DBs / tunnels / simulators: none started.
- Ports 8200 / 8201 / 8203: clear.
- No background jobs left running.

### Conditions for Wave-2 / broader-cohort promotion

The Round 2 open items are now closed in the backend follow-up. Broader cohort or staging/production promotion still requires the normal release gates (classifier-selected focused/full verification, staging smoke if deploying, and device/iOS QA), but there are no remaining R2-specific open implementation tasks in this document.

### Round 3 prompt status

The proposed Round 3 work is now superseded by the close-out verification above. No active Round 3 implementation prompt remains open in this QA document.

### Round 2 prompt / process improvements

- **Verify each "CLOSED" claim against source before accepting.** Round 2 found one false-close (R2-NEW-005) by simply re-reading the file. Closeout-vs-source-truth gap, again.
- **Trace fixes through to production wiring.** The R1 advisor fix is mathematically correct but R2-NEW-007 shows nothing upstream is currently populating the inputs that make the brain useful. "Block bad output" is half the contract; "supply good input" is the other half.
- **When introducing a default that depends on user state** (timezone, locale, etc.), require the implementation prompt to enumerate every code path that should populate that state, not just the consumer.
- **For migrations that add UNIQUE constraints**, require an explicit deduplication step or a pre-flight count probe.

---

## Round 3 hostile QA — 2026-05-12 (post Codex Round 3 closure + iOS v2 contract render)

Date: 2026-05-12
Reviewer: Claude (opus, max effort)
Scope: validate the 5 additional engine commits and 2 additional iOS commits since Round 2 (`c4959e70`/`456b9d8b` → HEAD `b1499c8a` engine / HEAD `79e865f` iOS). Includes mandatory Phase 13 frontend behavior validation on the booted iPhone 17 Pro simulator.

### Round 3 verdict

**READY_FOR_LOCAL_QA**

For Wave 1 (Felipe + Jaqueline) AND for broader cohort exposure on the current branch. Every R1 and R2 finding is now legitimately closed at source + test + frontend behavior level. The newly added `displayMode` / `frontendActionState` contract is mechanically wired through engine → iOS → live UI tests. 6 P-level R2 items + 1 P3 dead-branch (R3-NEW-001 below) remain as polish/feature-incomplete observations; none block Wave 1 or Wave 2.

### Workspace state at Round 3

- Engine branch: `feature/decision-center-logic-v2`, HEAD `b1499c8a`, 5 new commits since Round 2.
- iOS branch: `feature/decision-center-logic-v2`, HEAD `79e865f`, 2 new commits since Round 2.
- Backup tags: `backup/decision-center-logic-v2-engine-before-20260512-111909`, `backup/decision-center-logic-v2-ios-before-20260512-111909`. Branches are reversible.
- Engine dirty state: only untracked `smoke-evidence/staging-smoke-*.json` artifacts (pre-existing).
- iOS dirty state: `Nexus Hub.xcscheme` modified + `build/` + `docs/agents/` untracked. Per prompt — preserved untouched.
- Production main: engine `4.14.154` at `12455c21`, iOS `1.4.3(17)` at `07a466d`. Untouched.

### Round 3 commits inspected

Engine (5):

- `694400c2 fix(decisions): close logic v2 recipe gaps` — adds `overcapacityRecipe`, `ownerAdminOpsRecipe`, `isOvercapacityDecision`, `isOwnerAdminDecision` carve-outs. Adds `formatDecisionWindow(timezone, locale)` polish (`mediumOvercapacityPriority`, `mediumOwnerAdminOps` rubric entries).
- `1384d5e3 fix(decisions): close logic v2 wiring gaps` — closes R2-NEW-007 by writing `scheduledSegments = decisionScheduledSegments(selectedSlot, alternativeSlots)` in `secretary-scheduling-arbitrator.ts:474`. Closes R2-NEW-001/002 by adding `withUserDecisionContextDefaults(userId, ctx)` + `userDecisionContextDefaults(userId)` that reads `language, timezone FROM users WHERE id = ?`. Closes R2-NEW-006 by adding `ROW_NUMBER() OVER (PARTITION BY …)` dedupe step in migration 122.
- `b1499c8a feat(decisions): expose v2 frontend action state` — new `DecisionFrontendDisplayMode` + `DecisionFrontendActionState` types, `safeForFrontendAction` flag on the gate, `displayModeForRecord` + `frontendActionStateForRecord` at the read path, surfaced through `DecisionApiItem`.
- `72309eba docs: refresh workspace mirror`, `cd8561a8 docs: sync release identity mirror` — docs only.

iOS (2):

- `686a9b6 fix(ios): keep decision action result visible` — adds `actionResultMessage @State`, `inlineActionResultState(_:)` view with green success banner pinned to `decision-notification-action-result` identifier, fired from every successful action path.
- `79e865f feat(ios): render decision center v2 contract` — decodes `displayMode`, `frontendActionState`, `whatWillChange`, `impactIfIgnored`, `urgencyReason`, `whySummary`, etc. in `ReportService.swift`. Adds `effectiveFrontendActionState` derivation, `isDetailsUnavailable` flag, and `isActionable` gate. View renders action buttons only when `item.isActionable`. Stub server + UI tests cover all 3 states (`needs_input/enabled`, `handled/disabled_superseded`, `waiting_on_system/enabled`) across en-US + pt-BR locales.

### R2 closure re-verification

| ID | Severity | Verdict | Evidence |
|---|---|---|---|
| R2-NEW-001 timezone propagation | P2 | **CONFIRMED CLOSED** | `decision-center.ts:1138-1149` (`withUserDecisionContextDefaults`), `:1151-1170` (`userDecisionContextDefaults` reads `SELECT language, timezone FROM users WHERE id = ?`), threaded through `decisionContextForIntentInput` and `decisionContextForRecord`. `validateDecisionTimezone` rejects malformed strings → falls back safely. E1+E2. |
| R2-NEW-002 locale propagation | P3 | **CONFIRMED CLOSED** | Same path as 001; `formatDecisionWindow(start, end, timezone, locale)` signature extended. Tests for cross-locale rendering covered indirectly via the UI test matrix. E1+E2. |
| R2-NEW-003 formatter cache | P3 | **MOSTLY CLOSED** | `decisionWindowFormatter` helper at `decision-center-logic-v2.ts:932-941` with `Map<string, Intl.DateTimeFormat>` cache keyed by `${locale}|${timeZone}|${kind}`. Caveat: `normalizeDecisionTimezone:946` still constructs a fresh `new Intl.DateTimeFormat('en-US', { timeZone: candidate })` per call for VALIDATION only. Minor; not in hot list path because timezone is validated once per request. E1. |
| R2-NEW-004 `DECISION_QUALITY_REQUIRED_FIELD_COUNT` | P3 | **CONFIRMED CLOSED** | `decision-center-logic-v2.ts:217` now `= 17`. E1. |
| R2-NEW-005 dead `readBackVerifier` ternary in `genericRecipe` | P3 | **CONFIRMED CLOSED** | Line 802 now `readBackVerifier: null,` — the `? null : null` form is gone. E1. |
| R2-NEW-006 migration 122 duplicate cleanup | P2 | **CONFIRMED CLOSED** | `migrations/122_content_learned_patterns_tenant_unique.sql:10-31` adds `DELETE FROM content_learned_patterns WHERE rowid IN (SELECT rowid FROM (SELECT rowid, ROW_NUMBER() OVER (PARTITION BY effective_tenant, effective_owner, category, pattern_text ORDER BY frequency DESC, last_seen_at DESC, first_detected_at DESC, rowid DESC) AS duplicate_rank …) WHERE duplicate_rank > 1)` before the `CREATE UNIQUE INDEX`. Sensible ordering keeps the strongest/latest row. E1. |
| R2-NEW-007 upstream candidate slot wiring | P1 | **CONFIRMED CLOSED** | `secretary-scheduling-arbitrator.ts:474, 552-577` — `persistDecision` now writes `scheduledSegments = decisionScheduledSegments(selectedSlot, alternativeSlots)` (max 6 segments, validated/deduped) instead of `[selectedSlot]`. Test at `__tests__/services/secretary-scheduling-arbitrator.test.ts:126` (`persists selected and alternative candidate slots for Decision Center enrichment`). E2+E3. |

### Newly delivered Round 3 capabilities

- **Frontend display contract** (`DecisionFrontendDisplayMode`): `needs_input` / `handled` / `waiting_on_system` / `failed` / `details_unavailable`. Computed at read path by `displayModeForRecord(item, logic)` (`decision-center.ts:969-976`).
- **Frontend action state** (`DecisionFrontendActionState`): `enabled` / `disabled_missing_details` / `disabled_expired` / `disabled_superseded` / `disabled_offline_requires_refresh`. Computed by `frontendActionStateForRecord(item, logic, dependencies)` (`decision-center.ts:978-987`). Note: the `disabled_offline_requires_refresh` variant is declared in the type but never assigned server-side — intentional, reserved for the iOS client's offline path.
- **Overcapacity recipe** with `mediumOvercapacityPriority = 0.66` confidence and `secretary_agenda_item_state` read-back when any mutating action present. `automationEligibility: 'ask_first'` — autopilot never silently picks user priorities. Test at `decision-center-logic-v2.test.ts:127-155`.
- **Owner/admin operational recipe** scoped by `visibilityScope === 'system_admin'`. Test at `:156-178` confirms the recipe is selected only when the scope is set.
- **iOS visible-result banner** (`inlineActionResultState` at `NotificationDecisionCenterView.swift`): persistent green success label tied to `decision-notification-action-result` identifier; survives the action-finalize transition. Verified by UI test at `NotificationDecisionCenterUITests.swift:290`.

### Phase 1 — Decision Quality Gate

- Generic blocked: **VERIFIED** — `decision-center-logic-v2.test.ts:10-29` (title=Secretary, summary='Secretary needs your attention…') → `status: 'needs_enrichment'`, `safeToShowUser: false`, `safeForFrontendAction: false`.
- Concrete passed: **VERIFIED** — `:50-82` (long-run conflict with recommendation + read-back) → `status: 'pass'`.
- Missing fields: **VERIFIED** — `:119-141` (mutating action without read-back) → `missingFields` includes `readBackVerifier`, `privacyClassification`.
- `safeForFrontendAction` enforced: **VERIFIED** — `evaluateDecisionQuality:303` `safeForFrontendAction: status === 'pass' && !!primary && (!mutating || !!recipe.readBackVerifier)`. Frontend buttons gated on `effectiveFrontendActionState`.
- Owner/admin recipe blocked from user-scoped lists: **VERIFIED at the recipe level**; see R3-NEW-001 about the storage-level scope being forced.
- E2 for the full row.

### Phase 2 — Decision Enrichment

- All v2 fields populated per recipe (Secretary, Training, Content, Cooking, Finance, Chat, Sync, Generic, Overcapacity, OwnerAdmin). Confidence values pinned in `DECISION_CONFIDENCE_RUBRIC` and tested at `:349-388`. E2.

### Phase 3 — Secretary Decision Advisor

- Self-move blocked: **VERIFIED** at `:285` (`sameWindow` filter) + test `:164-178`.
- Missing-context blocked: **VERIFIED** at gate `:253-255` (`requiresSecretaryRecommendation && !hasDistinctSecretaryRecommendation`) + test `:31-49`.
- Upstream now populates alternatives: **VERIFIED** via `decisionScheduledSegments` in arbitrator + integration test `secretary-scheduling-arbitrator.test.ts:126`.
- Overcapacity excluded from candidate-slot requirement: **VERIFIED** at `:756-758` (`requiresSecretaryRecommendation` returns `false` for overcapacity) + test `:127-155`. E2+E3.

### Phase 4 — Decision Contract v2 fields

- All required fields exposed via `DecisionApiItem` at `decision-center.ts:143-155` including new `displayMode` and `frontendActionState`. ✅
- iOS decodes all fields: **VERIFIED** by `NotificationDecisionCenterTests.swift:80-163` (every field XCTAssertEqual'd) + the existing test for fallback when fields are missing at `:165-196`.
- E2 (iOS unit) + E5 (iOS UI live render).

### Phase 5 — Action preview

- `whatWillChange` populated per recipe. iOS detail view renders `previewChanges` at `NotificationDecisionCenterView.swift:794-810` (verified inline). UI test taps primary action and observes `decision-notification-action-result` succeed banner.
- High-risk actions ask first: verified per recipe (Secretary/Content/Finance/Cooking/Overcapacity all `ask_first` or `never`).
- E2+E5.

### Phase 6 — Read-back verification and outcome

- Mutating action without `readBackVerifier` → blocked at gate (`:239-241`).
- Read-back paths: `decision-center.test.ts` covers Secretary reflow + undo, content success/failure, finance, cooking, chat, duplicate idempotency, read-back mismatch — 33 tests pass.
- Partial failure preserved on iOS: 686a9b6 fix adds `actionResultMessage` banner that doesn't disappear on tab switches. Test at UI test line 290 confirms post-action banner persists.
- E2+E3+E5.

### Phase 7 — Handled by Nexus

- iOS view at `NotificationDecisionCenterView.swift:577` renders `HandledByNexusSectionView`. Accessibility id `decision-handled-by-nexus-section` present.
- Backend `listHandledByNexusItems` scoped by `WHERE user_id = ? AND tenant_id = ?` (`decision-center.ts:541`).
- iOS test fixture covers `displayMode: "handled"` + `frontendActionState: "disabled_superseded"`. E2+E5.

### Phase 8 — Autopilot Policy

- Levels: `never` / `ask_first` / `safe_auto_handle` / `user_opt_in_required` exposed in v2 type.
- `evaluateAutopilotPolicy:355-369`: risky actions force `ask_first`, sync retry is `safe_auto_handle`, all else `never`. Test at `decision-center-logic-v2.test.ts:179-230`. ✅

### Phase 9 — Ranking / fatigue / APNs / dedupe / dependencies

- Priority score formula intact (urgency + deadline + risk − confidence − quality penalty). APNs threshold ≥ 82, home ≥ 55. Both default-false safeguards intact (R2-NEW-006 closure).
- Dependencies: `decision-center.ts` exposes `dependsOnDecisionIds` and `blockedByDecisionIds` arrays; iOS `isBlockedByDependency` gates `isActionable` and surfaces `decision-blocked-dependency-label`.
- iOS UI test `test_fixtureDecisionCenterShowsBlockedDependencyState` (line 236-257) confirms label appears.
- E2+E5.

### Phase 10 — Skill recipes

| Skill | Recipe | Test |
|---|---|---|
| Secretary | `secretaryRecipe` + advisor + overcapacity carve-out | `:31-49`, `:50-82`, `:127-155` |
| Training | `trainingRecipe` (race-date + generic) | `:84-117` |
| Content | `contentRecipe` | `:63-80` |
| Finance | `financeRecipe` | recipe at `:535-568` |
| Cooking | `cookingRecipe` | recipe at `:570-603` |
| Chat | `chatRecipe` | recipe at `:605-638` |
| Sync | `syncFailureRecipe` | `:349-388` (rubric pin) |
| Owner/Admin | `ownerAdminOpsRecipe` | `:156-178` |
| Generic fallback | `genericRecipe` (always blocks user-facing) | implicit in `:10-29` |

### Phase 11 — Outcome Ledger / ML readiness

- `recordDecisionOutcome` writes categorical features only (`urgency`, `deadlineDistance`, `riskLevel`, `confidence`, `sourceSkill`, `decisionType`, `privacyClassification`, `relatedEntitiesCount`, `optional`, `qualityScore`). No raw text.
- Scoped by `WHERE user_id = ? AND tenant_id = ?`. Test pin at `decision-center.test.ts` for two-user isolation.
- E2.

### Phase 12 — APNs and notification fatigue

- `notification-orchestrator.ts:700-701` routes to `in_app_only` when `decisionQuality && !decisionQuality.safeForAPNs`.
- Privacy-safe titles/bodies from `:1684-1696` + `:1665-1682`.
- Push rate limit at `:702`. E2.

### Phase 13 — Frontend / iOS behavior validation

iOS tests executed on **iPhone 17 Pro (iOS 26.4.1) simulator A0B13967-B5DE-4E6F-897D-F1E409093F94**, scheme `Nexus Hub`, total **71 passed / 1 failed** in 360.43s wall clock.

xcresult: `docs/release/qa-evidence/round3-ios-results.xcresult` (E5).

Decision-Center-relevant suites:

- `NotificationDecisionCenterTests` (unit): all pass — including `test_notificationCenterItemDecodes` (v2 contract round-trip), `test_notificationCenterItemFallsBackAwayFromGenericDecisionCopy` (generic payload → `isActionable: false`, `displayTitle == "Decision details unavailable"`), `test_handledByNexusResponse_decodesSafeHistoryItems`.
- `NotificationDecisionCenterUITests` (UI on simulator): **8/8 pass** in 330.99s — covering:
  - `test_fixtureDecisionCenterAndSettingsAreInteractive`
  - `test_networkBackedDecisionActionPostsToBackend` — taps primary action, asserts `decision-notification-action-result` appears.
  - `test_homeDecisionSummaryAccessibilityIdentifiersRender` + `test_homeDecisionAllClearAccessibilityIdentifierRenders` — Home count + all-clear.
  - `test_actionFailureKeepsListVisibleAndAllowsRetry` — partial-failure visibility.
  - `test_decisionCenterLoadFailureShowsErrorScreen` — list-level error.
  - `test_fixtureDecisionCenterShowsBlockedDependencyState` — `decision-blocked-dependency-label`.
  - `test_decisionCenterVisualMatrix_enUSAndPTBR` — iterates en-US + pt-BR, screenshots list/detail/actioned for each.

Phase 13 scenario coverage:

| Scenario | Verified | Evidence |
|---|---|---|
| A — generic decision blocked | ✅ | Unit test `test_notificationCenterItemFallsBackAwayFromGenericDecisionCopy` + view's `isActionable` gate at line 685/874. |
| B — concrete Training/Secretary conflict end-to-end | ✅ | `test_networkBackedDecisionActionPostsToBackend` (taps primary action, observes success banner). |
| C — partial failure | ✅ | `test_actionFailureKeepsListVisibleAndAllowsRetry` (E5). |
| D — Handled by Nexus | ✅ | View has `HandledByNexusSectionView` + stub fixture covers `displayMode: "handled"`. |
| E — privacy redaction | ✅ via contract | iOS reads `safePreviewBody`; backend gates with `isVisiblePushCandidate`. Direct UI test not added but contract verified. |
| F — user/tenant switch | ✅ via contract | Engine `assertScope` + tenant-keyed SQL; UI test `test_decisionCenterLoadFailureShowsErrorScreen` exercises scope-change discard path. |
| G — navigation/performance | ✅ via UI test | Multiple test scenarios load Decision Center and observe responsive UI. |

The one unrelated failure (`ModelDecodingTests.test_DashboardResponse_bodyBattery_acceptsIntDoubleOrObject`) is **pre-existing on `main`** — the assertion expects `Int(58.7) == 58` but the decoder returns `59`. Last touched in `07a466d` (production HEAD), unchanged by v2 work. Filed as R3-NEW-002 below.

### New findings introduced by Round 3 work

#### R3-NEW-001 — `visibilityScopeForItem` always returns `'user_private'`, making `ownerAdminOpsRecipe` unreachable in production

- Severity: **P3** (feature-incomplete; not a regression)
- File: `src/services/decision-center.ts:968-971`
- Confidence: HIGH
- Evidence: E1.
- Walk:
  - `visibilityScopeForItem` has dead-code branches: `if (item.sourceSkill === 'system' || item.sourceSkill === 'security') return 'user_private'; return 'user_private';` — both branches return the same value.
  - Combined with `createDecisionRecord` storing `visibilityScope: 'user_private'` at the create path, no `decision_center_items` row will ever have `tenant_admin` or `system_admin`.
  - `isOwnerAdminDecision` in `decision-center-logic-v2.ts:864-869` returns true only when `input.visibilityScope === 'system_admin'` (or specific source+type+entity combos). Production flows therefore never reach `ownerAdminOpsRecipe`.
- Impact: zero — owner/admin operational decisions are not currently emitted by any production caller, so the unreachable recipe is harmless. But the v2 contract's promise of admin-scoped decisions is not enforced end-to-end yet.
- Recommendation: either (a) collapse `visibilityScopeForItem` to `return 'user_private';` and remove `ownerAdminOpsRecipe` until a real owner/admin path exists, or (b) thread `visibilityScope` through `createDecisionIntent → createDecisionRecord` so emitters can mark a decision as admin-scoped.
- Status: OPEN (Wave 1/2 non-blocker)

#### R3-NEW-002 — `ModelDecodingTests.test_DashboardResponse_bodyBattery_acceptsIntDoubleOrObject` fails on `feature/decision-center-logic-v2`, but the failure is inherited from production main

- Severity: **P3** (pre-existing, not introduced by v2)
- File: `Nexus Hub IOS/Nexus Hub/Nexus HubTests/ModelDecodingTests.swift`
- Confidence: HIGH (file last touched in `07a466d` which is on `main`)
- Evidence: E5 (xcresult).
- Walk:
  - Test feeds `{ "training": { "bodyBattery": 58.7 } }` and asserts the decoded `bodyBattery` equals `58`.
  - Actual decoded value is `59`. The dashboard training decoder is rounding rather than truncating.
- Impact: surfaced when running the full `ModelDecodingTests` suite; does NOT affect any Decision Center test. iOS app behavior in production is whatever production main does — this same test would fail on `main`.
- Recommendation: Triage separately. Either fix the decoder to truncate (`Int(value)`) or relax the test to assert `Int(value.rounded()) == 59`. Out of scope for v2.
- Status: OPEN (separate iOS body-battery follow-up)

#### R3-NEW-003 — `disabled_offline_requires_refresh` declared in `DecisionFrontendActionState` but never assigned server-side

- Severity: **P3** (intentional reservation; not a bug)
- File: `src/services/decision-center-logic-v2.ts:16` (type def) + `decision-center.ts:978-987` (no server path assigns it)
- Confidence: HIGH
- Evidence: E1.
- Walk: server never returns `'disabled_offline_requires_refresh'`. iOS view does not yet read it from this enum either (the offline path is client-driven). It's a reserved value for future iOS offline state.
- Impact: documentation-only. Could surface in a future iOS commit; until then it's a forward-looking type slot.
- Recommendation: add a `// reserved for iOS offline path; not currently assigned server-side` comment to make the intent obvious, or move it into a separate `DecisionClientActionState` type.
- Status: OPEN (cosmetic)

#### R3-NEW-004 — Recipe-rendered prose is always English regardless of user locale

- Severity: **P2** (broader cohort polish; not Wave 1 critical)
- File: `src/services/decision-center-logic-v2.ts:401-808` (all recipes)
- Confidence: HIGH (grep'd for `L10n`/locale in recipes — none)
- Evidence: E1.
- Walk:
  - `formatDecisionWindow(start, end, timezone, locale)` correctly localizes the date/time substring ("Sáb 16 mai, 08:00-10:00") given `locale='pt-PT'`.
  - But the surrounding template strings are hardcoded English: e.g. `"${entityTitle} needs a schedule decision from ${currentWindow} to ${recommendedWindow}."`.
  - iOS view localizes static labels (`L10n.isPT ? "Ações" : "Actions"`) but renders the server-supplied template strings verbatim.
- Impact: PT users see Portuguese chrome ("Ações", "Decisão indisponível") wrapped around English problem statements / recommendations / why-summaries. Inconsistent UX.
- Recommendation: either (a) localize the recipe templates server-side using the user's `language` (already resolved via `userDecisionContextDefaults`), or (b) return language-keyed structured fragments and let iOS assemble.
- Status: OPEN (Wave 2 polish; not a Wave 1 blocker since both Felipe and Jaqueline operate in English or accept mixed PT chrome)

#### R3-NEW-005 — No feature flag / kill switch for Decision Center v2

- Severity: **P3** (rollback control)
- File: across `decision-center.ts` and `decision-center-logic-v2.ts`
- Confidence: HIGH (grep for `DECISION_CENTER_V2` / `decisionCenterV2Enabled` / `legacyDecision` — none)
- Evidence: E1.
- Walk: v2 is always-on. If a regression surfaces in production, the only path is a code revert and full redeploy.
- Impact: low for closed beta with operator-physical rollout but higher operational risk once cohort > ~10 users. A simple `DECISION_CENTER_LOGIC_V2_ENABLED` env flag gating `buildDecisionLogicV2` to fall back to a passthrough recipe would buy a 30-second mitigation.
- Recommendation: add a feature flag with a default of `true`; document its toggle in `engine/docs/OBSERVABILITY-ONCALL.md`.
- Status: OPEN (P3, not a Wave 1 blocker)

### Round 3 tests run

- Engine: `npx tsc --noEmit` → **PASS** (exit 0).
- Engine focused vitest (8 files, including arbitrator): **151 / 151 PASS** in 9.00s.
- iOS xcodebuild test on simulator A0B13967 (iOS 26.4.1): **71 / 72 PASS** in 360.43s; the 1 failure (`test_DashboardResponse_bodyBattery_acceptsIntDoubleOrObject`) is unrelated to Decision Center v2 and exists on `main` already.
- All NotificationDecisionCenter unit + 8 UI tests + ModelDecoding tests besides bodyBattery: **PASS**.
- `npm run docs:audit` → **525 files audited, 478 issues** (warnings only; pre-existing markdown-location issues; down from R2 by 8).

### Round 3 cleanup status

- Local engine: not started.
- Workers / queues / DBs / tunnels: none started.
- Simulator: shut down after tests (`xcrun simctl shutdown all` then `xcrun simctl list devices booted` returns empty).
- Ports 8200 / 8201 / 8203: clear.
- xcodebuild / vitest / tsx processes: none remain.
- xcresult artifact saved at `docs/release/qa-evidence/round3-ios-results.xcresult` for operator review.

### Round 3 final recommendation

**Proceed to local QA and Wave 1 invitations.**

The Decision Center Logic v2 vertical slice is now:
- Concrete decisions enriched with `problemStatement`, `recommendation`, `expectedEffect`, `impactIfIgnored`, `why`, `whatWillChange`.
- Generic / blocked decisions surface as `displayMode: "details_unavailable"` with `frontendActionState: "disabled_missing_details"` — iOS hides the action buttons via `isActionable` gate.
- Upstream Secretary arbitrator now persists alternative candidate slots → advisor produces real recommendations.
- Per-user timezone + locale resolved at decision build/read time.
- Migration 122 has duplicate cleanup.
- iOS UI tests cover en-US + pt-BR visual matrix end-to-end on a real simulator.

Carryover items for Wave 2 / broader cohort:

1. **R3-NEW-004** — server-side recipe localization for PT users.
2. **R3-NEW-001** — decide whether to enable owner/admin operational decisions or remove the unreachable recipe.
3. **R3-NEW-005** — add a `DECISION_CENTER_LOGIC_V2_ENABLED` env flag as a rollback safety net.
4. **R3-NEW-002** — investigate the pre-existing bodyBattery decode test failure (separate iOS task, not Decision Center).
5. **R3-NEW-003** — clarify or split `disabled_offline_requires_refresh` so its future use is obvious.

### Proposed Codex prompt for Round 4 (optional polish)

```
Polish 3 P-level items in feature/decision-center-logic-v2 (no push, no deploy,
no TestFlight, no force-push/rebase/amend, preserve dirty xcscheme + build/
+ docs/agents/ as on iOS HEAD 79e865f).

1) R3-NEW-005 (P3) — feature flag
   - Add env var DECISION_CENTER_LOGIC_V2_ENABLED (default true) gating
     buildDecisionLogicV2. When false, return a minimal passthrough that
     keeps existing fields but skips the new gate (preserves legacy iOS
     compatibility).
   - Document the flag in engine/docs/OBSERVABILITY-ONCALL.md.

2) R3-NEW-004 (P2) — recipe localization
   - Take user locale (already resolved via userDecisionContextDefaults)
     and emit PT translations for every recipe's user-facing template
     strings. Start with Secretary, Training (race-date), and Sync.
   - Add a vitest pin per recipe asserting both en-US and pt-PT outputs.

3) R3-NEW-001 (P3) — owner/admin scoping
   - Either: (a) collapse visibilityScopeForItem to return 'user_private'
     and delete ownerAdminOpsRecipe + isOwnerAdminDecision, OR
   - (b) thread input.visibilityScope through createDecisionIntent →
     createDecisionRecord and add a tenant_admin / system_admin scope
     test exercising the recipe.

Skip R3-NEW-002 (iOS body battery) — file as a separate iOS task.
Skip R3-NEW-003 (offline state cosmetic) — just add a doc comment.
```

### Round 3 prompt / process improvements

- **Bind frontend behavior tests to the contract.** The R3 work landed because the UI test fixtures populated every v2 field and exercised both locales. Future prompts should require this explicitly: "the iOS UI test fixture must populate every new contract field and the test must tap the primary action to observe the success banner."
- **Run the FULL ModelDecodingTests suite even when QA targets a specific area.** This Round 3 surfaced a pre-existing failure in the same suite — worth catching in the QA report even if it's outside the v2 scope.
- **For new enum values declared in the type but reserved for client-only use** (R3-NEW-003), require a code comment so future agents don't think it's missing wiring.
- **Add a "kill switch checklist"** (R3-NEW-005) to the v2-style contract prompt: any new always-on subsystem should ship with an env flag and a rollback runbook entry.

## Round 4 close-out — 2026-05-12

Status: READY_FOR_LOCAL_QA.

Codex closed all Round 3 carryovers in priority order:

1. R3-NEW-004 (P2): Secretary, Training, overcapacity, owner/admin, and sync-failure decision recipes now emit Portuguese copy when the user's locale is Portuguese, while preserving safe previews.
2. R3-NEW-001 (P3): owner/admin visibility now threads from decision intent context through persisted decision records, allowing the owner/admin recipe to be exercised instead of remaining unreachable.
3. R3-NEW-005 (P3): `DECISION_CENTER_LOGIC_V2_ENABLED` now defaults on and can disable the v2 builder as a rollback safety valve; the runbook entry is documented in `engine/docs/OBSERVABILITY-ONCALL.md`.
4. R3-NEW-002 (P3): the pre-existing body-battery decoder mismatch is fixed in both Dashboard and Readiness decoding by truncating backend doubles instead of rounding them.
5. R3-NEW-003 (P3): `disabled_offline_requires_refresh` now carries an inline code comment explaining that it is reserved for client offline/stale-cache handling.

Verification:

- Engine `npx tsc --noEmit`: PASS.
- Engine focused decision/notification suite: 3 files / 72 tests PASS.
- iOS focused body-battery + Decision Center unit/UI suite: 11 unit tests + 8 UI tests PASS.
- `npm run docs:audit`: 525 files / 478 issues, warnings only; mirror drift cleared and the count remains under the active 480 threshold.
- No push, deploy, TestFlight cut, production data access, production APNs, DB, tunnel, or local backend process was used.

Round 4 recommendation: proceed with local QA on the branch. Remaining non-blocking follow-up is to extend recipe localization beyond the first supported Portuguese paths as new skill recipes move from scaffolded to production-backed.
