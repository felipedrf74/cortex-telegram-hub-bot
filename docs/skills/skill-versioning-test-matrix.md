# Skill Versioning Test Matrix

Date: 2026-04-29

## Tests Added

Service tests:

- `__tests__/services/skill-version-registry.test.ts`

API tests:

- Updated `__tests__/api/skills-routes.test.ts`

## Coverage Matrix

| Requirement | Coverage | Status |
|---|---|---|
| Skill version creation | `createSkillVersion()` service test and owner API route test | Covered |
| Active version lookup | `getActiveSkillVersion()` and `GET /skills/versions/:skillId` tests | Covered |
| Version status transitions | `setSkillVersionStatus()` rolled_back test | Covered |
| Rollback metadata | create/read tests assert rollback notes remain available | Covered |
| Skill capability lookup | `getAllSkillMetadata()` and seeded baseline tests | Covered |
| Tenant-specific rollout | service and API tests verify tenant rollout beats global only for matching tenant | Covered |
| Unauthorized version mutation denied | API test verifies non-owner `POST /versions` returns 403 | Covered |
| Release notes available without sensitive details | service/API tests verify `internalNotes` is redacted from public payloads/history | Covered |
| Backward compatibility for skills without explicit version metadata | fallback metadata service test | Covered |
| Existing skill behavior preserved | Existing Skills API catalog/override tests still pass | Covered |

## Commands Run

```bash
npm test -- --run __tests__/services/skill-version-registry.test.ts __tests__/api/skills-routes.test.ts
```

Result:

- PASS
- 2 files
- 26 tests

## Not Yet Covered

- Portal UI rendering of skill version metadata.
- Audit logging for owner mutations.
- Full local product smoke that displays or consumes skill version metadata.
- Release-report automation that writes registry records during release candidate preparation.
- Tenant/user rollout enforcement beyond metadata lookup. The current implementation records rollout truth but does not change skill execution behavior.

