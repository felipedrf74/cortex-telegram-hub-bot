# Chat Risk Register

Generated: 2026-04-29 03:30 WEST  
Branch: `feature/chat-tenant-safe-context-orchestration`

## Risk Table

| ID | Severity | Area | Risk | Status | Recommended action |
| --- | --- | --- | --- | --- | --- |
| CHAT-P0-01 | P0 | Persistence release | Tenant-scoped message/conversation/memory fixes are in the working tree but not yet production-applied. | Staging-clone proof closed | `084`/`085` rehearsal passed; take fresh production snapshot, then follow release path. |
| CHAT-P0-02 | P0 if enabled | WebSocket | Experimental `/ws` Chat path lacks REST auth parity, tenant ID, and revoked-device checks. | Gated by default | Keep `IOS_WS_ENABLED=false` or fix before enablement. |
| CHAT-P0-03 | P0 if product supports multi-workspace | Auth/session | Active tenant is inferred as `userId`; no independent tenant membership check. | Open | Add active tenant claim/selection and membership authorization before workspace switching. |
| CHAT-P1-01 | P1 | Domain handlers | Domain handlers and tool loops are user-only. | Closed in branch | Tenant is now passed through Chat execution, Secretary/simple-domain handlers, and tool calls. |
| CHAT-P1-02 | P1 | Prompt context | Daily/shared/Secretary context caches are user-only. | Closed in branch | Cache keys/tables now include tenant where Chat consumes them. |
| CHAT-P1-03 | P1 | Shared memory tools | Store is tenant-aware, but tool execution does not pass tenant. | Closed in branch | Shared-memory tool set/remove now inherit tenant scope and have tests. |
| CHAT-P1-04 | P1 | Sensitive logs | Some logs include raw user text or previews. | Partially closed | High-risk Chat route/tool logs touched in this pass now log lengths/keys. Wider non-Chat prompt logs still need audit. |
| CHAT-P1-05 | P1 | Model audit | AI usage lacked tenant ID and often lost user ID for provider-domain calls. | Partially closed | Domain calls now carry optional user/tenant metadata; streaming and some one-shot paths still need a wider audit. |
| CHAT-P1-06 | P1 | Export/privacy | Data export reads some Chat memory by user only. | Closed in branch | Export filters Chat conversations/shared memory by active canonical tenant/user scope. |
| CHAT-P1-07 | P1 | Provider fallback | Fallback providers receive scoped context, but future fallback code could rebuild broader context. | Guardrail open | Keep context construction before provider selection and add regression tests. |
| CHAT-P1-08 | P1 | Attachments | Attachment model calls lack durable scoped audit if an image action later mutates data. | Open | Add scoped attachment/tool audit before write-capable attachment flows. |
| CHAT-P1-09 | P1 | Prompt injection | Retrieved/memory content could previously include tag-breaking instructions inside the context block. | Closed in branch | Context item bodies are escaped and labeled `instruction_authority="data_only"`; prompt-injection attempts create weak-context signals. |
| CHAT-P1-10 | P1 | Cross-tenant peer context | Shared-decision context cached by tenant but underlying mesh readers were user-scoped. | Closed in branch | Non-canonical tenant IDs now return empty peer context until tenant-aware mesh readers exist. |
| CHAT-P1-11 | P1 | Tool user injection | Some tools accepted explicit `user_id`; mismatch could be silently rewritten to the authenticated user. | Closed in branch | Explicit user mismatch now rejects the tool call instead of rewriting. |
| CHAT-P2-01 | P2 | Interaction quality | Day-to-day Chat simulation harness needed to test realistic multi-turn sufficiency. | Closed in branch | Deterministic fixture harness now covers 11 personas, 10 A-J scenarios, 28 turns, rubric scoring, failure taxonomy, iOS envelope shape, tenant switch, prompt injection, and retry/dedupe behavior. |
| CHAT-P2-02 | P2 | iOS readiness | iOS Chat rendering for rich/degraded/streaming states is partially audited, but true tenant switching/live streaming remain out of scope. | Partial | Keep iOS claims limited to DTO/render/local-smoke evidence; add persistent simulator/XCUITest later. |
| CHAT-P2-03 | P2 | Portal/web | Portal diagnostics are metadata-only and privacy-safe; no full support console exists. | Partial | Keep raw content review out of scope until permission, consent, redaction, and audit exist. |
| CHAT-P2-04 | P2 | Routing docs drift | Historical comments imply Claude/GPT/Gemini fixed behavior. | Open | Clean comments after behavior is locked. |
| CHAT-P3-01 | P3 | UX polish | Chat can answer but may not always explain skill/action source. | Open | Add action/source metadata and frontend rendering later. |

## Current Readiness

Current readiness for the REST Chat release: **GO WITH CONDITIONS** per `docs/chat/chat-final-production-go-no-go.md`.

The backend working tree has meaningful tenant-scope, lifecycle, prompt-injection, and tool-authorization hardening, plus staging-clone migration proof and local smoke evidence. It still does not have WebSocket hardening, active tenant membership, durable tool invocation lifecycle, or live-provider/fallback quality proof.

## Security Principle

Provider routing, model intelligence, and prompt instructions are not security controls. Tenant isolation must be enforced in:

- auth/session
- data queries
- memory retrieval
- context cache keys
- tool authorization
- file/attachment access
- persistence
- audit records
