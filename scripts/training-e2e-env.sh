#!/usr/bin/env bash
# Shared helpers for the isolated Training E2E harness.

set -euo pipefail

training_e2e_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd
}

training_e2e_git_dir() {
  local root
  root="$(training_e2e_root)"
  if [[ -n "${NEXUS_TRAINING_E2E_GIT_DIR:-}" ]]; then
    printf '%s\n' "$NEXUS_TRAINING_E2E_GIT_DIR"
    return 0
  fi
  if [[ -e "$root/.git" ]]; then
    git -C "$root" rev-parse --absolute-git-dir 2>/dev/null
    return 0
  fi
  local canonical_git_dir="/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/.git"
  if [[ -d "$canonical_git_dir" ]]; then
    printf '%s\n' "$canonical_git_dir"
    return 0
  fi
  return 1
}

training_e2e_git() {
  local git_dir
  git_dir="$(training_e2e_git_dir)"
  git --git-dir="$git_dir" --work-tree="$(training_e2e_root)" "$@"
}

training_e2e_sanitize_id() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g; s/-+/-/g'
}

training_e2e_pick_port() {
  local start="$1"
  python3 - "$start" <<'PY'
import socket
import sys

start = int(sys.argv[1])
for port in range(start, start + 500):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            continue
        print(port)
        raise SystemExit(0)
raise SystemExit(f"no free loopback port found starting at {start}")
PY
}

training_e2e_load_latest_env() {
  local root
  root="$(training_e2e_root)"
  local latest="$root/.local/training-e2e/latest.env"
  if [[ ! -f "$latest" ]]; then
    echo "ERROR: no Training E2E run metadata found at $latest" >&2
    echo "Start one first with: scripts/training-e2e-up.sh" >&2
    return 1
  fi
  # shellcheck disable=SC1090
  source "$latest"
}
