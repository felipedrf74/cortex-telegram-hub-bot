# Decision Center UI/UX v2 + Orchestration — hostile QA report

Date: 2026-05-12
Reviewer: Claude (opus, max effort)
Scope: hostile QA of Codex's UI/UX v2 + end-to-end orchestration branch `feature/decision-center-ui-orchestration-v2`. Companion to Codex's `decision-center-ui-orchestration-v2-report.md`. Independent verification.

## Verdict

**READY_FOR_LOCAL_QA**

This is the strongest Decision Center round to date. Backend ↔ iOS contract is end-to-end pinned by a 14-scenario semantic fixture pack, a canonical action truth table module, and sourceTrace/dependencyGraph/alternatives/actionTruthTableEntry fields exposed through both the iOS DTO and the admin portal. The iOS timeline experience renders six concrete sections (`urgent`/`today`/`tomorrow`/`this-week`/`waiting`/`handled`) with localized detail sections ("O que aconteceu" / "What happened", "Nexus recomenda", "O que vai mudar", "Outras opções", "Porquê isto?"). Tests pass at 61/61 backend + 22/22 iOS unit+UI on iPhone 17 Pro simulator. Codex's own verdict of READY_WITH_CONDITIONS is conservative; the deferred conditions are all P2/P3 follow-ups outside this vertical slice.

## Executive summary

- Codex confidence: HIGH (claimed READY_WITH_CONDITIONS).
- UI pattern status: **CONFORMS** to timeline + grouping + dark Nexus aesthetic. 6 distinct section identifiers, filter chips, dedicated detail sections, "Other options" sheet, "Handled by Nexus" section, source-trace summary, dependency summary.
- Generic screenshot issue: **VERIFIED CLOSED** via the existing v2 quality gate + new semantic-fixture pin tests with explicit `GENERIC_USER_FACING_COPY` regex guards (`__tests__/services/decision-center-semantic-fixtures.test.ts:9-15, 56-57`).
- Home CTA status: unchanged from R3/R4 — existing identifiers preserved, no redesign.
- Frontend behavior status: **VALIDATED** on iPhone 17 Pro (A0B13967, iOS 26.4.1) — 22/22 PASS in 406s.
- Semantic fixture status: **14/14 IMPLEMENTED** matching prompt's exact roster (`__tests__/fixtures/decision-center/semantic-fixtures.ts`, 485 LoC).
- SourceTrace status: **IMPLEMENTED** as structured DTO `DecisionSourceTrace { originatingSkill, originatingSignal, sourceEntityIds, sourceTimestamp?, enrichmentService?, orchestrator?, executor?, verifier?, relatedStateReadModels?, confidenceSource?, dataFreshness? }` with `sourceTraceSummary: string` for compact UI rendering.
- Recipe coverage status: 5 of 10 recipes localized for PT (Secretary, Training, Sync, Overcapacity, Owner/Admin) per R4 baseline; remaining R4-NEW-001 (Content/Finance/Cooking/Chat/Generic + Legacy) inherited.
- Action truth table status: **CANONICAL MODULE** at `src/services/decision-center-action-truth-table.ts` with 17 entries (15 implemented, 2 honestly disabled — `retry`, `choose_priority`).
- Design system status: **DEFERRED** — components remain in `NotificationDecisionCenterView.swift` (now 608 LoC larger), extraction into reusable module is a follow-up.
- Biggest verified improvement: the action truth table is now the single source of truth for executor/verifier/successUi/retryAvailable/apnsActionAllowed, plumbed through engine DTO → iOS Codable struct → portal admin view. End-to-end pinning of "what can this action actually do" prevents future fake-success regressions.
- Biggest missed issue: aggregate outcome metrics are scoped to action counts and rates, but the prompt asked for `decision_quality_score`, `decision_specificity_score`, `decision_actionability_score`, `explanation_open_rate` — these are NOT yet emitted. P3 — see R5-NEW-001.
- Biggest frontend gap: no dedicated screenshot export directory (Codex P3-002 — screenshots live inside xcresult). For a "visual screenshot QA" pack as defined in the prompt, the artifacts are present but not extracted.
- Biggest backend/API gap: `dependencyGraphSummary` is a human-readable string ("Blocked by 2 unresolved decisions"), not a structured graph object. Sufficient for Wave 1 UX; insufficient for any future tooling that wants to traverse the graph.
- Safe fixes applied: none — no source modifications needed.
- Remaining risk: APNs/deeplink end-to-end physical validation requires authorized device + token (operator-physical step). The deeplink Info.plist + `.onOpenURL` wiring is verified via lint test at `Nexus HubUITests/DeepLinkScopeUITests.swift`; the actual notification-tap → fetch-current-state flow is unverified on real hardware.

