# Training Exercise Media V1 Operator Runbook

Status: canonical
Owner: Training media release owner (Felipe)
Last verified: 2026-07-13
Update policy: update when authored-content, package materialization, approval,
staging activation, or production-validation contracts change.

This runbook governs metadata only. Media binaries stay on the approved
content-addressed host and are never bundled into the backend or iOS app. The
global `TRAINING_EXERCISE_MEDIA_V1_ENABLED` flag remains `false` until the
reviewed package is activated and a scoped smoke is green.

## 1. Fixed inputs

Start from the reviewed backend checkout. Derive that checkout rather than
hardcoding a worktree, and explicitly supply the independent Phase 0 catalog
root without copying the 300+ MiB artifact tree:

```bash
export BACKEND_ROOT="$(git rev-parse --show-toplevel)"
: "${PHASE0_ROOT:?Export PHASE0_ROOT as the absolute reviewed ProductionExerciseMediaCatalog path}"
test -f "$PHASE0_ROOT/validate-catalog.mjs"
export AUTHORED_ROOT="$BACKEND_ROOT/catalog/training/exercise-media/v1/authored-content"
cd "$BACKEND_ROOT"
```

The materializer accepts only the frozen Phase 0 eligibility, artifact-index,
approval-package, and live publication-evidence hashes. It also requires the
authored-content package hash, reviewer identities/timestamps, rights metadata,
and approved origin in `materialization-policy.json` to agree exactly. The v2
release subject additionally binds the raw policy bytes, its canonical
activation-policy projection, and the complete canonical pre-owner governance
ledger without changing the frozen media package hash.

## 2. Complete and validate authored content

Each instruction chunk must contain one row per exercise and locale. Each
accessibility chunk must contain one row per selected asset mapping and locale.
The required totals are derived by the validator rather than entered by an
operator.

```bash
npm run training:exercise-media:authored-content:hash:check
NEXUS_TRAINING_MEDIA_PHASE0_ROOT="$PHASE0_ROOT" \
  npm run training:exercise-media:authored-content:validate
```

The second command must print `PASS_AUTHORING_COMPLETE_UNAPPROVED` and an
`authoredContentPackageHash`. Draft status, missing rows, duplicate keys,
placeholder/generic copy, unknown mappings, or content-hash drift fail closed.

After the live publication verifier writes `publication-evidence.json`, bind
its raw file hash in `materialization-policy.json`:

```bash
shasum -a 256 "$PHASE0_ROOT/publication-evidence.json"
```

Do not change the policy to `READY_TO_MATERIALIZE` until every nullable review
and rights field is replaced by its real evidence value and the content-review
subject equals the validator's exact authored-content package hash.

## 3. Materialization preflight and exact package-hash approval

Run a read-only preflight first:

```bash
npx tsx scripts/materialize-training-exercise-media.ts \
  --check \
  --phase0-root="$PHASE0_ROOT" \
  | tee /tmp/training-media-materialization-preflight.json

export TRAINING_MEDIA_PACKAGE_HASH="$(
  jq -er '.compiledPackageHash' /tmp/training-media-materialization-preflight.json
)"
printf 'Exact Training media package hash for owner review: %s\n' \
  "$TRAINING_MEDIA_PACKAGE_HASH"
```

The preflight must print `PASS_MATERIALIZATION_PREFLIGHT`, exact coverage, a
null `ownerApprovalRef`, `activationReady: false`, and the next gate
`FINAL_OWNER_APPROVAL_BOUND_TO_COMPILED_PACKAGE_HASH`.

Felipe reviews that exact hash and, if approved, supplies a JSON file outside
the repository and outside shell history. The importer accepts this schema;
there is intentionally no command that fabricates it:

```json
{
  "schemaVersion": "training-exercise-media-final-owner-approval.v1",
  "status": "APPROVED",
  "approvalId": "training-media-final-owner-approval-YYYY-MM-DD-<package-hash-prefix>",
  "reviewerRef": "owner:felipe-dominguez",
  "subjectPackageHash": "exact 64-character hash printed above",
  "reasonCodes": ["FINAL_PACKAGE_HASH_REVIEWED"],
  "reviewedAt": "owner-supplied ISO-8601 instant",
  "expiresAt": null,
  "activatedAt": "owner-supplied ISO-8601 instant at or after reviewedAt"
}
```

