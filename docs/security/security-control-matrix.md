# Nexus Hub Security Control Matrix

Status: canonical
Owner: Felipe Dominguez
Last verified: 2026-07-27
Update policy: update when route families, mobile storage, provider integrations,
or release gates change.

## Control Matrix

| Surface | Baseline references | Required controls | Evidence / gate |
|---|---|---|---|
| `/api/v1` REST | OWASP ASVS L2, API1/BOLA, REST, Mass Assignment | JWT middleware before scoped routes; `userId/tenantId` from auth context; explicit request allowlists; safe error envelope. | Route inventory tests, tenant-isolation tests, mutation allowlist tests. |
| Auth/session | NIST 800-63B, OWASP Auth/Session/JWT, OAuth BCP | Device-bound refresh rows; refresh rotation; logout revocation; active-tenant match; step-up for sensitive actions. | Auth middleware tests, refresh replay tests, audit-log tests. |
| WebSocket /ws | OWASP WebSocket, ASVS auth/session | First-frame JWT auth; trusted-Origin rejection for browser upgrades while preserving native iOS clients; canonical tenant recheck per message; device revocation; fail-closed tier/access checks; heartbeat/rate-limit. | WebSocket origin/rate helper tests plus tenant/tier source pins and integration tests. |
| iOS storage | OWASP MASVS-STORAGE/AUTH/PRIVACY, Apple Keychain | This-device-only Keychain; no iCloud sync for tokens; scoped cache keys; logout/account-switch erasure; debug-token release gates. | Keychain/source-pin tests, account-switch tests, debug importer/exporter tests. |
| iOS network/deeplinks | MASVS-NETWORK/PLATFORM, RFC 8252, PKCE | Strict ATS; local backend only in DEBUG explicit launch; URL/deeplink scheme validation; OAuth state/nonce verification. | Release hardening tests, deep-link tests, OAuth callback tests. |
| Provider tokens | Google/Microsoft/Garmin/Resend/Telegram docs, OWASP Secrets | Least-privilege scopes; per-user token reads; no owner fallback except explicit owner system path; revoke where possible; no token logs. | Provider tenant-isolation tests, redaction tests, OAuth-flow tests. |
| Stripe/Apple billing | Stripe webhooks, Apple JWS, OWASP API replay/idempotency | Signature/JWS verification; bundle/product validation; idempotency; webhook rate limit; safe 200 to Apple on invalid event. | Billing webhook tests, Apple JWS tests, idempotency tests. |
| Content engine | FastAPI security, Pydantic, httpx timeouts | Loopback bind; internal shared secret; input validation; request IDs; provider timeout/degraded states. | Python compile/tests, internal-route auth tests, content eval gates. |
| AI/tool calls | OWASP LLM/prompt-injection concepts, ASVS data protection | Untrusted provider/transcript labels; no model-only mutations; tool allowlists; read-back verification; raw output sanitization. | Prompt/tool-injection tests, action verification tests, content/chat evals. |
| SSRF/scraping | OWASP SSRF, Playwright security, WHATWG URL | HTTPS allowlist; block localhost/private/metadata IPs; redirect revalidation; isolated browser contexts; no persistent foreign auth state. | SSRF URL corpus tests, Playwright source pins. |
| SQLite/backups | SQLite security, OWASP SQLi/Crypto/Secrets | Prepared statements; scoped predicates; root-owned `age` encryption; checksum-bound local retention; pre-promotion point; private scratch restore verification. Same-disk host-loss risk is explicit and accepted; no AWS/off-host dependency is claimed. | Migration rehearsal, local backup tests, weekly restore verifier, release receipt. |
| Logs/Sentry | OWASP Logging/Error Handling, Sentry scrubbing, Pino redaction | Token/email/health/finance/calendar/model-output redaction; `sendDefaultPii=false`; event processor tests. | Log sanitizer tests, Sentry redaction tests. |
| CI/supply chain | CodeQL, Dependabot, npm audit, pip-audit, Scorecard, OIDC | Static analysis; dependency audit; least-privilege workflow permissions; secret scanning/push protection policy. | `security.yml`, Dependabot config, CI source pins. |
| VPS/Cloudflare | CIS, Cloudflare Tunnel firewall, UFW/fail2ban | Origin ports loopback/firewalled; staging/admin Access; SSH key-only; SMB/RDP restricted/closed; WAF/security headers. | Infra checklist and approved ops window evidence. |
| Incident/privacy | NIST 800-61, OWASP IR, GDPR/ICO | Incident runbooks; breach evidence checklist; provider revocation; DSR export/delete audit rows; tabletop and restore drills. | Incident runbook, privacy map, quarterly drill record. |

The current recovery boundary is intentionally local to ServerDominguez. It
covers release mistakes and database corruption but not complete NVMe or host
loss. A USB SSD, NAS, or another non-AWS host can be added later without making
AWS part of CI, release, SonarQube, or production operation.

## Sensitive Action Step-Up Candidates

- Account deletion and data export.
- Provider unlink/relink and token revocation.
- Payment/customer portal access.
- Owner/admin portal mutations.
- Revoke-all-sessions and device/session management.
- Production operator-token minting.

## Release Gate

Security-sensitive changes require:

1. `npm run typecheck`
2. Focused security test sweep for affected surface.
3. Tenant/BOLA regression tests when scoped data is touched.
4. `npm run docs:audit` when security or release docs change.
5. iOS focused MASVS tests when app storage, auth, network, APNs, or deep links change.
6. Staging smoke before any production promotion.
