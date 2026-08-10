# Nexus Security Hardening Implementation Status

Status: current
Owner: Felipe Dominguez
Last verified: 2026-08-10
Update policy: update after each security-hardening wave, production ops window,
or QA finding closure.

## Local Readiness

Local code is ready for independent hostile QA, with live-ops conditions listed
below.

The local code/testable portion of the security plan is implemented. Live
infrastructure and account/authenticator changes remain blocked until an
approved production operations window because this pass was explicitly
non-production-mutating.

Completion rule: every item from the implementation plan is either represented
in `Completed In This Wave` below or explicitly listed as
`BLOCKED_WITH_EXACT_REASON` or `ACCEPTED_RESIDUAL_RISK`.
There are no intentionally hidden open tasks in this local pass.

## Completed In This Wave

| Plan area | Status | Evidence |
|---|---|---|
| Security baseline and threat model | DONE | `docs/security/nexus-security-threat-model.md`, `docs/security/security-control-matrix.md`, `__tests__/security/security-baseline-source-pins.test.ts` |
| `/api/v1` auth boundary inventory | DONE | `__tests__/security/api-router-auth-boundary.test.ts` pins scoped route families after `authMiddleware` and entitlement gates. |
| Chat/WebSocket/Telegram access-check failure behavior | DONE | Fail-closed `ACCESS_CHECK_UNAVAILABLE` in REST chat, WebSocket, and Telegram handler paths. |
| WebSocket origin and message-rate boundary | DONE | `/ws` rejects untrusted browser `Origin` headers, preserves native iOS no-Origin clients, and enforces a rolling per-connection message budget. |
| SSRF URL guard | DONE | `src/security/url-guard.ts` blocks localhost/private/metadata/credentialed/non-HTTPS URLs, including bracketed IPv6 loopback/ULA/link-local and IPv4-mapped IPv6; YouTube transcript parsing rejects spoofed hosts. |
| Logging and Sentry privacy redaction | DONE | `src/utils/log-sanitizer.ts`, `src/utils/logger.ts`, and Sentry/logger tests cover tokens, emails, calendar text, health, finance, provider errors, prompts, and raw outputs while preserving safe operational IDs. |
| Auth/session/OAuth/deep-link regression coverage | DONE | Existing refresh/session replay, invite/login, OAuth nonce/state, Apple nonce/JWS, and iOS `DeepLinkRouterTests` were re-run. |
| Provider webhook security regression | DONE | Existing webhook/billing sweeps re-run: HMAC signature, provider-specific headers, replay/idempotency, Apple JWS rejection paths. |
| iOS MASVS source pins | DONE | Keychain this-device-only/no-iCloud sync and ATS/cleartext/WebView bypass tests added. |
| CI/supply-chain guardrails | DONE | `.github/workflows/security.yml` adds CodeQL, npm audit, pip-audit, OpenSSF Scorecard with least-privilege job permissions; `.github/dependabot.yml` covers npm, pip, GitHub Actions. |
| Python content-engine dependency audit | DONE | The reviewed direct source generates `content-engine/requirements-release.txt`; CI byte-compares that complete hash lock and `pip-audit` reports no known vulnerabilities in its exact deployed closure. |
| Incident response and privacy ops runbook | DONE | `docs/security/security-operations-runbook.md` covers account takeover, provider leak, cross-tenant exposure, webhook abuse, lost JWT/signing key, compromised VPS, production secret leak, restore drill, and breach checklist. |
| Local encrypted recovery | DONE_IN_REPOSITORY | Root-owned tooling creates `age`-encrypted, checksum-bound SQLite recovery points with 24 hourly, 30 daily, four weekly, and pre-promotion retention; weekly verification restores only to a private scratch path. The Sonar PostgreSQL dump retention referenced here is retired with SonarQube (2026-08-07). No AWS or off-host service is required. |

## Claude QA Follow-Up Closure

