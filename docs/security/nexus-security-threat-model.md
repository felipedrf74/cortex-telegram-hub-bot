# Nexus Hub Security Threat Model

Status: canonical
Owner: Felipe Dominguez
Last verified: 2026-05-14
Update policy: update when a deployed surface, identity boundary, provider
integration, or release/deploy path changes.

## Scope

This threat model covers the deployed Nexus Hub system: Node/Express iOS API,
Telegram bot, portal/admin routes, SQLite persistence, Python/FastAPI content
engine, iOS SwiftUI app, provider integrations, Cloudflare Tunnel ingress, PM2
runtime, CI/CD, backups, observability, and incident response.

## Primary Assets

- User private data: chat, calendar, tasks, training, cooking, finance, content
  drafts, creator references, HealthKit/Apple Health summaries, and settings.
- Provider credentials: Google, Microsoft/Outlook, Garmin, Todoist, Notion,
  Stripe, Apple IAP, Resend, Telegram, OpenAI, Anthropic, Google GenAI.
- Session material: iOS access/refresh tokens, device rows, OAuth states,
  portal/operator tokens, webhook secrets, JWT signing keys.
- Operational authority: production deploy access, PM2 process control,
  Cloudflare tunnel/API tokens, GitHub Actions, backups, logs, Sentry.
- Trust signals: audit trail, provider sync truth, model/tool verification
  status, release evidence, incident evidence.

## Trust Boundaries

- Public internet to Cloudflare Tunnel and exposed VPS ports.
- Cloudflare edge to Node/Express backend.
- iOS app to `/api/v1` REST and optional `/ws` WebSocket.
- Telegram users to bot handlers and domain services.
- Node backend to Python content engine on loopback.
- Node backend to external providers and model APIs.
- Backend services to SQLite and filesystem-backed provider/session stores.
- GitHub Actions to build/test/deploy credentials.
- Production runtime to logs, Sentry, backups, and operator alert channels.

## Attacker-Controlled Inputs

- REST bodies, query strings, headers, JWTs, refresh tokens, OAuth callbacks,
  webhook payloads, WebSocket frames, Telegram messages/files/callbacks.
- Provider-returned text and error payloads, calendar/event/task fields,
  transcripts, competitor examples, scraped web pages, URLs, redirects.
- iOS deep links, APNs payload fields, local UserDefaults values, fixture flags.
- CI inputs from pull requests, workflow files, package manifests, migrations.

## Security Invariants

- Tenant/user scope is derived from authenticated context, not body/query input.
- A user can never read, mutate, prompt-inject, or infer another tenant's data;
  multi-tenant BOLA is treated as a P0 failure mode.
- A mutation cannot claim success unless the deterministic service executed and
  read-back verification succeeded or an honest partial failure is returned.
- Provider tokens and session secrets are never logged, sent to Sentry, written
  to user-facing output, or copied into model prompts.
- External URLs are allowlisted or SSRF-guarded before fetch/browser use.
- WebSocket and REST chat enforce the same auth, tenant, tier, and logout state;
  browser WebSocket upgrades also require a trusted Origin and every connection
  has a bounded message budget.
- iOS credentials remain local-device Keychain items and account-switch clears
  stale caches before rendering user data.
- Backups and audit evidence preserve incident accountability while minimizing
  access to sensitive user data.

## Priority Failure Modes

| Severity | Failure mode | Examples |
|---|---|---|
| P0 | Exploitable cross-user access | Broken object-level authorization, prompt context contamination, provider-token fallback to owner/global account. |
| P0 | Account/session takeover | Forged refresh token, stale device token after logout, OAuth state/nonce bypass, weak owner/admin auth. |
| P1 | Provider-token compromise | provider-token compromise via token logged, backup exposure, overbroad scopes, webhook replay, OAuth revocation failure. |
| P1 | SSRF/tool execution abuse | User/provider URL reaches localhost/metadata/private network, Playwright reuses auth state, redirect bypass. |
| P1 | Payment/webhook abuse | Stripe/Apple unsigned event accepted, duplicate replay mutates subscription, no idempotency. |
| P1 | Mobile local data exposure | iOS local data exposure through iCloud-synced secrets, stale user cache after account switch, debug auth token in release. |
| P2 | Observability/privacy leak | Sentry/logs include emails, health, finance, calendar text, raw model output, provider errors. |
| P2 | Infra exposure | VPS exposure through API/staging ports reachable directly, SMB/RDP/SSH broad exposure, backups world/group-readable. |
| P3 | Maturity gaps | Missing tabletop drill, incomplete control matrix, advisory-only supply-chain checks. |

## Reference Baseline

- Backend/API: OWASP ASVS Level 2, OWASP API Top 10 2023, OWASP REST, JWT,
  Session Management, Logging, Error Handling, SSRF, Mass Assignment, SQLi, and
  Secrets Management cheat sheets.
- Mobile: OWASP MASVS baseline across storage, auth, network, platform, code,
  resilience, and privacy.
- Identity: NIST SP 800-63B-4, OAuth 2.0 for Native Apps, OAuth Security BCP,
  OIDC Core, PKCE, Sign in with Apple, Google/Microsoft token guidance.
- Runtime: CIS Linux benchmark concepts, Cloudflare origin protection, Express
  production security, Node security best practices.

## Operating Notes

- Direct production firewall, Cloudflare, SSH, APNs, provider, or payment
  changes require a separate approved operations window.
- This model is a security scan source of truth; individual findings must still
  be validated at source level before being treated as exploitable.
