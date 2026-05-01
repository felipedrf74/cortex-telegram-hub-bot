# Cooking + Training - staging RC smoke and production promotion gate

Date: 2026-05-01

## Executive summary

- Exact RC deployed: backend staging tree at `49e7b27` with runtime/product candidate through `2d887f8`.
- Staging environment: `serverdominguez:/home/dominguez/telegram-hub-bot-staging`, package version `4.14.107`, portal on `8201`, content engine on `8101`.
- Cooking smoke verdict: PASS WITH CONDITIONS. App-facing and portal API flows passed; portal substitution browser interaction was not run.
- Training smoke verdict: PASS WITH CONDITIONS. Staging plan generation passed, and Google/Outlook non-production lifecycle smoke passed. Signed device/TestFlight gate remains blocked.
- Tenant/security verdict: PASS for the forged-tenant probes run in this pass.
- Calendar sync verdict: PASS for non-production Google/Outlook lifecycle smoke, including duplicate prevention and cleanup.
- Training iOS signed device/TestFlight verdict: BLOCKED. No signed device/TestFlight validation was run in this pass.
- DB snapshot requirement: REQUIRED before production because migrations/data changes are in scope.
- Overall production promotion recommendation: READY_WITH_CONDITIONS. Do not promote until the listed conditions are closed and owner approval is explicit.
- Highest remaining blocker: signed device/TestFlight validation for Training iOS production-only gates.

## Documentation drift fixes

- Files changed:
  - `docs/release/cooking-training-main-prod-go-no-go.md`
  - `docs/release/cooking-training-readiness-summary.md`
  - `docs/release/cooking-training-next-task-execution.md`
- Old values:
  - backend commit references: `c8dca78` and `c01cace`
  - backend focused test count: `6 files / 61 tests`
  - Cooking iOS focused count: `13 tests`
- New values:
  - backend runtime/product candidate commit: `2d887f8`
  - backend focused test count: `6 files / 69 tests`
  - Cooking iOS focused count: `15 tests`
- Commit created: `49e7b27 docs(release): correct stale commit hashes and test counts`
- Verification:
  - Focused backend command passed: `NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 npx vitest run __tests__/services/cooking-preferences.test.ts __tests__/services/cooking-intelligence.test.ts __tests__/api/cooking-routes.test.ts __tests__/portal/portal-cooking-routes.test.ts __tests__/portal/portal-cooking-ui.test.ts __tests__/services/provider-registry-fixture-mode.test.ts`
  - Result: 6 files passed, 69 tests passed.
  - Pre-commit hook passed typecheck and full Vitest: 429 files, 6434 tests.

## RC identity and deployment evidence

- Backend branch/commit: `feature/cooking-intelligence-upgrade` at `49e7b27`.
- Backend runtime/product candidate: `2d887f8`.
- Backend dirty state before staging deploy: clean after the docs-only commit.
- Cooking iOS branch/commit: `feature/cooking-rich-state-ui` at `8a5bdad`.
- Training iOS branch/commit: `feature/training-validation-and-coach-fixes` at `173ce5b`.
- Portal/frontend branch/commit: portal code is in the backend tree at `49e7b27`.
- Artifact/version deployed: package version `4.14.107`.
- Deployment command: `./scripts/deploy-staging.sh`.
- Deployment result: PASS. Staging PM2 apps restarted; production was not touched.
- Health check result:
  - `./scripts/staging-smoke.sh -v` passed 17/17.
  - Staging content engine health passed.
  - Staging portal health passed.
  - Staging DB integrity check passed.
- Evidence deployed RC matches expected commit:
  - Local `dist/index.js` SHA-256: `42ac2467085f4f9edb6d021f0d0332cf084a591f80b2b5ab01d5fc2ad4a0d5f2`
  - Remote staging `dist/index.js` SHA-256: `42ac2467085f4f9edb6d021f0d0332cf084a591f80b2b5ab01d5fc2ad4a0d5f2`
  - Remote package version: `4.14.107`

## DB migration/data-change review

- Migrations/data changes found:
  - `migrations/102_cooking_tenant_scope_and_intelligence.sql`
  - `migrations/103_cooking_intelligence_candidate_version.sql`
  - `migrations/104_cooking_pantry_items.sql`
  - `migrations/105_cooking_preference_memory_candidate.sql`
  - `migrations/106_cooking_cross_skill_context_candidate.sql`
