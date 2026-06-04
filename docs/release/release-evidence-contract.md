# Release Evidence Contract

The release pipeline now keys reusable production evidence on one identity:

- engine git SHA
- optional iOS SHA plus `includesIos`
- optional iOS build hash when the release includes iOS
- release artifact manifest digest from `scripts/release-artifact-manifest.mjs`

The manifest digest covers the runtime artifact, not only `dist/index.js`:

- `dist/**`
- `migrations/**`
- `prompts/**`
- `package.json` and `package-lock.json`
- `ecosystem*.config.js`
- `content-engine/**` runtime source and requirements, excluding venvs, caches, data, and tests

## Evidence Producer

The `RC — Release Evidence` workflow runs on annotated `v*` tags and manual dispatch. It runs full sharded Vitest, full content-engine pytest, typecheck, build, cumulative migration rehearsal, and the cannot-skip dashboard before writing:

- `docs/release/evidence/release-evidence-<engine-sha>.json`
- `docs/release/evidence/latest-release-evidence.json`

## Evidence Consumers

`scripts/deploy.sh` and `scripts/promote-to-prod.sh` validate `docs/release/evidence/latest-release-evidence.json` against the current SHA and manifest digest.

During the first three clean RCs, production deploy stays in shadow mode: evidence match/mismatch is logged, but default deploy still runs full verification. `NEXUS_DEPLOY_SKIP_VERIFY=auto-when-staged` may only skip full Vitest when evidence matches exactly and `NEXUS_RELEASE_EVIDENCE_REUSE_ENABLED=1` has been explicitly set after the shadow period.

Emergency bypasses require `NEXUS_EMERGENCY_SKIP_REASON` and are appended to `.local/release/override-audit.jsonl`.

## Migration Policy

`scripts/migration-safety-check.mjs` verifies migration ordering, legacy duplicate-prefix allowlist, and cumulative SQLite application. A changed migration containing `DROP TABLE`, `DROP COLUMN`, or `RENAME` blocks release unless both are set:

- `NEXUS_MIGRATION_APPROVER`
- `NEXUS_MIGRATION_BACKUP_EVIDENCE`
