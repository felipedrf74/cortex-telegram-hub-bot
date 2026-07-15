# Nexus Hub Backend Agent Instructions

This file is the self-contained bootloader for Codex, Claude Code, and other
coding agents. Load detail only when the task needs it.

## Start

1. Run `git status --short --branch`.
2. Read `docs/project-map.json` to locate code, tests, owners, skills, and docs.
3. Read `docs/DOCS_INDEX.md` only for the relevant domain.
4. For release work, read `docs/release/release-state.json` and use the
   `release-operator` skill.

## Safety

- Preserve unrelated and user-owned changes. Do not clean, reset, discard,
  commit, push, deploy, archive, or delete outside the authorized scope.
- Never use `--no-verify`, amend, force push, shared-branch rebase, or broad
  destructive cleanup without explicit approval.
- Production mutation, remote branch deletion, and TestFlight expiry require
  explicit owner authorization.
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

## Verification

- Use `scripts/changed-area-classifier.sh --json` and `scripts/risk-gate.sh`.
- Use `npm run test:migration-hook-lint` after database-test changes.
- Use `npm run docs:audit` after documentation, agent, or skill changes.
- Use `npm run verify` or the focused commands selected by the risk gate.
- Before ending non-trivial work, run the `verifiable-reward-check` skill.
  Verdict and hard failures outrank numeric score.

## Review Priority

Flag missing evidence for auth, tenant isolation, providers, migrations,
billing, release identity, backup/rollback, secrets, and production data as
P0/P1. Ground findings in paths, commands, and observable behavior.
