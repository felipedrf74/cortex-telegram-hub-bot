# Nexus Hub Release Docs

Date: 2026-05-01

This folder is the active source of truth for the release process.

Start here:

1. `../DOCS_INDEX.md`
2. `current-release-index.md`
3. `CURRENT_RELEASE_STATE.md`
4. `release-process-audit-final-report.md`
5. `streamlined-release-process-v2.md`
6. `risk-based-release-gate-matrix.md`
7. `main-staging-production-gate-model.md`
8. `production-promotion-checklist-v2.md`

Before writing a release decision, generate current identity:

```bash
scripts/release-identity.sh markdown
```

Historical release-specific packs were moved to:

```text
docs/release/archive/2026-05-01-pre-v2/
```

Archived docs are evidence, not active gates. Do not treat them as current
blockers unless the active release index or gate matrix explicitly points to
them.
