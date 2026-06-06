# Claude Code QA Prompt — Nexus Security Hardening

You are Claude Code. Perform hostile QA on the Nexus Hub security hardening
wave. Do not rubber-stamp. Verify every claim at source and test level.

## Original Goal

Upgrade Nexus Hub security across backend, iOS, content engine, providers,
infrastructure, CI, observability, backups, and incident response using OWASP
ASVS/API Top 10/MASVS, NIST 800-63B/CSF, CIS, OAuth BCP, Cloudflare, Stripe,
provider-specific, Node/Express, SQLite, FastAPI, iOS, logging, and supply-chain
guidance.

## What Was Implemented

- Canonical security threat model, control matrix, operations runbook, and
  implementation-status ledger under `docs/security/`.
- `/api/v1` route-boundary source pin requiring scoped routes to mount after
  `authMiddleware` and entitlement gates where relevant.
- REST Chat, WebSocket, and Telegram tier/access-check errors now fail closed
  with `ACCESS_CHECK_UNAVAILABLE` instead of falling through.
- WebSocket upgrades reject untrusted browser `Origin` headers while preserving
  native iOS clients that omit `Origin`, and each connection has a rolling
  message-rate budget.
- SSRF guard for external URLs plus stricter YouTube transcript host parsing.
- Follow-up fix for hostile QA P0: bracketed IPv6 hostnames are normalized
  before IP classification, and the guard now blocks IPv6 loopback, ULA,
  link-local, unspecified, and IPv4-mapped IPv6 SSRF vectors.
- Expanded Pino and Sentry redaction for emails, calendar text, health, finance,
  provider errors, prompts, raw tool/model output, and camelCase sensitive keys.
- Follow-up fixes for hostile QA P2/P3: `calendarText` Pino redaction is pinned,
  route-boundary tests now use quote/spacing-tolerant mount regexes, and the
  Scorecard job no longer requests `id-token: write`.
- Security CI workflow for CodeQL, npm audit, pip-audit, and OpenSSF Scorecard;
  Dependabot config for npm, pip, and GitHub Actions.
- Python content-engine dependency upgrade to remove pip-audit findings.
- iOS MASVS source pins for Keychain accessibility/no-iCloud sync and
  ATS/cleartext/WebView bypass prevention.
- Completion ledger mapping every original plan phase to DONE or
  BLOCKED_WITH_EXACT_REASON, plus explicit public-interface/contract and
  test-plan coverage tables.

## Files Changed

Backend:
- `.github/workflows/security.yml`
- `.github/dependabot.yml`
- `content-engine/requirements.txt`
- `scripts/audit-docs.mjs`
- `src/api/routes/chat-message-tier-gate.ts`
- `src/api/websocket.ts`
- `src/handlers/message.ts`
- `src/security/url-guard.ts`
- `src/services/youtube-transcript.ts`
- `src/utils/log-sanitizer.ts`
- `src/utils/logger.ts`
- `__tests__/api/chat-message-tier-gate.test.ts`
- `__tests__/api/websocket-security.test.ts`
- `__tests__/security/api-router-auth-boundary.test.ts`
- `__tests__/security/security-baseline-source-pins.test.ts`
- `__tests__/security/url-guard.test.ts`
- `__tests__/services/error-tracker.test.ts`
- `__tests__/utils/log-sanitizer.test.ts`
- `docs/DOCS_INDEX.md`
- `docs/engineering/ENGINEERING_STANDARDS_INDEX.md`
- `docs/security/nexus-security-threat-model.md`
- `docs/security/security-control-matrix.md`
- `docs/security/security-operations-runbook.md`
- `docs/security/security-hardening-implementation-status.md`
- `docs/security/security-hardening-claude-qa-prompt.md`

iOS:
- `Nexus HubTests/KeychainHelperTests.swift`
- `Nexus HubTests/ReleaseHardeningConfigTests.swift`

## Expected Behavior

- Scoped `/api/v1` user routes remain behind auth and request context.
- Chat/WS/Telegram cannot proceed if access/tier verification is unavailable.
- WebSocket browser upgrades from hostile origins are rejected, native iOS
  no-Origin clients still connect, and message floods are rate-limited before
  JSON parsing or domain routing.
- URL consumers cannot fetch localhost/private/metadata/credentialed/non-HTTPS
  URLs, and YouTube parsing cannot accept spoofed hosts like
  `evil-youtube.com`.
- Logs and Sentry must not expose tokens, emails, calendar text, health,
  finance, provider errors, prompts, raw model/tool output, or sensitive
  camelCase keys.
- Security CI should use least-privilege permissions and include CodeQL,
  npm audit, pip-audit, Scorecard, and Dependabot coverage.
- iOS Keychain should remain this-device-only/no iCloud sync; cleartext/ATS
  exceptions and legacy WebView bypasses should stay blocked.

## Tests Already Performed

