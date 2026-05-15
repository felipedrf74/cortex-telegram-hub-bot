# Training Cross-Skill Staging Smoke Runbook

## Purpose

This smoke validates that Training can consume peer-skill context from Secretary, Cooking, Finance, and Content without pretending Training is an isolated plan generator.

It is a read-only staging smoke. It does not create or delete production data. It reads the selected staging user's mesh contexts, builds the Training-facing shared decision context/contracts, and verifies that the important cross-skill signals are visible and scoped.

## Audit Summary

Before adding this harness, these paths were audited:

- `src/services/training-plan-coordination.ts` consumes `SecretaryMeshContext`, `CookingMeshContext`, `FinanceMeshContext`, and `ContentMeshContext` to cap hard sessions, protect focus/filming days, avoid paid training complexity, and bias constrained weeks toward modular sessions.
- `src/services/training-signals.ts` carries user-scoped Training inputs for `calendar_conflict`, `training_schedule_stale`, `fueling_gap_risk`, `budget_remaining`, and `publishing_commitment`.
- `src/services/shared-decision-context.ts` builds Training-facing summaries/contracts from Secretary, Cooking, Finance, and Content.
- `src/services/cross-agent-learning.ts` reads peer skill context and derives schedule, fueling, finance, and content workload signals.

Existing local tests prove signal formatting and contract plumbing, but they do not prove a staging test user has real cross-skill data. This harness separates local fixture contract checks from real staging runtime checks.

## Safety Guardrails

The smoke refuses real staging reads unless all of these are present:

- `STAGING=true` or `NODE_ENV=staging`
- `TRAINING_CROSS_SKILL_STAGING_SMOKE=1`
- `TRAINING_CROSS_SKILL_STAGING_USER_ID=<staging test user id>`
- `DATABASE_PATH=<staging database path>`

`DATABASE_PATH` must look like a staging/test database path unless `TRAINING_CROSS_SKILL_ALLOW_NON_STAGING_DB=1` is set explicitly. Do not set that override for production data.

The smoke is read-only. It does not seed, mutate, or clean external calendars, task lists, meals, budgets, or content topics. If a staging flow is missing its prerequisite data, the flow is reported as blocked or failed rather than marked successful.

## Command

From the backend repo:

```bash
npm run build
TRAINING_CROSS_SKILL_STAGING_ENV_FILE=/path/to/staging.env \
TRAINING_CROSS_SKILL_STAGING_SMOKE=1 \
TRAINING_CROSS_SKILL_STAGING_USER_ID=<staging-user-id> \
TRAINING_CROSS_SKILL_STAGING_RESULTS_PATH=docs/training/cross-skill-staging-smoke-results.md \
node dist/tools/training-cross-skill-staging-smoke.js
```

Or:

```bash
TRAINING_CROSS_SKILL_STAGING_ENV_FILE=/path/to/staging.env \
TRAINING_CROSS_SKILL_STAGING_SMOKE=1 \
TRAINING_CROSS_SKILL_STAGING_USER_ID=<staging-user-id> \
scripts/training-cross-skill-staging-smoke.sh
```

Dry run:

```bash
scripts/training-cross-skill-staging-smoke.sh --dry-run
```

## Required Staging Fixture

The selected staging user should be an isolated test tenant/user with:

- Secretary: at least one busy/conflicting calendar day, optionally a travel window and focus/admin pressure.
- Cooking: meal/fueling coverage gaps around at least one hard training day.
- Finance: a constrained budget or selective training spend posture.
- Content: an active publishing/filming workload or next execution item.
- Training: an active plan/week where available, plus any content-capture opportunity if validating Training-to-Content milestone flow.

The harness can run without all fixture data, but flows without fixture data are not considered validated.

## Expected Result

The report should show `pass` for:

- `secretary_conflict`
- `cooking_fueling_gap`
- `finance_budget_constraint`
- `content_workload`
- `shared_context_scope`

`training_content_milestone` is marked `pass` only if the staging user currently has a Training `content_capture_opportunity` signal. If no such signal exists, the flow is marked `blocked` because the capability is supported but not present in the selected fixture.

## Failure Handling

If the smoke is blocked, fix the missing prerequisites listed in `docs/training/cross-skill-staging-smoke-results.md` and rerun.

If a runtime flow fails, inspect the evidence column to determine whether the failure is:

- missing staging fixture data
- an unavailable peer-skill context reader
- a broken shared-decision contract
- a user-scope leak or wrong test user
- duplicate/noisy warning output

Do not treat local fixture passes as staging validation.
