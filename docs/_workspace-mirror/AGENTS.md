# Nexus Hub Workspace Agent Instructions

Use these instructions for Codex, Claude Code, and any coding agent working in
the Nexus Hub workspace. This is a bootloader: after reading it, open the
repo-local guidance for the area being changed.

## Workspace router

- Official workspace: `/Users/felipedominguez/Desktop/Nexus Hub`
- Backend release repo: `engine` symlink, real path
  `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot`
- iOS release repo: `ios` symlink, real Xcode release path
  `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus Hub.xcodeproj`
- iOS specs: `ios-specs`
- Website/marketing work: use the website-specific guidance below and the
  website source repo named by `CLAUDE.md`.

Read first for any product/backend/iOS release work:

1. `docs/DOCS_INDEX.md`
2. `docs/agent/OPERATING_CONTEXT.md`
3. `docs/release/CURRENT_RELEASE_STATE.md`
4. `docs/agent/VERIFIABLE_REWARD_PROTOCOL.md`
5. `docs/skills/SKILLS_INDEX.md`
6. `engine/AGENTS.md` and `engine/CLAUDE.md`
7. `ios/AGENTS.md` and `ios/CLAUDE.md` when touching iOS

## New Way Of Work

- Start every task by checking the active repo and branch with
  `git status --short --branch`.
- Do not clean, reset, discard, commit, push, deploy, archive, or delete user
  work unless Felipe explicitly asks for that action.
- Backend releases use evidence-based deduplication. Full Vitest/pytest runs
  once per release candidate in signed CI evidence; local/staging/prod gates
  prove exact SHA, artifact digest, env parity, locks, readiness, rollback
  drill freshness, and staging smoke.
- Backend local pre-RC default: `npm run release:focused-verify`. Escalate to
  `npm run release:verify:full` for high-risk changes, classifier failure,
  migrations, deploy/security/auth/tenant/package/test-config/runtime-infra
  changes, or missing/invalid/stale evidence.
- Backend pre-staging sandbox: `npm run release:sandbox:up`,
  `npm run release:sandbox:smoke`, then
  `npm run release:sandbox:deploy-harness`.
- `auto-when-staged` remains disabled until three distinct clean signed RC
  evidence runs, a current signed rollback drill, and real staging/prod
  manifest parity exist.
- iOS release work must use the real `Nexus Hub.xcodeproj` under the Developer
  checkout. Do not release the archived scaffold copy, and do not raise the
  app deployment target above iOS 18 without explicit approval.
- Documentation updates must land in canonical files or approved archive
  locations. Do not create scattered final reports, audit reports, or open
  item files.

## Verifiable Reward Loop

- V1 is a local, deterministic, RLVR-inspired feedback loop. It is not
  provider-side fine-tuning and does not train model weights.
- Before ending non-trivial work, run the
  `docs/skills/verifiable-reward-check/SKILL.md` workflow and include the
  verdict in the handoff/final answer.
- Verdict and hard-failure semantics outrank the numeric score. A high score
  cannot hide missing mandatory evidence.
- Raw reward JSON belongs under ignored `.local/reward-runs/`. Track only
  curated summaries and promoted evidence.
- Fine-tuning/eval data export requires calibration, sanitization, and manual
  review. Do not launch provider fine-tuning without Felipe's explicit approval.

## Website / Marketing Work

For Nexus Hub marketing website work, use the website-specific guidance named
by `CLAUDE.md` and the `saas-ui-ux-conversion` skill under `.claude/skills/`.
Keep this workspace bootloader focused on cross-repo engineering behavior.
