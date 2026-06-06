# Nexus Security Hardening — Claude Hostile QA

**Date**: 2026-05-14
**Engine**: `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot` — branch `main`, dirty working tree
**iOS**: `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub` — branch `main`, dirty working tree
**Simulator**: iPhone 17 Pro, iOS 26.4.1 (`A0B13967-B5DE-4E6F-897D-F1E409093F94`)
**iOS xcresult**: `/tmp/sec-qa/ios.xcresult`

## Verdict

**NO_GO** ❌

I confirmed all the documented controls land at source level, the focused
test sweeps pass (backend 128/128, auth/OAuth 31/31, Python 146/146),
`npm audit` reports 0 high vulnerabilities, redaction does not
over-redact safe ops fields, the completion ledger is honest, and the
FastAPI runtime upgrade works on Python 3.13. **But** my hostile probes
against the SSRF guard found a **real exploitable bypass** that defeats
the IPv6 portion of the guard entirely.

The QA prompt's NO_GO criteria explicitly include "**skipped critical
test**" and "**raw artifact leak**." This finding fits both: zero IPv6
test cases exist in `__tests__/security/url-guard.test.ts`, and 6 IPv6
SSRF attack vectors succeed against the production guard.

The root cause is a 3-line fix and a missing test column. The control
itself was designed correctly — `isPrivateIpv6` covers `::1`, `fc*`,
`fd*`, `fe80:*`, and IPv6-mapped IPv4 — but it's never invoked because
of an upstream bracket-handling bug.

## P0 — SSRF guard does not block IPv6 (6 attack vectors succeed)

**File**: `src/security/url-guard.ts:43-44, 80-82`

**Symptom**: All bracketed-IPv6 URLs (`https://[::1]`, `https://[fd00:1::1]`,
`https://[fe80::1]`, `https://[::ffff:127.0.0.1]`, `https://[0:0:0:0:0:0:0:1]`,
`https://[::ffff:7f00:1]`) pass `assertSafeExternalUrl` even when the
embedded address is loopback, link-local, ULA, or IPv6-mapped IPv4
loopback.

**Root cause** (Node REPL evidence):
```
new URL('https://[::1]/').hostname === '[::1]'   // brackets included
net.isIP('[::1]') === 0                          // not recognized as IP
net.isIP('::1') === 6                            // recognized only without brackets
```

The guard's check at `:80` is:
```typescript
if (net.isIP(hostname) === 6 && isPrivateIpv6(hostname)) {
```

Because `hostname` retains the brackets, `net.isIP(hostname)` returns
`0`, the condition is `false`, and `isPrivateIpv6` is never called. The
guard's `normalizeHostname` at `:43-44` only strips trailing dots and
lowercases — it does not strip square brackets.

**Hostile probe transcript** (25 vectors run; 6 IPv6 vectors bypass; all
non-IPv6 vectors correctly blocked):
```
✓  plain HTTP                               → BLOCKED (Only HTTPS URLs are allowed)
✓  file://                                  → BLOCKED (Only HTTPS URLs are allowed)
✓  IPv4 loopback                            → BLOCKED (Private IPv4 ranges are not allowed)
✓  AWS/GCP metadata IPv4 (169.254.169.254)  → BLOCKED
✓  literal localhost                        → BLOCKED
✓  URL credentials (user:pass@…)            → BLOCKED
✓  private 10.x / 192.168 / 172.16-31       → BLOCKED
✓  0.0.0.0                                  → BLOCKED
✗  IPv6 loopback        [::1]               → ALLOWED  (P0)
✗  IPv6 ULA fd          [fd00:1::1]         → ALLOWED  (P0)
✗  IPv6 link-local      [fe80::1]           → ALLOWED  (P0)
✗  IPv6-mapped IPv4     [::ffff:127.0.0.1]  → ALLOWED  (P0)
✗  expanded IPv6        [0:0:0:0:0:0:0:1]   → ALLOWED  (P0)
✗  IPv6-mapped via hex  [::ffff:7f00:1]     → ALLOWED  (P0)
✓  padded IPv4 (127.000.000.001)            → BLOCKED
✓  decimal IPv4 (2130706433)                → BLOCKED (URL parser normalizes)
✓  hex IPv4 (0x7f000001)                    → BLOCKED
✓  octal IPv4 (0177.0.0.1)                  → BLOCKED
✓  suffix-bypass (youtube.com.evil.test)    → BLOCKED
✓  prefix-attack (evil-youtube.com)         → BLOCKED
✓  trailing dot + uppercase legit URL       → ALLOWED (correct)
✓  legit www.youtube.com                    → ALLOWED (correct)
```

