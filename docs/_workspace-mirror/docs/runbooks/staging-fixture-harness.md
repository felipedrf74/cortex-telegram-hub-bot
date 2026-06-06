# Staging Fixture Harness

## Purpose

Use this harness when an engine change needs authenticated staging evidence
against real `/api/v1` routes without borrowing a production user token.
It creates a synthetic staging-only user, mints a long-lived iOS JWT with a
`staging_fixture: true` claim, seeds minimal multi-domain data, probes the
migrated route-pipeline/cache surfaces, and cleans up the fixture rows.

The harness is operator tooling only. It must never run against production.

## Safety Boundaries

The harness has three independent refusal layers:

- Hostname: `scripts/staging-fixture-harness.mjs` refuses `api.nexushub.me`
  and any hostname that does not include `staging`.
- JWT claim: fixture tokens carry `staging_fixture: true`; production auth
  middleware rejects that claim before any database lookup.
- Reserved user IDs: fixture users must live in `1000000-1099999`; production
  auth middleware rejects that range even if the claim is absent.

If a safety check fails, the CLI exits with code `2`.

## Commands

From `/Users/felipedominguez/Desktop/Nexus Hub/engine`:

```bash
./scripts/deploy-staging.sh
sleep 300
./scripts/staging-smoke.sh

STAGING_URL=https://staging-api.nexushub.me \
  node scripts/staging-fixture-harness.mjs --action seed

STAGING_URL=https://staging-api.nexushub.me \
  node scripts/staging-fixture-harness.mjs --action probe

STAGING_URL=https://staging-api.nexushub.me \
  node scripts/staging-fixture-harness.mjs --action cleanup
```

The probe writes a report to `/tmp/staging-probe-<timestamp>.json`.

If `staging-api.nexushub.me` is not resolvable from the local machine, open an
SSH tunnel and use a local staging hostname:

```bash
ssh -N -L 127.0.0.1:18201:127.0.0.1:8201 dominguez@serverdominguez

STAGING_URL=http://staging.localhost:18201 \
  node scripts/staging-fixture-harness.mjs --action probe
```

Close the tunnel after the probe. The hostname still includes `staging`, so the
same production-refusal guard remains active.

For a single end-to-end run:

```bash
STAGING_URL=https://staging-api.nexushub.me \
  node scripts/staging-fixture-harness.mjs --action all
```

## Production Refusal Check

Run this before trusting a harness change:

```bash
PRODUCTION_URL=https://api.nexushub.me \
  node scripts/staging-fixture-harness.mjs --action probe
echo "Exit code: $?"
```

Expected output includes:

```text
SAFETY_REFUSAL: Refusing production API hostname api.nexushub.me
Exit code: 2
```

## What It Seeds

The default synthetic user is `1000001` with a non-founder profile:
`en-US`, `25-45 women`, and a knitting niche. The seed creates minimal rows
for:

- user + iOS device session
- content creator profile, topic, and script draft
- task lists and tasks
- cooking recipe, meal plan, and shopping list
- finance transaction
- active training plan/week/session

The harness intentionally avoids real OAuth tokens. Calendar route writes may
therefore report `CALENDAR_NOT_CONFIGURED`; the probe also runs a deployed
registry-level cache-coherence check for calendar/cooking invalidation.

## Cleanup

Cleanup is idempotent and deletes fixture rows for the reserved user from
`users`, `ios_devices`, native task tables, cooking tables, finance tables,
content tables, training plan tables, OAuth token tables, audit/signal tables,
and user-scoped `api_cache` keys.

To verify cleanup on the staging server:

```bash
ssh dominguez@serverdominguez "
  cd /home/dominguez/telegram-hub-bot-staging
  set -a && . ./.env && set +a
  sqlite3 \"\$DATABASE_PATH\" \
    'SELECT COUNT(*) FROM users WHERE id BETWEEN 1000000 AND 1099999;'
"
```

Expected result: `0`.
