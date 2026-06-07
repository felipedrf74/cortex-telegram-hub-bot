#!/usr/bin/env bash
# Shared release/deploy guard helpers. Source from bash scripts after
# LOCAL_DIR/ROOT is known; all helpers fail closed.

release_require_git_worktree() {
  local root="$1"
  local inside
  if ! inside="$(git -C "$root" rev-parse --is-inside-work-tree 2>/dev/null)"; then
    echo "❌ Git worktree probe failed for $root" >&2
    echo "   Check .git/config; core.bare must be false for release scripts." >&2
    return 1
  fi
  if [ "$inside" != "true" ]; then
    echo "❌ $root is not a usable git worktree (rev-parse returned '$inside')" >&2
    return 1
  fi
}

release_git_status_porcelain() {
  local root="$1"
  shift
  git -C "$root" status --porcelain "$@"
}

release_require_clean_tree() {
  local root="$1"
  local status
  if ! status="$(release_git_status_porcelain "$root")"; then
    echo "❌ Could not read git status for $root; refusing to continue." >&2
    return 1
  fi
  if [ -n "$status" ]; then
    printf '%s\n' "$status"
    return 2
  fi
}

release_require_tracked_clean_file() {
  local root="$1"
  local rel_path="$2"
  if ! git -C "$root" ls-files --error-unmatch -- "$rel_path" >/dev/null 2>&1; then
    echo "❌ Required release trust-anchor file is not tracked: $rel_path" >&2
    return 1
  fi
  if ! git -C "$root" diff --quiet HEAD -- "$rel_path"; then
    echo "❌ Required release trust-anchor file is modified vs HEAD: $rel_path" >&2
    return 1
  fi
}

release_lock_root() {
  local root="$1"
  printf '%s/.local/release/locks' "$root"
}

release_current_host() {
  hostname 2>/dev/null || printf unknown
}

release_lock_owner_value() {
  local owner_file="$1"
  local key="$2"
  awk -F= -v key="$key" '$1 == key { print substr($0, index($0, "=") + 1); exit }' "$owner_file" 2>/dev/null
}

release_write_local_lock_owner() {
  local lock_dir="$1"
  {
    printf 'pid=%s\n' "$$"
    printf 'user=%s\n' "${USER:-${LOGNAME:-unknown}}"
    printf 'host=%s\n' "$(release_current_host)"
    printf 'script=%s\n' "$(basename "$0")"
    printf 'createdAt=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$lock_dir/owner"
}

release_local_lock_is_stale() {
  local lock_dir="$1"
  local owner_file="$lock_dir/owner"
  local owner_pid owner_host current_host
  [ -f "$owner_file" ] || return 1
  owner_pid="$(release_lock_owner_value "$owner_file" pid)"
  owner_host="$(release_lock_owner_value "$owner_file" host)"
  current_host="$(release_current_host)"
  case "$owner_pid" in
    ''|*[!0-9]*)
      return 1
      ;;
  esac
  [ -n "$owner_host" ] || return 1
  [ "$owner_host" = "$current_host" ] || return 1
  kill -0 "$owner_pid" 2>/dev/null && return 1
  return 0
}

release_acquire_local_lock() {
  local root="$1"
  local name="$2"
  local lock_root lock_dir
  lock_root="$(release_lock_root "$root")"
  lock_dir="$lock_root/$name.lock"
  mkdir -p "$lock_root"
  if mkdir "$lock_dir" 2>/dev/null; then
    release_write_local_lock_owner "$lock_dir"
    release_register_local_lock "$lock_dir"
    return 0
  fi
  if [ -d "$lock_dir" ] && release_local_lock_is_stale "$lock_dir"; then
    local reclaim_marker
    reclaim_marker="$lock_dir/.reclaiming"
    if ! mkdir "$reclaim_marker" 2>/dev/null; then
      echo "❌ Lost race reclaiming stale local release lock: $lock_dir" >&2
      return 73
    fi
    if ! release_local_lock_is_stale "$lock_dir"; then
      rmdir "$reclaim_marker" 2>/dev/null || true
      echo "❌ Local release lock became active during reclaim: $lock_dir" >&2
      return 73
    fi
    echo "🟡 Reclaiming stale local release lock: $lock_dir" >&2
    sed 's/^/   /' "$lock_dir/owner" >&2 || true
    release_write_local_lock_owner "$lock_dir"
    rmdir "$reclaim_marker" 2>/dev/null || true
    release_register_local_lock "$lock_dir"
    return 0
  fi
  echo "❌ Local release lock already exists: $lock_dir" >&2
  if [ -f "$lock_dir/owner" ]; then
    sed 's/^/   /' "$lock_dir/owner" >&2 || true
  fi
  return 73
}

