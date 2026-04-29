# Content Memory Test Matrix

Updated: 2026-04-29  
Branch: `feature/content-creation-intelligence-upgrade`

## Focused Tests

Command:

```bash
npm test -- --run __tests__/services/content-memory-profile.test.ts
```

Result:

- PASS: 1 file / 8 tests.

## Coverage

| Requirement | Test Coverage | Status |
| --- | --- | --- |
| Tenant A voice profile not used for Tenant B | Cross-tenant profile context excludes Tenant A values | PASS |
| User-private preference not used in tenant-shared content unless allowed | Tenant-shared output omits private voice unless explicit override is set | PASS |
| Correction updates voice profile | Corrected `voice.directness` supersedes older memory | PASS |
| Stale memory downgraded | Version invalidation excludes old voice memory from default context | PASS |
| Platform-specific voice applied | YouTube context includes YouTube style and excludes LinkedIn style | PASS |
| Disliked format avoided | Suggestion filter removes disliked format | PASS |
| Successful content pattern influences suggestion | Scoring boosts matching topic, format, and hook memory | PASS |
| Rejected topic not repeated | Avoided topic/rejected pattern suggestions are filtered | PASS |
| Missing profile data asks targeted questions | Empty profile returns follow-up questions and low completeness | PASS |

## Broader Regression

This pass should be validated with the Content regression slice before release:

```bash
npm test -- --run __tests__/services/content-memory-profile.test.ts __tests__/services/skill-memory.test.ts __tests__/services/content-editorial-workflow.test.ts __tests__/services/content-reference-provenance.test.ts __tests__/services/content-domain-ontology.test.ts __tests__/services/content-tenant-scope.test.ts __tests__/api/content-reference-routes.test.ts __tests__/api/content-learning-routes.test.ts __tests__/services/content-dedup-routing.test.ts
```

## Remaining Gaps

- Route-level APIs for managing full brand profiles are not added in this pass.
- iOS and portal profile editing/readiness are still open.
- Full product smoke has not yet validated profile memory through Chat -> Content -> model fixture end to end.
