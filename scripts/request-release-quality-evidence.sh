#!/usr/bin/env bash
# Dispatch the existing protected operational signer for advisory, redacted
# Sentry quality evidence while holding the existing release/Sonar host mutex.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

usage() {
  cat <<'EOF'
Usage: scripts/request-release-quality-evidence.sh \
  <server-request.json> <server-provenance-public-key.pem> <output.json> \
  [--server ServerDominguez] [--run-id <workflow-run-id>]
EOF
}

[ $# -ge 3 ] || { usage >&2; exit 64; }
REQUEST_INPUT="$1"
SERVER_PUBLIC_KEY_INPUT="$2"
OUTPUT_INPUT="$3"
shift 3
SERVER="${NEXUS_RELEASE_SERVER:-ServerDominguez}"
RUN_ID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER="$2"; shift 2 ;;
    --run-id) RUN_ID="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 64 ;;
  esac
done

[[ "$SERVER" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "invalid release server alias" >&2; exit 64; }
[[ -z "$RUN_ID" || "$RUN_ID" =~ ^[1-9][0-9]*$ ]] \
  || { echo "invalid release-quality workflow run id" >&2; exit 64; }
REQUEST="$(node -e 'process.stdout.write(require("path").resolve(process.argv[1]))' "$REQUEST_INPUT")"
SERVER_PUBLIC_KEY="$(node -e 'process.stdout.write(require("path").resolve(process.argv[1]))' "$SERVER_PUBLIC_KEY_INPUT")"
OUTPUT="$(node -e 'process.stdout.write(require("path").resolve(process.argv[1]))' "$OUTPUT_INPUT")"
for input in "$REQUEST" "$SERVER_PUBLIC_KEY"; do
  [ -f "$input" ] && [ ! -L "$input" ] || {
    echo "release-quality inputs must be regular non-symlink files" >&2
    exit 64
  }
done
request_size="$(wc -c < "$REQUEST" | tr -d '[:space:]')"
[[ "$request_size" =~ ^[0-9]+$ ]] && [ "$request_size" -gt 0 ] \
  && [ "$request_size" -le 45000 ] || {
  echo "release-quality request must be between 1 and 45000 bytes" >&2
  exit 64
}
output_parent="$(dirname "$OUTPUT")"
[ -d "$output_parent" ] && [ ! -L "$output_parent" ] || {
  echo "release-quality output parent must be an existing non-symlink directory" >&2
  exit 64
}

command -v gh >/dev/null 2>&1 || { echo "GitHub CLI is required" >&2; exit 1; }
command -v ssh >/dev/null 2>&1 || { echo "SSH is required" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "GitHub CLI authentication is required" >&2; exit 1; }

allow_expired_request=false
[ -z "$RUN_ID" ] || allow_expired_request=true
validated="$(node scripts/release-quality-evidence.mjs validate-server-request \
  --source-root "$ROOT" \
  --request "$REQUEST" \
  --server-public-key "$SERVER_PUBLIC_KEY" \
  --allow-expired-request "$allow_expired_request")"
read -r request_id runtime_sha < <(printf '%s' "$validated" | node -e '
let body="";
process.stdin.on("data",(chunk)=>{body+=chunk;});
process.stdin.on("end",()=>{
  const value=JSON.parse(body);
  const runtimeSha=value.windows?.current?.transactions?.at(-1)?.runtimeSha??"";
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.requestId??"")
      || !/^[0-9a-f]{40}$/.test(runtimeSha)) process.exit(1);
  process.stdout.write(`${value.requestId} ${runtimeSha}`);
});')
[[ "$request_id" =~ ^[0-9a-f-]{36}$ && "$runtime_sha" =~ ^[0-9a-f]{40}$ ]] || {
  echo "validated release-quality request identity is invalid" >&2
  exit 64
}

temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/nexus-release-quality.XXXXXX")"
fifo="$temporary_root/release-sonar-mutex.fifo"
ready="$temporary_root/release-sonar-mutex.ready"
errors="$temporary_root/release-sonar-mutex.err"
download="$temporary_root/download"
remote_mutex_pid=""
remote_mutex_open=false
temporary_output=""
cleanup() {
  status=$?
  if [ "$remote_mutex_open" = true ]; then
    exec 9>&-
    remote_mutex_open=false
  fi
  if [ -n "$remote_mutex_pid" ]; then
    wait "$remote_mutex_pid" 2>/dev/null || true
  fi
  [ -z "$temporary_output" ] || rm -f "$temporary_output"
  rm -rf "$temporary_root"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkfifo "$fifo"
chmod 600 "$fifo"
: > "$ready"
: > "$errors"
chmod 600 "$ready" "$errors"
exec 9<>"$fifo"
remote_mutex_open=true
ssh -o BatchMode=yes -o ConnectTimeout=10 "$SERVER" \
  'mutex=/run/lock/nexus-release-sonar.lock; command -v flock >/dev/null && test -f "$mutex" && test ! -L "$mutex" && test "$(stat -c "%U:%G:%a" "$mutex")" = root:dominguez:660 && exec sh -c '\''exec 8<>"$mutex"; flock -n 8 || exit 75; printf "NEXUS_MUTEX_ACQUIRED\n"; cat >/dev/null'\''' \
  < "$fifo" > "$ready" 2> "$errors" 9>&- &
remote_mutex_pid=$!
for _ in $(seq 1 100); do
  if grep -qx 'NEXUS_MUTEX_ACQUIRED' "$ready"; then break; fi
  if ! kill -0 "$remote_mutex_pid" 2>/dev/null; then break; fi
  sleep 0.1
done
grep -qx 'NEXUS_MUTEX_ACQUIRED' "$ready" || {
  echo "release-quality request blocked: shared remote release/Sonar mutex is unavailable" >&2
  sed -n '1,3p' "$errors" >&2 || true
  exit 75
}

for lock in \
  "$ROOT/.local/release/locks/prod-deploy.lock" \
  "$ROOT/.local/release/locks/staging-deploy.lock"; do
  [ ! -d "$lock" ] || {
    echo "release-quality request blocked: a local release lock is active" >&2
    exit 75
  }
done
ssh -o BatchMode=yes -o ConnectTimeout=10 "$SERVER" \
  'test ! -d /home/dominguez/telegram-hub-bot/.local/release/locks/prod-deploy.lock && test ! -d /home/dominguez/telegram-hub-bot-staging/.local/release/locks/staging-deploy.lock' \
  >/dev/null 2>&1 || {
  echo "release-quality request blocked: remote release lock state is active or unavailable" >&2
  exit 75
}

request_sha256="$(node -e '
const crypto=require("node:crypto"),fs=require("node:fs");
process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"));
' "$REQUEST")"
request_b64="$(base64 < "$REQUEST" | tr -d '\r\n')"
[ -n "$request_b64" ] && [ "${#request_b64}" -le 60000 ] || {
  echo "base64 release-quality request is empty or too large" >&2
  exit 64
}

ref=main
signing_workflow=sign-staging-attestation.yml
gh workflow view "$signing_workflow" --ref "$ref" --yaml >/dev/null 2>&1 || {
  echo "protected-main operational signing workflow is unavailable" >&2
  exit 1
}
title="Sign release_quality $request_id digest $request_sha256"
if [ -z "$RUN_ID" ]; then
  gh workflow run "$signing_workflow" --ref "$ref" \
    -f "evidence_kind=release_quality" \
    -f "request_id=$request_id" \
    -f "runtime_sha=$runtime_sha" \
    -f "request_sha256=$request_sha256" \
    -f "request_b64=$request_b64"
  for _ in $(seq 1 30); do
    RUN_ID="$(EXPECTED_TITLE="$title" gh run list \
      --workflow "$signing_workflow" \
      --branch main \
      --event workflow_dispatch \
      --limit 50 \
      --json databaseId,displayTitle,headBranch,event \
      | node -e '
        let body="";
        process.stdin.on("data",(chunk)=>{body+=chunk;});
        process.stdin.on("end",()=>{
          const matches=JSON.parse(body).filter((run)=>run.displayTitle===process.env.EXPECTED_TITLE
            &&run.headBranch==="main"&&run.event==="workflow_dispatch");
          if(matches.length>1)process.exit(65);
          if(matches.length===1)process.stdout.write(String(matches[0].databaseId));
        });'
    )" || {
      echo "release-quality signing workflow correlation is ambiguous" >&2
      exit 65
    }
    [ -z "$RUN_ID" ] || break
    sleep 2
  done
