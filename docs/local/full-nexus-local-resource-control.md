# Full Nexus Local Resource Control

## Defaults

- Backend binds to `127.0.0.1`.
- Local DB is isolated at `data/local-full-nexus-smoke.db`.
- Telegram legacy delivery is disabled.
- Model provider keys are blank unless `NEXUS_LOCAL_ALLOW_MODEL_CALLS=1`.
- Content engine sidecar is off unless `NEXUS_LOCAL_START_CONTENT_ENGINE=1`.

## Resource Checks

```bash
scripts/full-nexus-local-engine.sh status
lsof -nP -iTCP:8200 -sTCP:LISTEN
ps aux | rg 'dist/index.js|content-engine/main.py|full-nexus' -n
```

## Shutdown

```bash
scripts/full-nexus-local-engine.sh stop
```

When using attached `up` mode, stop the foreground process with Ctrl-C. In a
non-interactive Codex shell, the validation run stopped the attached backend by
killing the logged Node PID and then running `cleanup`.

## Cleanup

```bash
scripts/full-nexus-local-engine.sh cleanup
FULL_NEXUS_RESET_DB=1 scripts/full-nexus-local-engine.sh cleanup
```

Use DB reset only when you intentionally want to remove local smoke data.