- Snapshot required: YES.
- Staging snapshot status: not separately taken in this pass; the staging deployment preserved staging `data/` and did not promote production.
- Production-predeploy snapshot instructions: see `docs/release/cooking-training-production-predeploy-db-snapshot.md`.
- Rollback considerations:
  - Migration 102 backfills tenant/scope metadata and quarantines userless Cooking rows.
  - Migration 104 creates a new pantry table.
  - Migrations 103, 105, and 106 mutate skill-version metadata.
  - Production rollback should use the deploy backup/restore path that includes `data/bot.db`; do not rely on down migrations for this release.

## Cooking staging smoke results

Test run IDs:

- Primary focused Cooking smoke: `ct-rc-20260501100221`
- Initial transient failed attempt: `ct-rc-20260501095133`
- Retry/probe artifacts were cleaned after verification.

### Recipe CRUD

- Result: PASS.
- IDs: staging smoke recipe and portal recipe IDs were created under test users and cleaned.
- Evidence:
  - App-facing create/read/update succeeded.
  - Read-after-update reflected the updated title/instructions.
  - Cleanup verification found 0 remaining recipes matching the run IDs.
- Issues:
  - An initial app-facing recipe create returned a transient 500 (`RangeError: Too many parameter values were provided`). The same route, service insert, and fresh authenticated retry passed without code changes. This was not reproducible after staging settled.

### Meal-plan read-back

- Result: PASS.
- IDs: smoke meal plan created under run ID and cleaned.
- Evidence:
  - Meal-plan create/read-back returned the exact smoke metadata.
  - Cleanup verification found 0 remaining meal plans matching the run IDs.
- Issues: none.

### App-facing substitution apply/read-back

- Result: PASS.
- IDs: smoke recipe/shopping list created under test user and cleaned.
- Evidence:
  - Substitution candidates were requested.
  - Substitution was applied through the app-facing API.
  - Read-back showed the selected ingredient changed from Chicken to Tofu.
  - Shopping list read-back reflected the updated substitution.
- Issues: none.

### Portal substitution apply/read-back

- Result: PASS WITH CONDITIONS.
- Portal UI used: no. Portal signed-session API and direct DB read-back were used.
- Interactions performed:
  - Created a signed `ps_` portal session.
  - Applied a substitution through the portal route.
  - Read back persisted recipe ingredients from staging DB.
- IDs: portal test recipe was cleaned.
- Evidence:
  - Portal substitution apply persisted the selected ingredient as Tempeh.
  - Cleanup verification found 0 remaining recipes matching the run IDs.
- Issues:
  - The portal browser/UI substitution path was not driven in this pass. This is a production condition if the release manager requires browser-level portal evidence.

### Pantry read/write

- Result: PASS.
- IDs: smoke pantry item created under test user and cleaned.
- Evidence:
  - Pantry item create/update/read-back succeeded.
  - Cleanup verification found 0 remaining pantry items matching the run IDs.
- Issues: none.

### Preference read/write

- Result: PASS.
- IDs: smoke preference memory created under test user and cleaned.
- Evidence:
  - Preference write/read-back succeeded using a natural food preference value.
  - A synthetic run-ID preference value was correctly rejected by memory secret guards; the smoke used a realistic value instead.
  - Cleanup removed the smoke `skill_memories` row.
- Issues: none.

### Scoped portal load

- Result: PASS.
- Tenant/user: scoped portal session for staging user 1/tenant 1.
- Evidence:
  - Cooking portal preferences route loaded for the authorized tenant.
  - Forged portal tenant access was denied.
- Issues: none.

### Forged-tenant denial

- Result: PASS.
- Request attempted:
  - Authenticated tenant A request with forged tenant B context.
  - Portal signed session with forged `tenantId=2`.
- Response:
  - App/API forged tenant header was denied with 403.
  - Portal forged tenant load was denied with 403 `FORBIDDEN_TENANT_SCOPE`.
- Evidence:
  - Body-side `tenantId` migration attempt during recipe create was ignored; stored scope stayed with the authenticated user/tenant.
- Issues: none.

## Training staging smoke results

### Plan generation

- Result: PASS.
- Plan/session IDs:
  - Test run ID: `training-rc-20260501100512`
  - Staging user: 23
  - Generated plan ID: 2
  - Total sessions: 3
- Evidence:
  - Authenticated staging user was registered.
  - Fitness profile was seeded for the test user only.
  - `POST /api/v1/training/plan/generate` returned 201.
  - `GET /api/v1/training/week` returned 200 with 3 sessions.
  - Plan was associated with the correct test user.
- Issues: none.