release_append_lock_entry() {
  local variable_name="$1"
  local entry="$2"
  local current
  eval "current=\"\${$variable_name:-}\""
  if [ -n "$current" ]; then
    printf -v "$variable_name" '%s\n%s' "$current" "$entry"
  else
    printf -v "$variable_name" '%s' "$entry"
  fi
}

release_register_local_lock() {
  local lock_dir="$1"
  release_append_lock_entry RELEASE_LOCAL_LOCKS "$lock_dir"
}

release_cleanup_local_locks() {
  local lock_dir
  while IFS= read -r lock_dir; do
    [ -n "$lock_dir" ] || continue
    rm -rf "$lock_dir"
  done <<< "${RELEASE_LOCAL_LOCKS:-}"
  RELEASE_LOCAL_LOCKS=""
}

release_acquire_remote_lock() {
  local server="$1"
  local remote_dir="$2"
  local name="$3"
  local token lock_dir max_age
  token="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  lock_dir="$remote_dir/.local/release/locks/$name.lock"
  max_age="${NEXUS_REMOTE_LOCK_MAX_AGE_S:-1800}"
  if ssh "$server" bash -s -- "$remote_dir" "$name" "$token" "$(basename "$0")" "$max_age" <<'REMOTE_LOCK'
set -euo pipefail

remote_dir="$1"
name="$2"
token="$3"
script_name="$4"
max_age="$5"
lock_root="$remote_dir/.local/release/locks"
lock_dir="$lock_root/$name.lock"

write_owner() {
  {
    printf 'token=%s\n' "$token"
    printf 'pid=%s\n' "$$"
    printf 'host=%s\n' "$(hostname 2>/dev/null || printf unknown)"
    printf 'user=%s\n' "${USER:-${LOGNAME:-unknown}}"
    printf 'script=%s\n' "$script_name"
    printf 'createdAt=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$lock_dir/owner"
}

owner_value() {
  local key="$1"
  awk -F= -v key="$key" '$1 == key { print substr($0, index($0, "=") + 1); exit }' "$lock_dir/owner" 2>/dev/null || true
}

mkdir -p "$lock_root"
if mkdir "$lock_dir" 2>/dev/null; then
  write_owner
  exit 0
fi

stale=0
if [ -f "$lock_dir/owner" ]; then
  created_at="$(owner_value createdAt)"
  created_epoch="$(date -u -d "$created_at" +%s 2>/dev/null || printf 0)"
  now_epoch="$(date -u +%s)"
  case "$max_age" in
    ''|*[!0-9]*) max_age=1800 ;;
  esac
  if [ "$created_epoch" -gt 0 ] && [ $((now_epoch - created_epoch)) -gt "$max_age" ]; then
    stale=1
  fi

  owner_host="$(owner_value host)"
  owner_pid="$(owner_value pid)"
  current_host="$(hostname 2>/dev/null || printf unknown)"
  case "$owner_pid" in
    ''|*[!0-9]*) ;;
    *)
      if [ "$owner_host" = "$current_host" ] && ! kill -0 "$owner_pid" 2>/dev/null; then
        stale=1
      fi
      ;;
  esac
fi

if [ "$stale" = "1" ]; then
  reclaim_marker="$lock_dir/.reclaiming"
  if ! mkdir "$reclaim_marker" 2>/dev/null; then
    echo "REMOTE_LOCK_EXISTS:$lock_dir"
    [ -f "$lock_dir/owner" ] && sed 's/^/   /' "$lock_dir/owner" || true
    exit 73
  fi
  trap 'rmdir "$reclaim_marker" 2>/dev/null || true' EXIT
  echo "🟡 Reclaiming stale remote release lock: $lock_dir" >&2
  [ -f "$lock_dir/owner" ] && sed 's/^/   /' "$lock_dir/owner" >&2 || true
  write_owner
  rmdir "$reclaim_marker" 2>/dev/null || true
  trap - EXIT
  exit 0
fi

echo "REMOTE_LOCK_EXISTS:$lock_dir"
[ -f "$lock_dir/owner" ] && sed 's/^/   /' "$lock_dir/owner" || true
exit 73
REMOTE_LOCK
  then
    :
  else
    return $?
  fi
  release_append_lock_entry RELEASE_REMOTE_LOCKS "$server|$lock_dir"
}

release_cleanup_remote_locks() {
  local entry server lock_dir
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    server="${entry%%|*}"
    lock_dir="${entry#*|}"
    [ -n "$server" ] && [ -n "$lock_dir" ] || continue
    ssh "$server" bash -s -- "$lock_dir" >/dev/null 2>&1 <<'REMOTE_CLEANUP' || true
set -euo pipefail
lock_dir="$1"
[ -n "$lock_dir" ] || exit 0
rm -rf "$lock_dir"
REMOTE_CLEANUP
  done <<< "${RELEASE_REMOTE_LOCKS:-}"
  RELEASE_REMOTE_LOCKS=""
}

release_cleanup_all_locks() {
  release_cleanup_remote_locks
  release_cleanup_local_locks
}