Validate the final-package approval first. The command prints a
`releaseSubjectHash` and the exact `supplementalApprovalStatement`; the package
remains non-activatable at this point:

```bash
export FINAL_OWNER_APPROVAL="/secure/operator/path/training-media-final-owner-approval.json"
export MATERIALIZED_ROOT="/tmp/training-media-v1-$TRAINING_MEDIA_PACKAGE_HASH"

npx tsx scripts/materialize-training-exercise-media.ts \
  --check \
  --phase0-root="$PHASE0_ROOT" \
  --final-owner-approval="$FINAL_OWNER_APPROVAL"
```

Felipe must then provide a second JSON artifact outside Git. Its v2 schema
binds the exact package and release-subject hashes, extends the first approval,
uses reviewer `owner:felipe-dominguez`, uses the canonical ID printed/derived
for the review date, contains only reason
`FINAL_RELEASE_SUBJECT_HASH_REVIEWED`, and preserves the exact statement from
the preflight. A template is not approval and must retain an awaiting status
and null reviewer/timestamps until Felipe explicitly supplies the statement.

```bash
export SUPPLEMENTAL_OWNER_APPROVAL="/secure/operator/path/training-media-release-subject-owner-approval.json"

npx tsx scripts/materialize-training-exercise-media.ts \
  --check \
  --phase0-root="$PHASE0_ROOT" \
  --final-owner-approval="$FINAL_OWNER_APPROVAL" \
  --supplemental-owner-approval="$SUPPLEMENTAL_OWNER_APPROVAL"

npx tsx scripts/materialize-training-exercise-media.ts \
  --write \
  --phase0-root="$PHASE0_ROOT" \
  --final-owner-approval="$FINAL_OWNER_APPROVAL" \
  --supplemental-owner-approval="$SUPPLEMENTAL_OWNER_APPROVAL" \
  --output-root="$MATERIALIZED_ROOT"
```

Expected verdicts are `PASS_ACTIVATION_PREFLIGHT` and
`PASS_MATERIALIZED_ACTIVATION_READY`. A reused output directory, mismatched
hash, noncanonical owner identity/ID/reason, future/expired approval, attestation
drift, governance drift, or incomplete package fails without changing the
checked-in package.

## 4. Review and install generated metadata

Review the generated files before changing the Git-backed package:

```bash
diff -ru \
  --exclude=authored-content \
  "$BACKEND_ROOT/catalog/training/exercise-media/v1" \
  "$MATERIALIZED_ROOT"
```

After review, copy only the known generated metadata files. Do not copy media
binaries and do not delete `authored-content/`:

```bash
for file in \
  manifest.json exercises.json assets.json instructions.json \
  media-localizations.json provenance.json reviews.json takedowns.json \
  approval-ledger.json compiled-manifest.json materialization-attestation.json
do
  cp "$MATERIALIZED_ROOT/$file" \
    "$BACKEND_ROOT/catalog/training/exercise-media/v1/$file"
done
```

Then prove source/compiled freshness and activation readiness:

```bash
npm run training:exercise-media:compile:check
TRAINING_EXERCISE_MEDIA_CATALOG_ROOT="$PHASE0_ROOT" \
  npm run --silent training:exercise-media:verify:activation \
  | tee /tmp/training-media-backend-activation.json
jq -e --arg hash "$TRAINING_MEDIA_PACKAGE_HASH" \
  '.passed == true and .activationReady == true and .packageHash == $hash
   and .releaseAttestation.valid == true
   and .releaseAttestation.activationReady == true
   and .releaseAttestation.releaseSubjectHash
     == "27b97ebc96e1b3bb1ee3612e63c5609b5572c9d4b58e59b8ea3e77642fb1cea3"
   and .releaseAttestation.finalOwnerApprovalHash
     == "1108f01773e9bac67a7d667989bfc8bf160ae338fef5520c239f2aa5569d6be5"' \
  /tmp/training-media-backend-activation.json

node "$PHASE0_ROOT/validate-catalog.mjs" \
  --mode=production \
  --backend-root="$BACKEND_ROOT" \
  | tee /tmp/training-media-phase0-production-gate.json
jq -e \
  '.verdict == "PASS" and .productionReleaseEligible == true
   and .backendRuntimePackageVerification.verified == true
   and .backendRuntimePackageVerification.materializationAttestationBound == true' \
  /tmp/training-media-phase0-production-gate.json
```

