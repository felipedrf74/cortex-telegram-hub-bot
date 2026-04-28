# Training Engine Release Candidate Risk Register

Date: 2026-04-28

## Overall Risk Posture

Current production recommendation: NO-GO until merge hygiene, provider staging proof, cross-skill staging proof, and migration rollback rehearsal are complete.

The backend code/tests/evaluation are much stronger than the previous Training engine, but the release candidate is not yet a clean artifact. The largest risks are not coach-domain logic anymore; they are release packaging, real provider calendar proof, database rollback, and staging validation.

## Risk Register

| ID | Severity | Area | Risk | Current evidence | Mitigation | Release status |
| --- | --- | --- | --- | --- | --- | --- |
| RC-R001 | P0 | Merge hygiene | The RC branch has a large dirty working tree; merging by branch pointer would miss or mispackage real work. | `release/training-engine-production-candidate` exists at `d0d0c41`; many Training files are modified/untracked. | Commit selected work in reviewable slices; keep `git status --short` clean before review. | Blocking |
| RC-R002 | P0 | Calendar staging | Google Calendar lifecycle is not proven by real staging read-back. | Staging smoke harness exists/was planned, but credentials/prereqs remain missing. | Run create/update/regenerate/cancel/retry smoke against staging Google test calendar and document event IDs/cleanup. | Blocking unless explicitly waived |
| RC-R003 | P0 | Calendar staging | Outlook lifecycle is not proven by real staging read-back. | Same as Google; provider behavior differs around body/metadata. | Run the same staging lifecycle against Outlook test calendar. | Blocking unless explicitly waived |
| RC-R004 | P0 | Calendar safety | Bad identity or cleanup logic could leave duplicate/stale events or delete wrong events. | Automated tests cover identity/reconciliation in dirty worktree; real provider proof still missing. | Require ownership metadata, shape hash, provider event ID cleanup, and read-back proof. | Blocking until staging proof |
| RC-R005 | P1 | Database rollback | Migration 082 has no down migration. | Additive SQL exists for identity/hash columns and indexes. | Take DB snapshot, rehearse staging clone migration, verify old code ignores columns. | Must complete before release |
| RC-R006 | P1 | Cross-skill staging | Secretary/Cooking/Finance/Content orchestration is not proven against staging data. | Local fixture-style cross-skill checks were documented; staging prerequisites remain blocked. | Seed test tenant and run cross-skill staging smoke. | Blocking unless explicitly waived |
| RC-R007 | P1 | Security/tenancy | Calendar mappings, feedback, and shared context could leak or mutate cross-user if tests miss an edge. | Security review docs/tests exist in worktree; must be included and run from clean RC. | Include security tests; run full verify; review auth guards for mutations. | Must pass |
| RC-R008 | P1 | iOS compatibility | Backend richer payloads could exceed current production iOS assumptions. | Local iOS rich-fixture smoke passed; authenticated local E2E remains follow-up. | Keep backend fields additive; coordinate iOS companion; do not remove legacy fields. | Must document before release |
| RC-R009 | P1 | Runtime config | GPT-5.5/high-intelligence runtime may be assumed in docs but not configured in production. | Model config proof not established in this release-plan pass. | Verify provider/model routing and avoid overstated release claims. | Must resolve release copy/config |
| RC-R010 | P1 | Staging harness safety | Smoke tools could accidentally run against non-staging DB/calendar if guards are weak. | Harness env flags include explicit smoke/live-write flags; non-staging override exists. | Keep override disabled; enforce staging markers; document command discipline. | Must review before inclusion |
| RC-R010b | P1 | Staging harness evidence | Dry-run smoke output could be mistaken for real staging proof. | Calendar and cross-skill dry-run reports now mark runtime proof as `blocked` and tests pin the behavior. | Require non-dry-run reports with staging env/test user IDs before release. | Improved; staging proof still blocking |
| RC-R011 | P2 | Generated artifacts | Generated eval reports/logs may be accidentally committed. | `reports/` exists untracked. | Exclude by default; commit only curated docs/results if needed. | Should fix before review |
| RC-R012 | P2 | Performance | Larger catalog and richer payloads may increase generation/render time. | Eval harness passed; no production profiling yet. | Run verify/eval; monitor response time in staging; add timeout observability. | Monitor |
| RC-R013 | P2 | Feedback loop | Rich feedback ingestion may not be fully end-to-end adaptive in production. | Tests/docs show improved pipeline; live feedback adaptation proof is limited. | Keep backward-compatible payloads; verify feedback influences future plan in staging. | Should validate |
| RC-R014 | P2 | Weak profile prompts | Follow-up prompts could become noisy or block useful planning. | Tests planned/added; profile behavior should be conservative not blocking. | Ensure prompt dedup and safe conservative plan fallback. | Review |
| RC-R015 | P2 | Cross-skill noise | Fueling/schedule warnings could duplicate across Home, Training, Cooking, and Secretary. | Dedup work exists in docs/tests; staging proof missing. | Run cross-skill smoke and inspect user-visible guidance. | Review |
| RC-R016 | P3 | Documentation drift | Many workstream docs exist; product truth may become inconsistent. | Large docs set generated during workstream. | Update only final release docs/product truth after actual release decision. | Defer until release |
| RC-R017 | P2 | Operational rollback | Operators may not know which Training switch to use during an incident. | Env switches now exist for global Training, generation, calendar writes/sync, and cross-skill publishing. | Include exact switch table in release checklist/runbook. | Improved |

## Risk-Based Release Gates

Do not release while any P0 risk remains open.

P1 risks require either:

- a passing test/staging artifact, or
- an explicit owner waiver recorded in release notes with user impact and rollback plan.

P2/P3 risks can be deferred only if they are documented in the final release notes/open-items file.

## Highest-Risk Unknowns

1. Real Google/Outlook provider behavior under regenerate/cancel/retry.
2. Migration rollback and old-code compatibility after identity/hash columns are added.
3. Whether staging test tenants have enough realistic cross-skill context to catch stale/noisy signal bugs.
4. Whether current production iOS ignores all richer backend fields safely.
5. Whether release docs accidentally imply GPT-5.5 runtime behavior that the deployed config does not prove.

## Recommended Risk Burn-Down Order

1. Package clean RC commits and eliminate dirty worktree risk.
2. Rehearse migration 082 on staging clone with snapshot restore.
3. Run full backend verify from clean RC.
4. Run Training eval harness from clean RC.
5. Run Google and Outlook staging calendar lifecycle smokes.
6. Run cross-skill staging smoke against test tenant.
7. Verify iOS companion compatibility status.
8. Update final release notes/product truth only after all gates are true.
