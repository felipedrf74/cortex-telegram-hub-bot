# Nexus Hub — Staging Environment Runbook

> Quarter audit item: Staging environment + Blue-green deploy.

## What Staging Is

A second, isolated install of Nexus Hub running on the same VPS as production,
with its own database, ports, PM2 processes, and (optionally) Telegram bot.
Used to test risky changes — DB migrations, refactors, new providers, dependency
upgrades — **before** they touch the live install.

```
┌────────────────────────────── serverdominguez ──────────────────────────────┐
│                                                                              │
│  PROD                                    STAGING                             │
│  ────                                    ───────                             │
│  /home/dominguez/telegram-hub-bot/       /home/dominguez/telegram-hub-bot-   │
│                                          staging/                            │
│                                                                              │
│  pm2: nexus-hub          → :8200         pm2: nexus-hub-staging      → :8201 │
│  pm2: content-engine     → :8100         pm2: content-engine-staging → :8101 │
│                                                                              │
│  data/bot.db (live)                      data/bot.db (isolated)              │
│  .env (real keys)                        .env (separate)                     │
│  Telegram bot: @your_real_bot            Telegram bot: @your_staging_bot     │
│                                          (or none — see below)               │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Nothing is shared at runtime.** Staging can corrupt its own DB, hit a bad
API key, or get killed by a memory leak — none of it touches prod.

---

## First-Time Setup (one-time, manual)

You only do this once per server.

### 1. Create the staging directory

```bash
ssh dominguez@serverdominguez
mkdir -p /home/dominguez/telegram-hub-bot-staging/{data/garmin-tokens,logs,content-engine/data}
```

### 2. Copy the prod .env as a starting template, then EDIT it

```bash
cp /home/dominguez/telegram-hub-bot/.env /home/dominguez/telegram-hub-bot-staging/.env
nano /home/dominguez/telegram-hub-bot-staging/.env
```

**Required overrides** (these MUST differ from prod):

```bash
# Tells the boot code we're staging — softens TELEGRAM_BOT_TOKEN check
NODE_ENV=staging
STAGING=true

# Different ports than prod so both can run side-by-side
PORTAL_PORT=8201
CONTENT_ENGINE_PORT=8101

# Database lives inside the staging install — fully isolated
DATABASE_PATH=/home/dominguez/telegram-hub-bot-staging/data/bot.db

# Different portal token so the staging admin panel uses a separate password
PORTAL_TOKEN=<a different random string than prod>
```

**Telegram bot token** — pick ONE of these two options:

**Option A (recommended for genuine end-to-end testing):**
Create a SECOND bot via [@BotFather](https://t.me/BotFather) (e.g.
"Nexus Hub Staging") and put its token in `TELEGRAM_BOT_TOKEN`. This
gives you a fully working staging bot you can message from Telegram.

**Option B (no second bot — simpler but partial):**
Set `TELEGRAM_BOT_TOKEN=` (empty). The staging install will SKIP the
Telegram polling loop and log a warning, but everything else (portal,
content-engine, all cron jobs, AI calls, the iOS API) runs normally.
Useful for testing migrations, the iOS API, content generation flows,
and the dashboard. You just won't be able to send the staging install
a Telegram message.

**API keys** — Anthropic, Google, Garmin, etc. can be the same as prod,
**but consider** lower spending caps or a separate Anthropic project so
runaway staging tests can't burn through your prod budget. The cost
guardrail (`COST_GUARDRAIL_DAILY_USD`) is per-install — set a tight
limit like `5` for staging.

### 3. Set up the Python content-engine venv

```bash
cd /home/dominguez/telegram-hub-bot-staging/content-engine
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

(Once `requirements.txt` exists in the directory — it gets there on first
deploy. So the order is: deploy first, then venv.)

### 4. First deploy

From your Mac:

```bash
./scripts/deploy-staging.sh
```

The script will rsync everything, install Node deps, but warn that the
PM2 entries don't exist yet.

### 5. Register the PM2 entries (one-time)

Back on the server:

```bash
ssh dominguez@serverdominguez
cd /home/dominguez/telegram-hub-bot-staging
pm2 start ecosystem.staging.config.js
pm2 save
```

You should now see four PM2 processes:

```
pm2 list
┌────┬──────────────────────────┬──────────┬───────┐
│ id │ name                     │ status   │ port  │
├────┼──────────────────────────┼──────────┼───────┤
│ 0  │ content-engine           │ online   │ 8100  │
│ 1  │ content-engine-staging   │ online   │ 8101  │
│ 2  │ nexus-hub                │ online   │ 8200  │
│ 3  │ nexus-hub-staging        │ online   │ 8201  │
└────┴──────────────────────────┴──────────┴───────┘
```

