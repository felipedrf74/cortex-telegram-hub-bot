# Training Engine Release Candidate Risk Register

Date: 2026-04-28

## Overall Risk Posture

Current production recommendation: GO WITH CONDITIONS. Provider staging proof, cross-skill staging proof, true staging clone migration rollback proof, and runtime-model release-copy restraint are complete. Production deployment still requires a production-predeploy DB snapshot, final release-copy review, explicit owner deployment approval, and post-deploy production-safe validation.

The backend code/tests/evaluation are much stronger than the previous Training engine, and the release candidate is now a clean local artifact at `b8f9be7` with an iOS companion candidate at `537abf6`. The largest remaining risks are now deployment-process risks: production-predeploy snapshot discipline, final release-copy accuracy, post-deploy validation, and production monitoring.

## Risk Register

| ID | Severity | Area | Risk | Current evidence | Mitigation | Release status |
| --- | --- | --- | --- | --- | --- | --- |
| RC-R001 | P0 | Merge hygiene | The prior dirty worktree risk could have caused missed or over-included work. | Closed and pushed for review: backend branch head `b99098e` (code `b8f9be7`) and iOS branch head `b1aad7f` (code `537abf6`) are clean candidate commits. | Human review still required; rerun tests after any future merge conflict resolution. | Resolved for review packaging |
| RC-R002 | P0 | Calendar staging | Google Calendar lifecycle was not proven by real staging read-back. | Closed: Google run `training-calendar-smoke-20260428165035-7ljwng` passed create/update/regenerate/cancel/retry with read-back and cleanup. | Continue production-safe post-deploy monitoring. | Resolved |
| RC-R003 | P0 | Calendar staging | Outlook lifecycle was not proven by real staging read-back. | Closed: Outlook run `training-calendar-smoke-20260428165107-7fsbbr` passed create/update/regenerate/cancel/retry with read-back and cleanup. | Continue production-safe post-deploy monitoring. | Resolved |
| RC-R004 | P0 | Calendar safety | Bad identity or cleanup logic could leave duplicate/stale events or delete wrong events. | Automated tests plus real Google/Outlook provider smokes passed. | Keep ownership metadata, shape hash, provider event ID cleanup, and read-back proof in release notes. | Resolved for release gate |
| RC-R005 | P1 | Database rollback | Migration 082 has no down migration. | Local clone and true staging clone rehearsals passed; snapshot restore removed 082 columns on clone. | Take production-predeploy snapshot and keep restore command available during rollout. | Deployment condition |
| RC-R006 | P1 | Cross-skill staging | Secretary/Cooking/Finance/Content orchestration was not proven against staging data. | Closed: seeded runtime run `training-cross-skill-smoke-20260428164946-829lm7` passed; fixture cleanup verified zero rows remain. | Keep staging fixture tool gated and use only for smoke. | Resolved |
| RC-R007 | P1 | Security/tenancy | Calendar mappings, feedback, and shared context could leak or mutate cross-user if tests miss an edge. | Security review docs/tests exist in worktree; must be included and run from clean RC. | Include security tests; run full verify; review auth guards for mutations. | Must pass |
| RC-R008 | P1 | iOS compatibility | Backend richer payloads could exceed current production iOS assumptions. | Local iOS rich-fixture smoke, authenticated local E2E, DebugAuthTokenImporter tests, and full iOS scheme passed on companion candidate `537abf6`. | Keep backend fields additive; coordinate iOS companion; do not remove legacy fields; still run signed/post-deploy validation. | Improved; production proof still required |
| RC-R009 | P1 | Runtime config | GPT-5.5/high-intelligence runtime may be assumed in docs but not configured in production. | Runtime audit found Training plan generation is deterministic/rule-based and makes zero AI calls. | Avoid GPT-5.5 runtime claims in release copy. | Resolved by release-copy restraint |
| RC-R010 | P1 | Staging harness safety | Smoke tools could accidentally run against non-staging DB/calendar if guards are weak. | Harness env flags include explicit smoke/live-write flags; non-staging override exists. | Keep override disabled; enforce staging markers; document command discipline. | Must review before inclusion |
| RC-R010b | P1 | Staging harness evidence | Dry-run smoke output could be mistaken for real staging proof. | Calendar and cross-skill dry-run reports mark runtime proof as `blocked`; non-dry-run staging reports now exist and passed. | Keep non-dry-run result reports attached to release docs. | Resolved |
| RC-R011 | P2 | Generated artifacts | Generated eval reports/logs may be accidentally committed. | Generated `reports/` artifacts were removed/excluded from the packaged local candidate. | Keep generated reports out of release commits unless explicitly curated. | Resolved locally |
| RC-R012 | P2 | Performance | Larger catalog and richer payloads may increase generation/render time. | Eval harness passed; no production profiling yet. | Run verify/eval; monitor response time in staging; add timeout observability. | Monitor |
| RC-R013 | P2 | Feedback loop | Rich feedback ingestion may not be fully end-to-end adaptive in production. | Tests/docs show improved pipeline; live feedback adaptation proof is limited. | Keep backward-compatible payloads; verify feedback influences future plan in staging. | Should validate |
| RC-R014 | P2 | Weak profile prompts | Follow-up prompts could become noisy or block useful planning. | Tests planned/added; profile behavior should be conservative not blocking. | Ensure prompt dedup and safe conservative plan fallback. | Review |
| RC-R015 | P2 | Cross-skill noise | Fueling/schedule warnings could duplicate across Home, Training, Cooking, and Secretary. | Dedup work exists in docs/tests; seeded cross-skill staging smoke passed. | Monitor in production; keep warning counts in post-deploy checks. | Monitor |
| RC-R016 | P3 | Documentation drift | Many workstream docs exist; product truth may become inconsistent. | Large docs set generated during workstream. | Update only final release docs/product truth after actual release decision. | Defer until release |
| RC-R017 | P2 | Operational rollback | Operators may not know which Training switch to use during an incident. | Env switches now exist for global Training, generation, calendar writes/sync, and cross-skill publishing. | Include exact switch table in release checklist/runbook. | Improved |

## Risk-Based Release Gates

Do not release while any P0 risk remains open.

Current P0 status: **none open**.

P1 risks require either:

- a passing test/staging artifact, or
- an explicit owner waiver recorded in release notes with user impact and rollback plan.

P2/P3 risks can be deferred only if they are documented in the final release notes/open-items file.

## Highest-Risk Unknowns

1. Production-provider behavior under real user load after staged regenerate/cancel/retry proof.
2. Production-predeploy snapshot discipline for migration 082.
3. Whether current production iOS ignores all richer backend fields safely until the companion iOS release lands.
4. Whether release docs accidentally imply GPT-5.5 runtime behavior that the deployed config does not prove.

## Recommended Risk Burn-Down Order

1. Take production-predeploy DB snapshot.
2. Review final release copy for GPT-5.5/runtime claims.
3. Use one canonical backend RC branch for release.
4. Follow standard staging/promote process.
5. Run production-safe post-deploy validation and monitor provider calendar sync closely.
