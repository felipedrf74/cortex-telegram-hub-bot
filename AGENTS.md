# Nexus Hub Backend Agent Instructions

Use these instructions for Codex and any coding agent working in the backend
repo. This is a bootloader; keep it concise and defer detail to canonical
docs.

## Read First

1. Workspace docs index:
   `/Users/felipedominguez/Desktop/Nexus Hub/docs/DOCS_INDEX.md`
2. Workspace operating context:
   `/Users/felipedominguez/Desktop/Nexus Hub/docs/agent/OPERATING_CONTEXT.md`
3. Workspace agent process standard:
   `/Users/felipedominguez/Desktop/Nexus Hub/docs/agent/AGENT_PROCESS_STANDARD.md`
4. Nexus Verifiable Reward Loop:
   `/Users/felipedominguez/Desktop/Nexus Hub/docs/agent/VERIFIABLE_REWARD_PROTOCOL.md`
5. Backend docs index: `docs/DOCS_INDEX.md`
6. Backend engineering standards index:
   `docs/engineering/ENGINEERING_STANDARDS_INDEX.md`
7. Backend Claude bootloader: `CLAUDE.md`

## Backend Rules

- Start with `git status --short --branch`.
- Do not clean, reset, discard, commit, push, deploy, archive, or delete user
  work unless Felipe explicitly asks.
- Do not use `--no-verify`, `git commit --amend`, force push, shared-branch
  rebase, or destructive cleanup without explicit approval.
- Keep operational reads/writes on REST/tool contracts. Do not fake
  token-zero behavior through chat prompts.
- Use provider routing abstractions; do not bypass them with direct provider
  calls in runtime code.
- Preserve tenant/user isolation, prompt-context scope, memory boundaries,
  calendar boundaries, and provider fallback safety.
- Do not create scattered final reports, audit reports, or open-item files
  when a canonical/current doc exists.
- Do not expose secrets, raw production logs, private user data, finance
  values, calendar contents, OAuth tokens, or provider raw responses.

## Verification

- Use `scripts/changed-area-classifier.sh --json` and
  `scripts/risk-gate.sh` to select local verification.
- Use `npm run docs:audit` before creating release docs or copying verdicts,
  commit hashes, or test counts.
- Use `npm run verify` or the focused risk-gate commands required by the
  changed area.
- Release/deploy work follows the release docs and requires explicit owner
  authorization.

## Verifiable Reward Loop

- Before ending non-trivial work, run
  `docs/agents/VERIFIABLE_REWARD_PROTOCOL.md` and the
  `verifiable-reward-check` skill.
- V1 is local, advisory, and verifier-driven. It is RLVR-inspired, but it is
  not provider-side fine-tuning and does not train model weights.
- Verdict and hard failures outrank numeric score.
- Raw reward JSON belongs under ignored `.local/reward-runs/`. Handoffs carry
  only curated summaries.

## Review Guidelines

- Flag P0/P1 risks where evidence is missing for auth, tenant isolation,
  provider routing, migrations, release gates, deploy paths, secrets, or
  production data safety.
- Treat fabricated or unsupported verification claims as blocking findings.
- Prefer comments grounded in exact file paths, commands, and observable
  behavior.
