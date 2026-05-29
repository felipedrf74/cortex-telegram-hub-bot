# ChatCoreV2 Layer 1 Assembly Map

**Generated:** 2026-05-27
**Work Order:** `docs/qa/work-orders/WO-chatcore-v2-production-activation.md`
**Branch:** `codex/chatcore-v2-production-activation-wo`
**Base commit:** `e5ca0034`

Layer 1 is the deterministic prepass. It produces hints only. It cannot route,
answer, execute, or call an LLM. This document maps each planned prepass
responsibility to existing services so implementation extends the repo instead
of creating another chat owner.

## Assembly Table

| Layer 1 responsibility | Existing owner(s) to reuse | Current status | Target output |
|---|---|---|---|
| Request normalization | `src/api/routes/chat-message-request.ts`, `src/api/routes/chat-message-routes.ts` | already in route | normalized text, attachments, locale, IDs |
| Explicit command/button recognition | `chat-message-shortcuts.ts`, `chat-state-shortcuts.ts`, `chat-shortcut-parsers.ts`, inline button/confirmation routes | mixed explicit and NL logic | explicit-surface hints only; NL shortcuts move behind V2 |
| Pending confirmation detection | `chat-pending-confirmations.ts`, `chat-confirmation-token.ts`, `chat-core-v2/pending-commands.ts` | present | pending command/confirmation hint |
| Idempotency/replay | `chat-message-execution.ts`, confirmation replay handling in route | present | replay hint, never planner-owned |
| Capability candidate selection | `chat-skill-capability-registry.ts`, `chat-core-v2/capability-registry.ts`, `chat-core-v2/tool-selection.ts` | split registries | 3-8 recall-biased candidate capability IDs |
| Active context hints | `chat-turn-context.ts`, route active-domain memory, `chat-context-compiler.ts` | fragmented | active domain, active entity candidates, recent-turn summary |
| Reference candidates | `chat-core-v2/entity-resolution.ts`, current active context/pending confirmation records | primitives present | candidates for "it", "that", "same", "other one" |
| High-risk signals | `finance-action-policy.ts`, `training-safety-policy.ts`, destructive confirmation policy in route | present but route-scattered | risk signals, not decisions |
| Tier-0/Tier-1 context | `chat-context-compiler.ts`, `chat-turn-context.ts`, deterministic read routes | present outside V2 | bounded context packet inputs |
| Locale hint | `chat-core-v2/locale-policy.ts`, request metadata | present | normalized locale hint |
| Prepass miss logging | new implementation needed | absent | HMAC message hash, locale, candidates, final capability, reason codes |

## Deterministic Constraint Audit

The prepass must not call model providers. A direct grep of the candidate
Layer 1 inputs found:

- `chat-context-compiler.ts`: no direct provider/model call imports found.
- `chat-turn-context.ts`: no direct provider/model call imports found.
- `chat-skill-capability-registry.ts`: no direct provider/model call imports found.
- `chat-skill-orchestrator.ts`: heuristic/regex-heavy; no direct provider
  import in the scanned file, but it currently behaves like a chat owner and
  should become hint evidence only.
- `chat-message-shortcuts.ts`: imports `completeOneShotWithFallback`; this is
  not allowed inside Layer 1. Explicit deterministic shortcuts may remain
  pre-V2, but NL/model-backed shortcuts must move behind ChatCoreV2.
- `chat-action-fixer-worker.ts`: uses Anthropic for repair work and must stay
  outside Layer 1.

## Candidate Selection Algorithm

Layer 1 candidate recall is intentionally biased toward inclusion:

1. Keyword index maps verbs and nouns to likely capabilities.
2. Active thread anchor includes capabilities from recent domains.
3. Pending confirmation capability is always included.
4. High-risk keywords include the relevant safety capability.
5. Ambiguous pronouns widen across active domains from the last 24 hours.
6. Sentinel capabilities are always present: clarify reference, unsupported,
   and general help.

Candidate set bounds:

- target: 3-8 capabilities
- hard max: 8 capabilities
- if more than 8 candidates score equally, preserve pending confirmation,
  high-risk, active-domain, then most recent domain order

## Prepass Output Contract

```ts
type ChatCoreV2PrepassHints = {
  schemaVersion: 'chat_core_v2_prepass_hints@1.0.0';
  tenantId: string;
  userId: string;
  surface: 'ios' | 'web' | 'telegram_legacy' | 'internal';
  locale: 'en' | 'pt-PT' | 'pt-BR' | 'es' | 'mixed' | 'unknown';
  messageHash: string; // HMAC, not raw text
  candidateCapabilityIds: string[]; // 3-8 target, max 8
  activeDomainHint?: string;
  highRiskSignals: string[];
  referenceCandidates: Array<{
    entityType: string;
    entityIdHmac: string;
    labelSafe?: string;
    confidence: number;
    source: 'pending_confirmation' | 'recent_turn' | 'read_model' | 'memory';
  }>;
  pendingConfirmationId?: string;
  tier0ContextHash: string;
  tier1ContextHash?: string;
  reasonCodes: string[];
};
```

## Non-Negotiable Rules

- Layer 1 output is advisory. `buildChatCoreV2RouteDecision` remains
  authoritative after the planner emits its bounded plan.
- Layer 1 cannot answer.
- Layer 1 cannot execute.
- Layer 1 cannot decide final domain.
- Layer 1 cannot call an LLM.
- Layer 1 cannot log raw message text.

## D1 Status

D1 is complete as a documentation deliverable. Implementation is blocked until
Phase 2 because the Work Order requires D1-D16 plus the production benchmark
before shadow ships.

