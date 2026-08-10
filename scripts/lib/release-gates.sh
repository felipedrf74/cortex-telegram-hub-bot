#!/usr/bin/env bash
# Small shared guards used by local verification and the lean release operator.

declare -a RELEASE_LOCAL_LOCK_DIRS=()

release_require_git_worktree() {
  local root="$1"
  [ "$(git -C "$root" rev-parse --is-inside-work-tree 2>/dev/null)" = true ] || {
    echo "not a usable Git worktree: $root" >&2
    return 1
  }
}

release_git_status_porcelain() {
  git -C "$1" status --porcelain --untracked-files=normal
}

release_read_deployed_identity() {
  local state_file="$1"
  node - "$state_file" <<'NODE'
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const sha = state?.backend?.runtimeSha;
const digest = state?.backend?.artifactDigest;
if (!/^[0-9a-f]{40}$/.test(sha || '')
    || !/^[0-9a-f]{64}$/.test(digest || '')) {
  process.exit(1);
}
process.stdout.write(`${sha} ${digest}\n`);
NODE
}

release_require_clean_tree() {
  local root="$1"
  local status
  status="$(release_git_status_porcelain "$root")" || return 1
  [ -z "$status" ] || {
    printf '%s\n' "$status"
    return 2
  }
}

release_reassert_exact_protected_main() {
  local root="$1"
  local expected_sha="$2"
  local checked_out_sha protected_main_sha
  [[ "$expected_sha" =~ ^[0-9a-f]{40}$ ]] || {
    echo "release target SHA is invalid at the transaction boundary" >&2
    return 64
  }
  release_require_git_worktree "$root" || return 1
  release_require_clean_tree "$root" >/dev/null || {
    echo "release transaction requires a clean exact protected-main checkout" >&2
    return 1
  }
  checked_out_sha="$(git -C "$root" rev-parse HEAD)" || return 1
  [ "$checked_out_sha" = "$expected_sha" ] || {
    echo "checked-out release target changed before transaction dispatch" >&2
    return 1
  }
  git -C "$root" fetch --quiet --no-tags origin main || return 1
  protected_main_sha="$(git -C "$root" rev-parse origin/main)" || return 1
  [ "$protected_main_sha" = "$expected_sha" ] || {
    echo "release target is no longer the exact current protected origin/main SHA" >&2
    return 1
  }
}

release_require_tracked_clean_file() {
  local root="$1"
  local relative="$2"
  git -C "$root" ls-files --error-unmatch -- "$relative" >/dev/null 2>&1 \
    && git -C "$root" diff --quiet HEAD -- "$relative"
}

release_acquire_local_lock() {
  local root="$1"
  local name="$2"
  local lock_root lock_dir owner_pid owner_host current_host
  [[ "$name" =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]] || {
    echo "invalid local lock name" >&2
    return 64
  }
  lock_root="$root/.local/release/locks"
  install -d -m 700 "$root/.local" "$root/.local/release" "$lock_root"
  lock_dir="$lock_root/$name.lock"
  current_host="$(hostname 2>/dev/null || printf unknown)"
  if [ -d "$lock_dir" ] && [ ! -L "$lock_dir" ] && [ -f "$lock_dir/owner" ]; then
    owner_pid="$(awk -F= '$1=="pid"{print $2}' "$lock_dir/owner")"
    owner_host="$(awk -F= '$1=="host"{print $2}' "$lock_dir/owner")"
    if [[ "$owner_pid" =~ ^[0-9]+$ ]] && [ "$owner_host" = "$current_host" ] \
      && ! kill -0 "$owner_pid" 2>/dev/null; then
      rm -f -- "$lock_dir/owner"
      rmdir "$lock_dir" 2>/dev/null || true
    fi
  fi
  mkdir "$lock_dir" 2>/dev/null || {
    echo "local release lock is already held: $lock_dir" >&2
    return 73
  }
  {
    printf 'pid=%s\n' "${BASHPID:-$$}"
    printf 'host=%s\n' "$current_host"
    printf 'createdAt=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$lock_dir/owner"
  chmod 600 "$lock_dir/owner"
  RELEASE_LOCAL_LOCK_DIRS+=("$lock_dir")
}

release_cleanup_all_locks() {
  local lock_dir
  if [ "${#RELEASE_LOCAL_LOCK_DIRS[@]}" -eq 0 ]; then
    return 0
  fi
  for lock_dir in "${RELEASE_LOCAL_LOCK_DIRS[@]}"; do
    rm -f -- "$lock_dir/owner"
    rmdir "$lock_dir" 2>/dev/null || true
  done
  RELEASE_LOCAL_LOCK_DIRS=()
}
