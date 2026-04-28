# Training Calendar Staging Smoke Open Items

## Open Items

1. **Real staging credentials were not available in the current shell.**
   - Current status: blocked before provider clients loaded.
   - Missing prerequisites are listed in `docs/training/calendar-staging-smoke-results.md`.
   - Required next action: run the harness with a staging env file and a staging user that has connected Google and Outlook OAuth tokens.

2. **Provider description read-back may differ by provider.**
   - Google returns full event descriptions in the current read path.
   - Outlook calendar-view reads currently expose `bodyPreview`, which can truncate long descriptions.
   - The smoke verifies event IDs, title prefix, and run ownership; if we need to assert the full identity marker after write, add provider-specific `getEventById` helpers that fetch full Google description and Outlook body content.

3. **The smoke currently validates provider lifecycle semantics, not the full app API route flow.**
   - It exercises the same unified calendar provider APIs and identity-marker payload shape used by Training.
   - A future stage can seed an isolated staging plan/session row and call `syncTrainingPlanCalendar` plus cancellation saga end to end once we have a safe dedicated staging user/calendar.

4. **Crash recovery cleanup is intentionally manual-first.**
   - The harness precisely deletes IDs it created during the run.
   - If the process is killed before `finally` cleanup, use the reported event IDs or a future marker-verified cleanup command.
   - Do not add broad date/title deletion.

## Required Before Production Trust Gate Can Be Closed

- Run Google staging smoke with read-back and cleanup success.
- Run Outlook staging smoke with read-back and cleanup success.
- Attach the resulting `docs/training/calendar-staging-smoke-results.md` to the Training release packet.
