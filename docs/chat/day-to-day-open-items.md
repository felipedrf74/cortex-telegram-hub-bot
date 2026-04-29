# Chat Day-To-Day Open Items

Generated: 2026-04-29 12:39 WEST
Branch: `feature/chat-p0-tenant-security-audit`

## P0

None from the deterministic day-to-day harness itself. The latest deterministic run passed 12 scenarios / 34 turns with average score `1.94 / 2.00`.

Existing Chat workstream P0s still apply:

- migrations `084` and `085` have staging-clone proof; production still needs a fresh predeploy DB snapshot
- WebSocket Chat must remain disabled or receive auth/tenant parity before production use
- active tenant membership model remains incomplete for true workspace switching

## P1

| Item | Reason | Next Step |
| --- | --- | --- |
| Full local product engine integration | Fixture harness proves behavior expectations, not live REST/tool state. | Replay the 12 scenarios against seeded local Nexus runtime. |
| iOS simulator Chat smoke | Harness validates envelope shape but not rendering/state refresh. | Run iOS Chat against full local backend with these scenarios. |
| Bounded live-provider sample | Fixture mode avoids cost but cannot evaluate real wording/reasoning drift. | Run a small curated provider pass after scoped context builder is locked. |
| Tool-call lifecycle persistence | Harness records tool status but does not persist durable invocation state. | Continue message/tool lifecycle workstream. |

## P2

| Item | Reason | Next Step |
| --- | --- | --- |
| Portal/web Chat replay view | Useful for reviewing transcripts and rubric failures. | Add report viewer or export format if needed. |
| More frustrated-user variants | Current coverage now includes tool failure/retry and contradictory cancellation/change instructions. | Add interruption and cancellation-during-stream variants. |
| Attachment-driven prompt injection | Current scenario simulates quoted malicious content only. | Add real local attachment fixtures once attachment scope is audited. |

## Cleanup Status

No local services, workers, tunnels, simulators, containers, or model loops were started by this harness pass.