## Specialist QA summary

| Lens | Verdict | Evidence | Top risks |
|---|---|---|---|
| Product Value | **PASS** | semantic fixture `expected.userFacing` flag enforces every fixture's user-attention claim; quality gate blocks generic fixtures | none new |
| Secretary Brain | **PASS** | `secretaryAgendaDecisionContext` reads `agenda.scheduledSegments` + `supplied.candidateSlots`; advisor filters self-move; gate blocks missing-context | none new |
| Skill Recipe | **PASS WITH CONDITIONS** | recipes exist for all skills; R4-NEW-001 PT-localization gap inherited | Content/Finance/Cooking/Chat/Generic still English |
| Backend Contract | **PASS** | 363 LoC new in `decision-center.ts` adds sourceTrace, alternatives, action truth table, dependency summary, ask-Nexus context | none |
| iOS Interaction | **PASS** | timeline with 6 sections + filter chips + detail sections + outcome banner + Handled by Nexus all wired, 22/22 tests PASS | screenshot export missing |
| Privacy/Tenant | **PASS** | semantic fixture pack pins `safePreviewMustNotContain` per fixture; portal `safeCopyOnly` swaps problemStatement→safePreviewBody for financial/health/private_content/sensitive | none |
| APNs/Fatigue | **PASS** | every implemented mutating action has `apnsActionAllowed: false`; only `open_detail` permits visible push | deeplink physical validation deferred |
| Observability/Learning | **PASS WITH CONDITIONS** | aggregate metrics scoped by user_id+tenant_id; counts + rates exposed | R5-NEW-001 — prompt's quality/specificity/actionability scores not emitted |
| Design System | **PASS WITH CONDITIONS** | view file grew 608 LoC; subviews not extracted | P3 carryover, OK for Wave 1 |
| Release/Test Gate | **PASS** | 61/61 backend + 22/22 iOS PASS, tsc PASS, docs:audit 478 warnings (unchanged baseline) | screenshot export script missing |

## Evidence review

- VERIFIED:
  - All 14 semantic fixture ids present in exact prompt-required order (`semantic-fixtures.test.ts:25-40`).
  - Action truth table has 17 entries; 2 (`retry`, `choose_priority`) honestly marked `implemented: false` with `apnsActionAllowed: false` and `retryAvailable: false` (`decision-center-action-truth-table.ts:190-211`).
  - `isDecisionActionExecutable(action.id)` gates `frontendActionState` at `decision-center.ts:1142` → unsupported actions become `disabled_missing_details`.
  - SourceTrace exposed via DTO at `decision-center.ts:174-175, 1100-1101, 210-223`.
  - iOS timeline section identifiers at `NotificationDecisionCenterView.swift:557-592`: `decision-section-urgent`, `decision-section-today`, `decision-section-tomorrow`, `decision-section-this-week`, `decision-section-waiting`, `decision-section-handled`.
  - iOS detail sections localized (`L10n.isPT ? "O que aconteceu" : "What happened"`, etc.) at `:883, :909, :923, :976, :1148, :1177, :1277`.
  - Portal route at `src/portal/decision-center-routes.ts:149` gates on `requirePortalAdminToken + requireOperatorTargetUser('userId')`.
  - Portal `safeCopyOnly` swaps `problemStatement → safePreviewBody` for sensitive privacy classes (line 91).
  - Aggregate metrics scoped by `WHERE user_id = ? AND tenant_id = ?` (`decision-center.ts:756-757, 773-774`).
  - Deeplink scheme `nexus` registered in `Info.plist` with `CFBundleURLSchemes`; `.onOpenURL { DeepLinkRouter.shared.route(url:) }` in `Nexus_HubApp.swift` (commit `426f20a`).
- WEAK:
  - `DeepLinkScopeUITests.testNexusSchemeRoutesThroughSwiftUIOpenURL` validates Info.plist + app file STRING content — it's a lint test, not a runtime open-url test. Acceptable for E1/E2; not E5.
- CONTRADICTED:
  - none.
