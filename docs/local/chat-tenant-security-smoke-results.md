# Chat Tenant Security Local Smoke Results

Generated: 2026-04-29 12:04 WEST

Branch: `feature/chat-p0-tenant-security-audit`

Mode: full local Nexus backend, focused Chat tenant-isolation smoke, fixture-first, no production data, provider keys blanked.

## Final Verdict

Verdict: **PASS WITH CONDITIONS**

No cross-tenant leakage was observed. This is not marked plain PASS because true same-user multi-workspace tenant switching is intentionally not supported by the current iOS Chat ingress, and live real-provider fallback was not exercised. The current safe production model remains canonical `tenantId == userId`.

Latest addendum, 2026-04-29 22:50 WEST: same-user active-tenant override attempts are now explicit fail-closed behavior instead of being silently ignored. A focused live local smoke on `http://127.0.0.1:8297` passed 15 checks, left 1 provider-fallback condition partial, and returned `403 FORBIDDEN` when User A attempted to read Chat history with `x-nexus-active-tenant-id` set to Tenant B. Canonical `x-nexus-active-tenant-id == userId` remains allowed. See `docs/local/chat-same-user-tenant-switch-smoke-results.md`.

## Local Runtime

Backend was run locally on:

```text
http://127.0.0.1:8210
```

Local DB:

```text
data/chat-tenant-security-smoke.db
```

Provider/resource controls:

```text
NEXUS_LOCAL_ALLOW_MODEL_CALLS=0
GEMINI_API_KEY=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
ANTHROPIC_ENABLED=false
```

Migration state:

```text
086_chat_callback_scope.sql applied
```

Full product surfaces checked on the same local backend:

```text
Dashboard, plan today, plan week, task lists, today tasks, training summary,
training today, content pipeline, content intelligence, meal plan, finance
monthly summary, connections, inbox
```

All 13 authenticated API smoke routes passed.

## Commands Run

```bash
FULL_NEXUS_STATE_DIR=.local/chat-tenant-security-smoke \
PORTAL_PORT=8210 \
FULL_NEXUS_BASE_URL=http://127.0.0.1:8210 \
DATABASE_PATH=/Users/felipedominguez/Desktop/Custom\ Connectors/Cortex/cortex-telegram-hub-bot/data/chat-tenant-security-smoke.db \
FULL_NEXUS_RESET_DB=1 \
scripts/full-nexus-local-engine.sh cleanup
```

```bash
FULL_NEXUS_STATE_DIR=.local/chat-tenant-security-smoke \
PORTAL_PORT=8210 \
FULL_NEXUS_BASE_URL=http://127.0.0.1:8210 \
DATABASE_PATH=/Users/felipedominguez/Desktop/Custom\ Connectors/Cortex/cortex-telegram-hub-bot/data/chat-tenant-security-smoke.db \
IOS_INVITE_CODE=local-chat-tenant-smoke \
PORTAL_ADMIN_TOKEN=local-chat-tenant-admin \
PORTAL_ALLOW_LOCAL_BYPASS=false \
NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 \
scripts/full-nexus-local-engine.sh up
```

```bash
CHAT_TENANT_SMOKE_BASE_URL=http://127.0.0.1:8210 \
IOS_INVITE_CODE=local-chat-tenant-smoke \
PORTAL_ADMIN_TOKEN=local-chat-tenant-admin \
DATABASE_PATH=/Users/felipedominguez/Desktop/Custom\ Connectors/Cortex/cortex-telegram-hub-bot/data/chat-tenant-security-smoke.db \
node scripts/chat-tenant-security-smoke.js \
  --base-url http://127.0.0.1:8210 \
  --invite-code local-chat-tenant-smoke \
  --portal-admin-token local-chat-tenant-admin
```

```bash
npx vitest run \
  __tests__/domains/domain-handler.test.ts \
  __tests__/services/chat-context-engine.test.ts \
  __tests__/utils/callback-store.test.ts \
  __tests__/services/tool-executor.test.ts \
  __tests__/api/chat-callback-routes.test.ts \
  __tests__/api/chat-message-attachments.test.ts \
  __tests__/portal/portal-chat-routes.test.ts \
  __tests__/portal/chat-diagnostics.test.ts
```

```bash
xcodebuild test \
  -project "Nexus Hub.xcodeproj" \
  -scheme "Nexus Hub" \
  -sdk iphonesimulator \
  -destination "platform=iOS Simulator,name=iPhone 17 Pro" \
  -only-testing:"Nexus HubTests/ChatRepositoryTests"
```

```bash
FULL_NEXUS_STATE_DIR=.local/chat-tenant-security-smoke \
PORTAL_PORT=8210 \
FULL_NEXUS_BASE_URL=http://127.0.0.1:8210 \
DATABASE_PATH=/Users/felipedominguez/Desktop/Custom\ Connectors/Cortex/cortex-telegram-hub-bot/data/chat-tenant-security-smoke.db \
IOS_INVITE_CODE=local-chat-tenant-smoke \
PORTAL_ADMIN_TOKEN=local-chat-tenant-admin \
PORTAL_ALLOW_LOCAL_BYPASS=false \
NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 \
scripts/full-nexus-local-engine.sh smoke
```

## Smoke Result Matrix

