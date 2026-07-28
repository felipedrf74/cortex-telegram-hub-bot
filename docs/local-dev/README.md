# Nexus Hub — local Docker sandbox

A one-command local-development environment for the Nexus Hub backend +
Python content engine, with iOS Simulator wiring. It is isolated from the
exact-artifact staging→production chain; nothing here modifies PM2 or the
staging install on the remote Linux host.

This is the **default** local-dev path. If you need a native (non-Docker)
runner — for example to attach a Node debugger or run with PM2 — the
existing `scripts/full-nexus-local-engine.sh` still works.

---

## What you get

| Piece | Where it runs | Default port |
| --- | --- | --- |
| Node engine (`@nexushub/core`) | container `nexus-hub-node` | `127.0.0.1:8200` |
| Python content engine (FastAPI) | container `nexus-hub-content-engine` | `127.0.0.1:8100` |
| SQLite DB | host-side `./data/local.db` | — |
| iOS app | Xcode Simulator on the host | hits `127.0.0.1:8200` |

Ports are bound to **loopback only** (`127.0.0.1`). The sandbox does
not leak onto your LAN.

---

## First-time setup

You'll need:
- Docker Desktop running (`docker --version` and `docker compose version`
  should both work).
- Xcode + simulator tools if you want the iOS path (`xcrun simctl list
  devices` should show at least one device).
- A `.env.local` with at least one AI provider key.

```bash
# 1. From the repo root
cd "$(git rev-parse --show-toplevel)"

# 2. Copy the env template and fill in your dev-tier keys
cp .env.local.example .env.local
$EDITOR .env.local
# At minimum, fill in ONE of: ANTHROPIC_API_KEY or GEMINI_API_KEY.
# Leave OAUTH/Stripe/Garmin/etc. blank if you don't need them — the
# code degrades gracefully.

# 3. Boot the sandbox
./scripts/local-up.sh
# Expected: both containers report healthy within ~60s on a warm Mac
# (first build takes 2–4 min while npm ci + pip install run).

# 4. Sanity-check
./scripts/local-smoke.sh
# Expected: 5/5 green
```

If `local-smoke.sh` returns 5/5, the engine is operational.

---

## Daily loop

```bash
./scripts/local-up.sh         # idempotent — no-op if already running
./scripts/local-smoke.sh      # 5-check contract before push

# When you finish:
./scripts/local-down.sh       # stop, keep data/
```

### One-click cockpit (alternative)

If you'd rather click buttons than type commands:

```bash
./scripts/cockpit.sh
```

Opens a browser cockpit at `http://127.0.0.1:8210` with every action
above as a button, plus live container status chips, today's AI
spend pill, streaming container logs, a focused vitest runner, dev
JWT minting, and a Finder-launcher row. The cockpit talks to the same
sandbox and respects the same 30s per-command cooldowns the rest of
the codebase uses for portal actions. Full details in
`scripts/cockpit/README.md`.

`tsx watch` is wired through the Node container, so editing files
under `src/` triggers a rebuild within a few seconds. Editing files
under `content-engine/` triggers uvicorn's `--reload`.

---

## iOS Simulator path

The iOS app's `NexusConfig.swift` already supports a local backend.
You have two ways to wire it up:

### Option A — Xcode scheme (recommended)

In Xcode:
1. Product → Scheme → Manage Schemes → duplicate the existing scheme,
   name it **"Nexus Hub Local Dev"**.
2. Edit the new scheme → Run → Arguments → Arguments Passed On Launch.
3. Add these two arguments (both checked):
   - `-nexus_allow_local_backend YES`
   - `-nexus_base_url http://127.0.0.1:8200`
4. Optional but recommended for simulator social-button auth against the
   sandbox: add `-nexus_local_auth_invite_code LOCAL-DEV-INVITE` using the
   value from `.env.local`'s `IOS_INVITE_CODE`.
