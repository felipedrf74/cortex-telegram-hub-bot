#!/usr/bin/env bash
# Copy immutable runtime backup content while production remains online.
# Database state is intentionally excluded and finalized only after writes drain.
set -euo pipefail
umask 077

RUNTIME_DIR="${1:?runtime directory is required}"
BACKUP_DIR="${2:?backup directory is required}"
[ -d "$RUNTIME_DIR" ] || { echo "runtime directory is missing" >&2; exit 1; }
install -d -m 700 "$BACKUP_DIR"
STAGE="$(mktemp -d "$BACKUP_DIR/.runtime-stage-XXXXXX")"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

# Use explicit file/directory classes instead of the compact numeric form.
# Both GNU rsync and the older rsync shipped on macOS accept this spelling,
# while preserving the same private 0700-directory/0600-file boundary.
readonly RSYNC_PRIVATE_CHMOD='Du=rwx,Dgo=,Fu=rw,Fgo='

required=(dist prompts migrations package.json package-lock.json ecosystem.config.js content-engine)
for relative in "${required[@]}"; do
  [ -e "$RUNTIME_DIR/$relative" ] || { echo "runtime backup source missing: $relative" >&2; exit 1; }
done

for relative in dist prompts migrations package.json package-lock.json ecosystem.config.js; do
  install -d -m 700 "$STAGE/$(dirname "$relative")"
  rsync -a --chmod="$RSYNC_PRIVATE_CHMOD" "$RUNTIME_DIR/$relative" "$STAGE/$(dirname "$relative")/"
done
rsync -a --chmod="$RSYNC_PRIVATE_CHMOD" \
  --exclude='.env' --exclude='.env.*' --exclude='.venv/' --exclude='.local/' \
  --exclude='logs/' --exclude='data/' --exclude='*.db' --exclude='__pycache__/' \
  "$RUNTIME_DIR/content-engine/" "$STAGE/content-engine/"
if [ -d "$RUNTIME_DIR/catalog" ]; then
  rsync -a --chmod="$RSYNC_PRIVATE_CHMOD" "$RUNTIME_DIR/catalog/" "$STAGE/catalog/"
fi

node - "$STAGE" <<'NODE'
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile()) {
      const body = fs.readFileSync(full);
      files.push({
        path: path.relative(root, full).split(path.sep).join('/'),
        size: body.length,
        sha256: crypto.createHash('sha256').update(body).digest('hex'),
      });
    }
  }
}
walk(root);
files.sort((a, b) => a.path.localeCompare(b.path));
fs.writeFileSync(path.join(root, '.nexus-runtime-prestage.json'), `${JSON.stringify({
  schema: 'nexus.runtime-backup-prestage.v1', preparedAt: new Date().toISOString(), files,
}, null, 2)}\n`, { mode: 0o600 });
NODE

trap - EXIT
echo "NEXUS_PREPARED_RUNTIME_DIR=$STAGE"
