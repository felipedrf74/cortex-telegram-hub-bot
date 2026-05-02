# Cross-skill refresh and overfetch analysis

## Current behavior observed

The local engine booted with scheduler, shared context, provider routing, and app-facing routes enabled. Fixture mode prevented real provider/model calls.

Read paths inspected during this pass:

- Dashboard/Home
- Plan today/week
- Tasks/Secretary
- Training
- Connections
- Skills catalog
- Cooking/Finance/Content through smoke coverage

No direct model/provider call was observed during simple navigation reads in fixture mode.

## Main cross-skill risk

The largest confirmed issue was not a slow skill call but quota coupling: every authenticated route shared one per-user bucket. A burst of read-only cross-skill refreshes could block later reads or writes with `429`.

That risk is fixed by splitting read and mutation buckets.

## Remaining overfetch risks

### Skills catalog

The catalog is a stable read and measured about 9.2 KB locally. It should not be repeatedly fetched on every tab switch.

Recommended follow-up:

- Confirm iOS fetch cadence.
- Add ETag/short-lived cache if repeated.

### Dashboard/Home

Home aggregates multiple sections into one payload. Locally it is fast, but staging p95 should be captured because real accounts have more provider/account state.

Recommended follow-up:

- Add dependency timing around Home sub-builders.
- Track p50/p95 and payload size in staging.

### Week/Semana

Plan week/today reads were fast locally and did not require real provider calls. Calendar provider sync should remain separate from read paths.

Recommended follow-up:

- Add a staging assertion that `GET /plan/week` does not perform Google/Outlook provider read-back.

