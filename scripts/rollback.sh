#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# rollback.sh — Rollback Nexus Hub to a previous version
#
# Audit Quarter item: tested rollback procedure. This script is the
# orchestrator that ships on Felipe's Mac; the heavy lifting (extraction,
# integrity check, pre-restore snapshot, file replacement) happens on the
# production server via scripts/restore.sh which was written with both
# dry-run and apply modes in QW-10.
#
# Usage:
#   ./scripts/rollback.sh                     # List available backups (read-only)
#   ./scripts/rollback.sh --dry-run latest    # Dry-run restore of latest backup
#   ./scripts/rollback.sh --dry-run v4.9.20   # Dry-run restore of specific version
#   Apply mode is retired. Production recovery must use the signed,
#   root-owned promotion transaction so selectors, artifacts, database state,
#   PM2 identity, and rollback evidence remain one atomic authority.
#
# Safety rails this script adds on top of restore.sh:
#   1. Interactive confirmation prompt showing current→target version
#   2. PM2 stop/start orchestration around the restore
#   3. Dependency reinstall (npm ci) in case package.json changed between
#      the current version and the rollback target
#   4. Health check against /health after restart (confirms the bot is
#      actually serving, not just that PM2 thinks it's running)
#   5. Pre-restore snapshot includes data/bot.db (previous version of this
#      script did NOT include it — QW-10 finding)
# ─────────────────────────────────────────────────────
set -euo pipefail

SERVER="${DEPLOY_SERVER:-dominguez@serverdominguez}"
REMOTE_DIR="${DEPLOY_PATH:-/home/dominguez/telegram-hub-bot}"
LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$LOCAL_DIR/scripts/lib/release-gates.sh"
BACKUP_DIR="${NEXUS_BACKUP_DIR:-/home/dominguez/backups/nexushub}"
PM2="${NEXUS_PM2_BIN:-/home/dominguez/.npm-global/bin/pm2}"

# ── Parse args ───────────────────────────────────────
DRY_RUN=false
VERSION=""
BACKUP_FILE_OVERRIDE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --backup-file)
      if [ "$#" -lt 2 ]; then
        echo "❌ --backup-file requires an absolute backup path"
        exit 2
      fi
      BACKUP_FILE_OVERRIDE="$2"
      shift 2
      ;;
    -h|--help)
      sed -n '2,28p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      VERSION="$1"
      shift
      ;;
  esac
done

# The historical apply lane stopped PM2 directly, installed dependencies from
# the network, overwrote the live database, and mutated current/current.next
# outside the root-owned v3 journal. Keep only inventory and offline dry-run
# validation; there is intentionally no environment-variable bypass.
if [ "$DRY_RUN" != true ] \
    && { [ -n "$VERSION" ] || [ -n "$BACKUP_FILE_OVERRIDE" ]; }; then
  echo "❌ Direct rollback apply is retired. Use the signed root-owned promotion recovery transaction." >&2
  exit 77
fi

echo "═══════════════════════════════════════════════"
echo "  🔄 Nexus Hub Rollback Tool"
echo "═══════════════════════════════════════════════"
echo ""

# ── List available backups ───────────────────────────
echo "📦 Available backups on server:"
echo ""
# Batch archive size, data presence, and release identity into one SSH call.
# The archive manifest is authoritative. Historical archives without a
# manifest fall back to the archived package.json version and finally to the
# old filename convention, so existing operator commands remain usable.
METADATA="$(ssh "$SERVER" bash -s -- "$BACKUP_DIR" <<'REMOTE_BACKUP_METADATA'
set -euo pipefail
backup_dir="$1"
node_bin=/usr/bin/node
if [ ! -x "$node_bin" ]; then node_bin="$(command -v node || true)"; fi
[ -n "$node_bin" ] || { echo "Node is required to inspect backup identity" >&2; exit 1; }

