#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# changed-area-classifier.sh — Map a git diff to release tier + matrix rows
#
# Read-only advisor. Does not run tests, does not change any file. Prints
# JSON or markdown describing the recommended Tier 0–6 lane and the
# risk-matrix rows that apply for the changed files.
#
# Use this as the input to:
#   - pre-commit hook (skip vitest entirely on docs-only diff)
#   - pre-push hook (focused vs full)
#   - CI matrix dispatch
#   - promote-to-prod readiness check
#
# Inputs:
#   --base <ref>       Base ref to diff against. Defaults to origin/main, then main.
#   --format json|md   Output format. Defaults to markdown.
#   --files <list>     Comma-separated explicit file list (skips git diff).
#                       Useful for hooks that already have the staged set.
#   --quiet             Suppress narrative output; emit only the JSON.
#   -h, --help          Show this header.
#
# Outputs (markdown):
#   - Recommended tier list
#   - Recommended Vitest path globs (or "FULL" / "NONE")
#   - Recommended XCTest classes (or "FULL" / "NONE")
#   - Required staging-smoke domain checks
#   - Cannot-skip warnings (tenant/security/calendar/provider/migration)
#
# Outputs (json):
#   { "version": "1",
#     "baseRef": "...", "head": "...", "changedFiles": [...],
#     "areas": [...], "tiers": [...],
#     "vitest": { "mode": "skip|focused|full", "globs": [...] },
#     "xctest": { "mode": "skip|focused|full", "classes": [...] },
#     "stagingSmoke": { "generic": true, "domains": [...] },
#     "cannotSkip": [...],
#     "skipReason": "..." }
#
# Safe to run on any working tree, any time. Does not need network.
# ─────────────────────────────────────────────────────
set -euo pipefail

LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_REF=""
FORMAT="markdown"
EXPLICIT_FILES=""
QUIET=false

while [ $# -gt 0 ]; do
  case "$1" in
    --base)   BASE_REF="$2"; shift 2;;
    --format) FORMAT="$2"; shift 2;;
    --files)  EXPLICIT_FILES="$2"; shift 2;;
    --quiet)  QUIET=true; shift;;
    --json)   FORMAT="json"; shift;;
    --markdown) FORMAT="markdown"; shift;;
    -h|--help)
      sed -n '2,40p' "$0" | sed 's/^# \?//'
      exit 0;;
    *)
      echo "Unknown arg: $1" >&2
      exit 64;;
  esac
done

# Resolve base ref. Try in order:
#   1. explicit --base
#   2. origin/main
#   3. main
#   4. HEAD~1 as a last-resort fallback
resolve_base() {
  if [ -n "$BASE_REF" ]; then
    if git -C "$LOCAL_DIR" rev-parse --verify "$BASE_REF^{commit}" >/dev/null 2>&1; then
      printf '%s' "$BASE_REF"
      return 0
    fi
    echo "Base ref '$BASE_REF' does not resolve" >&2
    return 1
  fi
  for ref in origin/main main HEAD~1; do
    if git -C "$LOCAL_DIR" rev-parse --verify "$ref^{commit}" >/dev/null 2>&1; then
      printf '%s' "$ref"
      return 0
    fi
  done
  echo "Could not resolve any base ref" >&2
  return 1
}

resolved_base="$(resolve_base)"
head_sha="$(git -C "$LOCAL_DIR" rev-parse --short HEAD 2>/dev/null || printf 'unknown')"

# Collect changed files. Two sources are merged:
#   - committed diff against base (`git diff --name-only base...HEAD`)
#   - working-tree changes (`git status --porcelain` minus '??' untracked)
# This way a hook with no committed diff still sees staged + dirty files.
collect_changes() {
  if [ -n "$EXPLICIT_FILES" ]; then
    printf '%s\n' "$EXPLICIT_FILES" | tr ',' '\n' | sed '/^$/d'
    return
  fi
  {
    git -C "$LOCAL_DIR" diff --name-only "$resolved_base"...HEAD 2>/dev/null || true
    git -C "$LOCAL_DIR" status --porcelain 2>/dev/null \
      | sed -E 's/^[ MADRCU?!]{2} //' \
      | sed -E 's/^"//; s/"$//' || true
  } | sed '/^$/d' | sort -u
}

CHANGED="$(collect_changes)"
CHANGED_COUNT="$(printf '%s\n' "$CHANGED" | sed '/^$/d' | wc -l | tr -d ' ')"

# Classification flags
HAS_BACKEND_SRC=false
HAS_BACKEND_TEST=false
HAS_API_ROUTE=false
HAS_TRAINING=false
HAS_COACH_KERNEL=false
HAS_CALENDAR=false
HAS_PROVIDER_ROUTING=false
HAS_AUTH_OR_TENANT=false
HAS_MEMORY_OR_RETRIEVAL=false
HAS_PROMPT=false
HAS_COOKING=false
HAS_CONTENT=false
HAS_FINANCE=false
HAS_SECRETARY=false
HAS_PORTAL=false
HAS_MIGRATION=false
HAS_PYTHON_ENGINE=false
HAS_IOS_SRC=false
HAS_IOS_AUTH=false
HAS_IOS_UI=false
HAS_IOS_TEST=false
HAS_DOCS_ONLY=true
HAS_CURRENT_VERDICT_DOC=false
HAS_DEPLOY_SCRIPT=false
HAS_HOOK=false
HAS_CI_WORKFLOW=false
HAS_TEST_CONFIG=false
HAS_PACKAGE_JSON=false
HAS_NON_DOC=false
# Closed-beta hardening (2026-05-03): attachment plumbing, model
# routing, and explicit personalization-scope changes that the audit
# flagged as missing dedicated routing into the security tests.
HAS_ATTACHMENT=false
HAS_MODEL_ROUTING=false
HAS_PERSONALIZATION_SCOPE=false
HAS_CONTENT_AGENT=false
# Engineering-excellence hardening (2026-05-04): classifier gaps
# that the audit flagged as currently missing dedicated test routing.
# Each maps a high-blast-radius surface to its existing test files so
# touching that surface auto-fans out into the right suites.
HAS_LOGGER=false              # pino/redaction/PII-scrub changes
HAS_SCHEDULER=false           # cron/scheduler/job-failure paths
HAS_NOTIFICATION=false        # APNs/iOS push/notification routing
HAS_HEALTH_INTEGRATION=false  # Garmin/HealthKit/wearable/body-battery
HAS_RATE_LIMIT=false          # rate-limit middleware + per-account lockout
HAS_AUDIT=false               # audit trail and audit-event contracts
HAS_DEPLOY_CONFIG=false       # PM2/deploy config and environment shape
HAS_EVENT_BACKBONE=false      # event_outbox/jobs/read-models/delta-sync/budgets
HAS_CHAT_REASONING=false      # Chat ActionFrame parsing/execution/eval harness
HAS_IOS_NAVIGATION=false      # tab/navigation/view-model responsiveness
HAS_IOS_DTO=false             # app-facing DTO/decoder contract changes
HAS_IOS_NOTIFICATION=false    # APNs/local notifications/Decision Center UI
HAS_APPLE_NOTIFICATION_WEBHOOK=false
HAS_TRAINING_ENTITLEMENT=false
HAS_CONTENT_PROMPT_CLEANLINESS=false
HAS_VOICE_EVOLUTION_MULTI_TENANT=false
HAS_VIDEO_STUDY_PROMPT_CLEANLINESS=false
HAS_CHANNEL_LEARNER_PROMPT_CLEANLINESS=false
HAS_GLOBAL_COST_GUARDRAIL_REST=false

