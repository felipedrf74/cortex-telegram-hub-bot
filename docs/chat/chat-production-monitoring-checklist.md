# Chat Production Monitoring Checklist

Date: 2026-04-29
Release branch: `release/chat-tenant-safe-production-candidate`

## Chat Lifecycle

- chat creation failures
- message send failures
- stuck messages in `sent` or `streaming`
- failed/canceled/retried lifecycle-state rates
- duplicate messages
- repeated retries
- `CHAT_IDEMPOTENCY_CONFLICT` rate
- chat history read failures
- degraded response rate

## Streaming Posture

- `IOS_WS_ENABLED` remains unset/false
- unexpected WebSocket connection attempts
- streaming failures if any non-iOS/internal stream exists
- old `streaming` rows repaired to failed rather than left active

## Tool, Skill, And Routing

- tool-call failures
- skill routing failures
- confirmation-required rate
- failed tool retry rate
- unusually high tool-continuation volume
- domain/skill selected per request
- task tier selected: `classify`, `chat`, `toolUse`, `tool continuation`
- destructive action attempts without confirmation

## Tenant, Retrieval, And Security

- tenant authorization failures
- unusual cross-tenant access attempts
- retrieval/memory scope failures
- prompt-injection/security events
- unauthorized tool-call attempts
- mismatched explicit `user_id` in tool inputs
- ambiguous legacy/quarantined Chat row access attempts
- stale tenant cache reports after auth or tenant changes
- unauthorized attachment/file access attempts if any attachment path is enabled
- tenant/user-safe logging only
- no raw sensitive prompt/context/message/tool-output leakage

## iOS

- Chat decode/render errors
- unknown metadata fallback frequency
- failed/retry state rendering issues
- confirmation/clarification rendering errors
- stale cache reports after auth changes
- local cache scope reset after sign-out

## Provider And Model Operations

- provider selected per request
- model selected per request
- category tag
- domain/skill
- operator override applied or not
- fallback used or not
- fallback reason
- provider failure rate
- model latency
- token/cost estimate where available
- runaway call loops
- unusually high classification volume
- unusually high tool-continuation volume
- provider circuit breaker open/half-open/closed state
- Anthropic emergency fallback activation if enabled

## Response Quality

- response insufficiency rate if measurable
- clarification rate
- user correction rate
- failed memory retrieval rate
- stale context detection rate
- low-confidence context rate
- support/operator diagnostic error rate

## Release-Scope Guardrails

- no public/product claim of true workspace switching
- no public/product claim of production WebSocket streaming readiness
- no public/product claim of live provider fallback quality unless bounded provider smoke is later run
- no raw Chat support-console access without future role, consent, redaction, and audit work
