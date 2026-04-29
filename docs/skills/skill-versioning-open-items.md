# Skill Versioning Open Items

Date: 2026-04-29
Branch: `feature/content-creation-intelligence-upgrade`

## Current Verdict

PASS WITH CONDITIONS for the foundation.

The database schema, service, read APIs, owner-only mutation APIs, baseline seeds, rollout metadata, and focused tests are implemented. This is enough to start tracking skill releases structurally. It is not yet a full operator portal workflow or automatic release pipeline.

## Closed In This Pass

- Added additive `skill_versions` and `skill_version_rollouts` tables.
- Seeded baseline active global records for Chat, Secretary, Training, Finance, Cooking, and Content Creation.
- Added `src/services/skill-version-registry.ts`.
- Added authenticated read APIs for current skill metadata and release history.
- Added owner-only create/status/activate APIs.
- Added public redaction of `internal_notes`.
- Added service and API tests.
- Verified focused tests pass.

## P1 Open Items

| Item | Why It Matters | Closure Path |
|---|---|---|
| Portal UI visibility | Operators need to inspect version, rollout, quality gate, and risks without raw private content | Add portal read-only panel backed by safe public metadata |
| Audit log for version mutations | Owner-only is necessary but support/release changes should be auditable | Record admin audit events for create/status/activate |
| Release docs integration | Registry will drift if release reports do not write or reference version records | Add version id/status lines to Chat, Secretary, Training, Content, Finance, and Cooking release docs |
| Full local smoke | Need prove full product can read registry metadata without breaking runtime | Add to next full local product smoke |
| Rollout enforcement policy | Registry currently tracks rollout truth; it does not force skill behavior by tenant/user | Decide which skill behaviors should read rollout metadata before execution |

## P2 Open Items

| Item | Why It Matters | Closure Path |
|---|---|---|
| Release automation | Manual records can be forgotten | Add release-candidate helper script that creates candidate records from docs |
| Rollback target links | Rollback notes exist; explicit target id is supported in rollout table but not exposed in API yet | Add rollback target API fields after first real rollback exercise |
| Evaluation score schema | `evaluation_results_json` is flexible but not normalized | Define per-skill rubric schema when evaluation harnesses stabilize |
| iOS display | iOS may eventually show "skill updated" or capability metadata | Add only after product UX wants it |

## P3 Open Items

| Item | Notes |
|---|---|
| Dynamic/plugin skill baseline generation | Fallback metadata works, but dynamic skills do not auto-create registry rows |
| Tenant admin version pins | Do not expose until tenant-admin permissions and support model are mature |

## Release Gate Notes

- This pass does not deploy.
- This pass does not alter live model routing.
- This pass does not alter skill enablement or entitlement behavior.
- This pass does not claim a production release is ready.

