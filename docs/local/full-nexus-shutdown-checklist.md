# Full Nexus Shutdown Checklist

Date: 2026-04-29
Purpose: stop local full-product smoke cleanly and prove no local runtime remains

## Normal Shutdown

From the backend repo:

```bash
cd "/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot"
scripts/full-nexus-local-engine.sh stop
```

Then remove local auth artifacts:

```bash
scripts/full-nexus-local-engine.sh cleanup
```

Reset the local DB only when intentional:

```bash
FULL_NEXUS_RESET_DB=1 scripts/full-nexus-local-engine.sh cleanup
```

## Verify Backend And Sidecar Ports

Default backend:

```bash
lsof -nP -iTCP:8200 -sTCP:LISTEN || true
```

Optional content engine:

```bash
lsof -nP -iTCP:8102 -sTCP:LISTEN || true
```

If using a custom port, verify that port too:

```bash
lsof -nP -iTCP:${PORTAL_PORT:-8200} -sTCP:LISTEN || true
```

Expected result: no listener unless intentionally left running.

## Verify No Local Runtime Processes Remain

```bash
ps aux | rg 'dist/index.js|content-engine/main.py|full-nexus-local-engine|chat-tenant-security-smoke|training-cross-skill-staging-smoke|chat-evaluation-harness|chat-day-to-day-simulation' || true
```

Expected result: no backend, content-engine, smoke, evaluation, or model-loop
process remains.

## Verify Local Auth Artifacts

Default auth file:

```bash
test ! -f ".local/full-nexus/local-ios-auth.json" && echo "local auth removed" || echo "local auth still present"
```

Custom state directory:

```bash
find "${FULL_NEXUS_STATE_DIR:-.local/full-nexus}" -name 'local-ios-auth.json' -print
```

Expected result after cleanup: no local auth JSON.

## Verify Local DB State

If the DB should be preserved for inspection:

```bash
ls -lh data/local-full-nexus-smoke.db* 2>/dev/null || true
```

If the DB should be deleted:

```bash
FULL_NEXUS_RESET_DB=1 scripts/full-nexus-local-engine.sh cleanup
ls -lh data/local-full-nexus-smoke.db* 2>/dev/null || true
```

Expected result after reset: no `local-full-nexus-smoke.db`, `-wal`, or `-shm`
files.

## Verify iOS Simulator State

List booted simulators:

```bash
xcrun simctl list devices booted
```

Stop the app if the simulator is intentionally kept open:

```bash
xcrun simctl terminate booted me.nexushub.app 2>/dev/null || true
```

Shutdown all booted simulators when the smoke is complete:

```bash
xcrun simctl shutdown all 2>/dev/null || true
xcrun simctl list devices booted
```

Expected result: no booted simulators unless a developer intentionally keeps
one open.

## Verify Local Backend URL Is Not Accidentally In Use

The iOS app ignores local URLs unless the DEBUG allow gate is passed, but a
running debug simulator can still show a connectivity banner if it was launched
against a stopped local backend.

Production-style launch should omit these args:

```text
-nexus_debug_local_auth_import YES
-nexus_allow_local_backend YES
-nexus_base_url http://127.0.0.1:8200
```

If the app is still running from a local launch:

```bash
xcrun simctl terminate booted me.nexushub.app 2>/dev/null || true
```

Then relaunch without local args for production/default behavior.

## Verify No Provider Or Tunnel Loops

```bash
ps aux | rg 'OPENAI_API_KEY|GEMINI_API_KEY|ANTHROPIC_API_KEY|ngrok|cloudflared|localtunnel|provider|model-call' || true
```

Expected result: no local tunnel or provider-call loop remains.

## Cleanup Pass Criteria

Mark cleanup `PASS` only when:

- backend port is free
- content-engine port is free or intentionally left running
- no local backend/smoke/evaluation/model-loop process remains
- local auth JSON is removed
- local DB is removed when reset was requested
- no booted simulator remains unless intentionally kept open
- no tunnel remains
- no real provider-call loop remains

If any item remains, document the PID, port, file path, or simulator UDID and
do not mark cleanup passed.
