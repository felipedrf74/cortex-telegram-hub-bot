#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# training-cross-skill-staging-smoke.sh — Cross-skill training smoke.
#
# Exit-code contract (consumers depend on this — do not overload):
#   0 -> pass
#   1 -> fail
#   2 -> intentionally blocked by design (e.g. the staging runtime section
#        under --dry-run). Callers such as scripts/full-nexus-local-engine.sh
#        and scripts/closed-beta-smoke.sh treat 2 as a benign outcome.
#   3 -> hard guard/identity refusal (staging-proof guard, release-base
#        guard, identity verification, evidence-path escape, supplied-identity
#        mismatch, production role). Never benign — always a real failure.
#
# Real staging proof requires an installed release: run this wrapper directly
# from the unpacked candidate with NEXUS_RELEASE_BASE_DIR set. From a source
# checkout only --dry-run is available, and its receipt is non-evidentiary.
# ─────────────────────────────────────────────────────
set -euo pipefail

# Distinct from 2 so a refusal can never be read as "blocked by design".
GUARD_REFUSAL_EXIT=3

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT_DIR"

# This smoke mutates a dedicated staging fixture user; production is refused at
# the shell level too, not only inside the TypeScript prerequisites.
if [ "${NEXUS_RELEASE_ROLE:-}" = "production" ]; then
  echo "Refusing cross-skill smoke: this smoke is staging-only (NEXUS_RELEASE_ROLE=production)." >&2
  exit "$GUARD_REFUSAL_EXIT"
fi

DRY_RUN=0
for arg in "$@"; do
  if [ "$arg" = "--dry-run" ]; then
    DRY_RUN=1
  fi
done

identity_from_json() {
  local identity_mode="$1"
  node -e '
let body = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { body += chunk; });
process.stdin.on("end", () => {
  const parsed = JSON.parse(body);
  const mode = process.argv[1];
  const expectedSchema = mode === "installed"
    ? "nexus.release-installed-source-verification.v1"
    : "nexus.release-artifact-manifest.v1";
  if (parsed.schema !== expectedSchema) process.exit(1);
  const runtimeSha = parsed.runtimeSha ?? parsed.git?.sha;
  const artifactDigest = parsed.artifactDigest ?? parsed.digest;
  if (!/^[0-9a-f]{40}$/.test(runtimeSha ?? "")
      || !/^[0-9a-f]{64}$/.test(artifactDigest ?? "")) process.exit(1);
  process.stdout.write(`${runtimeSha} ${artifactDigest}\n`);
});
' "$identity_mode"
}