- Backend focused security sweep passed:
  `npx vitest run __tests__/api/chat-message-tier-gate.test.ts __tests__/api/websocket-security.test.ts __tests__/security/api-router-auth-boundary.test.ts __tests__/security/url-guard.test.ts __tests__/security/security-baseline-source-pins.test.ts __tests__/utils/log-sanitizer.test.ts __tests__/services/error-tracker.test.ts __tests__/utils/logger-redaction.test.ts __tests__/services/webhook-registry.test.ts __tests__/services/webhook-registry-qa-validation.test.ts __tests__/api/billing-routes.test.ts --reporter=default`
- SSRF hostile probe passed via `npx tsx` one-off: bracketed IPv6 loopback/ULA/
  link-local, IPv4-mapped IPv6, decimal/octal/hex IPv4, metadata, credentialed,
  non-HTTPS, file, and YouTube host-spoofing URLs all blocked.
- `npm run typecheck`: PASS.
- `npm audit --audit-level=high`: 0 vulnerabilities.
- `pip-audit -r content-engine/requirements.txt`: no known vulnerabilities.
- Python content engine tests passed on Python 3.13.
- Auth/OAuth/APNs-routing focused checks passed:
  `npx vitest run __tests__/services/oauth-state-store.test.ts __tests__/api/auth-routes.test.ts __tests__/security/notification-orchestrator-security.test.ts __tests__/security/billing-apple-notifications-jws-verify.test.ts --reporter=default`
- iOS new security pins passed, result bundle
  `/tmp/nexus-security-ios-new-pins.xcresult`.
- iOS `DeepLinkRouterTests` passed, result bundle
  `/tmp/nexus-security-ios-deeplink.xcresult`.
- `npm run docs:audit`: exit 0 with existing warning baseline.

## Inspect Carefully

- Ensure fail-closed changes do not leak raw internal errors to clients.
- Verify `docs/security/security-hardening-implementation-status.md` covers
  every original phase, public-interface/contract item, and test-plan bullet as
  DONE / DONE_WITH_EXISTING_CONTRACTS / DONE_WITH_EXISTING_COVERAGE or
  BLOCKED_WITH_EXACT_REASON.
- Re-attack the SSRF guard with IPv6, decimal/octal IPv4, embedded credentials,
  redirect assumptions, YouTube host spoofing, trailing dot hosts, and
  allowlist suffix mistakes. The prior P0 was bracketed IPv6 hostnames bypassing
  `net.isIP`; verify that path is closed, not merely tested at a higher layer.
- Verify log/Sentry redaction does not over-redact required operational fields
  like `tenantId`, `userId`, retry counters, trace IDs, or safe status labels.
- Verify route-boundary source pin is meaningful and not brittle to harmless
  formatting.
- Check whether CodeQL/Scorecard permissions are truly least privilege.
- Verify FastAPI dependency upgrade remains compatible with content-engine
  runtime, not only tests.
- Confirm iOS tests were added without touching unrelated scheme/project drift.
- Check the completion ledger: every unfinished plan item should have an exact
  blocker reason, not vague deferred language.
- Challenge the `Original Plan Phase Coverage` matrix and verify each row is
  backed by source/test evidence or a real ops/product blocker.
- Challenge `Public Interface / Contract Coverage` and `Test Plan Coverage`:
  confirm the local pass did not hide global metadata, user-facing security
  settings, mass-assignment migration, APNs payload proof, or live manual-hostile
  drills without exact blockers.

## Edge Cases To Verify

- Tier gate throws in REST Chat, WS, and Telegram.
- WebSocket access-check failure after authentication but before handling a
  message.
- WebSocket `Origin: null`, invalid Origin, hostile suffix hosts, and excessive
  per-connection message frames.
- Sentry event with nested camelCase keys like `calendarText`, `bodyBattery`,
  `providerError`, and `eventTitle`.
- User-supplied URLs:
  `http://`, `file://`, `https://127.0.0.1`, `https://169.254.169.254`,
  `https://localhost`, `https://user:pass@example.com`, `https://youtube.com.evil.test`.
- Apple billing notification malformed/forged JWS still returns safe Apple-compatible response.
- Python dependency audit remains clean in CI.
- iOS full release-hardening class still has a known pre-existing scheme drift
  failure; do not count that as a regression in this wave unless the touched
  files caused it.

## Known Risks Or Assumptions

- Production Cloudflare/VPS/firewall/backup/secret-rotation/passkey/SQLCipher
  work is intentionally not executed in this local pass; see
  `docs/security/security-hardening-implementation-status.md` for exact
  BLOCKED_WITH_EXACT_REASON entries.
- Existing engine docs audit warnings remain baseline warnings.
- Existing iOS `.xcscheme` and project drift were preserved.
- No production data, provider writes, APNs, TestFlight, push, or deploy were
  used.

Return one of GO / GO_WITH_CONDITIONS / NO_GO. Include file:line evidence,
test commands/results, any new findings by severity, and exact cleanup state.