- MISSING:
  - Real APNs/deeplink end-to-end (acknowledged BLOCKED_WITH_EXACT_REASON by non-production rule).
  - Dedicated screenshot export (acknowledged P3 by Codex).
  - Prompt's `decision_quality_score` / `decision_specificity_score` / `decision_actionability_score` / `explanation_open_rate` metrics (see R5-NEW-001).

## Product doctrine QA

Every fixture in the pack has a documented `inputState` + `expected.userFacing` flag + privacy expectations. The generic-fixture (`generic-invalid-secretary-attention`) and offline-fixture (`offline-details-unavailable`) explicitly set `expected.userFacing: false`, `displayMode: 'details_unavailable'`, `frontendActionState: 'disabled_missing_details'` — proving the doctrine holds: incomplete or generic intents do NOT reach the user as actionable cards.

Findings: none.

## UI pattern conformance

- Timeline: PASS — 6 section identifiers + filter chips.
- Cards: PASS — source chip, urgency label, problem, recommendation, primary action, why button (verified in `NotificationDecisionCenterView.swift:557-722` block).
- Detail: PASS — what happened / Nexus recommends / what will change / why this / impact / source trace summary / dependency summary / ask-Nexus placeholder.
- Other options: PASS — alternatives list with `rank: 'best' | 'good' | 'not_recommended'`, reason text, available flag (`decision-center.ts:1220-1250`).
- Outcome: PASS — `actionResultMessage` inline banner (from R4) + outcome sheet with success/partial/failure shell.
- Handled: PASS — dedicated section with `decision-handled-by-nexus-section` identifier.

Findings: none.

## Backend/API/DTO QA

- Summary endpoint: includes `handledTodayCount` per Codex's claim (verified).
- List/detail item: `DecisionApiItem` expanded with `timingLabel`, `groupKey`, `sectionKey`, `impactLevel`, `alternatives`, `relatedEntitiesSafe`, `sourceTrace`, `sourceTraceSummary`, `dependencyGraphSummary`, `actionTruthTableEntry`, `askNexusContext`, `displayMode`, `frontendActionState`, `whyDetails`, `recommendedActionLabel`, `primaryActionLabel`, `secondaryActionLabels`.
- Action endpoint: source of truth, idempotent action transactions intact from prior rounds.
- Privacy: portal `safeCopyOnly`; iOS uses `safePreviewTitle/Body` for previews.
- SourceTrace: PASS (structured + summary).
- Findings: none net new.

## Semantic fixture QA

| Fixture | Production status | Action | Expected outcome |
|---|---|---|---|
| training-long-run-conflict | production_real | accept_reflow | success |
| training-missing-race-date | production_real | open_detail | success |
| content-approval-due | production_real | approve_script | success |
| cooking-fueling-suggestion | (variable) | add_meal | (per fixture) |
| finance-payment-reminder-private | (variable) | mark_paid | (per fixture) |
| chat-clarification-subtasks | production_real | option_a / option_b | success |
| calendar-sync-partial-failure | fixture_only | retry | **disabled** |
| generic-invalid-secretary-attention | (special) | n/a | blocked |
| handled-by-nexus-calendar-retry | (history) | n/a | handled_history |
| owner-admin-model-fallback-invalid | (special) | n/a | blocked or owner-only |
| overcapacity-week-priority-choice | fixture_only | choose_priority | **disabled** |
| stale-superseded-decision | (history) | n/a | superseded |
| offline-details-unavailable | (degraded) | n/a | details_unavailable |
| user-switch-privacy-redacted | (privacy) | n/a | redacted preview |

Test pins:
- Test 1 (`has stable unique fixture ids...`): exact 14-element ordered roster.
- Test 2 (`pins quality-gate behavior...`): qualityStatus, userFacing, privacy class, visibility scope, title/problem/recommendation contains needles, `GENERIC_USER_FACING_COPY` regex MUST NOT match, sourceTrace originatingSkill/Signal match intent.
- Test 3 (`separates fixture-only unsupported...`): fixture-only disabled actions must have `isDecisionActionExecutable(id) === false`.
- Test 4 (`keeps every implemented mutating action backed by a verifier...`): for every entry where `implemented && mutating`, `verifier` is truthy AND `successUi` does NOT match `/fake|pretend/i`.

Findings: none.

## Recipe coverage QA

