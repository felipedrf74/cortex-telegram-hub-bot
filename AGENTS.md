# Nexus Hub Backend Agent Instructions

This file is the self-contained bootloader for Codex, Claude Code, and other
coding agents. Load detail only when the task needs it.

## Start

1. Run `git status --short --branch` and `npm run agent:context`.
   Read [shared development policy](docs/agents/DEVELOPMENT_PROCESS.md).
2. Read `docs/project-map.json` to locate code, tests, owners, skills, and docs.
3. Read `docs/DOCS_INDEX.md` only for the relevant domain.
4. For release work, read `docs/release/continuous-deployment.md` and
   `ops/nexus-release/README.md`. Use the `release-operator` skill for governed
   inspection/recovery or the explicitly owner-authorized PM2 first-cutover
   fallback; checked-in release projections are never runtime truth.

## Product brief (required)

Before non-trivial work, read `docs/NEXUS_HUB_PRODUCT_BRIEF.md`. Keep
AGENTS.md as the process bootloader; the brief is product truth.

## Safety

- Preserve unrelated and user-owned changes. Do not clean, reset, discard,
  commit, push, deploy, archive, or delete outside the authorized scope.
- Never use `--no-verify`, amend, force push, shared-branch rebase, or broad
  destructive cleanup without explicit approval.
- Manual production mutation, remote branch deletion, and TestFlight expiry
  require explicit owner authorization. Ordinary protected-main CD is unattended.
- Keep operational reads/writes on REST/tool contracts and use provider routing
  abstractions. Preserve tenant/user isolation, memory scope, calendar scope,
  entitlement gates, provider fallback, and cost controls.
- Never expose secrets, private logs, personal data, finance/calendar content,
  OAuth tokens, or raw provider responses.

## Implementation

- Keep evidence, inventories, profiles, and handoffs under ignored `.local/`
  paths or CI artifacts. Update a canonical current doc instead of creating a
  Markdown report.
- Treat the Training catalog as governed runtime data. Read its compact
  `catalog/training/exercise-media/v1/summary.json` before large compiled files.
- Use `.agents/skills` as the canonical project skill source. Claude skill
  entries are symlinks to the same bodies.

## Execution Continuity

Felipe freely chooses model and effort. Use
[model prompt notes](docs/agents/MODEL_GUIDANCE.md) only when relevant; never
change session settings or weaken acceptance criteria. Ask only material
questions, not a mandatory interview before every plan.

- Continue every safe, authorized, in-scope implementation, verification, and
  release step without stopping merely to report intermediate status.
- Resolve discoverable blockers and use governed alternatives before asking
  the owner. Keep progress updates non-blocking.
- Pause only when completion requires an unavailable identity, physical-device,
  legal declaration, external approval, or materially new authorization. First
  exhaust all independent work, then request one exact owner action.

## Verification

- Use `scripts/changed-area-classifier.sh --json` and `scripts/risk-gate.sh`.
- Use `npm run test:migration-hook-lint` after database-test changes.
- Use `npm run docs:audit` after documentation, agent, or skill changes.
- Use `npm run verify` or the focused commands selected by the risk gate.
- Run `npm run preflight:trust` before a trust-wide PR: lint → docs:audit → mutation with `--base origin/main` when the test-cleanup classifier requires it.
- Before ending non-trivial implementation, run the `verifiable-reward-check` skill.
  Read-only/planning answers need source review, not files created for a score.
  Verdict and hard failures outrank numeric score.

## Review Priority

Flag missing evidence for auth, tenant isolation, providers, migrations,
billing, release identity, backup/rollback, secrets, and production data as
P0/P1. Ground findings in paths, commands, and observable behavior.

## Task closeout

Use `npm run agent:task -- --help` for ownership registration and safe closeout.
The approved policy permits cleanup of registered task scratch/processes and
clean integrated local worktrees/branches after active-task/dependency checks.
Never remove dirty, unmerged, unregistered or ambiguous work.
