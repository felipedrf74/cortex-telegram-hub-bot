#!/usr/bin/env bash
# Read-only ServerDominguez capacity and network snapshot for the advisory
# SonarQube/Docker decision. Apart from its private evidence directory, this
# script never writes host configuration or restarts a service.
set -euo pipefail
umask 077

OUTPUT=""
SAMPLE_SECONDS=10
MIN_AVAILABLE_GIB=16
MIN_DISK_FREE_PERCENT=20
EXPECTED_HOST="${SONAR_EXPECTED_HOST:-serverdominguez}"
VERIFY_PM2_ONLY=false
VERIFY_RUNTIME_BOUNDARY_ONLY=false
PRINT_USERNS_MAP=false
ALLOW_DOCKER_ABSENT=false
PM2_USER=dominguez
PM2_USER_HOME=/home/dominguez
PM2_HOME=/home/dominguez/.pm2
PM2_BIN=/usr/local/bin/pm2
PM2_VERSION=6.0.14
ROOT_NODE_BIN=/usr/bin/node
PM2_CONTROL=/usr/local/sbin/nexus-release-promotion-control
PROC_ROOT=/proc
DOCKER_SOCKET=/var/run/docker.sock
DOCKER_DAEMON_CONFIG=/etc/docker/daemon.json
SUBUID_FILE=/etc/subuid
SUBGID_FILE=/etc/subgid
DOCKER_USERNS_ACCOUNT=dockremap
DPKG_QUERY_BIN=/usr/bin/dpkg-query
DOCKER_PROCESS_SCAN_LIMIT=65536
SNAP_INVENTORY_MAX_BYTES=262144
SNAP_UNIT_INVENTORY_MAX_BYTES=65536
SNAP_BIN=/usr/bin/snap
SNAP_DOCKER_CLI=/snap/bin/docker
SNAP_DOCKER_MOUNT=/snap/docker
SNAP_DOCKER_DATA=/var/snap/docker
SNAP_DOCKER_BLOB_DIR=/var/lib/snapd/snaps
SNAP_DOCKER_UNIT_DROPIN=/etc/systemd/system/snap.docker.dockerd.service.d
RUNUSER_BIN=/usr/sbin/runuser
SYSTEMCTL_BIN="$(command -v systemctl 2>/dev/null || true)"
JOURNALCTL_BIN="$(command -v journalctl 2>/dev/null || true)"
GETENT_BIN="$(command -v getent 2>/dev/null || true)"
GETFACL_BIN="$(command -v getfacl 2>/dev/null || true)"
ID_BIN="$(command -v id 2>/dev/null || true)"
HOSTNAME_BIN="$(command -v hostname 2>/dev/null || true)"
SLEEP_BIN="$(command -v sleep 2>/dev/null || true)"
REALPATH_BIN="$(command -v realpath 2>/dev/null || true)"
DOCKER_BIN="$(command -v docker 2>/dev/null || true)"
if [ "${NEXUS_RELEASE_TEST_MODE:-0}" = 1 ]; then
  PM2_BIN="${NEXUS_SONAR_PM2_BIN:-$PM2_BIN}"
  PM2_USER_HOME="${NEXUS_SONAR_PM2_USER_HOME:-$PM2_USER_HOME}"
  PM2_HOME="${NEXUS_SONAR_PM2_HOME:-$PM2_HOME}"
  ROOT_NODE_BIN="${NEXUS_SONAR_ROOT_NODE_BIN:-$ROOT_NODE_BIN}"
  PM2_CONTROL="${NEXUS_SONAR_PM2_CONTROL:-$PM2_CONTROL}"
  PROC_ROOT="${NEXUS_SONAR_PROC_ROOT:-$PROC_ROOT}"
  DOCKER_SOCKET="${NEXUS_SONAR_DOCKER_SOCKET:-$DOCKER_SOCKET}"
  DOCKER_DAEMON_CONFIG="${NEXUS_SONAR_DOCKER_DAEMON_CONFIG:-$DOCKER_DAEMON_CONFIG}"
  SUBUID_FILE="${NEXUS_SONAR_SUBUID_FILE:-$SUBUID_FILE}"
  SUBGID_FILE="${NEXUS_SONAR_SUBGID_FILE:-$SUBGID_FILE}"
  DPKG_QUERY_BIN="${NEXUS_SONAR_DPKG_QUERY_BIN:-$DPKG_QUERY_BIN}"
  SNAP_BIN="${NEXUS_SONAR_SNAP_BIN:-$SNAP_BIN}"
  SNAP_DOCKER_CLI="${NEXUS_SONAR_SNAP_DOCKER_CLI:-$SNAP_DOCKER_CLI}"
  SNAP_DOCKER_MOUNT="${NEXUS_SONAR_SNAP_DOCKER_MOUNT:-$SNAP_DOCKER_MOUNT}"
  SNAP_DOCKER_DATA="${NEXUS_SONAR_SNAP_DOCKER_DATA:-$SNAP_DOCKER_DATA}"
  SNAP_DOCKER_BLOB_DIR="${NEXUS_SONAR_SNAP_DOCKER_BLOB_DIR:-$SNAP_DOCKER_BLOB_DIR}"
  SNAP_DOCKER_UNIT_DROPIN="${NEXUS_SONAR_SNAP_DOCKER_UNIT_DROPIN:-$SNAP_DOCKER_UNIT_DROPIN}"
  RUNUSER_BIN="${NEXUS_SONAR_RUNUSER_BIN:-$RUNUSER_BIN}"
  SYSTEMCTL_BIN="${NEXUS_SONAR_SYSTEMCTL_BIN:-$SYSTEMCTL_BIN}"
  JOURNALCTL_BIN="${NEXUS_SONAR_JOURNALCTL_BIN:-$JOURNALCTL_BIN}"
  GETENT_BIN="${NEXUS_SONAR_GETENT_BIN:-$GETENT_BIN}"
  GETFACL_BIN="${NEXUS_SONAR_GETFACL_BIN:-$GETFACL_BIN}"
  ID_BIN="${NEXUS_SONAR_ID_BIN:-$ID_BIN}"
  HOSTNAME_BIN="${NEXUS_SONAR_HOSTNAME_BIN:-$HOSTNAME_BIN}"
  SLEEP_BIN="${NEXUS_SONAR_SLEEP_BIN:-$SLEEP_BIN}"
  REALPATH_BIN="${NEXUS_SONAR_REALPATH_BIN:-$REALPATH_BIN}"
  DOCKER_BIN="${NEXUS_SONAR_DOCKER_BIN:-$DOCKER_BIN}"
fi
CLOUDFLARED_UNIT=nexus-cloudflared.service
CURL_BIN="$(command -v curl 2>/dev/null || true)"
NODE_BIN="$ROOT_NODE_BIN"
HEALTH_URLS=(http://127.0.0.1:8200/health http://127.0.0.1:8201/health)

usage() {
  cat <<'EOF'
Usage: quality-sonar-preflight.sh --output <absolute-private-dir> [options]
  --sample-seconds <0-60>       Observation window for swap and PM2 stability.
  --min-available-gib <16-30>   Minimum MemAvailable; default 16 GiB.
  --min-disk-free-percent <20-90>
  --health-url <loopback-url>   Replaces default URLs on first use; repeatable.
  --verify-pm2-only             Verify the governed root PM2 closure and exit.
  --verify-runtime-boundary-only
                                Verify live capacity, PM2, host identities,
                                Docker authority, and updater absence; no files
                                are written.
  --print-userns-map            Verify the live Docker namespace/storage
                                authority and print its exact mapped IDs.
  --allow-docker-absent         Boundary-only pre-install mode. All host
                                identity/capacity checks still run.
EOF
}

custom_health=false
while [ $# -gt 0 ]; do
  case "$1" in
    --output) OUTPUT="$2"; shift 2 ;;
    --sample-seconds) SAMPLE_SECONDS="$2"; shift 2 ;;
    --min-available-gib) MIN_AVAILABLE_GIB="$2"; shift 2 ;;
    --min-disk-free-percent) MIN_DISK_FREE_PERCENT="$2"; shift 2 ;;
    --verify-pm2-only) VERIFY_PM2_ONLY=true; shift ;;
    --verify-runtime-boundary-only) VERIFY_RUNTIME_BOUNDARY_ONLY=true; shift ;;
    --print-userns-map) PRINT_USERNS_MAP=true; shift ;;
    --allow-docker-absent) ALLOW_DOCKER_ABSENT=true; shift ;;
    --health-url)
      if [ "$custom_health" = false ]; then HEALTH_URLS=(); custom_health=true; fi
      HEALTH_URLS+=("$2"); shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 64 ;;
  esac