fi
[[ "$RUN_ID" =~ ^[1-9][0-9]*$ ]] || {
  echo "release-quality signing workflow run was not found" >&2
  exit 1
}

validate_run_identity() {
  local require_complete="$1"
  gh run view "$RUN_ID" --json \
    databaseId,displayTitle,headBranch,event,status,conclusion,workflowName \
    | node -e '
      let body="";
      process.stdin.on("data",(chunk)=>{body+=chunk;});
      process.stdin.on("end",()=>{
        const value=JSON.parse(body);
        const [id,title,complete]=process.argv.slice(1);
        if(String(value.databaseId)!==id||value.displayTitle!==title
            ||value.headBranch!=="main"||value.event!=="workflow_dispatch"
            ||value.workflowName!=="Release — Sign staging attestation")process.exit(1);
        if(complete==="1"&&(value.status!=="completed"||value.conclusion!=="success"))process.exit(1);
      });' "$RUN_ID" "$title" "$require_complete"
}
validate_run_identity 0 || { echo "release-quality signing run identity is invalid" >&2; exit 1; }
gh run watch "$RUN_ID" --exit-status
validate_run_identity 1 || {
  echo "completed release-quality signing run identity is invalid" >&2
  exit 1
}

mkdir -m 700 "$download"
gh run download "$RUN_ID" \
  --name "release-quality-$request_id" \
  --dir "$download"
signed_count="$(find "$download" -type f -name release-quality.json -print | wc -l | tr -d '[:space:]')"
[ "$signed_count" = 1 ] || {
  echo "signed release-quality artifact is missing or ambiguous" >&2
  exit 1
}
signed="$(find "$download" -type f -name release-quality.json -print -quit)"
node scripts/release-quality-evidence.mjs validate-evidence \
  --source-root "$ROOT" \
  --request "$REQUEST" \
  --server-public-key "$SERVER_PUBLIC_KEY" \
  --evidence "$signed" \
  --release-public-key "$ROOT/docs/release/evidence/release-evidence-public-key.pem" \
  --expect-runtime-sha "$runtime_sha" \
  --allow-expired-request true >/dev/null

temporary_output="$(mktemp "$output_parent/.release-quality.next.XXXXXX")"
install -m 600 "$signed" "$temporary_output"
if [ -e "$OUTPUT" ] || [ -L "$OUTPUT" ]; then
  [ -f "$OUTPUT" ] && [ ! -L "$OUTPUT" ] \
    && cmp -s "$temporary_output" "$OUTPUT" || {
    echo "existing release-quality output differs from the protected signer artifact" >&2
    exit 73
  }
  rm -f "$temporary_output"
  temporary_output=""
else
  mv "$temporary_output" "$OUTPUT"
  temporary_output=""
  chmod 600 "$OUTPUT"
fi
printf '{"ok":true,"requestId":"%s","workflowRunId":"%s","runtimeSha":"%s","requestSha256":"%s","evidence":"%s"}\n' \
  "$request_id" "$RUN_ID" "$runtime_sha" "$request_sha256" "$OUTPUT"
