# Content Portal Provenance, Reuse, and Historical Comparison Workflows

Date: 2026-04-29

## Audit / Findings

- Existing backend foundations already track content reference provenance, source-output links, novelty candidates, and repurpose history.
- The portal admin write surface had books, links, channels, pillars, and voice DNA contracts, but no portal-grade way to inspect provenance lineage, reuse lineage, or run deterministic historical comparison before approval.
- The richer provenance/reuse state was therefore available to backend services but hard to expose safely in a power-user portal workflow.
- Tenant/user scope remains required for all new endpoints. No frontend filtering is treated as a security boundary.

## Implementation Notes

Added tenant/user-scoped portal contracts under `/api/v1/admin/content`:

| Endpoint | Purpose | Scope behavior |
| --- | --- | --- |
| `GET /provenance` | Lists scoped output provenance, optionally filtered by `objectType` and `objectId`. | Requires explicit `userId`; filters through `contentDirectScopePredicate`. |
| `GET /provenance/review-pack` | Returns a deep portal review payload: provenance, source links, reuse lineage, and human-review signal. | Requires explicit `userId`, `objectType`, and `objectId`; all subqueries are scoped. |
| `GET /reuse-history` | Lists scoped repurpose history, or lineage where an object is either the original or reused content. | Requires explicit `userId`; scoped by tenant/user before returning lineage. |
| `POST /historical-comparison` | Runs deterministic novelty/duplicate/reuse comparison for a portal candidate. Optional `recordCandidate=true` records the candidate. | Requires write portal token and explicit `userId`; no model/provider call is made. |

Service additions:

- `listContentOutputProvenance`
- `listContentSourceOutputLinks`
- `listContentReuseLineage`

These additions preserve live model routing by avoiding provider calls entirely for portal historical comparison.

## Tests Added

Focused route tests in `__tests__/api/content-admin-write-auth.test.ts` cover:

- provenance listing uses tenant/user scoped predicates
- review pack combines provenance, source links, and reuse lineage inside the requested scope
- reuse lineage matches original or reused content id without cross-scope access
- historical comparison checks scoped historical candidates and does not record by default

## Local Smoke Results

Focused backend smoke:

```bash
npm test -- --run __tests__/api/content-admin-write-auth.test.ts
```

Actual result: PASS, 17/17 route tests.

Additional focused services:

```bash
npm test -- --run __tests__/services/content-reference-provenance.test.ts __tests__/services/content-novelty-reuse.test.ts
```

Actual result: PASS, 12/12 service tests.

Typecheck:

```bash
npm run typecheck
```

Actual result: PASS.

## Open Blockers

| Priority | Item | Status |
| --- | --- | --- |
| P1 | Portal UI does not yet render the deep provenance/reuse review pack. | Open frontend/portal surface work. |
| P1 | Full browser smoke for the new portal panels is not complete because no first-class UI has been wired yet. | Open. |
| P2 | Historical comparison currently compares against the novelty candidate ledger; legacy artifacts still need fuller backfill for broader historical coverage. | Open. |
| P2 | Review pack does not yet include visual graph layout; it provides structured data for a future graph/table UI. | Deferred. |

## Release-Gate Verdict

PASS WITH CONDITIONS for backend portal contracts.

Conditions:

- Focused backend tests and typecheck passed.
- Portal UI must still be built or updated before claiming first-class end-user portal provenance/reuse workflows.
- Legacy artifact backfill should be completed before claiming universal historical comparison coverage.
