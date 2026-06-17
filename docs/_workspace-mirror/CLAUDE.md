# CLAUDE.md - Nexus Hub Workspace Bootloader

Status: canonical
Owner: workspace lead (Felipe)
Last verified: 2026-06-07
Update policy: update when the agent workflow, read-first list, or
markdown rules change. The companion is `AGENTS.md` (Codex bootloader).

Claude Code should treat this file as a bootloader, not as the full source of
truth.

Official working path: `/Users/felipedominguez/Desktop/Nexus Hub`

## Read First

1. `docs/DOCS_INDEX.md`
2. `docs/agent/OPERATING_CONTEXT.md`
3. `docs/agent/AGENT_PROCESS_STANDARD.md`
4. `docs/agent/VERIFIABLE_REWARD_PROTOCOL.md`
5. `docs/agent/AGENT_TECHNICAL_MASTERY.md`
6. `docs/skills/SKILLS_INDEX.md`
7. `docs/release/CURRENT_RELEASE_STATE.md`
8. `docs/release/OPEN_ITEMS.md`

Then read the repo-local bootloader for the area you are changing:

- Backend: `engine/CLAUDE.md`
- iOS: `../Nexus Hub IOS/CLAUDE.md` and `ios-specs/00-CURRENT-PRODUCT-TRUTH.md`

## New Way Of Work

- Start every task by checking the active repo and branch with
  `git status --short --branch`.
- Do not clean, reset, discard, commit, push, deploy, archive, or delete user
  work unless Felipe explicitly asks for that action.
- Backend release speed comes from deduplication, not lower coverage: run full
  Vitest/pytest once per release candidate in signed CI evidence; use local,
  staging, and production gates to prove exact SHA, artifact digest, env
  parity, locks, readiness, rollback drill freshness, and staging smoke.
- Backend local pre-RC default is `npm run release:focused-verify`. Escalate to
  `npm run release:verify:full` for high-risk changes, classifier failure,
  migrations, deploy/security/auth/tenant/package/test-config/runtime-infra
  changes, or missing/invalid/stale evidence.
- Run the backend release sandbox before staging:
  `npm run release:sandbox:up`, `npm run release:sandbox:smoke`, and
  `npm run release:sandbox:deploy-harness`.
- Keep `auto-when-staged` disabled until three distinct clean signed RC
  evidence runs, a current signed rollback drill, and real staging/prod
  manifest parity exist.
- iOS release work uses the real Xcode checkout at
  `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus Hub.xcodeproj`.
  Do not release archived scaffold copies or raise the deployment target above
  iOS 18 without explicit approval.
- Documentation updates must land in canonical files or approved archive
  locations. Do not create scattered final reports, audit reports, or open
  item files.

## Working Patterns (Skills)

Both Claude and Codex follow the catalogue at
`docs/skills/SKILLS_INDEX.md`. The defaults that change everyday work:

1. **Before producing a plan for a non-trivial change**, default to
   [grill-me](docs/skills/grill-me/SKILL.md). One question at a time, each
   with a recommended answer.
2. **Before debugging anything described as flaky / lag / regression**,
   follow [diagnose](docs/skills/diagnose/SKILL.md) Phase 1 (build a
   feedback loop) before speculating.
3. **For long handoff prompts** (Claude→Codex, Codex→Claude), reach for
   [caveman](docs/skills/caveman/SKILL.md) once context is established.
4. **Hard-to-reverse decisions** captured during grilling or architecture
   review go into `docs/adr/` (see
   [docs/adr/README.md](docs/adr/README.md)). Don't ADR ephemeral
   decisions.
5. **For Nexus Hub marketing website work** (homepage, pricing, features,
   signup, onboarding, landing page), use
   [saas-ui-ux-conversion](.claude/skills/saas-ui-ux-conversion/SKILL.md).
   Companion subagents in `.claude/agents/`:
   - `saas-ux-researcher` — UX/CRO audits (read-only)
   - `conversion-copywriter` — value prop, hero copy, CTAs, FAQ
   - `frontend-design-reviewer` — post-implementation a11y/responsive review
   Deep reference docs at `docs/agent/saas-conversion/`. Website source of
   truth: `/Users/felipedominguez/Desktop/nexushub-landing-astro/` (Astro
   static export, see its `AGENTS.md`).
6. **Before ending non-trivial work**, run the
   [verifiable-reward-check](docs/skills/verifiable-reward-check/SKILL.md)
   workflow and include the reward verdict in the handoff/final answer. The
   canonical policy is `docs/agent/VERIFIABLE_REWARD_PROTOCOL.md`; verdict and
   hard failures outrank the numeric score.

## Rule For Markdown

Do not create new scattered `*-final-report.md`, `*-audit.md`, or
`*-open-items.md` files unless `docs/DOCS_INDEX.md` says that is the canonical
place for the workstream.

Update current docs first. Archive historical evidence second.

Run `cd engine && npm run docs:audit` before creating release docs or copying
verdicts, commit hashes, or test counts.
