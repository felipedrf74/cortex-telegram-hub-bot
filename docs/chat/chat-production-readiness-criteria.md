# Chat Production Readiness Criteria

Date: 2026-04-29  
Release branch: `release/chat-tenant-safe-production-candidate`

## Readiness Standard

Chat is production-ready only when it is safe as the main interaction layer, not merely when messages can be sent. The release must preserve configurable provider routing, enforce tenant/user scope before retrieval and provider calls, avoid unsafe tool execution, and give iOS enough structured state to render outcomes honestly.

## Required Criteria

| Area | Criterion | Current Status |
| --- | --- | --- |
| Tenant isolation | Conversation, message, memory, context, and history queries are tenant/user scoped on the backend. | Met for REST Chat path; staging-clone migration proof passed. |
| Authorization | Chat routes and tool calls enforce auth, tenant/user ownership, and destructive confirmation before execution. | Met in tests. |
| Legacy data | Ambiguous legacy rows are quarantined, not broadly exposed. | Migration design met; staging-clone rehearsal passed. |
| Context engine | Prompt context is scoped, relevance-ranked, freshness/confidence-tagged, budgeted, and weak-context aware. | Met in deterministic tests. |
| Provider routing | Gemini/OpenAI/Anthropic-gated routing remains configurable; operator overrides are preserved. | Met. Final hardening fixed invalid model override validation. |
| Fallback safety | Fallback providers receive the same scoped context rather than rebuilding broader context. | Met in focused tests. No live-provider/fallback quality claim is made in this restrained release; bounded provider smoke is required before making one. |
| Prompt injection | Prompt injection cannot override tenant/tool authorization or leak hidden context. | Met in deterministic tests and eval harness. |
| Message lifecycle | Sent/completed/failed/canceled/retried states and idempotent client retries are represented. | Met in REST tests. |
| Streaming | Streaming transport has auth/tenant/retry parity or remains disabled. | Must remain disabled for this release. |
| Day-to-day quality | Multi-turn realistic simulations pass an acceptable rubric. | Met in fixture mode: 10 scenarios, average 1.93 / 2.00. |
| Evaluation harness | Red-team and response sufficiency suite is runnable. | Met in fixture mode: 24 scenarios, average 1.99 / 2.00. |
| iOS | iOS renders lifecycle, tool/skill metadata, confirmations, clarifications, and future-safe unknown metadata. | Met for DTO/rendering/local smoke; some live flows remain partial. |
| Portal | Portal diagnostics avoid raw content by default and expose metadata-only health. | Met for API diagnostics; portal UI and raw review policy remain future work. |
| Local full-product smoke | Full local backend/iOS smoke passes without production data or provider spend. | Met with documented limitations. |
| Resource cleanup | Local smoke stops backend, simulator, DB/token artifacts, and provider loops. | Met. |
| Rollback | Code rollback and DB snapshot/restore strategy are documented. | Documented in RC rollback plan; staging-clone rehearsal passed. A fresh production snapshot remains required before deploy. |

## Minimum Deployment Gate

Before production deployment, all of these must be true:

1. `npm run typecheck` passes.
2. `npm run build` passes.
3. Focused Chat/security/provider/portal regression suite passes.
4. `npm run chat:eval` passes with no P0/P1 fixture failures.
5. Day-to-day simulation passes.
6. Staging-clone rehearsal for migrations `084` and `085` remains linked and production snapshot is taken immediately before deploy.
7. `IOS_WS_ENABLED=false` is confirmed unless streaming parity is implemented. Staging and production currently leave it unset, which resolves to false.
8. Release copy avoids unsupported claims: no GPT-only claim, no true workspace switching claim, no streaming claim, no raw support-console claim.
9. Focused staging Chat smoke passes after staging deploy and before production promotion.

## Acceptance Threshold

- P0: none open.
- P1: fixed or explicitly accepted with rationale and a production guardrail.
- P2: tracked with owner/next step.
- P3: safe to defer.
