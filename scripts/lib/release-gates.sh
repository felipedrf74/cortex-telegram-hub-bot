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
    echo "🟡 Removing stale local release lock: $lock_dir" >&2
    sed 's/^/   /' "$lock_dir/owner" >&2 || true
    rm -rf "$lock_dir"
    if mkdir "$lock_dir" 2>/dev/null; then
      release_write_local_lock_owner "$lock_dir"
      release_register_local_lock "$lock_dir"
      return 0
    fi
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
  local token lock_dir
  token="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  lock_dir="$remote_dir/.local/release/locks/$name.lock"
  ssh "$server" "set -e
    mkdir -p '$remote_dir/.local/release/locks'
    if mkdir '$lock_dir' 2>/dev/null; then
      {
        printf 'token=%s\n' '$token'
        printf 'user=%s\n' '${USER:-${LOGNAME:-unknown}}'
        printf 'script=%s\n' '$(basename "$0")'
        printf 'createdAt=%s\n' \"\$(date -u +%Y-%m-%dT%H:%M:%SZ)\"
      } > '$lock_dir/owner'
    else
      echo 'REMOTE_LOCK_EXISTS:$lock_dir'
      [ -f '$lock_dir/owner' ] && sed 's/^/   /' '$lock_dir/owner' || true
      exit 73
    fi"
  release_append_lock_entry RELEASE_REMOTE_LOCKS "$server|$lock_dir"
}

release_cleanup_remote_locks() {
  local entry server lock_dir
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    server="${entry%%|*}"
    lock_dir="${entry#*|}"
    [ -n "$server" ] && [ -n "$lock_dir" ] || continue
    ssh "$server" "rm -rf '$lock_dir'" >/dev/null 2>&1 || true
  done <<< "${RELEASE_REMOTE_LOCKS:-}"
  RELEASE_REMOTE_LOCKS=""
}

release_cleanup_all_locks() {
  release_cleanup_remote_locks
  release_cleanup_local_locks
}
