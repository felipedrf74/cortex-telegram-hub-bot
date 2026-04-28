# Full Nexus Product Engine Local Runbook

Date: 2026-04-28

## Goal

Run the complete local Nexus product backend behind iOS without using
production data or production calendars.

## Quick Start

```bash
cd "/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot"
scripts/full-nexus-local-engine.sh doctor
scripts/full-nexus-local-engine.sh start
scripts/full-nexus-local-engine.sh auth-token
scripts/full-nexus-local-engine.sh smoke
scripts/full-nexus-local-engine.sh stop
```

In Codex/CI shells that reap detached background jobs, use an attached run in
one terminal/session:

```bash
scripts/full-nexus-local-engine.sh up
```

Then run `health`, `auth-token`, or `smoke` from a second terminal/session.

## Commands

| Command | What it does |
| --- | --- |
| `doctor` | Prints branch, commit, ports, env, tool availability, and model-call mode. |
| `start` | Builds TS backend and starts the local API on loopback. |
| `up` | Builds and runs the backend attached in the foreground. |
| `health` | Calls public `/api/v1/` and optional content-engine health. |
| `auth-token` | Creates a local beta sandbox iOS session and saves the token. |
| `smoke` | Runs health plus authenticated iOS API smoke when token is available. |
| `status` | Prints PIDs, ports, local DB, and token file status. |
| `stop` | Stops backend/content-engine processes started by the runner. |
| `cleanup` | Stops services, removes auth token, and optionally removes the local DB. |

## Optional Content Engine

The Python content engine is not required for basic iOS API smoke. Start it
only when validating content research/sidecar behavior:

```bash
NEXUS_LOCAL_START_CONTENT_ENGINE=1 scripts/full-nexus-local-engine.sh start
```

## Optional Model Calls

Default smoke blanks model provider keys to avoid runaway cost:

```bash
scripts/full-nexus-local-engine.sh start
```

Run a bounded reasoning-quality smoke only when intentionally needed:

```bash
NEXUS_LOCAL_ALLOW_MODEL_CALLS=1 scripts/full-nexus-local-engine.sh start
```

Record every real model-call smoke in `docs/local/gpt55-smoke-test-usage-notes.md`.

## Local API URL

Default:

```text
http://127.0.0.1:8200
```

Use this for iOS simulator launch arguments:

```text
-nexus_allow_local_backend YES
-nexus_base_url http://127.0.0.1:8200
```

## Safety Rules

- Never source production `.env` for local full-engine smoke.
- Do not enable Google/Outlook real provider writes from this runner.
- Keep `TELEGRAM_LEGACY_DELIVERY=false`.
- Keep `PORTAL_BIND=127.0.0.1`.
- Stop services with `scripts/full-nexus-local-engine.sh stop`.
- Verify port `8200` is free after shutdown.
