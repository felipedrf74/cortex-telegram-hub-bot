# Full Nexus Local Cleanup Confirmation

Date: 2026-04-29
Run ID: `full-nexus-local-smoke-20260429T1115`
Local base URL: `http://127.0.0.1:8212`

## Cleanup Verdict

`PASS`

No local backend, worker, content sidecar, simulator, tunnel, container, or
provider-call loop remains from this smoke.

## Commands Run

Stopped the iOS app/simulator:

```bash
xcrun simctl shutdown A0B13967-B5DE-4E6F-897D-F1E409093F94
```

Stopped the attached backend with `SIGINT`:

```text
^C
```

Backend shutdown log showed:

```text
Shutting down...
SQLiteStorage closed
Database closed
```

Removed local state and DB:

```bash
FULL_NEXUS_STATE_DIR=.local/full-nexus-local-smoke-20260429T1115 \
PORTAL_PORT=8212 \
FULL_NEXUS_BASE_URL=http://127.0.0.1:8212 \
DATABASE_PATH="$PWD/data/full-nexus-local-smoke-20260429T1115.db" \
FULL_NEXUS_RESET_DB=1 \
scripts/full-nexus-local-engine.sh cleanup
```

Cleanup output:

```text
content engine: not running
backend: not running
Port verification:
Removed local smoke DB: /Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/data/full-nexus-local-smoke-20260429T1115.db
Cleanup complete.
```

## Verification Matrix

| Resource | Verification command | Result |
| --- | --- | --- |
| Backend port `8212` | `lsof -nP -iTCP:8212 -sTCP:LISTEN` | PASS - no listener |
| Default backend port `8200` | `lsof -nP -iTCP:8200 -sTCP:LISTEN` | PASS - no listener |
| Content sidecar port `8102` | `lsof -nP -iTCP:8102 -sTCP:LISTEN` | PASS - no listener |
| Backend/smoke/model processes | `pgrep -fl "dist/index.js|content-engine/main.py|full-nexus-local-engine|chat-tenant-security-smoke|training-cross-skill-staging-smoke|chat-evaluation-harness|chat-day-to-day-simulation|ngrok|cloudflared|localtunnel"` | PASS - no matches |
| Local auth JSON | `test ! -f .local/full-nexus-local-smoke-20260429T1115/local-ios-auth.json` | PASS - removed |
| Local DB | `data/full-nexus-local-smoke-20260429T1115.db*` | PASS - removed |
| iOS simulator | `xcrun simctl list devices booted` | PASS - no booted iOS simulator |
| Containers | `docker ps --format ...` | PASS - no local smoke container output |
| Tunnels | included in process scan | PASS - no tunnel process matched |
| Provider-call loops | included in process scan | PASS - no model/provider loop matched |

## Notes

- The backend was run in attached `up` mode, so no runner PID file was expected.
- The optional content-engine sidecar was not started.
- Real provider calls were not enabled; `NEXUS_LOCAL_ALLOW_MODEL_CALLS=0`.
- No staging or production services were touched.