while IFS= read -r archive; do
  [ -n "$archive" ] || continue
  size="$(du -h "$archive" | cut -f1)"
  has_db=0
  if tar tzf "$archive" 2>/dev/null | awk '$0 == "data/bot.db" { found = 1 } END { exit found ? 0 : 1 }'; then
    has_db=1
  fi

  manifest="$(tar xOzf "$archive" .nexus-backup-manifest.json 2>/dev/null || true)"
  archived_version=""
  before_version=""
  identity_source=""
  if [ -n "$manifest" ]; then
    identity="$(printf '%s' "$manifest" | "$node_bin" -e '
      const fs = require("fs");
      const value = JSON.parse(fs.readFileSync(0, "utf8"));
      const valid = input => typeof input === "string" && /^[0-9A-Za-z.+-]+$/.test(input);
      if (value.schema !== "nexus.release-backup.v1" || !valid(value.archivedVersion)) {
        throw new Error("backup manifest release identity is invalid");
      }
      if (value.targetVersion != null && !valid(value.targetVersion)) {
        throw new Error("backup manifest target identity is invalid");
      }
      process.stdout.write(`${value.archivedVersion}|${value.targetVersion || ""}`);
    ')"
    archived_version="${identity%%|*}"
    before_version="${identity#*|}"
    identity_source="manifest"
  else
    package_body="$(tar xOzf "$archive" package.json 2>/dev/null || true)"
    if [ -n "$package_body" ]; then
      archived_version="$(printf '%s' "$package_body" | "$node_bin" -e '
        const fs = require("fs");
        try {
          const value = JSON.parse(fs.readFileSync(0, "utf8"));
          if (typeof value.version === "string" && /^[0-9A-Za-z.+-]+$/.test(value.version)) {
            process.stdout.write(value.version);
          }
        } catch {}
      ')"
    fi
    identity_source="legacy-package"
    filename="$(basename "$archive")"
    if [[ "$filename" =~ ^v([^_]+)_before-v([^_]+)_[0-9]{8}_[0-9]{6}\.tar\.gz$ ]]; then
      [ -n "$archived_version" ] || archived_version="${BASH_REMATCH[1]}"
      before_version="${BASH_REMATCH[2]}"
    elif [ -z "$archived_version" ] && [[ "$filename" =~ ^v([^_]+)_[0-9]{8}_[0-9]{6}\.tar\.gz$ ]]; then
      archived_version="${BASH_REMATCH[1]}"
      identity_source="legacy-filename"
    fi
  fi

  [[ "$archived_version" =~ ^[0-9A-Za-z.+-]+$ ]] || {
    echo "Unable to determine archived version for $archive" >&2
    exit 1
  }
  printf '%s|%s|%s|%s|%s|%s\n' \
    "$archive" "$size" "$has_db" "$archived_version" "$before_version" "$identity_source"
done < <(ls -1t "$backup_dir"/v*.tar.gz 2>/dev/null || true)
REMOTE_BACKUP_METADATA
)"

if [ -z "$METADATA" ]; then
  echo "   ❌ No backups found at $BACKUP_DIR"
  echo "   Run a deploy first to create a backup."
  exit 1
fi

i=1
while IFS='|' read -r backup size has_db archived_version before_version identity_source; do
  [ -z "$backup" ] && continue
  fname=$(basename "$backup")
  if [ "$has_db" = "1" ]; then
    db_flag=" [includes data]"
  else
    db_flag=" [code only ⚠️]"
  fi
  if [ -n "$before_version" ]; then
    identity_flag=" [archive v${archived_version}, before v${before_version}]"
  elif [ "$identity_source" = "manifest" ]; then
    identity_flag=" [archive v${archived_version}]"
  else
    identity_flag=" [archive v${archived_version}, legacy metadata]"
  fi
  echo "   [$i] $fname ($size)$db_flag$identity_flag"
  i=$((i + 1))
done <<< "$METADATA"
echo ""

# ── If no version specified, just list and exit ──────
if [ -z "$VERSION" ] && [ -z "$BACKUP_FILE_OVERRIDE" ]; then
  echo "Usage:"
  echo "  ./scripts/rollback.sh --dry-run latest      # Validate backup without applying"
  echo ""
  echo "Production recovery is available only through the signed root-owned transaction."
  exit 0
fi

