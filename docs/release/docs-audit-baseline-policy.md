# docs:audit historical baseline policy

Status: canonical
Owner: release lead (Felipe)
Last verified: 2026-06-06
Update policy: update only when the baseline shrinks (e.g. an archive
sweep relocates files) or when a new warning class is added to
`audit-docs.mjs`.

This document closes ENG-EXC-O7 and ENG-EXC-CX-O5 from the engineering-
excellence pass. It defines what `npm run docs:audit` warnings are
treated as a frozen historical baseline vs actionable signal.

## Baseline as of 2026-06-06

```
markdown files scanned: 4255
issues flagged:         5185
```

Distribution by warning class:

| Class | Count | Treatment |
|---|---|---|
| `markdown-outside-approved-current-or-archive-location` | 3445 | **frozen baseline** (see §1) |
| `test-count-literal-outside-current-report`             | 1288 | **frozen baseline** (see §3) |
| `duplicate-or-scattered-current-verdict`                |  283 | **actionable** — every new entry blocks PR |
| `broken-markdown-reference`                             |  156 | **actionable** — every new entry blocks PR |
| `commit-hash-not-found-in-own-repo`                     |   13 | **frozen baseline** (see §2) |
| `engineering-standard-frontmatter-missing`              |   0 | **enforced** by Codex's frontmatter check |
| `workspace-mirror-stale` / `workspace-mirror-missing`   |   0 | **enforced** by ENG-EXC-O8 mirror |

Total budget: **5185 ± 5 across the three frozen classes.** The 5-issue
buffer covers minor doc edits within the baseline. Crossing the buffer
in any direction (up OR down) requires a one-line update to this
document.

## §1 — markdown-outside-approved-current-or-archive-location

Most of the 3445 entries are per-domain design docs under
`docs/{chat,cooking,content,training,calendar,memory,...}/`.
They were authored before `engineering/` was a canonical location and
they reference rich domain context that's still useful as evidence even
if not "current truth". Moving them all to `archive/` would lose the
co-located docs-with-code structure.

**Decision**: keep where they are; do NOT count them as drift. New
files MUST land in an approved location per the workspace
[engineering standards index](../engineering/ENGINEERING_STANDARDS_INDEX.md)
standard-authoring rules.

## §2 — commit-hash-not-found-in-own-repo

These are commit hashes referenced in archived release notes (e.g.
`docs/release/archive/...`) where the original commit was
later squashed or rebased away from the current branch. The hash is
intentionally preserved as historical provenance.

**Decision**: keep as historical record; do NOT block new release
notes that reference current hashes (those are caught by the existing
release-doc-drift check in nightly CI).

## §3 — test-count-literal-outside-current-report

Most are per-pass closure reports under `docs/archive/2026-*/` that
recorded "X/X PASS" verdicts at the time. The test count was correct
when the pass shipped; it's now historical evidence.

**Decision**: keep as historical record. New release-track docs
should reference `docs/release/release-identity.md` (auto-regenerated
by `scripts/release-identity.sh --persist`) instead of typing
literal counts.

## What's actionable

The two classes that **stay actionable** (block PRs):

1. **`broken-markdown-reference`** (156 currently). Every NEW broken
   reference in a current-like doc is a PR-blocker. Engineering
   standards (ENG-EXC-O9 closure) are now in this set — a renamed
   standard breaks links visibly.
2. **`duplicate-or-scattered-current-verdict`** (283 currently). Every
   NEW verdict-shaped string outside the canonical verdict files
   ([CURRENT_RELEASE_STATE](docs/release/CURRENT_RELEASE_STATE.md),
   [OPEN_ITEMS](docs/release/OPEN_ITEMS.md),
   [QA_BACKEND_REPORT](../qa/QA_BACKEND_REPORT.md),
   [QA_IOS_REPORT](ios/docs/qa/QA_IOS_REPORT.md))
   creates drift.

## How to interpret a docs:audit run

A run with `issues flagged: ≤ 5190` is **green**. The 5-issue buffer
above the 5185 baseline absorbs day-to-day noise.

A run with `issues flagged: > 5190` requires **per-class diff** vs the
table above:

```
node scripts/audit-docs.mjs --json | jq '.summary.issuesByType'
```

If a frozen-baseline class grew, it's noise — investigate but don't
block. If `broken-markdown-reference` or
`duplicate-or-scattered-current-verdict` grew, treat it as actionable.

## Reduction projects

Future passes that would shrink the baseline (NOT required for
closed-beta):

- **Archive sweep of pre-2026-04 design docs** — relocate domain
  docs older than 90 days into `docs/archive/`.
  Reduces class §1 by an estimated ~80 entries.
- **Hash backfill** — scrub historical commit-hash references in
  release notes that point to squashed commits, replacing with a
  "see release-identity.md for current" pointer. Reduces class §2 by
  an estimated ~50 entries.

These are P3 hygiene items tracked in
[OPEN_ITEMS](OPEN_ITEMS.md) as ENG-EXC-O7 (now
closed via this policy doc).

## Related standards

- `docs/engineering/testing-and-qa-harness-standard.md` §16
  defines evidence requirements per change.
- [Workspace engineering standards index](../engineering/ENGINEERING_STANDARDS_INDEX.md)
  defines the workspace docs durability mirror (ENG-EXC-O8 closure).
- `scripts/audit-docs.mjs` implements the warning classes.
- `scripts/cannot-skip-gate-dashboard.sh` (ENG-EXC-O3) emits
  per-gate evidence to a sibling directory.
- `scripts/testflight-evidence.sh` (ENG-EXC-O6) emits E5
  evidence to `docs/release/testflight-evidence/`.
