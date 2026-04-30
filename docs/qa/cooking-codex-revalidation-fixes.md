# Cooking - Codex re-validation + fixes

Date: 2026-05-01

## Environment and branch state

- Backend branch/commit: `feature/cooking-intelligence-upgrade` at `cf3d7af` before this pass.
- iOS Cooking branch/commit: `feature/cooking-rich-state-ui` at `7be4b6f`.
- QA reports read: `docs/qa/cooking-codex-work-validation.md` and `docs/qa/cooking-codex-work-open-findings.md` from branch `qa/cooking-codex-work-validation-20260430-2159` via `git show`; they are not present on the backend feature branch.
- Dirty working tree before changes: backend was clean at start of re-validation; iOS Cooking worktree was clean and remained unmodified.
- Services/simulators initially running: no listener on `8326` or `8200`; no booted simulator before iOS work.
- Fixture mode/model-call gating status: all local backend/smoke commands used `NEXUS_LOCAL_ALLOW_MODEL_CALLS=0`. `src/services/runtime-flags.ts:66` treats that value as model calls disabled, `src/services/provider-registry.ts:83-87` returns the local fixture provider, and `__tests__/services/provider-registry-fixture-mode.test.ts` passed.

## Phase A: re-validation

| Claim / evidence row | Result | Evidence |
|---|---|---|
| `POST /api/v1/cooking/recipes` rejects non-string `instructions` as HTTP 400 before SQLite | CONFIRMED | Existing route validation and expanded tests in `__tests__/api/cooking-routes.test.ts:210`, `:240`. Focused Cooking route tests passed. |
| `PATCH /api/v1/cooking/recipes/:id` rejects non-string `instructions` with the same shape | CONFIRMED | Existing route validation and expanded tests in `__tests__/api/cooking-routes.test.ts:260`, `:278`. Focused Cooking route tests passed. |
| `instructions = ""` remains valid | CONFIRMED | Added/passed `__tests__/api/cooking-routes.test.ts:227`; empty string returns 201 and is preserved. |
| `instructions = true`, `{}`, and `42` reject | CONFIRMED | Added/passed create and update table tests in `__tests__/api/cooking-routes.test.ts:240` and `:278`. |
| Focused Cooking tests were green | CONFIRMED | `NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 npx vitest run __tests__/api/cooking-routes.test.ts __tests__/services/cooking-preferences.test.ts __tests__/services/cooking-intelligence.test.ts __tests__/portal/portal-cooking-routes.test.ts __tests__/portal/portal-cooking-ui.test.ts __tests__/services/tool-executor.test.ts __tests__/api/auth-middleware-device-revocation.test.ts` passed: 7 files / 154 tests. |
| `npx tsc --noEmit` clean | CONFIRMED | `NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 npx tsc --noEmit` passed. |
| Local backend cleanup on `8326`/`8200` was honest | CONFIRMED | Cleanup verification at end: no listeners on `8326`/`8200`, no `cooking-*.db*`, no booted simulators. |
| iOS focused Cooking presentation tests pass | CONFIRMED | `xcodebuild test -scheme "Nexus Hub" -destination 'id=A0B13967-B5DE-4E6F-897D-F1E409093F94' -parallel-testing-enabled NO -maximum-concurrent-test-simulator-destinations 1 -only-testing:"Nexus HubTests/CookingPresentationTests"` passed: 13/13. |
| No production data/calendar/provider calls used | CONFIRMED | Fixture mode logs showed `routing(fixture)` and `fixtureMode:true`; local smoke used temporary DB/state dirs only. No production calendar/provider credentials were used. |
| No fixed GPT/Claude/Gemini/OpenAI provider hardcoded by Cooking work | CONFIRMED | Cooking source remains deterministic/provider-agnostic; fixture/provider routing tests passed. |
| Tenant scoping statically present at route/tool/data/portal layers | CONFIRMED, strengthened | Added forged tenant header and body-side tenant spoofing tests: `__tests__/api/auth-middleware-device-revocation.test.ts:195`, `__tests__/api/cooking-routes.test.ts:317`. |
| Portal preference reads sanitize private memory values | CONFIRMED | Existing `__tests__/portal/portal-cooking-routes.test.ts` passed and asserts no `memoryValue` leakage. |
| Portal admin access is guarded/audited | CONFIRMED statically/E3 unit | Existing portal route tests confirm `requirePortalAdminToken`, `requireOperatorTargetUser`, tenant rejection, and audit calls. A live forged operator browser/token probe was not available. |
| Substitution engine deterministic and reviewable | CONFIRMED with caveat | `src/services/cooking-intelligence.ts` uses deterministic rules and tests cover allergy/restriction/expired pantry. Adequate for candidate scope; still not a complete culinary ontology. |
| Cooking `1.1.0-rc.1` stays candidate, not active production | CONFIRMED | Existing docs/migration state keep `cooking@1.0.0` active until explicit promotion. |
| F-DOC-1: stale substitution test count | CONFIRMED, updated beyond Claude's number | Claude was right that `34` was stale. This pass added more adversarial tests; current focused substitution command is now 3 files / 48 tests. Updated docs accordingly. |
| F-WORDING-1: headline could be excerpted out of context | CONFIRMED | Tightened `docs/cooking/cooking-final-report.md:5` to "backend candidate PASS WITH CONDITIONS - do not promote to production from this workstream". |