### Calendar sync

- Result: PASS WITH CONDITIONS.
- Provider/internal agenda:
  - For the new staging test user without a connected calendar provider, app-facing sync returned the expected safe 409 `NO_CALENDAR`.
  - Non-production provider lifecycle smoke passed for staging user 1 against Google and Outlook.
- Event IDs:
  - Google examples: `duub26vnbfadvfu2d5k862qth8`, `ll19b2bd7s7tsp0t7j1rglosvo`, `r2qmoc3c1i7bkggtuj3ldvg4vc`.
  - Outlook event IDs were created/read/updated/deleted during the provider smoke.
- Evidence:
  - Provider smoke run ID: `training-calendar-smoke-20260501100313-lkz9pi`.
  - Provider create, update, retry, replacement, cancel, and cleanup operations passed.
- Issues:
  - The isolated test user did not have provider credentials; this is expected. Provider validation was covered by the non-production provider smoke.

### No duplicate events

- Result: PASS.
- Retry/regenerate attempted:
  - Provider smoke retried sync.
  - Regenerated same-shape events.
  - Regenerated changed-shape events.
  - Replaced plans.
- Duplicate count:
  - Google and Outlook active event count stayed at 1 for retry paths.
- Stale event status:
  - Old provider events were exact-deleted during changed-shape and replacement flows.
- Evidence:
  - Provider smoke reported no cleanup failures.
- Issues: none.

## Training iOS signed device/TestFlight validation

- Environment: not available in this pass.
- Build: no signed device/TestFlight build was installed or launched.
- Auth/onboarding: BLOCKED.
- Apple Sign In: BLOCKED.
- HealthKit/Apple Watch: BLOCKED.
- APNs token upload: BLOCKED.
- Two-account switching: BLOCKED.
- Training navigation: not rerun on signed device/TestFlight in this pass.
- Blockers:
  - Requires a signed TestFlight/device build.
  - Requires Apple Sign In capable environment.
  - Requires real HealthKit/Apple Watch data path.
  - Requires APNs token upload proof.
  - Requires two accounts on device.
- Verdict: BLOCKED for production promotion until completed or explicitly waived by the owner.

## Google/Outlook non-production calendar smoke

- Required: YES.
- Reason: current backend candidate changed since the last recorded provider smoke.
- Command:
  - `TRAINING_CALENDAR_STAGING_SMOKE=1 TRAINING_CALENDAR_STAGING_ALLOW_LIVE_WRITES=1 TRAINING_CALENDAR_STAGING_USER_ID=1 TRAINING_CALENDAR_STAGING_PROVIDERS=google,outlook TRAINING_CALENDAR_STAGING_RESULTS_PATH=/tmp/training-calendar-ct-rc-smoke.md node dist/tools/training-calendar-staging-smoke.js`
- Google result: PASS.
- Outlook result: PASS.
- Event IDs: see Training calendar section above.
- Cleanup: PASS. No cleanup failures reported by the provider smoke.
- Blockers: none.

## App-facing / portal consistency

- Cooking consistency:
  - App-facing substitution apply/read-back persisted as expected.
  - Portal substitution route persisted as expected.
  - Portal substitution browser/UI was not exercised.
- Training consistency:
  - Training plan generation was readable through the app-facing weekly endpoint.
  - Calendar sync for an unconnected test user returned safe 409 `NO_CALENDAR`.
- Calendar/agenda consistency:
  - Provider lifecycle smoke verified event read-back, replacement, duplicate prevention, and cleanup.
- Tenant scope consistency:
  - App/API forged tenant denial passed.
  - Portal forged tenant denial passed.
- Issues:
  - Portal browser-level substitution interaction remains unverified.

## Cleanup status

- Test run IDs:
  - `ct-rc-20260501100221`
  - `ct-rc-20260501095133`
  - `training-rc-20260501100512`
  - `training-calendar-smoke-20260501100313-lkz9pi`
- Objects created:
  - Cooking test users/devices, recipes, meal plans, shopping lists, pantry item, preference memory.
  - Training test user/device/profile/plan/sessions.
  - Google/Outlook non-production calendar events.
- Objects cleaned:
  - Cleanup verification returned 0 rows for smoke users, Cooking run recipes, pantry rows, shopping lists, meal plans, iOS devices, Training plan 2, Training week/session rows for plan 2, and Training agenda ownership for plan 2/user 23.
  - Provider calendar smoke reported no cleanup failures.
- Objects left behind: none known.
- Manual cleanup needed: none known.
- Cleanup verdict: PASS.

