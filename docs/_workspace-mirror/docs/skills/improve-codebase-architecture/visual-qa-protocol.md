# Visual QA Protocol

Status: canonical
Owner: workspace lead (Felipe)
Last verified: 2026-05-09
Update policy: update when a new visual-class refactor surfaces a gap this protocol didn't catch, or when iOS/SwiftUI infrastructure changes make a check redundant.

This is the visual-evidence companion to `improve-codebase-architecture/SKILL.md`. It applies to **any architecture round that touches user-visible SwiftUI views** — refactors, repository changes that affect rendering, cache changes that affect first-paint behavior, navigation/coordinator consolidations, theme/design-system changes.

It does NOT replace operator-physical real-device walkthroughs (those catch hardware-level differences in animation, haptics, and HIG conformance). It DOES replace the implicit "trust the diff" pattern that lets visual regressions slip through code review + unit tests + auth-only XCUITests.

## When this applies

| Round type | Protocol required? | Reason |
|---|---|---|
| Refactoring shared SwiftUI components/primitives | **YES** | Every consumer's rendering depends on the change. |
| Repository / cache / state-machine changes affecting first paint | **YES** | Loading / unavailable / error states are usually the regression vectors. |
| Navigation / coordinator / sheet-presentation changes | **YES** | Push/pop/dismiss behavior is invisible to code review. |
| Theme / typography / spacing tokens | **YES** | A single token bump can shift an entire screen's layout. |
| Pure backend changes that don't touch iOS rendering | NO | Engine-only rounds use the engine validation gates. |
| iOS code that only changes non-rendering paths (logging, telemetry, request coalescing internals) | NO | Unless the change has user-observable timing impact (e.g. removes a spinner). |

When in doubt, apply the protocol. The cost of running 20-40 visual cells is ~30 min of CI time. The cost of missing a visual regression in a Wave-1 cohort build is a week of operator triage.

## The visual QA matrix

For any round in scope, enumerate the matrix of cells to verify:

```
cells = visual_surfaces × per_surface_states × locales
```

For Phase 2B.1 (workspace landing state), this is:

```
5 surfaces × 3 states (warmup / unavailable+retry / content) × 2 locales = 30 cells
                       (Tasks adds slow-load = 4 states)
                       (Training adds error+retry via TrainingLoadErrorView)
                       Effective: 5 × ~3.5 × 2 = ~35 cells
```

For Phase 2B.4 (iOS Repository primitive), this would be:

```
13 repositories × 4 states (loading / cached-data / error / refreshing) × 1 locale = ~52 cells
```

You can sub-sample. **Required: every state of every surface in at least one locale, plus every copy-bearing state in both locales.** Skipping cells without justification is a finding.

## Required tests

### 1. State-forced XCUITest per cell

The app must render the target state deterministically. If a state can only be reached via real network conditions, that's a test-infrastructure finding to close before the protocol applies.

Use existing scenario-forcing mechanisms first:

- **`QualityAuditScenario`** — already wired for `tasksWorkspaceUnavailable` and `trainingWorkspaceUnavailable`. Extend to cover Cooking/Content/Finance unavailable + all domains' error+retry states.
- **`-NEXUSQA<scenario>` launch arguments** — used by existing `TrainingFixtureBypassUITests`. Extend per-domain.
- **`AuthOnboardingStubServer`** — for auth/onboarding states that need backend response shaping.

If the existing scenarios don't cover the cell, ADD a new scenario before adding the test. Don't paper over it with arbitrary mocks.

### 2. Element presence assertion

For each cell, assert the right SwiftUI elements actually appear:

```swift
// Example for Tasks unavailable+retry cell
XCTAssertTrue(app.staticTexts["tasks-unavailable-title"].waitForExistence(timeout: 3))
XCTAssertTrue(app.images["tasks-unavailable-icon"].exists)
XCTAssertTrue(app.buttons["tasks-unavailable-retry"].isHittable)
```

This requires accessibility identifiers on every element under test. **If an identifier is missing, add it before the test** — accessibility identifiers are part of the deliverable, not a test infrastructure detour.

### 3. Element-property assertion

Verify the per-domain configuration actually drives rendering:

```swift
// Example for Cooking
let icon = app.images["cooking-unavailable-icon"]
XCTAssertEqual(icon.label, "fork.knife.circle.fill")  // SF Symbol name
let title = app.staticTexts["cooking-unavailable-title"]
XCTAssertTrue(title.label.contains("Recipes unavailable") || title.label.contains("Receitas indisponíveis"))
```

This is what catches "the consolidation accidentally swapped Cooking's icon for Tasks's checkmark."

### 4. Screenshot attachment

Every test attaches a screenshot of the rendered state for visual review:

```swift
let screenshot = XCUIScreen.main.screenshot()
let attachment = XCTAttachment(screenshot: screenshot)
attachment.name = "\(domain)_\(state)_\(locale)"
attachment.lifetime = .keepAlways
add(attachment)
```

Screenshots land in the xcresult bundle. Reviewers can browse them via Xcode's test report or `xcrun xcresulttool` to spot visual drift.

This does NOT replace pixel-diff visual regression tooling (deferred to Phase 3+ unless an operator round explicitly requests it). It DOES give every run a visual paper trail.

