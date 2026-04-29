# Session Identity Open Items

## Open Risks

1. **Legacy unmarked orphan events**
   - Events created before the `NEXUS_TRAINING_IDENTITY` marker can still be deleted if linked through `training_sessions` or `training_agenda_event_ownership`.
   - If they are fully orphaned and unmarked, the new safety model intentionally refuses title/date-only deletion.

2. **Calendar update description support**
   - The current unified `updateEvent` path supports title/start/end only.
   - Same-shape prior-version reuse records new ownership locally, but the external event description can retain an older version marker.
   - A future provider patch should support description updates and refresh the marker after same-shape reuse.

3. **Full regeneration flow runtime smoke**
   - Unit coverage now proves identity semantics around sync, replacement, cancellation, and retry.
   - A live/staging smoke should still validate real Google/Outlook event marker retention, especially because provider APIs can sanitize descriptions differently.

## Recommended Follow-Up

- Extend `unified-calendar.updateEvent` and provider adapters to support `new_description`.
- Add a staging smoke that creates a plan, syncs, regenerates same-shape, regenerates changed-shape, cancels, and verifies provider calendar state.
- Add a one-time operator reconciliation report for legacy unmarked training events, reviewed manually before deletion.
