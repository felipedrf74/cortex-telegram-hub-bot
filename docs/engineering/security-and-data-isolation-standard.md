# Security and Data Isolation Standard

Status: canonical
Owner: backend security architect
Last verified: 2026-05-04
Update policy: update when threat model changes, when a new permanent gate
is added, or when a new class of multi-tenant bug is shipped to production.
Removing a gate requires owner approval.

This standard codifies how Nexus Hub enforces auth, session, tenant
isolation, memory/retrieval scope, prompt-context scope, tool-call
authorization, and audit logging. It is grounded in OWASP API Security
Top-10 (2023), OWASP Auth/Session/REST/Node cheat sheets, NIST SP 800-218
SSDF, and CISA Secure-by-Design principles, then translated into
Nexus-specific rules and gates.

## 1. Threat model summary

Nexus Hub is a **multi-tenant SaaS** even though closed-beta has only a
handful of users. The runtime treats every authenticated request as a
candidate cross-tenant attack surface. The four tenants of focus:

1. **Cross-tenant data leak**: user A reads/writes data scoped to user B.
2. **Identity contamination via prompt/memory**: prompts/memory written
   for user A leak into user B's chat or generated content.
3. **Provider/tool privilege escalation**: a tool call authorized for user
   A's calendar fetches user B's calendar.
4. **Account takeover via auth weakness**: stolen Apple/Google id token
   replay, unverified-email merge, refresh-token theft, register
   enumeration.