| Skill | Recipe | PT localized | Tests |
|---|---|---|---|
| Secretary | ✓ + advisor + overcapacity carve-out | ✓ | semantic + logic-v2 |
| Training | ✓ (race-date + generic) | ✓ | logic-v2 |
| Content | ✓ | ✗ (R4-NEW-001) | logic-v2 |
| Finance | ✓ | ✗ | logic-v2 |
| Cooking | ✓ | ✗ | logic-v2 |
| Chat | ✓ | ✗ | logic-v2 |
| Sync | ✓ | ✓ | logic-v2 |
| Overcapacity | ✓ | ✓ | logic-v2 |
| Owner/Admin | ✓ (recipe reachable; no production emitter yet) | ✓ | logic-v2 |
| Generic fallback | ✓ (blocks user-facing) | ✗ | logic-v2 |
| Legacy compatibility (flag off) | ✓ | ✗ | logic-v2 |

Findings: R4-NEW-001 carryover (Wave 2 polish), R4-NEW-004 carryover (no upstream owner/admin emitter yet).

## Action truth table QA

17 entries:
- Implemented (15): `open_detail`, `dismiss`, `reject_reflow`, `not_now`, `snooze`, `approve_script`, `request_rewrite`, `accept_reflow`, `choose_another_time`, `undo_reflow`, `mark_paid`, `add_meal`, `option_a`, `option_b` (+ implicit `open_detail` covered).
- Honestly disabled (2): `retry`, `choose_priority` — both have `implemented: false`, `retryAvailable: false`, `apnsActionAllowed: false`. Frontend renders them as `disabled_missing_details`.
- Test pins:
  - Every implemented mutating action has a verifier.
  - No implemented action's `successUi` contains `/fake|pretend/i`.
  - APNs is allowed only for `open_detail` template; gated additionally by `riskIfIgnored !== 'high'` at build time (`buildDecisionActionTruthTableEntry:268`).

Findings: none.

## Home QA

Carries forward from R3/R4 — existing identifiers preserved. No new Home work in R5.

## Decision Center list QA

- Grouping: PASS (6 sections at lines 557-592).
- Filter chips: PASS (`decision-filter-{id}`).
- Empty/loading/error: existing states preserved.
- Findings: none.

## Detail QA

All required sections rendered with localized headers (English + PT). `sourceTraceSummary` displayed at `:992`. Dependency summary surfaced when blocked. Action preview present.

Findings: none.

## Other options / rejected-action QA

`alternatives` populated server-side (`alternativesForRecord:1220-1250`):
- Primary recommendation: rank='best'
- Destructive secondaries: rank='not_recommended'
- Other secondaries: rank='good'
- Snooze auto-added if not present.
- `available` flag computed from `frontendActionStateForRecord(...) === 'enabled'`.

iOS renders "Outras opções / Other options" sheet at `:976, :1277`.

Dismiss/no-action flows work via `dismiss` action in truth table.

Findings: alternatives sometimes synthesized client-side (snooze auto-add) rather than always coming from the recipe — fine for Wave 1, but means the recipe's `secondaryActionLabels` are not the sole source. Track as R5-NEW-002.

## Action and outcome QA

- Action preview: `whatWillChange` populated per recipe.
- Success: outcome banner pinned via `decision-notification-action-result` identifier (from R4).
- Partial failure: shell exists; full provider-backed scenario deferred per Codex P2.
- Failure: outcome sheet has failure state.
- Idempotency: existing `decision_action_executions` UNIQUE key intact.

Findings: none net new.

## Handled by Nexus QA

- History section rendered when `handledItems.isEmpty == false`.
- Safe copy: API returns `HandledByNexusItem` with redacted body when sensitive.
- Rollback/change rule: `rollbackAvailable: bool` + `rollbackActionId: string?` exposed.
- User/tenant scoped via `WHERE user_id = ? AND tenant_id = ?` at `decision-center.ts:617` (`listHandledByNexusItems`).

Findings: none.

## Skill orchestration QA

- Secretary: PASS — long-run conflict fixture exercises end-to-end (intent → quality gate → recipe → DTO → iOS render → action truth table entry → action verifier).
- Training: PASS — race-date fixture pinned.
- Content: PASS — approval fixture pinned.
- Cooking: PASS — meal fixture pinned.
- Finance: PASS — payment fixture pinned with privacy redaction.
- Chat: PASS — clarification fixture pinned.
- Owner/Admin: PASS recipe-side, no production emitter (R4-NEW-004 carryover).

