# Backend runtime local smoke results

## Local engine

Command:

```bash
NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 scripts/full-nexus-local-engine.sh start
NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 scripts/full-nexus-local-engine.sh smoke
```

Result:

- backend health: passed
- auth token generation: passed
- authenticated API smoke: 13/13 passed

Smoke covered:

- Dashboard
- Plan today/week
- Task lists
- Today tasks
- Training summary/today
- Content pipeline/intelligence
- Current meal plan
- Finance monthly summary
- Connections
- Inbox

## Attached engine validation

Command:

```bash
NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 scripts/full-nexus-local-engine.sh up
```

Attached mode was required because detached jobs can be reaped by the Codex shell.

Validation performed:

- generated local auth token
- hit Home / Plan / Tasks / Training / Connections / Skills read endpoints
- ran synthetic authenticated read burst
- confirmed authenticated reads use `X-RateLimit-Bucket: user-read`
- confirmed no read burst `429`

## Cleanup

Local backend process was stopped after validation. Final cleanup status is recorded in the final report.

