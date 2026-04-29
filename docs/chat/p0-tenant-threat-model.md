# P0 Chat Tenant Threat Model

Generated: 2026-04-29 11:52 WEST

Branch: `feature/chat-p0-tenant-security-audit`

## Security Objective

Chat must never expose, retrieve, prompt, mutate, summarize, stream, cache, or log data outside the authenticated user's authorized tenant and resource scope. This must be enforced by backend authorization, scoped data access, scoped retrieval, tool policy, and audited operator access. The model provider must never receive unauthorized context and must never be treated as a security boundary.

## Assets

| Asset | Sensitivity | Notes |
| --- | --- | --- |
| Conversations and messages | High | User private requests, actions, corrections, plans, and potentially sensitive personal/work context. |
| Message chunks/stream events | High | Same sensitivity as messages; interruption/reconnect can create stale scope risks. |
| Shared memory | High | Stable preferences, personal facts, tenant facts, corrections, and unresolved commitments. |
| Daily context cache | High | Calendar, tasks, training, content, readiness, and planning summaries. |
| Callback payloads | High | Encapsulate actions for tasks, coach recommendations, and future destructive operations. |
| Tool calls and skill invocations | High | Can mutate calendars, tasks, plans, finance records, and content workflows. |
| Attachments/images | High | Receipts, calendars, tasks, invoices, screenshots, private documents. |
| Provider prompts and tool outputs | High | May contain merged cross-skill context and private user/tenant data. |
| Portal diagnostics | Medium to high | Metadata-only today, but still exposes user IDs, tenant IDs, message counts, failures, and lifecycle state. |
| Provider usage rows | Medium | Cost/latency/provider metadata can identify user activity patterns. |
| iOS local cache | High | Stores visible conversation messages on device across account/tenant switches. |

## Trust Boundaries

1. iOS app to backend REST API
   - Trust is established by JWT plus device-session check in `authMiddleware`.
   - Current tenant is derived from `userId`.

2. iOS app to backend WebSocket
   - Currently disabled.
   - If enabled, it uses a separate JWT path and does not carry tenant scope.

3. Backend chat route to prompt/model provider
   - Authorization and context selection must happen before any provider call.
   - Provider routing is live and configurable; Gemini/OpenAI/Anthropic paths must all receive the same scoped context.

4. Backend chat route to tools/skills
   - Tool authorization must happen outside model output.
   - Tools must inherit authenticated tenant/user scope.

5. Backend to portal/admin/support
   - Admin/support access requires explicit role/scope and audit.
   - Metadata-only diagnostics are safer but not sufficient for tenant admin features.

6. Backend to external providers
   - Calendar, Microsoft Todo, Gmail/Outlook, and other integrations must be user/tenant scoped.
   - Global provider services are unsafe when action payloads come from chat callbacks.

## Actor Model

| Actor | Capability | Security concern |
| --- | --- | --- |
| Authenticated user | Send messages, load history, press callbacks, upload attachments. | Must not access another user/tenant's chat, memory, tools, or callback actions. |
| Same human across tenants | Switch workspaces or ask vague follow-ups. | Must not leak previous tenant context into active tenant. |
| Malicious authenticated user | Guess/replay callback refs, prompt inject, ask for another tenant's data. | Backend must deny before retrieval/tool/model use. |
| Tenant admin | May need aggregate diagnostics. | Must not casually see private user chat content without policy and audit. |
| Platform operator | Can inspect support diagnostics. | Access must be scoped, audited, and metadata-minimized. |
| Compromised/stale client cache | Holds old messages/callback refs. | Backend must reject unauthorized callbacks and stale tenant context. |
| Model provider | Receives scoped prompts and returns text/tool calls. | Provider must not receive unauthorized data; model output cannot authorize actions. |

## Primary Attack Paths

### 1. Callback replay or cross-user callback use

Path:

1. User A receives a chat task card with callback `td:tc:<ref>`.
2. The ref leaks through a screenshot, local cache, logs, proxy, or client compromise.
3. User B submits the same callback to `/api/v1/chat/callback`.
4. Backend validates User B is authenticated, but retrieves callback payload by ref only.
5. Backend performs task/list action using global Microsoft Todo service.

Current control:

- Authenticated route requires a user.
- Callback TTL exists.

Gap:

- Callback state has no tenant/user/message ownership.
- Destructive task callbacks are not scoped to the authenticated user's provider.
- Ref entropy is short.

Severity: P0.

### 2. WebSocket enabled without tenant/auth parity

Path:

1. Operator enables `IOS_WS_ENABLED=true`.
2. Client connects to `/ws`.
3. WebSocket verifies JWT directly and stores only `userId`.
4. Routing, domain handlers, prompt context, stream frames, and tool calls do not receive tenant ID.

Current control:

- Disabled by default and release docs say keep disabled.
- iOS release path forces REST-only.

