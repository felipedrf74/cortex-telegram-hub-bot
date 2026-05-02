# Training calendar and Secretary orchestration review

## Current evidence

- App-facing plan generation builds coordination through the Secretary-aware coordination layer.
- Local full Nexus smoke passed Training summary and Training today endpoints in fixture mode.
- `training-agenda-reconciliation.test.ts`, `training-plan-cancellation.test.ts`, and related calendar tests passed during focused and full-suite runs.
- Calendar source resolution chooses a requested/preferred/linked/default source from Google/Outlook rather than intentionally writing each Training event to both providers.

## Rechecked concerns

- Duplicate Google + Outlook events: no current app-facing route path was found that writes the same Training event to both providers in one create. The remaining risk is stale provider residue from older plans or legacy paths, which requires provider read-back smoke.
- "Plano não está no calendário" vs "Agendado": iOS now has a plan-level sync state contract and tests. Provider evidence remains needed for full confidence.
- Cancellation residue: prior commit `627d4fe` already added cancellation-time orphan reconciliation; focused cancellation/reconciliation tests passed.

## Open items

- Run non-production Google/Outlook lifecycle smoke with create, retry, update/cancel, provider read-back, duplicate check, and precise cleanup.
- Keep Training scheduling through Secretary; do not add direct calendar bypasses from Training.
