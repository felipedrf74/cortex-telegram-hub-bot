# Production Promotion Checklist V2

Status: canonical
Owner: release lead (Felipe)
Last verified: 2026-06-16
Update policy: update only when the production-promote process changes (deploy-staging → smoke → promote-to-prod sequence).

Date: 2026-06-16

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
- [ ] Focused staging smoke for changed domains passed. Check count is
      release-dependent; use the current smoke evidence, not a historical
      17/19/22/26 count.
- [ ] Tenant/security smoke passed if auth/data/retrieval/admin paths changed.
- [ ] Provider/calendar smoke passed if calendar/provider code changed.
- [ ] Secretary agenda/provider smoke passed or is explicitly blocked with
      staging credential/live-write prerequisite details if Secretary
      arbitration, provider sync, reminders, or calendar ownership changed.
- [ ] Decision Center notification/iOS decision-surface smoke passed if
      decision delivery, notification counts, APNs, or native decision views
      changed.
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
