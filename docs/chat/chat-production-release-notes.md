# Chat Production Release Notes

Date: 2026-04-29
Release branch: `release/chat-tenant-safe-production-candidate`
Backend version: `4.14.99`

## What Changed

This release hardens Nexus Chat as a tenant-safe REST interaction layer:

- Chat conversations and messages now carry tenant/user scope, visibility scope, lifecycle state, created-by metadata, and migration backfill/quarantine handling.
- Chat history, persistence, memory/context retrieval, shared memory, tool calls, and route-level execution now enforce backend scope before model prompt construction or tool execution.
- Message lifecycle now supports completed, failed, canceled, retried, idempotent replay, and stuck-state repair helpers for the REST path.
- Chat prompt construction now uses scoped context metadata: source, freshness, confidence, relevance, permission requirements, data-only labels, weak-context handling, and prompt-injection isolation.
- Skill routing now preserves Secretary/Training/Cooking/Finance/Content ownership boundaries and requires confirmation for destructive actions.
- Provider routing remains configurable and provider-agnostic; this release does not hardcode GPT, Gemini, Claude, OpenAI, Anthropic, or any single provider.
- Portal diagnostics are metadata-only and intentionally do not expose raw messages, prompts, memory values, tool output, attachments, or provider bodies.
- iOS Chat can decode/render richer lifecycle, tenant, tool-call, skill-result, confirmation, clarification, grounding, memory, and unknown future metadata states.

## User Impact

Users should see safer and more reliable Chat behavior:

- Chat history is less likely to leak across users or tenant scope.
- Retries are safer and less likely to duplicate messages or actions.
- Assistant responses can show richer action status, skill attribution, and decision metadata.
- Degraded model/provider cases should be honest instead of pretending an action succeeded.

## Tenant And Security Impact

The release strengthens backend-enforced tenant/user boundaries:

- Conversations/messages are scoped in data and route access.
- Ambiguous legacy Chat rows are quarantined instead of broadly exposed.
- Tool calls reject mismatched user scope.
- Prompt injection cannot override authorization because authorization happens outside the model.
- Provider fallback receives already-scoped context rather than rebuilding broader context.

## iOS Chat Behavior Changes

- Rich Chat response metadata renders without crashing.
- Unknown future lifecycle or metadata values fall back safely.
- Local Chat cache is scoped by user/tenant key and can be invalidated on future tenant switches.
- The app can render streaming lifecycle metadata, but live WebSocket streaming remains disabled for this release.

## Portal/Web Behavior Changes

- Portal Chat diagnostics are limited to operational metadata.
- Raw Chat content review is not part of this release.
- Broader support-console Chat visibility requires a future role, consent, redaction, and audit model.

## Skill Routing Changes

- Chat coordinates skill requests but does not become a bypass around skill ownership.
- Secretary remains the schedule/arbitration owner.
- Training, Cooking, Finance, and Content retain ownership of their domain content.
- Destructive requests require confirmation before execution.

## Memory And Context Changes

- Context items are scoped, attributed, ranked, and labeled as data-only before prompt construction.
- Weak or stale context should trigger clarification or uncertainty instead of hallucinated certainty.
- Memory/context retrieval is tenant/user scoped for the current released stores.

## Model Routing / Provider Behavior

This release preserves configurable live routing:

- No fixed-model claim is made.
- No GPT-only, Gemini-only, Claude-only, OpenAI-only, or Anthropic-only claim is made.
- Operator overrides and domain/tier routing remain part of the architecture.
- Bounded real-provider fallback/operator-pin quality proof was not run, so release copy must not claim live provider quality or fallback-performance improvements.

## Known Limitations

- WebSocket streaming is not production-ready and must remain disabled: `IOS_WS_ENABLED=false` or unset.
- True multi-workspace Chat is not released; current canonical scope remains one tenant per user.
- Durable tool invocation records are future work; current release relies on route-level idempotency and confirmation gates.
- Durable attachment storage/support inspection is out of scope.
- Live vector-store namespace smoke is out of scope until vector retrieval is configured.
- Live provider wording/fallback/operator-pin quality was not smoke-tested with real calls.

## Rollback Instructions

1. Stop promotion if staging Chat smoke fails.
2. Keep or restore `IOS_WS_ENABLED=false`.
3. Restore code to the prior production commit using the standard rollback script.
4. Restore the predeploy production DB snapshot if migration rollback is required.
5. Verify `/api/v1/auth/me`, `/api/v1/chat/history`, and a safe deterministic `/api/v1/chat/message` request.
6. Confirm cross-user Chat history access remains denied.