# Use grep-based detection so multiple flags can match a single file.
# Bash `case` stops at the first match — that's wrong here because e.g.
# `src/services/coach-kernel/strength-engine.ts` is BOTH HAS_BACKEND_SRC
# AND HAS_TRAINING AND HAS_COACH_KERNEL. We need fan-out, not switch.
match() {
  # match <regex> on $CHANGED (one path per line). Returns 0 if any match.
  printf '%s\n' "$CHANGED" | grep -E -q "$1"
}

# Non-doc detection: any file that's NOT (.md / docs/** / prompts/*.md / CHANGELOG.md)
if printf '%s\n' "$CHANGED" \
    | grep -vE '\.md$|^docs/|/docs/|^CHANGELOG\.md$|^prompts/.*\.md$' \
    | grep -q .; then
  HAS_NON_DOC=true
  HAS_DOCS_ONLY=false
fi

match '^docs/release/CURRENT_RELEASE_STATE\.md$|^docs/release/OPEN_ITEMS\.md$|^engine/docs/release/CURRENT_RELEASE_STATE\.md$|^engine/docs/release/current-release-index\.md$|^docs/qa/QA_BACKEND_REPORT\.md$|^docs/release/release-pipeline-optimization-report\.md$' && HAS_CURRENT_VERDICT_DOC=true

match '^src/' && HAS_BACKEND_SRC=true
match '^__tests__/' && HAS_BACKEND_TEST=true
match '^src/api/' && HAS_API_ROUTE=true

match '^src/services/coach-kernel/' && { HAS_TRAINING=true; HAS_COACH_KERNEL=true; }
match '^src/services/training-|^src/api/routes/training' && HAS_TRAINING=true
match '^src/api/routes/training|^src/api/router\.ts$|^__tests__/security/training-routes-entitlement\.test\.ts$' && HAS_TRAINING_ENTITLEMENT=true
match '^src/skills/training/' && HAS_TRAINING=true
match '^__tests__/services/training-' && HAS_TRAINING=true
match '^__tests__/services/coach-kernel-' && { HAS_TRAINING=true; HAS_COACH_KERNEL=true; }
match '^__tests__/api/training-' && HAS_TRAINING=true

match '^src/services/unified-calendar|^src/services/calendar' && HAS_CALENDAR=true
match '^__tests__/services/.*calendar' && HAS_CALENDAR=true
match '^__tests__/api/training-calendar-' && HAS_CALENDAR=true
match '^__tests__/api/training-plan-calendar-' && HAS_CALENDAR=true

match '^src/services/provider-registry|^src/services/gemini-provider|^src/services/anthropic|^src/services/tool-executor|^src/services/openai' && HAS_PROVIDER_ROUTING=true
match '^__tests__/services/provider-|^__tests__/services/ai-provider' && HAS_PROVIDER_ROUTING=true

match '^src/api/middleware/auth|^src/api/routes/auth|^src/services/auth|^src/services/ios-auth-session|^src/services/google-sign-in|^src/services/apple-sign-in-nonce|^src/services/google-auth-session-store|^src/services/oauth-flow|^src/services/oauth-state-store|^src/portal/oauth-routes|^src/services/user-service|^src/state/scope' && HAS_AUTH_OR_TENANT=true
match '^__tests__/security/|^__tests__/scope/|^__tests__/api/auth-|^__tests__/api/connections-tenant-|^__tests__/services/google-sign-in|^__tests__/services/apple-sign-in-nonce|^__tests__/services/oauth-|^__tests__/portal/portal-oauth-routes' && HAS_AUTH_OR_TENANT=true

match '^src/services/context-engine|^src/services/chat-context-engine|^src/state/content-references|^src/services/intelligence-bus' && HAS_MEMORY_OR_RETRIEVAL=true
match '^__tests__/services/.*context|^__tests__/services/.*memory|^__tests__/services/.*retrieval' && HAS_MEMORY_OR_RETRIEVAL=true

match '^prompts/|^src/skills/.*/prompts/' && HAS_PROMPT=true

match '^src/domains/cooking/|^src/services/cooking-|^src/api/routes/cooking|^src/skills/cooking/' && HAS_COOKING=true
match 'cooking' && match '^__tests__/' && HAS_COOKING=true

match '^src/domains/content/|^src/services/content-|^src/services/voice-|^src/api/routes/content|^src/agents/|^content-engine/' && HAS_CONTENT=true
match '^content-engine/services/|^content-engine/models/|^content-engine/routers/|^content-engine/tests/test_prompt_cleanliness\.py$|^src/services/content-engine\.ts$|^src/commands/books\.ts$' && HAS_CONTENT_PROMPT_CLEANLINESS=true
match '^__tests__/services/content-' && HAS_CONTENT=true
match '^src/agents/|^__tests__/services/cross-agent-learning|^__tests__/security/content-agent-neutrality' && HAS_CONTENT_AGENT=true
match '^src/agents/voice-evolution-agent\.ts$|^__tests__/agents/voice-evolution-multi-tenant\.test\.ts$' && HAS_VOICE_EVOLUTION_MULTI_TENANT=true
match '^src/services/video-study\.ts$|^__tests__/services/video-study-prompt-cleanliness\.test\.ts$' && HAS_VIDEO_STUDY_PROMPT_CLEANLINESS=true
match '^src/services/channel-learner\.ts$|^__tests__/services/channel-learner-prompt-cleanliness\.test\.ts$' && HAS_CHANNEL_LEARNER_PROMPT_CLEANLINESS=true

match '^src/domains/finance/|^src/services/finance-|^src/services/invoice-|^src/api/routes/finance|^src/skills/finance/' && HAS_FINANCE=true
match '^__tests__/services/finance-|^__tests__/services/invoice-' && HAS_FINANCE=true

match '^src/domains/secretary/|^src/services/secretary-|^src/api/routes/secretary|^src/skills/secretary/' && HAS_SECRETARY=true
match '^__tests__/services/secretary-' && HAS_SECRETARY=true