## Open blockers

### P0

- None identified in this pass.

### P1

- `CT-P1-001` Training iOS signed device/TestFlight validation remains incomplete.
  - Workstream: Training iOS.
  - Evidence: no signed device/TestFlight run was available in this pass.
  - Production impact: blocks unconditional production promotion.
  - Recommended next action: run signed TestFlight/device validation for fresh auth/onboarding, Apple Sign In, HealthKit/Apple Watch recognition, APNs token upload, two-account switching, and Training navigation.

- `CT-P1-002` Production DB snapshot is required before production.
  - Workstream: Backend.
  - Evidence: migrations 102-106 and skill-version data updates are in scope.
  - Production impact: production promotion must not start without a verified predeploy backup including `data/bot.db`.
  - Recommended next action: execute and verify the production-predeploy snapshot runbook after owner approval and before production promotion.

### P2

- `CT-P2-001` Portal browser-level substitution interaction was not run.
  - Workstream: Cooking portal.
  - Evidence: portal route and DB read-back passed; browser/UI interaction was not executed.
  - Production impact: does not invalidate backend/API correctness, but limits UI confidence for portal substitution.
  - Recommended next action: run a browser-level staging portal smoke that navigates to Cooking and applies a substitution through the UI.

### P3

- None after the documentation drift commit.

## Production promotion recommendation

Recommendation: READY_WITH_CONDITIONS.

Required conditions before production:

1. Owner explicitly approves production promotion.
2. Production-predeploy DB snapshot is created, integrity-checked, and restorable according to `docs/release/cooking-training-production-predeploy-db-snapshot.md`.
3. Training iOS signed device/TestFlight gate passes or the owner explicitly accepts the waiver.
4. If portal UI confidence is required for this release, run the browser-level portal substitution smoke.
5. Run final pre-production checks immediately before promotion:
   - Confirm RC identity and clean tree.
   - Confirm staging still reports version `4.14.107` and healthy PM2 apps.
   - Confirm Google/Outlook provider credentials are non-production for smoke only.
   - Confirm production deploy path will create a backup with `data/bot.db`.

Monitoring needed after deploy:

- Cooking recipe create/update failures.
- Cooking substitution apply/read-back failures.
- Pantry/preference write failures.
- Forged tenant denial events.
- Training plan generation failures.
- Training calendar sync failures.
- Duplicate calendar event count.
- Provider fallback/model routing errors.
- Tenant authorization failures.

Rollback notes:

- Use the backup created by the production deploy path, which includes `data/bot.db`.
- Validate restore with `./scripts/rollback.sh --dry-run latest` before applying rollback when possible.
- Migration rollback should prefer DB restore over manual down-migration.

Owner approval required: YES.

## Commands run

- `git status --short`
- `git log --oneline --decorate -10`
- `NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 npx vitest run __tests__/services/cooking-preferences.test.ts __tests__/services/cooking-intelligence.test.ts __tests__/api/cooking-routes.test.ts __tests__/portal/portal-cooking-routes.test.ts __tests__/portal/portal-cooking-ui.test.ts __tests__/services/provider-registry-fixture-mode.test.ts`
- `git commit -m "docs(release): correct stale commit hashes and test counts"`
- `./scripts/deploy-staging.sh`
- `./scripts/staging-smoke.sh -v`
- Remote staging Cooking focused API/portal smoke scripts via SSH and Node.
- Remote staging Training plan generation smoke via SSH and Node.
- Remote staging Google/Outlook provider lifecycle smoke via `dist/tools/training-calendar-staging-smoke.js`.
- Remote staging cleanup verification via SSH and Node.
- `shasum -a 256 dist/index.js`
- `ssh dominguez@serverdominguez 'shasum -a 256 /home/dominguez/telegram-hub-bot-staging/dist/index.js && cd /home/dominguez/telegram-hub-bot-staging && node -p "require(\"./package.json\").version"'`
- `lsof -i :8326`
- `lsof -i :8200`
- `ps aux | grep -i '[n]exus\|[c]ooking\|[t]raining'`
- `xcrun simctl list devices booted`

## Confidence

- Overall confidence: MEDIUM-HIGH.
- What would raise confidence:
  - Signed device/TestFlight Training validation.
  - Browser-level portal substitution smoke on staging.
  - Verified production-predeploy DB snapshot immediately before promotion.
- What remains unverified:
  - Signed iOS production-only behavior.
  - Portal substitution interaction through the browser UI.
