# Nexus Hub Branching And Release Workflow

Status: canonical
Last verified: 2026-06-16

Nexus Hub uses a **single-branch plus staging validation** workflow for the
backend. The old `develop` branch model is retired. Do not create release plans
that depend on `develop`, automatic deploy-on-merge, or GitHub-hosted SSH
deploys unless Felipe explicitly approves a process change.

## Branch Model

```
main  ───────────────────────────────────────────────► production source of truth
  │
  ├── codex/<short-task>      optional Codex work branch
  ├── feature/<short-task>    optional risky feature branch
  ├── fix/<short-task>        optional focused bug-fix branch
  └── hotfix/<short-task>     urgent production fix branch
```

| Branch | Purpose | Merge target | Notes |
|---|---|---|---|
| `main` | Production source and normal integration branch | n/a | Production deploys are still gated by staging and release docs. |
| `codex/*` | Codex-scoped implementation or QA work | `main` | Use for non-trivial work or when the user asks for a branch. |
| `feature/*` | Larger feature work | `main` | Keep short-lived and focused. |
| `fix/*` | Focused bug fix | `main` | Prefer when review isolation helps. |
| `hotfix/*` | Urgent production repair | `main` | Still requires focused validation and staging gate unless owner waives. |

Small local fixes may be made directly on `main` when the owner is driving the
work and the promote pipeline will validate before production. Do not push,
commit, deploy, or run production-impacting commands unless the user explicitly
asks.

## Normal Development Loop

```bash
# 1. Start from main
git checkout main
git pull --ff-only origin main

# 2. Optional branch for isolated work
git checkout -b codex/<short-task>

# 3. Make the change, then inspect the diff
git diff --stat
git diff

# 4. Run the required focused checks from the changed-area classifier
scripts/changed-area-classifier.sh --markdown
```

Run tests only when the task or owner asks for validation, or when the current
release/process doc requires it. When tests are run, record the exact commands
and pass/fail counts in the PR, QA report, or release evidence.

## Release Workflow

Production promotion is local-script driven:

1. Prepare/verify the candidate with the relevant release scripts from
   `DEPLOY.md` and `docs/release/production-promotion-checklist-v2.md`.
2. Deploy the exact candidate to staging with `./scripts/deploy-staging.sh`.
3. Run the required staging smoke suite. The expected check count is
   release-dependent; read `docs/release/risk-based-release-gate-matrix.md` and
   the generated smoke evidence instead of copying historical counts.
4. Promote with `./scripts/promote-to-prod.sh`.
5. Verify production health, PM2 state, public health endpoints, and any scoped
   authenticated probes required by the changed area.
6. Update `docs/release/CURRENT_RELEASE_STATE.md` and
   `docs/release/current-release-index.md`.

Do not use the retired `develop -> release/* -> main` flow.

## Commit Convention

Format:

```text
type(scope): description
```

Common types:

| Type | When |
|---|---|
| `feat` | New feature |
| `fix` | Bug fix |
| `refactor` | Code change that neither fixes nor adds behavior |
| `test` | Adding or updating tests |
| `docs` | Documentation-only change |
| `ci` | CI/CD pipeline change |
| `chore` | Maintenance, dependencies, config |
| `perf` | Performance improvement |
| `style` | Formatting only, no logic change |

Examples:

```text
feat(training): expose load snapshot read model
fix(secretary): prevent duplicate provider event retry
test(decision-center): cover terminal dedupe replay
docs(release): refresh current production state
```

## Environment Mapping

| Environment | Source | Deployment |
|---|---|---|
| Local dev | current checkout | `scripts/local-up.sh`, cockpit, focused local commands |
| Staging | exact candidate from `main` or short-lived branch | `./scripts/deploy-staging.sh` |
| Production | validated release candidate | `./scripts/promote-to-prod.sh` |

## Documentation Requirements

- Current production truth lives in `docs/release/CURRENT_RELEASE_STATE.md`.
- The active release index lives in `docs/release/current-release-index.md`.
- One-off QA reports should stay under `/tmp` or PR comments unless the release
  index intentionally links them as durable evidence.
- If branch or release rules change, update this file, `CLAUDE.md`, `DEPLOY.md`,
  and the relevant `docs/release/*` process docs in the same change.
