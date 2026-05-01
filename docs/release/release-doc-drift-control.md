# Release Doc Drift Control

Date: 2026-05-01

## Problem

Recent releases had stale commit hashes and test counts after small follow-up commits. This creates another QA loop even when product code is ready.

Observed examples:

- Backend commit references in Cooking/Training release docs fell behind the actual tip.
- Focused test counts changed after new tests were added.
- Multiple docs copied the same verdict, so a wording fix had to be made in more than one place.

## Strategy

1. Generate release identity from the repo, do not hand-type it.
2. Keep one current release summary per release window.
3. Move old QA docs to historical/reference status.
4. Store test output artifacts or structured summaries next to the current release summary.
5. Avoid copying verdicts; link to the one gate document.
6. Mark every skipped check with the risk-matrix reason.

## Implemented Quick Win

Added:

```bash
scripts/release-identity.sh markdown
scripts/release-identity.sh json
```

The script prints backend/iOS branch, commit, dirty state, backend package version, and migration count. Release docs should paste or ingest this output before go/no-go decisions.

## Next Automation

Add a later `scripts/release-doc-drift-check.sh` that:

- scans current release docs for short SHAs;
- compares the active RC identity file against the docs;
- fails if docs cite a stale active branch tip;
- ignores historical docs explicitly marked `Historical`.

Do not make old reports auto-fail release unless they are listed in the current release index.