match '^src/portal/|^__tests__/portal/|^scripts/cooking-portal-browser-smoke\.ts$' && HAS_PORTAL=true

match '^migrations/' && HAS_MIGRATION=true
match '^content-engine/' && HAS_PYTHON_ENGINE=true
match '^src/api/router\.ts$|^src/api/routes/billing\.ts$|^src/services/apple-jws-verifier\.ts$|^__tests__/security/billing-apple-notifications-jws-verify\.test\.ts$' && HAS_APPLE_NOTIFICATION_WEBHOOK=true
match '^src/services/cost-guardrail\.ts$|^src/api/routes/(chat-message-request|training-plan-routes|training|content-script-routes|finance)\.ts$|^__tests__/security/cost-guardrail-global-rest\.test\.ts$' && HAS_GLOBAL_COST_GUARDRAIL_REST=true

match '^scripts/(deploy|deploy-staging|promote-to-prod|rollback|restore)\.sh$' && HAS_DEPLOY_SCRIPT=true
match '^\.husky/' && HAS_HOOK=true
match '^\.github/workflows/' && HAS_CI_WORKFLOW=true
match '^vitest\.config\.ts$|^tsconfig\.json$' && HAS_TEST_CONFIG=true
match '^package\.json$|^package-lock\.json$' && HAS_PACKAGE_JSON=true

# Closed-beta hardening (2026-05-03): three new flags so the
# security/isolation suite gets dispatched whenever the relevant
# surfaces change.

# Attachment / image / media plumbing — chat attachment routes,
# media handlers, and any test that exercises them. Cross-tenant
# attachment leakage is a high-blast-radius P0 vector if anything
# in this surface regresses (an attachment handed to user A could
# be served to user B).
match '^src/api/routes/chat-message-attachments|^src/api/routes/chat-attachments|^src/handlers/media|^__tests__/api/chat-attachments|^__tests__/api/chat-message-attachments|^__tests__/services/fiscal-bundle-attachments' && HAS_ATTACHMENT=true

# Model routing / domain provider router — provider routing already
# has its own flag, but the higher-level `domain-provider-router.ts`
# and `model-routing-*` test files are about which model handles
# which user request, separate from the SDK wrappers. Changes here
# affect cross-tenant cost attribution and per-domain fallback
# behavior.
match '^src/services/domain-provider-router|^src/portal/provider-routes|^__tests__/services/domain-provider-router|^__tests__/services/model-routing-' && HAS_MODEL_ROUTING=true

# Personalization scope — cooking-preferences, content-references,
# finance preferences, skill-memory. These determine what data
# crosses into a per-user prompt. The audit flagged Cooking and
# Finance preference scope as missing dedicated routing.
match '^src/services/cooking-preferences|^src/services/finance-preferences|^src/services/skill-memory|^src/state/content-references|^__tests__/services/cooking-preferences|^__tests__/services/finance-preferences|^__tests__/services/skill-memory|^__tests__/services/content-references' && HAS_PERSONALIZATION_SCOPE=true

# Engineering-excellence hardening (2026-05-04): additional
# flag groups so the relevant safety/regression suites are picked up
# automatically when a change touches these surfaces.

# Logger / pino / redaction — `src/utils/logger.ts` and the redaction
# helpers control what does (and does not) end up in operator-visible
# logs. Bug here is a security-policy violation by definition (PII or
# raw secrets reaching pino). Changes route through the existing
# `__tests__/utils/logger-redaction.test.ts` and the secret-guard
# integration test.
match '^src/utils/logger|^src/utils/redact|^src/utils/log-context|^__tests__/utils/logger-|^__tests__/api/secret-guards' && HAS_LOGGER=true

# Scheduler / cron / job-failure plumbing — `src/services/scheduler.ts`
# fans out 28+ cron jobs. A regression that breaks per-user scope or
# silent-fails a job leaks into operator alerts and into stale
# task/calendar state. The user-scope test pins per-tenant iteration.
match '^src/services/scheduler|^src/services/cron|^src/services/job-|^__tests__/services/scheduler-' && HAS_SCHEDULER=true

# Notification / APNs / push routing — APNs token upload, Secretary
# Notification Orchestrator, privacy-safe payload shaping, decision logs,
# device tokens, and action handling. Regressions here can leak tenant data,
# spam users, or expose private lock-screen copy.
match '^src/services/apns-|^src/services/notification|^src/api/routes/notifications|^src/api/routes/content-notification|^src/services/content-notification|^__tests__/services/apns-|^__tests__/services/notification-|^__tests__/services/content-notifications|^__tests__/api/notifications-|^__tests__/api/content-notification-|^__tests__/security/notification-' && HAS_NOTIFICATION=true

# Health integration — Garmin, Apple Health, HealthKit, body-battery,
# readiness, wearable cache isolation. Cross-user readiness leaks are
# a known risk class (Felipe / Jaqueline / nexushubbot isolation
# verification is in OPEN_ITEMS). Test mapping covers wearable cache
# and Apple Health parity.
match '^src/services/garmin|^src/services/apple-health|^src/services/wearable|^src/services/readiness|^src/services/body-battery|^src/api/routes/wearable|^src/api/routes/health-data|^src/api/routes/garmin-auth|^__tests__/services/garmin-|^__tests__/services/apple-health-|^__tests__/services/integration-health-|^__tests__/api/wearable-|^__tests__/api/health-data-|^__tests__/api/garmin-auth-|^__tests__/portal/integration-health-' && HAS_HEALTH_INTEGRATION=true

# Rate limit / abuse control — auth-route rate limiter, portal rate
# limiter, per-account lockout (AUTH-O7 still open). Regressions here
# remove an auth-defense layer.
match '^src/api/middleware/rate-limit|^src/services/rate-limiter|^src/api/middleware/auth-rate-limit|^__tests__/api/rate-limiter' && HAS_RATE_LIMIT=true

# Audit trail — GDPR/self-service audit reads, admin audit reads, and
# auth/provider-link/user-created audit emission. A regression here weakens
# incident response and user-data accountability.
match '^src/services/audit-trail|^src/api/routes/audit-trail|^src/portal/admin-audit|^src/portal/admin-data-routes|^__tests__/services/audit-trail|^__tests__/api/authenticated-support-routes-scope|^__tests__/portal/portal-admin-audit|^__tests__/portal/portal-admin-data-routes|^__tests__/portal/portal-admin-data-isolation' && HAS_AUDIT=true

# Deploy / PM2 config — runtime process topology and environment shape.
# These are not deploy scripts themselves, but they change what deploy scripts
# start and health-check.
match '(^|/)ecosystem(\.staging)?\.config\.js$|^src/config\.ts$|^__tests__/config|^__tests__/scripts/deploy' && HAS_DEPLOY_CONFIG=true

