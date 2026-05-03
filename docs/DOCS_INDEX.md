# Backend Documentation Index

This is the backend repo's markdown routing map for Codex and Claude Code.

## Current Docs To Update

| Purpose | Status | Path | Update Policy |
| --- | --- | --- | --- |
| Backend QA status | current | `docs/qa/QA_BACKEND_REPORT.md` | Update after backend QA, security, runtime, or release validation. |
| Release process entrypoint | canonical | `docs/release/README.md` | Keep as the release-process start page. |
| Current release index | current | `docs/release/current-release-index.md` | Update first for active release decisions and exact RC identity. |
| Production checklist | canonical | `docs/release/production-promotion-checklist-v2.md` | Update only when the process changes. |
| Risk-based gate matrix | canonical | `docs/release/risk-based-release-gate-matrix.md` | Update when changed-file gating changes. |
| Docs drift audit | canonical command | `npm run docs:audit` | Run before creating release docs or copying verdicts/test counts. |

## Historical Docs

Historical one-off reports belong under:

```text
docs/release/archive/
docs/archive/
```

Do not treat old timestamped reports as current truth unless
`docs/release/current-release-index.md` links them explicitly.

## Agent Rules

1. Before creating a new markdown report, update the current doc above when
   one matches the work.
2. If a new report is unavoidable, link it from the current index.
3. Do not duplicate final verdicts across multiple current files.
4. Keep commit hashes and test counts in the current release index, not copied
   into many workstream docs.
5. Never delete historical evidence until it has been archived or explicitly
   classified as scratch.
6. Use `/Users/felipedominguez/Desktop/Nexus Hub` as the official workspace
   entrypoint. Do not start from old beta-agent folders.
