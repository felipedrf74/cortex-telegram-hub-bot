# Chat Day-To-Day Interaction Risk Map

Date: 2026-04-29
Branch: `feature/chat-p0-tenant-security-audit`
Commit audited: `34add9a`

## Purpose

This risk map focuses on whether Nexus Chat can handle ordinary user behavior, not just whether endpoints return 200. It complements the existing deterministic harness and identifies where live local-engine validation still needs to deepen.

## Current Baseline

The deterministic day-to-day simulation suite exists and passes:

- 11 personas
- 10 multi-turn scenarios
- 28 turns
- average score previously recorded as `1.93 / 2.00`
- fixture provider trace
- no production or staging data

Focused test run for this batch:

```bash
npm test -- --run __tests__/services/chat-context-engine.test.ts __tests__/services/chat-skill-orchestrator.test.ts __tests__/services/chat-day-to-day-simulation.test.ts __tests__/services/chat-evaluation-harness.test.ts
```

Result: PASS - 4 files / 28 tests.

## Interaction Risk Matrix

| Interaction | Current guardrail | Primary failure mode | Severity | Required next validation |
| --- | --- | --- | --- | --- |
| Morning planning: “What do I need to do today?” | Secretary routing, daily context, shared decision context, fixture scenario A. | Answer may be plausible but not sourced from live current agenda/tasks/training/cooking/finance/content state. | P1 | Run scenario A through seeded local engine and iOS transcript rendering. |
| Schedule mutation: “Move it to Friday.” | Ambiguous follow-up detection and scoped recent history. | Wrong target if recent context contains multiple moveable objects. | P1 | Add typed pending-action/object-reference store and mutation test. |
| Cancellation: “Cancel that.” | Destructive action confirmation before routing. | Confirmation may not bind to a stable object ID/source skill. | P1 | Require structured target identity before cancellation tools run. |
| Repeat request: “Do the same as last week.” | Memory recall/prior-context detection; fixture follow-up scenario. | Could copy stale, wrong-tenant, or wrong-domain behavior. | P1 | Add local-engine scenario with two similar prior actions across tenants/domains. |
| Preference use: “Use my usual setup.” | Preference-like shared memory gets higher relevance. | If memory is missing, stale, or conflicting, provider may overclaim. | P2 | Add memory conflict/correction fixtures and response evidence metadata. |
| Tenant boundary: “That is for my other tenant.” | Tenant-boundary weak signal; prompt says clarify workspace. | Product lacks complete true active-tenant membership/switching model. | P0/P1 | Do not release workspace-switch claims until backend + iOS + mesh tenant tests pass. |
| Explanation: “Why are you suggesting this?” | `asksWhy` pulls relevant history/daily/shared-decision context. | Explanation may be text-only without structured evidence or freshness. | P2 | Add response metadata/evidence cards for context sources and confidence. |
| Freshness diff: “What changed since yesterday?” | Stale-context risk and refresh-before-answer metadata. | No canonical diff service across agenda/tasks/memory/skills. | P1 | Add “yesterday vs today” fixture and live local-engine diff validator. |
| Training adjustment: “I am tired today; adjust my schedule.” | Training and Secretary routing; recovery scenario B. | Live flow may not update both Training and Secretary state durably. | P1 | Add cross-skill tool lifecycle smoke with Training feedback + Secretary reflow. |
| Finance + schedule: “Can I afford this and fit it into my week?” | Finance, Training, Secretary multi-skill detection; fixture scenario D. | Finance facts and schedule capacity may be stale or independently reasoned. | P1 | Run seeded Finance + Secretary capacity smoke through Chat. |
| User correction: “Actually, I changed my mind.” | Correction intent detection and fixture memory update. | Real memory summaries may not be superseded/repaired durably. | P1 | Add memory supersession table/contract or explicit correction repair workflow. |
| Tool failure: “Retry it.” | Message idempotency and fixture tool failure/dedupe. | Durable tool-call state may be absent, causing duplicate actions in live tools. | P1 | Add tool-call lifecycle persistence and retry idempotency smoke. |
| Prompt injection | Prompt-injection intent and untrusted context labeling. | Real attachments/retrieved docs could carry stronger malicious instructions than fixture text. | P1 | Add real local attachment/retrieval prompt-injection fixtures. |
| Streaming interruption | Message lifecycle docs/tests exist, but WebSocket Chat remains special. | Reconnect may duplicate messages/actions or lose tenant scope if enabled. | P1 if enabled | Keep disabled or add streaming tenant/idempotency tests. |
| User frustration/contradiction | Fixture scenario H and frustrated persona. | Response may over-apologize, hide state, or fail to offer actionable recovery. | P2 | Add more variants: canceled stream, partial tool success, contradictory instruction. |

