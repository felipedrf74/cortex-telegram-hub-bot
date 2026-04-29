# Content Local Cleanup Confirmation

Date: 2026-04-29
State dir: `.local/content-full-nexus-smoke`
Database: `data/content-full-nexus-smoke.db`

## Cleanup Commands

```bash
mcp xcodebuild stop_app_sim
```

```bash
FULL_NEXUS_STATE_DIR=.local/content-full-nexus-smoke \
DATABASE_PATH="$PWD/data/content-full-nexus-smoke.db" \
FULL_NEXUS_RESET_DB=1 \
NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 \
scripts/full-nexus-local-engine.sh cleanup
```

## Cleanup Result

Status: `PASS`

Observed final state:

- iOS app `me.nexushub.app` stopped successfully in simulator `A0B13967-B5DE-4E6F-897D-F1E409093F94`.
- backend listener on `127.0.0.1:8200` stopped.
- content-engine sidecar not running.
- local auth token absent after cleanup.
- local smoke DB `data/content-full-nexus-smoke.db` removed.
- no local backend listener remained according to runner status.
- no tunnels were started.
- no provider-call loops were started.
- no real provider calls were made.

Additional focused sidecar cleanup after the production-blocker follow-up:

- fixture-mode content-engine was started on `127.0.0.1:18102`.
- `/api/v1/script` fixture smoke returned HTTP 200 with `degraded=true` and no AI proxy/provider call.
- sidecar process `43804` was stopped.
- port `18102` had no remaining listener after cleanup.

Additional Content smoke wrapper validation:

- `scripts/content-full-nexus-local-smoke.sh run` completed.
- The wrapper built/started the local backend, ran authenticated API smoke, cross-skill fixtures, Chat tenant smoke, Content tests/eval/persist steps, then invoked cleanup.
- Latest cleanup stopped backend PID `6181`, confirmed `content engine: not running`, and no listener on `127.0.0.1:8200`.
- Local smoke DB `data/content-full-nexus-smoke.db` was removed.
- Eval-history artifact intentionally remains at `reports/content-eval/content-eval-history.sqlite` for release evidence.

Command output:

```text
content engine: not running
backend: not running
Port verification:
Removed local smoke DB: /Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/data/content-full-nexus-smoke.db
Cleanup complete.
Backend PID: none
Backend running: no
Backend listener: no
Content PID: none
Content running: no
Backend listener: no
Auth token: absent
```