## Phase B: independent findings

| Probe | Result | Evidence |
|---|---|---|
| SQL-injection-style title | PASS | Added `__tests__/api/cooking-routes.test.ts:299`; title `Robert'); DROP TABLE recipes; --` stores/searches as data. |
| TenantId body migration attempt | PASS | Added `__tests__/api/cooking-routes.test.ts:317`; body-side `tenantId:202` does not move a recipe out of auth tenant `101`; tenant `202` read returns 404. |
| Forged operator session | INCONCLUSIVE live, guarded in unit/static evidence | No local portal token harness/browser smoke config was found. Existing `__tests__/portal/portal-cooking-routes.test.ts` confirms admin and target-user guards plus tenant rejection. |
| String tenantId tool executor | PASS | Added `__tests__/services/tool-executor.test.ts:1234`; string tenant id fails closed with `TENANT_SCOPE_MISMATCH` before `getPantryItems`. |
| Regex/meta-character ingredient | PASS | Added `__tests__/services/cooking-intelligence.test.ts:228`; `(a+)+$` is treated as plain ingredient text. |
| Prototype pollution/object injection | PASS | Added `__tests__/api/cooking-routes.test.ts:339`; `__proto__` ingredient payload does not pollute `Object.prototype`. |
| Oversized payload | PASS | Added `__tests__/api/cooking-routes.test.ts:353`; reasonably oversized title/instructions are handled without crash/internal leak. |
| Fixture-mode provider escape | PASS | `__tests__/services/provider-registry-fixture-mode.test.ts` passed; local smoke logs showed `routing(fixture)` and no provider call path. |
| Full `npm run verify` | PASS after unrelated test determinism fixes | Initial run failed on May 1 date-sensitive tests in Chat/content smoke, not Cooking. Fixed tests to pin the clock/current date, then `NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 npm run verify` passed: 429 files / 6425 tests. |
| Portal smoke | PARTIAL | Static/unit portal tests passed. No Playwright config or dedicated browser smoke harness was available, so browser-level portal interaction was not claimed. |
| Full local product smoke | PASS WITH CONDITIONS | `scripts/full-nexus-local-engine.sh full-smoke` on local fixture backend passed: authenticated API smoke 13/13, Chat tenant smoke 15 pass / 1 partial / 0 fail, cross-skill fixtures PASS, Chat eval PASS, Chat day-to-day PASS. |
| API smoke | PASS | Same full local product smoke reran authenticated API smoke: 13/13. |
| iOS Cooking tests | PASS focused; unrelated full-suite failures | `CookingPresentationTests` passed 13/13. Full `Nexus HubTests` had 1009 passed / 4 failed, all in unrelated Content localization/model tests. |
| Frontend interaction validation | PARTIAL PASS | Single-simulator local backend smoke reached Home -> Areas -> Cooking, opened new recipe form, weekly agenda, shopping list, generated empty shopping list, and back navigation. Live seeded state did not expose substitution rows, so substitution rendering remains covered by unit tests rather than live UI proof. |

New findings:

- MEDIUM / P2 - Portal browser smoke remains unproven.
  - Evidence: no `playwright.config.*` or dedicated Cooking portal browser smoke command was found; only static/unit portal tests were available.
  - Recommended fix: add a repeatable local portal smoke harness for Cooking preference/pantry interactions and invalid operator/session cases.

- MEDIUM / P2 - iOS live UI did not prove backend-provided substitution rows in the current seeded state.
  - Evidence: the local UI smoke rendered Cooking empty/weekly/shopping states, but no `cooking-substitution-suggestion-row` was present in the live state. Unit tests still pass.
  - Recommended fix: add a deterministic iOS/local fixture that seeds an allergy conflict and validates visible substitution rows through UI automation.

