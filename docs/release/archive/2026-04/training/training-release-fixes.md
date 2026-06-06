# Training Release Fixes

Date: 2026-04-29
Branch observed: `feature/secretary-scheduling-arbitrator-batch4`
Scope: backend Training production-hardening fixes only. No iOS code was changed in this pass.

## Summary

This pass fixed the remaining code-backed Training release gaps that were safe to address locally:

- active schedule lifecycle states now persist instead of being flattened to `pending`;
- schedule-compression/reflow/cap explanations are stored in the Training session description and calendar event description;
- iOS-facing week payloads can expose `scheduled`, `reflowed`, `compressed`, `capped`, `unscheduled`, and `superseded` lifecycle states consistently;
- unscheduled/deferred/superseded sessions no longer inflate adherence totals or cross-plan weekly load.

No broad rewrites were performed. Existing calendar identity, plan versioning, session shape hash, agenda ownership, cancellation cleanup, feedback analysis, weak-profile prompts, and poor-recovery variation code paths were preserved and covered by focused regression tests.

## Files Changed

- `src/api/routes/training-plan-persistence.ts`
- `src/api/routes/training-calendar-utils.ts`
- `src/services/training-plans.ts`
- `__tests__/api/training-plan-persistence.test.ts`
- `__tests__/api/training-routes.test.ts`
- `__tests__/services/training-plans.test.ts`

## Fix Details

### Schedule Lifecycle Persistence

Before:

- Generated active sessions with `scheduleState: "reflowed"`, `"compressed"`, or `"capped"` were persisted as `pending`.
- iOS could decode rich states from generated/local fixtures, but persisted API read models could flatten active lifecycle decisions.

After:

- Generated active sessions persist one of:
  - `scheduled`
  - `reflowed`
  - `compressed`
  - `capped`
- Inactive sessions continue to persist as:
  - `unscheduled`
  - `deferred`
  - `dropped`

The public status mapping still returns `planned` for active rich states, while `lifecycleState` carries the specific state for iOS.

### Schedule-Compression Explanations

Before:

- Inactive/no-slot reasons were appended to descriptions.
- Active compression/reflow/cap reasons could be lost during persistence.

After:

- Active generated sessions append `scheduleReason` to the persisted Training session description.
- Calendar event descriptions use the same enriched text before the Training identity marker is appended.
- This gives users and operators a durable reason for compressed/reflowed sessions.

### iOS-Facing Rich State Payloads

Before:

- iOS had model/test support for rich Training lifecycle states, but backend persisted active schedule states as `pending`.

After:

- `/api/v1/training/week` returns:
  - `lifecycleState: "reflowed"` and `status: "planned"` for reflowed sessions;
  - `lifecycleState: "compressed"` and `status: "planned"` for compressed sessions;
  - `lifecycleState: "unscheduled"` and `status: "unscheduled"` for no-slot sessions;
  - `lifecycleState: "superseded"` and `status: "superseded"` for inactive historical sessions.
- `sessionShapeHash` and plan version remain exposed.
- Inactive sessions do not count toward the week `totalCount`.

### Adherence And Cross-Plan Load

Before:

- Weekly adherence counted every row in `training_sessions`, including unscheduled/deferred/superseded rows.
- Cross-plan load excluded only skipped sessions, which could make no-slot or superseded sessions look like active load.

After:

- Weekly adherence excludes:
  - `rest`
  - `unscheduled`
  - `deferred`
  - `dropped`
  - `cancelled`
  - `superseded`
- Cross-plan weekly load excludes those inactive states plus `skipped`.
- Active rich states (`scheduled`, `reflowed`, `compressed`, `capped`) remain load/adherence-bearing until completed or skipped.

## Existing Code Paths Preserved

### Constrained/Travel-Week Capacity Reconciliation

Existing coach-kernel behavior remains intact:

- travel weeks cap active sessions to feasible windows;
- no-valid-slot sessions become `unscheduled`;
- reflow/compression decisions include evidence-backed `decisionReasons`;
- calendar sync only creates events for capacity-valid active sessions.

### Plan Version And Session Shape Hash

Existing migration/lifecycle behavior remains intact:

- `fitness_training_plans.plan_version` remains the plan generation/version counter;
- `training_sessions.session_identity_key` and `training_sessions.session_shape_hash` remain stable identity/shape fields;
- calendar identity markers include plan id, plan version, session id, session identity key, and session shape hash.

### Precise Agenda Cleanup

Existing cancellation behavior remains intact:

- cancellation uses linked provider event IDs and agenda ownership rows;
- identity-marker matching is used for generated Training events;
- broad date-range/title-only deletion remains avoided;
- external delete failures mark ownership rows as `orphaned` for reconciliation.

### Poor-Recovery Variation

Existing poor-recovery variation behavior remains intact and covered by focused tests:

- hybrid weeks stay modality-aware;
- cycling recovery does not repeat one generic card;
- travel weeks use low-burden recovery when appropriate;
- strength weeks rotate safe fallback shapes.

### Weak-Profile Follow-Up Prompts

Existing profile-quality behavior remains intact and covered by focused tests:

- low-confidence profiles surface missing-critical-data flags;
- targeted follow-up questions are emitted;
- profile confidence improves after answers.

### Feedback Ingestion Contract

Existing feedback analysis behavior remains intact and covered by focused tests:

- too hard/easy/long feedback affects future planning;
- soreness/pain can trigger deload logic;
- skipped travel sessions are recognized;
- duration feedback drives duration coherence.

## Remaining Non-Code Conditions

These were not completed in this pass because they require external environments or product approval:

- signed TestFlight/device validation for Training UI, auth, provider state, and HealthKit behavior;
- production-safe Training mutation/calendar proof against an approved production test tenant/calendar;
- any release-copy claim that Training is fully GPT-5.5-runtime powered;
- any release-copy claim that rich feedback adaptation is fully closed-loop until a full end-to-end scenario is captured.

## Release-Gate Impact

Code-level Training gate after this pass: **PASS WITH CONDITIONS**.

No open P0 Training code blocker remains from the requested list. Remaining conditions are evidence/rollout/product-claim gates, not local code blockers found in this pass.
