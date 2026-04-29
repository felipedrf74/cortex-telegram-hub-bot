# Content Lifecycle Test Matrix

Updated: 2026-04-29  
Branch: `feature/content-creation-intelligence-upgrade`

## Focused Tests

Command:

```bash
npm test -- --run __tests__/services/content-editorial-workflow.test.ts
```

Result:

- PASS: 1 file / 9 tests.

## Coverage

| Requirement | Test Coverage | Status |
| --- | --- | --- |
| Lifecycle transitions | Idea to outline to draft records workflow events | PASS |
| Invalid transition rejected | Idea cannot jump directly to published | PASS |
| Approval required before publish | Approved draft still needs publish-specific approval | PASS |
| Approval required before tenant-shared schedule | Tenant-shared content schedule blocks until approval | PASS |
| Low-confidence source review | Weak source blocks approval | PASS |
| Unsupported claim review | Unsupported claim blocks approval | PASS |
| Deleted draft not silently lost | `delete_draft` requires approval and preserves row/state | PASS |
| Radar conversion | Shortlisted radar signal converts to idea with lineage | PASS |
| Content schedule request to Secretary | Built intent uses `sourceSkill=content` and Secretary ownership context | PASS |
| Tenant/user permission | Wrong user cannot mutate private workflow object | PASS |

## Remaining Test Gaps

- Route-level tests for future workflow APIs are pending because no public workflow route was added in this pass.
- iOS/portal approval UI tests are pending until those surfaces exist.
- Full Content generation routes still need tests proving every new output writes lifecycle and provenance rows.
- Full local product smoke remains a later release gate.
