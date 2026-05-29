# ChatCoreV2 Phase 1 Contracts

**Generated:** 2026-05-27
**Work Order:** `docs/qa/work-orders/WO-chatcore-v2-production-activation.md`
**Branch:** `codex/chatcore-v2-production-activation-wo`
**Base commit:** `e5ca0034`

This file captures the D4-D16 contracts needed before Phase 2 plan-only shadow.
It is a documentation contract, not runtime implementation.

## D4 - ChatTurnPlanMicro Schema

### CPU Hot-Path Amendment

The original architecture allowed a 2000 token soft cap and 3000 token hard
cap for the 3B planner prompt. The 2026-05-27 VPS calibration shows that this
budget is not viable for foreground turns on the current CPU-only VPS.

Revised implementation direction:

1. Layer 2 must be a tiny intent/capability planner, not a context reader.
2. The foreground planner packet should contain candidate capabilities,
   compact evidence IDs, context hashes, locale, risk signals, and at most a
   terse Tier-1 summary.
3. Large context is fetched after route validation through deterministic reads.
4. If large context is required to choose a route, ask clarification or move to
   background/escalation instead of stuffing it into the 3B prompt.
5. The 2k/3k prompt benchmark remains as a stress benchmark and hardware
   decision input, not the common-turn CPU foreground budget.

Current candidate budget from calibration:

- `num_ctx=512`
- `num_predict=180` for schema-valid benchmark/default harness runs
- `num_predict=12` only proved a latency lower bound; it is not enough for the
  full output contract
- tiny JSON packet with locale, 2-3 capability IDs, risk signal, and terse
  message/summary fields
- 10 sequential qwen latency-lower-bound runs: p50 2085.1 ms, p95 4582.4 ms,
  zero transport failures

This candidate is not enough to unblock Phase 2 by itself. It must pass the
full D3 benchmark suite and schema-validity checks before runtime shadow work.

```ts
type ChatTurnPlanMicro = {
  schemaVersion: 'chat_turn_plan_micro@1.0.0';
  intent: 'answer' | 'read' | 'write_preview' | 'clarify' | 'unsupported' | 'escalate';
  domains: ChatCoreV2Domain[]; // max 2
  capabilityIds: string[]; // max 3
  requiredReads: ReadRequest[]; // max 3
  proposedWrites: WriteRequest[]; // max 1
  clarification?: {
    question: string;
    options: ClarificationOption[]; // max 4
    expectsFreeText?: boolean;
  };
  evidenceClaimIds: string[]; // max 5
  confidence: number; // 0..1
  complexityScore: number; // 0..1
  escalationReasons: EscalationReason[];
  contextHash: string;
  promptVersion: string;
};
```

Prompt budget:

- initial architecture target: soft input cap 2000 tokens, hard input cap
  3000 tokens
- current VPS calibration amendment: 2000/3000 token foreground planning is
  not viable on CPU-only production (`docs/ai/benchmarks/chatcore-v2-planner-calibration-2026-05-27.md`)
- revised implementation task: use the ultra-compact packet candidate as the
  starting point for Phase 2 benchmark work and reserve large context expansion
  for deterministic reads, background, or escalation
- output cap: 180 tokens
- repair attempts: 1
- hard-cap overflow: clarify or escalate; never silently truncate required
  evidence

## D5 - Evidence Taxonomy

| Domain | Required evidence kinds | Never-cloud examples |
|---|---|---|
| cooking | recipe rows, meal plan rows, computation | private dietary notes unless summarized locally |
| content | content item rows, pipeline state, tool result | unpublished draft text unless positive allowlisted |
| finance | finance rows, computation, policy | balances, transactions, account identifiers |
| training | training session rows, plan rows, computation, policy | health-adjacent notes and long-term plan internals |
| secretary | calendar/task/event rows, external API response | raw calendar titles, attendee emails, addresses |
| tasks | task rows, task state computation | private task titles unless locally summarized |

Evidence item requirements:

- source ID
- source kind
- content hash
- freshness
- confidence
- sensitivity
- allowed provider
- tenant ID
- user ID