| Scenario | Expected result | Actual result | Pass/fail | Notes |
| --- | --- | --- | --- | --- |
| Product health | Local iOS API reachable. | `/api/v1/` returned online. | PASS | Full local backend, not production. |
| Local tenants/users | Seed Tenant A/User A and Tenant B/User B. | Final run seeded Tenant A/User A `8`, Tenant B/User B `9`. | PASS | Current canonical tenant is user id. |
| User A cannot see Tenant B conversations | User A history excludes Tenant B marker. | User A history excluded unique Tenant B marker. | PASS | HTTP route. |
| User B cannot see Tenant A conversations | User B history excludes Tenant A marker. | User B history excluded unique Tenant A marker. | PASS | HTTP route. |
| User A cannot retrieve Tenant B memory | Active Tenant A memory/context excludes Tenant B rows. | Direct local context probe excluded both other-user Tenant B memory and same-user alternate-tenant memory. | PASS | Service probe because no public memory read API exists. |
| Prompt construction scope | Prompt context excludes Tenant B memory before model/provider call. | `buildChatPromptContext` block stayed inside active tenant. | PASS | No provider call. |
| Vague follow-up after tenant switch | Requires clarification and does not leak previous tenant context. | `tenant_boundary_requires_confirmation` weak signal emitted; no Tenant B marker present. | PASS | Same-user tenant switch is not enabled through iOS ingress. |
| Prompt injection | Does not reveal other tenant conversation/memory/tool context. | Injection response returned 200 degraded/local response with no Tenant B marker. | PASS | Provider keys blanked. |
| Attachment access | User A cannot access Tenant B attachment content. | Attachment path stayed authenticated/scoped and disclosed no Tenant B marker. | PASS | Durable attachment store is not part of this release claim. |
| Tool on Tenant B resource | User A callback cannot mutate Tenant B scoped resource. | Foreign scoped callback denied with `410`. | PASS | Scoped callback ref created for Tenant B, replayed by User A. |
| Admin/support cross-tenant diagnostics | Portal user diagnostics reject mismatched tenant scope. | `/api/users/8/chat-diagnostics?tenantId=9` returned `403`. | PASS | Metadata-only portal path with admin token. |
| Tenant switch invalidates iOS cache | iOS repository replaces scoped cache after scope change. | `ChatRepositoryTests` passed, including `test_loadHistory_replacesCachedMessagesWhenTenantScopeChanges`. | PASS | XCTest, no iOS code changes. |
| Provider fallback path | Fallback receives scoped tenant/user metadata. | Focused `domain-handler.test.ts` passed. | PASS by unit test | No real provider fallback call. |
| Multi-tenant user where supported | Same-user multi-workspace should not leak. | Not supported by current iOS Chat ingress; route guard canonicalizes `tenantId=userId`. | PARTIAL | Do not claim true workspace switching. |
| Platform/admin user where supported | Admin/support access should be scoped/audited. | Portal diagnostics mismatch denied; audit tests passed. | PASS for current metadata-only support path | No raw chat admin review claimed. |

## Automated Smoke Summary

`scripts/chat-tenant-security-smoke.js` final run:

```text
Verdict: PASS WITH CONDITIONS
Pass: 12
Partial: 2
Fail: 0
Tenant A/User A: 8
Tenant B/User B: 9
```

Focused backend tenant tests:

```text
Test Files: 8 passed
Tests: 140 passed
```

iOS focused cache tests:

```text
ChatRepositoryTests: 8 passed
** TEST SUCCEEDED **
```

Full authenticated API smoke:

```text
ALL 13 AUTHENTICATED SMOKE TESTS PASSED
```

## Provider Usage

Real provider calls used: NO.

This smoke intentionally used blank provider keys and deterministic/local degraded paths. It validated that scoped prompt construction and fallback metadata plumbing remain safe, but it did not validate live Gemini/OpenAI/Anthropic response quality or live fallback behavior.

## Cleanup Confirmation

Cleanup commands/results:

```text
scripts/full-nexus-local-engine.sh cleanup
```

```text
backend: not running
content engine: not running
Removed local smoke DB: data/chat-tenant-security-smoke.db
Cleanup complete.
```

Post-cleanup verification:

```text
No 8210 listener
No booted simulators
No matching smoke/backend process
No local smoke auth token
No local smoke DB file
```

Cleanup status: PASS.

## Open Conditions

| Condition | Release impact |
| --- | --- |
| True same-user workspace tenant switching is not supported. | Do not claim workspace tenant switching for Chat. |
| Same-user active-tenant override attempts now fail closed. | This is safe for the current release, but still not true workspace switching support. |
| Live provider fallback was not called with real providers. | Do not claim live fallback quality from this smoke; run bounded staging/provider smoke if needed. |
| Durable attachment store is not part of this release claim. | Attachment smoke only proves authenticated Chat attachment path did not leak cross-tenant markers. |
| WebSocket streaming remains disabled for release. | Do not enable Chat WebSocket until scoped streaming lifecycle/idempotency smoke exists. |

## Final Release Gate Meaning

This smoke supports staging validation of the focused P0/P1 Chat tenant-safety patch. It does not, by itself, approve a broad Chat product release with true workspaces, WebSocket streaming, raw support conversation review, or live-provider quality claims.
