# Nexus Hub Agent Operating Context

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
