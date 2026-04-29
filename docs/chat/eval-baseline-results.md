# Chat Eval Baseline Results

Date: 2026-04-29
Mode: deterministic fixture

## Summary

Status: pass for runnable fixture evaluation.

Status: partial for scenarios that require live local-engine or real-provider evidence.

No production data and no production provider calls were used.

## Baseline Coverage

| Area | Status | Evidence |
| --- | --- | --- |
| Persona bank | Pass | `CHAT_EVAL_PERSONAS` includes normal, Training, multi-skill, content, tenant admin, platform admin, attacker, multi-tenant, frustrated, and longitudinal users. |
| Scenario bank | Pass | `CHAT_EVAL_SCENARIOS` includes 24 scenarios covering quality, safety, routing, memory, provider, streaming, and day-to-day behavior. |
| Scoring rubric | Pass | 20 scoring dimensions are defined and tested. |
| Red-team coverage | Pass | Cross-tenant access, tenant switch, prompt injection, and malicious retrieved content are included. |
| Existing day-to-day harness integration | Pass | Evaluation harness uses the day-to-day suite as a dependency for realistic multi-turn cases. |
| Streaming interruption | Partial | Modeled in rubric; live streaming/reconnect requires local-engine run. |
| Provider fallback | Partial | Modeled in rubric; requires bounded real-provider run. |
| Operator-pinned model | Partial | Modeled in rubric; requires real routing/config proof. |
| iOS compatibility | Pass for fixture envelopes | Full transcript rendering smoke remains a follow-up. |

## Expected Fixture Result Shape

The fixture run should produce:

- overall pass
- zero failed scenarios
- zero blocked scenarios
- partial status for live-only streaming/provider cases
- day-to-day harness pass

Command:

```bash
npx vitest run __tests__/services/chat-evaluation-harness.test.ts __tests__/services/chat-day-to-day-simulation.test.ts
```

CLI after build:

```bash
npm run build
npm run chat:eval
```

## Release Interpretation

This baseline is a quality harness gate, not a production go/no-go by itself. It should become part of the Chat release process before local full-product smoke, iOS smoke, provider-routing proof, and final security review.
