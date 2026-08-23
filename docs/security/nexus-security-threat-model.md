# Nexus Hub Security Threat Model

Status: canonical
Owner: Felipe Dominguez
Last verified: 2026-08-09
Update policy: update when a deployed surface, identity boundary, provider
integration, or release/deploy path changes.

## Scope

This threat model covers the deployed Nexus Hub system: Node/Express iOS API,
Telegram bot, portal/admin routes, SQLite persistence, Python/FastAPI content
engine, iOS SwiftUI app, provider integrations, Cloudflare Tunnel ingress, the
digest-pinned container pair and root release poller, CI/CD, backups,
observability, and incident response. PM2 is retained only as the manual first-
cutover fallback for 14 stable days.

## Primary Assets

- User private data: chat, calendar, tasks, training, cooking, finance, content
  drafts, creator references, HealthKit/Apple Health summaries, and settings.
- Provider credentials: Google, Microsoft/Outlook, Garmin, Todoist, Notion,
  Stripe, Apple IAP, Resend, Telegram, OpenAI, Anthropic, Google GenAI.
- Session material: iOS access/refresh tokens, device rows, OAuth states,
  portal/operator tokens, webhook secrets, JWT signing keys.
- Operational authority: the root systemd release poller, Docker Engine, pinned
  release verification key, hosted release-workflow signing and registry
  credentials, Cloudflare tunnel/API tokens, authoritative root-owned release
  state and immutable receipts, local-backup identity/configuration, backups,
  logs, Sentry, and first-cutover-only PM2 fallback control.
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
- Pull-request code and workflow definitions to the protected-main CI runner,
  which has test authority only: no registry credential, Docker, or deploy path.
- The hosted release workflow to GHCR and the release-manifest signing key. It
  publishes immutable application images plus a signed release-payload image;
  it does not deploy or rerun the protected-main tests.
- The root VPS poller to the signed release payload, root-owned policy and key,
  Docker Engine, release locks, state, receipts, and operator alert channels.
  Docker remains root-equivalent host authority even when application ports are
  bound only to loopback.
- The application containers and one-shot migrator to host-mounted SQLite data.
- The production database to root-owned encrypted backup storage on the same
  release-host disk. This is an isolation and corruption boundary, not a
  host-loss boundary.
- The first-cutover container database to the recorded PM2 database and runtime
  fallback. That boundary exists only during the 14-stable-day fallback window.

## Attacker-Controlled Inputs

- REST bodies, query strings, headers, JWTs, refresh tokens, OAuth callbacks,
  webhook payloads, WebSocket frames, Telegram messages/files/callbacks.
- Provider-returned text and error payloads, calendar/event/task fields,
  transcripts, competitor examples, scraped web pages, URLs, redirects.
- iOS deep links, APNs payload fields, local UserDefaults values, fixture flags.
- CI inputs from pull requests, workflow files, package manifests, migrations,
  and migration-classifier policy.
- Moving image tags, signed release-payload and Compose bytes, OCI digests,
  migration verdicts, root state/receipts, local encrypted backup artifacts,
  predecessor identities, and restore-verification output. Each is untrusted
  until its exact signature, identity, ownership, digest, topology, and path
  checks pass.

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
- Only a release payload whose Ed25519 signature binds the governed repository,
  protected-main ref, workflow/run identity, source SHA, image digests, Compose
  digest, migration-verdict digest, timestamp, and pinned key id can acquire
  production authority. Moving tags provide discovery only.
- The protected-main CI runner has no registry or deploy credential. The hosted
  release workflow receives signing authority only after independently
  recomputing the full-push migration verdict and matching CI.
- Root write-ahead state records the candidate, exact pre-migration backup, and
  outgoing predecessor before migration. Backup must precede migration; a
  failure keeps the predecessor serving. Crash recovery reopens those exact
  artifacts rather than consulting a mutable backup pointer.
- A release must pass staging, the production migrator, health/smoke checks, and
  60 seconds of observation. A reversible failure restores the recorded
  predecessor image pair within the 120-second objective; database corruption
  hard-stops for operator recovery instead of discarding post-migration writes.
- Unattended deployment accepts only predecessor-compatible expand/backfill
  migrations. Contract, destructive, or unknown migrations remain blocked. The
  required owner-authorized container maintenance executor is not implemented;
  its exact-release authorization, quiescence, snapshot, and database-plus-
  runtime recovery design remains owner-gated.
- Docker is root-equivalent. Root-owned policy, release state, receipts, keys,
  locks, and encrypted backup material stay outside the containers; application
  ports remain loopback-bound behind Cloudflare ingress.
- Application recovery points are SQLite-consistent, encrypted with `age`,
  descriptor- and checksum-bound, retained locally as 24 hourly, 30 daily, and
  four weekly copies, and restored only into a private scratch path during
  verification.
- No AWS or off-host backup service is a runtime or release dependency.
  Same-disk recovery is explicitly accepted for the current project size: it
  protects against bad releases, operator error, and database corruption, but
  total NVMe or release-host loss can destroy both primary data and backups.

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
| P1 | Release authority or recovery bypass | Signature, manifest, policy, root state, receipt, backup, or predecessor identity is tampered; write-ahead or rollback readiness is missing; or soak/recovery deadlines are bypassed. |
| P1 | Backup recovery failure | Stale/missing local point, unreadable `age` identity, checksum drift, hostile rollback archive, a restore that touches production paths, or total host/NVMe loss under the accepted same-disk residual risk. |
| P2 | Container control-plane exposure | Docker listener/socket exposure, container escape or root-policy/key access, direct application-port exposure, resource pressure, or unreviewed image/runtime change. |
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
- Moving backup durability to a USB SSD, NAS, or another non-AWS host is a
  future resilience decision. Until then, do not describe local recovery
  points as disaster recovery for complete server loss.
- This model is a security scan source of truth; individual findings must still
  be validated at source level before being treated as exploitable.
