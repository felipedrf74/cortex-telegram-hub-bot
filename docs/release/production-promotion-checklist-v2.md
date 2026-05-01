# Production Promotion Checklist V2

Date: 2026-05-01

## Preflight

- [ ] Owner explicitly approved this production promotion.
- [ ] `scripts/release-identity.sh markdown` output is captured.
- [ ] Worktree is clean.
- [ ] RC commit matches the staging artifact.
- [ ] Changed-file risk classification is recorded.
- [ ] No unresolved P0/P1 production blockers.

## Required Evidence

- [ ] Relevant focused tests passed.
- [ ] Full backend verify passed once for the RC if backend source changed.
- [ ] iOS focused/full tests passed if iOS changed.
- [ ] Staging deploy passed.
- [ ] Staging health passed.
- [ ] Focused staging smoke for changed domains passed.
- [ ] Tenant/security smoke passed if auth/data/retrieval/admin paths changed.
- [ ] Provider/calendar smoke passed if calendar/provider code changed.
- [ ] TestFlight/device smoke passed or owner accepted waiver if native iOS capabilities are in scope.

## Data And Migration Safety

- [ ] Migration files reviewed.
- [ ] Irreversible/destructive migration risk documented.
- [ ] Production DB snapshot requirement decided.
- [ ] Snapshot completed if required.
- [ ] Rollback caveats documented.

## Promotion

- [ ] Run `./scripts/promote-to-prod.sh`.
- [ ] Do not use `--skip-smoke` unless owner explicitly approves and the reason is documented.
- [ ] Capture deploy logs and version.

## Postdeploy

- [ ] Production health check passed.
- [ ] Safe test tenant/user smoke passed where applicable.
- [ ] PM2/process state checked.
- [ ] Tenant-denial/provider/calendar/model-routing logs monitored.
- [ ] Rollback command/path confirmed.
