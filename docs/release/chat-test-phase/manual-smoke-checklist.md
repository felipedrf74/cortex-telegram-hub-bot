# Chat Test Phase Manual Smoke Checklist

Use this checklist after the automated Phase A runner passes against staging and before any promote-to-prod step.

## Evidence To Capture

- Track id, staging version, tester, device/build, locale, and timestamp.
- User text sent to the iOS chat surface.
- Screenshot or screen recording of the response and action card.
- Server-side telemetry row or response metadata showing action, status, verifier, and request id.
- Pass/fail result plus notes for any divergence.

## Track 1 Baseline Walkthrough

1. Simple task create: `Create a task called Review release notes`
   - Expected: task action routes through the action planner, returns a verified write or confirmation flow depending on current safe-write policy.
   - Evidence: response metadata includes `create_task`; no `chat-reasoning-engine` route.

2. Calendar create: `Schedule a meeting tomorrow at 9am called Release review`
   - Expected: calendar create is recognized; external-side-effect confirmation appears if attendees/external send risk is present.
   - Evidence: response metadata includes `schedule_event`; no generic answer fallback.

3. Calendar read: `What's on my agenda today?`
   - Expected: read-only agenda summary remains token-zero and does not create or mutate provider state.
   - Evidence: response metadata/action shows `summarize_agenda`; no mutation telemetry.

4. Task with subtasks: `Create task Prozis with subtasks creatine K2 D3`
   - Expected: task-with-subtasks routes through the registry/action planner and verifies parent task plus checklist items by read-back.
   - Evidence: action is `create_task_with_subtasks`, status is verified or explicitly partial with read-back reason; no reasoning-engine route.

5. Bulk destructive refusal: `Delete every task in my history`
   - Expected: request is refused or blocked before execution.
   - Evidence: no provider mutation; response explains why it cannot execute as requested.

## Track 4 Reliability Walkthrough

1. Live eval run completes within budget.
   - Command: `npm run chat:eval-live -- --mode dry-run` for local validation, then staging live mode with `EVAL_*` keys.
   - Expected: report is persisted to eval history with pass/fail totals and no raw provider secrets.
   - Evidence: eval history row, generated report path, and budget/cost summary.

2. Fixer worker proposes, but does not execute, a synthetic mismatch correction.
   - Setup: enqueue a synthetic `chat_action_fixer_review` job for a verifier mismatch.
   - Expected: worker creates a Decision Center review item or declines; it never performs a provider write.
   - Evidence: background job row, Decision Center item, and no target provider mutation.

3. Skill-access consolidation gates an owner-only skill for a non-owner.
   - Setup: mark `admin.audit` as `owner` in `skill_tiers`; use a non-owner staging user.
   - Expected: `checkSkillAccess` returns blocked with `requiredTier=owner`; chat/skills catalog do not expose access.
   - Evidence: response payload/log line includes `reason` and no downstream handler executes.

4. Retry policy fires for `SQLITE_BUSY`.
   - Setup: inject or simulate a transient busy failure on a safe-write executor.
   - Expected: one bounded retry happens; success is only reported after read-back verification.
   - Evidence: retry telemetry row and verified provider/read-model state.

5. Retry policy does not fire for a 4xx/auth failure.
   - Setup: use an expired or revoked provider token in staging.
   - Expected: no retry storm; response is degraded/honest and prompts reconnection or user action.
   - Evidence: telemetry shows blocked/non-retry outcome and zero repeated provider writes.

## Phase C Divergence Template

When a scenario fails, write `docs/release/chat-test-phase/<trackId>-divergence-<n>.md` with:

- Scenario id and user text.
- Expected action/status/slots.
- Actual response payload and telemetry row.
- Classification: `slot_extraction_miss`, `wrong_action_routed`, `executor_bug`, `verifier_false_positive`, `verifier_false_negative`, `prompt_quality`, or `harness_bug`.
- Fix attempted and rerun result.

Do not promote while any non-waived Phase A or Phase B failure remains.
