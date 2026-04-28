# Training Engine Release Candidate Rollback Plan

Date: 2026-04-28

## Rollback Summary

No production deployment has been performed from `release/training-engine-production-candidate`.

Primary rollback baseline for this RC is:

- Branch: `origin/main`
- Commit: `a3f1b78`
- Subject: `docs: record 4.14.99 Training engine overhaul release`
- Backup tag at same commit: `backup-codex-pre-training-second-opinion-20260427-2246`

Deeper pre-overhaul rollback point:

- Commit/tag: `96c61fb` / `backup-training-engine-before-orchestration-overhaul-20260427-2003`
- Use only if the whole 4.14.99 Training overhaul must be backed out, because it removes already-landed Training intelligence work.

Proposed release tag after review, before deployment:

- `training-engine-rc-20260428.1`

Proposed production release tag if promoted:

- `v4.14.100-training-engine-production-hardening`

Do not create or push tags until the candidate is reviewed.

## Pre-Deployment Rollback

Since the RC is not deployed, rollback is simply abandoning the local candidate branch or resetting a release clone to `origin/main`.

Safe local cleanup pattern:

```bash
git switch main
git fetch origin
git reset --hard origin/main
```

Only use `git reset --hard` in a disposable release clone or after confirming no local work must be preserved. Do not run it in a shared dirty developer workspace.

## Production Rollback Commands If Candidate Is Later Deployed

Use the existing deployment process, not ad hoc file copying.

```bash
git fetch origin
git switch main
git reset --hard a3f1b78
npm run verify
# deploy staging using the normal staging deploy process
# run staging smoke
# promote to production using the normal production deploy process
# run production health checks
```

If the candidate is tagged before deploy:

```bash
git fetch origin --tags
git switch main
git reset --hard a3f1b78
```

Record the production process manager state before rollback:

```bash
pm2 list
pm2 describe cortex-telegram-hub-bot
```

Use exact PM2 app names from the deployment environment; do not assume local names.

## Database Rollback

The candidate includes a proposed additive migration:

- `migrations/082_training_session_identity_shape_hash.sql`

The migration adds identity/hash columns and indexes:

- `training_sessions.session_identity_key`
- `training_sessions.session_shape_hash`
- `training_agenda_event_ownership.session_identity_key`
- `training_agenda_event_ownership.session_shape_hash`
- supporting indexes

No down migration is currently present. SQLite column rollback is not the primary rollback strategy.

Required before production:

1. Take a database snapshot/copy immediately before applying migration 082.
2. Apply migration 082 on a staging clone first.
3. Run lifecycle tests/smokes against the migrated clone.
4. Verify older code at `a3f1b78` ignores the additive columns.

Rollback options:

| Scenario | Preferred rollback |
| --- | --- |
| Migration applied but no live data written | Restore the pre-migration DB snapshot. |
| Migration applied and candidate wrote event identity data | Cancel/supersede active candidate plans first where safe, export affected ownership rows, then restore DB snapshot. |
| Snapshot restore unavailable | Leave additive columns/indexes in place and roll code back to `a3f1b78`; validate older code ignores columns. Do not attempt manual column drops in production without a tested migration. |

## Calendar/Event Rollback

Calendar rollback must be precise. Never use broad date-range deletion.

Candidate-generated events must be identified through ownership metadata:

- plan ID
- plan version
- session identity key
- session shape hash
- provider event ID
- provider/calendar ID
- Nexus marker such as `NEXUS_TRAINING_IDENTITY`

If a bad release creates calendar events:

1. Freeze new Training plan generation if an operational switch is available.
2. Export affected rows from `training_agenda_event_ownership`.
3. Use provider event IDs and ownership rows to delete only candidate-owned events.
4. Read back Google/Outlook calendars to verify deletion.
5. Mark internal ownership rows as deleted/failed according to existing lifecycle rules.
6. Roll code back after event cleanup, unless the code itself is needed to perform precise cleanup.

If cleanup fails, document:

- user/tenant ID
- provider
- calendar ID
- event ID
- plan ID/version
- cleanup error

Do not delete unrelated user calendar events.

## Feature-Flag / Operational Rollback

Dedicated Training operational switches now exist for the release candidate. They default to enabled and can be set through the normal environment/config deployment mechanism:

| Scope | Disable setting | Effect |
| --- | --- | --- |
| Entire Training engine write surface | `TRAINING_ENGINE_DISABLED=1` or `TRAINING_ENGINE_ENABLED=false` | Disables plan generation, calendar writes/sync, and Training-originated cross-skill signal publishing. |
| Plan generation only | `TRAINING_PLAN_GENERATION_DISABLED=1` or `TRAINING_PLAN_GENERATION_ENABLED=false` | `/api/v1/training/plan/generate` returns 503 `TRAINING_GENERATION_DISABLED` before quota/model work starts. |
| Calendar writes/sync | `TRAINING_CALENDAR_WRITES_DISABLED=1`, `TRAINING_CALENDAR_WRITES_ENABLED=false`, `TRAINING_CALENDAR_SYNC_DISABLED=1`, or `TRAINING_CALENDAR_SYNC_ENABLED=false` | Blocks Training provider event writes and `/api/v1/training/plan/sync-calendar`; delete/cleanup paths are not intentionally disabled. |
| Training cross-skill signal publishing | `TRAINING_CROSS_SKILL_SIGNALS_DISABLED=1` or `TRAINING_CROSS_SKILL_SIGNALS_ENABLED=false` | Skips Training-originated signal writes while preserving reads of existing context. |

If Training calendar sync misbehaves after release, prefer the calendar-specific switch first so existing plans remain readable and precise cleanup remains available.

Temporary operational mitigations, subject to owner approval:

- Hide or disable Training plan creation in iOS while keeping read-only existing plans.
- Disable provider calendar writes for Training while preserving internal plan state.
- Disable cross-skill Training signal emission if stale/noisy signals occur.

## iOS Rollback

Backend RC fields are expected to be additive and backward-compatible. If an iOS companion release is shipped and fails:

- Pause phased rollout or stop TestFlight build distribution.
- Reissue the previous stable iOS build.
- Keep backend responses tolerant of older iOS DTOs.
- Do not remove additive backend fields as an iOS rollback mechanism.

Known iOS companion branch:

- iOS repo branch: `feature/ios-training-local-engine-smoke`
- This branch is not included in the backend RC.

## Cross-Skill Rollback

If cross-skill Training signals create bad UX:

1. Disable or ignore Training-originated shared context signals if an operational switch exists.
2. Clean only Training-owned test/staging context rows by tenant/user/source.
3. Preserve Secretary/Cooking/Finance/Content data owned by those skills.
4. Verify no stale Training context remains in Home/Secretary/Cooking views.

## Rollback Verification Checklist

After rollback:

- `npm run verify` passes on rollback code.
- Production health checks pass.
- `/api/v1/training/*` routes return stable 4.14.99-compatible payloads.
- Active Training plans remain readable.
- No duplicate Training calendar events remain.
- Candidate-created stale events are removed or precisely documented.
- Cross-skill warnings are not duplicated.
- iOS can open Home and Training without decode errors.

## Rollback Decision Rules

Rollback immediately if any of these occur after release:

- Cross-tenant or cross-user Training data exposure.
- Unauthorized Training cancellation, feedback, or calendar sync succeeds.
- Calendar cleanup deletes unrelated events.
- Provider calendar retries create duplicates across multiple users.
- iOS cannot decode Training plan payloads for current production build.

Use hotfix instead of full rollback only if:

- The issue is isolated.
- The fix is smaller and safer than rollback.
- Calendar ownership and tenant safety are not compromised.
