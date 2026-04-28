# Training Final Security and Tenancy Review

Date: 2026-04-28

## Executive Summary

This pass reviewed Training production safety across backend API authorization, tenant/user scoping, plan and session ownership, calendar event ownership, iOS Training feedback payloads, cross-skill shared context, logs, staging artifact cleanup, and sensitive profile/health fields.

Result: no open P0/P1 authorization or tenancy blockers remain after this pass. One P1 privacy hardening issue was found and fixed: provider SDK errors and some calendar/Training logs could still include raw auth headers, tokens, objectives, event titles, or request body content. The backend logger now has an explicit redaction policy for auth/token/secret-bearing fields, and Training/calendar logs touched by this pass now log shape metadata instead of sensitive free text.

This review did not deploy. It is a code-level and focused-test gate. Real Google/Outlook staging read-back and cross-skill staging proof remain separate release trust gates and must not be inferred from this security review.

## Branch, Backup, And Scope

Backend repository: `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot`

- Working branch: `release/training-engine-production-hardening`
- Starting commit: `d0d0c41`
- Backup branch: `backup/security-tenancy-review-pre-20260428-115301`
- Backup tag: `backup-security-tenancy-review-pre-20260428-115301`
- Tracked patch backup: `/tmp/nexus-backend-security-tenancy-review-tracked-20260428-115301.patch`
- Untracked archive backup: `/tmp/nexus-backend-security-tenancy-review-untracked-20260428-115301.tgz`

iOS repository: `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub`

- Working branch: `feature/ios-training-local-engine-smoke`
- Starting commit: `f7da7b7`
- Backup branch: `backup/ios-security-tenancy-review-pre-20260428-115301`
- Backup tag: `backup-ios-security-tenancy-review-pre-20260428-115301`
- Tracked patch backup: `/tmp/nexus-ios-security-tenancy-review-tracked-20260428-115301.patch`
- Untracked archive backup: `/tmp/nexus-ios-security-tenancy-review-untracked-20260428-115301.tgz`

The backend and iOS worktrees already contained many in-flight Training changes from prior hardening tasks. This pass avoided reverting or restructuring them and only applied security/privacy-focused changes.

## Security Decision

| Area | Status | Evidence |
| --- | --- | --- |
| Training route authentication | Pass | `src/api/router.ts` mounts `authMiddleware` before `/training`; request context carries `userId`. |
| Plan cancellation ownership | Pass | `cancelTrainingPlanForUser` rejects requested plans where `plan.user_id !== userId`. |
| Session mutation ownership | Pass | `resolveTrainingMutationSession` resolves session -> plan and rejects if the plan user differs. |
| Calendar ownership mapping | Pass | `recordCalendarOwnership` stores `plan_id`, `plan_version`, `session_id`, `user_id`, provider event id, source, identity key, and shape hash. |
| Calendar stale/cross-user filtering | Pass | `filterCalendarEventsForTrainingScope` filters Training-owned events against owner rows. |
| Cross-skill signal scoping | Pass | Training signal reads/writes use `user_id`; global reads exclude user-scoped signals unless a user is supplied. |
| iOS feedback privacy | Pass | Training feedback is held in local view state, validated, and sent through REST; no Training feedback debug logging was found. |
| Provider token/log redaction | Fixed | Added global logger redaction paths for common auth/token/secret fields and nested SDK error shapes. |
| Staging artifact cleanup safeguards | Pass with release-gate dependency | Staging smoke harnesses require staging flags/users/databases, clear test titles/run IDs, read-back, and precise event cleanup. Real provider execution is tracked separately. |

## Backend Findings

### API Authorization

All app-facing Training routes are mounted after `authMiddleware` and `rateLimitMiddleware`. The authenticated `userId` is the source of truth for plan generation, sync, cancellation, completion, skip, and related reads.

Reviewed endpoints:

- `POST /api/v1/training/plan/generate`
- `POST /api/v1/training/plan/sync-calendar`
- `POST /api/v1/training/plan/cancel`
- `POST /api/v1/training/complete`
- `POST /api/v1/training/skip`
- Training read models used by Home/Training iOS surfaces

No unauthenticated Training mutation path was found in the reviewed route tree.

### Tenant And User Scoping

Ownership checks are explicit at the important mutation boundaries:

- Plan cancellation checks requested plan ownership before deletion.
- Session complete/skip resolves the session row and rejects when the backing plan belongs to another user.
- Calendar ownership records include `user_id`; deletion marking accepts scoped `userId`, `planId`, and ownership id filters.
- Training calendar scope filtering hides events owned by another user or inactive plan.
- Training cross-skill signals and shared decision context use user-scoped reads/writes.

