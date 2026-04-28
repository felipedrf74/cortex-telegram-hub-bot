# Training Agenda Open Items

Date: 2026-04-28

## Remaining Work

1. Add a scheduled reconciler job for `reconcileOrphanedTrainingAgendaEvents`.
   - The service exists and is used by generation saga paths, but a periodic sweep would make provider outages self-healing without waiting for the next plan operation.

2. Consider first-class `superseded` plan status.
   - Current behavior hard-deletes cancelled/replaced plans and uses ownership rows for audit. This matches the user-facing cleanup contract, but a soft-retained `superseded` state would improve longitudinal analytics if product wants historical plan review.

3. Add provider metadata where supported.
   - Google/Outlook event extended properties could store `planId`, `planVersion`, and `sessionId`. The backend ownership table is the source of truth, but provider metadata would make manual support investigations easier.

4. Add a real integration test adapter for calendar providers.
   - Current tests mock provider calls. A fake in-memory calendar adapter would let us assert exact create/update/delete sequences across activation, cancellation, replacement, and retry.

5. Define explicit moved-session sync semantics.
   - Today, mismatched linked events are repaired by replacement + stale delete. If product wants user-manual calendar moves to be preserved, we need a separate "user moved event" signal instead of treating every mismatch as stale.

6. Surface agenda reconciliation state to iOS.
   - The backend now knows when external deletes are queued as `orphaned`. iOS could show "plan removed locally, calendar cleanup still retrying" instead of a generic success when provider deletion partially fails.

## Not Open After This Pass

- Ownership rows are no longer ignored during cancellation.
- Active ownership rows whose session disappeared are no longer stranded outside reconciliation.
- Stale linked events are no longer left behind silently when sync repairs a session.
- Orphaned events are no longer considered unclaimed by future training sync.
- Ownership terminal updates can be scoped to user/plan to avoid cross-plan pollution.