- LOW / P3 - Unrelated iOS full-suite Content localization/model tests are red on this simulator.
  - Evidence: full `Nexus HubTests` failed 4 Content tests while CookingPresentationTests passed 13/13.
  - Recommended fix: route to Content/iOS owners; do not block Cooking backend candidate on this alone, but do not call the full iOS suite green.

## Frontend interaction validation

- iOS simulator/device/UDID used: iPhone 17 Pro / iOS 26.4 / `A0B13967-B5DE-4E6F-897D-F1E409093F94`.
- Single-device control: `xcrun simctl shutdown all` before testing, booted exactly this UDID, used UDID destination for Xcode tests, and no extra simulator clones appeared.
- iOS interactions performed:
  - Home loaded against local backend on `127.0.0.1:8200`.
  - Bottom tab -> Areas.
  - Areas -> Cooking card.
  - Opened Cooking landing screen.
  - Opened "Nova receita" form and returned.
  - Opened weekly agenda and returned.
  - Opened shopping list, tapped "Gerar da agenda", remained in safe empty-list state.
  - Verified disabled prep scheduling state is shown when no planned meals exist.
- Screenshot evidence:
  - `/tmp/nexus-cooking-ui-smoke-home-attached.png`
  - `/tmp/nexus-cooking-ui-smoke-cooking-empty.png`
  - `/tmp/nexus-cooking-ui-smoke-new-recipe.png`
  - `/tmp/nexus-cooking-ui-smoke-weekly-agenda.png`
  - `/tmp/nexus-cooking-ui-smoke-shopping-list.png`
- iOS Cooking substitution suggestions rendered: not verified live in this seeded run; verified by `CookingPresentationTests` only.
- Portal smoke environment used: none; backend unit/static portal tests only.
- Portal interactions performed: none browser-level.
- Untested frontend paths: live iOS substitution row with backend seeded allergy conflict, portal browser invalid/forged operator session, deep portal pantry/preference interactions in a real browser.
- Confidence impact: medium. Backend candidate is strong; frontend/browser proof still has two fixture gaps.

## Phase C: triage

1. P0/P1 tenant/provider safety probes - fixed/covered first. Forged tenant header, body-side tenant spoofing, string tenant id, SQL-shaped titles, prototype payload, regex ingredient, oversized text, and fixture-mode provider gate all passed with tests.
2. P3 doc findings - fixed after the probes because they were confirmed and tiny.
3. Full-suite validation - reran `npm run verify`; fixed unrelated date-sensitive tests to make the suite stable after May 1.
4. Frontend runtime smoke - ran focused iOS tests and a local single-simulator interaction smoke; documented live substitution/portal gaps instead of claiming more than observed.

Skipped-refuted:

- None. Claude's two P3 findings were confirmed, though F-DOC-1's new count is now 48 after this pass.

Skipped-out-of-scope:

- Unrelated iOS full-suite Content localization/model failures were not fixed in the Cooking workstream.
- Browser-level portal smoke was not implemented in this pass because no local Playwright/browser harness was present.

Skipped-broad-redesign:

- A complete culinary substitution ontology and portal deep editors remain P2 product work, not a safe release-gate patch.

## Phase D: implementation

### Fix 1 - Cooking adversarial route validation coverage

- Files: `__tests__/api/cooking-routes.test.ts:227`, `:240`, `:278`, `:299`, `:317`, `:339`, `:353`.
- Test: Cooking route focused vitest.
- Diff summary: added edge/adversarial coverage for empty-string instructions, primitive/object instruction rejection, SQL-shaped titles, body-side tenant spoofing, prototype-shaped ingredient payloads, and oversized recipe text.
- Focused validation result: `NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 npx vitest run __tests__/services/cooking-preferences.test.ts __tests__/services/cooking-intelligence.test.ts __tests__/api/cooking-routes.test.ts` passed: 3 files / 48 tests.

### Fix 2 - Forged active-tenant request coverage

- Files: `__tests__/api/auth-middleware-device-revocation.test.ts:80`, `:125`, `:195`.
- Test: `authMiddleware: device revocation` focused vitest.
- Diff summary: allowed the middleware helper to model request method/url and added a Cooking POST forged active-tenant header test that fails closed with 403 before route execution.
- Focused validation result: included in the 7-file focused run, passing.

### Fix 3 - Cooking tool executor tenant-id type coercion coverage