# Event backbone / jobs / read models / sync / budgets — SQLite-backed
# projection and delta-sync foundation. These changes must fan out into
# event/job/idempotency tests, summary endpoint tests, sync cursor tests,
# and tenant/user isolation checks.
match '^src/services/event-outbox|^src/services/background-job-queue|^src/services/product-decision-log|^src/services/app-summary-read-models|^src/services/delta-sync|^src/services/resource-budgets|^src/services/event-backbone-worker|^src/api/routes/summaries|^src/api/routes/sync|^migrations/[0-9]+_event_backbone|^__tests__/services/event-backbone|^__tests__/api/event-backbone' && HAS_EVENT_BACKBONE=true

# Chat Reasoning Engine — deterministic ActionFrame parsing, Secretary
# task/subtask execution, policy validation, and route-level no-model
# interception. These changes must route through behavior tests, not
# shape-only prompt checks.
match '^src/services/chat-reasoning|^src/api/routes/chat-message-routes|^__tests__/services/chat-reasoning|^__tests__/api/chat-routes' && { HAS_CHAT_REASONING=true; HAS_SECRETARY=true; }

# Detect iOS changes by file path. iOS repo is at ../Nexus Hub IOS/Nexus Hub
# but in workspace symlink it's `ios/`. Since this script runs from engine,
# ios files won't appear in this engine diff — included for forward-compat
# when the classifier is invoked from the workspace.
while IFS= read -r f; do
  case "$f" in
    *.swift) HAS_IOS_SRC=true ;;
    *UITests*|*UITest.swift) HAS_IOS_UI=true; HAS_IOS_TEST=true ;;
    *Tests*|*Test.swift) HAS_IOS_TEST=true ;;
  esac
  case "$f" in
    *Core/AuthManager.swift|*Core/KeychainHelper.swift|*Views/Auth/*|*Auth*Tests.swift|*Keychain*Tests.swift|*GoogleAuthCallbackResolverTests.swift) HAS_IOS_AUTH=true ;;
  esac
  case "$f" in
    *MainTabView.swift|*RootView.swift|*AppState.swift|*Navigation*|*ViewModel.swift|*DashboardViewModel.swift|*TrainingViewModel.swift|*ChatViewModel.swift|*TasksViewModel.swift|*NavigationPerformance*|*Responsiveness*|*HomeWeekNavigationPerformanceUITests.swift|*AppWideResponsivenessUITests.swift) HAS_IOS_NAVIGATION=true ;;
  esac
  case "$f" in
    *Service.swift|*Repository.swift|*DTO*|*Contract*|*Decoder*|*Response*.swift|*ContractDecoderResilienceTests.swift|*HomeViewStateContractDecodingTests.swift|*TrainingHomeViewStateContractDecodingTests.swift|*ContentHomeContractDecodingTests.swift|*PlanGenerateResponse*Tests.swift) HAS_IOS_DTO=true ;;
  esac
  case "$f" in
    *Notification*|*DecisionCenter*|*InboxView.swift|*DeepLinkRouter.swift|*Notification*Tests.swift|*Notification*UITests.swift|*DecisionCenter*Tests.swift|*DecisionCenter*UITests.swift) HAS_IOS_NOTIFICATION=true; HAS_IOS_SRC=true ;;
  esac
done <<EOF
$CHANGED
EOF

$HAS_IOS_AUTH && HAS_AUTH_OR_TENANT=true
$HAS_IOS_NAVIGATION && HAS_IOS_SRC=true
$HAS_IOS_DTO && HAS_IOS_SRC=true
$HAS_IOS_NOTIFICATION && HAS_IOS_SRC=true

# ── Tier resolution ────────────────────────────────────
# Tier 0: always.
# Tier 1: required when any source/test/config/migration/hook/CI/deploy file changed.
# Tier 2 (local smoke): required when app-facing flow surface changed.
# Tier 4 (staging smoke): required when backend src/migrations/python-engine changed AND release flow.
# Cannot-skip: tenant/auth/security, prompts (chat-identity-class), calendar lifecycle,
#              provider routing, migrations, deploy script changes.

TIERS=()
TIERS+=("T0")

CANNOT_SKIP=()
$HAS_AUTH_OR_TENANT && CANNOT_SKIP+=("tenant-auth-security")
$HAS_MEMORY_OR_RETRIEVAL && CANNOT_SKIP+=("memory-retrieval-isolation")
$HAS_PROMPT && CANNOT_SKIP+=("prompt-injection-defense")
$HAS_CALENDAR && CANNOT_SKIP+=("calendar-agenda-lifecycle")
$HAS_PROVIDER_ROUTING && CANNOT_SKIP+=("provider-routing-fallback")
$HAS_MIGRATION && CANNOT_SKIP+=("migration-rollback-review")
$HAS_DEPLOY_SCRIPT && CANNOT_SKIP+=("deploy-script-promotion-rehearsal")
$HAS_HOOK && CANNOT_SKIP+=("hook-validation-on-feature-branch")
$HAS_CI_WORKFLOW && CANNOT_SKIP+=("ci-workflow-validation-on-PR")
$HAS_TEST_CONFIG && CANNOT_SKIP+=("test-config-mock-completeness-audit")
# Closed-beta hardening (2026-05-03): three new cannot-skip gates.
$HAS_ATTACHMENT && CANNOT_SKIP+=("attachment-tenant-isolation")
$HAS_MODEL_ROUTING && CANNOT_SKIP+=("model-routing-cost-attribution")
$HAS_PERSONALIZATION_SCOPE && CANNOT_SKIP+=("personalization-scope-isolation")
$HAS_CONTENT_AGENT && CANNOT_SKIP+=("content-agent-neutrality")
# Engineering-excellence hardening (2026-05-04): cannot-skip gates so
# operator-visible-PII, scheduler-failure, APNs-regression,
# wearable-tenant-leak, rate-limit weakening, audit regressions,
# deploy-config drift, iOS navigation, and iOS decoder changes trigger
# their tests.
$HAS_LOGGER && CANNOT_SKIP+=("logger-redaction-pii-scan")
$HAS_SCHEDULER && CANNOT_SKIP+=("scheduler-tenant-scope-and-failure")
$HAS_NOTIFICATION && CANNOT_SKIP+=("notification-apns-delivery-and-tenant")
$HAS_HEALTH_INTEGRATION && CANNOT_SKIP+=("health-integration-tenant-isolation")
$HAS_RATE_LIMIT && CANNOT_SKIP+=("auth-rate-limit-and-lockout")
$HAS_AUDIT && CANNOT_SKIP+=("audit-trail-emission-and-scope")
$HAS_DEPLOY_CONFIG && CANNOT_SKIP+=("deploy-config-health-rehearsal")
$HAS_EVENT_BACKBONE && CANNOT_SKIP+=("event-backbone-jobs-sync-tenant-isolation")
$HAS_IOS_NAVIGATION && CANNOT_SKIP+=("ios-navigation-responsiveness")
$HAS_IOS_DTO && CANNOT_SKIP+=("ios-contract-decoder-resilience")
$HAS_IOS_NOTIFICATION && CANNOT_SKIP+=("ios-notification-decision-center")
$HAS_APPLE_NOTIFICATION_WEBHOOK && CANNOT_SKIP+=("apple-notifications-jws-verify")
$HAS_TRAINING_ENTITLEMENT && CANNOT_SKIP+=("training-routes-entitlement")
$HAS_CONTENT_PROMPT_CLEANLINESS && CANNOT_SKIP+=("content-engine-prompt-cleanliness")
$HAS_VOICE_EVOLUTION_MULTI_TENANT && CANNOT_SKIP+=("voice-evolution-multi-tenant")
$HAS_VIDEO_STUDY_PROMPT_CLEANLINESS && CANNOT_SKIP+=("video-study-prompt-cleanliness")
$HAS_CHANNEL_LEARNER_PROMPT_CLEANLINESS && CANNOT_SKIP+=("channel-learner-prompt-cleanliness")
$HAS_GLOBAL_COST_GUARDRAIL_REST && CANNOT_SKIP+=("cost-guardrail-global-rest")

# Tier 1 if anything non-doc is in scope
if $HAS_NON_DOC; then
  TIERS+=("T1")
fi

# Tier 2: app-facing flow surfaces
if $HAS_API_ROUTE || $HAS_PORTAL || $HAS_PYTHON_ENGINE || $HAS_IOS_UI || \
   $HAS_TRAINING || $HAS_COOKING || $HAS_CONTENT || $HAS_SECRETARY || \
   $HAS_EVENT_BACKBONE; then
  TIERS+=("T2")
fi

# Tier 3 only if test config changed broadly (signals shared-behavior risk)
$HAS_TEST_CONFIG && TIERS+=("T3-recommended")
$HAS_PACKAGE_JSON && TIERS+=("T3-recommended")

# Tier 4 (staging smoke) if backend src or migration in scope
if $HAS_BACKEND_SRC || $HAS_MIGRATION || $HAS_PYTHON_ENGINE || $HAS_DEPLOY_CONFIG; then
  TIERS+=("T4")
fi

# Tier 5 + 6 always for production deploys; the operator decides this, the
# classifier just notes them.
TIERS+=("T5-on-promote")
TIERS+=("T6-postdeploy")

# ── Vitest mode ────────────────────────────────────────
VITEST_MODE="skip"
VITEST_GLOBS=()
PYTEST_GLOBS=()

if $HAS_NON_DOC; then
  if $HAS_TEST_CONFIG || $HAS_PACKAGE_JSON; then
    VITEST_MODE="full"
  elif $HAS_BACKEND_SRC || $HAS_BACKEND_TEST || $HAS_DEPLOY_CONFIG; then
    VITEST_MODE="focused"
    $HAS_TRAINING && VITEST_GLOBS+=("__tests__/services/training-*.test.ts" "__tests__/services/coach-kernel-*.test.ts" "__tests__/api/training-*.test.ts")
    $HAS_TRAINING_ENTITLEMENT && VITEST_GLOBS+=("__tests__/security/training-routes-entitlement.test.ts")
    $HAS_CALENDAR && VITEST_GLOBS+=("__tests__/services/calendar*.test.ts" "__tests__/api/training-calendar-*.test.ts" "__tests__/api/training-plan-calendar-*.test.ts")
    $HAS_PROVIDER_ROUTING && VITEST_GLOBS+=("__tests__/services/provider-*.test.ts" "__tests__/services/ai-provider*.test.ts")
    $HAS_AUTH_OR_TENANT && VITEST_GLOBS+=("__tests__/security/**/*.test.ts" "__tests__/scope/**/*.test.ts" "__tests__/api/auth-*.test.ts" "__tests__/api/connections-tenant-*.test.ts" "__tests__/services/google-sign-in.test.ts" "__tests__/services/apple-sign-in-nonce.test.ts" "__tests__/services/oauth*.test.ts" "__tests__/portal/portal-oauth-routes.test.ts")
    $HAS_MEMORY_OR_RETRIEVAL && VITEST_GLOBS+=("__tests__/services/*context*.test.ts" "__tests__/services/*memory*.test.ts")
    $HAS_PROMPT && VITEST_GLOBS+=("__tests__/security/**/*.test.ts")
    $HAS_COOKING && VITEST_GLOBS+=("__tests__/services/*cooking*.test.ts" "__tests__/api/cooking-*.test.ts")
    $HAS_CONTENT && VITEST_GLOBS+=("__tests__/services/content-*.test.ts" "__tests__/api/content-*.test.ts")
    $HAS_FINANCE && VITEST_GLOBS+=("__tests__/services/finance-*.test.ts" "__tests__/services/invoice-*.test.ts")
    $HAS_SECRETARY && VITEST_GLOBS+=("__tests__/services/secretary-*.test.ts")
    $HAS_PORTAL && VITEST_GLOBS+=("__tests__/portal/**/*.test.ts")
    # Closed-beta hardening (2026-05-03):
    $HAS_ATTACHMENT && VITEST_GLOBS+=("__tests__/api/chat-attachments*.test.ts" "__tests__/api/chat-message-attachments*.test.ts" "__tests__/services/fiscal-bundle-attachments*.test.ts" "__tests__/security/**/*.test.ts")
    $HAS_MODEL_ROUTING && VITEST_GLOBS+=("__tests__/services/domain-provider-router*.test.ts" "__tests__/services/model-routing-*.test.ts")
    $HAS_PERSONALIZATION_SCOPE && VITEST_GLOBS+=("__tests__/services/cooking-preferences*.test.ts" "__tests__/services/finance-preferences*.test.ts" "__tests__/services/skill-memory*.test.ts" "__tests__/services/content-references*.test.ts" "__tests__/security/**/*.test.ts")
    $HAS_CONTENT_AGENT && VITEST_GLOBS+=("__tests__/security/content-agent-neutrality.test.ts" "__tests__/services/cross-agent-learning*.test.ts" "__tests__/portal/domain-status.test.ts")
    # Engineering-excellence hardening (2026-05-04): wire new flags.
    $HAS_LOGGER && VITEST_GLOBS+=("__tests__/utils/logger-*.test.ts" "__tests__/api/secret-guards.test.ts")
    $HAS_SCHEDULER && VITEST_GLOBS+=("__tests__/services/scheduler-*.test.ts")
    $HAS_NOTIFICATION && VITEST_GLOBS+=("__tests__/services/apns-*.test.ts" "__tests__/services/notification-*.test.ts" "__tests__/services/content-notifications*.test.ts" "__tests__/api/notifications-*.test.ts" "__tests__/api/content-notification-*.test.ts" "__tests__/security/notification-*.test.ts" "__tests__/security/p0-chat-identity-isolation.test.ts")
    $HAS_HEALTH_INTEGRATION && VITEST_GLOBS+=("__tests__/services/garmin-*.test.ts" "__tests__/services/apple-health-*.test.ts" "__tests__/services/integration-health-*.test.ts" "__tests__/api/wearable-*.test.ts" "__tests__/api/health-data-*.test.ts" "__tests__/api/garmin-auth-*.test.ts" "__tests__/portal/integration-health-*.test.ts")
    $HAS_RATE_LIMIT && VITEST_GLOBS+=("__tests__/api/rate-limiter.test.ts" "__tests__/security/**/*.test.ts")
    $HAS_AUDIT && VITEST_GLOBS+=("__tests__/services/audit-trail.test.ts" "__tests__/api/authenticated-support-routes-scope.test.ts" "__tests__/portal/portal-admin-audit.test.ts" "__tests__/portal/portal-admin-data-routes.test.ts" "__tests__/portal/portal-admin-data-isolation.integration.test.ts")
    $HAS_DEPLOY_CONFIG && VITEST_GLOBS+=("__tests__/services/config-*.test.ts" "__tests__/portal/health-endpoint*.test.ts" "__tests__/portal/health-endpoints.test.ts" "__tests__/scripts/*.test.ts" "__tests__/security/**/*.test.ts")
    $HAS_EVENT_BACKBONE && VITEST_GLOBS+=("__tests__/services/event-backbone.test.ts" "__tests__/api/event-backbone-routes.test.ts" "__tests__/security/**/*.test.ts")
    $HAS_CHAT_REASONING && VITEST_GLOBS+=("__tests__/services/chat-reasoning-engine.test.ts" "__tests__/api/chat-routes.test.ts" "__tests__/security/p0-chat-identity-isolation.test.ts")
    $HAS_APPLE_NOTIFICATION_WEBHOOK && VITEST_GLOBS+=("__tests__/security/billing-apple-notifications-jws-verify.test.ts")
    $HAS_TRAINING_ENTITLEMENT && VITEST_GLOBS+=("__tests__/security/training-routes-entitlement.test.ts")
    $HAS_VOICE_EVOLUTION_MULTI_TENANT && VITEST_GLOBS+=("__tests__/agents/voice-evolution-multi-tenant.test.ts")
    $HAS_VIDEO_STUDY_PROMPT_CLEANLINESS && VITEST_GLOBS+=("__tests__/services/video-study-prompt-cleanliness.test.ts")
    $HAS_CHANNEL_LEARNER_PROMPT_CLEANLINESS && VITEST_GLOBS+=("__tests__/services/channel-learner-prompt-cleanliness.test.ts")
    $HAS_GLOBAL_COST_GUARDRAIL_REST && VITEST_GLOBS+=("__tests__/security/cost-guardrail-global-rest.test.ts")
    $HAS_CONTENT_PROMPT_CLEANLINESS && PYTEST_GLOBS+=("content-engine/tests/test_prompt_cleanliness.py")
    if [ "${#VITEST_GLOBS[@]}" -eq 0 ]; then
      # Backend src/test changed but no domain mapped — fall back to changed-files-only
      VITEST_MODE="changed-only"
    fi
  fi
