# Nexus Hub Release Docs

Status: canonical
Owner: release lead (Felipe)
Last verified: 2026-06-06
Update policy: update when the release-process entrypoint structure changes.

Date: 2026-06-06

This folder is the active source of truth for the release process.

Start here:

1. `../DOCS_INDEX.md`
2. `current-release-index.md`
3. `CURRENT_RELEASE_STATE.md`
4. `streamlined-release-process-v2.md`
5. `risk-based-release-gate-matrix.md`
6. `main-staging-production-gate-model.md`
7. `production-promotion-checklist-v2.md`

Before writing a release decision, generate current identity:

```bash
scripts/release-identity.sh markdown
```

Before staging a production candidate, prepare the versioned release commit:

```bash
scripts/release-prep.sh --patch
```

Before reusing CI release evidence, ensure it is signed v2 evidence per
`release-evidence-contract.md`. `auto-when-staged` remains default-off until
the shadow period and rollback-drill requirements are satisfied.

Current release verification contract:

1. Prepare the versioned release commit with `npm run release:prep -- --patch`
   or the matching minor/major command.
2. Run `npm run release:focused-verify` locally before the RC. Docs-only diffs
   run docs audit/drift checks; risky deploy, migration, package, security,
   auth, tenant, and test-config diffs escalate to the full local runner.
3. Run `npm run release:pre-rc` to exercise the release-test container contract.
4. Let the `RC — Release Evidence` workflow run the full Vitest suite once as
   shards, full pytest once, typecheck, build, migration safety,
   science-policy, sandbox smoke, and the cannot-skip dashboard.
5. Download signed CI evidence into `.local/release/evidence/` for local
   promote/deploy reuse. Keep the run-specific evidence files there until the
   three-clean-RC threshold is met for the candidate SHA.
6. Deploy staging, run staging smoke/readiness, run promote dry-run, then
   promote to production.

Full local verification remains available, but it is not the normal minor
release path:

```bash
npm run release:verify:full
```

Useful release-hardening commands:

```bash
npm run release:prep -- --patch
npm run release:focused-verify
npm run release:pre-rc
npm run release:verify
npm run release:verify:container
npm run release:evidence:keygen
npm run release:rollback-drill-check
```

`npm run release:verify` is the focused local pre-RC runner. Use
`npm run release:verify:full` when evidence is missing, the classifier fails,
the diff is high-risk, or an emergency fallback intentionally requires the full
local suite.

The keygen command writes the public verifier to `docs/release/evidence/` and a
local private key under `.local/release/`; an owner must install that private key
as the GitHub Actions secret before signed CI evidence can pass.

Before creating new markdown reports or copying old verdicts/test counts, run:

```bash
npm run docs:audit
```

Historical release-specific packs were moved to:

```text
docs/release/archive/2026-05-01-pre-v2/
```

Archived docs are evidence, not active gates. Do not treat them as current
blockers unless the active release index or gate matrix explicitly points to
them.
