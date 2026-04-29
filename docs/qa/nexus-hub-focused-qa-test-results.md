# Nexus Hub — Focused QA Test Results

**Generated:** 2026-04-29 18:48 WEST (Wave 1) + 19:30 WEST (Wave 2 Opus rerun, full suite verification)
**Audit branch:** `qa/nexus-hub-focused-review-selected-areas`
**HEAD:** `e1591f6` (Opus rerun on top of `a0341d5` Sonnet baseline on top of `888b69e`)

## Summary — Wave 1 (focused targets)

| Metric | Value |
|---|---|
| Test files run | 14 |
| Total tests | 140 |
| Passed | 140 |
| Failed | 0 |
| Skipped | 0 |
| Typecheck | clean (`npx tsc --noEmit` exit 0) |

## Summary — Wave 2 (full pre-commit suite, ran twice)

| Run | Trigger | Test files | Tests | Pass | Fail | Skip | Duration |
|---|---|---|---|---|---|---|---|
| 1 | `git commit` for `a0341d5` (Sonnet baseline) | 410 | 6233 | 6233 | 0 | 0 | 485.24s |
| 2 | `git commit` for `e1591f6` (Opus rerun) | 410 | 6247 | 6247 | 0 | 0 | 493.63s |

Test count difference (6233 → 6247) reflects additional uncommitted Codex tests added between the two commits. Both runs green.

`npx tsc --noEmit` exits 0 against the full uncommitted change set. **The test layer is healthy.**

> Wave 1 test execution ran on the general-purpose subagent (test runner is a deterministic operation, no model-tier impact). Wave 2 verification was the pre-commit hook running the full suite twice in sequence on each commit.

**The test layer is healthy against the working tree.** Every focused target — including 6 brand-new uncommitted Codex test files (`skill-memory`, `skill-version-registry`, `content-tenant-scope`, `content-domain-ontology`, `content-reference-provenance`, `content-dedup-routing`) — passes cleanly. The full uncommitted change set (50+ modified/new files including migrations 087–092 and the new content-domain-ontology / content-editorial-workflow / content-reference-context / skill-memory / skill-version-registry services) typechecks without error.

This is necessary but not sufficient. **The audit findings (15 P0 + 20 P1) describe gaps the existing tests do not exercise.** A green test layer means "the written tests pass against the written code"; it does not mean "all tenant-isolation, kill-switch, and authorization properties hold."

## Test execution detail

| # | Test target | Files | Tests | Pass | Fail | Skip | Duration |
|---|---|---|---|---|---|---|---|
| 1 | `__tests__/services/skill-memory.test.ts` | 1 | 9 | 9 | 0 | 0 | 2.41 s |
| 2 | `__tests__/services/skill-version-registry.test.ts` | 1 | 6 | 6 | 0 | 0 | 1.60 s |
| 3 | `__tests__/services/content-tenant-scope.test.ts` | 1 | 4 | 4 | 0 | 0 | 15 ms |
| 4 | `__tests__/services/content-domain-ontology.test.ts` | 1 | 7 | 7 | 0 | 0 | 3 ms |
| 5 | `__tests__/services/content-reference-provenance.test.ts` | 1 | 4 | 4 | 0 | 0 | 13 ms |
| 6 | `__tests__/services/content-dedup-routing.test.ts` | 1 | 2 | 2 | 0 | 0 | 5 ms |
| 7 | `__tests__/api/content-home-route.test.ts` + `content-learning-routes.test.ts` + `content-reference-routes.test.ts` | 3 | 19 | 19 | 0 | 0 | 934 ms |
| 8 | `__tests__/services/channel-learner-scope.test.ts` + `content-workflow-user-scope.test.ts` | 2 | 5 | 5 | 0 | 0 | 1.27 s |
| 9 | `__tests__/services/python-engine-hardening.test.ts` + `__tests__/api/internal-routes.test.ts` + `__tests__/api/skills-routes.test.ts` | 3 | 84 | 84 | 0 | 0 | 4.98 s |
| 10 | `npx tsc --noEmit` | n/a | n/a | n/a | n/a | n/a | exit 0 |