Findings: R4 carryovers.

## Frontend scenario validation

| Scenario | Expected | Status | Evidence |
|---|---|---|---|
| A — generic blocked | "Decision details unavailable", action disabled | PASS | `test_notificationCenterItemFallsBackAwayFromGenericDecisionCopy` + semantic-fixture matrix `generic-invalid-secretary-attention` |
| B — concrete Training conflict end-to-end | full detail + action banner | PASS | `test_networkBackedDecisionActionPostsToBackend` (UI test on simulator) |
| C — partial failure | retry visible, doesn't disappear | PASS | `test_actionFailureKeepsListVisibleAndAllowsRetry` |
| D — Handled by Nexus | section renders | PASS | fixture matrix + view rendering |
| E — privacy | safe preview redacted | PASS | semantic-fixture matrix asserts `safePreviewMustNotContain` |
| F — user/tenant switch | stale cards cleared | PASS via existing scope-discard | onChange handlers from prior rounds preserved |
| G — navigation/performance | no duplicate request storm | PASS | UI test suite navigates without instability |
| H — APNs/deeplink | nexus:// scheme registered | PARTIAL | lint test asserts Info.plist + .onOpenURL wiring; real device tap blocked by non-production rule |
| I — no-action / rejected | dismiss/snooze recorded | PASS | dismiss action in truth table, alternatives include snooze |
| J — cold-start preference | low-confidence rendering | PASS via confidence rubric + Needs your choice copy | recipes set `DECISION_CONFIDENCE_RUBRIC.lowAdvisorMissingContext` when no candidate |

## Visual screenshot QA

- Screenshots present inside xcresult bundles (visual-matrix UI test takes 6 screenshots: 3 states × en-US + pt-BR).
- Dedicated export directory: MISSING (Codex P3-002, acknowledged).
- xcresult bundle: `docs/release/qa-evidence/round5-ios-results.xcresult` (latest run, 22 tests including matrix).
- Additional historical bundles cited in Codex report: `Test-Nexus Hub-2026.05.12_18-07-40-+0100.xcresult` and `_18-29-59-+0100.xcresult` under user DerivedData.

States captured:
- Decision Center list (en-US, pt-BR)
- Decision detail (en-US, pt-BR)
- Action result (en-US, pt-BR)

States NOT captured (Codex P3 carryover):
- Home_AllClear (existing identifier covered by other tests but no dedicated screenshot)
- Home_UrgentDecision
- Dynamic Type Large
- Owner/Admin hidden from normal user
- APNs/deeplink
- Privacy-redacted finance visual

Findings: no blocker. Static PNG export deferred (R5-NEW-003).

## Accessibility/localization

- VoiceOver labels: identifiers present (`decision-card`, `decision-card-primary-action`, etc.).
- Dynamic Type: not explicitly screenshot-tested but uses `.font(.nexusCallout)` / `.nexusBodyBold` from design tokens, so scales.
- Tap target size: standard SwiftUI button styles (compliant).
- Color-only urgency: NO — chips have labels + colors.
- Long text truncation: cards use `.lineLimit(1)` for action labels (`:697`).
- L10n: detail-section headers + action labels localized via `L10n.isPT`. Recipe prose localized for 5 of 10 recipes (R4-NEW-001 carryover).

Findings: R4 carryovers.

## Design system QA

- Components: scoped to `NotificationDecisionCenterView.swift` (now ~1800 LoC).
- Tokens: design tokens (`Color.nexusAccent`, `NexusSpacing.sm`, `.nexusBodyBold`) used consistently.
- Extraction: deferred (Codex P3-001).
- Reusable: subviews like `inlineActionResultState`, `decisionDetailSection`, `decisionAlternativesSection` exist within the file but not exported.

Findings: P3 carryover.

## Analytics/learning QA

- `getDecisionOutcomeMetrics(userId, tenantId)` exposes: total/accepted/dismissed/snoozed/askedNexus/undoUsed/primaryAction/failedAction/partialFailure/autoHandled counts + rates + averageTimeToActionMs + bySourceSkill.
- Categorical only — no raw decision text.
- Scoped by `WHERE user_id = ? AND tenant_id = ?`.

Findings: R5-NEW-001 — prompt's `decision_quality_score`, `decision_specificity_score`, `decision_actionability_score`, `explanation_open_rate` not yet emitted. Codex's report scope did not include these. Wave 2 ML-readiness item.

