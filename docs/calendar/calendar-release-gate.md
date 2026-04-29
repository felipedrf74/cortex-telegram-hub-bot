# Calendar Release Gate

Date: 2026-04-29

Branch: `feature/secretary-scheduling-arbitrator-batch4`

Final verdict: **PASS WITH CONDITIONS**

## Evidence Summary

| Gate | Result | Evidence |
| --- | --- | --- |
| Local Secretary calendar lifecycle smoke | PASS | `docs/calendar/local-calendar-smoke-results.md` |
| Google staging provider smoke | PASS | `docs/calendar/google-staging-smoke-results.md` |
| Outlook staging provider smoke | PASS | `docs/calendar/outlook-staging-smoke-results.md` |
| TypeScript typecheck | PASS | `npm run typecheck` |
| Build | PASS | `npm run build` |
| Staging cleanup sweep | PASS | Independent provider scan found `leftoverCount=0` for `[NEXUS SECRETARY STAGING]` and `NEXUS_SECRETARY_AGENDA_ITEM` markers. |

## Staging Runs

| Provider | Run ID | Result | Summary |
| --- | --- | --- | --- |
| Google | `secretary-calendar-google-final-20260429122125` | PASS | 8/8 operations passed with read-back and cleanup. |
| Outlook | `secretary-calendar-outlook-final-20260429122259` | PASS | 8/8 operations passed with read-back and cleanup. |

## Operations Proven

Both staging providers validated:

- create
- update/move
- retry idempotency
- stale duplicate cleanup
- external provider deletion repair
- regenerate/superseded cleanup
- replacement create
- cancel/delete
- read-back verification
- final cleanup

## Important Fixes Found During Smoke

The smoke caught and this branch fixed two real provider-lifecycle issues before final evidence was accepted:

1. Provider read-back originally used `unified-calendar.getEvents`, whose deduplication could hide duplicate events from Secretary repair. The adapter now uses provider-specific Google/Outlook reads for marker-based lifecycle repair.
2. Outlook rejected Secretary-owned creates because categories included both `Secretary` and `secretary`. Categories are now deduped case-insensitively before create.

## Conditions Before Production Deployment

This gate is `PASS WITH CONDITIONS`, not unconditional `GO`, because:

- The staging provider smoke ran from a temporary staging-side build, not from the live PM2 staging service.
- Generic calendar REST writes and Chat/tool direct calendar writes can still bypass Secretary agenda ownership until those routes are migrated.
- iOS has not been rerun against this exact calendar lifecycle payload.

Required before production deployment:

1. Commit and push the backend release branch containing these fixes.
2. Deploy the same branch to staging through the normal staging deploy path.
3. Rerun the focused Secretary calendar staging smoke against the deployed staging service or approved staging-side release artifact.
4. Migrate or explicitly gate generic calendar/Chat tool write paths that bypass Secretary if the release claim is "Secretary owns all agenda lifecycle."
5. Run the relevant iOS local/staging smoke for richer agenda lifecycle rendering if the UI surface is in scope.

## Safety Confirmation

- No production calendars were used.
- Provider events were titled with `[NEXUS SECRETARY STAGING]`.
- Provider cleanup used exact event IDs and Secretary markers.
- No broad date-range deletion was used.
- Independent cleanup sweep found no leftover staging smoke events.
