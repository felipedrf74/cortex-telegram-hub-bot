# Full Nexus Product Engine Troubleshooting

## Port 8200 already in use

Check:

```bash
lsof -nP -iTCP:8200 -sTCP:LISTEN
```

Stop the existing local owner or change `PORTAL_PORT`.

## Startup fails with iOS JWT or invite errors

Set:

```bash
IOS_API_ENABLED=true
IOS_API_JWT_SECRET=<local 32+ char secret>
IOS_INVITE_CODE=LOCAL-BETA-2026
```

The runner supplies defaults unless `.env.local-full-nexus` overrides them.

## Startup fails with OAuth encryption error

Set a local-only `OAUTH_ENCRYPTION_KEY`. Do not reuse production secrets.

## Authenticated smoke returns 401

Mint a local sandbox session:

```bash
scripts/full-nexus-local-engine.sh auth-token
```

Then re-run:

```bash
scripts/full-nexus-local-engine.sh smoke
```

## Authenticated smoke has degraded provider responses

This is expected when Google/Outlook/Garmin/Stripe/AI providers are not
configured locally. The local smoke gate proves API shape, auth, tenant context,
and safe degraded behavior. Real provider read-back belongs to staging gates.

## Content engine health fails

The content sidecar is optional. If needed:

```bash
cd content-engine
.venv/bin/pip install -r requirements.txt
NEXUS_LOCAL_START_CONTENT_ENGINE=1 scripts/full-nexus-local-engine.sh start
```

## Model calls unexpectedly happen

Stop the runner:

```bash
scripts/full-nexus-local-engine.sh stop
```

Then restart without `NEXUS_LOCAL_ALLOW_MODEL_CALLS=1`. The runner blanks
provider keys by default.
