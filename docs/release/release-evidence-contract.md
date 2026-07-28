# Release checksum evidence contract

The release checkpoint publishes one unsigned checksum manifest. Trust comes
from protected GitHub workflow identity, exact SHA binding, SHA-256
verification, branch protection, and explicit production-owner approval.

## `nexus.release-checksum-manifest.v1`

Required fields:

| Field | Contract |
| --- | --- |
| `sourceSha` | Full lowercase SHA equal to the protected-main checkout |
| `version` | Version from the exact bundle completion marker |
| `createdAt` | Checkpoint timestamp |
| `artifact.name` | `release-bundle-<sourceSha>-<artifact.sha256>` |
| `artifact.sha256` | Aggregate SHA-256 from the protected-main artifact manifest |
| `protectedMain` | Workflow/run identity, docs-only flag, and exact selected-test file/result counts and digests |
| `releaseCheckpoint` | Workflow name, run ID, and attempt |
| `releaseImpact` | Canonical protected release-state predecessor SHA plus sorted, deduplicated groups selected from the cumulative `deployedSha..sourceSha` diff |
| `testPolicySha256` | SHA-256 of the exact group policy used by the SHA |
| `selectedGroups` | Sorted, deduplicated protected-main test groups; empty only for a docs-only SHA |
| `fullSuite` | Exact deterministic inventory plus selected/remainder partition proof and four ordered, passing remainder-shard receipts |
| `python` | `passed` when required, otherwise `skipped` |
| `migrations` | `passed` when compatible migration files changed, otherwise `skipped`; any irreversible scan blocks checkpoint completion and cannot authorize promotion |

The partition commits the deterministic, protected-main selected, and
checkpoint remainder file counts and inventory SHA-256 values. Manifest
creation independently parses the selected and four shard Vitest JSON results
and fails unless selected and remainder are disjoint and their exact union is
the deterministic inventory. Each shard receipt records its `I/4` identity,
passing test/file counts, inventory SHA-256, and SHA-256 of the original Vitest
JSON result. A gap, overlap, failed, duplicated, or out-of-order shard
invalidates the manifest.

`scripts/release-checksum-manifest.mjs validate` additionally verifies the
bundle's declared file bytes, file inventory, completion marker, source SHA,
version, and aggregate artifact digest. An undeclared file in the pristine
bundle is rejected. Promotion derives conditional quality requirements from
`releaseImpact.groups`, never from `selectedGroups`, because only the former
covers every change since the deployed predecessor. Validation rejects a
`releaseImpact.deployedSha` that differs from the protected
`docs/release/release-state.json`.

## Transaction evidence

Both server phases write `nexus.lean-release-transaction.v1` with:

- role (`staging` or `production`);
- transaction ID;
- runtime SHA and artifact digest;
- exact release directory;
- predecessor path, SHA, and digest recorded before mutation;
- phase and terminal status;
- start, update, and completion timestamps;
- candidate health result;
- configured stability seconds and soak start/completion timestamps;
- rollback result and measured recovery duration;
- candidate/recovery health budgets and the 120-second rollback objective;
- artifact parity, migration startup, authenticated smoke, database integrity,
  pre-promotion backup, and rollback-readiness results;
- bounded failure message.

Writes use a temporary private file, file fsync, atomic rename, and parent
directory fsync. Local state binds the same artifact, checkpoint run, canonical
deployed SHA, and manifest SHA-256. Promotion revalidates the checkpoint run
and requires a fresh download of its exact named manifest artifact to match
those cached bytes and that SHA-256 before any server SSH.

Terminal success is only `phase=completed,status=passed`, with passing health,
authenticated runtime smoke and read-only SQLite integrity/foreign-key checks
for both roles, and rollback marked `not_required`. The authenticated smoke
binds the live snapshot version to `.complete.json.packageVersion` and verifies
that `current` still resolves to that exact candidate before and after the
request. `prePromotionBackup` is `passed` only for production and `skipped` for
staging; it is independent from `databaseIntegrity`. A failed production
candidate is recovered only when state says `rolled_back`, rollback is
`restored`, and the measured predecessor health recovery is recorded.
`rollback_failed` requires manual recovery and blocks another promotion.
Production success additionally requires a timestamped soak of at least 60
seconds and a predecessor SHA equal to `releaseImpact.deployedSha`. A staging
fault drill records `faultInjection=staging-health`, exact
predecessor recovery, and removal of the deliberately failed candidate before
the same bundle may be staged normally.

Validate a successful phase against its exact manifest with:

```bash
node scripts/release-checksum-manifest.mjs validate-state \
  --manifest <release-manifest.json> \
  --state <staging-or-production.json> \
  --role staging
```

## Deliberate exclusions

The manifest is not cryptographically signed, contains no secrets, and does
not authorize production by itself. SonarQube, mutation results, AWS, KVM
drills, documentation closeout, and timing targets are not fields or gates.
