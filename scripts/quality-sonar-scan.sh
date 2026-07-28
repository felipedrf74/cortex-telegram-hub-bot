#!/usr/bin/env bash
# Advisory Mac-side scanner. It analyzes a temporary clean exact origin/main,
# never runs tests, and waits for SonarQube Compute Engine completion.
set -euo pipefail
umask 077

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
SERVER_URL=http://127.0.0.1:9000
PROJECT_KEY="${SONAR_PROJECT_KEY:-nexus-hub-backend}"
TOKEN_FILE="${SONAR_TOKEN_FILE:-}"
SCANNER_BIN="${SONAR_SCANNER_BIN:-$(command -v sonar-scanner 2>/dev/null || true)}"
RELEASE_LOCK_HOST="${SONAR_RELEASE_LOCK_HOST:-ServerDominguez}"
COVERAGE_MANIFEST=""
OUTPUT=""
FETCH=true
POLL_SECONDS=10
TIMEOUT_SECONDS=900
SSH_BIN="$(command -v ssh 2>/dev/null || true)"
CURL_BIN="$(command -v curl 2>/dev/null || true)"
NODE_BIN="$(command -v node 2>/dev/null || true)"
SCANNER_VERIFY="$ROOT/scripts/quality-sonar-verify-scanner.sh"

usage() {
  cat <<'EOF'
Usage: quality-sonar-scan.sh --token-file <mode-0600-file> [options]
  --scanner-bin <pinned-sonar-scanner>
  --server-url <http://127.0.0.1:9000>
  --project-key <key>
  --coverage-manifest <SonarCoverageEvidenceV1.json>
  --release-lock-host <ssh-alias>
  --output <private-json-evidence>
  --no-fetch
  --poll-seconds <1-60>
  --timeout-seconds <60-3600>
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --token-file) TOKEN_FILE="$2"; shift 2 ;;
    --scanner-bin) SCANNER_BIN="$2"; shift 2 ;;
    --server-url) SERVER_URL="$2"; shift 2 ;;
    --project-key) PROJECT_KEY="$2"; shift 2 ;;
    --coverage-manifest) COVERAGE_MANIFEST="$2"; shift 2 ;;
    --release-lock-host) RELEASE_LOCK_HOST="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    --no-fetch) FETCH=false; shift ;;
    --poll-seconds) POLL_SECONDS="$2"; shift 2 ;;
    --timeout-seconds) TIMEOUT_SECONDS="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 64 ;;
  esac
done

