# Cooking + Training - production promotion recommendation

Date: 2026-05-01

## Recommendation

READY_WITH_CONDITIONS.

Do not promote to production yet without closing or explicitly accepting the remaining conditions.

## Evidence supporting the recommendation

- Backend RC deployed to staging successfully.
- Staging deployed artifact matches local build hash:
  - `42ac2467085f4f9edb6d021f0d0332cf084a591f80b2b5ab01d5fc2ad4a0d5f2`
- Staging package version is `4.14.107`.
- Generic staging smoke passed 17/17.
- Focused Cooking app-facing API smoke passed:
  - recipe CRUD
  - meal-plan read-back
  - substitution apply/read-back
  - pantry read/write
  - preference read/write
  - forged-tenant denial
- Portal route-level Cooking smoke passed:
  - signed session
  - substitution apply/read-back
  - scoped load
  - forged-tenant denial
- Focused Training staging smoke passed:
  - plan generation
  - week read-back
  - safe `NO_CALENDAR` response for a test user without provider credentials
- Google/Outlook non-production calendar lifecycle smoke passed:
  - create
  - read-back
  - update
  - retry without duplicate
  - regenerate same shape
  - regenerate changed shape
  - replace plan
  - cancel/delete
  - cleanup
- Staging cleanup verification found no remaining rows for the Cooking/Training run IDs checked.

## Conditions required before production

1. Owner approval for production promotion.
2. Production-predeploy DB snapshot created and verified.
3. Training iOS signed device/TestFlight gate completed or explicitly waived:
   - fresh auth/onboarding
   - Apple Sign In
   - HealthKit/Apple Watch recognition
   - APNs token upload
   - true two-account switching
   - Training navigation on signed build
4. Decide whether portal substitution browser/UI smoke is required for this release:
   - If required, run it on staging before production.
   - If waived, note that portal API and persistence passed, but browser interaction remains unverified.
5. Confirm no production calendars or production user data will be used in any final validation.

## Final pre-production checklist

- Confirm backend branch is the intended RC:
  - `feature/cooking-intelligence-upgrade`
  - product/runtime candidate through `2d887f8`
  - release-doc correction at `49e7b27`
- Confirm Cooking iOS branch is the intended RC:
  - `feature/cooking-rich-state-ui`
  - `8a5bdad`
- Confirm Training iOS branch is the intended RC:
  - `feature/training-validation-and-coach-fixes`
  - `173ce5b`
- Confirm staging still reports package version `4.14.107`.
- Confirm staging PM2 apps are online.
- Confirm production deploy will create a backup that includes `data/bot.db`.
- Confirm rollback dry-run is available.
- Confirm monitoring is ready for:
  - Cooking write failures
  - substitution apply/read-back failures
  - pantry/preference failures
  - forged tenant denial events
  - Training plan generation failures
  - calendar sync failures
  - duplicate calendar event warnings
  - provider/model routing failures

## Production deploy instruction

Production deploy is not authorized by this report.

If the owner approves production after conditions are met, use the normal production runbook. Do not bypass:

1. focused tests/typecheck
2. staging deploy
3. staging smoke
4. production-predeploy DB snapshot
5. production promotion
6. production health
7. rollback evidence

## Rollback readiness

- Rollback path exists through `./scripts/rollback.sh`.
- Rollback must use a backup containing `data/bot.db`.
- Use `./scripts/rollback.sh --dry-run latest` before apply when possible.
- Prefer DB restore over manual down-migration for migrations 102-106.

## Final verdict

The backend/staging candidate is strong enough to continue toward production, but production promotion remains conditional.

Final recommendation: READY_WITH_CONDITIONS.
