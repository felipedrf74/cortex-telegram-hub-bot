# Nexus Hub Workspace

This directory is the shared entrypoint for Codex and Claude Code.

Official working path: `/Users/felipedominguez/Desktop/Nexus Hub`

It intentionally uses symlinks instead of moving repositories:

- `engine` -> backend repo
- `ios` -> iOS app repo
- `ios-specs` -> iOS/spec truth

Start with `AGENTS.md` or `CLAUDE.md`, then follow `docs/DOCS_INDEX.md`.

Use `cd engine && npm run docs:audit` before adding release reports or copying
test counts, commit hashes, or verdicts.