Gap:

- If enabled, it is a separate, weaker transport.

Severity: P1 while disabled, P0 if enabled.

### 3. Future active tenant header accepted without membership

Path:

1. Product adds active tenant/workspace selection.
2. Caller supplies a tenant ID.
3. `resolveChatTenantScope` accepts any positive tenant ID.
4. Chat reads/writes or prompt context is built under an unauthorized tenant.

Current control:

- iOS does not currently supply active tenant; auth sets `tenantId=userId`.

Gap:

- No membership model in the chat scope helper.

Severity: P1 now; P0 when true tenant switching is introduced.

### 4. Prompt context cross-tenant contamination

Path:

1. Prompt context cache row is tenant-scoped.
2. Source reads inside the builder still query user-owned source tables only.
3. Same user in two tenants gets mixed task/calendar/training/content context.

Current control:

- Tenant currently equals user.
- Shared memory and conversation history are tenant-scoped.

Gap:

- Source-of-truth tables are not uniformly tenant-aware.
- Global `user_id=0` content rows may be treated as user context.

Severity: P1 for true multi-tenant release.

### 5. Attachment prompt/provider metadata misses tenant

Path:

1. User uploads receipt/calendar/task image.
2. Attachment classifier sends image and caption to provider with user ID only.
3. Provider usage and fallback metadata lose tenant attribution.

Current control:

- Attachment is not persisted as durable file in current chat path.
- REST persistence of the final assistant response is tenant-scoped.

Gap:

- Provider call metadata is not tenant-complete.

Severity: P1 for attachment-heavy or multi-tenant release.

### 6. Portal/support metadata visibility without tenant/audit depth

Path:

1. Operator calls chat diagnostics.
2. User diagnostics filter by user ID only and expose all that user's tenant buckets.
3. Operator scopes may be optional in single-owner mode.

Current control:

- Requires portal admin token.
- Recent messages are metadata-only and expose text length, not raw text.

Gap:

- No tenant-specific user diagnostics route.
- Access audit is not explicit in the inspected route.

Severity: P1 for multi-operator support tooling.

### 7. Provider fallback or direct fallback losing tenant observability

Path:

1. Normal provider routing is unavailable.
2. Legacy direct Anthropic fallback runs.
3. Prompt was scoped before call, but provider usage metadata loses tenant ID.

Current control:

- Tool execution still receives tenant where provided.
- Normal provider path carries tenant metadata.

Gap:

- Direct fallback uses legacy positional arguments.

Severity: P2.

## Required Controls

| Control | Required behavior | Current state |
| --- | --- | --- |
| Backend authorization before retrieval | Validate auth, active tenant, membership, user/resource ownership before loading chat data. | REST chat mostly yes under tenant=user; active membership missing. |
| Backend authorization before prompt construction | No unauthorized context reaches model. | Main REST path mostly scoped; daily source reads not tenant-aware for true workspace model. |
| Tool authorization outside the model | Model output cannot authorize a tool call. | Main tool executor has scoped guard; callback actions bypass this. |
| Callback ownership | Callback ref must be tenant/user/message/action scoped and replay-protected. | Missing. |
| WebSocket parity | Same auth/session/tenant guarantees as REST. | Missing; disabled. |
| Tenant-scoped memory | Memory cannot cross tenants/users. | Implemented for `shared_memory` after migration `084`. |
| Tenant-scoped retrieval/vector | Retrieval must namespace by tenant/user before returning context. | No durable chat vector table found; must be required for future work. |
| Attachment safety | Attachments must have tenant/user scope, size/type policy, provider metadata, and prompt-injection handling. | Partial; no durable file table found, but provider metadata lacks tenant. |
| Admin/support audit | Every user/tenant diagnostic access is role-scoped and audited. | Partial; metadata-only diagnostics exist, explicit access audit not proven. |
| iOS cache partitioning | Local state clears on account/tenant switch and unknown stream chunks cannot cross scope. | REST cache scoped by user=tenant; streaming nil scope while disabled. |
| Provider fallback consistency | Fallback must reuse the same scoped prompt/context and preserve tenant metadata. | Normal provider path good; direct fallback metadata gap. |

## Release Guidance

Do not ship or claim:

- true workspace/tenant switching,
- WebSocket chat streaming,
- raw support/admin chat visibility,
- durable chat attachments,
- cross-tenant shared chat,
- tenant-aware vector retrieval,
- scoped callback action safety,

until the matching blockers in `p0-tenant-open-blockers.md` are closed.

For a narrow REST-only chat release, the minimum security condition is:

1. Scoped callback actions fixed or disabled.
2. `IOS_WS_ENABLED=false`.
3. No true workspace switching claim.
4. Portal remains metadata-only.
5. Focused staging chat smoke verifies chat history, prompt context, callbacks, and tenant denial paths.