done

[ -x "$ID_BIN" ] || { echo "id is required" >&2; exit 1; }
[ "$("$ID_BIN" -u)" -eq 0 ] || { echo "Preflight requires root so host evidence is complete" >&2; exit 1; }
selected_modes=0
[ "$VERIFY_PM2_ONLY" = false ] || selected_modes=$((selected_modes + 1))
[ "$VERIFY_RUNTIME_BOUNDARY_ONLY" = false ] || selected_modes=$((selected_modes + 1))
[ "$PRINT_USERNS_MAP" = false ] || selected_modes=$((selected_modes + 1))
[ "$selected_modes" -le 1 ] \
  || { echo "Select only one preflight verification mode" >&2; exit 64; }
if [ "$selected_modes" -eq 0 ]; then
  [[ "$OUTPUT" == /* ]] && [ "$OUTPUT" != / ] || { echo "--output must be a safe absolute directory" >&2; exit 64; }
  [ ! -e "$OUTPUT" ] || { echo "Preflight output already exists: $OUTPUT" >&2; exit 1; }
elif [ -n "$OUTPUT" ]; then
  echo "Verification-only modes do not accept an evidence output directory" >&2
  exit 64
fi
[ "$ALLOW_DOCKER_ABSENT" = false ] || [ "$VERIFY_RUNTIME_BOUNDARY_ONLY" = true ] \
  || { echo "--allow-docker-absent requires --verify-runtime-boundary-only" >&2; exit 64; }
[[ "$SAMPLE_SECONDS" =~ ^[0-9]+$ ]] && [ "$SAMPLE_SECONDS" -le 60 ] || { echo "Invalid sample interval" >&2; exit 64; }
[[ "$MIN_AVAILABLE_GIB" =~ ^[0-9]+$ ]] && [ "$MIN_AVAILABLE_GIB" -ge 16 ] && [ "$MIN_AVAILABLE_GIB" -le 30 ] || { echo "Invalid memory floor" >&2; exit 64; }
[[ "$MIN_DISK_FREE_PERCENT" =~ ^[0-9]+$ ]] && [ "$MIN_DISK_FREE_PERCENT" -ge 20 ] && [ "$MIN_DISK_FREE_PERCENT" -le 90 ] || { echo "Invalid disk floor" >&2; exit 64; }

verify_root_pm2_identity() {
  local identity
  [ -f "$PM2_CONTROL" ] && [ ! -L "$PM2_CONTROL" ] \
    && [ "$(stat -c '%U:%G:%a:%h' -- "$PM2_CONTROL")" = root:root:755:1 ] || {
    echo "Root PM2 authority control is unsafe" >&2
    return 1
  }
  [ -f "$ROOT_NODE_BIN" ] && [ ! -L "$ROOT_NODE_BIN" ] \
    && [ "$(stat -c '%U:%G:%a:%h' -- "$ROOT_NODE_BIN")" = root:root:755:1 ] || {
    echo "Root PM2 Node identity is unsafe" >&2
    return 1
  }
  [ "$("$ROOT_NODE_BIN" --version)" = v22.23.1 ] || {
    echo "Root PM2 Node version is outside the v3 trust contract" >&2
    return 1
  }
  identity="$("$PM2_CONTROL" assert-root-pm2-ready)" || {
    echo "Governed root PM2 authority rejected the installed closure" >&2
    return 1
  }
  "$ROOT_NODE_BIN" - "$identity" "$PM2_VERSION" "$PM2_BIN" "$ROOT_NODE_BIN" <<'NODE'
const [raw, expectedVersion, launcher, nodePath] = process.argv.slice(2);
const value = JSON.parse(raw);
if (value.ok !== true || value.schema !== 'nexus.pm2-root-install.v1'
    || value.version !== expectedVersion || value.launcher !== launcher
    || value.entrypoint !== `/opt/nexus-release/pm2/${expectedVersion}/node_modules/pm2/bin/pm2`
    || !/^[a-f0-9]{64}$/u.test(value.closureDigest || '')
    || !/^[a-f0-9]{64}$/u.test(value.payloadDigest || '')
    || !/^[a-f0-9]{64}$/u.test(value.packageLockSha256 || '')
    || !/^[a-f0-9]{64}$/u.test(value.launcherSha256 || '')
    || value.node?.path !== nodePath || value.node?.version !== 'v22.23.1'
    || !/^[a-f0-9]{64}$/u.test(value.node?.sha256 || '')) process.exit(1);
process.stdout.write(`root_pm2_identity_ok version=${value.version}\n`);
NODE
}

verify_pm2_runtime_inputs() {
  "$ID_BIN" "$PM2_USER" >/dev/null 2>&1 || {
    echo "PM2 service user is unavailable" >&2
    return 1
  }
  [[ "$PM2_BIN" == /* ]] && [ -x "$PM2_BIN" ] || {
    echo "PM2 binary is unavailable" >&2
    return 1
  }
  [[ "$PM2_USER_HOME" == /* && "$PM2_HOME" == "$PM2_USER_HOME"/* ]] \
    && [ -d "$PM2_USER_HOME" ] && [ ! -L "$PM2_USER_HOME" ] \
    && [ -d "$PM2_HOME" ] && [ ! -L "$PM2_HOME" ] \
    && [ "$(stat -c '%U' -- "$PM2_USER_HOME")" = "$PM2_USER" ] \
    && [ "$(stat -c '%U:%a' -- "$PM2_HOME")" = "$PM2_USER:700" ] || {
    echo "PM2 service-user home is unsafe" >&2
    return 1
  }
  [ -x "$RUNUSER_BIN" ] || {
    echo "runuser is unavailable" >&2
    return 1
  }
}

verify_expected_host() {
  local observed_host
  [ -x "$HOSTNAME_BIN" ] || {
    echo "hostname is unavailable" >&2
    return 1
  }
  observed_host="$("$HOSTNAME_BIN" -s 2>/dev/null | tr '[:upper:]' '[:lower:]')"
  [ "$observed_host" = "$EXPECTED_HOST" ] || {
    echo "Preflight must run on $EXPECTED_HOST (observed $observed_host)" >&2
    return 1
  }
}

getent_exact() {
  local database="$1" key="$2" value line_count
  value="$("$GETENT_BIN" "$database" "$key" 2>/dev/null)" || return $?
  line_count="$(printf '%s\n' "$value" | awk 'NF { count += 1 } END { print count + 0 }')"
  [ "$line_count" -eq 1 ] || return 1
  printf '%s' "$value"
}

getent_absent() {
  local database="$1" key="$2" value rc
  if value="$(getent_exact "$database" "$key")"; then
    echo "Host $database identity $key collides with a mapped container identity" >&2
    return 1
  else
    rc=$?
  fi
  [ "$rc" -eq 2 ] || {
    echo "Unable to prove host $database identity $key is absent" >&2
    return 1
  }
}

verify_protected_identities() {
  local docker_group="" docker_gid="" account passwd_row passwd_uid passwd_gid
  local observed_uid observed_gid observed_groups group_id
  [ -x "$GETENT_BIN" ] || {
    echo "getent is required for protected identity verification" >&2
    return 1
  }

  if docker_group="$(getent_exact group docker)"; then
    IFS=: read -r group_name _ docker_gid group_members extra <<<"$docker_group"
    [ -z "${extra:-}" ] && [ "$group_name" = docker ] \
      && [[ "$docker_gid" =~ ^[0-9]+$ ]] || {
      echo "Docker group identity is malformed" >&2
      return 1
    }
  else
    case "$?" in
      2) docker_gid="" ;;
      *) echo "Unable to resolve the Docker group identity" >&2; return 1 ;;
    esac
  fi

  for account in dominguez nexus-release; do
    passwd_row="$(getent_exact passwd "$account")" || {
      echo "Protected host account is unavailable or ambiguous: $account" >&2
      return 1
    }
    IFS=: read -r passwd_name _ passwd_uid passwd_gid _ _ _ extra <<<"$passwd_row"
    [ -z "${extra:-}" ] && [ "$passwd_name" = "$account" ] \
      && [[ "$passwd_uid" =~ ^[0-9]+$ ]] \
      && [[ "$passwd_gid" =~ ^[0-9]+$ ]] || {
      echo "Protected host account is malformed: $account" >&2
      return 1
    }
    observed_uid="$("$ID_BIN" -u "$account")" \
      && observed_gid="$("$ID_BIN" -g "$account")" \
      && observed_groups="$("$ID_BIN" -G "$account")" || {
      echo "Unable to resolve protected account groups: $account" >&2
      return 1
    }
    [ "$observed_uid" = "$passwd_uid" ] && [ "$observed_gid" = "$passwd_gid" ] \
      && [[ "$observed_groups" =~ ^[0-9]+([[:space:]][0-9]+)*$ ]] || {
      echo "Protected account identity disagrees with NSS: $account" >&2
      return 1
    }
    for group_id in $observed_groups; do
      if [ -n "$docker_gid" ] && [ "$group_id" = "$docker_gid" ]; then
        echo "Protected account $account has Docker-group authority" >&2
        return 1
      fi
    done
  done
}

validate_root_configuration_file() {
  local path="$1" label="$2" identity mode
  [ -f "$path" ] && [ ! -L "$path" ] || {
    echo "$label is missing, not regular, or a symlink" >&2
    return 1
  }
  identity="$(stat -c '%u:%g' -- "$path")" || {
    echo "Unable to inspect $label ownership" >&2
    return 1
  }
  mode="$(stat -c '%a' -- "$path")" || {
    echo "Unable to inspect $label mode" >&2
    return 1
  }
  [ "$identity" = 0:0 ] && [[ "$mode" =~ ^[0-7]{3,4}$ ]] \
    && [ $((8#$mode & 022)) -eq 0 ] || {
    echo "$label must be root-owned and not group/world writable" >&2
    return 1
  }
}

docker_cli() {
  env \
    -u DOCKER_CONTEXT \
    -u DOCKER_TLS \
    -u DOCKER_TLS_VERIFY \
    -u DOCKER_CERT_PATH \
    DOCKER_HOST="unix://$DOCKER_SOCKET" \
    "$DOCKER_BIN" "$@"
}

DOCKER_USERNS_JSON=null
DOCKER_AUTHORITY=""

verify_snap_docker_not_installed() {
  local evidence_path snap_inventory snap_inventory_status
  local unit_inventory unit_inventory_mode
  local snap_blob
  local -a snap_blobs=()

  for evidence_path in \
    "$SNAP_DOCKER_CLI" \
    "$SNAP_DOCKER_MOUNT" \
    "$SNAP_DOCKER_DATA" \
    "$SNAP_DOCKER_UNIT_DROPIN"; do
    [ ! -e "$evidence_path" ] && [ ! -L "$evidence_path" ] || {
      echo "Docker Snap installation evidence already exists: $evidence_path" >&2
      return 1
    }
  done

  if [ -e "$SNAP_DOCKER_BLOB_DIR" ] || [ -L "$SNAP_DOCKER_BLOB_DIR" ]; then
    [ -d "$SNAP_DOCKER_BLOB_DIR" ] \
      && [ ! -L "$SNAP_DOCKER_BLOB_DIR" ] \
      && [ -r "$SNAP_DOCKER_BLOB_DIR" ] \
      && [ -x "$SNAP_DOCKER_BLOB_DIR" ] || {
      echo "Unable to inspect the Docker Snap package-blob directory" >&2
      return 1
    }
    shopt -s nullglob
    snap_blobs=("$SNAP_DOCKER_BLOB_DIR"/docker_*.snap)
    shopt -u nullglob
    if [ "${#snap_blobs[@]}" -ne 0 ]; then
      snap_blob="${snap_blobs[0]}"
      echo "Docker Snap package blob already exists: $snap_blob" >&2
      return 1
    fi
  fi

  if [ -e "$SNAP_BIN" ] || [ -L "$SNAP_BIN" ]; then
    [ -f "$SNAP_BIN" ] && [ ! -L "$SNAP_BIN" ] && [ -x "$SNAP_BIN" ] || {
      echo "Snap inventory command is present but unsafe" >&2
      return 1
    }
    if ! snap_inventory="$(LC_ALL=C "$SNAP_BIN" list --all 2>&1)"; then
      echo "Unable to prove Docker Snap package absence" >&2
      return 1
    fi
    if "$NODE_BIN" - "$snap_inventory" "$SNAP_INVENTORY_MAX_BYTES" <<'NODE'
const [raw, maxBytesRaw] = process.argv.slice(2);
const maxBytes = Number(maxBytesRaw);
if (!Number.isSafeInteger(maxBytes)
    || Buffer.byteLength(raw, 'utf8') > maxBytes) process.exit(1);
const trimmed = raw.trim();
if (/^No snaps are installed yet\.(?:\s+Try .*)?$/u.test(trimmed)) {
  process.exit(0);
}
const lines = trimmed.split(/\r?\n/u);
if (lines.length < 1 || lines.length > 4097
    || lines[0].trim().split(/\s+/u)[0] !== 'Name') process.exit(1);
for (const line of lines.slice(1)) {
  const fields = line.trim().split(/\s+/u);
  if (fields.length < 2 || !/^[a-z0-9][a-z0-9_-]*$/u.test(fields[0])) {
    process.exit(1);
  }
  if (/^docker(?:_[a-z0-9-]+)?$/u.test(fields[0])) process.exit(10);
}
NODE
    then
      :
    else
      snap_inventory_status=$?
      if [ "$snap_inventory_status" -eq 10 ]; then
        echo "Docker Snap package record already exists" >&2
      else
        echo "Unable to validate the bounded Snap package inventory" >&2
      fi
      return 1
    fi
  fi

  for unit_inventory_mode in list-unit-files list-units; do
    if [ "$unit_inventory_mode" = list-unit-files ]; then
      unit_inventory="$(
        "$SYSTEMCTL_BIN" list-unit-files 'snap.docker.*' \
          --no-legend --no-pager
      )" || {
        echo "Unable to inspect Docker Snap installed units" >&2
        return 1
      }
    else
      unit_inventory="$(
        "$SYSTEMCTL_BIN" list-units --all 'snap.docker.*' \
          --no-legend --no-pager
      )" || {
        echo "Unable to inspect Docker Snap loaded units" >&2
        return 1
      }
    fi
    [ "${#unit_inventory}" -le "$SNAP_UNIT_INVENTORY_MAX_BYTES" ] || {
      echo "Docker Snap systemd inventory exceeded its bounded limit" >&2
      return 1
    }
    [ -z "$(printf '%s' "$unit_inventory" | tr -d '[:space:]')" ] || {
      echo "Docker Snap systemd unit already exists" >&2
      return 1
    }
  done
}

verify_docker_not_installed() {
  local package package_status package_rc unit unit_state load_state
  local unit_file_state key value remainder proc_dir process_name
  local scanned_processes=0 load_state_seen unit_file_state_seen
  local -a docker_packages=(
    docker-ce
    docker-ce-cli
    docker-ce-rootless-extras
    docker-buildx-plugin
    docker-compose-plugin
    docker.io
    docker-compose
    docker-compose-v2
    moby-engine
    moby-cli
    containerd
    containerd.io
  )

  [ ! -x "$DOCKER_BIN" ] || {
    echo "Docker CLI is already installed" >&2
    return 1
  }
  [ ! -e "$DOCKER_SOCKET" ] && [ ! -L "$DOCKER_SOCKET" ] || {
    echo "Docker socket path already exists" >&2
    return 1
  }
  [ ! -e "$DOCKER_DAEMON_CONFIG" ] \
    && [ ! -L "$DOCKER_DAEMON_CONFIG" ] || {
    echo "Docker daemon configuration already exists" >&2
    return 1
  }

  [ -x "$DPKG_QUERY_BIN" ] || {
    echo "dpkg-query is required to prove Docker package absence" >&2
    return 1
  }
  for package in "${docker_packages[@]}"; do
    if package_status="$(
      LC_ALL=C "$DPKG_QUERY_BIN" -W -f='${db:Status-Abbrev}' \
        "$package" 2>/dev/null
    )"; then
      echo "Docker/containerd package record already exists: $package ($package_status)" >&2
      return 1
    else
      package_rc=$?
    fi
    [ "$package_rc" -eq 1 ] || {
      echo "Unable to prove Docker package absence: $package" >&2
      return 1
    }
  done

  [ -x "$SYSTEMCTL_BIN" ] || {
    echo "systemctl is required to prove Docker unit absence" >&2
    return 1
  }
  verify_snap_docker_not_installed || return 1
  for unit in \
    docker.service docker.socket containerd.service \
    snap.docker.dockerd.service; do
    unit_state="$(
      "$SYSTEMCTL_BIN" show "$unit" \
        -p LoadState -p UnitFileState --no-pager
    )" || {
      echo "Unable to inspect container-runtime unit state: $unit" >&2
      return 1
    }
    load_state=""
    unit_file_state=""
    load_state_seen=false
    unit_file_state_seen=false
    while IFS== read -r key value remainder; do
      [ -z "${remainder:-}" ] || {
        echo "Container-runtime unit state is malformed: $unit" >&2
        return 1
      }
      case "$key" in
        LoadState)
          [ "$load_state_seen" = false ] || {
            echo "Container-runtime unit state repeats LoadState: $unit" >&2
            return 1
          }
          load_state="$value"
          load_state_seen=true
          ;;
        UnitFileState)
          [ "$unit_file_state_seen" = false ] || {
            echo "Container-runtime unit state repeats UnitFileState: $unit" >&2
            return 1
          }
          unit_file_state="$value"
          unit_file_state_seen=true
          ;;
        *)
          echo "Container-runtime unit state has an unknown field: $unit" >&2
          return 1
          ;;
      esac
    done <<<"$unit_state"
    [ "$load_state_seen" = true ] \
      && [ "$unit_file_state_seen" = true ] \
      && [ "$load_state" = not-found ] \
      && [ -z "$unit_file_state" ] || {
      echo "Container-runtime systemd unit already exists: $unit" >&2
      return 1
    }
  done

  for proc_dir in "$PROC_ROOT"/[0-9]*; do
    [ -d "$proc_dir" ] || continue
    scanned_processes=$((scanned_processes + 1))
    [ "$scanned_processes" -le "$DOCKER_PROCESS_SCAN_LIMIT" ] || {
      echo "Container-runtime process scan exceeded its bounded limit" >&2
      return 1
    }
    if ! process_name="$(tr -d '\r\n' <"$proc_dir/comm" 2>/dev/null)"; then
      [ ! -e "$proc_dir" ] || {
        echo "Unable to inspect a live process during Docker absence proof" >&2
        return 1
      }
      continue
    fi
    case "$process_name" in
      dockerd|containerd)
        echo "Container-runtime process is already active: $process_name" >&2
        return 1
        ;;
    esac
  done
}

resolve_docker_userns_mapping() {
  local mapping docker_info docker_root namespaced_root root_identity root_mode
  local account_passwd account_group account_uid account_gid account_groups
  local subuid_base subgid_base postgres_uid postgres_gid sonar_uid sonar_gid
  local protected protected_uid protected_groups protected_group

  validate_root_configuration_file \
    "$DOCKER_DAEMON_CONFIG" "Docker daemon configuration" || return 1
  validate_root_configuration_file "$SUBUID_FILE" "subordinate UID map" \
    || return 1
  validate_root_configuration_file "$SUBGID_FILE" "subordinate GID map" \
    || return 1

  mapping="$("$NODE_BIN" - \
    "$DOCKER_DAEMON_CONFIG" "$SUBUID_FILE" "$SUBGID_FILE" \
    "$DOCKER_USERNS_ACCOUNT" <<'NODE'
const fs = require('fs');
const path = require('path');
const [daemonPath, subuidPath, subgidPath, account] = process.argv.slice(2);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

let daemon;
try {
  daemon = JSON.parse(fs.readFileSync(daemonPath, 'utf8'));
} catch {
  fail('Docker daemon configuration is not valid JSON');
}
if (!daemon || typeof daemon !== 'object' || Array.isArray(daemon)
    || daemon['userns-remap'] !== 'default'
    || !daemon.features || typeof daemon.features !== 'object'
    || Array.isArray(daemon.features)
    || daemon.features['containerd-snapshotter'] !== false) {
  fail('Docker must use default userns-remap with the incompatible containerd image store disabled');
}
if (Object.hasOwn(daemon, 'hosts')) {
  fail('Docker daemon configuration must not declare alternate listeners');
}

function parseSubordinateFile(filePath, label) {
  let rows;
  try {
    rows = fs.readFileSync(filePath, 'utf8').split(/\r?\n/u);
  } catch {
    fail(`${label} is unreadable`);
  }
  const ranges = [];
  for (const raw of rows) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const fields = line.split(':');
    if (fields.length !== 3
        || !/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(fields[0])
        || !/^[0-9]+$/u.test(fields[1])
        || !/^[0-9]+$/u.test(fields[2])) {
      fail(`${label} contains a malformed range`);
    }
    const start = Number(fields[1]);
    const count = Number(fields[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count)
        || start < 100000 || count <= 0
        || start + count - 1 > 2_147_483_647) {
      fail(`${label} contains an unsafe range`);
    }
    ranges.push({ name: fields[0], start, count, end: start + count - 1 });
  }
  const selected = ranges.filter((row) => row.name === account);
  if (selected.length !== 1 || selected[0].count !== 65536) {
    fail(`${label} must contain exactly one 65536-ID ${account} range`);
  }
  const ordered = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].start <= ordered[index - 1].end) {
      fail(`${label} contains overlapping subordinate ranges`);
    }
  }
  return selected[0].start;
}

const subuidBase = parseSubordinateFile(subuidPath, 'subordinate UID map');
const subgidBase = parseSubordinateFile(subgidPath, 'subordinate GID map');
process.stdout.write([
  subuidBase,
  subgidBase,
  subuidBase + 999,
  subgidBase + 999,
  subuidBase + 1000,
  subgidBase + 1000,
].join('\t'));
NODE
  )" || return 1
  IFS=$'\t' read -r \
    subuid_base subgid_base postgres_uid postgres_gid sonar_uid sonar_gid \
    <<<"$mapping"
  for value in \
    "$subuid_base" "$subgid_base" "$postgres_uid" "$postgres_gid" \
    "$sonar_uid" "$sonar_gid"; do
    [[ "$value" =~ ^[0-9]+$ ]] || {
      echo "Docker subordinate mapping output is malformed" >&2
      return 1
    }
  done

  account_passwd="$(getent_exact passwd "$DOCKER_USERNS_ACCOUNT")" || {
    echo "Docker user-namespace account is unavailable or ambiguous" >&2
    return 1
  }
  account_group="$(getent_exact group "$DOCKER_USERNS_ACCOUNT")" || {
    echo "Docker user-namespace group is unavailable or ambiguous" >&2
    return 1
  }
  IFS=: read -r account_name _ account_uid account_gid _ _ _ extra \
    <<<"$account_passwd"
  [ -z "${extra:-}" ] && [ "$account_name" = "$DOCKER_USERNS_ACCOUNT" ] \
    && [[ "$account_uid" =~ ^[0-9]+$ ]] \
    && [[ "$account_gid" =~ ^[0-9]+$ ]] || {
    echo "Docker user-namespace account identity is malformed" >&2
    return 1
  }
  IFS=: read -r group_name _ group_gid group_members extra <<<"$account_group"
  [ -z "${extra:-}" ] && [ "$group_name" = "$DOCKER_USERNS_ACCOUNT" ] \
    && [[ "$group_gid" =~ ^[0-9]+$ ]] \
    && [ "$group_gid" = "$account_gid" ] || {
    echo "Docker user-namespace group identity is malformed" >&2
    return 1
  }
  account_groups="$("$ID_BIN" -G "$DOCKER_USERNS_ACCOUNT")" || {
    echo "Unable to resolve Docker user-namespace account groups" >&2
    return 1
  }
  [ "$account_groups" = "$account_gid" ] || {
    echo "Docker user-namespace account has unexpected supplementary groups" >&2
    return 1
  }
  [ "$account_uid" -lt "$subuid_base" ] && [ "$account_gid" -lt "$subgid_base" ] \
    || {
      echo "Docker user-namespace account overlaps its subordinate range" >&2
      return 1
    }

  for protected in dominguez nexus-release; do
    protected_uid="$("$ID_BIN" -u "$protected")" \
      && protected_groups="$("$ID_BIN" -G "$protected")" || {
      echo "Unable to recheck protected identity against Docker subordinate ranges" >&2
      return 1
    }
    if [ "$protected_uid" -ge "$subuid_base" ] \
        && [ "$protected_uid" -lt $((subuid_base + 65536)) ]; then
      echo "Protected account $protected overlaps the Docker subordinate UID range" >&2
      return 1
    fi
    for protected_group in $protected_groups; do
      if [ "$protected_group" -ge "$subgid_base" ] \
          && [ "$protected_group" -lt $((subgid_base + 65536)) ]; then
        echo "Protected account $protected overlaps the Docker subordinate GID range" >&2
        return 1
      fi
    done
  done

  getent_absent passwd "$postgres_uid" || return 1
  getent_absent passwd "$sonar_uid" || return 1
  getent_absent group "$postgres_gid" || return 1
  getent_absent group "$sonar_gid" || return 1

  docker_info="$(docker_cli info --format '{{json .}}')" || {
    echo "Unable to read Docker daemon user-namespace state" >&2
    return 1
  }
  docker_root="$("$NODE_BIN" - "$docker_info" <<'NODE'
const path = require('path');
const value = JSON.parse(process.argv[2]);
const security = Array.isArray(value.SecurityOptions) ? value.SecurityOptions : [];
const driver = Array.isArray(value.DriverStatus) ? value.DriverStatus.flat(Infinity) : [];
if (!security.some((item) => item === 'name=userns' || item === 'userns')) {
  throw new Error('Docker daemon is not actively using userns-remap');
}
if (driver.some((item) => String(item).includes('io.containerd.snapshotter.v1'))) {
  throw new Error('Docker containerd image store is incompatible with userns-remap');
}
if (typeof value.DockerRootDir !== 'string'
    || !value.DockerRootDir.startsWith('/')
    || path.normalize(value.DockerRootDir) !== value.DockerRootDir
    || value.DockerRootDir === '/') {
  throw new Error('Docker root directory is unsafe');
}
process.stdout.write(value.DockerRootDir);
NODE
  )" || return 1
  [ -x "$REALPATH_BIN" ] && [ -d "$docker_root" ] && [ ! -L "$docker_root" ] \
    && [ "$("$REALPATH_BIN" -e -- "$docker_root")" = "$docker_root" ] || {
    echo "Docker root directory is missing, noncanonical, or a symlink" >&2
    return 1
  }
  namespaced_root="$docker_root/$subuid_base.$subgid_base"
  [ -d "$namespaced_root" ] && [ ! -L "$namespaced_root" ] \
    && [ "$("$REALPATH_BIN" -e -- "$namespaced_root")" = "$namespaced_root" ] || {
    echo "Docker user-namespace storage root is missing or unsafe" >&2
    return 1
  }
  root_identity="$(stat -c '%u:%g' -- "$namespaced_root")" || return 1
  root_mode="$(stat -c '%a' -- "$namespaced_root")" || return 1
  [ "$root_identity" = "$subuid_base:$subgid_base" ] \
    && [[ "$root_mode" =~ ^[0-7]{3,4}$ ]] \
    && [ $((8#$root_mode & 077)) -eq 0 ] || {
    echo "Docker user-namespace storage root has unsafe ownership or mode" >&2
    return 1
  }

  DOCKER_USERNS_JSON="$("$NODE_BIN" - \
    "$subuid_base" "$subgid_base" "$postgres_uid" "$postgres_gid" \
    "$sonar_uid" "$sonar_gid" "$docker_root" "$namespaced_root" <<'NODE'
const [
  subuidBase,
  subgidBase,
  postgresUid,
  postgresGid,
  sonarUid,
  sonarGid,
  dockerRootDir,
  namespacedRoot,
] = process.argv.slice(2);
const numeric = (value) => Number(value);
process.stdout.write(JSON.stringify({
  schema: 'nexus.docker-userns-map.v1',
  status: 'passed',
  daemonSetting: 'default',
  account: 'dockremap',
  rangeSize: 65536,
  subuidBase: numeric(subuidBase),
  subgidBase: numeric(subgidBase),
  postgres: {
    containerUid: 999,
    containerGid: 999,
    hostUid: numeric(postgresUid),
    hostGid: numeric(postgresGid),
  },
  sonarqube: {
    containerUid: 1000,
    containerGid: 1000,
    hostUid: numeric(sonarUid),
    hostGid: numeric(sonarGid),
  },
  dockerRootDir,
  namespacedRoot,
}));
NODE
  )" || return 1
}

verify_docker_socket_authority() {
  local allow_absent="$1" docker_group docker_gid socket_identity acl
  local socket_type_verified=false
  DOCKER_AUTHORITY=""
  DOCKER_USERNS_JSON=null
  if [ ! -x "$DOCKER_BIN" ]; then
    [ "$allow_absent" = true ] || {
      echo "Docker Engine is required for the live runtime boundary" >&2
      return 1
    }
    verify_docker_not_installed || return 1
    DOCKER_AUTHORITY=not_installed
    return 0
  fi
  docker_cli version >/dev/null 2>&1 || {
    echo "Docker client/server authority is unavailable" >&2
    return 1
  }
  docker_group="$(getent_exact group docker)" || {
    echo "Docker group identity is unavailable or ambiguous" >&2
    return 1
  }
  IFS=: read -r group_name _ docker_gid _ extra <<<"$docker_group"
  [ -z "${extra:-}" ] && [ "$group_name" = docker ] \
    && [[ "$docker_gid" =~ ^[0-9]+$ ]] || {
    echo "Docker group identity is malformed" >&2
    return 1
  }
  socket_type_verified=false
  if [ -S "$DOCKER_SOCKET" ] && [ ! -L "$DOCKER_SOCKET" ]; then
    socket_type_verified=true
  elif [ "${NEXUS_RELEASE_TEST_MODE:-0}" = 1 ] \
      && [ "${NEXUS_SONAR_TEST_SOCKET_TYPE_VERIFIED:-0}" = 1 ] \
      && [ -e "$DOCKER_SOCKET" ] && [ ! -L "$DOCKER_SOCKET" ]; then
    socket_type_verified=true
  fi
  [ "$socket_type_verified" = true ] || {
    echo "Docker socket is missing, not a socket, or a symlink" >&2
    return 1
  }
  socket_identity="$(stat -c '%u:%g:%a' -- "$DOCKER_SOCKET")" || {
    echo "Unable to inspect Docker socket ownership" >&2
    return 1
  }
  [ "$socket_identity" = "0:$docker_gid:660" ] || {
    echo "Docker socket must be root:docker mode 0660" >&2
    return 1
  }
  [ -x "$GETFACL_BIN" ] || {
    echo "getfacl is required to prove Docker socket ACL isolation" >&2
    return 1
  }
  acl="$("$GETFACL_BIN" -cp -- "$DOCKER_SOCKET" 2>/dev/null)" || {
    echo "Unable to inspect Docker socket ACLs" >&2
    return 1
  }
  printf '%s\n' "$acl" | awk '
    /^$/ { next }
    $0 == "user::rw-" { user += 1; next }
    $0 == "group::rw-" { group += 1; next }
    $0 == "other::---" { other += 1; next }
    { exit 1 }
    END {
      if (user != 1 || group != 1 || other != 1) exit 1
    }
  ' || {
    echo "Docker socket has a named, masked, or nonstandard ACL" >&2
    return 1
  }
  resolve_docker_userns_mapping || return 1
  DOCKER_AUTHORITY=root_socket_userns_remap
}

is_known_automatic_updater() {
  local value
  value="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  case "/$value/" in
    *watchtower*|*containrrr/watchtower*|*ouroboros*|*pyouroboros*|\
    *crazymax/diun*|*/diun:*|*/diun/*|*dockupdater*|\
    *whats-up-docker*|*/wud:*|*/wud/*|*docker-auto-update*|\
    *docker-compose-update*)
      return 0
      ;;
  esac
  return 1
}

verify_no_automatic_updaters() {
  local inventory name image extra unit_inventory unit state remainder unit_type
  if [ -x "$DOCKER_BIN" ]; then
    inventory="$(docker_cli ps -a --format '{{.Names}}\t{{.Image}}')" || {
      echo "Unable to enumerate Docker containers for automatic updaters" >&2
      return 1
    }
    while IFS=$'\t' read -r name image extra; do
      [ -z "$name$image$extra" ] && continue
      [ -n "$name" ] && [ -n "$image" ] && [ -z "$extra" ] || {
        echo "Docker container inventory is malformed" >&2
        return 1
      }
      if is_known_automatic_updater "$name $image"; then
        echo "Known automatic Docker updater container is installed: $name" >&2
        return 1
      fi
    done <<<"$inventory"
  fi

  [ -x "$SYSTEMCTL_BIN" ] || {
    echo "systemctl is required to prove automatic updater absence" >&2
    return 1
  }
  for unit_type in service timer; do
    unit_inventory="$("$SYSTEMCTL_BIN" list-unit-files \
      --type="$unit_type" --no-legend --no-pager)" || {
      echo "Unable to enumerate systemd $unit_type unit files" >&2
      return 1
    }
    while read -r unit state remainder; do
      [ -z "$unit$state$remainder" ] && continue
      [ -n "$unit" ] && [ -n "$state" ] || {
        echo "systemd $unit_type inventory is malformed" >&2
        return 1
      }
      if is_known_automatic_updater "$unit"; then
        echo "Known automatic Docker updater unit is installed: $unit" >&2
        return 1
      fi
    done <<<"$unit_inventory"

    unit_inventory="$("$SYSTEMCTL_BIN" list-units --all \
      --type="$unit_type" --no-legend --no-pager)" || {
      echo "Unable to enumerate loaded systemd $unit_type units" >&2
      return 1
    }
    while read -r unit remainder; do
      [ -z "$unit$remainder" ] && continue
      if is_known_automatic_updater "$unit"; then
        echo "Known automatic Docker updater unit is loaded: $unit" >&2
        return 1
      fi
    done <<<"$unit_inventory"
  done
}

verify_runtime_authority() {
  local allow_docker_absent="$1"
  verify_expected_host || return 1
  verify_protected_identities || return 1
  verify_docker_socket_authority "$allow_docker_absent" || return 1
  verify_no_automatic_updaters || return 1
  printf '{"schema":"nexus.sonarqube-runtime-authority.v1","status":"passed","host":"serverdominguez","protectedAccounts":["dominguez","nexus-release"],"containerUserIds":[999,1000],"dockerAuthority":"%s","dockerUserns":%s,"automaticUpdaterCount":0}\n' \
    "$DOCKER_AUTHORITY" "$DOCKER_USERNS_JSON"
}

pm2_snapshot() {
  "$RUNUSER_BIN" -u "$PM2_USER" -- \
    /usr/bin/env -i \
      HOME="$PM2_USER_HOME" \
      USER="$PM2_USER" \
      LOGNAME="$PM2_USER" \
      PATH=/usr/local/bin:/usr/bin:/bin \
      PM2_HOME="$PM2_HOME" \
      "$PM2_BIN" jlist | "$NODE_BIN" -e '
    let raw="";
    process.stdin.on("data", d => raw += d).on("end", () => {
      const expected = ["nexus-hub", "content-engine", "nexus-hub-staging", "content-engine-staging"];
      const rows = JSON.parse(raw || "[]");
      const services = expected.map(name => {
        const found = rows.filter(row => row?.name === name);
        if (found.length !== 1) throw new Error(`expected exactly one ${name}`);
        const env = found[0].pm2_env || {};
        const restartTime = Number(env.restart_time);
        const unstableRestarts = Number(env.unstable_restarts);
        if (env.status !== "online"
            || !Number.isSafeInteger(restartTime) || restartTime < 0
            || !Number.isSafeInteger(unstableRestarts) || unstableRestarts < 0) {
          throw new Error(`invalid PM2 state for ${name}`);
        }
        return { name, status: env.status, restartTime, unstableRestarts };
      });
      process.stdout.write(`${JSON.stringify({ services }, null, 2)}\n`);
    });'
}

read_swap_counter() {
  awk -v key="$1" '$1 == key { print $2; exit }' "$PROC_ROOT/vmstat"
}

verify_live_capacity_and_pm2() {
  local available_kib required_kib load_15_milli oom_log oom_count
  local swap_in_before swap_out_before swap_in_after swap_out_after
  local before after
  [ -r "$PROC_ROOT/meminfo" ] && [ -r "$PROC_ROOT/loadavg" ] \
    && [ -r "$PROC_ROOT/vmstat" ] || {
    echo "Live Linux capacity sources are unavailable" >&2
    return 1
  }
  available_kib="$(awk '/^MemAvailable:/ { print $2; exit }' "$PROC_ROOT/meminfo")"
  required_kib=$((MIN_AVAILABLE_GIB * 1024 * 1024))
  [[ "$available_kib" =~ ^[0-9]+$ ]] && [ "$available_kib" -ge "$required_kib" ] || {
    echo "Live MemAvailable is below ${MIN_AVAILABLE_GIB} GiB" >&2
    return 1
  }
  load_15_milli="$(awk '{ printf "%d", ($3 * 1000) + 0.5 }' "$PROC_ROOT/loadavg")"
  [[ "$load_15_milli" =~ ^[0-9]+$ ]] && [ "$load_15_milli" -lt 6000 ] || {
    echo "Live 15-minute load is at or above 6" >&2
    return 1
  }
  [ -x "$JOURNALCTL_BIN" ] || {
    echo "journalctl is required for the live OOM boundary" >&2
    return 1
  }
  oom_log="$("$JOURNALCTL_BIN" -k --since '-24 hours' --no-pager 2>/dev/null)" || {
    echo "Unable to read the kernel OOM journal" >&2
    return 1
  }
  oom_count="$(printf '%s\n' "$oom_log" \
    | grep -Eic 'Out of memory|oom-kill|Killed process' || true)"
  [ "$oom_count" -eq 0 ] || {
    echo "Recent kernel OOM evidence blocks Sonar" >&2
    return 1
  }

  before="$(pm2_snapshot)" || {
    echo "Unable to capture the initial live PM2 state" >&2
    return 1
  }
  swap_in_before="$(read_swap_counter pswpin)"
  swap_out_before="$(read_swap_counter pswpout)"
  [[ "$swap_in_before" =~ ^[0-9]+$ ]] \
    && [[ "$swap_out_before" =~ ^[0-9]+$ ]] || {
    echo "Unable to read initial swap counters" >&2
    return 1
  }
  if [ "$SAMPLE_SECONDS" -gt 0 ]; then
    [ -x "$SLEEP_BIN" ] || {
      echo "sleep is required for the live stability sample" >&2
      return 1
    }
    "$SLEEP_BIN" "$SAMPLE_SECONDS"
  fi
  swap_in_after="$(read_swap_counter pswpin)"
  swap_out_after="$(read_swap_counter pswpout)"
  [[ "$swap_in_after" =~ ^[0-9]+$ ]] \
    && [[ "$swap_out_after" =~ ^[0-9]+$ ]] \
    && [ "$swap_in_after" -eq "$swap_in_before" ] \
    && [ "$swap_out_after" -eq "$swap_out_before" ] || {
    echo "Live swap pressure blocks Sonar" >&2
    return 1
  }
  after="$(pm2_snapshot)" || {
    echo "Unable to capture the final live PM2 state" >&2
    return 1
  }
  "$NODE_BIN" - "$before" "$after" <<'NODE'
const [beforeRaw, afterRaw] = process.argv.slice(2);
const before = JSON.parse(beforeRaw).services;
const after = JSON.parse(afterRaw).services;
if (before.length !== after.length) process.exit(1);
for (const row of after) {
  const prior = before.find(item => item.name === row.name);
  if (!prior || row.status !== 'online' || prior.status !== 'online'
      || row.restartTime !== prior.restartTime
      || row.unstableRestarts !== prior.unstableRestarts) process.exit(1);
}
NODE
  printf 'sonar_live_capacity_ok memoryFloorGiB=%s load15Milli=%s swapDeltaPages=0 oomEvents24h=0 pm2Stable=true\n' \
    "$MIN_AVAILABLE_GIB" "$load_15_milli"
}

if [ "$VERIFY_PM2_ONLY" = true ]; then
  verify_root_pm2_identity \
    || { echo "Root-owned PM2 v3 identity verification failed" >&2; exit 1; }
  exit 0
fi
if [ "$PRINT_USERNS_MAP" = true ]; then
  [ -x "$NODE_BIN" ] || { echo "node is required" >&2; exit 1; }
  verify_expected_host || exit 1
  verify_protected_identities || exit 1
  verify_docker_socket_authority false || exit 1
  verify_no_automatic_updaters || exit 1
  [ "$DOCKER_USERNS_JSON" != null ] || {
    echo "Docker user-namespace map is unavailable" >&2
    exit 1
  }
  printf '%s\n' "$DOCKER_USERNS_JSON"
  exit 0
fi
verify_root_pm2_identity >/dev/null \
  || { echo "Root-owned PM2 v3 identity verification failed" >&2; exit 1; }
verify_pm2_runtime_inputs || exit 1
[ -x "$NODE_BIN" ] || { echo "node is required" >&2; exit 1; }
if [ "$VERIFY_RUNTIME_BOUNDARY_ONLY" = true ]; then
  verify_runtime_authority "$ALLOW_DOCKER_ABSENT"
  verify_live_capacity_and_pm2
  exit 0
fi

[ -x "$CURL_BIN" ] && [ -x "$NODE_BIN" ] || { echo "curl and node are required" >&2; exit 1; }
verify_expected_host || exit 1
boot_id="$(tr -d '\r\n' <"$PROC_ROOT/sys/kernel/random/boot_id" 2>/dev/null || true)"
[[ "$boot_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || { echo "Unable to read the current Linux boot ID" >&2; exit 1; }
for url in "${HEALTH_URLS[@]}"; do
  case "$url" in http://127.0.0.1:*/*|http://localhost:*/*) ;; *) echo "Health snapshots must use loopback URLs" >&2; exit 64 ;; esac
done

mkdir -m 0700 -p "$OUTPUT"
failures_file="$OUTPUT/failures.txt"
: >"$failures_file"
chmod 0600 "$failures_file"

record_failure() {
  printf '%s\n' "$1" >>"$failures_file"
}

if ! verify_runtime_authority true >"$OUTPUT/runtime-authority.json" 2>&1; then
  record_failure runtime_authority_boundary_failed
fi
chmod 0600 "$OUTPUT/runtime-authority.json"

capture_or_mark() {
  local file="$1"; shift
  if "$@" >"$OUTPUT/$file" 2>&1; then
    chmod 0600 "$OUTPUT/$file"
  else
    printf 'capture_unavailable command=%s\n' "$1" >"$OUTPUT/$file"
    chmod 0600 "$OUTPUT/$file"
    record_failure "snapshot_unavailable:$file"
  fi
}

firewall_backend_count=0
capture_firewall_backend() {
  local file="$1" command="$2"; shift 2
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'backend=not_installed command=%s\n' "$command" >"$OUTPUT/$file"
  elif "$command" "$@" >"$OUTPUT/$file" 2>&1; then
    firewall_backend_count=$((firewall_backend_count + 1))
  else
    printf 'backend=capture_failed command=%s\n' "$command" >"$OUTPUT/$file"
  fi
  chmod 0600 "$OUTPUT/$file"
}

capture_firewall_backend firewall-ufw.txt ufw status verbose
capture_firewall_backend firewall-nft.txt nft list ruleset
capture_firewall_backend firewall-iptables.txt iptables-save
[ "$firewall_backend_count" -gt 0 ] || record_failure no_authoritative_firewall_backend_snapshot
capture_or_mark listeners.txt ss -ltnp
capture_or_mark sysctl.txt sysctl vm.max_map_count fs.file-max net.ipv4.ip_forward
capture_routes() {
  ip -details rule show
  ip route show table all
}
capture_or_mark routes.txt capture_routes

{
  "$SYSTEMCTL_BIN" show tailscaled -p ActiveState -p SubState -p NRestarts --no-pager 2>/dev/null || true
  printf 'tailscaleProcessCount=%s\n' "$(ps -eo comm= | awk '$1 == "tailscaled" { n++ } END { print n + 0 }')"
} >"$OUTPUT/tailscale.txt"
{
  "$SYSTEMCTL_BIN" show "$CLOUDFLARED_UNIT" -p ActiveState -p SubState -p NRestarts --no-pager 2>/dev/null || true
  printf 'cloudflaredProcessCount=%s\n' "$(ps -eo comm= | awk '$1 == "cloudflared" { n++ } END { print n + 0 }')"
} >"$OUTPUT/cloudflare.txt"
chmod 0600 "$OUTPUT/tailscale.txt" "$OUTPUT/cloudflare.txt"

if [ -x "$DOCKER_BIN" ]; then
  docker_cli version --format 'client={{.Client.Version}} server={{.Server.Version}}' >"$OUTPUT/docker.txt" 2>&1 || record_failure docker_version_unavailable
else
  printf 'docker=not_installed\n' >"$OUTPUT/docker.txt"
fi
chmod 0600 "$OUTPUT/docker.txt"

available_kib="$(awk '/^MemAvailable:/ { print $2; exit }' "$PROC_ROOT/meminfo")"
required_kib=$((MIN_AVAILABLE_GIB * 1024 * 1024))
[[ "$available_kib" =~ ^[0-9]+$ ]] || { echo "Unable to read MemAvailable" >&2; exit 1; }
[ "$available_kib" -ge "$required_kib" ] || record_failure "memory_available_below_${MIN_AVAILABLE_GIB}GiB"

load_15_milli="$(awk '{ printf "%d", ($3 * 1000) + 0.5 }' "$PROC_ROOT/loadavg")"
[[ "$load_15_milli" =~ ^[0-9]+$ ]] || { echo "Unable to read 15-minute load" >&2; exit 1; }
[ "$load_15_milli" -lt 6000 ] || record_failure "load_15_at_or_above_6"

disk_used_percent="$(df -P / | awk 'NR == 2 { gsub(/%/, "", $5); print $5 }')"
[[ "$disk_used_percent" =~ ^[0-9]+$ ]] || { echo "Unable to read root disk usage" >&2; exit 1; }
disk_free_percent=$((100 - disk_used_percent))
[ "$disk_free_percent" -ge "$MIN_DISK_FREE_PERCENT" ] || record_failure "disk_free_below_${MIN_DISK_FREE_PERCENT}_percent"

max_map_count="$(sysctl -n vm.max_map_count)"
file_max="$(sysctl -n fs.file-max)"
[ "$max_map_count" -ge 524288 ] || record_failure vm_max_map_count_below_524288
[ "$file_max" -ge 131072 ] || record_failure fs_file_max_below_131072

if ss -ltnH 'sport = :9000' | grep -q .; then
  record_failure port_9000_already_in_use
fi

oom_count=0
if [ -x "$JOURNALCTL_BIN" ]; then
  oom_count="$("$JOURNALCTL_BIN" -k --since '-24 hours' --no-pager 2>/dev/null | grep -Eic 'Out of memory|oom-kill|Killed process' || true)"
else
  record_failure kernel_journal_unavailable
fi
[ "$oom_count" -eq 0 ] || record_failure "kernel_oom_events_last_24h:$oom_count"

pm2_snapshot >"$OUTPUT/pm2-before.json" || record_failure pm2_before_snapshot_failed
chmod 0600 "$OUTPUT/pm2-before.json"

swap_in_before="$(read_swap_counter pswpin)"
swap_out_before="$(read_swap_counter pswpout)"
[ "$SAMPLE_SECONDS" -eq 0 ] || "$SLEEP_BIN" "$SAMPLE_SECONDS"
swap_in_after="$(read_swap_counter pswpin)"
swap_out_after="$(read_swap_counter pswpout)"
swap_in_delta=$((swap_in_after - swap_in_before))
swap_out_delta=$((swap_out_after - swap_out_before))
[ "$swap_in_delta" -eq 0 ] && [ "$swap_out_delta" -eq 0 ] || record_failure "active_swap_io:in=$swap_in_delta,out=$swap_out_delta"

pm2_snapshot >"$OUTPUT/pm2-after.json" || record_failure pm2_after_snapshot_failed
chmod 0600 "$OUTPUT/pm2-after.json"
if [ -s "$OUTPUT/pm2-before.json" ] && [ -s "$OUTPUT/pm2-after.json" ]; then
  "$NODE_BIN" - "$OUTPUT/pm2-before.json" "$OUTPUT/pm2-after.json" <<'NODE' || record_failure pm2_restart_or_status_regression
const fs = require('fs');
const [beforePath, afterPath] = process.argv.slice(2);
const before = JSON.parse(fs.readFileSync(beforePath, 'utf8')).services;
const after = JSON.parse(fs.readFileSync(afterPath, 'utf8')).services;
for (const row of after) {
  const prior = before.find(item => item.name === row.name);
  if (!prior || row.status !== 'online' || prior.status !== 'online') process.exit(1);
  if (row.restartTime !== prior.restartTime || row.unstableRestarts !== prior.unstableRestarts) process.exit(1);
}
NODE
fi

health_index=0
: >"$OUTPUT/health.tsv"
for url in "${HEALTH_URLS[@]}"; do
  health_index=$((health_index + 1))
  body="$OUTPUT/.health-$health_index.body"
  if ! code="$($CURL_BIN --silent --show-error --connect-timeout 2 --max-time 8 -o "$body" -w '%{http_code}' "$url" 2>/dev/null)"; then
    code=000
  fi
  digest=unavailable
  bytes=0
  if [ -f "$body" ]; then
    digest="$(sha256sum "$body" | awk '{ print $1 }')"
    bytes="$(wc -c <"$body" | tr -d ' ')"
    rm -f "$body"
  fi
  printf '%s\t%s\t%s\t%s\n' "$url" "$code" "$bytes" "$digest" >>"$OUTPUT/health.tsv"
  case "$code" in 2??) ;; *) record_failure "health_probe_failed:$url:$code" ;; esac