The 4.14.118-class incident (`prompts/secretary.md` literally said "You
are Felipe's personal assistant…" and was used for every tenant) closed
threat #2 at the prompt layer. The 4.14.127 auth-hardening pass closed
threat #4 family items. The standard below is what must hold to prevent
all four.

## 2. Auth + session contract (must)

### Identifiers

1. **`req.userId === req.tenantId` for JWT-authenticated routes.** This
   is enforced by `auth-middleware`. Any route that diverges from this
   identity is a tenant-isolation bug.
2. **`req.userId` is derived from the JWT, not from the request body.**
   The iOS client never sends a `userId` field in chat/message payloads
   or any operational route. Routes that accept a `userId` in the body
   are admin routes only and require an admin token.
3. **`getPreferredDisplayNameById(userId)`, `getUserLanguageById(userId)`,
   `getUserTimezoneById(userId)`** are the strict by-id resolvers. The
   fuzzy `getUserByAnyIdentifier` is reserved for OAuth callback paths
   that resolve users by Telegram id / email; it must NOT be called from
   app-facing iOS routes.

### Token lifecycle

1. **Access tokens are JWT-signed, 7-day TTL.** Acceptable for closed
   beta; revisit before open beta (see AUTH-O15).
2. **Refresh tokens are stored hashed at rest.** AUTH-O4 still open —
   plaintext storage in `ios_devices.refresh_token` is the deferred fix.
   The schema field exists; the hash-at-rest migration coordinates with
   active sessions.
3. **Refresh rotation includes theft detection.** When a refresh token is
   used, the previous one is invalidated; if the previous one is then
   used again, all sessions for that user are revoked.
4. **`/auth/logout` revokes the device row + refresh token server-side
   BEFORE iOS clears local Keychain.** The 4.14.127 fix added the
   fire-and-forget POST in `AuthManager.logout()` with a 5s timeout.

### Apple / Google / Telegram OAuth

1. **Apple Sign In: rawNonce → SHA-256 nonce contract.** iOS generates a
   raw nonce, hashes it with SHA-256, sets `request.nonce` to the hash;
   backend validates `payload.nonce === sha256(rawNonce)` and stores
   consumed nonce hashes in `apple_sign_in_nonces`. Replay rejected.
   This is the AUTH-O1 closure.
2. **Apple JWKS force-refresh on `kid` miss** (debounced 60s). Apple key
   rotation no longer 401s for up to 24 h.
3. **Apple `jwt.verify` uses `maxAge: '5m'`, `clockTolerance: 30`.**
   Replay window narrowed from 10 min to 5 min.
4. **Google id tokens verified via `OAuth2Client.verifyIdToken`** (local
   JWKS + signature + iss + aud + exp). The deprecated `tokeninfo`
   debug endpoint is forbidden.
5. **Google `email_verified` link gate.** A Google sub is merged into an
   existing email-matched user only if BOTH `payload.emailVerified ===
   true` AND `existing.email_verified === 1`. Otherwise throws
   `GoogleAccountLinkRequiresVerificationError` → HTTP 409.
6. **Telegram OAuth state nonce binding.** State is `tg:<userId>:<nonce>`
   backed by the existing nonce store. Legacy numeric state is rejected.
7. **No Apple `@privaterelay.appleid.com` email linking** (AUTH-O8 still
   open). Defensive check planned.

### Email + password

1. **bcrypt cost 12** for password hashing. Lower costs are forbidden.
2. **Email verification codes are 6-digit, `crypto.randomInt(100000,
   1000000)`-generated, 5-attempt cap, single-use.** AUTH-O22 + AUTH-O5
   are both closed.
3. **Login failures audit-logged** with outcome, reason, hashed email,
   device id. The `logAudit({ action: 'access', resource:
   'auth.login_email', details: { outcome: 'failure', ... } })` shape is
   the reference; do not invent a new shape.
4. **Account-existence enumeration is prevented.** `/auth/register`
   returns `REGISTRATION_REJECTED 400` for both "email already exists"
   and "validation rejected". `/auth/login/email` returns generic 401
   for both "user not found" and "wrong password". iOS displays
   "Invalid email or password" for both.

## 3. Tenant isolation (must)

1. **Every scoped read filters by `user_id` explicitly.** No `IN (0, ?)`
   merging of platform-seed rows with user rows. The 4.14.127 fix
   replaced `WHERE user_id IN (0, ?)` with `WHERE user_id = ?` in
   `services/content-intelligence.ts`; the same shape is required for
   every new scoped read.
2. **Every scoped write asserts `userId` is non-zero, non-null, and
   matches `req.userId`.** A write that accepts a `userId` from the body
   is an admin write or is wrong.
3. **`getSavedIdeas(source, userId)` and similar list helpers require
   `userId` explicitly.** Optional `userId` parameters that fall back to
   "every user" are forbidden.
4. **A new test under `__tests__/security/<feature>-tenant-isolation.test.ts`
   accompanies every new scoped surface.** The test fixture seeds
   user A and user B with non-empty data, calls the route as user A,
   and asserts user B's data is not in the response.

The `__tests__/security/p0-chat-identity-isolation.test.ts` (23 cases)
is the gold-standard pattern. Copy that shape.

## 4. Prompt and memory scope (must)

1. **Prompts must NOT contain owner identity.** The
   `closed-beta-identity-scan` scanner (`engine/scripts/closed-beta-identity-scan.sh`)
   greps for `Felipe's voice`, `Felipe's brand`, `felipes_angle`, etc.
   in `src/`, `prompts/`, `content-engine/`. Strict mode runs nightly
   and fails the build on any non-allowed match.
2. **`buildKnowledgePromptBlock(userId, ...)` requires explicit
   `userId`.** It must NOT default to "any user" or merge user 0 rows
   into the user's prompt.
3. **`creator_profile`, `voice_dna`, `content_knowledge`, `content_pillars`,
   `cooking_preferences`, `finance_preferences`, `skill_memory` are all
   strictly per-user.** Every read goes through a typed by-userId
   accessor.
4. **`creator-config.md` and every domain prompt under `prompts/` is a
   NEUTRAL TEMPLATE.** No name, no worldview, no audience, no political /
   religious / dietary defaults. The prompt-cleanliness test
   (`__tests__/services/prompt-cleanliness.test.ts`, 72 cases) pins this.
5. **The deterministic identity fast-path at
   `src/api/routes/chat-message-local-responses.ts`** answers 16 PT/EN
   identity questions BEFORE any AI call, using the JWT-derived
   authenticated session. This closes the v4.14.118-class smoking gun
   structurally — even if a prompt regresses, the AI never gets the
   identity question.
6. **The authenticated-user `ChatContextItem` at priority 98** carries
   the JWT display name and an explicit "do not use owner, founder,
   default, or prior-user names" instruction.

## 5. Tool-call authorization (must)

1. **Every tool that mutates data accepts `userId` and authorizes
   against it.** Calendar create, task create, plan create, content
   topic create — all funnel through `tool-executor.ts` which performs
   the userId check before dispatch.
2. **Every tool that reads data accepts `userId`.** Cross-user reads via
   tool calls are tenant-isolation bugs.
3. **Provider fallback preserves `userId`.** If Gemini fails and
   Anthropic is invoked, the userId is passed through; the prompt block
   built by Gemini and Anthropic uses the same per-user data.
4. **Telegram bot tool calls are userId-scoped.** The `ctx.from!.id` is
   resolved to a Nexus userId via the strict by-telegramId resolver
   before any tool runs.

## 6. Audit logging (must)

1. **`logAudit(...)` rows exist for every auth event.** Login success,
   login failure (per-reason), register success, register rejection,
   provider link, provider unlink, password change, email verification,
   logout, account suspension. AUTH-O6 and AUTH-O12 still open for
   provider-link audit and portal-login audit; close before broad cohort
   sign-up.
2. **Audit rows do NOT contain raw secrets.** Hashed email, redacted
   provider id, user id, IP — yes. Raw email, raw provider token, raw
   password — no.
3. **`audit_trail` rows are immutable and partitioned by user_id.**
   Reads are admin-scoped only.

## 7. Rate limits and abuse controls (must)

1. **Auth routes have IP-bucket rate limits.** Login, register, password
   reset (when AUTH-O2 lands) — all rate-limited.
2. **Per-account lockout after failed attempts.** AUTH-O7 still open;
   distributed credential-stuffing across many IPs is currently unbounded
   per account. Plan: 10-attempt 15-min lockout via
   `failed_login_attempts` table.
3. **Portal `/api/*` rate limit.** AUTH-O10 still open; portal does not
   currently mount `rateLimitMiddleware`. Plan: 20 req/min/IP for portal.
4. **Cost guardrails enforce daily AI spend caps** globally and per-user.

## 8. Secrets and logging (must)

1. **No raw secrets in logs.** `OPERATOR_ALERT_WEBHOOK_TOKEN`, OAuth
   tokens, Apple JWKS keys, refresh tokens — never logged.
2. **Pre-commit hook runs `detect-secrets`** and rejects committed
   secrets.
3. **`.env` files are not modified by code.** Configuration is read at
   startup via `src/config.ts` which validates required keys.
4. **PII redaction**: emails, full names, phone numbers, finance values,
   calendar event titles, raw email message bodies, raw chat message
   contents are forbidden in pino log lines. The `audit_trail` schema
   defines what's allowed.

## 9. Fixture / demo data gates (must)

1. **Every fixture row is gated by `NEXUS_STAGING=1` or
   `NEXUS_FIXTURE_MODE=1`.** A production env without these flags
   refuses to seed fixture rows and refuses to serve fixture-tagged
   data.
2. **Fixture rows are tagged at the row level.** `is_fixture: 1` (or a
   dedicated `fixture_tag`) so a leak from fixture into production is
   visually obvious in DB inspection.
3. **A test asserts production env never returns fixture-tagged data**
   for any app-facing route.

## 10. Permanent security gates (must)

These gates run on every PR and/or nightly. **Do not remove a gate**;
removal requires owner approval and a documented replacement.

| Gate | Where | Frequency | Closes |
|---|---|---|---|
| `closed-beta-identity-scan` (advisor) | `engine/.github/workflows/ci.yml` | every PR | identity-leak (4.14.118 class) |
| `closed-beta-identity-scan-strict` | `engine/.github/workflows/nightly.yml` | nightly | identity-leak strict gate |
| `__tests__/security/p0-chat-identity-isolation.test.ts` | Vitest | every PR (auth/prompt diff) | chat identity contamination |
| `__tests__/security/creator-config-neutrality.test.ts` | Vitest | every PR | prompt neutrality |
| `__tests__/services/prompt-cleanliness.test.ts` (72 cases) | Vitest | every PR (prompt diff) | prompt static cleanliness |
| `vi.mock` completeness lint | `engine/scripts/vi-mock-completeness-lint.mjs` | nightly strict | partial-mock leakage |
| `release-doc-drift-check.sh` | nightly strict | nightly | release-state drift |
| Two-user matrix test | `__tests__/security/<domain>-tenant-isolation.test.ts` | every PR (per-domain diff) | cross-tenant read leak |
| Auth-route audit log assertion | `__tests__/api/auth-routes.test.ts` | every PR (auth diff) | missing audit row |

## 11. Data classification (canonical)

| Class | Examples | Storage | Logging | Sharing |
|---|---|---|---|---|
| **Public** | Marketing copy, app version | Public-readable | Free | Free |
| **Operational** | Build metadata, deploy SHAs, smoke evidence | Internal repos | Free | Internal |
| **User-scoped** | Tasks, calendar, plans, content, finance | SQLite per-user rows | Redacted (no values) | User only + admin under audit |
| **Identity** | Email, name, hashed password, OAuth tokens | SQLite users/identities | Hashed only | User only |
| **Sensitive** | Health metrics, body battery, body composition, finance values, sensitive chat | SQLite scoped tables | Never | User only |
| **Secrets** | API keys, OAuth tokens at rest, JWKS keys | env / encrypted store | Never | Backend only |

A field that is unclear is treated as Sensitive by default. Lifting to a
lower class requires explicit owner approval.

## 12. Incident response

When a tenant-isolation bug is suspected:

1. **Stop the bleeding.** Disable the affected route or feature flag.
2. **Run the closed-beta-identity-scan strict.** Confirm whether the bug
   matches a known signature.
3. **Snapshot affected DB rows.** Before any cleanup, capture the state
   so audit can reconstruct.
4. **Audit the access trail.** `audit_trail` rows for the affected user
   ids and the suspected window.
5. **Open an OPEN_ITEMS entry at P0** with the route/file/commit, the
   evidence, and the remediation owner.
6. **Land a regression test that fails before the fix.** Do not ship the
   fix without it.

## 13. PR checklist (security-relevant changes)

- [ ] No new prompt mentions an owner/founder/specific user name.
- [ ] Every new SQL `SELECT/INSERT/UPDATE/DELETE` filters by `user_id`.
- [ ] Every new tool call accepts and authorizes a `userId`.
- [ ] Every new auth-relevant route has an audit log entry.
- [ ] Every new fixture row is gated by `NEXUS_STAGING=1` or
      `NEXUS_FIXTURE_MODE=1` and tagged `is_fixture: 1`.
- [ ] No PII in pino log lines.
- [ ] No raw secrets in code or env-template.
- [ ] Two-user matrix test covers any new scoped surface.
- [ ] `closed-beta-identity-scan` runs clean.