[ -n "$ROOT" ] && [ -d "$ROOT/.git" -o -f "$ROOT/.git" ] || { echo "Run the scanner from a Nexus Hub Git worktree" >&2; exit 1; }
case "$SERVER_URL" in http://127.0.0.1:9000|http://localhost:9000) ;; *) echo "Sonar URL must be the local SSH-tunnel endpoint on port 9000" >&2; exit 64 ;; esac
[[ "$PROJECT_KEY" =~ ^[A-Za-z0-9_.:-]+$ ]] || { echo "Invalid Sonar project key" >&2; exit 64; }
[[ "$POLL_SECONDS" =~ ^[0-9]+$ ]] && [ "$POLL_SECONDS" -ge 1 ] && [ "$POLL_SECONDS" -le 60 ] || { echo "Invalid poll interval" >&2; exit 64; }
[[ "$TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] && [ "$TIMEOUT_SECONDS" -ge 60 ] && [ "$TIMEOUT_SECONDS" -le 3600 ] || { echo "Invalid CE timeout" >&2; exit 64; }
[ -n "$TOKEN_FILE" ] && [[ "$TOKEN_FILE" == /* ]] && [ -f "$TOKEN_FILE" ] && [ ! -L "$TOKEN_FILE" ] || { echo "A non-symlink absolute token file is required" >&2; exit 1; }
token_mode="$(stat -c '%a' "$TOKEN_FILE" 2>/dev/null || stat -f '%Lp' "$TOKEN_FILE")"
[ "$token_mode" = 600 ] || { echo "Sonar token file must have mode 0600" >&2; exit 1; }
token_owner="$(stat -c '%U' "$TOKEN_FILE" 2>/dev/null || stat -f '%Su' "$TOKEN_FILE")"
[ "$token_owner" = "$(id -un)" ] || { echo "Sonar token file must be owned by the scanner user" >&2; exit 1; }
[ -x "$SCANNER_BIN" ] || { echo "A pinned executable sonar-scanner is required" >&2; exit 1; }
[ -x "$SCANNER_VERIFY" ] || { echo "The governed scanner verifier is unavailable" >&2; exit 1; }
[ -x "$SSH_BIN" ] && [ -x "$CURL_BIN" ] && [ -x "$NODE_BIN" ] || { echo "ssh, curl, and node are required" >&2; exit 1; }
[[ "$RELEASE_LOCK_HOST" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "Invalid release-lock SSH alias" >&2; exit 64; }

token="$(tr -d '\r\n' <"$TOKEN_FILE")"
[ -n "$token" ] && [ "${#token}" -le 512 ] && [[ "$token" != *[[:space:]]* ]] || { echo "Invalid Sonar token file contents" >&2; exit 1; }

scan_lock="$ROOT/.local/sonarqube/scan.lock"
mkdir -p "$(dirname "$scan_lock")"
if ! mkdir "$scan_lock" 2>/dev/null; then
  echo "Another advisory Sonar scan appears active: $scan_lock" >&2
  exit 1
fi
printf 'pid=%s\nstartedAt=%s\n' "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$scan_lock/owner"
chmod 0600 "$scan_lock/owner"

tmp_root="$(mktemp -d)"
tmp_root="$(realpath "$tmp_root")"
source_root="$tmp_root/source"
auth_header="$tmp_root/sonar-auth-header"
ce_body="$tmp_root/ce-task.json"
quality_body="$tmp_root/quality-gate.json"
coverage_resolved="$tmp_root/coverage.json"
scanner_pid=""
remote_mutex_pid=""
remote_mutex_open=false
worktree_added=false

cleanup() {
  status=$?
  if [ -n "$scanner_pid" ] && kill -0 "$scanner_pid" 2>/dev/null; then
    kill -TERM "$scanner_pid" 2>/dev/null || true
    wait "$scanner_pid" 2>/dev/null || true
  fi
  if [ "$remote_mutex_open" = true ]; then
    exec 9>&-
    remote_mutex_open=false
  fi
  if [ -n "$remote_mutex_pid" ]; then
    kill -TERM "$remote_mutex_pid" 2>/dev/null || true
    wait "$remote_mutex_pid" 2>/dev/null || true
  fi
  unset token SONAR_TOKEN
  if [ "$worktree_added" = true ]; then
    git -C "$ROOT" worktree remove --force "$source_root" >/dev/null 2>&1 || true
  fi
  rm -rf "$tmp_root"
  rm -rf "$scan_lock"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

assert_no_release() {
  local lock
  for lock in \
    "$ROOT/.local/release/locks/release.lock"; do
    [ ! -d "$lock" ] || { echo "Advisory scan aborted: local release lock is active" >&2; return 1; }
  done
  "$SSH_BIN" -o BatchMode=yes -o ConnectTimeout=5 "$RELEASE_LOCK_HOST" \
    'state=/home/dominguez/.local/state/nexus-release; test -d "$state" && test -f "$state/.release.lock" && test ! -L "$state/.release.lock" && for role in staging production; do file="$state/$role.json"; test ! -f "$file" || ! grep -Eq '"'"'"status"[[:space:]]*:[[:space:]]*"running"'"'"' "$file"; done' \
    >/dev/null 2>&1 || {
      echo "Advisory scan aborted: a remote release is active or lock state is unavailable" >&2
      return 1
    }
}

acquire_remote_release_sonar_mutex() {
  local fifo="$tmp_root/release-sonar-mutex.fifo"
  local ready="$tmp_root/release-sonar-mutex.ready"
  local errors="$tmp_root/release-sonar-mutex.err"
  mkfifo "$fifo"
  chmod 0600 "$fifo"
  : >"$ready"
  : >"$errors"
  chmod 0600 "$ready" "$errors"
  # fd 9 is the sole writer keeping the remote `cat` alive. Closing it on any
  # local exit closes SSH stdin and releases both remote flocks automatically.
  # Scans and releases take the user lock first and the root/group lock second,
  # preventing both release overlap and root backup/restore overlap.
  exec 9<>"$fifo"
  remote_mutex_open=true
  "$SSH_BIN" -o BatchMode=yes -o ConnectTimeout=5 "$RELEASE_LOCK_HOST" \
    'state=/home/dominguez/.local/state/nexus-release; mutex="$state/.release.lock"; root_mutex=/run/lock/nexus-release-sonar.lock; command -v flock >/dev/null && install -d -m 700 "$state" && touch "$mutex" && chmod 600 "$mutex" && test -f "$mutex" && test ! -L "$mutex" && test -f "$root_mutex" && test ! -L "$root_mutex" && test "$(stat -c "%U:%G:%a" "$root_mutex")" = root:dominguez:660 && exec 8<>"$mutex" && exec 7<>"$root_mutex" && flock -n 8 && flock -n 7 && printf "NEXUS_MUTEX_ACQUIRED\n" && cat >/dev/null' \
    <"$fifo" >"$ready" 2>"$errors" 9>&- &
  remote_mutex_pid=$!
  for _ in $(seq 1 50); do
    if grep -qx 'NEXUS_MUTEX_ACQUIRED' "$ready"; then return 0; fi
    if ! kill -0 "$remote_mutex_pid" 2>/dev/null; then break; fi
    sleep 0.1
  done
  echo "Advisory scan aborted: shared remote release/Sonar mutex is unavailable" >&2
  sed -n '1,3p' "$errors" >&2 || true
  return 1
}

acquire_remote_release_sonar_mutex || exit 75
assert_no_release || exit 75
"$CURL_BIN" --fail --silent --show-error --connect-timeout 2 --max-time 5 \
  "$SERVER_URL/api/system/status" -o "$ce_body"
"$NODE_BIN" - "$ce_body" <<'NODE'
const fs = require('fs');
const body = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (body.status !== 'UP') throw new Error('SonarQube status is not UP');
NODE

if [ "$FETCH" = true ]; then
  git -C "$ROOT" fetch --quiet origin main
fi
runtime_sha="$(git -C "$ROOT" rev-parse --verify 'origin/main^{commit}')"
[[ "$runtime_sha" =~ ^[0-9a-f]{40}$ ]] || { echo "origin/main did not resolve to a full commit" >&2; exit 1; }
git -C "$ROOT" worktree add --quiet --detach "$source_root" "$runtime_sha"
worktree_added=true
[ "$(git -C "$source_root" rev-parse HEAD)" = "$runtime_sha" ] || { echo "Temporary scan worktree SHA mismatch" >&2; exit 1; }
[ -z "$(git -C "$source_root" status --porcelain=v1 --untracked-files=all)" ] || { echo "Temporary scan worktree is not clean" >&2; exit 1; }
git -C "$ROOT" show "$runtime_sha:ops/sonarqube/sonar-project.properties" >"$source_root/sonar-project.properties" || {
  echo "Exact origin/main does not contain the governed Sonar project settings" >&2
  exit 1
}
"$SCANNER_VERIFY" \
  --scanner-bin "$SCANNER_BIN" \
  --lock-file "$source_root/ops/sonarqube/scanner.lock.env" >/dev/null

scanner_args=(
  "-Dsonar.host.url=$SERVER_URL"
  "-Dsonar.projectKey=$PROJECT_KEY"
  "-Dsonar.scm.revision=$runtime_sha"
  "-Dsonar.qualitygate.wait=false"
)
coverage_imported=false

if [ -n "$COVERAGE_MANIFEST" ]; then
  [[ "$COVERAGE_MANIFEST" == /* ]] || COVERAGE_MANIFEST="$ROOT/$COVERAGE_MANIFEST"
  [ -f "$COVERAGE_MANIFEST" ] && [ ! -L "$COVERAGE_MANIFEST" ] || { echo "Coverage manifest must be a non-symlink file" >&2; exit 1; }
  "$NODE_BIN" - "$COVERAGE_MANIFEST" "$runtime_sha" "$coverage_resolved" <<'NODE'
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const [manifestPath, runtimeSha, output] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (value.schemaVersion !== 'SonarCoverageEvidenceV1') throw new Error('unsupported coverage manifest schema');
if (value.runtimeSha !== runtimeSha) throw new Error('coverage evidence is not bound to exact origin/main');
const base = path.dirname(path.resolve(manifestPath));
const resolveReport = (candidate, label) => {
  if (!candidate) return null;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
      || Object.keys(candidate).sort().join(',') !== 'path,sha256'
      || typeof candidate.path !== 'string'
      || !/^[0-9a-f]{64}$/.test(candidate.sha256 || '')) {
    throw new Error(`${label} coverage identity is invalid`);
  }
  const resolved = path.resolve(base, candidate.path);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('coverage report must be a non-symlink regular file');
  const observed = crypto.createHash('sha256').update(fs.readFileSync(resolved)).digest('hex');
  if (observed !== candidate.sha256) throw new Error(`${label} coverage digest mismatch`);
  return resolved;
};
const reports = {
  javascriptLcov: resolveReport(value.reports?.javascriptLcov, 'JavaScript'),
  pythonXml: resolveReport(value.reports?.pythonXml, 'Python'),
};
if (!reports.javascriptLcov && !reports.pythonXml) throw new Error('coverage manifest has no reports');
fs.writeFileSync(output, `${JSON.stringify({ runtimeSha, reports })}\n`, { mode: 0o600 });
NODE
  mkdir -m 0700 "$source_root/.sonar-coverage"
  lcov_path="$($NODE_BIN -e 'const v=require(process.argv[1]);process.stdout.write(v.reports.javascriptLcov||"")' "$coverage_resolved")"
  python_path="$($NODE_BIN -e 'const v=require(process.argv[1]);process.stdout.write(v.reports.pythonXml||"")' "$coverage_resolved")"
  if [ -n "$lcov_path" ]; then
    cp "$lcov_path" "$source_root/.sonar-coverage/lcov.info"
    scanner_args+=("-Dsonar.javascript.lcov.reportPaths=.sonar-coverage/lcov.info")
  fi
  if [ -n "$python_path" ]; then
    cp "$python_path" "$source_root/.sonar-coverage/python-coverage.xml"
    scanner_args+=("-Dsonar.python.coverage.reportPaths=.sonar-coverage/python-coverage.xml")
  fi
  coverage_imported=true
fi

assert_no_release || exit 75
(
  cd "$source_root"
  SONAR_TOKEN="$token" "$SCANNER_BIN" "${scanner_args[@]}"
) &
scanner_pid=$!

while kill -0 "$scanner_pid" 2>/dev/null; do
  sleep "$POLL_SECONDS"
  if ! assert_no_release; then
    kill -TERM "$scanner_pid" 2>/dev/null || true
    wait "$scanner_pid" 2>/dev/null || true
    scanner_pid=""
    exit 75
  fi
done
set +e
wait "$scanner_pid"
scanner_status=$?
set -e
scanner_pid=""
[ "$scanner_status" -eq 0 ] || { echo "Sonar scanner failed with status $scanner_status" >&2; exit "$scanner_status"; }

report_task="$source_root/.scannerwork/report-task.txt"
[ -f "$report_task" ] || { echo "Scanner did not emit report-task.txt" >&2; exit 1; }
ce_task_id="$(awk -F= '$1 == "ceTaskId" { print $2; exit }' "$report_task")"
[[ "$ce_task_id" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "Scanner emitted an invalid CE task ID" >&2; exit 1; }
printf 'Authorization: Bearer %s\n' "$token" >"$auth_header"
chmod 0600 "$auth_header"
unset token

deadline=$((SECONDS + TIMEOUT_SECONDS))
ce_status=PENDING
analysis_id=""
while [ "$SECONDS" -lt "$deadline" ]; do
  assert_no_release || exit 75
  "$CURL_BIN" --fail --silent --show-error --connect-timeout 2 --max-time 10 \
    -H @"$auth_header" "$SERVER_URL/api/ce/task?id=$ce_task_id" -o "$ce_body"
  ce_status="$($NODE_BIN -e 'const v=require(process.argv[1]);process.stdout.write(v.task?.status||"")' "$ce_body")"
  analysis_id="$($NODE_BIN -e 'const v=require(process.argv[1]);process.stdout.write(v.task?.analysisId||"")' "$ce_body")"
  case "$ce_status" in
    SUCCESS) break ;;
    FAILED|CANCELED) echo "Sonar Compute Engine task ended with status $ce_status" >&2; exit 1 ;;
    PENDING|IN_PROGRESS) sleep "$POLL_SECONDS" ;;
    *) echo "Sonar Compute Engine returned an unexpected task status" >&2; exit 1 ;;
  esac
done
[ "$ce_status" = SUCCESS ] || { echo "Timed out waiting for Sonar Compute Engine completion" >&2; exit 1; }

quality_status=UNKNOWN
if [[ "$analysis_id" =~ ^[A-Za-z0-9_-]+$ ]]; then
  if "$CURL_BIN" --fail --silent --show-error --connect-timeout 2 --max-time 10 \
      -H @"$auth_header" "$SERVER_URL/api/qualitygates/project_status?analysisId=$analysis_id" -o "$quality_body"; then
    quality_status="$($NODE_BIN -e 'const v=require(process.argv[1]);process.stdout.write(v.projectStatus?.status||"UNKNOWN")' "$quality_body")"
  fi
fi

if [ -z "$OUTPUT" ]; then OUTPUT="$ROOT/.local/sonarqube/scans/$runtime_sha.json"; fi
[[ "$OUTPUT" == /* ]] || OUTPUT="$ROOT/$OUTPUT"
mkdir -p "$(dirname "$OUTPUT")"
"$NODE_BIN" - "$OUTPUT" "$runtime_sha" "$ce_task_id" "$analysis_id" "$ce_status" "$quality_status" "$coverage_imported" <<'NODE'
const fs = require('fs');
const [output, runtimeSha, ceTaskId, analysisId, ceStatus, qualityGateStatus, coverageImported] = process.argv.slice(2);
const evidence = {
  schemaVersion: 'SonarAdvisoryScanV1',
  advisory: true,
  releaseGate: false,
  runtimeSha,
  ceTaskId,
  analysisId: analysisId || null,
  ceStatus,
  qualityGateStatus,
  coverageImported: coverageImported === 'true',
  completedAt: new Date().toISOString(),
};
fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
NODE
chmod 0600 "$OUTPUT"
echo "sonar_advisory_scan_complete sha=$runtime_sha ceStatus=$ce_status qualityGate=$quality_status coverageImported=$coverage_imported evidence=$OUTPUT"
