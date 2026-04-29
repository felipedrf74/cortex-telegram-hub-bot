# Memory Test Matrix

Date: 2026-04-29

## Tests Added

Test file:

- `__tests__/services/skill-memory.test.ts`

## Coverage Matrix

| Requirement | Test Coverage | Status |
|---|---|---|
| User-private memory not visible to another user | user-private Secretary memory retrieved by owner, hidden from another user | Covered |
| Tenant memory not visible to another tenant | tenant-shared Content voice memory hidden from another tenant | Covered |
| Skill memory not retrieved by unrelated skill unless explicitly shared | Training preference hidden from Content; cross-skill signal visible only when requested | Covered |
| Stale memory is downgraded | expired Chat memory marked stale/expired and excluded by default | Covered |
| Corrected memory overrides prior memory | Secretary workout timing correction supersedes old value | Covered |
| Version migration does not leak or corrupt memory | Content schema invalidation affects one tenant only | Covered |
| Content Creation voice memory is tenant-scoped | tenant-shared Content voice memory visible in tenant only | Covered |
| Secretary schedule preference memory is applied | Secretary memory summary includes buffer preference with source/confidence | Covered |
| Training equipment preference memory is applied | Training memory summary includes equipment preference with source/confidence | Covered |
| Chat ambiguous follow-up uses safe memory or asks clarification | Chat resolves same-tenant action memory; tenant mismatch asks clarification | Covered |
| Unsafe memory values rejected | token/secret-like memory write is rejected | Covered |
| Skill boundary enforced | Finance cannot store Content voice memory | Covered |

## Commands Run

```bash
npm test -- --run __tests__/services/skill-memory.test.ts
```

Result:

- PASS
- 1 file
- 9 tests

## Additional Validation Required

- Full test suite.
- Typecheck.
- Local full-product smoke that proves Chat/Content/Secretary prompt builders use scoped memory summaries.
- iOS/portal smoke only after clients consume memory metadata.

