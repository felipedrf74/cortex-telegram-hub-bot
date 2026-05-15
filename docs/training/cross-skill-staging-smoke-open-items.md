# Training Cross-Skill Staging Smoke Open Items

## Current Open Items

1. **Real staging credentials/environment are required to close this gate.**
   - The harness refuses runtime validation without staging mode, a staging/test database path, and an isolated staging user ID.
   - Local fixture checks are useful for contract regression, but they are not a staging pass.

2. **Staging test user data must be intentionally seeded.**
   - Secretary needs conflict/travel/focus/admin pressure.
   - Cooking needs at least one hard-session fueling gap.
   - Finance needs a tight or selective training-spend posture.
   - Content needs a workload/filming/next-execution signal.
   - Training-to-Content milestone validation needs a current `content_capture_opportunity` signal.

3. **The smoke is read-only by design.**
   - It does not create fake meals, events, budgets, tasks, or content topics.
   - A future controlled seeding harness could create isolated fixture data, but it must include precise cleanup and tenant-scope guardrails.

4. **Planner behavior is observed through coordination contracts, not full plan generation.**
   - This smoke verifies that Training sees the peer constraints.
   - Separate scenario-generation tests should continue to prove that the planner acts on those constraints when producing plans.

5. **Runtime signal freshness is still an ops concern.**
   - If staging data exists but peer contexts return no signals, check the refresh jobs and cache invalidation paths before assuming the planner is wrong.

## Required Before Closing Priority 9

- Run `scripts/training-cross-skill-staging-smoke.sh` with a real staging env file.
- Attach a results report showing the required flows as pass, or document precise blocked fixture gaps.
- If fixture gaps are the blocker, seed the isolated staging user and rerun.