Result: 19 pass / 6 fail of 25 attack vectors.

**Existing tests miss this entirely**:
```
$ grep -nE "\[::|::1|fe80|ipv6|IPv6" __tests__/security/url-guard.test.ts
(no output)
```

Zero IPv6 test cases in the URL guard test file. That's how the bypass
went undetected — the test suite has good IPv4 coverage but no IPv6
coverage, while the source code has an IPv6 protection function that is
unreachable in practice.

**Fix** (3 lines + 6 test cases, ~30 minutes):

```typescript
// src/security/url-guard.ts
function normalizeHostname(hostname: string): string {
  return hostname
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.$/, '')
    .toLowerCase();
}
```

Then add the 6 bracketed-IPv6 test vectors to `__tests__/security/url-guard.test.ts`.

After this fix, the guard's `isPrivateIpv6` function (already written
correctly) will be reachable, and all 6 vectors will block.

## P2 findings

### P2-1 — Pino redaction misses `calendarText`-style camelCase variants

**File**: `src/utils/logger.ts:85-108`

Pino path redaction matches exact key names. The QA prompt explicitly
listed `calendarText` as a key the redaction must catch (along with
`bodyBattery`, `providerError`, `eventTitle`). My grep:

```
$ grep -n "calendarText" src/utils/logger.ts
(no output)
```

The list has `calendar`, `event`, `eventTitle`, `eventDescription`,
`eventBody`, `bodyBattery`, `providerError`, `providerResponse` — but
not `calendarText`. A Sentry event or log line emitting
`{ calendarText: "Doctor appointment with Dr. Smith @ 3pm" }` would
**not** be redacted. Same risk applies to any other
`calendar<Suffix>` / `event<Suffix>` / `provider<Suffix>` variants the
prompt didn't enumerate.

**Fix** (~6 lines):
```typescript
'calendarText',
'calendarBody',
'calendarSummary',
'body.calendarText',
'body.calendarBody',
'body.calendarSummary',
```

Or — preferable — switch to a Pino redaction *wildcard* pattern that
catches the family (`calendar*Text*`, etc.) once Pino's wildcard syntax
supports it for your version. Verify version compatibility before
swapping the approach.

### P2-2 — Route-boundary pin uses brittle string-contains

**File**: `__tests__/security/api-router-auth-boundary.test.ts`

The pin checks `publicSection.toContain("router.use('/auth'")` and
`protectedSection.toContain("router.use('${scopedSurface}'")` for each
scope. This breaks if:
- Anyone migrates `router.use('/auth', authRouter)` to backtick syntax
  (`router.use(\`/auth\`, authRouter)`).
- Anyone reformats to multi-line with the path on its own line:
  ```
  router.use(
    '/auth',
    authRouter,
  );
  ```
- Anyone introduces a variable: `const path = '/auth'; router.use(path, …)`.

None of these are security regressions — they're harmless refactors —
but they'd break the pin and CI would block on a non-issue.

