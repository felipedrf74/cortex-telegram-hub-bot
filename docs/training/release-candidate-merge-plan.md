# Training Engine Release Candidate Merge Plan

Date: 2026-04-28

## Executive Summary

Release candidate branch `release/training-engine-production-candidate` exists locally at commit `d0d0c41` (`feat(training): codex second opinion hardening`). It was created from `release/training-engine-production-hardening` and has not been pushed.

This branch is a packaging branch, not yet a deployable release artifact. The branch currently carries a large dirty working tree with the Training open-item work, staging smoke harnesses, tests, docs, and generated artifacts. Because most Training follow-up feature branches point to the same commit (`d0d0c41`), the safe release path is not to merge by branch pointer. The safe path is to commit the current work into reviewable slices on the candidate branch, excluding unsafe/staging-only/generated material.

Current production/reference baseline: `origin/main` at `a3f1b78` (`docs: record 4.14.99 Training engine overhaul release`).

Current RC branch:

```bash
git switch release/training-engine-production-candidate
git rev-parse --short HEAD
# d0d0c41
```

No production deploy, push, or merge has been performed.

## Branch Inventory

| Area | Branch/source | Current head | Status | Release decision |
| --- | --- | ---: | --- | --- |
| Current production baseline | `origin/main`, `main` | `a3f1b78` | Stable reference | Use as rollback baseline |
| Training overhaul already landed | `feature/training-engine-intelligence-and-agenda-overhaul` | local `5c276e0`, origin `08273a4` | Already merged into `main` via 4.14.99 release docs | Do not re-merge |
| Second-opinion hardening base | `release/training-engine-production-hardening` | `d0d0c41` | Local hardening branch | Source for RC packaging |
| Release candidate | `release/training-engine-production-candidate` | `d0d0c41` | Created locally; dirty worktree carried | Package here, do not push yet |
| Constrained-week work | `feature/training-constrained-week-capacity-reconciliation` | `d0d0c41` | Branch pointer only; real work dirty | Include selected files from worktree |
| Session identity work | `feature/training-session-identity-plan-version-shape-hash` | `d0d0c41` | Branch pointer only; real work dirty | Include selected files plus migration |
| Calendar staging smoke | `feature/training-calendar-staging-smoke` | `d0d0c41` | Harness/docs in worktree | Include guarded harness/docs only |
| Cross-skill staging smoke | `feature/training-cross-skill-staging-smoke` | `d0d0c41` | Harness/docs in worktree | Include guarded harness/docs only |
| Eval harness | `feature/training-engine-eval-harness` | `d0d0c41` | Tool/docs in worktree | Include harness and baseline docs, exclude generated reports unless intentionally archived |
| Catalog expansion | `feature/training-catalog-expansion` | `d0d0c41` | Catalog/data/tests in worktree | Include after schema/metadata review |
| Poor recovery variation | `feature/training-poor-recovery-variation` | `d0d0c41` | Engine/tests/docs in worktree | Include |
| Weak-profile follow-up | `feature/training-weak-profile-followup-prompts` | `d0d0c41` | Engine/tests/docs in worktree | Include |
| Schedule explanations | `feature/training-schedule-compression-explanations` | `d0d0c41` | Decision trail/docs/tests in worktree | Include |
| iOS local smoke/readiness | iOS repo `feature/ios-training-local-engine-smoke` | `f7da7b7` | Separate repository | Do not merge into backend RC; coordinate as companion iOS release |

## Merge Strategy

Because the follow-up branches are not independent commits, use a controlled packaging strategy:

1. Stay on `release/training-engine-production-candidate`.
2. Review and stage files by slice, not by `git add .`.
3. Keep each slice independently testable.
4. Exclude generated artifacts, secrets, staging env files, local databases, and unreviewed broad churn.
5. After each slice commit, run the focused test set listed below.
6. Run full backend verification before declaring the RC review-ready.
7. Keep the production release blocked until Google/Outlook staging read-back and cross-skill staging blockers are resolved or explicitly waived.

Recommended commit order:

| Order | Slice | Include | Exclude | Risk | Required tests | Status |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | Catalog depth and metadata | `src/services/coach-kernel/knowledge/**`, catalog validators/tests, catalog docs | Random unused templates, cosmetic-only catalog bloat | Medium | Catalog depth tests, planner tests, eval harness | Planned |
| 2 | Poor-recovery variation | `poor-recovery-variation.ts`, guardrails/planner hooks, recovery tests/docs | Randomized recovery selection | Medium | Poor recovery, guardrails, planner, eval poor-recovery personas | Planned |
| 3 | Profile model and follow-up prompts | `training-profile-model.ts`, route serialization, profile tests/docs | Mandatory long questionnaire UX blockers | Medium | Profile model/follow-up tests, route tests | Planned |
| 4 | Constrained-week reconciliation | `capacity-reconciliation.ts`, planner/schedule/persistence integration, constrained-week docs/tests | UI-only schedule hiding, hardcoded travel cases | High | Constrained-week, planner, calendar-sync, lifecycle tests | Planned |
| 5 | Decision reasons and compression explanations | `decision-trail.ts`, schedule explanation mapping, route/read-model fields, docs/tests | Generic duplicate copy everywhere | Medium | Decision trail, compression explanation, route tests | Planned |
| 6 | Session identity and shape hash | `training-session-identity.ts`, `migrations/082_training_session_identity_shape_hash.sql`, agenda ownership/scope/calendar provider changes, docs/tests | Broad date/title cleanup, identity matching by title only | High | Identity, agenda reconciliation, cancellation, persistence, provider marker tests | Planned |
| 7 | Security/tenant/log hardening | Logger redaction, calendar/user scoping updates, security docs/tests | Sensitive payload logging, weakened auth guards | High | Security tenancy tests, logger redaction tests, route auth tests | Planned |
| 8 | Calendar staging smoke harness | `scripts/training-calendar-staging-smoke.sh`, `src/tools/training-calendar-staging-smoke.ts`, runbook/results/open-blockers docs | Any real credentials, production calendar access, broad cleanup helpers | Low for runtime, High as release gate | Harness tests plus real staging read-back before release | Planned |
| 9 | Cross-skill staging smoke harness | `scripts/training-cross-skill-staging-smoke.sh`, `src/tools/training-cross-skill-staging-smoke.ts`, docs | Destructive cross-skill test data, production tenants | Medium | Harness tests plus staging flow validation before release | Planned |
| 10 | Evaluation harness and final docs | `src/tools/training-eval-harness.ts`, `src/services/coach-kernel/evaluation/**`, evaluation docs | Large generated `reports/` unless release artifact policy says yes | Low | Eval harness all personas, docs check | Planned |

## Files Requiring Extra Review Before Inclusion

| Path/pattern | Reason |
| --- | --- |
| `migrations/082_training_session_identity_shape_hash.sql` | Additive schema change with no down migration. Requires database snapshot rollback plan and staging clone validation. |
| `src/services/google-calendar.ts`, `src/services/outlook-calendar.ts`, `src/services/unified-calendar.ts` | Provider behavior directly affects user calendars; require staging read-back proof. |
| `src/api/routes/training-plan-calendar-sync.ts`, `src/api/routes/training-plan-cancellation.ts`, `src/services/training-agenda-reconciliation.ts` | Calendar lifecycle and deletion semantics are production-trust critical. |
| `src/services/intelligence-bus.ts`, `src/services/shared-decision-context.ts`, `src/services/cross-agent-learning.ts` | Cross-skill context must preserve tenant/user scoping and avoid noisy/stale signals. |
| `src/services/coach-kernel/knowledge/**` | Catalog expansion must remain schema-valid and actually used by selection logic. |
| `reports/**` | Generated evaluation output; keep out of production commits unless intentionally archived. |
| `docs/qa/**` | Useful QA record but should be reviewed so transient local status does not become product truth. |

## Explicit Exclusions

Do not include these unless separately reviewed and justified:

- Secrets, `.env` files, staging tokens, local OAuth tokens, provider credentials.
- Local SQLite databases, staging data exports, or temporary logs.
- Generated `reports/` artifacts by default.
- Any smoke configuration using `TRAINING_CALENDAR_STAGING_ALLOW_NON_STAGING_DB=1` or `TRAINING_CROSS_SKILL_ALLOW_NON_STAGING_DB=1`.
- Broad date-range or title-only calendar deletion utilities.
- Test-only fixture mode in production runtime paths.
- Claims that GPT-5.5 execution occurred unless provider/model config and logs prove it.
- iOS repository changes in this backend RC branch.

## Required Gates Before Review-Ready

| Gate | Required evidence | Current status |
| --- | --- | --- |
| Clean RC commits | Slices committed on `release/training-engine-production-candidate`; `git status --short` clean except intentionally ignored local files | Not done |
| Backend full verification | `npm run verify` pass on committed candidate | Last pass observed on dirty worktree: 380 files / 5981 tests |
| Training evaluation harness | Persona/scenario eval pass with result path documented | Last pass observed on dirty worktree: 99/100 |
| Google calendar staging | Real staging create/update/regenerate/cancel read-back and cleanup | Blocked/missing staging prerequisites |
| Outlook calendar staging | Real staging create/update/regenerate/cancel read-back and cleanup | Blocked/missing staging prerequisites |
| Cross-skill staging | Secretary, Cooking, Finance, Content flows against staging/test tenant | Blocked/missing staging prerequisites |
| iOS companion smoke | iOS simulator against local engine/backend or fixtures; no decode/render blockers | Local rich-fixture smoke passed; authenticated E2E remains P2 |
| Migration rehearsal | Apply migration 082 to staging clone with backup/restore evidence | Required before release |

## Do-Not-Merge List

The candidate must not be merged or pushed for production while any of these are true:

- The RC branch still has uncommitted Training code changes.
- Google or Outlook staging read-back is missing and not explicitly waived by the owner.
- Migration 082 has not been rehearsed against a database clone with rollback proof.
- Calendar cleanup uses broad date/title matching instead of ownership metadata.
- Any P0/P1 security or tenant scoping test fails.
- Any generated/test-only artifact is staged accidentally.

## Current Release Recommendation

Proceed with RC packaging on `release/training-engine-production-candidate`, but keep production status as NO-GO until the branch is cleanly sliced, provider staging gates are resolved or formally waived, and migration rollback is proven.