Any failure is a stop condition. In particular, the Phase 0 owner statement is
not a substitute for the separate final approval bound to the compiled package
hash.

## 5. Staging deploy, activation, and scoped smoke

Keep the global feature flag off. Follow the normal release identity and risk
gates, deploy the exact reviewed source to staging, then seed and activate the
reviewed package in the staging database:

```bash
scripts/changed-area-classifier.sh --json
scripts/risk-gate.sh
npm run release:prepare
npm run --silent release:status
RELEASE_STATE=.local/release/release.json
RELEASE_CONFIRM="$(
  node -e '
const x=require(process.argv[1]);
if(x.schema!=="nexus.lean-release-state.v1"
  ||x.phase!=="staged"
  ||!/^[0-9a-f]{40}$/.test(x.runtimeSha)
  ||!/^[0-9a-f]{64}$/.test(x.artifactDigest))process.exit(1);
process.stdout.write(`${x.runtimeSha}:${x.artifactDigest}`);
' "$RELEASE_STATE"
)"

ssh "${DEPLOY_SERVER:-dominguez@serverdominguez}" bash -s <<'REMOTE_STAGING_MEDIA'
  set -euo pipefail
  BASE=/home/dominguez/telegram-hub-bot-staging
  RUNTIME="$(realpath -e "$BASE/current")"
  case "$RUNTIME" in "$BASE"/releases/*) ;; *) exit 1 ;; esac
  SELECTOR="$RUNTIME"
  cd "$RUNTIME"
  set -a; source "$BASE/.env"; set +a
  NEXUS_STAGING=1 \
  TRAINING_EXERCISE_MEDIA_SEED_APPLY_ACK=staging-only-reviewed-manifest \
    node dist/tools/training-exercise-media-seed.js \
      --apply --activate --target=staging
  test "$(realpath -e "$BASE/current")" = "$SELECTOR"
REMOTE_STAGING_MEDIA
```

Enable only an owner test scope in the staging `.env`, using one of:

```text
TRAINING_EXERCISE_MEDIA_V1_ENABLED_USER_<numeric-user-id>=true
TRAINING_EXERCISE_MEDIA_V1_ENABLED_TENANT_<numeric-tenant-id>=true
```

Restart staging and use an authenticated owner-device session to verify:

- a known canonical ID returns the exact package/asset metadata in all three
  locales;
- an unknown ID returns the governed not-found fallback;
- flag-off and wrong-tenant requests return the same hidden 404;
- a concrete ETag returns 304, while `If-None-Match: *` returns a fresh body;
- primary and supplemental URLs are on `https://media.nexushub.me`, return the
  recorded checksum, and retain immutable cache/security headers;
- takedown/unavailable behavior never falls back to superseded media.

## 6. Production validation, two-step seed, and promotion boundary

Before production promotion, run the standard staging smoke and dry-run while
the production flag remains off:

```bash
TRAINING_EXERCISE_MEDIA_CATALOG_ROOT="$PHASE0_ROOT" \
  npm run --silent training:exercise-media:verify:activation
./scripts/staging-smoke.sh
npm run release:promote -- \
  --dry-run --confirm "$RELEASE_CONFIRM"
```

Only the normal, explicit production-promotion approval may run:

```bash
NEXUS_RELEASE_OWNER_AUTHORIZED=1 \
  npm run release:promote -- \
    --confirm "$RELEASE_CONFIRM"
```

Production metadata publication uses a distinct fail-closed authorization path.
It never accepts the staging acknowledgement, requires the global flag to stay
off, binds both commands to all four immutable release identifiers, and refuses
to rotate a different active manifest. `--apply --activate` is deliberately
rejected in production.

