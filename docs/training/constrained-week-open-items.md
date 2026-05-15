# Constrained-Week Open Items

Date: 2026-04-28

## Open Risks

| Impact | Item | Notes |
|---|---|---|
| High | Secretary busy-window input is not yet wired directly into the coach-kernel capacity model. | The reconciler is ready for declared availability windows. True calendar conflicts are still applied later by plan persistence/calendar sync utilities. A future slice should pass Secretary-derived busy windows into the engine-level capacity model. |
| Medium | Inactive schedule states are not persisted as separate rows. | Deferred/unscheduled sessions are intentionally skipped by persistence to prevent active calendar/workout pollution. If product wants to show a “not scheduled this week” list after reload, add a dedicated plan-adjustments table or JSON payload. |
| Medium | Slot sharing is intentionally simple. | It supports remaining capacity inside a window, including triathlon brick pairing. It does not yet model transition buffers or user preference for not stacking sessions in one long window. |
| Medium | Calendar event update tests remain covered mostly by existing lifecycle tests. | This slice prevents invalid event creation. Broader reflowed-event update identity is covered by the agenda lifecycle workstream and should stay in release validation. |
| Low | Evaluation rubrics now score active sessions for structure/profile dimensions. | This matches product semantics, but future reports should show inactive/deferred counts explicitly so capacity losses remain visible. |

## Recommended Follow-Ups

1. Feed real Secretary/calendar busy windows into `reconcileWeeklyCapacity` before generation finalization.
2. Add a persisted, user-visible “deferred this week” artifact if the product wants to show unscheduled training intent after app relaunch.
3. Add transition-buffer support for shared windows, especially brick and two-a-day sessions.
4. Extend the iOS training plan renderer to show `scheduleState`, `scheduleAdjustments`, and `scheduleReason` distinctly once the API payload is promoted.

