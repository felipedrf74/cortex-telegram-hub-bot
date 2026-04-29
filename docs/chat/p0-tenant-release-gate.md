# P0 Chat Tenant Release Gate

Generated: 2026-04-29 12:04 WEST

Branch: `feature/chat-p0-tenant-security-audit`

## Verdict

Final verdict: **PASS WITH CONDITIONS**

No cross-tenant leakage remains in the tested current Chat release scope.

This is not a plain PASS because:
- current iOS Chat does not support true same-user workspace tenant switching, though active-tenant override attempts now fail closed;
- real provider fallback was not invoked with live provider keys;
- WebSocket streaming remains disabled and not part of this release claim.

## Evidence Summary

| Gate | Evidence | Result |
| --- | --- | --- |
| Backend local product health | Full local backend started on `127.0.0.1:8210`; migrations through `086_chat_callback_scope.sql` applied. | PASS |
| Full product API smoke | Existing authenticated local smoke passed 13/13 iOS API surfaces. | PASS |
| User A cannot see Tenant B conversations | Local smoke seeded User A/Tenant A and User B/Tenant B; history markers did not cross. | PASS |
| User A cannot retrieve Tenant B memory | Local service/context probe showed active Tenant A excludes Tenant B memory rows before prompt construction. | PASS |
| User A cannot access Tenant B attachments | Authenticated attachment path returned scoped/degraded result with no Tenant B marker. | PASS |
| User A cannot trigger tools on Tenant B resources | Tenant B scoped callback replay by User A returned `410`. | PASS |
| Tenant switch invalidates local/iOS cache | `ChatRepositoryTests` passed, including scoped history replacement and scoped clear-history cutoff. | PASS |
| Vague follow-up after tenant switch | Context builder emitted tenant-boundary clarification signal and did not include previous tenant memory. | PASS |
| Same-user active-tenant override | `x-nexus-active-tenant-id` for a non-canonical tenant returns `403` before Chat history/context/tool access. | PASS |
| Prompt injection cannot reveal another tenant | Live local prompt-injection request disclosed no Tenant B markers; context-engine red-team tests passed. | PASS |
| Provider fallback path remains tenant-safe | `domain-handler.test.ts` verifies fallback receives scoped `{ userId, tenantId }`. | PASS by focused test |
| Admin/support access | Portal user diagnostics reject mismatched tenant scope and audit tests passed. | PASS |
| Cleanup | Backend stopped; DB/auth artifacts removed; no listener/process/simulator remained. | PASS |

## Commands Proving Gate

```bash
node scripts/chat-tenant-security-smoke.js \
  --base-url http://127.0.0.1:8210 \
  --invite-code local-chat-tenant-smoke \
  --portal-admin-token local-chat-tenant-admin
```

Result:

```text
PASS WITH CONDITIONS
Latest same-user tenant-switch smoke: 15 pass / 1 partial / 0 fail
Earlier full tenant-security smoke: 12 pass / 2 partial / 0 fail
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

Result:

```text
8 test files passed
140 tests passed
```

```bash
xcodebuild test -project "Nexus Hub.xcodeproj" -scheme "Nexus Hub" -sdk iphonesimulator -destination "platform=iOS Simulator,name=iPhone 17 Pro" -only-testing:"Nexus HubTests/ChatRepositoryTests"
```

Result:

```text
8 ChatRepositoryTests passed
```

```bash
scripts/full-nexus-local-engine.sh smoke
```

Result:

```text
13/13 authenticated API smoke tests passed
```

## Conditions Before Production

Required before production promotion:

1. Take a fresh production DB snapshot immediately before deployment.
2. Rehearse migration `086_chat_callback_scope.sql` against a staging/predeploy clone.
3. Deploy the candidate to staging.
4. Run focused staging Chat smoke for scoped callbacks, tenant guard, task callback provider ownership, portal diagnostics, and attachment degraded path.
5. Confirm `IOS_WS_ENABLED=false` unless scoped WebSocket lifecycle hardening is complete.
6. Confirm release copy does not claim true workspace tenant switching.
7. Confirm release copy does not claim live-provider fallback quality from this local fixture smoke.

## Accepted Scope

This release gate supports:
- current iOS REST Chat tenant isolation with canonical `tenantId == userId`;
- explicit fail-closed rejection for non-canonical active-tenant override headers;
- scoped callbacks and callback replay denial;
- tenant-safe prompt construction before provider calls;
- tenant-safe memory/context retrieval for active scope;
- prompt-injection non-disclosure in local fixture mode;
- metadata-only portal diagnostics with tenant mismatch denial.

This release gate does not support:
- true same-user multi-tenant workspace switching;
- WebSocket Chat streaming release;
- raw support/admin review of private conversations;
- durable attachment/file lifecycle claims;
- live Gemini/OpenAI/Anthropic fallback quality claims;
- broad Chat product-quality release claims.

## Recommendation

Proceed to staging validation for the focused P0/P1 tenant-safety patch.

Do not promote to production until the conditions above are complete. Do not mark this as a broad Chat GO; it is a scoped tenant-security gate.