| Finding | Status | Closure |
|---|---|---|
| P0 IPv6 SSRF bypass | CLOSED | `normalizeHostname` strips IPv6 brackets before `net.isIP`, private IPv6 detection now catches loopback, ULA, link-local, unspecified, and IPv4-mapped IPv6. `__tests__/security/url-guard.test.ts` includes the hostile IPv6 corpus from QA. |
| P2 `calendarText` Pino redaction gap | CLOSED | `LOGGER_REDACTION_PATHS` now includes `calendarText` and `body.calendarText`; `logger-redaction.test.ts` pins both sensitive calendar text redaction and safe operational field preservation. |
| P2 brittle route-boundary source pin | CLOSED | `api-router-auth-boundary.test.ts` now uses whitespace/quote-tolerant regex mount detection instead of exact string contains for route mounts. |
| P3 Scorecard OIDC permission | CLOSED | `.github/workflows/security.yml` removed `id-token: write`; `security-baseline-source-pins.test.ts` pins its absence. |

## Blocked Or Accepted With Exact Reason

| Item | Status | Exact reason |
|---|---|---|
| Cloudflare firewall/origin lock-down, WAF, staging Access | BLOCKED_WITH_EXACT_REASON | Requires live Cloudflare/VPS changes and production/staging connectivity validation. The plan forbids production mutation without separate approval. |
| VPS UFW/fail2ban/SSH/systemd/PM2 permission changes | BLOCKED_WITH_EXACT_REASON | Requires a production operations window with rollback access. Local repo changes cannot prove host firewall or service-user state. |
| Off-host backup durability | ACCEPTED_RESIDUAL_RISK | Backups are encrypted but remain on the same ServerDominguez disk. They protect bad-release, operator-error, and corruption recovery, not total NVMe/server loss. A USB SSD, NAS, or another non-AWS host is deliberately deferred for the current project size; no AWS service is a backup or release dependency. |
| Secret rotation for JWT/provider/Stripe/Cloudflare/Resend/Telegram/model keys | BLOCKED_WITH_EXACT_REASON | Requires production secret inventory, provider dashboards, coordinated deploy, and user/provider reauth impact review. |
| Route-by-route mass-assignment allowlist migration | BLOCKED_WITH_EXACT_REASON | Requires a route-contract migration across every mutation surface, compatibility review for existing iOS clients, and route-owner fixtures. This wave added the auth-boundary gate and existing high-risk sweeps, but a safe full allowlist migration must be its own API-contract wave. |
| Step-up auth for destructive/sensitive actions | BLOCKED_WITH_EXACT_REASON | Requires product policy, auth-assurance metadata, UI prompts, and device testing for account deletion, provider unlink, export, payment changes, and admin operations. Implementing it locally without the UX/API contract would risk locking out legitimate owner/admin flows. |
| Passkeys/WebAuthn owner/admin rollout | BLOCKED_WITH_EXACT_REASON | Requires product/auth design, database/schema/API/UI rollout, and device testing. This wave documented the target but did not create a parallel auth stack. |
| SQLCipher or production DB-at-rest migration | BLOCKED_WITH_EXACT_REASON | Requires data migration design, backup compatibility testing, performance validation, and deployment sequencing. |
| Real APNs payload privacy smoke | BLOCKED_WITH_EXACT_REASON | Requires TestFlight/device APNs token and approved safe delivery proof; simulator cannot prove production APNs payload behavior. |
| Full iOS release-hardening suite | BLOCKED_WITH_EXACT_REASON | Existing dirty `.xcscheme` drift causes `test_sharedSchemeDoesNotAllowParallelUITestSimulatorFanout` to fail. This wave preserved unrelated scheme drift as instructed; the new security pins pass independently. |

## Original Plan Phase Coverage