- Files: `__tests__/services/tool-executor.test.ts:1234`.
- Test: `fails closed on string-typed tenant ids for cooking tool execution`.
- Diff summary: pins that a string tenant id cannot silently coerce into a Cooking tool read; the service call is not invoked.
- Focused validation result: included in the 7-file focused run, passing.

### Fix 4 - Regex/meta-character ingredient coverage

- Files: `__tests__/services/cooking-intelligence.test.ts:228`.
- Test: `treats regex metacharacter ingredients as plain strings`.
- Diff summary: pins that the substitution/preference matching path treats regex-looking ingredient names as data.
- Focused validation result: included in the 48-test substitution command, passing.

### Fix 5 - Date-deterministic full-suite tests

- Files: `__tests__/api/chat-routes.test.ts:6`, `:403`, `:672`; `__tests__/api/app-facing-happy-path-smoke.test.ts:733`.
- Test: `npm run verify`.
- Diff summary: froze Chat route tests to the intended April 2026 clock and made the app-facing published-content mock use current date so it remains in the current month across UTC/local date boundaries.
- Focused validation result: `NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 npx vitest run __tests__/api/chat-routes.test.ts __tests__/api/app-facing-happy-path-smoke.test.ts` passed: 2 files / 47 tests.

### Fix 6 - Confirmed doc tightening

- Files: `docs/cooking/cooking-final-report.md:5`, `:32`; `docs/cooking/cooking-local-smoke-results.md:40`.
- Test: report-only plus focused substitution command.
- Diff summary: changed the headline from an excerptable GO-style phrase to a scoped backend-candidate PASS WITH CONDITIONS phrase, and updated substitution evidence to the current 48-test focused command.
- Focused validation result: substitution command passed: 3 files / 48 tests.

## Phase E: verification

- `npx tsc --noEmit`: PASS.
- Cooking focused vitest:
  - 3-file substitution command: PASS, 48 tests.
  - 7-file focused Cooking/security/tool/API command: PASS, 154 tests.
- New tests: all new Cooking/auth/tool adversarial tests above passed.
- `npm run verify`: PASS after date-determinism fixes, 429 files / 6425 tests, about 538 seconds.
- Authenticated API smoke: PASS, 13/13 via `scripts/full-nexus-local-engine.sh full-smoke`.
- Portal smoke: static/unit portal tests passed; browser-level portal smoke not available.
- iOS CookingPresentationTests: PASS, 13/13 on selected iPhone 17 Pro simulator.
- Full Nexus HubTests: FAIL unrelated to Cooking, 1009 passed / 4 failed in Content localization/model tests.
- Cleanup status: PASS.
- Ports/processes/DB files: no listeners on `8200` or `8326`; no Nexus/Cooking processes except the verification grep itself; no `cooking-*.db*` files remain.
- Simulator cleanup: `xcrun simctl shutdown all` run; no booted simulators remain.

## Decisions / pushbacks

- I did not trust Claude's reports as ground truth. They were read from the QA branch and re-checked with focused tests, full verify, local engine smoke, and iOS tests.
- I did not implement a live portal Playwright smoke because no project Playwright config or dedicated browser smoke command was present; adding a new harness is useful but not a low-risk release-gate patch.
- I did not modify iOS code because the focused Cooking presentation tests passed and the live UI issue is fixture/evidence coverage, not a confirmed UI bug.
- I did not fix unrelated full-suite iOS Content failures in the Cooking workstream.

## Remaining blockers and conditions

- P0: none found in this pass.
- P1: none found in this pass.
- P2:
  - Browser-level Cooking portal smoke remains missing.
  - Live iOS substitution-row proof needs a deterministic seeded fixture.
  - Substitution acceptance/replacement workflow remains product follow-up.
  - Portal deep recipe/meal-plan/grocery editors remain future work.
- P3:
  - Unrelated iOS Content localization/model failures should be triaged by the Content/iOS owner.

## Confidence

- Overall confidence in shipped state: MEDIUM.
- Conditions remaining before production promotion:
  - Normal staging gate, staging smoke, and production health checks.
  - Browser-level Cooking portal smoke or documented acceptance.
  - Deterministic live iOS fixture proving substitution rows from backend data.
  - Real-provider quality sampling only if explicitly approved and controlled.
- What would raise confidence to HIGH:
  - Add/run a portal browser smoke with invalid operator/session probes.
  - Add/run an iOS seeded Cooking fixture that renders backend substitution candidates.
  - Confirm staging Cooking smoke with the exact release candidate.
