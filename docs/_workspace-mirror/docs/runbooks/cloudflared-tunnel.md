Status: canonical
Owner: release lead (Felipe)
Last verified: 2026-05-20
Update policy: update when Cloudflare routes, local ports, tunnel names,
credential storage, cache/health-check policy, or edge-protection (WAF / Bot
Fight Mode / AI crawler) configuration changes.

# Cloudflared Tunnel Runbook

This runbook describes the public tunnel that routes Nexus Hub traffic to the
loopback services on the VPS. Keep tunnel credential JSON in the encrypted
vault only. Do not commit live tunnel IDs or secrets.

## Expected Routing

| Hostname | Local service |
| --- | --- |
| `api.nexushub.me` | `http://127.0.0.1:8200` |
| `portal.nexushub.me` | `http://127.0.0.1:8200` |
| `api-staging.nexushub.me` | `http://127.0.0.1:8201` |

The content-engine remains loopback-only behind Express. It is not exposed as a
separate public hostname.

## Install

```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb
cloudflared --version
```

## Recreate A Tunnel

1. Confirm Felipe approved recreation.
2. Authenticate on the host:

   ```bash
   cloudflared tunnel login
   ```

3. Create the tunnel:

   ```bash
   cloudflared tunnel create nexushub-prod
   ```

4. Store the generated credential JSON in the encrypted vault.
5. Copy `infra/cloudflared/config.yml.example` to the host-local
   cloudflared config path and replace placeholders.
6. Bind DNS routes:

   ```bash
   cloudflared tunnel route dns nexushub-prod api.nexushub.me
   cloudflared tunnel route dns nexushub-prod portal.nexushub.me
   cloudflared tunnel route dns nexushub-prod api-staging.nexushub.me
   ```

7. Install and start the service:

   ```bash
   sudo cloudflared service install
   sudo systemctl enable --now cloudflared
   sudo systemctl status cloudflared
   ```

## Credential Rotation

1. Create a replacement tunnel or rotate credentials through the Cloudflare
   dashboard/CLI.
2. Put the new credential JSON into the encrypted vault.
3. Replace the host credential file atomically:

   ```bash
   sudo install -m 600 new-tunnel.json /etc/cloudflared/<tunnel-id>.json
   sudo systemctl restart cloudflared
   ```

4. Verify:

   ```bash
   curl -fsS https://api.nexushub.me/health
   curl -fsS https://portal.nexushub.me/health
   curl -fsS https://api-staging.nexushub.me/health
   ```

## Health Semantics

`/health` is allowed to return `503` when Express is up but a dependency is
degraded. External monitors must treat a 503 as actionable and must not cache a
previous 200 response. After any Cloudflare cache or rule change, test that a
local degraded health response reaches the public hostname unchanged.

`/public-status` is the permissive sibling — it always returns `200` with
minimal payload (`status`, `service`, `timestamp`) and is the only endpoint
intentionally allowlisted for external fetchers and AI crawlers. Do not enrich
it with diagnostic data; that posture is what makes it safe to expose. Add
diagnostic detail to `/health` (server-to-server) or `/health/detailed`
(authenticated) instead.

## Edge Protection And AI Crawler Policy

Two surfaces sit behind Cloudflare with **deliberately different postures**:

| Hostname | Surface | Posture | Permissive to AI fetchers? |
| --- | --- | --- | --- |
| `nexushub.me` | Cloudflare Pages (marketing) | permissive | yes — all major LLM crawlers |
| `api.nexushub.me` | VPS via Cloudflare Tunnel | strict | only `/public-status` |
| `portal.nexushub.me` | VPS via Cloudflare Tunnel | strict | no |
| `api-staging.nexushub.me` | VPS via Cloudflare Tunnel | strict | only `/public-status` when edge smoke is enabled |

**Rationale:** the marketing site benefits from being citable in LLM-generated
answers (ChatGPT, Claude, Perplexity, etc.) — that is an active growth channel
for a personal-AI product. The API has no such benefit; it should remain
behind standard Cloudflare bot protection, with one minimal heartbeat
(`/public-status`) exposed for external uptime monitors.

### Marketing Site Configuration (`nexushub.me`)

Configure in **Cloudflare Dashboard → `nexushub.me` zone**:

1. **Security → Bots → Bot Fight Mode**: set to "Bot Fight Mode" (basic), NOT
   "Super Bot Fight Mode". The basic mode allows verified crawlers and most
   well-behaved fetchers; SBFM challenges them and breaks AI discoverability.