| Original plan phase | Coverage |
|---|---|
| 1. Security baseline and control matrix | DONE: threat model, control matrix, severity classes, docs indexes, and source-pin tests are in place. |
| 2. Backend/API authorization inventory | DONE: scoped `/api/v1` route families are pinned behind auth middleware and entitlement gates. Exhaustive route-by-route mass-assignment migration is BLOCKED_WITH_EXACT_REASON above. |
| 2. Auth/session hardening | DONE for local regression evidence: refresh rotation/replay, Apple nonce, Google/OAuth state, and session switching tests were re-run. Step-up auth and passkeys are BLOCKED_WITH_EXACT_REASON above. |
| 2. WebSocket hardening | DONE: first-frame JWT auth already existed; this wave added trusted-Origin rejection, rate limiting, fail-closed tier checks, and source/unit pins. |
| 2. Provider/webhook hardening | DONE for local evidence: webhook signature, replay/idempotency, Apple JWS, and billing-route tests were re-run. Live provider secret rotation remains BLOCKED_WITH_EXACT_REASON. |
| 3. iOS/Mobile hardening | DONE for local evidence: Keychain no-iCloud/this-device-only, ATS/cleartext/WebView source pins, and deep-link routing tests passed. Real APNs and full release-hardening suite remain BLOCKED_WITH_EXACT_REASON. |
| 4. Infrastructure, edge, and data protection | DONE for local encrypted recovery tooling, retention, and isolated restore verification. Cloudflare/VPS/firewall and SQLCipher migration remain BLOCKED_WITH_EXACT_REASON; complete host-loss recovery is ACCEPTED_RESIDUAL_RISK while backups remain on the same disk. |
| 5. Content engine, AI, SSRF, and tool safety | DONE: FastAPI dependency audit is clean, content-engine tests passed on Python 3.13, and the URL guard blocks SSRF primitives for external URL consumers, including the IPv6 bypass corpus from hostile QA. |
| 6. Logging, Sentry, secrets, and privacy | DONE: redaction code/tests cover sensitive domains; secret-pattern scan found only fake test fixtures. Production secret rotation remains BLOCKED_WITH_EXACT_REASON. |
| 7. CI, supply chain, and release gates | DONE: CodeQL, npm audit, pip-audit, OpenSSF Scorecard, Dependabot, and docs audit integration are present. |
| 8. Incident response and privacy operations | DONE for repository artifacts and the weekly local restore verifier. The first live backup/restore receipt remains rollout evidence to collect; complete host recovery is not claimed while recovery points remain on the same disk. |

## Public Interface / Contract Coverage

| Contract item | Coverage |
|---|---|
| No breaking public API changes by default | DONE: this wave did not add, remove, or rename public REST routes. Security behavior changes are fail-closed error handling, WebSocket hostile-Origin rejection, WebSocket rate limiting, and safer URL/log handling. |
| Internal `traceId` and verification metadata where already useful | DONE_WITH_EXISTING_CONTRACTS: existing chat/training/content/decision-center contracts already carry trace/verification-style metadata on the routes that need it. This wave did not widen every API DTO just to add unused fields. |
| Global `authAssuranceLevel`, `scopeSource`, `providerWriteVerified`, and `redactionApplied` metadata | BLOCKED_WITH_EXACT_REASON: requires a cross-route API contract migration, iOS decoding/UI decisions, and backward-compatibility review. Adding these globally in a local hardening pass would create a partially adopted contract and could break existing clients. |
| User-facing active sessions/devices, passkey enrollment, provider-token status, recent security activity, and revoke-all-sessions settings | BLOCKED_WITH_EXACT_REASON: requires product design, database/API work, device testing, and explicit release UX. The security matrix lists these as future settings, but this wave deliberately avoids creating a parallel auth/security-settings stack. |

## Test Plan Coverage

