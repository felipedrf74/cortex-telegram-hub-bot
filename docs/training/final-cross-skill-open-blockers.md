# Final Training Cross-Skill Open Blockers

Date: 2026-04-28  
Run ID: `training-cross-skill-smoke-20260428105013-bj5mtb`

## Production Blockers

| ID | Severity | Area | Status | Blocker | Required Resolution |
| --- | --- | --- | --- | --- | --- |
| XSKILL-P1-001 | P1 | Staging prerequisites | Open | No staging-mode env, staging smoke flag, isolated staging user ID, or staging DB path was available. | Provide a staging env file or exported vars with `STAGING=true`/`NODE_ENV=staging`, `TRAINING_CROSS_SKILL_STAGING_SMOKE=1`, `TRAINING_CROSS_SKILL_STAGING_USER_ID`, and staging/test `DATABASE_PATH`. |
| XSKILL-P1-002 | P1 | Staging fixture data | Open | No real seeded staging tenant was available to prove Secretary/Cooking/Finance/Content signals. | Seed an isolated staging user with the required cross-skill data, then rerun the smoke. |
| XSKILL-P1-003 | P1 | Runtime proof | Open | Local fixture contracts passed, but real staging runtime checks did not run. | Rerun the final gate and require runtime flow pass/blocked/fail evidence per flow. |

## Flow-Specific Blockers

| Flow | Status | Missing Proof |
| --- | --- | --- |
| Secretary conflicts | Blocked | Real staging conflict/unavailable-window signal and Training coordination reaction. |
| Cooking fueling gaps | Blocked | Real staging fueling/meal coverage gap with one useful deduped warning. |
| Finance budget constraints | Blocked | Real staging budget/equipment constraint affecting Training recommendations. |
| Content workload signals | Blocked | Real staging content workload/filming signal and Training schedule friction reaction. |
| Shared context integrity | Blocked | Live user/tenant scoping and no stale/cross-tenant signal leakage. |

## Non-Blocking Local Evidence

The local fixture path passed and remains useful regression coverage:

- Secretary conflict creates modular/reflow guidance.
- Cooking fueling gap creates one specific warning line.
- Finance budget constraint creates low-cost/selective-spend bias.
- Content workload protects filming day.
- Training can emit a `content_capture_opportunity` signal.

This evidence does not replace staging proof.

## Exact Rerun Command

```bash
npm run build
TRAINING_CROSS_SKILL_STAGING_ENV_FILE=/path/to/staging-cross-skill.env \
TRAINING_CROSS_SKILL_STAGING_RESULTS_PATH=docs/training/final-cross-skill-staging-results.md \
scripts/training-cross-skill-staging-smoke.sh
```

The env file must include or export:

```bash
STAGING=true
TRAINING_CROSS_SKILL_STAGING_SMOKE=1
TRAINING_CROSS_SKILL_STAGING_USER_ID=<isolated staging user id>
DATABASE_PATH=<staging/test db path>
```

## Current Gate Verdict

Cross-skill staging gate remains **open** and should not be marked production-ready.
