# Staging Smoke Evidence

Smoke evidence filenames follow:

```text
staging-smoke-<worktree-head-sha>-<YYYYMMDDTHHMMSSZ>.json
```

The SHA in the filename is the worktree `HEAD` at smoke time. It is not always
the original feature implementation commit, because operators may run smoke
after follow-up docs, ledger, or deploy-provenance commits land on top.

For the Nexus Points usage-limits hardening release, the original
implementation commit was `48b0769a`; later smoke evidence can reference a
docs/deploy HEAD such as `75db3026`. When the filename SHA is unclear, use:

```bash
git log --all --source --oneline --decorate -- <sha>
git log --all --source --oneline --grep "nexus points"
```

Cross-reference the matching handoff, feature ledger row, and
`docs/release/current-release-index.md` before treating a smoke JSON filename as
the sole release provenance record.