| Test-plan item | Coverage |
|---|---|
| Backend route authorization/BOLA tests for scoped routes | DONE: `/api/v1` scoped route families are source-pinned behind `authMiddleware`; existing focused tenant/isolation suites were re-run for changed/high-risk surfaces. |
| Backend mass-assignment tests for mutation routes | BLOCKED_WITH_EXACT_REASON: full mutation allowlist migration is a separate API-contract wave because each route needs owner fixtures and iOS compatibility review. |
| JWT/session/refresh rotation and replay tests | DONE: auth/session focused checks were re-run, including refresh/session replay coverage. |
| WebSocket auth, tenant-scope, Origin, and rate tests | DONE: first-frame JWT/tenant behavior already existed; this wave added and tested Origin rejection and per-connection rate budget. |
| Provider webhook signature, replay, and idempotency tests | DONE: billing/webhook/Apple notification focused sweeps were re-run. |
| SSRF and Playwright isolation tests | DONE for URL consumers touched in this wave: the SSRF guard has IPv4, IPv6, metadata, credentialed, non-HTTPS, and host-spoofing corpus tests; YouTube transcript host parsing rejects spoofed/private/metadata URLs. Full Playwright browser-context hardening remains a future route-by-route consumer audit if new scraping entrypoints are added. |
| Sentry/Pino redaction tests | DONE: log sanitizer and Sentry tests cover nested sensitive keys, camelCase variants, provider errors, and raw model/tool content. |
| iOS Keychain/accessibility and ATS/no-cleartext source pins | DONE: new tests pin this-device-only/no-iCloud token storage and block accidental ATS cleartext or legacy WebView bypasses. |
| iOS account-switch cache erasure | DONE_WITH_EXISTING_COVERAGE: existing account-switch/cache tests remain part of the release-hardening suite; this wave did not change cache invalidation behavior. |
| iOS deep-link/OAuth state/nonce tests | DONE: `DeepLinkRouterTests` and OAuth nonce/state backend checks were re-run. |
| APNs payload privacy tests | BLOCKED_WITH_EXACT_REASON: simulator tests can cover notification orchestration, but real APNs payload privacy requires TestFlight/device token and approved safe delivery proof. |
| Debug-token gates | DONE_WITH_EXISTING_COVERAGE: release-hardening source pins already guard debug-token import/export behavior; this wave added adjacent MASVS pins without changing debug-token code. |
| Infra/CI secret scan, dependency audit, CodeQL, firewall checklist, backup restore drill | DONE for repository/CI and local recovery: secret-pattern scan, `npm audit`, `pip-audit`, CodeQL workflow, Scorecard workflow, Dependabot config, local backup tests, and isolated restore verification exist. Firewall changes require live ops; the first server receipt is rollout evidence, not an off-host or AWS dependency. |
| Manual hostile QA: two-account cross-tenant attempts, stolen/expired refresh token, provider revoked, malicious transcript/tool output, SSRF corpus, webhook replay, lost device/logout | DONE for local deterministic coverage where feasible: auth, provider/webhook, prompt/tool, SSRF, and account-scope tests exist. Live two-account/provider-revoked/lost-device/manual drills remain BLOCKED_WITH_EXACT_REASON until a safe staging/TestFlight operations window is approved. |

## Verification Commands

- Backend focused security sweep passed:
  `npx vitest run __tests__/api/chat-message-tier-gate.test.ts __tests__/api/websocket-security.test.ts __tests__/security/api-router-auth-boundary.test.ts __tests__/security/url-guard.test.ts __tests__/security/security-baseline-source-pins.test.ts __tests__/utils/log-sanitizer.test.ts __tests__/services/error-tracker.test.ts __tests__/utils/logger-redaction.test.ts __tests__/services/webhook-registry.test.ts __tests__/services/webhook-registry-qa-validation.test.ts __tests__/api/billing-routes.test.ts --reporter=default`
- SSRF hostile probe passed: `npx tsx` one-off against the QA corpus blocked bracketed IPv6 loopback/ULA/link-local, IPv4-mapped IPv6, decimal/octal/hex IPv4, metadata, credentialed, non-HTTPS, file, and YouTube host-spoofing URLs.
- Backend typecheck: `npm run typecheck`
- Backend dependency audit: `npm audit --audit-level=high`
- Python lock check: `node scripts/generate-python-release-lock.mjs --check`
- Python audit: `python -m pip install --disable-pip-version-check --require-hashes --only-binary=:all: -r content-engine/requirements-audit-tool.txt && pip-audit -r content-engine/requirements-release.txt`
- Python content engine tests passed: `pytest` from a Python 3.13 virtualenv under `content-engine/`
- Auth/OAuth/APNs-routing focused checks passed:
  `npx vitest run __tests__/services/oauth-state-store.test.ts __tests__/api/auth-routes.test.ts __tests__/security/notification-orchestrator-security.test.ts __tests__/security/billing-apple-notifications-jws-verify.test.ts --reporter=default`
- iOS new security pins passed:
  `xcodebuild test -project "Nexus Hub.xcodeproj" -scheme "Nexus Hub" -destination "platform=iOS Simulator,name=iPhone 17 Pro" -only-testing "Nexus HubTests/ReleaseHardeningConfigTests/test_securitySensitiveSourceDoesNotIntroduceCleartextOrWebViewBypass" -only-testing "Nexus HubTests/KeychainHelperTests/test_keychainHelperPinsThisDeviceOnlyAndNoICloudSync"`
- iOS deep-link routing passed:
  `xcodebuild test -project "Nexus Hub.xcodeproj" -scheme "Nexus Hub" -destination "platform=iOS Simulator,name=iPhone 17 Pro" -only-testing "Nexus HubTests/DeepLinkRouterTests"`
- Docs audit: `npm run docs:audit`
