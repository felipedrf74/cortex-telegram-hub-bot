# Release Evidence Contract

Status: canonical
Owner: release lead (Felipe)
Last verified: 2026-06-07

Release evidence is reusable only when it is cryptographically bound to the
exact release artifact. `auto-when-staged` stays shadow/default-off until three
distinct clean signed RC runs and a current rollback drill exist.

## Evidence Identity

The signed payload uses schema `nexus.release-evidence-payload.v2` and keys on:

- full engine git SHA, never a prefix
- optional iOS SHA plus `includesIos`
- optional iOS build hash when the release includes iOS
- CI provider, `runId`, and `runAttempt`
- release artifact manifest digest from `scripts/release-artifact-manifest.mjs`
- command results and per-suite test counts for typecheck, build, full sharded
  Vitest, full pytest, science-policy, migration rehearsal, sandbox smoke, and
  the cannot-skip dashboard

The outer envelope uses schema `nexus.release-evidence.v2`:

- `payload`
- `signature`
- `signatureAlgorithm` set to the EdDSA Curve25519 verifier identifier
- `keyId`

Deploy validation rejects unsigned evidence, stale evidence, zero or below-floor
Vitest/pytest counts, missing sandbox-smoke proof, missing command results,
non-passing command results, prefix SHA matches, and manifest drift.

## Evidence Producer

The `RC — Release Evidence` workflow runs on `v*` tags and manual dispatch. It
runs the full JavaScript suite once per release candidate as four Vitest shards,
content-engine pytest once on Python 3.12, typecheck, build, cumulative
migration rehearsal, and the cannot-skip dashboard. It also builds the
release-test container and runs the release gate contract inside that container
as sandbox-smoke proof before writing:

- `docs/release/evidence/release-evidence-<engine-sha>-<run-id>-<run-attempt>.json`
- `docs/release/evidence/latest-release-evidence.json`

The workflow writes evidence through `scripts/release-evidence-container.sh`, so
evidence production uses the release-test image while bind-mounting the checkout
for git metadata and post-build artifact hashing.

The workflow signs the canonical payload with the GitHub Actions secret
`NEXUS_RELEASE_EVIDENCE_PRIVATE_KEY_PEM`. The corresponding public verification
key is committed at:

- `docs/release/evidence/release-evidence-public-key.pem`

Generate or rotate the pair with:

```bash
npm run release:evidence:keygen
```

The generated private key is written under `.local/release/` and must be copied
into the GitHub secret by an owner. Do not commit the private key.

Deploy validation reads the public key from
`docs/release/evidence/release-evidence-public-key.pem` by default, or from an
explicit `--public-key` path. Environment-based public-key overrides are ignored
for verifier safety.

## Evidence Consumers

`scripts/deploy.sh` and `scripts/promote-to-prod.sh` validate release evidence
against the current full SHA and manifest digest. `deploy.sh` validates again
after `npm run build`, immediately before remote mutation, so the digest that
matched is the digest about to be shipped.

For local deploy consumption, keep downloaded CI evidence outside the tracked
docs tree by default:

- `.local/release/evidence/latest-release-evidence.json`
- `.local/release/evidence/release-evidence-<engine-sha>-<run-id>-<run-attempt>.json`

Override with `NEXUS_RELEASE_EVIDENCE_PATH` or
`NEXUS_RELEASE_CLEAN_RC_EVIDENCE_DIR` only when the replacement path is part of
an owner-approved release runbook. The evidence file itself may be
operator-writable because the signed payload, public key, exact SHA, and exact
manifest digest are the trust boundary.

Default production deploy still runs full verification. `auto-when-staged` can
skip full local Vitest only when all are true:

- `NEXUS_DEPLOY_SKIP_VERIFY=auto-when-staged`
- `NEXUS_RELEASE_EVIDENCE_REUSE_ENABLED=1`
- signed v2 evidence validates against the exact post-build manifest
- at least three distinct clean signed RC run IDs validate for the current SHA
- `scripts/rollback-drill-check.mjs` finds current rollback drill evidence
- `scripts/promote-to-prod.sh` has already proven local/staging artifact
  manifest parity before invoking production deploy
- the worktree is clean
- no emergency dirty-deploy override is active

When these conditions pass, deploy still runs typecheck, build, post-build
artifact digest revalidation against signed evidence, env/readiness checks,
deploy locks, DB integrity, native-module probes, PM2 checks, and postdeploy
health. When any condition is missing or invalid, deploy falls back to the full
local `npm run verify` path.

Emergency bypasses require `NEXUS_EMERGENCY_SKIP_REASON` and are appended to
`.local/release/override-audit.jsonl`.

Rollback drill evidence is expected at
`docs/release/evidence/rollback-drill-latest.json` by default. The gate requires
a current passed dry-run restore, DB integrity proof, backup-with-database
proof, and health-check proof. No such evidence is generated automatically by
this code path because it requires an operator-controlled restore rehearsal.

## Migration Policy

`scripts/migration-safety-check.mjs` verifies migration ordering, legacy
duplicate-prefix allowlist, cumulative SQLite application, and changed
irreversible migration policy. A changed migration containing `DROP TABLE`,
`DROP COLUMN`, or `RENAME` blocks release unless both are set:

- `NEXUS_MIGRATION_APPROVER`
- `NEXUS_MIGRATION_BACKUP_EVIDENCE`

This does not make an old production rollback safe after forward-only
migrations have already applied; rollback drills remain a separate production
readiness gate.
