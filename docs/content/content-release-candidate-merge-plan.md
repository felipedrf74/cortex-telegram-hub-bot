# Content Creation Release Candidate Merge Plan

Date: 2026-04-29  
Source branch: `release/content-creation-production-candidate`

## Do Not Deploy From This Plan Alone

This plan prepares the merge path. Production promotion still requires explicit approval, fresh production DB snapshot, staging deploy, focused staging smoke, and production health checks.

## Preconditions

- P0 blockers remain closed.
- P1 conditions are either fixed or explicitly accepted in release notes.
- Test run in `content-release-candidate-test-run.md` remains current.
- Fresh production DB snapshot procedure is ready.
- Monitoring and rollback plan are reviewed.

## Merge Sequence

1. Commit Content backend, docs, migrations, tests, and skill version registry changes on `release/content-creation-production-candidate`.
2. Push the release branch.
3. Open PR/merge review against the staging/release integration branch.
4. Confirm migration order includes `095_content_creation_production_candidate_version.sql`.
5. Deploy exact RC commit to staging.
6. Run focused staging Content smoke:
   - health/auth/session
   - content home
   - references add/list
   - tenant isolation
   - generation/eval fixture mode
   - approval gates
   - skill version metadata
   - provider routing metadata
7. Record staging evidence.
8. Promote to production only after staging passes and release approval is explicit.

## Post-Merge Verification

- `content@2.0.0` still active unless production activation is intentionally performed later.
- `content@2.3.0-rc.1` exists as candidate.
- Content references remain tenant/user-scoped.
- Content eval score remains >= 85 with zero critical failures.
- No raw prompt/reference/provider-token text appears in model metadata.

## Files To Highlight In Review

- `migrations/095_content_creation_production_candidate_version.sql`
- `__tests__/services/skill-version-registry.test.ts`
- `docs/content/content-production-burndown-plan.md`
- `docs/content/content-production-open-blockers.md`
- `docs/content/content-production-readiness-criteria.md`
- `docs/content/content-release-candidate-test-run.md`
- `docs/content/content-release-candidate-risk-register.md`
- `docs/content/content-release-candidate-rollback-plan.md`