# ── Find the backup file by archived runtime identity ──
BACKUP_FILE=""
SELECTED_METADATA=""
if [ -n "$BACKUP_FILE_OVERRIDE" ]; then
  case "$BACKUP_FILE_OVERRIDE" in
    "$BACKUP_DIR"/v*.tar.gz) ;;
    *)
      echo "❌ --backup-file must name a deploy backup inside $BACKUP_DIR"
      exit 1
      ;;
  esac
  while IFS='|' read -r backup _; do
    if [ "$backup" = "$BACKUP_FILE_OVERRIDE" ]; then
      BACKUP_FILE="$backup"
      SELECTED_METADATA="$(printf '%s\n' "$METADATA" | awk -F'|' -v selected="$backup" '$1 == selected { print; exit }')"
      break
    fi
  done <<< "$METADATA"
elif [ "$VERSION" = "latest" ]; then
  SELECTED_METADATA="$(printf '%s\n' "$METADATA" | head -1)"
  BACKUP_FILE="${SELECTED_METADATA%%|*}"
else
  CLEAN_VERSION="${VERSION#v}"
  while IFS='|' read -r backup _size _has_db archived_version _before_version _identity_source; do
    if [ "$archived_version" = "$CLEAN_VERSION" ]; then
      BACKUP_FILE="$backup"
      SELECTED_METADATA="$(printf '%s\n' "$METADATA" | awk -F'|' -v selected="$backup" '$1 == selected { print; exit }')"
      break
    fi
  done <<< "$METADATA"
fi

if [ -z "$BACKUP_FILE" ] || [ -z "$SELECTED_METADATA" ]; then
  if [ -n "$BACKUP_FILE_OVERRIDE" ]; then
    echo "❌ Exact backup is not present on the server: $BACKUP_FILE_OVERRIDE"
  else
    echo "❌ No backup found for archived version $VERSION"
    echo "   Available archived versions:"
    printf '%s\n' "$METADATA" | cut -d'|' -f4 | sort -u | sed 's/^/   - v/'
  fi
  exit 1
fi

IFS='|' read -r _selected_path _selected_size _selected_has_db TARGET_VERSION BACKUP_CREATED_BEFORE_VERSION _selected_source <<< "$SELECTED_METADATA"
[[ "$TARGET_VERSION" =~ ^[0-9A-Za-z.+-]+$ ]] || {
  echo "❌ Selected archive has no trustworthy archivedVersion"
  exit 1
}
BACKUP_NAME=$(basename "$BACKUP_FILE")
echo "🎯 Selected: $BACKUP_NAME"
if [ -n "$BACKUP_CREATED_BEFORE_VERSION" ]; then
  echo "   Rollback target: v${TARGET_VERSION} (archived before v${BACKUP_CREATED_BEFORE_VERSION})"
else
  echo "   Rollback target: v${TARGET_VERSION}"
fi
echo ""

# ── DRY-RUN mode: just run restore.sh dry-run remotely ───
if [ "$DRY_RUN" = true ]; then
  echo "🔍 Dry-run mode — extracting backup to a temp dir, running integrity check."
  echo "   No changes will be made to production."
  echo ""
  ssh "$SERVER" "cd $REMOTE_DIR && bash scripts/restore.sh $(printf '%q' "$BACKUP_FILE")"
  RESTORE_EXIT=$?
  echo ""
  if [ $RESTORE_EXIT -eq 0 ]; then
    echo "═══════════════════════════════════════════════"
    echo "  ✅ Dry-run complete — backup is restorable"
    echo "═══════════════════════════════════════════════"
    echo ""
    echo "To recover production, submit the exact signed root-owned recovery transaction."
  else
    echo "❌ Dry-run failed — this backup is NOT safe to restore"
    exit 1
  fi
  exit 0
fi

# ── APPLY mode: prove the active runtime before any mutation ──
# A versioned production install runs from BASE/current -> BASE/releases/....
# Refuse to stop anything if PM2 is actually serving a different cwd. This
# prevents a stale symlink, stale operator shell, or split PM2 state from
# turning a rollback into an unbounded filesystem mutation.
ACTIVE_RUNTIME_METADATA="$(ssh "$SERVER" bash -s -- "$REMOTE_DIR" "$PM2" <<'REMOTE_ACTIVE_RUNTIME'
set -euo pipefail
requested_base_dir="$1"
pm2_bin="$2"
[ -d "$requested_base_dir" ] || { echo "production base directory is missing" >&2; exit 1; }
base_dir="$(cd "$requested_base_dir" && pwd -P)"
[ -x "$pm2_bin" ] || { echo "PM2 is unavailable" >&2; exit 1; }

