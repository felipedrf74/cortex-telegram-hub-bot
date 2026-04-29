# Generation Quality Test Matrix

Date: 2026-04-29  
Branch: `feature/content-creation-intelligence-upgrade`

## Focused Backend Tests

Command:

```bash
npm test -- --run __tests__/services/content-generation-quality.test.ts
```

Result: PASS, 1 file / 10 tests.

## Coverage

| Area | Scenario | Status |
|---|---|---|
| Format aliases | User/platform labels normalize into ontology formats | PASS |
| Platform differentiation | YouTube long-form and LinkedIn contracts differ | PASS |
| Voice consistency | Tenant-scoped voice/brand memory appears in generation context | PASS |
| Reference grounding | Authorized references and source confidence are carried into generation | PASS |
| Unsupported claims | Unsupported claims are flagged for review | PASS |
| Refinement provenance | Refinement plan preserves source references | PASS |
| Short-form rules | Reel/short-form contract includes hook, short script, visual beats, and pacing | PASS |
| Cross-platform adaptation | Long-form draft can be planned as X/Twitter thread with target format rules | PASS |
| Low-confidence sources | Low-confidence source triggers review warnings | PASS |
| Model-routing safety | Generation context carries tenant/user metadata and excludes other-tenant references before provider calls | PASS |

## Broader Regression Target

Run before release candidate:

```bash
npm test -- --run \
  __tests__/services/content-generation-quality.test.ts \
  __tests__/services/content-radar-engine.test.ts \
  __tests__/services/content-radar-preferences.test.ts \
  __tests__/services/content-memory-profile.test.ts \
  __tests__/services/content-editorial-workflow.test.ts \
  __tests__/services/content-reference-provenance.test.ts \
  __tests__/services/content-domain-ontology.test.ts \
  __tests__/services/content-tenant-scope.test.ts
```

## Open Validation

- Real provider-backed quality evaluation not run in this pass.
- App-facing routes for all non-video formats are not complete.
- iOS and portal rendering of generation/refinement quality metadata are not validated.
- Full local Nexus product smoke remains open.
