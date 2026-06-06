# Release Evidence Contract

Status: canonical
Owner: release lead (Felipe)
Last verified: 2026-06-06

Release evidence is reusable only when it is cryptographically bound to the
exact release artifact. `auto-when-staged` stays shadow/default-off until three
clean signed RCs and a current rollback drill exist.

## Evidence Identity

The signed payload uses schema `nexus.release-evidence-payload.v2` and keys on:

- full engine git SHA, never a prefix
- optional iOS SHA plus `includesIos`
- optional iOS build hash when the release includes iOS
- release artifact manifest digest from `scripts/release-artifact-manifest.mjs`
- command results and test counts for typecheck, build, Vitest, pytest,
  science-policy, migration rehearsal, and cannot-skip dashboard

The outer envelope uses schema `nexus.release-evidence.v2`:

- `payload`
- `signature`
- `signatureAlgorithm` set to the EdDSA Curve25519 verifier identifier
- `keyId`

Deploy validation rejects unsigned evidence, stale evidence, zero Vitest/pytest
counts, missing command results, non-passing command results, prefix SHA
matches, and manifest drift.

## Evidence Producer

The `RC — Release Evidence` workflow runs on `v*` tags and manual dispatch. It
runs sharded Vitest, content-engine pytest on Python 3.12, typecheck, build,
cumulative migration rehearsal, and the cannot-skip dashboard. It also builds
the release-test container and runs the non-sharded release gate contract inside
that container before writing:

- `docs/release/evidence/release-evidence-<engine-sha>.json`
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
`docs/release/evidence/release-evidence-public-key.pem` by default, or from
`NEXUS_RELEASE_EVIDENCE_PUBLIC_KEY_PEM` /
`NEXUS_RELEASE_EVIDENCE_PUBLIC_KEY_PATH`.

## Evidence Consumers

`scripts/deploy.sh` and `scripts/promote-to-prod.sh` validate release evidence
against the current full SHA and manifest digest. `deploy.sh` validates again
after `npm run build`, immediately before remote mutation, so the digest that
matched is the digest about to be shipped.

Default production deploy still runs full verification. `auto-when-staged` can
skip full local Vitest only when all are true:

- `NEXUS_DEPLOY_SKIP_VERIFY=auto-when-staged`
- `NEXUS_RELEASE_EVIDENCE_REUSE_ENABLED=1`
- signed v2 evidence validates against the exact post-build manifest
- `scripts/rollback-drill-check.mjs` finds current rollback drill evidence
- the worktree is clean
- no emergency dirty-deploy override is active

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
