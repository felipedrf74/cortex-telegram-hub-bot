# Content Editorial Mutation Contracts

Date: 2026-04-29  
Branch: `feature/content-editorial-mutation-contracts`  
Mode: Backend implementation slice. No deployment.

## Findings

The service layer already had a strong Content lifecycle foundation:

- `content_domain_objects`
- `content_workflow_events`
- `content_approval_records`
- source provenance recording
- repurpose history
- Secretary scheduling intent handoff

The missing release-blocking gap was the app-facing mutation contract. iOS and portal could inspect parts of the state, but there was no dedicated REST path for source review, approval decisions, repurpose creation, or general editorial lifecycle actions.

## Implemented Contracts

All routes are mounted under `/api/v1/content` and require authenticated backend scope before data access.

| Route | Purpose |
| --- | --- |
| `GET /workflow/:id` | Inspect an authorized workflow object with events and approval records. |
| `POST /workflow/:id/actions` | Run lifecycle/editorial actions such as `approve_draft`, `mark_published`, `archive`, `reject`, and `schedule_content`. |
| `POST /workflow/:id/source-review` | Review references/claims, record provenance, block unauthorized references, and surface approval requirements. |
| `POST /workflow/:id/approval` | Approve or reject a pending approval gate such as publish, low-confidence sources, or tenant-shared scheduling. |
| `POST /workflow/:id/repurpose` | Create a derived content object and write tenant-scoped reuse lineage. |

## Safety Rules

- Source-review references must match the active tenant scope.
- User-private references must also match the owner user.
- Unauthorized reference submissions return `403 FORBIDDEN`.
- User-private workflow objects remain invisible to other users and return `404 NOT_FOUND`.
- Publishing still requires explicit approval; the route records approval decisions but does not externally publish.
- Repurpose creates a new scoped workflow object and `content_repurpose_history` row instead of overwriting the original.
- Content scheduling is Secretary-owned through the live `schedule_content` action path; the route now submits to Secretary, stores agenda identity, and returns scheduling feedback.

## Implementation Notes

- Added `src/api/routes/content-editorial-routes.ts`.
- Registered the route family from `src/api/routes/content.ts`.
- Extended `src/services/content-editorial-workflow.ts` with:
  - `reviewContentSources()`
  - `decideContentApproval()`
  - `repurposeContentWorkflowObject()`
  - source-review audit records
  - tenant/user reference authorization before provenance write
- Added `__tests__/api/content-editorial-routes.test.ts`.

## Tests Added

Focused API tests cover:

- Source review records grounded provenance and moves drafts to `reviewed`.
- Cross-tenant source-review references are rejected.
- Publish approval is surfaced as an explicit gate and can be approved.
- Repurpose creates a derived object and tenant-scoped reuse lineage.
- `schedule_content` creates a Secretary agenda item, stores agenda identity on the Content object, returns feedback, preserves tenant-shared approval gates, and reflows when new unavailable windows are supplied.
- Other users cannot mutate a user-private workflow object.

## Local Smoke Results

Focused local backend validation passed:

```bash
npm test -- --run __tests__/api/content-editorial-routes.test.ts __tests__/services/content-editorial-workflow.test.ts
```

Result: PASS, 2 files / 15 tests.

Wider Content API slice passed:

```bash
npm test -- --run __tests__/api/content-editorial-routes.test.ts __tests__/services/content-editorial-workflow.test.ts __tests__/api/content-reference-routes.test.ts __tests__/api/content-pipeline-routes.test.ts __tests__/api/content-home-route.test.ts
```

Result: PASS, 5 files / 29 tests.

Secretary-owned Content scheduling action smoke passed:

```bash
npm test -- --run __tests__/api/content-editorial-routes.test.ts __tests__/services/content-editorial-workflow.test.ts __tests__/services/secretary-scheduling-arbitrator.test.ts
```

Result: PASS, 3 files / 28 tests.

Typecheck passed:

```bash
npm run typecheck
```

## Open Blockers

- Full local Nexus product smoke was not rerun in this slice.
- iOS does not yet call these mutation routes.
- Portal UI does not yet expose the approval/source-review/repurpose workflow.
- iOS/portal do not yet render the returned Secretary `scheduling`, `agendaItem`, and source-skill `feedback` states.
- External publishing remains intentionally out of scope and must stay approval/audit gated.
- Live provider/source extraction quality was not sampled by this slice.

## Release-Gate Verdict

Verdict: **PASS WITH CONDITIONS** for backend mutation contracts.

The backend now exposes tenant-safe mutation contracts for source review, approvals, repurpose, and editorial actions. Do not claim full product readiness until iOS/portal wiring and full local product smoke are complete.
