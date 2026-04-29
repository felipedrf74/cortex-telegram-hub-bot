# Chat Evaluation Harness Spec

Date: 2026-04-29
Branch: `feature/chat-tenant-safe-context-orchestration`

## Purpose

The Chat evaluation harness measures whether Nexus Chat is improving in useful product behavior, not merely changing implementation details. It evaluates quality, tenant safety, authorization, memory, context handling, skill routing, prompt-injection resistance, provider routing, fallback safety, streaming/retry behavior, and iOS response compatibility.

## Runtime Artifacts

- Service: `src/services/chat-evaluation-harness.ts`
- CLI: `src/tools/chat-evaluation-harness.ts`
- Test: `__tests__/services/chat-evaluation-harness.test.ts`
- Existing day-to-day dependency: `src/services/chat-day-to-day-simulation.ts`

## Commands

Focused tests:

```bash
npx vitest run __tests__/services/chat-evaluation-harness.test.ts __tests__/services/chat-day-to-day-simulation.test.ts
```

Typecheck:

```bash
npm run typecheck
```

CLI after build:

```bash
npm run build
npm run chat:eval
```

Optional mode flag:

```bash
CHAT_EVAL_MODE=fixture npm run chat:eval
CHAT_EVAL_MODE=local_engine npm run chat:eval
CHAT_EVAL_MODE=real_provider npm run chat:eval
```

## Modes

| Mode | Status | Purpose |
| --- | --- | --- |
| `fixture` | Implemented | Deterministic, zero-provider-cost baseline for scenario/rubric wiring and safety expectations. |
| `local_engine` | Planned | Future full local Nexus runtime execution with seeded users, tenants, tools, Chat, skills, and iOS-compatible payloads. |
| `real_provider` | Planned | Bounded model-routing validation for provider fallback, operator-pinned models, and reasoning quality. |

## Scenario Result States

| Status | Meaning |
| --- | --- |
| `pass` | Deterministic expectations pass for the current evidence mode. |
| `partial` | Fixture expectations pass, but live local-engine or real-provider evidence is still required. |
| `fail` | Required safety/quality score failed. |
| `blocked` | Scenario cannot run because a required dependency is missing. |

## Design Principles

- Do not snapshot exact assistant wording as the only pass condition.
- Do not use production data.
- Do not call real providers in default test runs.
- Do not rely on model obedience for security.
- Score response sufficiency and safety dimensions explicitly.
- Mark live-only provider/streaming cases as partial in fixture mode.
- Preserve Nexus live model routing; the harness must not hardcode a production provider.

## Evidence Boundaries

The fixture baseline proves the evaluation suite exists, covers the intended risks, and can be run repeatedly. It does not prove production provider quality, live streaming reconnect behavior, or real tool/provider side effects. Those require `local_engine` and `real_provider` follow-up runs.