**Fix** (~10 lines): switch to a regex that allows whitespace flexibility
and quote variation. For example:
```typescript
new RegExp(`router\\.use\\(\\s*[\`'"]${scope}[\`'"]\\s*,`)
```

Or move to an AST-based check using TypeScript's compiler API to walk
the actual `router.use(...)` call expressions. AST is heavier setup but
robust to all reformatting.

## P3 findings (informational, not blocking)

### P3-1 — Scorecard `id-token: write` while `publish_results: false`

**File**: `.github/workflows/security.yml:75-80`

Scorecard's job declares:
```yaml
permissions:
  contents: read
  security-events: write
  id-token: write
```

But `publish_results: false` is set on the action input, so OIDC-signed
publishing isn't actually used. `id-token: write` is unnecessary in this
configuration. Removing it would be strict least-privilege.

This is mostly harmless because no code path uses the token, but a more
defensive permissions list would drop it.

### P3-2 — Python 3.14 cannot build pydantic-core for current pin

**Reproduced**: a fresh `python3 -m venv` on this system (Python 3.14.2)
fails to install `pydantic==2.10.4` because pydantic-core has no wheel
for 3.14 and source build fails.

Codex's pinned setup uses `.venv313` (Python 3.13.3), which installs
cleanly. CI uses Python 3.11 per `.github/workflows/security.yml:18`,
which is also fine. So this is **not** a regression on the supported
Python versions.

But the implicit version constraint (must be Python ≤3.13 because of
pydantic-core) isn't documented anywhere obvious. A new contributor on
Python 3.14 would hit a confusing build failure. Adding a `python_requires`
hint to a `pyproject.toml` or a one-line note in `content-engine/README.md`
would close the friction.

### P3-3 — iOS scheme drift causes 1 known pre-existing failure

**File**: `Nexus HubTests/ReleaseHardeningConfigTests.swift:131`

`test_sharedSchemeDoesNotAllowParallelUITestSimulatorFanout` fails:
```
XCTAssertGreaterThanOrEqual failed: ("1") is less than ("2") —
Both unit and UI test bundles must explicitly disable scheme-level
parallelization. If the UI-test bundle loses this flag, Xcode can fan
out extra simulator runners.
```

The QA prompt explicitly says: "iOS full release-hardening class still
has a known pre-existing scheme drift failure; do not count that as a
regression in this wave unless the touched files caused it."

The touched files in this wave are `KeychainHelperTests.swift` and
`ReleaseHardeningConfigTests.swift`. The failure is at `:131` — but the
underlying issue is `.xcscheme` XML state (which this wave preserved
per QA prompt). The test file itself is just *checking* an unrelated
project file. Per prompt: **does not count as a regression.**

Net iOS: **55 passed / 1 failed** (1 pre-existing, not a wave
regression).

## Test scorecard (independently re-run)

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | PASS (exit 0) |
| Backend security focused sweep (11 files: chat-tier-gate, websocket-security, api-router-auth-boundary, url-guard, security-baseline-source-pins, log-sanitizer, error-tracker, logger-redaction, webhook-registry × 2, billing-routes) | **128/128 passing** |
| Auth/OAuth/APNs sweep (4 files) | **31/31 passing** |
| Content-engine pytest on Python 3.13 against new FastAPI 0.136.1 | **146/146 passing** |
| `npm audit --audit-level=high` | **0 vulnerabilities** |
| `npm run docs:audit` | PASS (exit 0; pre-existing warnings under ceiling) |
| iOS focused tests (KeychainHelperTests + ReleaseHardeningConfigTests + DeepLinkRouterTests) | **55 passed / 1 failed** (1 pre-existing scheme drift, per QA prompt) |
| **Hostile SSRF probe** | **19/25 — 6 IPv6 bypasses** (P0) |

## Per-area verification

### ✅ Tier-gate fail-closed error opacity

**File**: `src/api/routes/chat-message-tier-gate.ts:42-51`

```typescript
} catch (err) {
  logger.warn({ err, userId, domain }, 'iOS tier gate check failed — fail-closed');
  res.status(503).json({
    error: {
      code: 'ACCESS_CHECK_UNAVAILABLE',
      message: 'Nexus could not verify access for this request. Please try again.',
      details: { domain },
    },
  });
  return true;
}
```

- Internal err captured in logs (where Pino redaction applies)
- Client response carries safe code + generic message + `domain` only
- No raw error message leaked to client

### ✅ WebSocket Origin + rate-limit

**File**: `src/api/websocket.ts:47-60, 114-115, 138-139`

- `origin === 'null'` → rejected (`:50`)
- Native iOS no-Origin: allowed (`:49` — `if (!origin) return true`)
- Allowed origin list matched via normalized URL.origin (`:60`)
- Rate-limit per-connection budget at `:138-139`

The check at `:114-115` rejects upgrades before any handler runs, and
the rate-limit blocks message flood before JSON parsing.

### ✅ /api/v1 route-boundary pin

**File**: `__tests__/security/api-router-auth-boundary.test.ts` —
Meaningful structural pin. Asserts every scoped surface
(`/chat`, `/dashboard`, `/tasks`, `/training`, `/calendar`,
`/connections`, `/content`, `/cooking`, `/finance`, `/settings`,
`/decisions`, `/reports`) is mounted **after** `router.use(authMiddleware)`,
and that entitlement gates exist for training/content/finance. P2-2
above is about brittleness, not correctness.

### ✅ Log redaction precision

**File**: `src/utils/logger.ts:6-149`

Reasoned via grep: `tenantId`, `userId`, `reqId`, `traceId`,
`requestId`, `retryCount`, `attempt` — none are in `LOGGER_REDACTION_PATHS`.
Confirmed safe operational fields survive redaction. The logger
**attaches** `reqId`, `src`, `userId` at `:184-186` from `getCurrentContext()`,
which is the opposite of redaction — explicit operational visibility.

P2-1 above narrows this to one specific camelCase variant gap, not a
broad over-redaction problem.

### ✅ Completion ledger honesty

**File**: `docs/security/security-hardening-implementation-status.md`

Every BLOCKED row carries an **exact** concrete blocker reason:
- Cloudflare/VPS firewall: "Requires live Cloudflare/VPS changes and
  production/staging connectivity validation."
- Backup encryption: "Requires access to production backup storage and
  an approved restore-drill target."
- Mass-assignment migration: "Requires a route-contract migration
  across every mutation surface, compatibility review for existing iOS
  clients, and route-owner fixtures."
- Step-up auth/passkeys: "Requires product policy, auth-assurance
  metadata, UI prompts, and device testing."
- SQLCipher: "Requires data migration design, backup compatibility
  testing, performance validation, and deployment sequencing."
- Real APNs payload smoke: "Requires TestFlight/device APNs token and
  approved safe delivery proof."

No vague "deferred" hand-waving. Each blocker names what's required to
unblock it. Passes the hostile honesty test.

### ✅ Python upgrade runtime compatibility

Installed `fastapi==0.136.1` into `.venv313` from current
`requirements.txt`. All imports succeed:
```
fastapi: 0.136.1
uvicorn: 0.34.0
pydantic: 2.10.4
aiosqlite: 0.20.0
httpx: 0.28.1
dotenv module loaded
OK
```
Python tests: **146/146 passing** on the upgraded version. The runtime
upgrade is sound (on Python ≤3.13; see P3-2 for the 3.14 caveat).

## Edge cases verified

| Probe | Result |
|---|---|
| Tier gate throws in REST chat | ✅ Pinned by `__tests__/api/chat-message-tier-gate.test.ts` |
| Tier gate throws in WebSocket | ✅ Pinned by `__tests__/api/websocket-security.test.ts` |
| Tier gate throws in Telegram | ✅ via shared `sendChatTierRequiredIfNeeded` reachable from `src/handlers/message.ts` |
| WebSocket `Origin: null` | ✅ rejected at `src/api/websocket.ts:50` |
| WebSocket invalid Origin | ✅ try/catch around `new URL(origin)` rejects |
| WebSocket hostile suffix | ✅ exact-string match against allowed origin set |
| WebSocket message flood | ✅ rate-limit budget at `:138-139` |
| Sentry nested camelCase: `calendarText`, `bodyBattery`, `providerError`, `eventTitle` | ⚠ 3/4 covered; `calendarText` missing (P2-1) |
| URL: `http://`, `file://` | ✅ blocked (HTTPS-only) |
| URL: 127.0.0.1, 169.254.169.254, localhost | ✅ blocked |
| URL: `user:pass@example.com` | ✅ blocked (URL credentials) |
| URL: `youtube.com.evil.test`, `evil-youtube.com` | ✅ blocked (suffix matching is exact-tail) |
| **URL: bracketed IPv6** | ❌ **P0 — 6 vectors bypass** |
| Apple billing notification malformed/forged JWS | ✅ Pinned by `__tests__/security/billing-apple-notifications-jws-verify.test.ts` |
| Python pip-audit clean | ✅ Codex's earlier run + my install confirms |
| iOS pre-existing scheme drift | ✅ Reproduced; NOT a wave regression per QA prompt |

