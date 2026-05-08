---
canonical_status: workspace_release_apns_runbook
generated: 2026-05-08
owner: Felipe (operator), Claude (AI helper)
---

# APNs Runbook — Nexus Hub

How to set up, verify, and rotate Apple Push Notification credentials. This
covers the **token-based authentication** path (`.p8` Auth Key), which is
what the Nexus Hub backend uses. There is no certificate-based code path.

## Current operational truth (2026-05-08)

| Field | Value |
|---|---|
| Apple Developer Team | Felipe Dominguez (`B6885R8NWM`) |
| App Bundle ID | `me.nexushub.app` |
| App ID Push capability | Enabled (no certificates needed) |
| APNs Auth Key — Key ID | `4QU52CCBPM` |
| APNs Auth Key — Created | 2026-04-10 19:04 (Apple Developer Portal) |
| APNs Auth Key — Service | Apple Push Notifications service (Team scoped, all topics, sandbox + production) |
| `.p8` file (local copy) | `~/Library/Mobile Documents/com~apple~CloudDocs/Dev/Nexus Hub/certificates/AuthKey_4QU52CCBPM.p8` |
| `.p8` file (server copy) | `dominguez@serverdominguez:/home/dominguez/secrets/AuthKey_4QU52CCBPM.p8` (mode 600) |
| Production engine env | `APNS_ENABLED=true`, `APNS_TEAM_ID=B6885R8NWM`, `APNS_KEY_ID=4QU52CCBPM`, `APNS_BUNDLE_ID=me.nexushub.app`, `APNS_AUTH_KEY_P8=/home/dominguez/secrets/AuthKey_4QU52CCBPM.p8`, `APNS_ENVIRONMENT=sandbox` |
| Smoke test (2026-05-08) | HTTP 200 to user 25's iPhone 17 Pro on `api.sandbox.push.apple.com` (Apple apns-id `52E648D4-D3ED-D5D4-1189-6341FFF9F105`) |

## Architecture

| Layer | Where it lives | Notes |
|---|---|---|
| iOS push registration | `Nexus Hub/Core/NotificationManager.swift`, `Nexus Hub/Core/AppDelegate.swift` | Calls `UIApplication.registerForRemoteNotifications()`, posts hex token to `/api/v1/settings/push-token` |
| iOS entitlement (Debug) | `Nexus Hub/Nexus Hub.entitlements` | `aps-environment = development` → token issued from sandbox APNs |
| iOS entitlement (Release) | `Nexus Hub/Nexus Hub.Release.entitlements` | `aps-environment = production` → token issued from production APNs |
| Token storage | `ios_devices.push_token` (SQLite, per-user) | Schema: `id, user_id, device_id, device_name, push_token, refresh_token, refresh_token_hash, previous_refresh_token_hash, last_active_at, created_at`. **No `environment` column** — environment is global on the backend, not per-token. |
| Backend sender | `engine/src/services/apns-sender.ts` | ES256 JWT (cached 55min), HTTP/2, error classification (`Unregistered`/`BadDeviceToken`/transient) |
| Backend env keys | `engine/src/config.ts` (`apns:` block, lines 476-484) | Six env vars; documented in `engine/.env.example` |
| Diagnostic helper | `engine/scripts/apns-smoke.mjs` | `--check` (no network), `--list` (DB inventory), `--user <id> [--dry-run]` (real send) |
| Scheduler | `engine/src/services/scheduler.ts` + `notification-orchestrator.ts` | Cron jobs and event-driven flows call `sendPushNotification()` |

## Sandbox vs production

The `.p8` Auth Key works for **both** APNs environments, but the env variable
`APNS_ENVIRONMENT` selects which endpoint the backend posts to:

| `APNS_ENVIRONMENT` | Endpoint | iOS build that produces matching tokens |
|---|---|---|
| `sandbox` | `api.sandbox.push.apple.com` | Debug builds installed via Xcode (development entitlement) |
| `production` | `api.push.apple.com` | Release builds: TestFlight (any tier) + App Store (production entitlement) |

**Mismatch consequence**: posting a sandbox token to production endpoint (or
vice versa) returns `BadDeviceToken`. Apple does NOT silently drop — you get
an explicit error.

**As of 2026-05-08** the production backend is on `sandbox` because all
existing tokens in `ios_devices` were issued by Debug/Xcode builds. When the
"100 Operators" closed-beta cohort onboards via TestFlight (Release builds),
flip to `production`:

1. Confirm no Debug-build tokens are still in `ios_devices` (or confirm those
   users are willing to lose pushes during the switch).
2. Set `APNS_ENVIRONMENT=production` in production `.env`.
3. `pm2 restart nexus-hub --update-env`.
4. Re-run `node scripts/apns-smoke.mjs --user <id>` against a TestFlight
   token.

## Setting up from scratch (already done — kept for future re-provisioning)

These steps are only needed if the existing key `4QU52CCBPM` is revoked or
lost.

### Apple Developer Portal (your hand)
1. https://developer.apple.com/account/resources/identifiers/list — open the
   `me.nexushub.app` App ID, ensure Push Notifications is enabled, save.
2. https://developer.apple.com/account/resources/authkeys/list — click `+`,
   name the key (e.g. "Nexus Hub APNs"), tick Apple Push Notifications, save.