if [ -f "$ROOT_DIR/.complete.json" ]; then
  if [ -z "${NEXUS_RELEASE_BASE_DIR:-}" ]; then
    echo "NEXUS_RELEASE_BASE_DIR is required so evidence stays outside immutable release bytes." >&2
    exit "$GUARD_REFUSAL_EXIT"
  fi
  VERIFIED_RELEASE_BASE="$(cd "$NEXUS_RELEASE_BASE_DIR" 2>/dev/null && pwd -P)" || {
    echo "NEXUS_RELEASE_BASE_DIR is not a readable directory." >&2
    exit "$GUARD_REFUSAL_EXIT"
  }
  case "$ROOT_DIR" in
    "$VERIFIED_RELEASE_BASE"/releases/*) ;;
    *)
      echo "Refusing cross-skill smoke: candidate is outside NEXUS_RELEASE_BASE_DIR/releases." >&2
      exit "$GUARD_REFUSAL_EXIT"
      ;;
  esac
  if [ -n "${NEXUS_RELEASE_DIR:-}" ]; then
    CONFIGURED_RELEASE_DIR="$(cd "$NEXUS_RELEASE_DIR" 2>/dev/null && pwd -P)" || {
      echo "NEXUS_RELEASE_DIR is not a readable directory." >&2
      exit "$GUARD_REFUSAL_EXIT"
    }
    if [ "$CONFIGURED_RELEASE_DIR" != "$ROOT_DIR" ]; then
      echo "Refusing cross-skill smoke: executing release differs from NEXUS_RELEASE_DIR." >&2
      exit "$GUARD_REFUSAL_EXIT"
    fi
  fi
  VERIFIED_IDENTITY="$(
    node scripts/release-artifact-manifest.mjs \
      --verify-installed-source "$ROOT_DIR" \
      --require-declared-file dist/tools/training-cross-skill-staging-smoke.js \
      | identity_from_json installed
  )" || {
    echo "Could not verify installed release identity." >&2
    exit "$GUARD_REFUSAL_EXIT"
  }
  VERIFIED_RUNTIME_SHA="${VERIFIED_IDENTITY%% *}"
  VERIFIED_ARTIFACT_DIGEST="${VERIFIED_IDENTITY#* }"
  export NEXUS_SMOKE_EVIDENCE_DIR="${NEXUS_SMOKE_EVIDENCE_DIR:-$VERIFIED_RELEASE_BASE/.local/release/smoke-evidence}"
  export TRAINING_CROSS_SKILL_STAGING_RESULTS_PATH="${TRAINING_CROSS_SKILL_STAGING_RESULTS_PATH:-$VERIFIED_RELEASE_BASE/.local/release/smoke-evidence/training-cross-skill-staging.md}"
  VERIFIED_JSON_EVIDENCE_DIR="$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$NEXUS_SMOKE_EVIDENCE_DIR")"
  VERIFIED_MARKDOWN_EVIDENCE_PATH="$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$TRAINING_CROSS_SKILL_STAGING_RESULTS_PATH")"
  case "$VERIFIED_JSON_EVIDENCE_DIR" in
    "$VERIFIED_RELEASE_BASE"/.local/*) ;;
    *)
      echo "Refusing cross-skill smoke: JSON evidence must stay under release-base/.local/." >&2
      exit "$GUARD_REFUSAL_EXIT"
      ;;
  esac
  case "$VERIFIED_MARKDOWN_EVIDENCE_PATH" in
    "$VERIFIED_RELEASE_BASE"/.local/*) ;;
    *)
      echo "Refusing cross-skill smoke: Markdown evidence must stay under release-base/.local/." >&2
      exit "$GUARD_REFUSAL_EXIT"
      ;;
  esac
else
  if [ "$DRY_RUN" != "1" ]; then
    echo "Refusing staging proof outside an installed release with a verified .complete.json marker." >&2
    exit "$GUARD_REFUSAL_EXIT"
  fi
  echo "Building current source before non-evidentiary dry-run smoke..."
  # A failed build must not inherit the compiler's exit code: tsc exits 2, which
  # callers read as "blocked by design" and would score a broken tree as benign.
  if ! npm run build >/dev/null; then
    echo "Refusing cross-skill smoke: source build failed before the dry-run." >&2
    exit "$GUARD_REFUSAL_EXIT"
  fi
  VERIFIED_IDENTITY="$(
    node scripts/release-artifact-manifest.mjs --root "$ROOT_DIR" --format json \
      | identity_from_json source
  )" || {
    echo "Could not derive freshly built source identity." >&2
    exit "$GUARD_REFUSAL_EXIT"
  }
  VERIFIED_RUNTIME_SHA="${VERIFIED_IDENTITY%% *}"
  VERIFIED_ARTIFACT_DIGEST="${VERIFIED_IDENTITY#* }"
fi

if [ -z "${VERIFIED_RUNTIME_SHA:-}" ] || [ -z "${VERIFIED_ARTIFACT_DIGEST:-}" ]; then
  echo "Could not derive a verified runtime/artifact identity." >&2
  exit "$GUARD_REFUSAL_EXIT"
fi
if [ -n "${NEXUS_RELEASE_SHA:-}" ] && [ "$NEXUS_RELEASE_SHA" != "$VERIFIED_RUNTIME_SHA" ]; then
  echo "Refusing cross-skill smoke: supplied runtime SHA differs from verified candidate bytes." >&2
  exit "$GUARD_REFUSAL_EXIT"
fi
if [ -n "${NEXUS_RELEASE_ARTIFACT_SHA256:-}" ] \
    && [ "$NEXUS_RELEASE_ARTIFACT_SHA256" != "$VERIFIED_ARTIFACT_DIGEST" ]; then
  echo "Refusing cross-skill smoke: supplied artifact digest differs from verified candidate bytes." >&2
  exit "$GUARD_REFUSAL_EXIT"
fi

export NEXUS_RELEASE_SHA="$VERIFIED_RUNTIME_SHA"
export NEXUS_RELEASE_ARTIFACT_SHA256="$VERIFIED_ARTIFACT_DIGEST"
export NEXUS_SMOKE_BUFFERED_CAPTURE=1
if [ -f "$ROOT_DIR/.complete.json" ]; then
  export NEXUS_RELEASE_DIR="$ROOT_DIR"
  export NEXUS_SMOKE_REQUIRE_EXACT_IDENTITY=1
else
  # Dry-run identity comes from a freshly built source manifest, not from an
  # installed release. Mark the receipt so its filename and payload can never
  # be mistaken for staging proof.
  export NEXUS_SMOKE_NON_EVIDENTIARY=1
fi

# Wrapped through with-smoke-evidence.sh so the run leaves a JSON evidence
# file under .local/release/smoke-evidence/. Disable with NEXUS_SMOKE_EVIDENCE=0.
exec scripts/with-smoke-evidence.sh training-cross-skill-staging \
  node dist/tools/training-cross-skill-staging-smoke.js "$@"
