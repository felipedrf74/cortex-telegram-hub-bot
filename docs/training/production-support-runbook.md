# Training Production Support Runbook

Date: 2026-04-28

## Inspect A Plan

Use database queries scoped by `user_id` and `plan_id` only. Check:

- `fitness_training_plans`
- `training_weeks`
- `training_sessions`
- `training_agenda_event_ownership`

Key fields:

- `plan_version`
- `status`
- `session_identity_key`
- `session_shape_hash`
- `calendar_event_id`
- `calendar_event_source`

## Inspect Calendar Ownership

Start from `training_agenda_event_ownership`, then verify provider events by exact provider event ID. Never delete by broad date/title.

## Diagnose Stale Events

1. Confirm active plan ID and plan version.
2. List ownership rows for that plan/version.
3. Compare against current scheduled sessions.
4. Delete only provider events owned by stale rows.
5. Mark or clean local ownership state according to existing lifecycle rules.

## Diagnose iOS Stale Plan State

1. Confirm backend active plan state through `/api/v1/training/*` routes.
2. Confirm plan/version/lifecycle fields are present.
3. Ask user to refresh or clear local cache only after backend truth is verified.
4. File iOS follow-up if backend truth is correct but UI remains stale.

## Operational Switches

- `TRAINING_ENGINE_DISABLED=1`
- `TRAINING_PLAN_GENERATION_DISABLED=1`
- `TRAINING_CALENDAR_WRITES_DISABLED=1`
- `TRAINING_CALENDAR_SYNC_DISABLED=1`
- `TRAINING_CROSS_SKILL_SIGNALS_DISABLED=1`

Prefer narrow switches first, for example disable calendar writes without disabling plan reads.

## Rollback

Primary baseline: `a3f1b78`.

1. Confirm production-predeploy DB snapshot path.
2. Use `scripts/rollback.sh` for documented rollback flow.
3. Restore DB snapshot only if required by migration/data state.
4. Verify PM2 health and production API health.
5. Verify Training plans remain readable.
6. Verify no duplicate/stale calendar events remain.

## Staging/Test Artifact Cleanup

Staging calendar smoke events use `[NEXUS TRAINING STAGING]` and run IDs. Cross-skill staging fixture rows use `[NEXUS TRAINING CROSS-SKILL STAGING]`.

Production cleanup must not target those prefixes unless they are unexpectedly found in production and ownership/user scope is verified first.
