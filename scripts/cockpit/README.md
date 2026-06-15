# Nexus Hub — Local Dev Cockpit

Single-page browser cockpit for the local Docker sandbox. Runs on
`http://127.0.0.1:8210` (loopback-bound; never reachable from the LAN).
No build step, no framework, no new dependencies.

## Launch

```
./scripts/cockpit.sh
```

That starts `scripts/cockpit/server.js` and opens the browser. If an
older Cockpit is already listening on the selected port, the launcher
restarts it first so the in-memory command registry matches the current
files. Ctrl-C in the launching terminal stops the cockpit cleanly.

Override port with `NEXUS_COCKPIT_PORT=8230 ./scripts/cockpit.sh` if
8210 is in use.

## What each button does

### Primary actions

| Button | Script invoked | Notes |
|---|---|---|
| ▶️ Boot sandbox | `scripts/local-up.sh` | idempotent — no-op if already running |
| 🛑 Stop sandbox | `scripts/local-down.sh` | keeps `data/` and named volumes |
| 🔬 Run smoke | `scripts/local-smoke.sh` | 5-check contract |
| 📱 Launch iOS Simulator | `scripts/sim-local.sh` | needs Xcode + simctl; auto-picks an available iPhone simulator and starts logged in as `nexushubbot@gmail.com` |
| ⏻ Shutdown iOS Simulator | `scripts/sim-down.sh` | shuts down booted devices and trims SimulatorTrampoline/CoreSimulator memory |
| 🔥 Force rebuild | `docker compose down && build --no-cache && up -d` | when Dockerfile / requirements.txt changes |
| 💀 Reset sandbox | `scripts/local-reset.sh --yes` | **destructive — confirmation modal required** |

### Diagnostics

| Button | Notes |
|---|---|
| 📜 Tail container logs | `docker compose logs -f` streamed into output panel; click Stop to detach |
| 🚀 Open Backend Portal | opens `http://127.0.0.1:8200` in default browser |
| 🔑 Prepare iOS auth | runs `scripts/local-ios-debug-auth.mjs`, creates/repairs the local `nexushubbot@gmail.com` sandbox user, and writes the DEBUG-only iOS auth import JSON without printing tokens |
| 🧪 Focused vitest | text input + Run; safe pattern matching `[a-zA-Z0-9/_.*-]{0,200}` |
| 📈 Last smoke result | shows the cached output of the most recent smoke run |

### Open helpers

| Icon | Target |
|---|---|
| 📁 data/ | opens `./data/` in Finder |
| 📁 logs/ | opens `./logs/` in Finder |
| 📁 repo | opens repo root in Finder |
| 🐳 Docker | brings Docker Desktop to front |

### Status indicators (top right)

- **Container chips** — one per compose service + one for the sandbox's
  `/health`. Green = running/healthy, yellow = restarting/degraded,
  red = down.
- **Today's spend pill** — `$X.XX / $5.00`. Polled from
  `/api/snapshot.healthSummary.apiCostToday`. The pill glows orange
  when spend exceeds 80% of the daily cap. If the sandbox has portal
  tokens configured, Cockpit uses the available read/write/admin/legacy
  token from its environment for this read-only snapshot request.
- **Git strip** — current branch, short SHA, dirty count, last 10
  commits. Refreshes on every status poll.

## Architecture (server-side)

`scripts/cockpit/server.js` is a pure Node `http` server. No Express,
no deps.

Endpoints:

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | `index.html` |
| GET | `/style.css` | stylesheet |
| GET | `/app.js` | frontend JS |
| GET | `/api/status` | merged JSON: sandbox health + spend + containers + git |
| GET | `/api/commands` | list of whitelisted commands |
| GET | `/api/last-smoke` | cached output of last smoke run |
| POST | `/api/run/:cmd` | spawn whitelisted command, stream stdout/stderr as SSE |
| POST | `/api/open` | `execFileSync('open', ...)` against a whitelisted target |

## Safety model

The cockpit is dev-only and loopback-bound. Even so, it enforces:

1. **Command whitelist** — the `COMMANDS` registry in `server.js`.
   Unknown commands → 400. The frontend also polls `/api/commands` and
   disables buttons that are not present in the running server process,
   which catches stale Cockpit instances before a click turns into a
   confusing command failure. There is no `?cmd=` query parameter and no
   shell interpolation.
2. **Argument whitelist** — only `vitest-run` accepts a user-supplied
   value; that value is regex-validated (`/^[a-zA-Z0-9/_.\-*]*$/`,
   `<200 chars`).
3. **Per-command cooldown** — 30s, mirrors
   `src/portal/actions.ts:PORTAL_ACTION_COOLDOWN_MS`. Returns 429 with
   `remainingMs`.
4. **One run at a time** — concurrent `/api/run/:cmd` returns 429
   `another_command_active`. Frontend disables every action button
   while a run is live.
5. **No shell expansion** — `child_process.spawn(bin, [...args])`,
   never the string form. Shell metacharacters in any user input are
   inert.
6. **Reset modal** — Reset cannot fire without an explicit "Yes, wipe"
   click. The button is the only one with `data-confirm="true"`, and the
   server requires a one-use confirmation nonce before a dangerous command
   can spawn.
7. **Loopback bind** — `server.listen(8210, '127.0.0.1')`. Never reachable
   from the LAN.
8. **Loopback CSRF guard** — all POST endpoints require a startup-scoped
   `X-Nexus-Cockpit-Token`, same-origin `Origin` / `Sec-Fetch-Site`, and
   `application/json`. A random web page can still send a loopback POST, but
   it cannot add the custom token header or read `/api/session` cross-origin.
   If Cockpit restarts while the browser tab stays open, the frontend refreshes
   a stale token once and retries the request automatically.

## How to add a new button

1. Add an entry to `COMMANDS` in `scripts/cockpit/server.js`:
   ```js
   'my-cmd': {
     label: 'My new command',
     bin: 'sh',
     args: (params) => ['-c', 'echo hello'],
     cwd: REPO_ROOT,
   },
   ```
2. Add a button in `scripts/cockpit/index.html`:
   ```html
   <button class="action-card action-card--info" data-cmd="my-cmd">
     <span class="action-emoji">🆕</span>
     <span class="action-label">My new command</span>
     <span class="action-detail">short description</span>
   </button>
   ```
3. Reload the page. The frontend wires `[data-cmd]` automatically.

For destructive commands, add `data-confirm="true"` and the
confirmation modal appears.

For commands that take user input, follow the `vitest-run` pattern: an
`.action-card--with-input` wrapper, an `<input>`, and an
`<.action-input-btn data-cmd="...">` button. The frontend reads the
input value and POSTs it as JSON; the server's `args(params)` function
must regex-validate before passing through to `spawn`.

## Output panel

- JetBrains Mono, last 500 lines kept in memory (older lines drop).
- stderr lines render red, meta lines (cockpit annotations) render
  muted/italic.
- The trailing line of every command shows
  `[exit code: N] · ran for Xs` colored by outcome.
- "Stop" cancels the active stream (sends SIGTERM to the child).
- "Clear" wipes the panel.

## Wave 2 ideas not yet shipped

- Container resource usage (CPU / mem) via `docker stats --no-stream`.
- iPhone Simulator screenshot button.
- APNs test push (the `scripts/apns-smoke.mjs` script already exists).
- Database table browser (read-only SQL playground).

File an issue or extend `COMMANDS` directly when one of these becomes
necessary.