Every factual answer claim must bind to at least one evidence item. Claims
without evidence are omitted, softened as assumptions, or converted into a
clarification.

## D6 - Prepass Candidate Selection And Recall Targets

Recall targets:

- en >= 98%
- pt-BR >= 97%
- pt-PT >= 92% initial, >= 95% within 30 days
- mixed >= 90%
- Class A writes >= 99%
- Class B writes >= 98%
- Class C writes >= 99%

Golden corpus:

- at least 200 turns before Phase 2
- seeded with real hallucination/context failures
- labeled by language, domain, expected capability IDs, forbidden claims,
  evidence requirements, and write risk class

Prepass miss logging:

- HMAC message hash only
- locale
- candidate capabilities
- final capability after fallback/escalation
- reason codes
- safe metadata only

## D7 - DomainAdapterV1

```ts
interface DomainAdapterV1 {
  readonly schemaVersion: 'domain_adapter@1.0.0';
  readonly domain: ChatCoreV2Domain;

  listCapabilities(ctx: TenantScope): CapabilityManifest;

  buildReadContext(args: {
    tenantId: string;
    userId: string;
    request: ReadRequest;
    contextHash: string;
  }): Promise<ReadResult>;

  previewCommand(args: {
    tenantId: string;
    userId: string;
    request: WriteRequest;
    contextHash: string;
  }): Promise<AICommandEnvelope>;

  executeCommand(args: {
    tenantId: string;
    userId: string;
    command: AICommandEnvelope;
    idempotencyKey: string;
  }): Promise<ExecutionResult>;

  verifyCommand(args: {
    tenantId: string;
    userId: string;
    result: ExecutionResult;
  }): Promise<VerificationResult>;

  formatEvidence(evidence: ReadResult | ExecutionResult): EvidenceItem[];
}
```

Rules:

- `tenantId` and `userId` are mandatory.
- no global user fallback
- no write bypasses `evaluateChatCoreV2CommandBusGate`
- registry rejects non-conforming adapters at boot once adapters are active

## D8 - iOS Turn-State Event Contract

States:

```ts
type ChatCoreV2TurnState =
  | 'planning'
  | 'validating'
  | 'reading_context'
  | 'previewing_command'
  | 'awaiting_confirmation'
  | 'executing'
  | 'verifying'
  | 'composing'
  | 'background_started'
  | 'background_completed'
  | 'failed';
```

Payload:

```ts
type TurnStateEvent = {
  turnId: string;
  state: ChatCoreV2TurnState;
  sequenceNumber: number;
  serverTime: string;
  idempotencyKey: string;
  displayTextKey: string;
  progressPercent?: number;
  canCancel: boolean;
  canResume: boolean;
  backgroundJobId?: string;
};
```

Reconnect:

- client sends `{ type: 'turn_resume', turnId, lastSequenceNumber }`
- server sends a snapshot followed by events newer than `lastSequenceNumber`
- client ignores duplicate `idempotencyKey` and out-of-order sequence numbers

## D9 - Background Lifecycle

States:

```text
pending -> running -> completed | cancelled | abandoned | superseded | expired | failed
```

Background jobs must persist:

- job ID
- turn ID
- tenant ID
- user ID
- context hash
- job type
- start and expiry timestamps
- abort token
- notification policy
- resume deep link

Cancel or supersede must attempt to abort the in-flight Ollama call through
AbortController semantics instead of only discarding the result.

## D10 - AnswerCompositionMode Budget

| Mode | Target share | Model behavior |
|---|---:|---|
| `templated` | 60-80% | zero model calls |
| `model_constrained` | 15-30% | returns `ComposedAnswerDraft` only |
| `background_model` | < 5% | 35B/background only |
| `cloud_allowlist` | < 2% | cloud only with positive allowlist |
| `model_unbounded` | 0% | prohibited |

`model_constrained` must not return raw final text. It returns a structured
draft with evidence bindings; the server converts to `ChatCoreV2Response`.

## D11 - Kill Switch And Auto-Revert

Master switch:

```bash
CHAT_CORE_V2_ORCHESTRATOR_MODE=off|shadow|canary|on
```

Rules:

- `off` wins over every other ChatCoreV2 flag.
- `off` returns to legacy in one code path.
- CI must prove `off` beats domain, surface, write, cloud, and read flags.
- every fallback to legacy emits a reason-coded telemetry event.

Auto-revert thresholds:

- `legacy_fallback_rate_24h >= 5%`: auto-flip to `shadow`
- `legacy_fallback_rate_24h >= 15%`: page operator
- Ollama unhealthy: auto-flip to `shadow`
- schema compliance under 95% for 1 hour: pin planner to repair-only mode
- prepass recall@8 under 90% for any language: shadow that language

## D12 - Model Residency Policy

Current policy for the VPS memory envelope:

- `qwen2.5:3b-instruct-q4_K_M`: `keep_alive=-1`
- `qwen3.6:35b-a3b-q4_K_M`: `keep_alive=5m`
- operational rollback model: `keep_alive=0`
- classifier may share 3B residency when prompt budgets fit

Daemon settings to verify before Phase 2:

- `OLLAMA_NUM_PARALLEL=1`
- `OLLAMA_MAX_QUEUE=8`
- conservative context length unless benchmarks prove no swap
- planner call uses `num_ctx=2048`, `num_predict<=180`, `temperature=0`

## D13 - Cloud Allowlist Composition

New module name: `cloud-allowlist-packet.ts`.

Allowed initial fields:

- intent
- capability ID
- tenant-scoped HMAC entity IDs
- evidence fingerprints
- locale
- complexity score
- escalation reason

Denied fields:

- raw message
- raw calendar/task/email/finance/health content
- account identifiers
- raw entity IDs
- subtraction-sanitized text

Denial reasons:

- `required_fact_never_cloud`
- `insufficient_safe_context_for_cloud`
- `cloud_provider_disabled`
- `cloud_budget_exceeded`
- `domain_disallows_cloud`

## D14 - Write Risk Gradient

| Class | Examples | Escalation path |
|---|---|---|
| A | reminders, simple event, explicit task, explicit single finance log | 3B plan, deterministic preview, confirmation as policy requires, execute, readback |
| B | relative-time calendar, inferred task due date, recurring event, inferred finance category | 3B plan, 3B critic, confirmation, execute, readback |
| C | multi-step writes, payments/transfers, >7 day training changes, external sends, cross-domain writes, ambiguous references | 35B or background escalation, confirmation, execute, readback |

Class A/B never require 35B. Class C must escalate or ask clarification.

## D15 - Failure Observability Matrix

| Failure mode | Detection | Required telemetry | Threshold |
|---|---|---|---|
| Prepass recall miss | `none_of_these_fit` or unknown capability | `prepass_recall_failures` safe row | 24h recall below target |
| Schema failure | zod/ajv invalid after repair | format compliance counter | > 2% in 1h |
| Composer drift | mode distribution | `AnswerCompositionMode` usage | `model_constrained > 35%` sustained |
| Plan repair loop | repair counter | trace span | p95 > 1 |
| 35B escalation drift | escalation counter | reason-coded trace | > 25% sustained |
| Background timeout | expired background jobs | queue metric | > 5% per day |
| Cloud allowlist denial | denial counter | denial reason | > 10% per day for one reason |
| Legacy fallback drift | fallback counter | reason-coded event | >= 5% shadow, >= 15% page |
| Ollama unhealthy | health probe | provider health metric | immediate shadow |

## D16 - Pure-Deterministic Prepass Audit

Layer 1 cannot import or call provider SDKs. The implementation phase must add
CI checks for these forbidden imports in Layer 1 modules:

- `gemini-provider`
- `openai-provider`
- `anthropic`
- `anthropic-provider`
- `ollama-provider`
- `completeOneShotWithFallback`
- `getActiveProvider`
- `getProvider(` unless the module is a reasoner outside Layer 1

Known current issue:

- `chat-message-shortcuts.ts` imports `completeOneShotWithFallback`; it cannot
  be used as a Layer 1 dependency for ordinary natural-language chat.

## Phase 1 Status

D4-D16 are documented here as contracts. They are not peer-reviewed and not
implemented. Phase 2 shadow remains blocked until these contracts become code,
tests, and reviewed evidence.