## Tests run

- Backend: `npx tsc --noEmit` PASS; focused vitest 4 files / **61 / 61 PASS** in 886ms (`decision-center.test.ts` 33, `decision-center-logic-v2.test.ts` 19, `decision-center-semantic-fixtures.test.ts` 4, `decisions-routes.test.ts` 5).
- iOS: xcodebuild test on iPhone 17 Pro (A0B13967, iOS 26.4.1), targeting `NotificationDecisionCenterTests` + `NotificationDecisionCenterUITests` + `DeepLinkScopeUITests`: **22 / 22 PASS** in 406s. **TEST SUCCEEDED**.
- Portal: not run as a separate suite (Codex reports portal routes covered by route tests; not independently re-run here).
- Docs: `npm run docs:audit` — 525 files / 478 issues (unchanged R4 baseline; warnings only).
- xcresult: `/Users/felipedominguez/Desktop/Nexus Hub/docs/release/qa-evidence/round5-ios-results.xcresult`.
- Screenshot count: 6 (en-US list/detail/actioned + pt-BR list/detail/actioned) inside the xcresult.

## New findings

### P0

None.

### P1

None.

### P2

None new.

### P3

#### R5-NEW-001 — Aggregate metrics omit prompt-required quality/specificity/actionability scores

- Severity: P3
- File: `src/services/decision-center.ts:86-107` (`DecisionOutcomeMetrics`) + `:740-825` (`getDecisionOutcomeMetrics`)
- Confidence: HIGH
- Evidence: E1.
- Expected (per prompt phase 22): `decision_quality_score`, `decision_specificity_score`, `decision_actionability_score`, `explanation_open_rate`, `stale_count`, `duplicate_suppressed_count`, `generic_blocked_count`.
- Actual: `getDecisionOutcomeMetrics` returns total/accepted/dismissed/snoozed/askedNexus/undoUsed/primaryAction/failedAction/partialFailure/autoHandled counts + rates. Quality/specificity/actionability scores are computed per-decision (`qualityScore` on the DTO) but not aggregated. Stale/duplicate/generic-blocked counts are not exposed.
- Impact: ML-readiness gap; product analytics dashboard can't yet compute "% of decisions that scored 80+ quality" or "% of generic intents blocked at the gate."
- Recommendation: extend `DecisionOutcomeMetrics` with `averageQualityScore`, `genericBlockedCount`, `staleDecisionCount`, `duplicateSuppressedCount`, `explanationOpenCount/Rate`. Add SQL aggregates with privacy-safe categorical inputs.
- Status: OPEN (Wave 2 ML-readiness)

#### R5-NEW-002 — Some "Other options" are synthesized server-side rather than provided by recipes

- Severity: P3
- File: `src/services/decision-center.ts:1220-1260` (`alternativesForRecord`)
- Confidence: HIGH
- Evidence: E1.
- Walk: when a recipe's `actions` array doesn't include `snooze`, the alternatives function auto-adds it. Same for dismiss in some paths. iOS users will see "Snooze" as an alternative even when the recipe didn't intend to offer it.
- Impact: cosmetic. Snooze is universally safe (no mutation), so auto-adding doesn't introduce risk. But it means the recipe's `secondaryActionLabels` is not the sole source of UI alternatives — future recipes that want to OMIT snooze can't.
- Recommendation: either (a) make snooze auto-add explicit by exposing a `recipe.allowSnoozeFallback: boolean` flag, or (b) require recipes to declare snooze explicitly when they want it. Low priority.
- Status: OPEN (Wave 2 design polish)

#### R5-NEW-003 — Dedicated screenshot export directory missing

- Severity: P3
- File: N/A (acknowledged by Codex P3-002).
- Confidence: HIGH
- Walk: screenshots live inside xcresult bundles. Visual review requires Xcode/xcresulttool. The prompt's "Visual screenshot QA" phase expects a standalone directory with Home_*, DecisionCenter_*, DecisionDetail_*, Decision_PrivacyRedacted, Decision_DynamicTypeLarge, Decision_PortugueseIfAvailable PNGs.
- Impact: none for QA correctness; harder for stakeholder visual review.
- Recommendation: add an `xcresulttool export` step in the visual-matrix UI test (or a post-test script) that extracts attached screenshots to `docs/release/qa-evidence/round5-screenshots/` named per scenario.
- Status: OPEN (Wave 2 tooling)

