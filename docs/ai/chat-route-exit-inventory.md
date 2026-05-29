# Chat Route Exit Inventory

**Generated:** 2026-05-27
**Work Order:** `docs/qa/work-orders/WO-chatcore-v2-production-activation.md`
**Branch:** `codex/chatcore-v2-production-activation-wo`
**Base commit:** `e5ca0034`
**Scope:** `src/api/routes/chat-message-routes.ts`

This is the Phase 0 inventory of current chat exits. Its job is to make the
strangler migration reviewable: every route that can answer, preview, execute,
or bypass natural-language ownership must be explicitly retained, adapted, or
retired.

Replacement status legend:

- **keep pre-V2:** explicit deterministic surface remains outside NL chat.
- **V2 owns NL:** ordinary natural-language ownership moves to ChatCoreV2.
- **V2 adapter:** existing deterministic behavior becomes a ChatCoreV2 adapter.
- **legacy fallback:** allowed temporarily with reason-coded telemetry.
- **retire after parity:** disable only after Phase 8 gates.

Line numbers are approximate anchors from `src/api/routes/chat-message-routes.ts`
at base commit `e5ca0034`.

| ID | Approx line | Current owner/path | Can answer | Can preview/execute | Current role | Planned V2 replacement |
|---|---:|---|---|---|---|---|
| R01 | 529 | auth guard | no | no | rejects unauthenticated chat requests | keep pre-V2 |
| R02 | 534 | malformed body guard | no | no | rejects invalid request bodies | keep pre-V2 |
| R03 | 543 | empty text/no attachment guard | no | no | returns empty-message error | keep pre-V2 |
| R04 | 590 | confirmation token validation | no | no | rejects invalid/expired confirmation token | keep pre-V2 |
| R05 | 594 | completed confirmation replay | yes | no | deterministic idempotent replay | keep pre-V2 |
| R06 | 600 | `claimPendingChatCoreV2Command` | yes | execute | executes pending ChatCoreV2 command confirmation | keep pre-V2, already V2 |
| R07 | 667 | legacy decision-center confirmation | yes | execute | executes older pending confirmation actions | V2 adapter, then retire after parity |
| R08 | 746 | request shape validation | no | no | rejects invalid chat payload | keep pre-V2 |
| R09 | 785 | idempotency replay lookup | yes | no | replays previous response for same idempotency key | keep pre-V2 |
| R10 | 833 | new-user local response | yes | no | onboarding deterministic response | V2 adapter or keep pre-V2 if explicit onboarding |
| R11 | 889 | `tryBuildTokenZeroChatMessageShortcutResponse` | yes | no | token-zero natural-language shortcut | V2 owns NL; explicit button/slash variants may remain |
| R12 | 922 | `tryBuildChatCoreV2DeterministicReadRoute` | yes | no | existing ChatCoreV2 deterministic read shortcut | V2 adapter, keep and fold into orchestrator |
| R13 | 975 | chat quota guard | no | no | cost-cap rejection | keep pre-V2 |
| R14 | 977 | `runChatCoreV2ShadowRouteHook` | no | no | current shadow route hook | extend for Phase 2 plan-only shadow |
| R15 | 1006 | `tryBuildChatCoreV2CommandPreviewRoute` | yes | preview | existing V2 command preview route | keep and route through new orchestrator |
| R16 | 1063 | legacy action planner | yes | preview/execute | legacy NL planner and confirmation path | legacy fallback, then retire after parity |
| R17 | 1176 | cached action planner response | yes | no | deterministic cached response replay | keep only if tied to idempotency, else V2 adapter |
| R18 | 1182 | attachment processing | yes | no | attachment domain handling | V2 adapter with evidence binding |
| R19 | 1243 | authenticated identity fast path | yes | no | deterministic identity response | keep pre-V2 or V2 adapter |
| R20 | 1266 | `tryBuildFastPathChatResponse` | yes | no | deterministic/NL fast path | split: explicit surfaces keep; NL moves to V2 |
| R21 | 1295 | natural-language training plan shortcut | yes | no | route-order shortcut for plan creation | V2 owns NL |
| R22 | 1348 | internet research route | yes | no | web research model/tool path | V2 adapter with evidence and cloud policy |
| R23 | 1420 | accept-current decision handling | yes | execute | legacy confirmation/decision execution | V2 adapter, then retire after parity |
| R24 | 1499 | destructive action confirmation guard | yes | preview | stops risky actions for confirmation | keep policy, expose through command bus |
| R25 | 1601 | `routeMessage` classifier | no | no | Gemini/OpenAI/Ollama-shadow domain classifier | V2 owns NL route decision after Phase 2 |
| R26 | 1636 | tier gate after classifier | no | no | subscription/entitlement gate | keep pre-V2 |
| R27 | 1641 | missing handler fallback | yes | no | unsupported/degraded response | V2 response-contract unsupported path |
| R28 | 1647 | `tryBuildChatMessageShortcutResponse` | yes | no | post-classifier shortcuts | V2 owns NL; explicit shortcuts can remain |
| R29 | 1687 | `executeChatDomainHandler` | yes | execute possible | domain handler owns final answer/tool flow | V2 adapter via `DomainAdapterV1` |
| R30 | 1763 | degraded retryable response | yes | no | fallback response on retryable model/domain errors | V2 degraded response contract |
| R31 | final catch | route error handler | yes | no | generic request failure handling | keep pre-V2, add reason-coded V2 telemetry |

## Immediate Findings

1. `chat-message-routes.ts` is the current orchestration choke point. It owns
   auth, validation, idempotency, deterministic shortcuts, token-zero NL
   shortcuts, ChatCoreV2 hooks, legacy action planning, internet research,
   classifier routing, tier gates, domain handlers, and degraded fallback.
2. Existing ChatCoreV2 hooks are already present, but they are currently
   selective routes, not the single natural-language owner.
3. Token-zero logic is mixed: explicit deterministic surfaces should remain,
   while ordinary natural-language shortcuts must move behind ChatCoreV2.
4. Domain handlers are still answer owners. Phase 8 retirement requires each
   domain handler path to become a deterministic adapter before it is disabled.
5. Legacy action planner paths are too powerful to delete first. They need a
   reason-coded fallback wrapper until parity is proven.

## Phase 1 Follow-Up

- Add owner labels for each row: explicit surface, NL shortcut, deterministic
  read, action preview, action execution, cloud/tool research, domain handler,
  fallback/error.
- Attach route rows to golden corpus examples.
- Add a replacement flag for each row before Phase 8:
  `legacy_exit_replaced`, `legacy_exit_shadow_only`, or `legacy_exit_active`.
- Peer validation must confirm no user-visible exit was missed.
