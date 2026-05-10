# F-A TenantId Source Audit

Status: CURRENT
Date: 2026-05-10
Round: Round E Part 0
Verdict: DOWNGRADE_TO_WAVE_2_PREP

## Summary

Hostile QA flagged that the Python content-engine accepts `tenant_id` from
request bodies. The exploitable condition would require a Node caller to pass a
client-supplied `tenantId`/`tenant_id` through to the Python service.

Audit result: no app-facing Node caller was found passing a request-body
tenantId into Python content-engine. The only Node wrapper that emits
`tenant_id` to Python is `getScript(...)`, and the iOS/API script route passes
JWT-derived `tenantId` from `AuthenticatedRequest`.

Recommended follow-up: add bearer-token or signed internal-service middleware
to Python content-engine in Wave 2 prep so Python does not trust unauthenticated
direct callers even if Node callers remain safe.

## Engine Fetch Inventory

| File:line | Python endpoint | Tenant source | Verdict |
|---|---|---|---|
| `engine/src/services/content-engine.ts:281` | `/deepsearch` | No `tenant_id` emitted. Inputs are query/niches only. | clean |
| `engine/src/services/content-engine.ts:288` | `/sources` | No `tenant_id` emitted. Query string only. | clean |
| `engine/src/services/content-engine.ts:293` | `/hotnews` | No `tenant_id` emitted. Creator payload only. | clean |
| `engine/src/services/content-engine.ts:307` | `/trending` | No `tenant_id` emitted. Niche query only. | clean |
| `engine/src/services/content-engine.ts:311` | `/reaction` | No `tenant_id` emitted. Topic query only. | clean |
| `engine/src/services/content-engine.ts:318` | `/hooks` | No `tenant_id` emitted. Topic/niche/count only. | clean |
| `engine/src/services/content-engine.ts:573` | `/script` | `tenant_id` is the `tenantId` argument to `getScript(...)`. App-facing route passes JWT-derived `tenantId`; legacy Telegram shortcuts omit it or use canonical user ID. | clean for Wave 1; harden Python auth in Wave 2 |
| `engine/src/services/content-engine.ts:609` | `/titles` | No `tenant_id` emitted. Topic/niche/count only. | clean |
| `engine/src/services/content-engine.ts:617` | `/thumbnail` | No `tenant_id` emitted. Title/niche only. | clean |
| `engine/src/services/content-engine.ts:625` | `/caption` | No `tenant_id` emitted. Topic/niche only. | clean |
| `engine/src/services/content-engine.ts:635` | `/competitor` | No `tenant_id` emitted. Channel/max_videos only. | clean |
| `engine/src/services/content-engine.ts:642` | `/gaps` | No `tenant_id` emitted. Niche/max_gaps only. | clean |
| `engine/src/services/content-engine.ts:650` | `/seo` | No `tenant_id` emitted. Topic only. | clean |
| `engine/src/services/content-engine.ts:658` | `/repurpose` | No `tenant_id` emitted. Topic/original_format only. | clean |
| `engine/src/services/content-engine.ts:677` | `/feedback` | No `tenant_id` emitted. Feedback metrics only. | clean |
| `engine/src/services/content-engine.ts:684` | `/report` | No `tenant_id` emitted. Period query only. | clean |

## App-Facing Route Callers

| File:line | Caller | Tenant source | Verdict |
|---|---|---|---|
| `engine/src/api/routes/content-script-routes.ts:67` | `POST /api/v1/content/script` | `const { userId, tenantId } = req as AuthenticatedRequest`; body destructuring excludes `tenantId`; `getScript(..., userId, ..., tenantId)` at lines 166-183. | clean |
| `engine/src/api/routes/content.ts:94` | `POST /api/v1/content/discover` | `const { userId, tenantId } = req as AuthenticatedRequest`; `runContentDiscovery({ userId, tenantId })` at line 100. No Python content-engine `tenant_id` body path. | clean |
| `engine/src/api/routes/chat-message-shortcuts.ts:110` | Chat content script shortcut | Uses authenticated `userId`; no request-body tenantId and no `tenant_id` emitted because `tenantId` argument is omitted. | clean for spoofing; future multi-tenant improvement |

## Telegram / Scheduled Callers

| File:line | Caller | Tenant source | Verdict |
|---|---|---|---|
| `engine/src/handlers/commands/content.ts:194` | Telegram content discovery | `resolveCanonicalUserId(ctx.from.id)` then `{ userId: canonicalUserId, tenantId: canonicalUserId }`. Not client-body controlled. | clean |
| `engine/src/handlers/commands/content.ts:957` | Telegram video study | `resolveCanonicalUserId(ctx.from.id)` then `{ userId: canonicalUserId, tenantId: canonicalUserId }`. Not client-body controlled. | clean |
| `engine/src/handlers/commands/content.ts:135,1008,1039` | Legacy Telegram script helpers | Omit explicit tenantId; `getScript` therefore emits no `tenant_id`. | clean for spoofing; legacy default-tenant behavior |
| `engine/src/services/manual-report-triggers.ts:63` | Manual content reports | Uses configured manual report target `{ userId, tenantId }`, not HTTP body. | clean |

## Notable Non-Python Adjacent Caller

`engine/src/api/routes/content-admin-write.ts` accepts admin/portal scope from
query/body in `resolveScopeTarget(...)`, but this route is for scoped portal
content-admin operations and the audited `addAndAnalyzeChannel(...)` path does
not call Python content-engine. It is not the F-A Python `tenant_id` source
finding.

## Follow-Up

- Wave 2 prep: require a signed internal service credential on Python
  content-engine endpoints and reject direct unauthenticated calls.
- Future multi-tenant cleanup: thread explicit tenantId through legacy Telegram
  script helpers and chat content shortcut, even though neither currently
  accepts tenantId from a client body.