## Canonical Daily-Use Prompts

| Prompt | Expected behavior | Current status |
| --- | --- | --- |
| “What do I need to do today?” | Use Secretary as primary, include fresh scoped daily plan context, summarize priorities and risks. | Covered by fixture; local-engine quality still P1. |
| “Move it to Friday.” | Resolve safe object from scoped recent history or ask which item; no mutation without target. | Guarded; needs typed reference store. |
| “Cancel that.” | Require explicit confirmation and stable target identity. | Confirmation exists; target identity contract incomplete. |
| “Do the same as last week.” | Use tenant-scoped memory/history only; clarify if “same” is ambiguous. | Fixture-covered; live resolver needed. |
| “Use my usual setup.” | Use scoped memory if fresh/confident; disclose or ask if weak. | Context engine supports; memory-write policy incomplete. |
| “That is for my other tenant.” | Do not reuse current tenant context; ask/require active workspace switch. | Guarded; true switching incomplete. |
| “Why are you suggesting this?” | Cite the source context and freshness/confidence. | Prompt support exists; response metadata missing. |
| “What changed since yesterday?” | Refresh or compare current state vs prior state; label unknowns. | Intent support exists; diff service missing. |
| “I am tired today; adjust my schedule.” | Route to Training + Secretary, adjust intensity/time only through authorized skill paths. | Fixture-covered; live tool flow needs proof. |
| “Can I afford this and fit it into my week?” | Route Finance for affordability and Secretary for capacity; explain tradeoff and missing facts. | Fixture-covered; seeded local-engine pass needed. |

## Failure Taxonomy For This Batch

| Failure | Description | Blocking level |
| --- | --- | --- |
| Tenant leak | Any response uses another tenant/user memory, conversation, retrieved context, or tool result. | P0 |
| Wrong skill owner | Chat performs work that Secretary/Training/Cooking/Finance/Content should own. | P1 |
| Unsafe ambiguity | Vague follow-up mutates without target confirmation. | P1 |
| Stale fact as truth | Chat uses stale daily/memory/skill state without freshness warning or refresh. | P1 |
| Memory overreach | Chat stores or recalls sensitive preference/fact without policy and scope. | P1 |
| Duplicate side effect | Retry/reconnect creates duplicate tool action, agenda item, reminder, or skill mutation. | P1 |
| Insufficient answer | Chat gives generic prose without action status, constraints, unresolved facts, or next step. | P2 |
| iOS incompatibility | Important state only appears in free text and cannot render as confirmation/error/result state. | P2 |

## Required Validation Before Strong Product Claims

Before claiming Chat is materially improved for real day-to-day use:

1. Run deterministic fixture suite in CI.
2. Replay the 10 canonical scenarios against seeded full local Nexus runtime.
3. Prove the iOS chat UI renders scenario transcripts, pending confirmations, failures, retries, and skill results.
4. Add durable pending-action and tool-call lifecycle state.
5. Add memory-write/correction policy and tests.
6. Run bounded real-provider sample only after context scope and tool lifecycle are locked.

## Current Release Interpretation

No new immediate P0 was found in this audit. The branch is safer and more capable than the previous Chat baseline, but the current evidence still supports **PASS WITH CONDITIONS**, not an unconditional production-quality Chat reasoning claim.

The release-critical condition is scope-dependent:

- If production scope is single-active-tenant Chat with deterministic/local-engine smoke, current work is close but needs live scenario replay.
- If production scope includes true workspace switching, cross-tenant shared context, or full streaming Chat, unresolved P0/P1 items remain.
