# Nexus Hub Release Candidate Risk Register

Generated: 2026-04-29

## Verdict

**PASS WITH CONDITIONS.** No P0 regression was reproduced in local verification. The release candidate is not cleared for unconditional production promotion until the P1 release gates are closed or explicitly accepted with narrowed release scope.

## P0 Production Blockers

No active P0 blocker was reproduced during this RC test run.

The following remain automatic P0 blockers if observed before or during deployment:

| ID | Risk | Trigger | Required action |
|---|---|---|---|
| NH-RC-P0-01 | Cross-tenant Chat leakage | Any conversation, message, memory, retrieval, attachment, tool call, or prompt context crosses tenant/user boundaries | Stop release; fix and rerun tenant isolation suite |
| NH-RC-P0-02 | Unauthorized provider context | Any Gemini/OpenAI/Anthropic/fallback path receives unauthorized tenant/user context | Stop release; fix prompt/context builder before provider call |
| NH-RC-P0-03 | Unsafe support/admin chat access | Raw private Chat content becomes visible without explicit permission and audit | Stop release; enforce permission/audit or remove path |
| NH-RC-P0-04 | Failed staging smoke | Focused staging smoke fails on exact RC commit | Do not promote; fix and rerun staging |
| NH-RC-P0-05 | No fresh DB snapshot | Production deploy begins without immediate predeploy snapshot | Stop deploy; snapshot first |

## P1 Must-Fix Or Must-Accept

| ID | Area | Risk | Evidence | Current disposition |
|---|---|---|---|---|
| NH-RC-P1-01 | Staging | Focused staging Chat smoke has not been run for this exact RC branch/commit | This RC run was local only | Must run before production promotion |
| NH-RC-P1-04 | Same-user multi-workspace Chat | True same-user multi-workspace tenant switching remains partial | Tenant smoke had 2 partial cases | Do not claim complete tenant switching until implemented/smoked |
| NH-RC-P1-05 | Provider fallback | Live provider fallback was covered by unit/fixture paths, not a live bounded provider failure | Local smoke used fixture behavior | Run bounded staging/provider smoke before claiming live fallback quality |
| NH-RC-P1-06 | WebSocket streaming | WebSocket reconnect/streaming transport remains not fully enabled/smoked | Local smoke used REST/local fast path | Do not claim production WebSocket streaming |
| NH-RC-P1-07 | Secretary universal ownership | Not every calendar/skill write path is proven to pass through Secretary ownership | Existing Secretary release gate | Limit claims to tested Secretary/Training paths |
| NH-RC-P1-08 | Shared context mesh | Some shared-context storage/readers remain user/default-tenant constrained rather than fully tenant-scoped | Existing shared-context gate | Limit claims or close mesh tenant gaps |
| NH-RC-P1-09 | Model-routing off paths | Streaming/proxy/legacy attribution gaps remain outside the central happy path | Existing AI routing gate | Preserve routing; do not claim complete observability for off paths |

## Closed Since Initial RC Package

| ID | Area | Closure | Evidence |
|---|---|---|---|
| NH-RC-P1-02 | Local runner | Detached `start` now launches `node dist/index.js` directly, verifies the backend PID after readiness, and tails backend logs on startup failure. | `bash -n` plus detached start/health/auth-token/smoke/cleanup passed; authenticated API smoke 13/13. |
| NH-RC-P1-03 | iOS structured Chat state | `local_grounded` is now treated as a known structured metadata type in iOS, avoiding the unknown-type fallback card while preserving grounding facts and memory hints. | Focused `ChatStructuredCardRenderingTests` passed 3/3. |

## P2 Should-Fix

| ID | Area | Risk | Recommendation |
|---|---|---|---|
| NH-RC-P2-01 | Swift concurrency | iOS tests emit Swift 6 actor/sendable warnings | Clean before App Store hardening to reduce future compiler friction |
| NH-RC-P2-02 | Local DB migration replay | Stale local smoke DB produced duplicate-column migration failure | Keep `FULL_NEXUS_RESET_DB=1` in local smoke or make migrations idempotent for local fixtures |
| NH-RC-P2-03 | Content engine local seed | Local fixture startup may warn when content engine is unavailable | Keep fixture expectations explicit or start content engine in full smoke |
| NH-RC-P2-04 | Portal diagnostics | Portal/support readiness is metadata-first and raw content access is intentionally absent | Fine for current scope; revisit before support tooling launch |
| NH-RC-P2-05 | XCUITest breadth | iOS simulator smoke was focused and manual/tool-driven, not exhaustive XCUITest UI automation | Add XCUITests for Chat/Secretary rich states |
| NH-RC-P2-06 | Calendar universal repair | Provider-side stale/duplicate repair outside tested ownership paths remains conditional | Expand Secretary ledger adoption before universal claims |

## P3 Deferrable

- Release-note polish after final deployment scope is chosen.
- Additional day-to-day simulation personas beyond the current fixture bank.
- Provider cost dashboard refinements.
- Portal analytics for response sufficiency, correction rate, and clarification rate.

## Security Notes

- Live model routing must remain configurable and provider-agnostic. This RC must not introduce release copy or code that claims GPT, Gemini, Claude, or any single provider as the fixed Nexus runtime model.
- Tenant/user authorization must happen before retrieval, tool execution, prompt construction, and provider fallback.
- No raw prompts, private message text, provider tokens, finance details, calendar details, or cross-skill private context should be logged in production diagnostics.

## Release Recommendation

Advance this branch only as a **restrained release candidate**. Production promotion remains blocked until staging smoke, fresh DB snapshot, push/merge discipline, and production health checks are complete.
