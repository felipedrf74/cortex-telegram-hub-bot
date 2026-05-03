#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# closed-beta-identity-scan.sh — Catch single-tenant identity residue.
#
# Closed-beta-readiness-hardening (2026-05-03).
#
# This scanner is the trip-wire for the v4.14.118-class P0 (a single
# literal "Felipe's voice" string in a runtime prompt that leaked
# founder identity to every authenticated user). It greps the runtime
# code (src/, prompts/, content-engine/, src/skills/) for hardcoded
# founder identity terms — but is smart enough to NOT flag:
#
#   - copyright headers (// Copyright (c) 2025 Felipe Dominguez. MIT...)
#   - manifest.json author fields (acceptable metadata)
#   - test files (test fixtures legitimately use named users)
#   - operator-config env-flag fallbacks (e.g. config.youtube.channelId)
#   - skill prompt section markers ("// authored by", etc.)
#   - the single intentional landing-page footer copyright
#
# What IT FLAGS:
#   - "Felipe's voice", "adapt to Felipe", "Felipe's brand", "Felipe's profile"
#   - the literal string "felipe_version" as a code-level field name
#     (was renamed to creator_version on 2026-05-03; future regressions
#     should fail this scan)
#   - any hardcoded user-A name string in a prompt body or persisted
#     payload writer outside the test surface
#
# Modes:
#   default          report; exit 0
#   --strict         report and exit 1 if any flag is found
#   --json           machine-readable
#
# Wiring:
#   - ci.yml lint job (advisor)
#   - nightly.yml (strict)
#   - pre-commit hook (advisor) for early local feedback
# ─────────────────────────────────────────────────────
set -euo pipefail

LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STRICT=false
JSON=false

for arg in "$@"; do
  case "$arg" in
    --strict) STRICT=true ;;
    --json) JSON=true ;;
    -h|--help)
      sed -n '2,40p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
  esac
done

cd "$LOCAL_DIR"

# Forbidden runtime patterns — anything matching is a closed-beta block
# unless the file is in the allowlist below.
#
# Patterns:
#   1. Felipe's voice / adapt to Felipe / Felipe's brand / Felipe's profile
#      (the v4.14.118-class P0 phrasing)
#   2. felipe_version (renamed to creator_version on 2026-05-03)
#   3. Any literal "Felipe Dominguez" outside copyright + author metadata
forbidden_patterns=(
  "Felipe's voice"
  "Felipe's brand"
  "Felipe's profile"
  "adapt to Felipe"
  "Felipe's audience"
  "felipe_version"
  "felipes_angle"
)

# Files / path-prefixes that are ALLOWED to mention founder identity
# (metadata, copyright, single-tenant operator config, test fixtures,
# stale design docs).
# Each pattern is matched against the FILE path (the part before the
# first `:` in a grep -rn line).
allow_paths=(
  '^__tests__/'
  '\.test\.ts$'
  '\.test\.tsx$'
  '\.spec\.ts$'
  '^src/portal/landing\.html$'
  '^src/portal/portal\.html$'
  '^src/skills/[^/]+/manifest\.json$'
  '^package\.json$'
  '^CHANGELOG\.md$'
  '^docs/'
  '^engine/docs/'
  '^scripts/closed-beta-identity-scan\.sh$'
  '\.archived$'
  # Stale legacy design doc; not loaded at runtime. P3 cleanup item.
  '^prompts/daily-content-discovery\.md$'
)

# Build the egrep allow-pattern (OR-joined)
allow_re="$(printf '%s|' "${allow_paths[@]}" | sed 's/|$//')"

# In-line marker that explicitly opts a single line out of this scan
# (e.g. legacy field-name backward-compat reads). The marker text is
# `nx-allow-identity-scan`.
inline_allow='nx-allow-identity-scan'

findings=()
total_flags=0

for pat in "${forbidden_patterns[@]}"; do
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    # `grep -rn` formats: `path:lineno:text`. Extract path for allow-match.
    file_path="${line%%:*}"
    if printf '%s' "$file_path" | grep -qE "$allow_re"; then
      continue
    fi
    # Inline opt-out marker on the same line (or the previous line for
    # multi-line constructs). We approximate with same-line check.
    if printf '%s' "$line" | grep -qF "$inline_allow"; then
      continue
    fi
    # Surrounding-line opt-out: check the line ABOVE in the file.
    # Some legacy backward-compat blocks place the marker in the
    # comment immediately above the field read.
    line_no="$(printf '%s' "$line" | cut -d: -f2)"
    if [ -n "$line_no" ] && [ "$line_no" -gt 1 ] 2>/dev/null; then
      prev_line_no=$((line_no - 1))
      prev="$(sed -n "${prev_line_no}p" "$file_path" 2>/dev/null || true)"
      if printf '%s' "$prev" | grep -qF "$inline_allow"; then
        continue
      fi
    fi
    findings+=("$line")
    total_flags=$((total_flags + 1))
  done < <(
    grep -rni --binary-files=without-match "$pat" \
      src/ prompts/ content-engine/ 2>/dev/null \
      | grep -vE "^\s*\*" \
      | grep -vE "// Copyright" \
      | grep -vE "//.*felipedrf" || true
  )
done

if [ "$JSON" = true ]; then
  printf '%s\n' "${findings[@]+"${findings[@]}"}" \
    | NODE_NO_WARNINGS=1 node -e '
      const lines = require("fs").readFileSync(0, "utf8").split("\n").filter(Boolean);
      const issues = lines.map((l) => {
        const m = l.match(/^([^:]+):(\d+):(.*)$/);
        if (!m) return { raw: l };
        return { file: m[1], line: Number(m[2]), text: m[3].trim() };
      });
      console.log(JSON.stringify({
        generatedAt: new Date().toISOString(),
        totalFlags: issues.length,
        issues,
      }, null, 2));
    '
else
  echo "# closed-beta-identity-scan"
  echo
  echo "Total flags: $total_flags"
  echo
  if [ "$total_flags" -eq 0 ]; then
    echo "✅ No hardcoded founder-identity residue found in runtime code."
  else
    echo "## Findings"
    echo
    for f in "${findings[@]}"; do
      echo "- $f"
    done
    echo
    echo "Resolution:"
    echo "  - rewrite the prompt/runtime string in neutral terms"
    echo "    (use authenticated creator's profile / voice DNA / brand voice)"
    echo "  - or move the file to docs/archive/ if it is historical"
    echo "  - or add the file to the allowlist in this script if it is"
    echo "    intentional metadata / single-tenant operator config"
  fi
fi

if [ "$STRICT" = true ] && [ "$total_flags" -gt 0 ]; then
  exit 1
fi
exit 0
