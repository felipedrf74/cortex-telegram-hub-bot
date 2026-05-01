# Cooking + Training Next-Task Execution

Date: 2026-05-01

## Selected Task

Selected task: P2 release evidence/doc drift.

Reason: Current validation found no safe P0/P1 code issue in Cooking or Training. The next highest-priority safe task was preventing release confusion by updating stale Cooking evidence and creating consolidated Cooking/Training readiness docs.

## Reproduction / Evidence

- `docs/cooking/cooking-final-report.md` still said full `npm run verify` passed `427 files / 6398 tests`.
- Current branch evidence from commit `2d887f8` and this pass says full backend verify passed `429 files / 6434 tests`.
- The same file described the portal runtime smoke before the forged-tenant stale-data clear was added.
- The requested consolidated release docs under `docs/release/cooking-training-*` did not exist.

## Implementation

Files created/updated:

- `docs/cooking/cooking-final-report.md`
- `docs/release/cooking-training-readiness-summary.md`
- `docs/release/cooking-training-open-items.md`
- `docs/release/cooking-training-next-task-execution.md`
- `docs/release/cooking-training-main-prod-go-no-go.md`

No product code changed in this task.

## Validation Before Docs

| Check | Result |
| --- | --- |
| Cooking backend typecheck | PASS |
| Cooking focused backend tests | PASS, 6 files / 69 tests |
| Cooking full backend verify | PASS in current `NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 npm run verify`, 429 files / 6434 tests |
| Training iOS build-for-testing | PASS |
| Training focused iOS tests | PASS, 59 unit + 4 UI tests |
| Cooking iOS focused tests | PASS, 15 tests |

## Validation After Docs

- `git diff --check`: PASS.
- Ports `8200` and `8326`: clear.
- Simulators: `xcrun simctl shutdown all` run; no booted devices remain.
- DB files: no `cooking-*.db` files remain.
- Runtime retest: not required for docs-only edits.

## Not Selected

- Cooking substitution apply workflow: P2 product feature, not a release-safety fix.
- Portal deep recipe/meal-plan/grocery editors: P2 product feature.
- Training provider-backed calendar smoke: requires non-production external provider credentials and should run on the exact RC/staging environment, not as a local code patch.
- Signed TestFlight/device smoke: requires physical/device distribution context, not a local code patch.

## Follow-Up Execution: Hardened Portal Auth Probe

Selected task: `CT-P2-003` hardened Cooking portal auth/session browser probe.

Reason: after the consolidated release docs landed, this was the next safe,
local release-evidence gap. The prior portal smoke proved scoped Cooking UI
behavior under the local token path, but did not prove that the browser login
fails closed when loopback bypass is disabled and signed portal sessions are
required.

Implementation:

- Updated `scripts/cooking-portal-browser-smoke.ts` to accept
  `--auth-token`, `--invalid-auth-token`, and `--probe-invalid-auth`.
- The new invalid-auth probe submits the invalid token through the real portal
  login form, waits for `/api/snapshot`, requires a `401`, verifies the visible
  `Invalid token` error, and verifies the login overlay remains visible.
- The same run then signs in with a valid `ps_` session, loads Cooking,
  writes scoped preference/pantry data, and verifies forged tenant `9002`
  still fails closed with `Load failed`.

Validation:

```bash
PORTAL_REQUIRE_SESSION_AUTH=true \
PORTAL_SESSION_SECRET=local-cooking-portal-session-secret-000000000000000000000000 \
PORTAL_ADMIN_ACTORS=local-cooking-smoke@nexushub.me \
PORTAL_ALLOW_LOCAL_BYPASS=false \
NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 \
FULL_NEXUS_STATE_DIR=.local/full-nexus-cooking-auth \
scripts/full-nexus-local-engine.sh up

PORTAL_SESSION_SECRET=local-cooking-portal-session-secret-000000000000000000000000 \
npx tsx src/tools/portal-session-token.ts \
  --actor local-cooking-smoke@nexushub.me \
  --scope admin \
  --ttl-ms 600000 \
  --json

NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 npm run smoke:cooking:portal -- \
  --base-url http://127.0.0.1:8200 \
  --auth-token '<minted ps_ session>' \
  --probe-invalid-auth \
  --user-id 2 \
  --tenant-id 2 \
  --forged-tenant-id 9002
```

Result: PASS. The invalid `ps_` session returned `401` with visible
`Invalid token`, the valid signed session loaded user/tenant `2`, forged tenant
`9002` failed closed, and `providerCallsAllowed:false`.

## Follow-Up Execution: Substitution Application Contract

Selected task: `CT-P2-001` backend in-place Cooking substitution acceptance
workflow.