fi

# Engineering-excellence enrichment (2026-05-04, ENG-EXC-O3): when only
# prompts/*.md changed, the diff is treated as docs-only and the entire
# vitest block above is skipped — even though `prompt-injection-defense`
# is named as a cannot-skip gate. The cannot-skip-gate-dashboard caught
# this. Patch: if HAS_PROMPT fired, force the security suite to run.
if $HAS_PROMPT && [ "$VITEST_MODE" = "skip" ]; then
  VITEST_MODE="focused"
  VITEST_GLOBS+=("__tests__/security/**/*.test.ts" "__tests__/services/prompt-cleanliness.test.ts")
  SKIP_REASON=""
fi

if $HAS_CONTENT_PROMPT_CLEANLINESS; then
  PYTEST_GLOBS+=("content-engine/tests/test_prompt_cleanliness.py")
fi

SKIP_REASON=""
if [ "$VITEST_MODE" = "skip" ]; then
  if $HAS_DOCS_ONLY; then
    SKIP_REASON="docs-only diff; no source/test/config/hook/migration/deploy file in scope"
  else
    SKIP_REASON="no Vitest-relevant files in scope"
  fi
fi

# ── XCTest mode ────────────────────────────────────────
XCTEST_MODE="skip"
XCTEST_CLASSES=()
if $HAS_IOS_SRC; then
  XCTEST_MODE="focused"
  $HAS_IOS_UI && XCTEST_CLASSES+=("Nexus HubUITests/*")
  $HAS_IOS_AUTH && XCTEST_CLASSES+=("Nexus HubTests/AppleSignInNonceTests" "Nexus HubTests/KeychainHelperTests" "Nexus HubTests/AuthManagerFixtureLeakTests" "Nexus HubTests/AuthManagerPersistenceTests" "Nexus HubTests/AuthUserPresentationTests" "Nexus HubTests/GoogleAuthCallbackResolverTests")
  $HAS_IOS_NAVIGATION && XCTEST_CLASSES+=("Nexus HubTests/NavigationPerformanceSourcePinsTests" "Nexus HubTests/MainTabViewBadgeMemoizationTests" "Nexus HubUITests/AppWideResponsivenessUITests" "Nexus HubUITests/HomeWeekNavigationPerformanceUITests")
  $HAS_IOS_DTO && XCTEST_CLASSES+=("Nexus HubTests/ContractDecoderResilienceTests" "Nexus HubTests/HomeViewStateContractDecodingTests" "Nexus HubTests/TrainingHomeViewStateContractDecodingTests" "Nexus HubTests/ContentHomeContractDecodingTests")
  $HAS_IOS_NOTIFICATION && XCTEST_CLASSES+=("Nexus HubTests/NotificationManagerTests" "Nexus HubTests/DeepLinkRouterTests" "Nexus HubTests/NotificationDecisionCenterTests" "Nexus HubUITests/NotificationDecisionCenterUITests")
  XCTEST_CLASSES+=("Nexus HubTests/ContractDecoderResilienceTests")
  XCTEST_CLASSES+=("Nexus HubTests/AuthManagerPersistenceTests")