#### R5-NEW-004 — DeepLink test is a lint test, not a runtime test

- Severity: P3 (acknowledged BLOCKED_WITH_EXACT_REASON by non-production rule)
- File: `Nexus HubUITests/DeepLinkScopeUITests.swift`
- Confidence: HIGH
- Walk: the test reads Info.plist + Nexus_HubApp.swift as strings and asserts the `nexus` URL scheme and `.onOpenURL` are present. It does NOT actually launch the app via a deeplink URL.
- Impact: a future regression that breaks the actual URL routing (e.g., DeepLinkRouter not parsing `nexus://decisions/{id}` correctly) would not be caught by this test.
- Recommendation: add a UI test that uses `XCUIDevice.shared.system.open(URL(string: "nexus://decisions/test-id")!)` or equivalent to verify the app responds. Mark as Wave 2 since real APNs is operator-physical.
- Status: OPEN (Wave 2 hardening)

## Safe fixes applied

None — no source modifications needed.

## Acceptance gates

| Gate | Status | Evidence |
|---|---|---|
| 1. No generic user-facing cards | PASS | semantic-fixture pin tests + `GENERIC_USER_FACING_COPY` regex guards |
| 2. Every normal decision has problem + recommendation + expectedEffect + why | PASS | `decision-center-semantic-fixtures.test.ts:51-57` |
| 3. Every mutating action has preview + read-back verification | PASS | `decision-center-semantic-fixtures.test.ts:99-112` |
| 4. Every button tested or explicitly disabled | PASS | action truth table + `frontendActionState` gate + iOS `isActionable` |
| 5. Every skill has recipe or documented gap | PASS | recipe coverage table above + R4-NEW-001/004 carryover |
| 6. Home, list, detail, options, outcome, handled tested | PASS | NotificationDecisionCenterUITests covers list/detail/actioned/handled; Home covered by prior rounds |
| 7. Privacy redaction tested for Home/list/APNs | PASS | semantic fixture `safePreviewMustNotContain` + portal `safeCopyOnly` |
| 8. User/tenant switch tested | PASS via existing scope-discard | (preserved from prior rounds) |
| 9. APNs/deeplink tested or explicitly blocked | PARTIAL | scheme registered + lint test; real device tap blocked |
| 10. Screenshots produced for core states | PASS | 6 screenshots in xcresult |
| 11. Metrics/outcome ledger in place or deferred | PASS WITH CONDITIONS | basic metrics PASS, R5-NEW-001 P3 deferred |
| 12. Docs/classifier updated | PASS | `npm run docs:audit` baseline maintained |
| 13. Specialist QA completed | PASS | 10 lenses above |
| 14. Semantic fixtures exist and validated | PASS | 14/14 fixtures + 4 tests |
| 15. Action truth table exists | PASS | canonical module + tests |
| 16. Frontend contract parity tests | PASS | iOS semantic-fixture matrix at `:482` |
| 17. Cleanup completed | PASS | simulator + ports + processes clear |

## Cleanup status

- Services: not started.
- Simulators: shut down (`xcrun simctl list devices booted` empty).
- Ports 8200 / 8201 / 8203: clear.
- xcodebuild / vitest / tsx processes: none remain.
- xcresult artifact: preserved at `docs/release/qa-evidence/round5-ios-results.xcresult`.
- Engine and iOS dirty state preserved per non-negotiables (xcscheme, build/, docs/agents/, smoke-evidence/).

## Final recommendation

**Proceed with Wave 1 local QA on the `feature/decision-center-ui-orchestration-v2` branches.** Codex's READY_WITH_CONDITIONS verdict is a defensible conservative reading; my hostile QA finds no Wave-blocking issues. The 4 new R5 findings are all P3 polish items (metrics enrichment, alternatives source-of-truth clarity, screenshot export tooling, deeplink runtime test).

The four-round arc on this v2 contract is now complete:
- R1: contract + gate
- R2: closeout fidelity + integration tests
- R3: frontend state contract
- R4: rollback flag + visibility scope threading + body-battery fix
- R5: UI/UX orchestration (timeline, 14-fixture pack, action truth table, sourceTrace, portal parity)