## Hand-off recommendation

**Stop and fix the IPv6 SSRF bypass before merge.** The fix is small
(3-line `normalizeHostname` change + 6 test cases) but **must land in
this wave**, not as a follow-up — the rest of the wave depends on the
SSRF guard being honest. P2-1 (calendarText redaction) and P2-2 (route
pin brittleness) can land in the same fix commit.

P3 items can be deferred to a hardening follow-up. P3-3 (iOS scheme
drift) is explicitly out of scope per the QA prompt.

**Re-validation after fix**: re-run the SSRF hostile probe script
(`node /tmp/sec-qa/ssrf-attack.mjs` after rebuild) — expect 25/25 pass.
Re-run the full focused security sweep — expect 128/128 (likely 130+
with new IPv6 cases). Then re-issue this hostile QA pass.

## Cleanup confirmation

- iOS xcscheme + project drift preserved (untouched).
- Docs/agents, smoke evidence, workspace mirror — all untouched.
- Eval bundles + test artifacts in `/tmp/sec-qa/` (out-of-tree).
- No production posting, ad spend, platform mutation, push, deploy, or
  TestFlight cut.
- iOS sim `A0B13967-…` ran only the named test targets.
- npm audit + pip-audit ran in fixture-mode only.
- Build artifacts in `dist/` were rebuilt to run the SSRF probe; this
  is a normal repeatable side-effect of `npm run build` and not a wave
  modification.

---

Generated 2026-05-14 by Claude Opus 4.7 (max effort).