fi

# ── Staging smoke ──────────────────────────────────────
SS_GENERIC=false
SS_DOMAINS=()
if $HAS_BACKEND_SRC || $HAS_MIGRATION || $HAS_PYTHON_ENGINE || $HAS_DEPLOY_CONFIG; then
  SS_GENERIC=true
fi
$HAS_TRAINING && { $HAS_CALENDAR || true; } && SS_DOMAINS+=("smoke:training-cross-skill:staging")
$HAS_CALENDAR && SS_DOMAINS+=("smoke:training-calendar:staging")
$HAS_COOKING && SS_DOMAINS+=("smoke:cooking:portal")
$HAS_CONTENT && SS_DOMAINS+=("smoke:content:local")

# Sort + dedupe arrays. set -u + zero-arg arrays would otherwise blow up.
dedupe() {
  if [ "$#" -eq 0 ]; then
    return 0
  fi
  printf '%s\n' "$@" | awk 'NF && !seen[$0]++'
}

VITEST_GLOBS_DEDUP="$(dedupe ${VITEST_GLOBS[@]+"${VITEST_GLOBS[@]}"})"
PYTEST_GLOBS_DEDUP="$(dedupe ${PYTEST_GLOBS[@]+"${PYTEST_GLOBS[@]}"})"
XCTEST_CLASSES_DEDUP="$(dedupe ${XCTEST_CLASSES[@]+"${XCTEST_CLASSES[@]}"})"
SS_DOMAINS_DEDUP="$(dedupe ${SS_DOMAINS[@]+"${SS_DOMAINS[@]}"})"
TIERS_DEDUP="$(dedupe "${TIERS[@]}")"
CANNOT_SKIP_DEDUP="$(dedupe ${CANNOT_SKIP[@]+"${CANNOT_SKIP[@]}"})"