5. Save. Selecting this scheme and pressing Run points the app at the
   local sandbox.

### Option B — `sim-local.sh` (one command)

```bash
./scripts/sim-local.sh
```

Boots the sandbox, chooses an available iPhone Simulator, then builds +
installs + launches the app with the launch args already set. By
default it prefers an already-booted iPhone, then the newest available
`iPhone 17 Pro`. Overridable env:

| Env var | Default | What it does |
| --- | --- | --- |
| `NEXUS_SIM_DEVICE` | auto | Preferred simulator device name, e.g. `iPhone 17 Pro`. |
| `NEXUS_SIM_UDID` | unset | Exact simulator UDID override. |
| `NEXUS_IOS_PROJECT_PATH` | `/Users/felipedominguez/.../Nexus Hub.xcodeproj` | Path to the `.xcodeproj`. |
| `NEXUS_IOS_SCHEME` | `Nexus Hub` | Scheme to build. |
| `NEXUS_IOS_BUNDLE_ID` | `me.nexushub.app` | Bundle ID to launch. |
| `NEXUS_LOCAL_PORT_TS` | `8200` | Host port the app should hit. |
| `NEXUS_SIM_AUTH_INVITE_CODE` | `.env.local` `IOS_INVITE_CODE` | DEBUG-only sandbox auth shortcut used by the Apple/Google buttons in the local simulator. |
| `NEXUS_SIM_CONSOLE` | `0` | Set to `1` to attach `simctl --console-pty`; default exits after launch for Cockpit. |
| `NEXUS_SIM_RESOLVE_ONLY` | `0` | Set to `1` to print the selected simulator and exit without boot/build/install. |

If `xcrun simctl` isn't available (e.g., running this from a CI shell),
the script prints the manual instructions and exits.

---

## What's in the smoke contract

`./scripts/local-smoke.sh` runs five checks. All must pass for "ready
to push":

1. **`GET /health`** → 200 with `status: healthy` (or `ok`).
2. **`GET /api/snapshot`** → 200 with `.version` and `.uptime`.
3. **`GET /api/v1/dashboard`** with no auth → **401** with the canonical
   error envelope `{ok: false, error: {code, message}, timestamp}`.
   This is the single most important check — a malformed envelope
   breaks the iOS app at the dashboard screen.
4. **`GET /api/cost-by-domain?days=7`** → 200 with the dashboard shape
   (`totalCost`, `providerSplit`, `dailySeries`).
5. **`PRAGMA integrity_check`** on the SQLite DB → `ok`.

If `.env.local` defines `PORTAL_READ_TOKEN`, `PORTAL_WRITE_TOKEN`,
`PORTAL_ADMIN_TOKEN`, or `PORTAL_TOKEN`, the smoke script sends the strongest
available read-compatible bearer token for portal-scoped checks such as
`/api/snapshot` and `/api/cost-by-domain`.

This mirrors the contract in `scripts/staging-smoke.sh` minus the PM2
process checks (compose health replaces those).

---

## Reset and recover

| Goal | Command |
| --- | --- |
| Stop the sandbox, keep data | `./scripts/local-down.sh` |
| Full wipe (drops DB + named volumes) | `./scripts/local-reset.sh` |
| Force rebuild without losing data | `./scripts/local-down.sh && docker compose -f docker-compose.local.yml build --no-cache && ./scripts/local-up.sh` |
| Inspect logs live | `docker compose -f docker-compose.local.yml logs -f` |
| Shell into the Node container | `docker compose -f docker-compose.local.yml exec nexus-hub bash` |
| Run SQLite queries on the local DB | `docker compose -f docker-compose.local.yml exec nexus-hub sqlite3 /app/data/local.db` |

The `data/` directory on the host is bind-mounted into the container,
so the DB persists across `local-down.sh` and `local-up.sh`. Only
`local-reset.sh --yes` wipes it.

---

## Cost cap

