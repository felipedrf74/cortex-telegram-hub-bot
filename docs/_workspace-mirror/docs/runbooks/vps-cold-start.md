Status: canonical
Owner: release lead (Felipe)
Last verified: 2026-05-05
Update policy: update after every successful disaster-recovery drill, host
image change, PM2 ecosystem change, backup format change, or tunnel topology
change.

# VPS Cold Start Runbook

Use this when a fresh Linux host must become the Nexus Hub production or
staging runtime from backups. Do not use production data on an untrusted host.
Run production recovery only after Felipe approves the target machine and DNS
cutover.

## Targets

- RTO: undefined until the first quarterly drill is timed.
- RPO: latest valid `nexushub-backup-*.tar.gz.enc` plus any provider-side data
  not yet synced into SQLite.
- Drill cadence: quarterly. Spin up a throwaway DigitalOcean droplet, restore
  from the latest encrypted backup, run smoke checks, record elapsed time in
  `docs/release/OPEN_ITEMS.md`, then destroy the droplet.

## Host Bootstrap

1. Create an Ubuntu LTS droplet with SSH keys only.
2. Install base packages:

   ```bash
   sudo apt-get update
   sudo apt-get install -y curl git build-essential python3.12 python3.12-venv unzip ufw
   ```

3. Install Node using the repo version policy:

   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs
   node --version
   npm --version
   ```

4. Install PM2:

   ```bash
   sudo npm install -g pm2
   pm2 startup systemd
   ```

5. Lock the host down:

   ```bash
   sudo ufw allow OpenSSH
   sudo ufw allow 8200/tcp
   sudo ufw allow 8201/tcp
   sudo ufw enable
   ```

## Source And Secrets

1. Clone the backend repo into the canonical runtime path:

   ```bash
   mkdir -p "$HOME/Nexus"
   git clone <private-backend-repo-url> "$HOME/Nexus/cortex-telegram-hub-bot"
   cd "$HOME/Nexus/cortex-telegram-hub-bot"
   npm ci
   ```

2. Restore `.env` from the offline encrypted vault. Preferred vaults are
   1Password or Bitwarden. Do not paste secrets into shell history.
3. Confirm mandatory runtime keys are present:

   ```bash
   node -e 'for (const k of ["JWT_SECRET","OAUTH_ENCRYPTION_KEY","HEALTH_TOKEN"]) if (!process.env[k]) { console.error(`missing ${k}`); process.exit(1); }'
   ```

## Restore Database

1. Fetch the latest encrypted backup from Google Drive or the offline vault.
2. Verify the filename and size:

   ```bash
   ls -lh nexushub-backup-*.tar.gz.enc
   ```

3. Decrypt and unpack using the approved backup key from the vault.
4. Place the restored SQLite DB at the path configured by `DATABASE_PATH`.
5. Run migrations against the restored DB:

   ```bash
   npm run typecheck
   node -e 'require("./dist/services/database").initDatabase?.()'
   ```

   If the compiled entry point is not available yet, build first with
   `npm run build`. Migration failures stop recovery until reviewed.

## Cloudflare Tunnel

1. Install cloudflared:

   ```bash
   curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
   sudo dpkg -i cloudflared.deb
   ```

2. Restore the tunnel credential JSON from the vault.
3. Install the tunnel service using
   `docs/runbooks/cloudflared-tunnel.md`.

## Start Services

1. Confirm content-engine Python dependencies:

   ```bash
   cd content-engine
   python3.12 -m venv .venv
   . .venv/bin/activate
   pip install -r requirements.txt
   ```

2. Start PM2 from the backend root:

   ```bash
   cd "$HOME/Nexus/cortex-telegram-hub-bot"
   pm2 start ecosystem.config.cjs
   pm2 save
   pm2 status
   ```

3. Content-engine must bind loopback only. Express portal/API should bind the
   configured local ports behind Cloudflare Tunnel.

## Smoke Checklist

Run all checks before DNS cutover or production promotion:

```bash
curl -fsS http://127.0.0.1:8200/health
curl -fsS -H "x-health-token: $HEALTH_TOKEN" http://127.0.0.1:8200/health/detailed
npm run docs:audit
npm run verify
bash scripts/cannot-skip-gate-dashboard.sh --json --no-evidence
```

Then run the staging smoke gate and operator portal smoke from the release
process. Do not promote if `/health` is degraded, provider keys are missing, or
the restored DB fails integrity checks.

## Drill Record

After every quarterly drill, append:

- date and operator
- backup filename and creation time
- elapsed time to first healthy `/health`
- elapsed time to full smoke pass
- any manual steps that were missing from this runbook
