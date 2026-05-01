# Cooking + Training - staging open blockers

Date: 2026-05-01

## Summary

The backend RC was deployed to staging and passed the focused Cooking/Training API and provider smokes. No P0 blocker was found in this pass.

The release remains conditional because production-only iOS gates and the production DB snapshot gate are not closed.

## P0

None.

## P1

### CT-P1-001 - Training iOS signed device/TestFlight validation incomplete

- Workstream: Training iOS.
- Type: iOS/frontend, production gate.
- Evidence: no signed TestFlight/device validation was run in this pass.
- Production impact: blocks unconditional production promotion.
- Affected gates:
  - fresh auth/onboarding
  - Apple Sign In
  - HealthKit/Apple Watch recognition
  - APNs token upload
  - true two-account switching
  - Training navigation on signed build
- Recommended next action:
  - Run the signed TestFlight/device checklist with a real device, Apple Sign In capable account, HealthKit/Apple Watch data path, APNs environment, and two accounts.
- Owner decision needed:
  - Either close this gate before production or explicitly accept a production waiver.

### CT-P1-002 - Production-predeploy DB snapshot required

- Workstream: Backend.
- Type: data/migration, rollback protection.
- Evidence: migrations 102-106 are in the backend candidate.
- Production impact: production promotion must not begin until a verified backup including `data/bot.db` exists.
- Recommended next action:
  - Follow `docs/release/cooking-training-production-predeploy-db-snapshot.md`.
  - Verify the backup contains `data/bot.db`.
  - Verify DB integrity from the backup copy.
  - Keep the backup location and SHA-256 in the production deploy log.

## P2

### CT-P2-001 - Portal substitution UI interaction smoke not run

- Workstream: Cooking portal.
- Type: portal/frontend smoke gap.
- Evidence: portal API substitution apply/read-back passed, and DB read-back confirmed persistence. Browser/UI interaction was not driven.
- Production impact: backend/API confidence is high, but portal UI confidence is incomplete.
- Recommended next action:
  - Run a staging browser smoke that authenticates to the portal, opens Cooking, applies a substitution from the UI, reads it back in the UI, and cleans up the test object.

## P3

None.

## Closed in this pass

- P3 documentation drift was closed by `49e7b27 docs(release): correct stale commit hashes and test counts`.
- Focused Cooking staging API smoke passed.
- Focused Training staging plan-generation smoke passed.
- Google/Outlook non-production calendar lifecycle smoke passed.
- Forged-tenant denial passed for app/API and portal route paths.
- Staging cleanup verification returned 0 rows for the run IDs checked.