### 6. Verify staging is up

```bash
curl http://localhost:8201/health
curl http://localhost:8101/health
```

Both should return `{"status":"ok"}`.

---

## Day-to-Day Use

### Deploy the current branch to staging

```bash
./scripts/deploy-staging.sh
```

This:

1. Builds TypeScript locally (fails fast if anything is broken)
2. Stops the staging PM2 processes
3. Rsyncs to `/home/dominguez/telegram-hub-bot-staging/` (NEVER touches prod)
4. Installs Node + Python deps
5. Rebuilds `better-sqlite3` against system Node
6. Restarts staging PM2
7. Health-checks port 8201 / 8101

Production is **never** touched.

### View staging logs

```bash
ssh dominguez@serverdominguez "pm2 logs nexus-hub-staging --nostream --lines 50"
ssh dominguez@serverdominguez "pm2 logs content-engine-staging --nostream --lines 50"
```

### Tail staging logs in real time

```bash
ssh dominguez@serverdominguez "pm2 logs nexus-hub-staging"
```

### Restart just staging

```bash
ssh dominguez@serverdominguez "pm2 restart nexus-hub-staging"
```

### Check staging cost (separate api_usage table)

```bash
ssh dominguez@serverdominguez "curl -sf -H 'Authorization: Bearer <staging-portal-token>' http://localhost:8201/api/cost-by-domain?days=7"
```

### Reset staging DB

```bash
ssh dominguez@serverdominguez "pm2 stop nexus-hub-staging && rm /home/dominguez/telegram-hub-bot-staging/data/bot.db && pm2 start nexus-hub-staging"
```

(Migrations re-run on startup so the schema rebuilds automatically.)

### Copy prod data to staging (for realistic tests)

```bash
ssh dominguez@serverdominguez "
  pm2 stop nexus-hub-staging
  cp /home/dominguez/telegram-hub-bot/data/bot.db /home/dominguez/telegram-hub-bot-staging/data/bot.db
  pm2 start nexus-hub-staging
"
```

⚠️ **Heads up**: this brings real user data into the staging install.
If you've configured staging with different API keys (recommended), you
won't accidentally hit production APIs — but the user IDs and OAuth
tokens are real. Be careful.

---

## When to Use Staging

| Change Type | Test on Staging? |
|---|---|
| New DB migration | **YES** — always |
| New cron job | **YES** — let it run for at least one tick |
| Refactor of `domain-handler.ts` or `tool-executor.ts` | **YES** |
| New provider integration (e.g. a new AI vendor) | **YES** |
| Dependency upgrades (especially `better-sqlite3`, `grammy`) | **YES** |
| Editing portal HTML/CSS | Nice-to-have, not required |
| Typo fix in a log message | Skip — go straight to prod |
| One-line bugfix | Optional — judgment call |

**Rule of thumb**: if a rollback would lose data or take >5 minutes, test
on staging first.

---

## Promotion to Production

There's no automated promotion (yet — that's the blue-green deploy item).
The current flow is:

1. `./scripts/deploy-staging.sh` — ship the change to staging
2. Verify staging behaves: hit the relevant endpoint, check logs, message
   the staging bot, etc.
3. Let staging run for at least 30 min so any cron jobs fire at least once
4. `./scripts/deploy.sh` — ship the SAME local working tree to prod
5. Verify prod via the usual health checks

Until blue-green deploy lands, prod still has the same ~30-second
restart window. Staging exists to MAKE that 30 seconds safe by catching
the bugs first.

---

## Troubleshooting

### `EADDRINUSE` on port 8201

Another process is bound to 8201. Find and kill it:

```bash
ssh dominguez@serverdominguez "ss -tlnp | grep 8201"
```

### Staging logs show `[reqId=-]` for everything

The Python content-engine wasn't restarted after the
distributed-tracing patch. Run `pm2 restart content-engine-staging`.

### Staging crashes immediately on boot

Check `pm2 logs nexus-hub-staging --nostream --lines 100` for the actual
error. The most common cause is a missing or wrong path in
`DATABASE_PATH` — staging tries to open a file under
`/home/dominguez/telegram-hub-bot-staging/data/` and that directory
doesn't exist yet. `mkdir -p` it and retry.

### Staging Telegram bot conflicts with prod

You forgot to use a SEPARATE bot token. Telegram allows only one
long-poll consumer per token, so the staging install will throw 409
errors and the prod bot will start losing messages. Either set
`TELEGRAM_BOT_TOKEN=` empty in the staging .env (Option B above) or
provision a second @BotFather bot.

---

## See Also

- `ecosystem.staging.config.js` — PM2 config for the staging processes
- `scripts/deploy-staging.sh` — the deploy script
- `DEPLOY.md` — production deploy + rollback runbook
