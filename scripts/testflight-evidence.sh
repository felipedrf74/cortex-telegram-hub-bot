#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# testflight-evidence.sh — Record machine-readable E5 (signed TestFlight)
#                          walk-through evidence.
#
# Closes ENG-EXC-O6 (closed-beta-auth-hardening, 2026-05-04). The iOS
# frontend-validation checklist defines E1–E5 evidence levels:
#
#   E1 — unit/contract test
#   E2 — simulator workflow
#   E3 — physical-device interaction
#   E4 — staging smoke + production health
#   E5 — signed TestFlight or two-account walk-through
#
# Until now, E5 had no machine-readable artifact. This script writes a
# structured JSON record under
# `.local/release/testflight-evidence/<sha>-<timestamp>.json`,
# mirroring the staging-smoke-evidence shape so future scripts (the
# release-doc-drift-check, the cannot-skip-gate dashboard, the doc
# audit) can refer to it without grepping markdown.
#
# Inputs (all required unless noted):
#   --sha <git-sha>             Engine commit SHA being validated.
#   --version <release-version> Production version string (e.g. 4.14.128).
#   --device-udid <udid>        Physical iPhone UDID.
#   --ios-version <version>     e.g. 26.5
#   --build-flavor <release|debug>  Build configuration tested.
#   --workflow <name>           Workflow exercised (e.g. workflow-A through I,
#                                or "two-account-walkthrough").
#   --outcome <pass|fail|partial>  Verdict.
#   --evidence-paths <list>     Comma-separated screenshot/recording paths.
#   --steps <text>              Free-text steps performed (becomes summary).
#   --note <text>               Optional operator note.
#   --apply                     Actually write the evidence file. Default is
#                                dry-run (prints to stdout).
#
# Outputs:
#   - JSON to stdout (always).
#   - Evidence file at the canonical path (only with --apply).
#
# Reference shape: see staging-smoke evidence under
# `engine/.local/release/smoke-evidence/`.
# ─────────────────────────────────────────────────────
set -euo pipefail

ENGINE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EVIDENCE_DIR="$ENGINE_ROOT/.local/release/testflight-evidence"

SHA=""
VERSION=""
DEVICE_UDID=""
IOS_VERSION=""
BUILD_FLAVOR=""
WORKFLOW=""
OUTCOME=""
EVIDENCE_PATHS=""
STEPS=""
NOTE=""
APPLY=false

while [ $# -gt 0 ]; do
  case "$1" in
    --sha)            SHA="$2"; shift 2;;
    --version)        VERSION="$2"; shift 2;;
    --device-udid)    DEVICE_UDID="$2"; shift 2;;
    --ios-version)    IOS_VERSION="$2"; shift 2;;
    --build-flavor)   BUILD_FLAVOR="$2"; shift 2;;
    --workflow)       WORKFLOW="$2"; shift 2;;
    --outcome)        OUTCOME="$2"; shift 2;;
    --evidence-paths) EVIDENCE_PATHS="$2"; shift 2;;
    --steps)          STEPS="$2"; shift 2;;
    --note)           NOTE="$2"; shift 2;;
    --apply)          APPLY=true; shift;;
    -h|--help)
      sed -n '2,46p' "$0" | sed 's/^# \?//'
      exit 0;;
    *) echo "Unknown arg: $1" >&2; exit 2;;
  esac
done

# Validate required args
missing=()
[ -z "$SHA" ]            && missing+=(--sha)
[ -z "$VERSION" ]        && missing+=(--version)
[ -z "$DEVICE_UDID" ]    && missing+=(--device-udid)
[ -z "$IOS_VERSION" ]    && missing+=(--ios-version)
[ -z "$BUILD_FLAVOR" ]   && missing+=(--build-flavor)
[ -z "$WORKFLOW" ]       && missing+=(--workflow)
[ -z "$OUTCOME" ]        && missing+=(--outcome)
[ -z "$STEPS" ]          && missing+=(--steps)
if [ ${#missing[@]} -gt 0 ]; then
  echo "Missing required: ${missing[*]}" >&2
  exit 2
fi

case "$OUTCOME" in
  pass|fail|partial) ;;
  *) echo "Unknown outcome: $OUTCOME (must be pass | fail | partial)" >&2; exit 2;;
esac
case "$BUILD_FLAVOR" in
  release|debug) ;;
  *) echo "Unknown build-flavor: $BUILD_FLAVOR (must be release | debug)" >&2; exit 2;;
esac

TS="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
EVIDENCE_FILE="$EVIDENCE_DIR/testflight-${SHA:0:7}-${WORKFLOW//[^a-zA-Z0-9]/-}-${TS}.json"

# Build the JSON payload via node so escaping is correct.
PAYLOAD=$(SHA="$SHA" VERSION="$VERSION" DEVICE_UDID="$DEVICE_UDID" \
  IOS_VERSION="$IOS_VERSION" BUILD_FLAVOR="$BUILD_FLAVOR" \
  WORKFLOW="$WORKFLOW" OUTCOME="$OUTCOME" \
  EVIDENCE_PATHS="$EVIDENCE_PATHS" STEPS="$STEPS" NOTE="$NOTE" \
  TS="$TS" \
  node -e '
    const evidence = (process.env.EVIDENCE_PATHS || "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    process.stdout.write(JSON.stringify({
      version: "1",
      schema: "engine/scripts/testflight-evidence.sh",
      generatedAt: new Date().toISOString(),
      runIdentifier: process.env.TS,
      engineSha: process.env.SHA,
      releaseVersion: process.env.VERSION,
      device: {
        udid: process.env.DEVICE_UDID,
        iosVersion: process.env.IOS_VERSION,
      },
      build: {
        flavor: process.env.BUILD_FLAVOR,
      },
      workflow: process.env.WORKFLOW,
      outcome: process.env.OUTCOME,
      evidencePaths: evidence,
      steps: process.env.STEPS,
      note: process.env.NOTE || null,
    }, null, 2));
  ')

printf '%s\n' "$PAYLOAD"

if [ "$APPLY" = true ]; then
  mkdir -p "$EVIDENCE_DIR"
  printf '%s\n' "$PAYLOAD" > "$EVIDENCE_FILE"
  echo ""
  echo "Wrote evidence: ${EVIDENCE_FILE#"$ENGINE_ROOT/"}"
fi