`.env.local.example` ships with `GLOBAL_DAILY_COST_LIMIT=5.00` — a hard
ceiling across all AI providers. The local sandbox is not metered any
differently than prod; if you hit the cap, the routing layer refuses
new AI calls until UTC midnight. Raise the cap in your private
`.env.local` (don't commit the change) only if you genuinely need it.

---

## Troubleshooting

### `local-up.sh` hangs at "Waiting for local sandbox to become healthy"

- `docker compose -f docker-compose.local.yml logs --tail=50` — read the
  last 50 lines of each container.
- If you see `EADDRINUSE :8200`, another process owns the port. Either
  stop the other process, or override the host port:
  `NEXUS_LOCAL_PORT_TS=8210 ./scripts/local-up.sh` and update
  `.env.local`'s `PORTAL_PORT` to match.

### iOS app stays on the prod URL

- Confirm the scheme has both launch args (Edit Scheme → Run → Arguments).
  Both must be **checked**.
- Confirm the build is a Debug build. NexusConfig rejects local URLs in
  Release builds by design.
- Reset the simulator's app data: Device → Erase All Content and Settings.

### Apple/Google buttons fail in the local simulator

- Use `./scripts/sim-local.sh` or Cockpit's **Launch iOS Simulator** button.
  They pass `-nexus_local_auth_invite_code` automatically from `.env.local`.
- In this DEBUG-only local backend mode the social buttons sign into the
  sandbox through the existing invite registration route. Real Apple/Google
  OAuth remains unchanged for TestFlight/devices.
- If you launch manually from Xcode, add the three launch args listed above.
- If Simulator memory grows after a run, use `./scripts/sim-down.sh` or
  Cockpit's **Shutdown iOS Simulator** button.

### Hot reload not picking up changes

- Confirm `CHOKIDAR_USEPOLLING=true` is set in the container env (it is
  by default — `docker-compose.local.yml` sets it on the Node service).
- macOS file-event propagation through bind mounts is slow; expect 2–5s
  lag. Anything longer than 10s means tsx isn't watching — restart the
  Node container: `docker compose -f docker-compose.local.yml restart
  nexus-hub`.

### "I broke the DB"

- `./scripts/local-reset.sh --yes` wipes everything and rebuilds from
  migrations. The local DB is throwaway — don't store anything you need
  to keep.

### Provider key error on first AI call

- Check `.env.local` has a non-empty `ANTHROPIC_API_KEY` or
  `GEMINI_API_KEY` (or both).
- Some routes need at least one key even if the route itself doesn't
  call an AI; the routing layer probes provider availability on startup.

---

## Relation to the staging→prod chain

- `./scripts/local-smoke.sh` is a **pre-staging filter**, not a
  replacement for `staging-smoke.sh`. Both exist; staging-smoke runs
  against the remote Linux box and has additional PM2 + remote-DB
  checks. The local smoke catches "does my change even boot."
- `release:prepare`, `release:promote`, and `release:status` are untouched by
  this sandbox. The compact checksum manifest, exact artifact, successful
  staging transaction, and explicit owner approval still gate production.
- The pre-commit hook prints a soft warning if the sandbox is down.
  It doesn't block commits.

---

## When to use this vs the native runner

| Situation | Use |
| --- | --- |
| Default development loop | Docker sandbox (this) |
| Quick iOS-simulator smoke test | `./scripts/sim-local.sh` |
| Free simulator memory after a run | `./scripts/sim-down.sh` |
| Need to attach a Node debugger to a non-containerized process | `scripts/full-nexus-local-engine.sh start` |
| Reproducing a Linux-only bug | Docker sandbox (matches prod base image) |
| Running just the content engine without Node | `scripts/full-nexus-local-engine.sh` with `NEXUS_LOCAL_START_CONTENT_ENGINE=1` and `start_backend` skipped |

Both paths coexist. Choose whichever matches the task.
