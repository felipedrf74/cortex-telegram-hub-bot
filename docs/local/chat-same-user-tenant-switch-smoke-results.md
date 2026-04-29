# Chat Same-User Tenant-Switch Smoke Results

Generated: 2026-04-29 22:50 WEST

Branch: `feature/content-editorial-mutation-contracts`

Mode: full local Nexus backend, isolated SQLite DB, fixture-mode model routing, no production data, no real provider calls.

## Verdict

Final verdict: **PASS WITH CONDITIONS**

No same-user cross-tenant leakage was observed. The live backend now fails closed when an iOS request tries to override the active tenant to a non-canonical tenant through `x-nexus-active-tenant-id` or `x-nexus-tenant-id`.

This is still not a claim that Nexus supports true same-user workspace switching. It proves the current safe behavior: active-tenant override attempts are rejected before Chat history, memory, prompt construction, or tool execution can use alternate-tenant data.

## Implementation Notes

- `authMiddleware` now detects explicit active-tenant override headers.
- A canonical header matching `tenantId == userId` is allowed.
- A non-canonical header is rejected with `403 FORBIDDEN`.
- A malformed active-tenant header is rejected with `403 FORBIDDEN`.
- The rejection records a tenant-scope anomaly with operation `ios_auth_active_tenant`.
- Existing default behavior remains backward compatible when no active-tenant header is present.

## Commands Run

```bash
npm test -- --run \
  __tests__/api/auth-middleware-device-revocation.test.ts \
  __tests__/api/chat-routes.test.ts \
  __tests__/state/shared-memory.test.ts \
  __tests__/state/user-isolation.test.ts
```

Result:

```text
4 test files passed
74 tests passed
```

```bash
npm run build
```

Result: PASS.

```bash
DATABASE_PATH=/tmp/nexus-chat-tenant-switch-smoke-20260429-2248.db \
PORTAL_PORT=8297 \
NEXUS_MODEL_FIXTURE_MODE=1 \
NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 \
npm start
```

Result: local backend started on `http://127.0.0.1:8297`.

```bash
CHAT_TENANT_SMOKE_BASE_URL=http://127.0.0.1:8297 \
DATABASE_PATH=/tmp/nexus-chat-tenant-switch-smoke-20260429-2248.db \
NEXUS_MODEL_FIXTURE_MODE=1 \
NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 \
node scripts/chat-tenant-security-smoke.js \
  --base-url http://127.0.0.1:8297 \
  --portal-admin-token local-chat-tenant-admin
```

Result:

```text
Verdict: PASS WITH CONDITIONS
Pass: 15
Partial: 1
Fail: 0
```

## Smoke Matrix

| Scenario | Expected result | Actual result | Result |
| --- | --- | --- | --- |
| Product health | Local iOS API reachable. | `/api/v1/` returned online. | PASS |
| Two local tenants/users | Tenant A/User A and Tenant B/User B are seeded locally. | User A `2`; User B `3`. | PASS |
| User A history | Tenant B marker not visible. | User A history excluded Tenant B marker. | PASS |
| User B history | Tenant A marker not visible. | User B history excluded Tenant A marker. | PASS |
| Memory scope | Active Tenant A memory excludes Tenant B and same-user alternate tenant rows. | No alternate marker returned. | PASS |
| Prompt context scope | Prompt block excludes Tenant B memory before provider call. | Prompt block stayed inside active tenant. | PASS |
| Vague follow-up after tenant switch | Ask/flag clarification and do not leak previous tenant context. | `tenant_boundary_requires_confirmation` emitted without markers. | PASS |
| Same-user active tenant override | Non-canonical active tenant header must fail closed. | `GET /chat/history` with `x-nexus-active-tenant-id: 3` returned `403`. | PASS |
| Canonical active tenant header | Canonical tenant header remains allowed. | `GET /chat/history` with `x-nexus-active-tenant-id: 2` returned `200`. | PASS |
| Prompt injection | Cannot reveal another tenant. | No Tenant B markers disclosed. | PASS |
| Attachment path | Does not disclose Tenant B content. | No Tenant B markers disclosed. | PASS |
| Tool callback | User A cannot trigger Tenant B scoped tool callback. | Foreign callback denied with `410`. | PASS |
| Admin diagnostics | Mismatched tenant diagnostics denied. | Portal diagnostics returned `403`. | PASS |
| Provider fallback | No real provider fallback call in this smoke. | Covered by focused unit tests, not live providers. | PARTIAL |

## Cleanup

Cleanup status: PASS.

```text
port 8297 stopped
temporary smoke database removed
```

## Open Conditions

| Condition | Status |
| --- | --- |
| True same-user workspace switching with membership-backed active tenants | Still open; do not claim support. |
| Live provider fallback path with real Gemini/OpenAI/Anthropic keys | Still open; this was fixture mode only. |
| iOS tenant-switch UI/cache smoke | Still separate; backend now rejects unsupported active-tenant overrides. |
| WebSocket streaming tenant scope | Still disabled/not claimed. |

## Release Gate Meaning

This smoke closes the previous ambiguity where an active-tenant header could be silently ignored. It does not close true workspace switching. Production copy and release notes should say active tenant switching is not enabled unless a membership-backed workspace model is implemented and smoked end to end.
