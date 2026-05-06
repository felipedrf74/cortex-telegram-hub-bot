Status: canonical
Owner: release lead (Felipe)
Last verified: 2026-05-05
Update policy: update when Cloudflare routes, local ports, tunnel names,
credential storage, or cache/health-check policy changes.

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

## IPv6 And Firewall

Cloudflare handles public IPv4/IPv6 ingress. The VPS firewall should expose
SSH and the local service ports only as required for administration and tunnel
origin checks. Prefer loopback origin addresses in the tunnel config.
