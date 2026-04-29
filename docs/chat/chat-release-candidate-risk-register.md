# Chat Release Candidate Risk Register

Date: 2026-04-29  
Release branch: `release/chat-tenant-safe-production-candidate`

## Risk Summary

| ID | Severity | Area | Risk | Status | Mitigation |
| --- | --- | --- | --- | --- | --- |
| CHAT-RC-P0-01 | P0 | Tenant leakage | Chat data could leak across tenants/users if REST query scope regresses. | Closed for current REST scope | Tests cover history, memory/context, routes, shared decision context, and local smoke user isolation. |
| CHAT-RC-P0-02 | P0 if enabled | WebSocket streaming | WebSocket path lacks release-proven auth/tenant/reconnect parity. | Guarded | Keep `IOS_WS_ENABLED=false`. |
| CHAT-RC-P0-03 | P0 if claimed | True workspace switching | Current canonical tenant model is `tenantId=userId`; no independent membership check. | Guarded | Do not claim true multi-workspace Chat; do not expose tenant switch UI as production capability. |
| CHAT-RC-P0-04 | P0 | Prompt injection tool/data leakage | User or retrieved content could attempt to override tenant/tool policy. | Closed in deterministic tests | Authorization runs outside the model; context is tagged as data-only; attacks refuse or clarify. |
| CHAT-RC-P1-01 | P1 | Migration readiness | `084` and `085` need predeploy apply/restore proof. | Closed for staging-clone proof | Rehearsal passed on 2026-04-29; take a fresh production DB snapshot immediately before deploy. |
| CHAT-RC-P1-02 | P1 | Live provider behavior | Fixture proof does not prove live provider fallback, latency, cost, or operator-pinned model quality. | Open claim gate | Run bounded real-provider smoke or avoid claims. |
| CHAT-RC-P1-03 | P1 | Tool invocation durability | No durable per-tool invocation lifecycle table. | Accepted with guardrail | Route idempotency and destructive confirmation cover current flows; add durable records before broad automation. |
| CHAT-RC-P1-04 | P1 | Attachments | Durable attachment/file scope and prompt-injection labeling are not release-proven. | Open for future attachment release | Keep durable attachments/support workflows out of scope. |
| CHAT-RC-P1-05 | P1 | Raw support review | Portal raw content review could expose private chats if added casually. | Controlled | Current portal diagnostics are metadata-only. |
| CHAT-RC-P1-06 | P1 | Migration filename history | Staging ledger contains `083_secretary_agenda_ledger.sql`; Chat originally also used prefix `083`. | Closed | Branch includes deployed `082`, recovered Secretary `083`, and renumbered Chat `084`/`085`; final staging-clone proof passed. |
| CHAT-RC-P2-01 | P2 | Local smoke repeatability | Full local Chat smoke uses documented commands, not a single runner. | Open | Add script/package command. |
| CHAT-RC-P2-02 | P2 | Provider observability completeness | Some one-shot/streaming paths still need tenant-aware attribution audit. | Open | Continue provider audit after REST release. |
| CHAT-RC-P2-03 | P2 | iOS live multi-skill fixtures | iOS renders rich metadata, but live local smoke did not emit all skill cards. | Open | Add backend fixture endpoints/responses. |

## Risk Decisions

1. **Do not block the RC for WebSocket streaming** because streaming remains disabled and is not part of release copy.
2. **Do not expose raw Chat support content** because metadata-only diagnostics provide operational value without privacy expansion.
3. **Do not block the RC for live provider quality** if release copy is restrained to architecture and deterministic safety. Live provider proof is required before claiming provider/fallback quality.
4. **Do not claim true multi-tenant workspace Chat** until active tenant membership exists.

## Fixed During Final Hardening

| Risk | Closure |
| --- | --- |
| Invalid operator model pin could break runtime routing. | `/api/model-config` validates model values against provider role-tier `MODEL_OPTIONS`; tests pass. |
| Chat tenant/lifecycle migration apply/restore unproven. | `084_chat_tenant_scope.sql` and `085_chat_message_lifecycle.sql` passed staging-clone online-backup, apply, backfill, scoped fixture, and restore proof. |

## Monitoring Signals After Release

- `CHAT_IDEMPOTENCY_CONFLICT` frequency.
- `message.lifecycle_state` stuck in `sent` or `streaming`.
- Provider fallback rate, provider errors, and cost spikes.
- Prompt-injection weak-context signal frequency.
- Tool authorization denial rate.
- Portal diagnostics error counts.
- Cross-user/tenant authorization denials.
- Chat history clear/archive anomalies.