active_runtime=""
if [ -L "$base_dir/current" ]; then
  active_runtime="$(cd "$base_dir/current" && pwd -P)"
  [ -d "$active_runtime" ] || { echo "production current symlink is broken" >&2; exit 1; }
elif [ -e "$base_dir/current" ]; then
  echo "production current path is not a symlink" >&2
  exit 1
else
  active_runtime="$base_dir"
fi
[ -n "$active_runtime" ] || { echo "active runtime could not be resolved" >&2; exit 1; }
if [ "$active_runtime" != "$base_dir" ] && [[ "$active_runtime" != "$base_dir"/releases/* ]]; then
  echo "active runtime escapes the production base: $active_runtime" >&2
  exit 1
fi

node_bin=/usr/bin/node
if [ ! -x "$node_bin" ]; then node_bin="$(command -v node || true)"; fi
[ -n "$node_bin" ] || { echo "Node is unavailable" >&2; exit 1; }
current_version="$("$node_bin" -e '
  const value = require(process.argv[1]);
  if (typeof value.version !== "string" || !value.version) process.exit(1);
  process.stdout.write(value.version);
' "$active_runtime/package.json")"

"$pm2_bin" jlist | "$node_bin" -e '
  const fs = require("fs");
  const path = require("path");
  const rows = JSON.parse(fs.readFileSync(0, "utf8"));
  const runtime = process.argv[1];
  const expected = new Map([
    ["nexus-hub", runtime],
    ["content-engine", path.join(runtime, "content-engine")],
  ]);
  for (const [name, cwd] of expected) {
    const row = rows.find(entry => entry?.name === name);
    const actual = row?.pm2_env?.pm_cwd;
    if (row?.pm2_env?.status !== "online") {
      throw new Error(`PM2 process is not online before rollback: ${name}`);
    }
    if (typeof actual !== "string" || path.resolve(actual) !== path.resolve(cwd)) {
      throw new Error(`PM2 cwd does not match active runtime: ${name} expected=${cwd} actual=${actual || "missing"}`);
    }
  }
' "$active_runtime"
printf '%s|%s\n' "$active_runtime" "$current_version"
REMOTE_ACTIVE_RUNTIME
)"
IFS='|' read -r ACTIVE_RUNTIME CURRENT_VERSION <<< "$ACTIVE_RUNTIME_METADATA"

echo "⚠️  This will rollback from v${CURRENT_VERSION} to v${TARGET_VERSION}"
echo "   Active runtime proved at: $ACTIVE_RUNTIME"
echo "   Pre-restore snapshot will be saved automatically."
if [ "${NEXUS_ROLLBACK_AUTO_CONFIRM:-0}" = "1" ]; then
  echo "   NEXUS_ROLLBACK_AUTO_CONFIRM=1 — confirmation supplied by caller"
  CONFIRM="YES"
else
  read -p "   Continue? (type YES to confirm) " CONFIRM
fi
echo ""

if [ "$CONFIRM" != "YES" ]; then
  echo "❌ Rollback cancelled"
  exit 0
fi

# Manual rollback shares the same cross-worktree production lock as exact
# promotion and the legacy deploy path. Acquire only after confirmation so an
# interactive prompt never holds production mutual exclusion indefinitely.
trap release_cleanup_all_locks EXIT
release_acquire_local_lock "$LOCAL_DIR" "prod-deploy"
release_acquire_remote_lock "$SERVER" "$REMOTE_DIR" "prod-deploy"

# ── 1. Stop services ────────────────────────────────
echo ""
echo "🛑 Stopping services..."
ssh "$SERVER" bash -s -- "$PM2" <<'REMOTE_STOP_ROLLBACK'
set -euo pipefail
pm2_bin="$1"
for app in nexus-hub content-engine; do
  "$pm2_bin" describe "$app" >/dev/null
  "$pm2_bin" stop "$app" >/dev/null
done
"$pm2_bin" jlist | /usr/bin/node -e '
  const fs = require("fs");
  const rows = JSON.parse(fs.readFileSync(0, "utf8"));
  for (const name of ["nexus-hub", "content-engine"]) {
    const row = rows.find(entry => entry?.name === name);
    if (!row || row.pm2_env?.status !== "stopped" || Number(row.pid || 0) !== 0) {
      throw new Error(`PM2 process did not stop: ${name}`);
    }
  }
'
echo "   Stopped."
REMOTE_STOP_ROLLBACK

# ── 2. Wait for both loopback ports to release ──────
echo "   Waiting for ports 8200 and 8100 to release..."
ssh "$SERVER" bash -s <<'REMOTE_WAIT_ROLLBACK_PORTS'
  set -euo pipefail
  for i in $(seq 1 30); do
    listening="$(ss -tln 2>/dev/null || true)"
    if ! printf '%s\n' "$listening" | grep -Eq ':(8200|8100)[[:space:]]'; then
      echo "   ✅ Ports 8200 and 8100 free (after ${i}s)"
      exit 0
    fi
    sleep 1
  done
  echo "Ports 8200 or 8100 remain bound after 30s" >&2
  exit 1
REMOTE_WAIT_ROLLBACK_PORTS

# ── 3. Run restore.sh --apply on the server ─────────
# The restore script handles:
#   - Pre-restore snapshot of current dist + catalog + bot.db (for undo)
#   - Integrity check on the backup DB before replacing
#   - Atomic file swap (dist, catalog, migrations, prompts, bot.db, garmin-tokens)
# We pipe "YES" to confirm non-interactively since we already prompted above.
echo ""
echo "📥 Restoring from $BACKUP_NAME..."
ssh "$SERVER" "cd $REMOTE_DIR && printf 'YES\\n' | REMOTE_DIR=$REMOTE_DIR BACKUP_DIR=$BACKUP_DIR bash scripts/restore.sh --apply $(printf '%q' "$BACKUP_FILE")"

# ── 4. Install dependencies ─────────────────────────
# package.json / package-lock.json may differ between current and target.
echo ""
echo "📦 Installing dependencies..."
ssh "$SERVER" "cd $REMOTE_DIR && npm ci --production 2>&1 | tail -1"
echo "   ✅ Dependencies installed"

# ── 5. Rebuild native modules ───────────────────────
# Must be rebuilt against system Node (the version PM2 spawns under).
# Same guarded remote pattern as exact promotion.
echo ""
echo "🔧 Rebuilding native modules..."
ssh "$SERVER" "
  SYSTEM_NODE=/usr/bin/node
  if [ -x \"\$SYSTEM_NODE\" ]; then
    cd $REMOTE_DIR && PATH=/usr/bin:\$PATH /usr/bin/npm rebuild better-sqlite3 2>&1 | tail -1
    echo '   ✅ Native modules rebuilt'
  fi
"

# A manual rollback restores the archive into the legacy base. Remove the
# versioned release selector before starting so current/current.next cannot
# continue to advertise a different runtime than PM2 is serving.
ssh "$SERVER" bash -s -- "$REMOTE_DIR" <<'REMOTE_SELECT_LEGACY_RUNTIME'
set -euo pipefail
base_dir="$1"
for selector in current current.next; do
  path="$base_dir/$selector"
  if [ -e "$path" ] && [ ! -L "$path" ]; then
    echo "refusing to remove non-symlink runtime selector: $path" >&2
    exit 1
  fi
done
rm -f "$base_dir/current" "$base_dir/current.next"
[ ! -e "$base_dir/current" ] && [ ! -L "$base_dir/current" ]
[ ! -e "$base_dir/current.next" ] && [ ! -L "$base_dir/current.next" ]
REMOTE_SELECT_LEGACY_RUNTIME

# ── 6. Recreate services without resurrecting historical PM2 secrets ──
echo ""
echo "🟢 Starting services..."
ROLLBACK_RUNTIME_CONFIG="ecosystem.config.js"
if ssh "$SERVER" bash -s -- \
  "$REMOTE_DIR" \
  "$PM2" \
  "rollback-unknown" \
  "$ROLLBACK_RUNTIME_CONFIG" \
  "nexus-hub,content-engine" \
  "NODE_ENV,ENV,GIT_COMMIT" \
  < "$LOCAL_DIR/scripts/remote-start-sanitized-pm2.sh"
then
  echo "   ✅ Running with sanitized PM2 state"
else
  echo "   ❌ Sanitized PM2 bootstrap failed after restore"
  exit 1
fi

# ── 7. Bound readiness by health + identity + version ──
echo ""
echo "🏥 Verifying simultaneous loopback health, PM2 cwd, and archived version..."
set +e
READINESS_OUTPUT="$(ssh "$SERVER" bash -s -- "$REMOTE_DIR" "$PM2" "$TARGET_VERSION" <<'REMOTE_VERIFY_ROLLBACK'
set -euo pipefail
runtime="$1"
pm2_bin="$2"
expected_version="$3"
node_bin=/usr/bin/node

actual_version="$("$node_bin" -e '
  const value = require(process.argv[1]);
  process.stdout.write(typeof value.version === "string" ? value.version : "");
' "$runtime/package.json")"
[ "$actual_version" = "$expected_version" ] || {
  echo "restored package version mismatch: expected=$expected_version actual=$actual_version" >&2
  exit 1
}

for attempt in $(seq 1 15); do
  backend_ok=false
  content_ok=false
  curl --fail --silent --max-time 2 http://127.0.0.1:8200/health >/dev/null &
  backend_pid=$!
  curl --fail --silent --max-time 2 http://127.0.0.1:8100/health >/dev/null &
  content_pid=$!
  if wait "$backend_pid"; then backend_ok=true; fi
  if wait "$content_pid"; then content_ok=true; fi

  if [ "$backend_ok" = true ] && [ "$content_ok" = true ]; then
    "$pm2_bin" jlist | "$node_bin" -e '
      const fs = require("fs");
      const path = require("path");
      const rows = JSON.parse(fs.readFileSync(0, "utf8"));
      const runtime = process.argv[1];
      const expected = new Map([
        ["nexus-hub", runtime],
        ["content-engine", path.join(runtime, "content-engine")],
      ]);
      for (const [name, cwd] of expected) {
        const row = rows.find(entry => entry?.name === name);
        const actual = row?.pm2_env?.pm_cwd;
        if (row?.pm2_env?.status !== "online" || typeof actual !== "string"
            || path.resolve(actual) !== path.resolve(cwd)) {
          throw new Error(`rollback PM2 identity mismatch: ${name}`);
        }
      }
    ' "$runtime"
    "$pm2_bin" save --force >/dev/null
    echo "NEXUS_RESTORED_VERSION=$actual_version"
    echo "   ✅ Backend and Content Engine are healthy with exact legacy cwd identity"
    exit 0
  fi
  echo "   ⏳ Attempt $attempt/15: backend=$backend_ok content=$content_ok"
  if [ "$attempt" -lt 15 ]; then sleep 2; fi
done
echo "rollback readiness failed within the bounded 60-second window" >&2
exit 1
REMOTE_VERIFY_ROLLBACK
)"
READINESS_EXIT=$?
set -e
printf '%s\n' "$READINESS_OUTPUT"
RESTORED_VERSION="$(printf '%s\n' "$READINESS_OUTPUT" | sed -n 's/^NEXUS_RESTORED_VERSION=//p' | tail -1)"
ssh "$SERVER" "export PATH=\$PATH:$(dirname $PM2) && $PM2 list | grep -E 'nexus-hub|content-engine'" || true

echo ""
echo "═══════════════════════════════════════════════"
if [ "$READINESS_EXIT" -eq 0 ] && [ "$RESTORED_VERSION" = "$TARGET_VERSION" ]; then
  echo "  ✅ Rollback complete!"
  echo "  📦 Version: v${CURRENT_VERSION} → v${RESTORED_VERSION}"
  echo "  💾 Pre-restore snapshot saved by restore.sh"
else
  echo "  ⚠️  Rollback completed but health check FAILED"
  echo "  📦 Version: v${CURRENT_VERSION} → v${RESTORED_VERSION}"
  echo "  🔍 Check logs: ssh $SERVER '$PM2 logs nexus-hub --lines 50 --nostream'"
  echo "  🔙 To undo: find pre-restore-*.tar.gz in $BACKUP_DIR and run"
  echo "     ssh $SERVER 'cd $REMOTE_DIR && bash scripts/restore.sh --apply <snapshot>'"
fi
echo "═══════════════════════════════════════════════"

if [ "$READINESS_EXIT" -ne 0 ] || [ "$RESTORED_VERSION" != "$TARGET_VERSION" ]; then
  exit 1
fi