emit_json() {
  # Build properly-quoted JSON via node so we don't have to manually escape
  # bash variables. Each shell variable is exported and read via process.env.
  export CLAS_TIERS="$TIERS_DEDUP"
  export CLAS_VGLOBS="$VITEST_GLOBS_DEDUP"
  export CLAS_PYGLOBS="$PYTEST_GLOBS_DEDUP"
  export CLAS_XCTEST="$XCTEST_CLASSES_DEDUP"
  export CLAS_SS_DOMAINS="$SS_DOMAINS_DEDUP"
  export CLAS_CANNOT_SKIP="$CANNOT_SKIP_DEDUP"
  export CLAS_CHANGED="$CHANGED"
  export CLAS_BASE="$resolved_base"
  export CLAS_HEAD="$head_sha"
  export CLAS_COUNT="$CHANGED_COUNT"
  export CLAS_VMODE="$VITEST_MODE"
  export CLAS_XMODE="$XCTEST_MODE"
  export CLAS_SKIP_REASON="$SKIP_REASON"
  export CLAS_GENERATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  export CLAS_SS_GENERIC="$SS_GENERIC"
  export CLAS_DOCS_ONLY="$HAS_DOCS_ONLY"
  export CLAS_BACKEND_SRC="$HAS_BACKEND_SRC"
  export CLAS_BACKEND_TEST="$HAS_BACKEND_TEST"
  export CLAS_API_ROUTE="$HAS_API_ROUTE"
  export CLAS_TRAINING="$HAS_TRAINING"
  export CLAS_COACH_KERNEL="$HAS_COACH_KERNEL"
  export CLAS_CALENDAR="$HAS_CALENDAR"
  export CLAS_PROVIDER="$HAS_PROVIDER_ROUTING"
  export CLAS_AUTH="$HAS_AUTH_OR_TENANT"
  export CLAS_MEMORY="$HAS_MEMORY_OR_RETRIEVAL"
  export CLAS_PROMPT="$HAS_PROMPT"
  export CLAS_COOKING="$HAS_COOKING"
  export CLAS_CONTENT="$HAS_CONTENT"
  export CLAS_FINANCE="$HAS_FINANCE"
  export CLAS_SECRETARY="$HAS_SECRETARY"
  export CLAS_PORTAL="$HAS_PORTAL"
  export CLAS_MIGRATION="$HAS_MIGRATION"
  export CLAS_PY_ENGINE="$HAS_PYTHON_ENGINE"
  export CLAS_IOS_SRC="$HAS_IOS_SRC"
  export CLAS_IOS_AUTH="$HAS_IOS_AUTH"
  export CLAS_IOS_TEST="$HAS_IOS_TEST"
  export CLAS_IOS_UI="$HAS_IOS_UI"
  export CLAS_DEPLOY_SCRIPT="$HAS_DEPLOY_SCRIPT"
  export CLAS_HOOK="$HAS_HOOK"
  export CLAS_CI_WORKFLOW="$HAS_CI_WORKFLOW"
  export CLAS_TEST_CONFIG="$HAS_TEST_CONFIG"
  export CLAS_PACKAGE_JSON="$HAS_PACKAGE_JSON"
  export CLAS_CURRENT_VERDICT_DOC="$HAS_CURRENT_VERDICT_DOC"
  export CLAS_ATTACHMENT="$HAS_ATTACHMENT"
  export CLAS_CHAT_REASONING="$HAS_CHAT_REASONING"
  export CLAS_MODEL_ROUTING="$HAS_MODEL_ROUTING"
  export CLAS_PERSONALIZATION_SCOPE="$HAS_PERSONALIZATION_SCOPE"
  export CLAS_CONTENT_AGENT="$HAS_CONTENT_AGENT"
  export CLAS_LOGGER="$HAS_LOGGER"
  export CLAS_SCHEDULER="$HAS_SCHEDULER"
  export CLAS_NOTIFICATION="$HAS_NOTIFICATION"
  export CLAS_EVENT_BACKBONE="$HAS_EVENT_BACKBONE"
  export CLAS_HEALTH_INTEGRATION="$HAS_HEALTH_INTEGRATION"
  export CLAS_RATE_LIMIT="$HAS_RATE_LIMIT"
  export CLAS_AUDIT="$HAS_AUDIT"
  export CLAS_DEPLOY_CONFIG="$HAS_DEPLOY_CONFIG"
  export CLAS_IOS_NAVIGATION="$HAS_IOS_NAVIGATION"
  export CLAS_IOS_DTO="$HAS_IOS_DTO"
  export CLAS_APPLE_NOTIFICATION_WEBHOOK="$HAS_APPLE_NOTIFICATION_WEBHOOK"
  export CLAS_TRAINING_ENTITLEMENT="$HAS_TRAINING_ENTITLEMENT"
  export CLAS_CONTENT_PROMPT_CLEANLINESS="$HAS_CONTENT_PROMPT_CLEANLINESS"

  node <<'JS'
function lines(name) {
  const v = process.env[name] || '';
  return v.split('\n').map((l) => l.trim()).filter(Boolean);
}
function flag(name) {
  return process.env[name] === 'true';
}

const payload = {
  version: '1',
  generatedAt: process.env.CLAS_GENERATED_AT,
  baseRef: process.env.CLAS_BASE,
  head: process.env.CLAS_HEAD,
  changedFileCount: Number(process.env.CLAS_COUNT || 0),
  changedFiles: lines('CLAS_CHANGED'),
  tiers: lines('CLAS_TIERS'),
  vitest: {
    mode: process.env.CLAS_VMODE,
    globs: lines('CLAS_VGLOBS'),
    skipReason: process.env.CLAS_SKIP_REASON || null,
  },
  pytest: {
    globs: lines('CLAS_PYGLOBS'),
  },
  xctest: {
    mode: process.env.CLAS_XMODE,
    classes: lines('CLAS_XCTEST'),
  },
  stagingSmoke: {
    generic: flag('CLAS_SS_GENERIC'),
    domains: lines('CLAS_SS_DOMAINS'),
  },
  cannotSkip: lines('CLAS_CANNOT_SKIP'),
  flags: {
    docsOnly: flag('CLAS_DOCS_ONLY'),
    backendSrc: flag('CLAS_BACKEND_SRC'),
    backendTest: flag('CLAS_BACKEND_TEST'),
    apiRoute: flag('CLAS_API_ROUTE'),
    training: flag('CLAS_TRAINING'),
    coachKernel: flag('CLAS_COACH_KERNEL'),
    calendar: flag('CLAS_CALENDAR'),
    providerRouting: flag('CLAS_PROVIDER'),
    authOrTenant: flag('CLAS_AUTH'),
    memoryOrRetrieval: flag('CLAS_MEMORY'),
    prompt: flag('CLAS_PROMPT'),
    cooking: flag('CLAS_COOKING'),
    content: flag('CLAS_CONTENT'),
    finance: flag('CLAS_FINANCE'),
    secretary: flag('CLAS_SECRETARY'),
    portal: flag('CLAS_PORTAL'),
    migration: flag('CLAS_MIGRATION'),
    pythonEngine: flag('CLAS_PY_ENGINE'),
    iosSrc: flag('CLAS_IOS_SRC'),
    iosAuth: flag('CLAS_IOS_AUTH'),
    iosTest: flag('CLAS_IOS_TEST'),
    iosUi: flag('CLAS_IOS_UI'),
    deployScript: flag('CLAS_DEPLOY_SCRIPT'),
    hook: flag('CLAS_HOOK'),
    ciWorkflow: flag('CLAS_CI_WORKFLOW'),
    testConfig: flag('CLAS_TEST_CONFIG'),
    packageJson: flag('CLAS_PACKAGE_JSON'),
    currentVerdictDoc: flag('CLAS_CURRENT_VERDICT_DOC'),
    attachment: flag('CLAS_ATTACHMENT'),
    chatReasoning: flag('CLAS_CHAT_REASONING'),
    modelRouting: flag('CLAS_MODEL_ROUTING'),
    personalizationScope: flag('CLAS_PERSONALIZATION_SCOPE'),
    contentAgent: flag('CLAS_CONTENT_AGENT'),
    logger: flag('CLAS_LOGGER'),
    scheduler: flag('CLAS_SCHEDULER'),
    notification: flag('CLAS_NOTIFICATION'),
    eventBackbone: flag('CLAS_EVENT_BACKBONE'),
    healthIntegration: flag('CLAS_HEALTH_INTEGRATION'),
    rateLimit: flag('CLAS_RATE_LIMIT'),
    audit: flag('CLAS_AUDIT'),
    deployConfig: flag('CLAS_DEPLOY_CONFIG'),
    iosNavigation: flag('CLAS_IOS_NAVIGATION'),
    iosDto: flag('CLAS_IOS_DTO'),
    appleNotificationWebhook: flag('CLAS_APPLE_NOTIFICATION_WEBHOOK'),
    trainingEntitlement: flag('CLAS_TRAINING_ENTITLEMENT'),
    contentPromptCleanliness: flag('CLAS_CONTENT_PROMPT_CLEANLINESS'),
  },
};
console.log(JSON.stringify(payload, null, 2));
JS
}

