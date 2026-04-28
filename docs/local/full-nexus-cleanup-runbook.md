# Full Nexus Cleanup Runbook

## Normal Cleanup

```bash
scripts/full-nexus-local-engine.sh cleanup
```

This stops runner-owned backend/content-engine processes and removes the local
auth token file.

## DB Reset

```bash
FULL_NEXUS_RESET_DB=1 scripts/full-nexus-local-engine.sh cleanup
```

This removes:

- `data/local-full-nexus-smoke.db`
- `data/local-full-nexus-smoke.db-shm`
- `data/local-full-nexus-smoke.db-wal`

## Artifact Locations

| Artifact | Path |
| --- | --- |
| PID files | `.local/full-nexus/*.pid` |
| Logs | `.local/full-nexus/logs/` |
| Local auth | `.local/full-nexus/local-ios-auth.json` |
| Local DB | `data/local-full-nexus-smoke.db` |

## Provider Artifacts

The local runner does not create real Google/Outlook provider events. If a
staging smoke is run separately, use the staging smoke cleanup report and event
IDs from that runbook, not broad date-range deletion.