2. **Security → Settings → Browser Integrity Check**: **off** for this zone.
   Marketing pages are static; the integrity check blocks legitimate fetchers
   without offering meaningful protection here.
3. **Security → Settings → Security Level**: **Essentially Off** for this
   zone. Reserve higher security levels for `api.nexushub.me`.
4. **Rules → Configuration Rules**: not required if zone-level settings above
   are applied. If the marketing site shares a zone with another surface that
   needs stricter protection, scope the relaxations with a Configuration Rule
   matched on `hostname equals nexushub.me`.

The `robots.txt`, `llms.txt`, and `_headers` files in the
`nexushub-landing-deploy` repo encode the application-level posture
(see the repo for the canonical files). Cloudflare-side settings above
must not contradict them.

### Backend API Configuration (`api.nexushub.me`)

Keep the default protective posture **except** for `/public-status`:

1. **Security → Bots**: leave Super Bot Fight Mode **on**.
2. **Security → Settings → Browser Integrity Check**: **on**.
3. **Security → WAF → Custom Rules** — create one allowlist rule for the
   public-status endpoint, scoped narrowly:

   ```
   Name: Allow AI/monitor fetchers on /public-status
   Expression:
     (http.host in {"api.nexushub.me" "api-staging.nexushub.me"}) and
     (http.request.uri.path eq "/public-status") and (
       (http.user_agent contains "Claude") or
       (http.user_agent contains "Anthropic") or
       (http.user_agent contains "GPT") or
       (http.user_agent contains "OpenAI") or
       (http.user_agent contains "ChatGPT-User") or
       (http.user_agent contains "Perplexity") or
       (http.user_agent contains "UptimeRobot") or
       (http.user_agent contains "StatusCake")
     )
   Action: Skip → All remaining custom rules, Super Bot Fight Mode,
                  Browser Integrity Check, Zone Lockdown
   ```

   Do **not** broaden this expression to other paths. Staging is included only
   so `NEXUS_SMOKE_EDGE_VERIFY=1 ./scripts/staging-smoke.sh` can verify the
   same edge contract before promotion. The whole point of the `/public-status`
   endpoint is that it carries no sensitive payload — the allowlist is safe
   specifically because the path is scoped.

4. Verify the rule fires by running:

   ```bash
   curl -fsS -A "ClaudeBot/1.0" https://api.nexushub.me/public-status
   curl -fsS -A "ClaudeBot/1.0" https://api-staging.nexushub.me/public-status
   curl -fsS -A "ClaudeBot/1.0" -o /dev/null -w '%{http_code}\n' \
     https://api.nexushub.me/health
   ```

   The first must return `200 {"status":"ok",...}`. The second must return
   a Cloudflare challenge or `403` — that is the working baseline; if `/health`
   becomes reachable to a bot user-agent the WAF rule is too broad.

### Diagnostic Workflow When A Fetcher Reports 403

1. Cloudflare Dashboard → affected zone → **Security → Events**, filter by
   Action = Block/Challenge for the last hour.
2. Match the timestamp + originating IP to the failing request. The event
   row names the exact rule (Managed Rule ID, SBFM verdict, BIC, etc.) that
   fired.
3. If a verified crawler (Googlebot, Bingbot, Applebot) is being blocked on
   `nexushub.me`, that is an SEO-critical incident — apply the marketing-site
   relaxations above immediately.
4. If `/public-status` on the API is blocking a fetcher, confirm the WAF
   custom rule above exists and that the user-agent matches at least one
   substring in the expression.

### What Not To Do

- Do not allowlist AI user-agents globally on `api.nexushub.me`. The narrow
  `/public-status` scoping is what keeps the API safe.
- Do not enrich `/public-status` with diagnostic fields. The intentional
  minimalism is its safety budget.
- Do not disable Cloudflare protection on `api.nexushub.me` "temporarily" to
  diagnose a fetcher 403 — diagnose from the Events log instead. Disabling
  protection on the API exposes the entire surface during the diagnostic
  window.
- Do not move the marketing site behind authentication or strict bot
  protection to "match the API posture." The two surfaces have different
  threat models and should keep diverging postures.

## IPv6 And Firewall

Cloudflare handles public IPv4/IPv6 ingress. The VPS firewall should expose
SSH and the local service ports only as required for administration and tunnel
origin checks. Prefer loopback origin addresses in the tunnel config.
