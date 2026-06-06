# Training Plan Version Lifecycle

## Decision

Keep `fitness_training_plans.plan_version` and `incrementPlanVersion()` as the explicit regenerate-without-hard-delete primitive, but do not claim that path is production-active yet.

Current production cancellation/regeneration still hard-deletes the active plan before persisting the replacement. In that path, new plans start at `plan_version=1`, and durable calendar safety is provided by `training_agenda_event_ownership`, session identity keys, and session shape hashes.

The version increment helper remains because the table and tests already support a future non-destructive regeneration flow. Removing it would require a schema rollback and would make it harder to preserve audit history once Training supports true plan supersession.

## Release Boundary

- Current release guarantee: hard-delete cancellation plus precise event ownership cleanup.
- Future release guarantee, not yet claimed: regenerate a plan in place and bump `plan_version` without deleting the prior plan row.

## Safety Rules

- Calendar cleanup must use ownership rows, provider event IDs, and session identity markers.
- No broad date-range cleanup.
- No title/date-only matching for generated Training events.
- Any future regenerate-without-cancel caller must call `incrementPlanVersion()` before writing replacement sessions/events.

