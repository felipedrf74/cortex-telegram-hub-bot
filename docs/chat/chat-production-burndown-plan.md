# Chat Production Burndown Plan

Date: 2026-04-29  
Release branch: `release/chat-tenant-safe-production-candidate`  
Source branch: `feature/chat-tenant-safe-context-orchestration`  
Base commit: `a3f1b78`

## Executive Summary

The Chat release candidate is ready for production-gate review with conditions. The REST Chat path now has backend-enforced tenant/user scope, scoped history and memory access, destructive-action confirmation, tool authorization checks, tenant-safe context construction, deterministic day-to-day simulation coverage, metadata-only portal diagnostics, and iOS rich-state rendering support.

The release must not be promoted until the remaining deployment gates are closed: a fresh production DB snapshot immediately before deployment, WebSocket streaming confirmed disabled, staging deployment completed, and focused staging Chat smoke passed. Release copy now avoids live-provider/fallback quality claims, so bounded live-provider proof is optional for this restrained REST Chat release.

Migration packaging note: production and staging both have `082_training_session_identity_shape_hash.sql` applied, and that file is now included in this branch. Staging also has `083_secretary_agenda_ledger.sql` in its migration ledger; the release branch now includes the recovered `083` file and Chat migrations are renumbered to `084`/`085`, so the migration prefix issue is closed.

## P0 Production Blockers

No unresolved P0 blocker remains for the current REST Chat release scope, provided these release constraints hold:

- `IOS_WS_ENABLED` remains disabled in production.
- Product copy does not claim true multi-workspace Chat switching. Current canonical tenant behavior is still `tenantId = userId`.
- Production deployment applies recovered `083_secretary_agenda_ledger.sql` where missing, plus `084_chat_tenant_scope.sql` and `085_chat_message_lifecycle.sql`, through the normal migration path after the passed staging-clone rehearsal and a fresh production DB snapshot.
- No raw Chat content support-console surface is enabled.

| Default P0 Area | Status | Evidence |
| --- | --- | --- |
| Cross-tenant chat access | Closed for REST path | `__tests__/api/chat-history-routes.test.ts`, `__tests__/state/user-isolation.test.ts`, local smoke separate-user history check. |
| Cross-tenant memory/retrieval | Closed for current scoped stores | `__tests__/services/chat-context-engine.test.ts`, `__tests__/services/shared-decision-context.test.ts`; live vector store is not enabled. |
| Unauthorized attachment access | No durable attachment endpoint in this release | Attachment audit remains P1 before durable attachment support or support tooling. |
| Unauthorized tool call | Closed | `__tests__/services/tool-executor.test.ts`; destructive/external-send tools require confirmed tenant/user scope. |
| Tenant switch stale cache leakage | Closed at repository/iOS cache layer; live UI switch absent | iOS `ChatRepositoryTests`; no visible tenant switch UI is released. |
| Missing backend authorization on Chat data | Closed for REST routes | Chat history/message routes enforce authenticated scope before data retrieval. |
| Prompt injection causing data/tool leakage | Closed in deterministic harness | Prompt injection, malicious retrieved content, and cross-tenant attacks refuse or clarify. |
| Ambiguous legacy Chat rows exposed broadly | Closed by migration design; staging-clone proof passed | `scope_status='quarantined'` for ambiguous rows in migration `084`; rehearsal documented in `docs/chat/chat-migration-084-085-rehearsal.md`. |
| Provider fallback passing unauthorized context | Closed in tests for scoped context handoff | `__tests__/services/provider-fallback-domain-routing.test.ts` and context-engine tests. |
| Model-routing change forces a single provider | Closed | Live provider routing preserved; `/api/model-config` now validates model pins against `MODEL_OPTIONS`. |

## P1 Must Fix Or Explicitly Accept Before Production