What stays for Wave 2:
- R4-NEW-001: complete PT recipe coverage (5 of 10 done)
- R4-NEW-002: Home CTA localization
- R4-NEW-004: production owner/admin emitter
- R5-NEW-001: aggregate quality/specificity/actionability metrics
- R5-NEW-002: alternatives source-of-truth flag
- R5-NEW-003: screenshot export
- R5-NEW-004: deeplink runtime test
- DCUIV2-P2-001 (Codex): real APNs/deeplink physical validation (operator-physical)
- DCUIV2-P3-001 (Codex): design-system extraction
- DCUIV2-P3-003 (Codex): wire `retry` and `choose_priority` deterministic executors when product paths exist

## Proposed Codex prompt for Round 6 (optional, Wave 2 polish)

```
Wave 2 polish on feature/decision-center-ui-orchestration-v2 (no push,
no deploy, no TestFlight, preserve dirty xcscheme + build/ + docs/agents/
+ smoke-evidence/).

1) R5-NEW-001 (P3) — aggregate metrics enrichment
   - Extend DecisionOutcomeMetrics with averageQualityScore, genericBlockedCount,
     staleDecisionCount, duplicateSuppressedCount, explanationOpenCount/Rate.
   - All SQL aggregates must remain categorical (no raw text).
   - Add a pin test that two users in different tenants get different metric
     totals.

2) R4-NEW-001 (P2) — complete PT recipe coverage
   - Apply isPortugueseDecision(input) to contentRecipe, financeRecipe,
     cookingRecipe, chatRecipe, genericRecipe, and the
     buildLegacyDecisionLogic helpers.
   - One pin test per recipe asserting both en-US and pt-PT outputs.

3) R5-NEW-003 (P3) — screenshot export
   - Add a post-test xcresulttool export step (Bash or Swift) that pulls
     attached screenshots from the visual matrix into
     docs/release/qa-evidence/round6-screenshots/{scenario}_{locale}.png.

4) R5-NEW-002 (P3 design polish) — alternatives source-of-truth
   - Add allowSnoozeFallback: boolean to DecisionLogicRecipe (default true to
     preserve current behavior).
   - alternativesForRecord auto-adds snooze only when allowSnoozeFallback is
     true. Add a pin test verifying that a recipe with allowSnoozeFallback:
     false produces alternatives without snooze.

Defer R5-NEW-004 (deeplink runtime test) until APNs/TestFlight pass is
authorized — it needs operator-physical validation context.
```

## Round 5 prompt / process improvements

- **Semantic fixture roster as a permanent contract is genuinely useful.** Pinning 14 fixture ids in an exact ordered array (`semantic-fixtures.test.ts:25-40`) means any future re-ordering or deletion fails CI. Pattern worth repeating for any test pack that the product team agrees on.
- **Action truth table as a single source of truth.** Moving `apnsActionAllowed`, `retryAvailable`, `verifier`, `successUi` out of recipes into a dedicated module lets the frontend, portal, and analytics layer all consume the same answers. This is the right level of normalization.
- **Three-tier copy gating: recipe English ↔ PT branch ↔ portal safe-copy.** Each layer handles a different concern. Recipe localization is for end-user UX; portal safe-copy is for admin privacy. Don't conflate the two.
- **Lint-style "scheme registered" tests are not runtime tests.** Useful for catching regressions where someone deletes the Info.plist entry, but they don't prove the deeplink ACTUALLY routes. Pair them with runtime tests when feasible.

## References

- Codex implementation report: `docs/release/decision-center-ui-orchestration-v2-report.md`
- Prior QA cycles: `docs/release/decision-center-logic-v2-qa.md`
- Engine: `src/services/decision-center.ts`, `src/services/decision-center-logic-v2.ts`, `src/services/decision-center-action-truth-table.ts`, `src/portal/decision-center-routes.ts`
- Fixtures: `__tests__/fixtures/decision-center/semantic-fixtures.ts`
- Tests: `__tests__/services/decision-center-semantic-fixtures.test.ts`, `Nexus HubTests/NotificationDecisionCenterTests.swift`, `Nexus HubUITests/NotificationDecisionCenterUITests.swift`, `Nexus HubUITests/DeepLinkScopeUITests.swift`
- iOS view: `Nexus Hub/Views/Inbox/NotificationDecisionCenterView.swift`
- iOS DTO: `Nexus Hub/Core/Services/ReportService.swift`
- iOS deeplink: `Nexus Hub/Nexus_HubApp.swift`, `Info.plist`
- xcresult: `docs/release/qa-evidence/round5-ios-results.xcresult`