3. **Download the `.p8` file** — Apple gives this only once. Save it to a
   safe location (e.g. iCloud Drive `Dev/Nexus Hub/certificates/`).
4. Copy the **Key ID** (10 characters) shown right after creation.
5. **Membership** page → copy the **Team ID** (10 characters).

### Server (`serverdominguez`)
```bash
# From the local Mac
P8_LOCAL="$HOME/Library/Mobile Documents/com~apple~CloudDocs/Dev/Nexus Hub/certificates/AuthKey_<KEY_ID>.p8"
ssh dominguez@serverdominguez 'mkdir -p ~/secrets && chmod 700 ~/secrets'
scp "$P8_LOCAL" dominguez@serverdominguez:~/secrets/
ssh dominguez@serverdominguez 'chmod 600 ~/secrets/AuthKey_<KEY_ID>.p8'
```

### Engine env (`~/telegram-hub-bot/.env` on server)
Append (or update if already present):
```env
APNS_ENABLED=true
APNS_TEAM_ID=B6885R8NWM
APNS_KEY_ID=<KEY_ID>
APNS_AUTH_KEY_P8=/home/dominguez/secrets/AuthKey_<KEY_ID>.p8
APNS_BUNDLE_ID=me.nexushub.app
APNS_ENVIRONMENT=sandbox     # or production — see table above
```
Reload PM2:
```bash
ssh dominguez@serverdominguez '~/.npm-global/bin/pm2 restart nexus-hub --update-env'
```

## Verifying

### Read-only diagnostic (safe; no network)
```bash
ssh dominguez@serverdominguez 'cd ~/telegram-hub-bot && node scripts/apns-smoke.mjs --check'
```
Expected: all 5 env values present, `.p8` reachable, JWT signs cleanly.

### Token inventory (safe; no token values printed)
```bash
ssh dominguez@serverdominguez 'cd ~/telegram-hub-bot && node scripts/apns-smoke.mjs --list'
```
Expected: count of devices with non-empty `push_token`, `last_active`, `device_name`.

### Real push send (small side effect — push lands on the chosen device)
```bash
ssh dominguez@serverdominguez "cd ~/telegram-hub-bot && node scripts/apns-smoke.mjs --user <user_id> --message 'APNs smoke ✅' --title 'Nexus Hub'"
```

Outcomes:
| HTTP | Reason | Meaning |
|---|---|---|
| 200 | — | Apple accepted; push will be delivered to the device (1-2s) |
| 410 | `Unregistered` | Token has rotated (app reinstalled or tokens cycled) — caller should delete the row |
| 400 | `BadDeviceToken` | Environment mismatch — check `APNS_ENVIRONMENT` against the iOS build that issued the token |
| 400 | `BadCertificateEnvironment` | The `.p8` is not authorized for this APNs environment (rare with Auth Key) |
| 401 | `InvalidProviderToken` | JWT was rejected — check Team ID, Key ID, or `.p8` corruption |
| 403 | `BadCertificate` | Certificate-based push attempted; we use token auth (shouldn't happen) |
| 410 | (any other) | See APNs error reference: https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns |

## Rotating the Auth Key

If you suspect compromise of `4QU52CCBPM`:

1. https://developer.apple.com/account/resources/authkeys/review/4QU52CCBPM → click **Revoke**.
2. Create a new Auth Key (same flow as section above), download new `.p8`.
3. SCP new `.p8` to server, set perms 600.
4. Update `APNS_KEY_ID` and `APNS_AUTH_KEY_P8` in `.env`.
5. `pm2 restart nexus-hub --update-env`.
6. Run smoke `--check` then `--user <id>` to verify.

Apple allows up to 2 active APNs Auth Keys per team — you can create the new
key first, switch the env over, verify, then revoke the old one (zero
downtime).

## Common operational gotchas

- **`.p8` file size should be 250-260 bytes**. Anything outside that range
  (esp. truncated to 100 bytes or expanded to several KB) means the file is
  corrupted or contains the wrong key type.
- **iOS sends a token at every cold launch + every 24h while running**.
  Don't be surprised if `ios_devices.last_active_at` for a single device
  updates without explicit user action.
- **Token format**: hex string, typically 64 chars (32 bytes). Some legacy
  iOS versions or token-encoding quirks can produce longer strings — Apple
  generally accepts these as long as they came from a real
  `didRegisterForRemoteNotificationsWithDeviceToken` call.
- **Multiple devices per user**: a single `user_id` can have multiple
  `ios_devices` rows (one per device). The push code in
  `notification-orchestrator.ts` typically sends to all of them; check if
  that's what you want for any new push category.
- **PM2 env reload**: `pm2 restart` alone does NOT pick up new `.env`
  values — you must pass `--update-env`.
- **Provider rotation**: when generating a fresh `.p8`, the engine's
  in-memory JWT cache will hold the OLD key for up to 55 minutes. Either
  restart the process (`pm2 restart`) or wait. Live-rotating without
  restart is not supported.

## Related docs

- `Nexus Hub IOS/specs/09-APNS-SETUP.md` — iOS-side notes (older; supersede
  with this runbook for operational truth)
- `engine/.env.example` — env key documentation
- `engine/src/services/apns-sender.ts` — sender implementation
- `engine/scripts/apns-smoke.mjs` — diagnostic CLI
- Apple docs: https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns
