# Nexus Hub Agent Operating Context

Status: canonical
Owner: workspace lead (Felipe)
Last verified: 2026-05-24
Update policy: update when the workspace map, shared product rules, or release workflow change. Companions are AGENT_PROCESS_STANDARD.md (governs HOW agents operate) and DOCS_INDEX.md (canonical doc routing).

## Workspace

- Workspace root: `/Users/felipedominguez/Desktop/Nexus Hub`
- Backend engine: `/Users/felipedominguez/Desktop/Nexus Hub/engine`
- iOS app: `/Users/felipedominguez/Desktop/Nexus Hub/ios`
- iOS specs: `/Users/felipedominguez/Desktop/Nexus Hub/ios-specs`

## Shared Product Rules

- Token-zero is non-negotiable: operational reads/writes use REST, not fake chat
  commands.
- User-scoped integration truth is mandatory.
- Tenant, auth, memory, calendar, and provider boundaries are release blockers.
- Nexus runtime model routing stays configurable. Do not hardcode GPT, Claude,
  Gemini, or any provider as the product default.
- Staging/prod work requires explicit owner approval and evidence.

## Markdown Workflow

1. Read `docs/DOCS_INDEX.md`.
2. Update current/canonical docs instead of creating a new report.
3. If historical evidence is useful, archive it under
   `docs/archive/YYYY-MM/<workstream>/`.
4. Keep current release truth in `docs/release/CURRENT_RELEASE_STATE.md`.
5. Keep open release items in `docs/release/OPEN_ITEMS.md`.
6. Run `cd engine && npm run docs:audit` before adding release docs or copying
   verdicts, commit hashes, or test counts.

## Release Workflow

Backend production changes should follow:

1. Focused tests/typecheck.
2. Full regression when risk justifies it.
3. Push source to `main`.
4. Deploy staging.
5. Run staging smoke.
6. Promote to production.
7. Run production health checks.
8. Update release state docs.

Do not claim a stage passed unless the command ran and the result is recorded.

## Session End — Definition of Done

Before you say a session is finished, work through this checklist explicitly.
Missing items create the kind of doc drift that costs entire follow-up
sessions to catch up on. Call out in your final response to Felipe which
items applied and which didn't.

### A. If the session shipped a production deploy

- [ ] `docs/release/CURRENT_RELEASE_STATE.md` has a new section dated today
  with: scope, production version, deploy commit, previous deploy commit,
  staging smoke result (file path), release validation (typecheck +
  Vitest/iOS test counts), production health (curl `/health`, PM2 status,
  authenticated snapshot version), and known caveats.
- [ ] `engine/docs/release/CURRENT_RELEASE_STATE.md` (repo-local mirror)
  matches the workspace doc — same version, same commit, same scope summary.
- [ ] Smoke evidence file lives under
  `engine/docs/release/smoke-evidence/staging-smoke-<sha>-<ts>.json` and is
  committed.

### B. If the session shipped a feature flag or user-facing surface

- [ ] `docs/release/feature-delivery-ledger.md` has a row for the flag /
  feature with columns: flag, feature, status (`planned` /
  `in_worktree` / `in_staging` / `in_prod` / `deprecated` / `retired`),
  owner_worktree, current_version, commits, tests, evidence path,
  last_verified date, notes.
- [ ] If the row already existed in an earlier state (e.g. promoting
  `in_worktree` → `in_prod`), update status, version, commits, evidence,
  and last_verified.
- [ ] Update the bottom-of-file status counts (`in_prod: N`, etc.) to match
  the new row state.

### C. Every non-trivial session (any code change, any QA round, any deploy)

- [ ] Create `docs/agents/handoffs/<YYYY-MM-DD>-<slug>.md` using the
  template at `docs/agents/handoff-template.md`. Cover: scope, what
  shipped, what's still in-flight, known caveats, QA verdict (if
  applicable), recommended next 3 actions for the next agent, and any
  protocol violations or follow-ups.
- [ ] If any QA/evidence artifact was created during the session
  (smoke output, eval JSON, screenshot, fixture capture), it's checked in
  under the appropriate evidence directory (`docs/release/smoke-evidence/`,
  `docs/release/eval-evidence/`, or `docs/qa/`). Never leave evidence
  untracked.
- [ ] `git status` is intentionally clean. Anything left untracked must
  either be `.gitignore`d or explicitly explained in the handoff doc.

### D. If you created any new canonical, current, runbook, or standard doc

- [ ] `docs/DOCS_INDEX.md` has a row routing to it with the right status
  (`canonical` / `current` / `historical` / `archive` / `generated`) and
  an update policy line.

### E. Always (every session, every time)

- [ ] Run `cd engine && npm run docs:audit` and address new warnings.
  Existing baseline warnings are acceptable; new warnings are not.
- [ ] If you changed any markdown file in `docs/release/`, the audit must
  re-pass before you ship.
- [ ] Your final response to Felipe explicitly lists which DoD items you
  completed AND which you intentionally skipped (with reason). Do not let
  Felipe discover doc drift after the fact.

### F. If a session ends WITHOUT a deploy (QA-only, planning, exploration)

You still owe items C, D, E. The handoff doc explains why no deploy
happened, what's blocking, and what the next agent should do first.

### Why this checklist exists

Past doc drift incidents (2026-05-04 → 2026-05-24): four production
promotes shipped without ledger rows; the handoffs directory had only one
file; OPERATING_CONTEXT was three weeks stale before someone noticed.
Each gap cost a follow-up session to backfill. This checklist makes the
update part of the work, not a side activity.
