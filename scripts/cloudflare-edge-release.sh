#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LANDING_DIR="${NEXUS_LANDING_DEPLOY_DIR:-/Users/felipedominguez/Desktop/nexushub-landing-deploy}"
PAGES_PROJECT="${NEXUS_CLOUDFLARE_PAGES_PROJECT:-nexushub-landing}"
PAGES_BRANCH="${NEXUS_CLOUDFLARE_PAGES_BRANCH:-main}"
PROPAGATION_SECONDS="${NEXUS_EDGE_PROPAGATION_SECONDS:-90}"

APPLY=0
INCLUDE_STAGING=0
SKIP_PAGES=0
SKIP_EDGE=0
SKIP_VERIFY=0

usage() {
  cat <<'USAGE'
Usage: scripts/cloudflare-edge-release.sh [--apply] [--include-staging] [--skip-pages] [--skip-edge] [--skip-verify]

Deploys and verifies the complete Nexus Hub AI-crawler edge posture:
  1. Validate the local landing bundle has robots.txt, llms.txt, and _headers.
  2. Deploy the landing bundle to Cloudflare Pages.
  3. Apply the Cloudflare WAF/Bot Management edge rules.
  4. Verify the live edge contract.

Dry-run is the default. --apply requires CLOUDFLARE_API_TOKEN or CF_API_TOKEN.

Environment:
  NEXUS_LANDING_DEPLOY_DIR       Landing source directory.
  NEXUS_CLOUDFLARE_PAGES_PROJECT Cloudflare Pages project name.
  NEXUS_CLOUDFLARE_PAGES_BRANCH  Cloudflare Pages branch name.
  NEXUS_EDGE_PROPAGATION_SECONDS Seconds to wait before verification.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply)
      APPLY=1
      ;;
    --include-staging)
      INCLUDE_STAGING=1
      ;;
    --skip-pages)
      SKIP_PAGES=1
      ;;
    --skip-edge)
      SKIP_EDGE=1
      ;;
    --skip-verify)
      SKIP_VERIFY=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

require_file() {
  local path="$1"
  if [ ! -f "$path" ]; then
    echo "Missing required landing file: $path" >&2
    exit 1
  fi
}

require_grep() {
  local pattern="$1"
  local path="$2"
  local label="$3"
  if ! grep -qE "$pattern" "$path"; then
    echo "Landing validation failed: $label ($path)" >&2
    exit 1
  fi
}

prepare_landing_bundle() {
  require_file "$LANDING_DIR/index.html"
  require_file "$LANDING_DIR/_headers"
  require_file "$LANDING_DIR/robots.txt"
  require_file "$LANDING_DIR/llms.txt"
  require_file "$LANDING_DIR/privacidade.html"
  require_file "$LANDING_DIR/termos.html"

  require_grep '^User-agent: ClaudeBot$' "$LANDING_DIR/robots.txt" 'robots.txt must explicitly name ClaudeBot'
  require_grep '^Allow: /$' "$LANDING_DIR/robots.txt" 'robots.txt must allow crawler access'
  require_grep '^# Nexus Hub$' "$LANDING_DIR/llms.txt" 'llms.txt must start with the Nexus Hub heading'
  require_grep '\$14\.99/month or R\$69\.99/month' "$LANDING_DIR/llms.txt" 'llms.txt must show current Pro prices'
  require_grep '\$24\.99/month or R\$119\.99/month' "$LANDING_DIR/llms.txt" 'llms.txt must show current Max prices'
  require_grep 'X-Robots-Tag: all' "$LANDING_DIR/_headers" '_headers must keep marketing pages indexable'
  require_grep '^/robots\.txt$' "$LANDING_DIR/_headers" '_headers must include robots.txt route'
  require_grep '^/llms\.txt$' "$LANDING_DIR/_headers" '_headers must include llms.txt route'

  if find "$LANDING_DIR" -maxdepth 1 -name '*.bak*' -print -quit | grep -q .; then
    echo "Landing validation failed: backup files remain in $LANDING_DIR" >&2
    find "$LANDING_DIR" -maxdepth 1 -name '*.bak*' -print >&2
    exit 1
  fi

  local tmp
  tmp="$(mktemp -d /tmp/nexushub-pages-deploy.XXXXXX)"
  rsync -a --delete \
    --exclude='.wrangler' \
    --exclude='.DS_Store' \
    --exclude='*.bak' \
    "$LANDING_DIR/" "$tmp/"
  echo "$tmp"
}

token_present() {
  [ -n "${CLOUDFLARE_API_TOKEN:-}" ] || [ -n "${CF_API_TOKEN:-}" ]
}

echo "Cloudflare edge release"
echo "  landing: $LANDING_DIR"
echo "  pages:   $PAGES_PROJECT / $PAGES_BRANCH"
echo "  mode:    $([ "$APPLY" -eq 1 ] && echo apply || echo dry-run)"

if [ "$APPLY" -eq 1 ] && ! token_present; then
  echo "Missing CLOUDFLARE_API_TOKEN/CF_API_TOKEN; refusing to deploy or mutate Cloudflare." >&2
  exit 2
fi

TMP_BUNDLE=""
cleanup() {
  if [ -n "$TMP_BUNDLE" ] && [ -d "$TMP_BUNDLE" ]; then
    rm -rf "$TMP_BUNDLE"
  fi
}
trap cleanup EXIT

if [ "$SKIP_PAGES" -eq 0 ]; then
  TMP_BUNDLE="$(prepare_landing_bundle)"
  echo "Prepared landing bundle: $TMP_BUNDLE"
  if [ "$APPLY" -eq 1 ]; then
    npx wrangler pages deploy "$TMP_BUNDLE" \
      --project-name "$PAGES_PROJECT" \
      --branch "$PAGES_BRANCH"
  else
    echo "Dry-run: would deploy $TMP_BUNDLE to Cloudflare Pages project $PAGES_PROJECT on branch $PAGES_BRANCH."
  fi
else
  echo "Skipping Pages deploy by request."
fi

if [ "$SKIP_EDGE" -eq 0 ]; then
  if [ "$APPLY" -eq 1 ]; then
    if [ "$INCLUDE_STAGING" -eq 1 ]; then
      node "$ROOT_DIR/scripts/cloudflare-edge-unblock.mjs" --apply --include-staging
    else
      node "$ROOT_DIR/scripts/cloudflare-edge-unblock.mjs" --apply
    fi
  else
    if [ "$INCLUDE_STAGING" -eq 1 ]; then
      node "$ROOT_DIR/scripts/cloudflare-edge-unblock.mjs" --include-staging
    else
      node "$ROOT_DIR/scripts/cloudflare-edge-unblock.mjs"
    fi
  fi
else
  echo "Skipping edge rule apply by request."
fi

if [ "$APPLY" -eq 1 ] && [ "$SKIP_VERIFY" -eq 0 ]; then
  echo "Waiting ${PROPAGATION_SECONDS}s for Cloudflare propagation before verification..."
  sleep "$PROPAGATION_SECONDS"
  "$ROOT_DIR/scripts/cloudflare-edge-verify.sh"
elif [ "$SKIP_VERIFY" -eq 1 ]; then
  echo "Skipping edge verification by request."
else
  echo "Dry-run complete. Re-run with --apply after setting CLOUDFLARE_API_TOKEN or CF_API_TOKEN."
fi
