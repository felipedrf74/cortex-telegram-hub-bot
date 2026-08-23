#!/usr/bin/env bash
# One-time ownership and user-systemd preparation for the lean release path.
# This installs no daemon and does not mutate `current` or any release bytes.
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

[ "$#" -eq 0 ] || {
  echo "usage: sudo scripts/lean-release-server-install.sh" >&2
  exit 64
}
[ "$(id -u)" -eq 0 ] || {
  echo "lean release server preparation must run as root" >&2
  exit 77
}

DEPLOY_USER=dominguez
DEPLOY_GROUP="$(id -gn "$DEPLOY_USER")"
DEPLOY_HOME="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
[ "$DEPLOY_HOME" = "${NEXUS_RELEASE_DEPLOY_HOME:?NEXUS_RELEASE_DEPLOY_HOME must be set (expected home of the deploy user)}" ] || {
  echo "dominguez account home is not the governed live path" >&2
  exit 1
}

validate_and_normalize_base() {
  local base="$1"
  local current_target persistent
  [ -d "$base" ] && [ ! -L "$base" ] || {
    echo "live release base is missing or symbolic: $base" >&2
    return 1
  }
  [ -f "$base/.env" ] && [ ! -L "$base/.env" ] || {
    echo "protected release environment is missing or symbolic: $base/.env" >&2
    return 1
  }
  [ -L "$base/current" ] || {
    echo "current release selector is not a symlink: $base/current" >&2
    return 1
  }
  current_target="$(realpath -e -- "$base/current")"
  case "$current_target" in
    "$base"/releases/*) ;;
    *)
      echo "current release selector escapes the live release set: $base/current" >&2
      return 1
      ;;
  esac

  for persistent in "$base/releases" "$base/data" "$base/logs"; do
    if [ -e "$persistent" ] || [ -L "$persistent" ]; then
      [ -d "$persistent" ] && [ ! -L "$persistent" ] || {
        echo "persistent release path is unsafe: $persistent" >&2
        return 1
      }
    else
      install -d -o "$DEPLOY_USER" -g "$DEPLOY_GROUP" -m 0700 "$persistent"
    fi
  done

  # Only the base and top-level runtime directories change ownership. Their
  # modes are normalized to private; database, log, environment, and release
  # file contents remain untouched.
  chmod 0700 "$base/releases" "$base/data" "$base/logs"
  chown "$DEPLOY_USER:$DEPLOY_GROUP" \
    "$base" "$base/releases" "$base/data" "$base/logs"

  runuser -u "$DEPLOY_USER" -- test -r "$base/.env"
  runuser -u "$DEPLOY_USER" -- test -w "$base"
  runuser -u "$DEPLOY_USER" -- test -w "$base/releases"
  runuser -u "$DEPLOY_USER" -- test -w "$base/data"
  runuser -u "$DEPLOY_USER" -- test -w "$base/logs"
}

validate_and_normalize_base "$DEPLOY_HOME/telegram-hub-bot"
validate_and_normalize_base "$DEPLOY_HOME/telegram-hub-bot-staging"

install -d -o "$DEPLOY_USER" -g "$DEPLOY_GROUP" -m 0700 \
  "$DEPLOY_HOME/.local" \
  "$DEPLOY_HOME/.local/share" \
  "$DEPLOY_HOME/.local/share/nexus-release" \
  "$DEPLOY_HOME/.local/share/nexus-release/incoming" \
  "$DEPLOY_HOME/.local/state" \
  "$DEPLOY_HOME/.local/state/nexus-release"

command -v loginctl >/dev/null || {
  echo "loginctl is required to make user transactions SSH-independent" >&2
  exit 1
}
loginctl enable-linger "$DEPLOY_USER"
[ -f "/var/lib/systemd/linger/$DEPLOY_USER" ] || {
  echo "systemd user lingering was not enabled" >&2
  exit 1
}

printf '{"ok":true,"schema":"nexus.lean-release-server-install.v1","user":"%s"}\n' \
  "$DEPLOY_USER"
