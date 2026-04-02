#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# setup-hooks.sh — Install Git hooks for Nexus Hub
#
# Installs:
#   - pre-commit: TypeScript type check
#   - pre-push: Full test suite + type check
#
# Usage: ./scripts/setup-hooks.sh
# ─────────────────────────────────────────────────────
set -euo pipefail

HOOKS_DIR="$(git rev-parse --show-toplevel)/.git/hooks"

echo "🔧 Installing Git hooks..."

# ── Pre-commit hook ──────────────────────────────────
cat > "$HOOKS_DIR/pre-commit" << 'HOOK'
#!/usr/bin/env bash
set -e

echo "🔍 Pre-commit: Type checking..."
npx tsc --noEmit 2>/dev/null
echo "✅ Type check passed"

echo "🧪 Pre-commit: Running tests..."
npx vitest run --reporter=dot 2>/dev/null
echo "✅ Tests passed"
HOOK
chmod +x "$HOOKS_DIR/pre-commit"
echo "   ✅ pre-commit hook installed (tsc + vitest)"

# ── Pre-push hook ────────────────────────────────────
cat > "$HOOKS_DIR/pre-push" << 'HOOK'
#!/usr/bin/env bash
set -e

# Get the branch being pushed
BRANCH=$(git rev-parse --abbrev-ref HEAD)

echo "🔍 Pre-push: Verifying $BRANCH..."

# Always run type check
echo "   📝 Type check..."
npx tsc --noEmit 2>/dev/null
echo "   ✅ Types OK"

# Run tests
echo "   🧪 Running tests..."
npx vitest run --reporter=dot 2>/dev/null
echo "   ✅ Tests passed"

# Extra checks for main branch
if [ "$BRANCH" = "main" ]; then
  echo "   🔨 Build verification (pushing to main)..."
  npm run build 2>/dev/null
  echo "   ✅ Build OK"
fi

echo "✅ All checks passed — pushing"
HOOK
chmod +x "$HOOKS_DIR/pre-push"
echo "   ✅ pre-push hook installed"

echo ""
echo "🎉 Git hooks installed! Checks will run automatically on commit and push."
echo ""
echo "   Skip hooks (emergency): git push --no-verify"