Reason: after the hardened portal auth evidence gap closed, the next highest
safe local item was a P2 product-quality gap. Cooking could generate and render
reviewable substitution candidates, but there was no backend mutation contract
for a client to accept one and keep the recipe, meal copy, and shopping list
consistent.

Implementation:

- Added `applyMealPlanSubstitution` in `src/services/cooking-chef.ts`.
- Added `POST /api/v1/cooking/meal-plan/substitutions/apply`.
- The route requires `date`, `mealType`, `originalIngredient`,
  `suggestedIngredient`, and a typed reason:
  `allergy`, `dietary_restriction`, `disliked_ingredient`, or
  `expired_pantry`.
- The service finds the authenticated tenant's meal slot, updates only the
  linked scoped recipe, replaces matching meal/recipe copy without regex-based
  matching, and regenerates the tenant-scoped weekly shopping list unless the
  caller explicitly disables it.
- Body-side tenant spoofing is ignored; the authenticated route tenant remains
  the scope of truth.

Validation:

```bash
NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 npx vitest run \
  __tests__/api/cooking-routes.test.ts \
  __tests__/services/cooking-intelligence.test.ts

NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 npx tsc --noEmit
```

Result: PASS. Focused Cooking route/intelligence tests passed 2 files / 45
tests, including accepted substitution application, cross-tenant denial, and
invalid reason rejection. Typecheck passed.

## Follow-Up Execution: Portal Substitution Acceptance Panel

Selected task: partial closure of `CT-P2-002` for the substitution-acceptance
portal affordance.

Reason: after the backend substitution mutation contract landed, the next safe
portal/frontend release task was to give operators a backend-authorized way to
apply an already-reviewed safe substitution without using Chat or a manual API
client. The broader recipe-library, meal-plan, and grocery-settings deep editors
remain separate product scope.

Implementation:

- Added `POST /api/users/:userId/cooking/meal-plan/substitutions/apply` to the
  portal Cooking admin routes.
- The route is guarded by the portal admin token middleware and
  `requireOperatorTargetUser('userId')`.
- It uses the existing fail-closed portal tenant rule, so body-side
  `tenantId` cannot elevate the operator into another tenant.
- It validates required meal/substitution fields and typed reasons before
  mutation.
- It calls the tenant-scoped `applyMealPlanSubstitution` service, invalidates
  derived Cooking caches only after success, and records a portal admin mutation
  audit entry.
- Added a compact portal browser panel with meal date/type, original ingredient,
  replacement, reason, shopping-list refresh, status, and result feedback.

Validation:

```bash
NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 npx vitest run \
  __tests__/portal/portal-cooking-ui.test.ts \
  __tests__/portal/portal-cooking-routes.test.ts \
  __tests__/api/cooking-routes.test.ts

NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 npx tsc --noEmit
```

Result: PASS. Focused portal/API tests passed 3 files / 52 tests, including
guard registration, scoped substitution apply audit/invalidation, cross-tenant
denial before service access, invalid-reason rejection, portal script syntax,
and direct backend route wiring. Typecheck passed.

## Follow-Up Execution: iOS Future-State Cooking Fallback

Selected task: partial closure of `CT-P2-004` for unknown/future Cooking enum
fallback tests.

Reason: after the portal substitution acceptance panel landed, the next safe
local release task was to make the iOS Cooking rich-state decoder tolerant of
future backend meal adaptation kinds. A new backend adaptation kind previously
could have failed the whole meal-plan payload decode instead of degrading the
single unknown adaptation.

Implementation:

- Updated `CookingMealAdaptation.Kind` to conform to the shared unknown-string
  enum fallback pattern and decode unknown backend values as `.unknown`.
- Added neutral UI fallback tint/icon for unknown meal adaptations.
- Kept user-facing copy conservative: unknown adaptation kinds do not invent a
  title or detail.
- Added focused tests for unknown meal adaptation decode and unknown
  substitution reason/confidence readability.

Validation:

```bash
xcrun simctl shutdown all
xcrun simctl boot A0B13967-B5DE-4E6F-897D-F1E409093F94
xcodebuild test \
  -project "Nexus Hub.xcodeproj" \
  -scheme "Nexus Hub" \
  -destination 'id=A0B13967-B5DE-4E6F-897D-F1E409093F94' \
  -parallel-testing-enabled NO \
  -maximum-concurrent-test-simulator-destinations 1 \
  -only-testing:"Nexus HubTests/CookingPresentationTests"
```

Result: PASS. Focused iOS Cooking presentation tests passed 15/15 on iPhone 17
Pro / iOS 26.4 using a single explicit simulator UDID. No additional simulator
clones appeared during the run.