emit_markdown() {
  echo "# Changed-area classifier"
  echo
  echo "- Base: \`$resolved_base\`"
  echo "- Head: \`$head_sha\`"
  echo "- Changed files: $CHANGED_COUNT"
  echo "- Generated at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo
  echo "## Recommended tiers"
  while IFS= read -r t; do [ -n "$t" ] && echo "- $t"; done <<<"$TIERS_DEDUP"
  echo
  echo "## Vitest"
  echo "- mode: \`$VITEST_MODE\`"
  if [ "$VITEST_MODE" = "skip" ]; then
    echo "- reason: $SKIP_REASON"
  elif [ "$VITEST_MODE" = "changed-only" ]; then
    echo "- recommendation: \`npx vitest run --changed $resolved_base\`"
  elif [ "$VITEST_MODE" = "focused" ]; then
    echo "- focused globs:"
    while IFS= read -r g; do [ -n "$g" ] && echo "  - \`$g\`"; done <<<"$VITEST_GLOBS_DEDUP"
  else
    echo "- run: \`npx vitest run\` (full)"
  fi
  echo
  echo "## Pytest"
  if [ -n "$PYTEST_GLOBS_DEDUP" ]; then
    while IFS= read -r g; do [ -n "$g" ] && echo "- \`$g\`"; done <<<"$PYTEST_GLOBS_DEDUP"
  else
    echo "- (none)"
  fi
  echo
  echo "## XCTest"
  echo "- mode: \`$XCTEST_MODE\`"
  if [ "$XCTEST_MODE" = "focused" ]; then
    while IFS= read -r c; do [ -n "$c" ] && echo "- \`$c\`"; done <<<"$XCTEST_CLASSES_DEDUP"
  fi
  echo
  echo "## Staging smoke"
  echo "- generic 17-check: \`$SS_GENERIC\`"
  if [ -n "$SS_DOMAINS_DEDUP" ]; then
    echo "- domain smokes:"
    while IFS= read -r d; do [ -n "$d" ] && echo "  - \`npm run $d\`"; done <<<"$SS_DOMAINS_DEDUP"
  else
    echo "- domain smokes: none required"
  fi
  echo
  echo "## Cannot-skip safety gates"
  if [ -n "$CANNOT_SKIP_DEDUP" ]; then
    while IFS= read -r c; do [ -n "$c" ] && echo "- $c"; done <<<"$CANNOT_SKIP_DEDUP"
  else
    echo "- (none triggered by this diff)"
  fi
  echo
  echo "## Changed files"
  if [ -z "$CHANGED" ]; then
    echo "(none — clean tree)"
  else
    while IFS= read -r f; do [ -n "$f" ] && echo "- \`$f\`"; done <<<"$CHANGED"
  fi
}

case "$FORMAT" in
  json|--json) emit_json ;;
  markdown|--markdown|md) emit_markdown ;;
  *) echo "Unknown format: $FORMAT" >&2; exit 64;;
esac