done
chmod 0600 "$OUTPUT/health.tsv"

cat >"$OUTPUT/capacity.env" <<EOF
MEM_AVAILABLE_KIB=$available_kib
MIN_AVAILABLE_GIB=$MIN_AVAILABLE_GIB
DISK_FREE_PERCENT=$disk_free_percent
MIN_DISK_FREE_PERCENT=$MIN_DISK_FREE_PERCENT
VM_MAX_MAP_COUNT=$max_map_count
FS_FILE_MAX=$file_max
SWAP_IN_DELTA_PAGES=$swap_in_delta
SWAP_OUT_DELTA_PAGES=$swap_out_delta
OOM_EVENTS_LAST_24H=$oom_count
LOAD_15_MILLI=$load_15_milli
SAMPLE_SECONDS=$SAMPLE_SECONDS
EOF
chmod 0600 "$OUTPUT/capacity.env"

find "$OUTPUT" -maxdepth 1 -type f ! -name checksums.sha256 -print0 \
  | sort -z | xargs -0 sha256sum >"$OUTPUT/checksums.sha256"
chmod 0600 "$OUTPUT/checksums.sha256"

failure_count="$(grep -c . "$failures_file" || true)"
if [ "$failure_count" -ne 0 ]; then
  echo "Sonar host preflight failed ($failure_count checks); private evidence: $OUTPUT" >&2
  exit 1
fi
evidence_tool="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/quality-sonar-start-evidence.mjs"
[ -x "$evidence_tool" ] || evidence_tool=/usr/local/sbin/quality-sonar-start-evidence.mjs
[ -x "$evidence_tool" ] || { echo "Sonar start-evidence recorder is unavailable" >&2; exit 1; }
"$evidence_tool" record-preflight \
  --directory "$OUTPUT" \
  --host "$EXPECTED_HOST" \
  --boot-id "$boot_id"
echo "sonar_host_preflight_ok memoryFloorGiB=$MIN_AVAILABLE_GIB diskFloorPercent=$MIN_DISK_FREE_PERCENT evidence=$OUTPUT/result.json"