| ID | Item | Current State | Release Action |
| --- | --- | --- | --- |
| CHAT-P1-02 | WebSocket/streaming posture | Streaming UI can render states, but backend WebSocket parity is not proven. | Keep `IOS_WS_ENABLED=false`; do not release streaming claims. |
| CHAT-P1-03 | Bounded live-provider routing/fallback proof | Fixture eval passes; no real provider calls in local smoke; release copy avoids live-provider quality/fallback claims. | Accepted for this restrained REST release; run bounded provider smoke before claiming live-provider quality or fallback behavior. |
| CHAT-P1-04 | Durable tool invocation lifecycle | Route-level idempotency prevents duplicate Chat actions; no durable tool-call table yet. | Accept for this REST release if destructive actions remain confirmation-gated; implement durable tool records before broader automation. |
| CHAT-P1-05 | Attachment/file scope audit | No durable attachment store was released; image/runtime attachments need audit before support workflows. | Keep attachment support conservative; add scoped audit before durable attachment release. |
| CHAT-P1-06 | Admin/support raw-content workflow | Portal exposes metadata-only diagnostics, not raw content. | Accept safe default; build raw support only with consent, policy, role, redaction, and audit. |
| CHAT-P1-07 | Active tenant membership | Current auth maps tenant to user; no independent workspace membership. | Do not claim true workspace switching; add membership before multi-tenant workspace UI. |

## P2 Should Fix If Low Risk

| ID | Item | Status |
| --- | --- | --- |
| CHAT-P2-01 | Restore a single `scripts/chat-full-nexus-local-smoke.sh` runner. | Manual local smoke command worked, but repeatability should improve. |
| CHAT-P2-02 | Add deterministic local Chat fixtures for Cooking, Content, Finance, and Training rich tool cards. | iOS render tests cover cards; live local Chat emitted Secretary/task path only. |
| CHAT-P2-03 | Add tenant-aware provider usage attribution for remaining one-shot/streaming paths. | Domain calls are improved; wider audit remains. |
| CHAT-P2-04 | Add live vector namespace smoke when vector retrieval is configured locally. | Current retrieval proof is fixture/unit level. |
| CHAT-P2-05 | Add audited read events for portal diagnostics. | Mutations are audited; metadata diagnostics read audit can improve support traceability. |

## Closed Since RC Packaging

| ID | Item | Closure |
| --- | --- | --- |
| CHAT-P1-01 | Predeploy migration proof for `084` and `085`. | Passed against a disposable staging clone on 2026-04-29. Live staging DB was unchanged; `migrated-proof.db`, restored `clone.db`, snapshot, and manifest are preserved under `/home/dominguez/telegram-hub-bot-staging/data/release-rehearsal/chat-084-085/20260429T081648Z`. |
| CHAT-P1-07 | Migration file history alignment. | `082` and recovered Secretary `083` are included; Chat migrations are `084`/`085`; final staging-clone proof passed. |

## P3 Deferrable

- Rename historical `classifyWithClaude` compatibility names after release.
- Add persistent provider circuit breaker state only if incidents justify it.
- Polish Chat lifecycle and tool-card copy after backend contracts stabilize.
- Add portal UI for Chat diagnostics after API schema survives one release.

## Completed In Final Hardening

- Closed model override validation risk: `/api/model-config` now rejects model values outside the provider role-tier `MODEL_OPTIONS` list.
- Added tests for invalid model rejection and wrong-tier model rejection.
- Re-ran release-candidate regression suite: 26 test files / 683 tests passed.
- Re-ran typecheck, build, fixture evaluation harness, day-to-day simulation, and whitespace diff check.

## Recommended Sequence

1. Review this RC branch and docs.
2. Take a fresh production DB snapshot immediately before deployment.
3. Keep production env `IOS_WS_ENABLED` unset/false.
4. Merge to `main`.
5. Deploy to staging and run focused Chat smoke.
6. Promote to production only after staging health and rollback checkpoints are clean.
7. Run bounded live-provider smoke later before any release copy or monitoring claim about live-provider quality/fallback behavior.