### 5. Interaction assertion (where applicable)

For states with interactive elements, verify the interaction:

```swift
// Tap retry, verify state transitions to warmup or content
app.buttons["tasks-unavailable-retry"].tap()
XCTAssertTrue(app.otherElements["tasks-warmup-spinner"].waitForExistence(timeout: 3))
```

This is what catches "retry closure was renamed but never wired" or "retry triggers a different action than before."

### 6. Cross-locale spot check

At minimum, **every copy-bearing state runs in both en-US and pt-BR**. The launch-arg pattern:

```swift
app.launchArguments.append(contentsOf: [
    "-AppleLanguages", "(\(locale))",
    "-AppleLocale", locale,
])
```

Skipping locales is acceptable only for states with no user-visible copy (e.g. a pure spinner). When skipping, document why in the test file's header comment.

### 7. Accessibility identifier inventory

At the end of the test class, run an enumeration check:

```swift
func test_accessibilityIdentifiersInventory() {
    let app = launchAppInDefaultState()
    let expectedIdentifiers: Set<String> = [
        "tasks-warmup-title",
        "tasks-warmup-spinner",
        "tasks-unavailable-title",
        "tasks-unavailable-icon",
        "tasks-unavailable-retry",
        // ... full per-surface set
    ]
    let actualIdentifiers = Set(app.descendants(matching: .any)
        .allElementsBoundByAccessibilityElement
        .compactMap { $0.identifier.isEmpty ? nil : $0.identifier })
    let missing = expectedIdentifiers.subtracting(actualIdentifiers)
    XCTAssertTrue(missing.isEmpty, "Missing accessibility identifiers: \(missing)")
}
```

Catches the regression where a refactor drops an identifier that downstream XCUITests depend on.

## Acceptance gates per round

A visual-class architecture round is **NOT** ready for hostile-QA verdict `READY_FOR_LOCAL_QA` until:

- [ ] Every cell in the matrix has a corresponding passing XCUITest.
- [ ] Every test attaches a screenshot via `XCTAttachment(screenshot:)`.
- [ ] Accessibility identifier inventory passes.
- [ ] Cross-locale check covers at least every copy-bearing state.
- [ ] Skipped cells are documented with an explicit reason in the test file header.
- [ ] xcresult bundle path is captured in the closeout dossier.
- [ ] The hostile QA reviewer (Felipe / Claude) has spot-checked at least 3 screenshot attachments per domain.

If any gate is unmet, the verdict is at most `READY_WITH_CONDITIONS` (the condition being a follow-up commit closing the gap).

## What this protocol does NOT replace

- **Operator-physical real-device walkthrough** before Wave-1 invitations: catches haptics, animations, native-vs-simulator GPU differences, real-network timing, real-keyboard behavior. The protocol covers code-level visual correctness; operator-physical covers hardware-level fidelity.
- **Performance / responsiveness testing**: the protocol asserts what's rendered, not how fast. Use the perf branch in `/diagnose` for that.
- **Accessibility audit**: `accessibilityIdentifier` ≠ accessibility correctness. VoiceOver / Dynamic Type / contrast audit is a separate concern (Phase 3 candidate).
- **Pixel-perfect snapshot diff**: deferred. Today's protocol gives screenshots for human review; tomorrow's may diff against a baseline.

## How this composes with other skills

- **`/improve-codebase-architecture`**: this protocol is the visual-evidence acceptance gate for any visual-class candidate.
- **`/diagnose`** Phase 1 (build a feedback loop): if the bug is visual, the loop is one of the cells in this protocol. Add the cell first.
- **`/tdd`**: vertical-slice red-green-refactor where the test for "correct visual rendering" is one of the cells defined here.
- **`/grill-with-docs`**: when grilling a visual-class plan, "what's the visual QA matrix?" is one of the questions to resolve before implementation starts.

## Operational examples

### Phase 2B.1 — workspace landing state (in progress)

Matrix: 5 domains × ~3.5 states × 2 locales ≈ 35 cells.

Required follow-up commit on `phase2b1-workspace-state-module-2026-05`:
- Add `WorkspaceLandingVisualUITests` covering Tasks (4 states), Training (3 states with `TrainingLoadErrorView`), Cooking / Content / Finance (3 states each).
- Extend `QualityAuditScenario` enum with `cookingWorkspaceUnavailable`, `contentWorkspaceUnavailable`, `financeWorkspaceUnavailable`.
- Add per-state accessibility identifiers (none today on the per-state SwiftUI views).
- Both locales for every unavailable+retry and content state.

### Phase 2B.4 — iOS Repository primitive (queued)

Matrix: 13 repositories × 4 states (loading / cached-data / error / refreshing) × 1 locale ≈ 52 cells.

Will require either:
- Per-repository scenario fixtures (heavy; 13 × 4 = 52 fixtures).
- A single `RepositoryStateScenarioForcing` mechanism parameterized by repository name + state, exercising only the ones the test enumerates.

The single-mechanism approach is recommended; document the choice as part of the round.

## When to update this document

- A new visual-class skill or pattern is added — add a matrix template here.
- A test type listed above is found insufficient — extend or supersede.
- A hostile QA round catches a visual regression this protocol would not have caught — add a new required test type.