**Totals (steps 1-9):** 14 test files, 140 tests, 140 passed, 0 failed, 0 skipped.

## Coverage gaps identified by the audit (tests that do NOT exist)

The audit identified the following missing test coverage. These are tests that *should* exist but currently do not.

### Authorization adversarial tests

- **A-P0-1:** No test asserting an unknown tool name (e.g. `weird_unmapped_tool`) is rejected before dispatch in `tool-executor.ts`.
- **A-P0-2:** No test asserting that a tool call without an authorization context is denied (current default is `allowed: true`).
- **G-P0-1:** No test asserting that `setSkillVersionStatus`/`activateSkillVersion` from a non-admin caller is denied.
- **H-P0-1:** No test where a user from tenant B queries tenant A's `tenant_shared` memory and is denied.

### Tenant-isolation adversarial tests

- **E-P0-1, E-P0-2, E-P0-3:** No test asserting that `getArtifactChain`, `getScriptByPipelineId`, learned-pattern queries return null/error when called with a wrong tenant.
- **I-P0-2:** No test asserting `training_agenda_event_ownership` rows are scoped to the calling tenant.

### Operational saga tests

- **I-P0-1:** No integration test for any of the 5 cancellation-saga branches (`success`, `no_active_plan`, `external_partial`, `forbidden`, `local_delete_failed`).
- **D-P1-2:** No test asserting `plan_version` increments before re-persist on regeneration.
- **D-P3-2:** No test file for slice 4.E (real metrics history reads).

### Crash-path tests

- **D-P0-1:** No test for adaptation engine when `readiness === undefined`.
- **D-P0-2:** No test for biomechanics substitution when `painFlags === undefined`.
- **D-P0-3:** No test for session coherence when `claimedMinutes === 0`.

### Provider routing parity tests

- **B-P1-1:** No test asserting OpenAI/Gemini honor `getDomainModelOverride`.
- **B-P1-2:** No test asserting `internal/ai-complete` resolves through override system.

### Cross-skill orchestration tests

- **F-P1-1:** No test asserting Cooking/Secretary memory entries tagged with a Training plan version are marked stale on plan cancellation.
- **F-P1-3:** No test for warning deduplication at the chat surface.
- **F-P1-4:** No end-to-end test asserting Training/Cooking/Finance schedule via Secretary intent submission.

### Calendar/agenda lifecycle tests

- **I-P1-2:** No test asserting all 11 lifecycle states (`proposed`, `synced`, `deferred`, `failed_sync`, `completed`, etc.) can be reached via the orchestration code paths.
- **I-P2-1:** Staging smoke does not exercise plan create → external-delete simulation → regenerate.
- **I-P2-2:** No test for provider read-back validation (404 on `getEvent` → `readback_failed` state).

## What was attempted and could not run

- **iOS local smoke** was not attempted from the backend repo. The iOS branch (`feature/ios-content-creation-intelligence-upgrade`) has 4 commits today and 2 uncommitted docs; signed TestFlight + simulator smoke remains a manual gate.
- **Real Google/Outlook calendar staging smoke** for the cancellation saga was not attempted — staging credentials were out of scope for this code-level QA pass.
- **Full backend `npm run verify`** (368 test files / 5,875 tests per CLAUDE.md) was not run; the audit ran the targeted subset listed above. A full `npm run verify` is recommended before any blocker-fix PR merges.
- **Tenant-isolation adversarial tests** could not be run because they do not exist (see coverage gaps above). The audit's tenant-leakage findings (E-P0-1/2/3, H-P0-1, I-P0-2) are evidence-based on code review, not on test failure.

## Recommendations from the test layer

1. Before merging any P0 fix, expand the matching test file with the adversarial case the fix must satisfy. Example: A-P0-1 fix should land with a test asserting `executeToolCall('not_a_real_tool', ...)` returns an error.
2. Add a `__tests__/scope/` test suite that systematically asserts every content/memory/agenda query refuses cross-tenant access.
3. Run `npm run verify` (full suite) before each block of blocker fixes lands. The 140-test focused subset is fast feedback; the full 5,875-test suite is the merge gate.
