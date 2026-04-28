# Training Engine Release Candidate Merge Plan

Date: 2026-04-28

## Executive Summary

Release candidate branch `release/training-engine-production-candidate` exists locally at commit `b8f9be7` (`feat(training): harden coach engine release gates`). It was created from `release/training-engine-production-hardening` and has not been pushed.

The prior packaging blocker is closed locally: the Training open-item work, staging smoke harnesses, tests, docs, migration, local full-product runner, and guarded operational switches are now committed into a clean local candidate. Generated `reports/` artifacts, secrets, staging env files, and local databases were excluded. This remains a local release candidate only: it still needs human review/push plus provider staging, cross-skill staging, migration rollback, and runtime-model proof before production.

Current production/reference baseline: `origin/main` at `a3f1b78` (`docs: record 4.14.99 Training engine overhaul release`).

Current RC branch:

```bash
git switch release/training-engine-production-candidate
git rev-parse --short HEAD
# b8f9be7
```

No production deploy, push, or merge has been performed.

## Branch Inventory

| Area | Branch/source | Current head | Status | Release decision |
| --- | --- | ---: | --- | --- |
| Current production baseline | `origin/main`, `main` | `a3f1b78` | Stable reference | Use as rollback baseline |
| Training overhaul already landed | `feature/training-engine-intelligence-and-agenda-overhaul` | local `5c276e0`, origin `08273a4` | Already merged into `main` via 4.14.99 release docs | Do not re-merge |
| Second-opinion hardening base | `release/training-engine-production-hardening` | `b8f9be7` | Clean local hardening branch | Source for RC review |
| Release candidate | `release/training-engine-production-candidate` | `b8f9be7` | Clean local candidate; not pushed | Review/push only after remaining gates are accepted |
| Constrained-week work | packaged in RC | `b8f9be7` | Included | Keep |
| Session identity work | packaged in RC | `b8f9be7` | Included with migration 082 | Keep; migration rollback still required |
| Calendar staging smoke | packaged in RC | `b8f9be7` | Guarded harness/docs included | Keep; real provider smoke still blocked |
| Cross-skill staging smoke | packaged in RC | `b8f9be7` | Guarded harness/docs included | Keep; real staging tenant smoke still blocked |
| Eval harness | packaged in RC | `b8f9be7` | Included; generated reports excluded | Keep |
| Catalog expansion | packaged in RC | `b8f9be7` | Included with schema/metadata tests | Keep |
| Poor recovery variation | packaged in RC | `b8f9be7` | Included | Keep |
| Weak-profile follow-up | packaged in RC | `b8f9be7` | Included | Keep |
| Schedule explanations | packaged in RC | `b8f9be7` | Included | Keep |
| iOS local smoke/readiness | iOS repo `release/ios-training-engine-local-smoke-candidate` | `537abf6` | Separate repository, clean local companion | Coordinate as companion iOS release |

## Merge Strategy

The follow-up branches have been collapsed into the clean local RC. For any future merge or push, keep the controlled packaging strategy:

1. Stay on `release/training-engine-production-candidate`.
2. Review and stage files by slice, not by `git add .`.
3. Keep each slice independently testable.
4. Exclude generated artifacts, secrets, staging env files, local databases, and unreviewed broad churn.
5. After each slice commit, run the focused test set listed below.
6. Run full backend verification before declaring the RC review-ready.
7. Keep the production release blocked until Google/Outlook staging read-back and cross-skill staging blockers are resolved or explicitly waived.

Packaging status:

| Order | Slice | Risk | Packaging status | Validation status |
| ---: | --- | --- | --- | --- |
| 1 | Catalog depth and metadata | Medium | Included in `b8f9be7`; generated reports excluded | Catalog/planner/eval tests passed |
| 2 | Poor-recovery variation | Medium | Included in `b8f9be7` | Poor recovery tests/eval passed |
| 3 | Profile model and follow-up prompts | Medium | Included in `b8f9be7` | Profile/route tests passed |
| 4 | Constrained-week reconciliation | High | Included in `b8f9be7` | Constrained-week/persistence/calendar tests passed |
| 5 | Decision reasons and compression explanations | Medium | Included in `b8f9be7` | Decision trail/route tests passed |
| 6 | Session identity and shape hash | High | Included in `b8f9be7` with migration 082 | Identity/lifecycle/calendar tests passed; migration rollback still open |
| 7 | Security/tenant/log hardening | High | Included in `b8f9be7` | Full verify passed |
| 8 | Calendar staging smoke harness | High as release gate | Included in `b8f9be7`; dry-run rows now `blocked`, not `pass` | Harness tests passed; real provider smoke blocked |
| 9 | Cross-skill staging smoke harness | Medium | Included in `b8f9be7`; dry-run rows now `blocked`, not `pass` | Harness tests passed; real staging smoke blocked |
| 10 | Evaluation harness and final docs | Low | Included in `b8f9be7`; generated `reports/` excluded | Eval passed 99/100 |

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
| Clean RC commits | Slices committed on `release/training-engine-production-candidate`; `git status --short` clean except intentionally ignored local files | Done locally at `b8f9be7` |
| Backend full verification | `npm run verify` pass on committed candidate | Passed: 382 files / 5,994 tests |
| Training evaluation harness | Persona/scenario eval pass with result path documented | Passed: 99/100, 156 cases |
| Google calendar staging | Real staging create/update/regenerate/cancel read-back and cleanup | Blocked/missing staging prerequisites |
| Outlook calendar staging | Real staging create/update/regenerate/cancel read-back and cleanup | Blocked/missing staging prerequisites |
| Cross-skill staging | Secretary, Cooking, Finance, Content flows against staging/test tenant | Blocked/missing staging prerequisites |
| iOS companion smoke | iOS simulator against local engine/backend or fixtures; no decode/render blockers | Local rich-fixture smoke and authenticated E2E passed; full iOS scheme passed |
| Migration rehearsal | Apply migration 082 to staging clone with backup/restore evidence | Required before release |

## Do-Not-Merge List

The candidate must not be merged or pushed for production while any of these are true:

- The RC branch has uncommitted Training code changes after future edits.
- Google or Outlook staging read-back is missing and not explicitly waived by the owner.
- Migration 082 has not been rehearsed against a database clone with rollback proof.
- Calendar cleanup uses broad date/title matching instead of ownership metadata.
- Any P0/P1 security or tenant scoping test fails.
- Any generated/test-only artifact is staged accidentally.

## Current Release Recommendation

Treat `b8f9be7` as the local backend RC review candidate and `537abf6` as the local iOS companion candidate. Keep production status as NO-GO until provider staging gates are resolved or formally waived, cross-skill staging is resolved or scoped, migration rollback is proven, and runtime-model claims match real configuration.