Focused tests passed for cross-user Training mutation denial and calendar ownership collision behavior.

### Calendar Provider Safety

Calendar lifecycle code avoids broad date-range deletion in the audited Training cancellation path. Deletion targets are built from scoped session/ownership rows and provider event ids, then each delete is recorded as `deleted` or `orphaned` in the ownership table.

The staging calendar smoke harness also has safety rails:

- Requires `STAGING=true` or `NODE_ENV=staging`.
- Refuses `NODE_ENV=production`.
- Requires `TRAINING_CALENDAR_STAGING_SMOKE=1`.
- Requires `TRAINING_CALENDAR_STAGING_ALLOW_LIVE_WRITES=1`.
- Requires a staging-looking database path unless explicitly overridden.
- Prefixes all staging events with `[NEXUS TRAINING STAGING]`.
- Embeds run id, plan id, plan version, session id, session identity key, and shape hash.
- Reads back provider events and precisely cleans tracked event ids.

This review did not run the real provider smoke. The final staging calendar gate remains the source of truth for real Google/Outlook proof.

## Sensitive Data Handling

Sensitive Training data reviewed:

- Injury/discomfort flags and details.
- Recovery/fatigue/soreness/readiness feedback.
- Sex/gender fields when explicitly present in profile data.
- Questionnaire/profile answers.
- Calendar titles/descriptions and provider event metadata.
- User feedback notes.
- OAuth/provider tokens and SDK client errors.

Fixes applied:

- Added `LOGGER_REDACTION_PATHS` in `src/utils/logger.ts` and wired Pino `redact` with `[Redacted]`.
- Redaction covers common auth/token/secret field names and nested provider SDK error shapes such as `err.config.headers.Authorization`, `err.response.config.headers.Authorization`, `err.request._header`, and `err.options.auth`.
- Removed raw Training objective logging from the plan generation success log; only `objectiveLength` is logged.
- Removed raw Training/calendar title logging from Training event rate-limit and blocker failure logs; shape fields such as `titleLength`, `sessionId`, `planId`, and `planVersion` are logged instead.
- Removed raw calendar create request body logging; errors now log safe shape metadata (`titleLength`, `hasDescription`, `attendeeCount`, `hasLocation`, `hasRecurrence`) plus scoped identifiers.
- Removed raw Outlook subject logging on event creation; the log now records `titleLength`, category count, and attendee count.

No Training iOS feedback logging was found. iOS feedback validation exists for skipped reason, duration, and discomfort context before payload submission.

## Cross-Skill Context

Training consumes same-user Secretary, Cooking, Finance, and Content signals through scoped context. The reviewed code does not expose global user-scoped signals when a user id is missing. The product intentionally allows same-user sensitive scheduling/fueling/context to flow into Training prompts and explanations; that is expected behavior, not a log target.

Remaining privacy expectation: model/provider policies and prompt logging must continue to treat this as sensitive user context. Future telemetry should only carry reason codes and shape metadata, not raw calendar titles, injury notes, or profile free text.

## Files Changed In This Pass

- `src/utils/logger.ts`
- `src/api/routes/calendar.ts`
- `src/api/routes/training-calendar-event-writer.ts`
- `src/api/routes/training-plan-persistence.ts`
- `src/api/routes/training-plan-routes.ts`
- `src/services/outlook-calendar.ts`
- `src/services/training-plans.ts`
- `__tests__/utils/logger-redaction.test.ts`
- `docs/training/final-security-tenancy-review.md`
- `docs/training/final-security-open-blockers.md`
- `docs/training/final-security-test-results.md`

Note: some of these source files already contained in-flight non-security Training changes before this pass. The security changes are limited to redaction and log minimization.

## Remaining Risks

- Real Google/Outlook staging smoke must still prove live provider read-back and precise cleanup if not already completed.
- Cross-skill staging smoke must still prove staging tenant/user isolation and signal behavior if the staging prerequisites are available.
- The backend `/training/skip` route currently handles the skip mutation but does not persist every rich feedback field sent by iOS. This is not a security leak, but it limits adaptation quality and should remain on the product hardening backlog.
- Broader non-Training logs still include some user emails, titles, or business strings in other product areas. The new logger redaction policy protects token/secret shapes, but whole-product log minimization should be a separate privacy pass.
- Future provider SDKs may expose credentials under new nested keys; redaction paths should be expanded whenever a new client library or error wrapper is introduced.

## Release Recommendation

Security/tenancy recommendation for Training code-level release gate: pass after this fix set and focused tests.

Do not treat this as full production approval until the remaining release gates show evidence for:

- Real provider staging calendar lifecycle.
- Cross-skill staging smoke.
- iOS rich Training payload simulator smoke.
- Production rollback readiness.
