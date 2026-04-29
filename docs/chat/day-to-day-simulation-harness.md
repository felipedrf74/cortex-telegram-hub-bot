# Chat Day-To-Day Simulation Harness

Generated: 2026-04-29 12:39 WEST
Branch: `feature/chat-p0-tenant-security-audit`

## Purpose

The Chat day-to-day simulation harness tests whether Nexus Chat behaves like a useful product surface during realistic multi-turn conversations. It is not an exact wording snapshot suite. It scores whether each response is correct, tenant-safe, memory-aware, context-relevant, fresh enough, routed to the right skill, actionable, clear under ambiguity, hallucination-resistant, stale-context-safe, and sufficient for the user.

The harness lives in:

- `src/services/chat-day-to-day-simulation.ts`
- `src/tools/chat-day-to-day-simulation.ts`
- `__tests__/services/chat-day-to-day-simulation.test.ts`

## Execution Modes

| Mode | Status | Purpose |
| --- | --- | --- |
| Deterministic fixture mode | Implemented | Default. Exercises routing, context selection, tool-call records, memory, tenant boundaries, response sufficiency, and iOS shape without model cost. |
| Real provider mode | Planned | Future bounded runs can replay selected scenarios through live model routing after the same scoped context is built. |
| Full local product engine mode | Planned | Future run should seed the local Nexus runtime and compare fixture expectations to actual REST/tool behavior. |

## Commands

Focused test:

```bash
npm test -- --run __tests__/services/chat-day-to-day-simulation.test.ts
```

Broader harness/eval sanity:

```bash
npm test -- --run __tests__/services/chat-day-to-day-simulation.test.ts __tests__/services/chat-evaluation-harness.test.ts
```

Typecheck:

```bash
npm run typecheck
```

CLI report after build:

```bash
npm run build
node dist/tools/chat-day-to-day-simulation.js
```

Latest measured run:

- Test: PASS - 1 file / 8 tests
- Eval sanity: PASS - 2 files / 14 tests
- Typecheck: PASS
- CLI: PASS - 12 scenarios / 34 turns, average score `1.94 / 2.00`

## What The Harness Records

- persona and tenant/user fixture
- multi-turn transcript
- active tenant per turn
- skills used
- selected domain
- fixture context records with source, freshness, confidence, tenant, and user
- tool calls with idempotency key and status
- provider trace with mode, provider, model, tier, category, and fallback flag
- iOS-compatible response envelope
- response sufficiency scores
- failure taxonomy entries

## Safety Properties

- Fixture users and tenants use synthetic IDs only.
- No production data is read.
- Provider mode defaults to deterministic fixture; no model call is made by the focused test.
- Tenant switch scenarios verify previous-tenant content is not reused.
- Prompt-injection scenarios forbid tool calls and require refusal.
- Retry scenarios verify idempotency evidence instead of duplicate actions.
- Contradictory frustrated-user scenarios require clarification before action, confirmation before agenda mutation, and preservation of the Training plan when only the calendar block is removed.

## Evaluation Philosophy

The harness intentionally avoids exact assistant wording as the only pass condition. Each turn has semantic expectations such as required skills, required action state, required clarification/refusal/confirmation, forbidden content, tool-call expectations, and minimum average score.

This makes it useful for comparing future real-provider responses where wording will vary but product behavior must remain safe and sufficient.

## Current Scenario Count

The runnable bank now covers 12 scenarios:

1. Morning planning
2. Training adjustment
3. Cooking/fueling around Training
4. Finance constraint affecting plans
5. Content planning with references
6. Tenant switch
7. Vague follow-ups
8. User correction
9. Tool failure and retry
10. Prompt-injection attempt
11. Longitudinal memory across days
12. Frustrated user with contradictory instructions
