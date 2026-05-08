# AGENTS.md - Nexus Hub Workspace Bootloader

Status: canonical
Owner: workspace lead (Felipe)
Last verified: 2026-05-04
Update policy: update when the agent workflow, repo map, or workspace
safety rules change. Removing a safety rule requires owner approval.

Official working path: `/Users/felipedominguez/Desktop/Nexus Hub`

## Start Here

Before creating or changing markdown, read:

1. `docs/DOCS_INDEX.md`
2. `docs/agent/OPERATING_CONTEXT.md`
3. `docs/agent/AGENT_PROCESS_STANDARD.md`
4. `docs/agent/AGENT_TECHNICAL_MASTERY.md`
5. `docs/skills/SKILLS_INDEX.md`
6. `docs/release/CURRENT_RELEASE_STATE.md`
7. `docs/release/OPEN_ITEMS.md`

## Working Patterns (Skills)

Codex follows the catalogue at `docs/skills/SKILLS_INDEX.md`. Defaults
that change everyday work:

1. **Before non-trivial planning**, default to
   [grill-me](docs/skills/grill-me/SKILL.md) — one question at a time,
   each with a recommended answer. Misalignment caught at planning time
   costs one conversation; misalignment caught after implementation costs
   the whole round trip.
2. **Before debugging flaky / lag / regression issues**, follow
   [diagnose](docs/skills/diagnose/SKILL.md) Phase 1 (build a feedback
   loop) before speculating.
3. **Long Claude↔Codex handoff prompts** can be written in
   [caveman](docs/skills/caveman/SKILL.md) mode once context is
   established.
4. **Hard-to-reverse decisions** captured during grilling or architecture
   review go into `docs/adr/` (see
   [docs/adr/README.md](docs/adr/README.md)).

## Repositories

- Backend engine: `engine`
- iOS app: `ios`
- iOS specs: `ios-specs`

## Documentation Rule

Do not create a new report file when a current/canonical file already exists.
Update the current file listed in `docs/DOCS_INDEX.md`.

One-off reports belong under `docs/archive/YYYY-MM/<workstream>/`.

Before copying verdicts, commit hashes, or test counts into markdown, run the
backend docs audit:

```bash
cd engine
npm run docs:audit
```

## Safety Rules

- Do not use production data unless an owner-approved production runbook says so.
- Do not deploy without explicit owner approval.
- Do not hardcode a model/provider. Nexus uses live model routing.
- Do not weaken tenant, auth, provider, calendar, or memory isolation checks.
- Data lookups and operational flows use REST, not fake chat commands.
