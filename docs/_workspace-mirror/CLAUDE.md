# CLAUDE.md - Nexus Hub Workspace Bootloader

Status: canonical
Owner: workspace lead (Felipe)
Last verified: 2026-05-04
Update policy: update when the agent workflow, read-first list, or
markdown rules change. The companion is `AGENTS.md` (Codex bootloader).

Claude Code should treat this file as a bootloader, not as the full source of
truth.

Official working path: `/Users/felipedominguez/Desktop/Nexus Hub`

## Read First

1. `docs/DOCS_INDEX.md`
2. `docs/agent/OPERATING_CONTEXT.md`
3. `docs/release/CURRENT_RELEASE_STATE.md`
4. `docs/release/OPEN_ITEMS.md`

Then read the repo-local bootloader for the area you are changing:

- Backend: `engine/CLAUDE.md`
- iOS: `../Nexus Hub IOS/CLAUDE.md` and `ios-specs/00-CURRENT-PRODUCT-TRUTH.md`

## Rule For Markdown

Do not create new scattered `*-final-report.md`, `*-audit.md`, or
`*-open-items.md` files unless `docs/DOCS_INDEX.md` says that is the canonical
place for the workstream.

Update current docs first. Archive historical evidence second.

Run `cd engine && npm run docs:audit` before creating release docs or copying
verdicts, commit hashes, or test counts.
