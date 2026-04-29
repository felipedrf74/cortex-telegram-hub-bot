# Content Radar Test Matrix

Date: 2026-04-29  
Branch: `feature/content-creation-intelligence-upgrade`

## Focused Backend Tests

Command:

```bash
npm test -- --run __tests__/services/content-radar-engine.test.ts
```

Result: PASS, 1 file / 10 tests.

## Coverage

| Area | Scenario | Status |
|---|---|---|
| Tenant-safe retrieval | Tenant A cannot list Tenant B Radar signals | PASS |
| Signal scoring | Strong, fresh, on-brand signal scores above weak signal | PASS |
| Stale handling | Stale signal receives downgrade reason | PASS |
| Duplicate detection | Same topic/source family links duplicate signal IDs and penalizes novelty | PASS |
| Channel-derived signal | Channel reference creates Radar signal with provenance | PASS |
| Book-derived signal | Book reference creates Radar signal with evidence | PASS |
| Private reference safety | User cannot use another user's private reference | PASS |
| Cross-skill Training signal | Training milestone creates high-relevance opportunity | PASS |
| Secretary capacity | Low capacity reduces prioritization and explains constraint | PASS |
| Review gate | Low-confidence signal becomes `review_required` | PASS |
| Workflow conversion | Radar signal converts to tenant-scoped Content idea with lineage metadata | PASS |

## Broader Regression Target

Run before release candidate:

```bash
npm test -- --run \
  __tests__/services/content-radar-engine.test.ts \
  __tests__/services/content-radar-preferences.test.ts \
  __tests__/services/content-memory-profile.test.ts \
  __tests__/services/content-editorial-workflow.test.ts \
  __tests__/services/content-reference-provenance.test.ts \
  __tests__/services/content-domain-ontology.test.ts \
  __tests__/services/content-tenant-scope.test.ts
```

## Open Validation

- API route coverage for Radar CRUD/list/convert is not complete.
- iOS and portal Radar rendering are not validated.
- Full local Nexus product smoke has not been run.
- Real external trend/provider ingestion is not claimed in this pass.