Run the stage and activation as separate commands. The exact first-release
values below are the owner-reviewed subjects; changing any one requires another
code/review cycle and a new approval:

```bash
ssh "${DEPLOY_SERVER:-dominguez@serverdominguez}" bash -s <<'REMOTE_PRODUCTION_MEDIA'
  set -euo pipefail
  BASE=/home/dominguez/telegram-hub-bot
  RUNTIME="$(realpath -e "$BASE/current")"
  case "$RUNTIME" in "$BASE"/releases/*) ;; *) exit 1 ;; esac
  SELECTOR="$RUNTIME"
  cd "$RUNTIME"
  set -a; source "$BASE/.env"; set +a

  MANIFEST="training-exercise-media-v1-materialized-91829bc7100c-c7d8b39afcc6"
  PACKAGE="51c1089cceb8a916abf200b5cb3688b19f5f7553990467ee0f8ef01c7c4f74bb"
  RELEASE="27b97ebc96e1b3bb1ee3612e63c5609b5572c9d4b58e59b8ea3e77642fb1cea3"
  FINAL="1108f01773e9bac67a7d667989bfc8bf160ae338fef5520c239f2aa5569d6be5"

  NODE_ENV=production NEXUS_STAGING=0 \
  TRAINING_EXERCISE_MEDIA_V1_ENABLED=false \
  TRAINING_EXERCISE_MEDIA_PRODUCTION_MANIFEST_ID="$MANIFEST" \
  TRAINING_EXERCISE_MEDIA_PRODUCTION_PACKAGE_HASH="$PACKAGE" \
  TRAINING_EXERCISE_MEDIA_PRODUCTION_RELEASE_SUBJECT_HASH="$RELEASE" \
  TRAINING_EXERCISE_MEDIA_PRODUCTION_FINAL_APPROVAL_HASH="$FINAL" \
  TRAINING_EXERCISE_MEDIA_PRODUCTION_STAGE_ACK="production-stage:$MANIFEST:$PACKAGE:$RELEASE:$FINAL" \
    node dist/tools/training-exercise-media-seed.js \
      --apply --target=production --action=stage \
      | tee /tmp/training-media-production-stage.json

  jq -e --arg manifest "$MANIFEST" --arg package "$PACKAGE" \
    '.manifestId == $manifest and .packageHash == $package
     and .publicationState == "STAGED"
     and .staged == true and .activated == false' \
    /tmp/training-media-production-stage.json

  NODE_ENV=production NEXUS_STAGING=0 \
  TRAINING_EXERCISE_MEDIA_V1_ENABLED=false \
  TRAINING_EXERCISE_MEDIA_PRODUCTION_MANIFEST_ID="$MANIFEST" \
  TRAINING_EXERCISE_MEDIA_PRODUCTION_PACKAGE_HASH="$PACKAGE" \
  TRAINING_EXERCISE_MEDIA_PRODUCTION_RELEASE_SUBJECT_HASH="$RELEASE" \
  TRAINING_EXERCISE_MEDIA_PRODUCTION_FINAL_APPROVAL_HASH="$FINAL" \
  TRAINING_EXERCISE_MEDIA_PRODUCTION_ACTIVATE_ACK="production-activate:$MANIFEST:$PACKAGE:$RELEASE:$FINAL" \
    node dist/tools/training-exercise-media-seed.js \
      --apply --target=production --action=activate \
      | tee /tmp/training-media-production-activate.json

  jq -e --arg manifest "$MANIFEST" --arg package "$PACKAGE" \
    '.manifestId == $manifest and .packageHash == $package
     and .publicationState == "ACTIVE"
     and .staged == true and .activated == true' \
    /tmp/training-media-production-activate.json
  test "$(realpath -e "$BASE/current")" = "$SELECTOR"
REMOTE_PRODUCTION_MEDIA
```

Keep the global flag off after activation. Add only the reviewed owner user or
tenant scope, restart, and run the same hidden-404/ETag/hash/takedown smoke used
in staging. The first-release rollback is to remove that scoped opt-in (and
restart); database rotation is intentionally unsupported. A global flag flip,
if later approved, happens only after the scoped production smoke is green.
