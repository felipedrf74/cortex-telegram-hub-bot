Status: canonical
Owner: release lead (Felipe)
Last verified: 2026-07-13
Update policy: update when `.env.example` changes, a provider adds a new
credential, or a rotation drill reveals a missing verification step.

# Secret Rotation Runbook

Use this for planned or emergency secret rotation. Rotate staging first, verify,
then production. Never rotate production secrets while a deploy or migration is
in progress.

## General Sequence

1. Open an incident or maintenance note in `docs/release/OPEN_ITEMS.md`.
2. Export current staging secrets from the encrypted vault to a local shell
   that does not persist history.
3. Create the replacement secret at the provider.
4. Update staging `.env`.
5. Restart staging and run focused smoke checks.
6. Repeat for production after staging is green.
7. Revoke the old secret only after production health and provider-specific
   smoke pass.
8. Record the rotated secret names, not secret values.

## Core Runtime Secrets

| Secret | Rotation source | Verification |
| --- | --- | --- |
| `JWT_SECRET` | generate with `openssl rand -hex 64` | existing sessions invalidate; login and `/api/v1/auth/me` work |
| `OAUTH_ENCRYPTION_KEY`, `GARMIN_ENCRYPTION_KEY`, `HEALTH_DATA_ENCRYPTION_KEY` | generate a different value for every domain and environment with `openssl rand -hex 64` | use the offline procedure below; verify all encrypted rows with the new dedicated keys before restart |
| `HEALTH_TOKEN` | generate with `openssl rand -hex 32` | `/health/detailed` rejects old token and accepts new token |
| `PORTAL_SESSION_SECRET` | generate with `openssl rand -hex 64` | portal admin login/session smoke passes |
| `INTERNAL_API_SECRET` | generate with `openssl rand -hex 64` | content-engine internal calls succeed |
| `BACKUP_KEY` | generate with `openssl rand -hex 64` | create backup, decrypt restore rehearsal copy |

## Provider Secrets

| Area | Secret names | Rotation source | Verification |
| --- | --- | --- | --- |
| Telegram | `TELEGRAM_BOT_TOKEN` | BotFather | bot starts and receives test command |
| Google OAuth | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google Cloud Console | Google sign-in and calendar/Gmail token refresh |
| Outlook OAuth | `OUTLOOK_CLIENT_ID`, `OUTLOOK_CLIENT_SECRET` | Microsoft Entra | Outlook calendar/mail token refresh |
| Apple Sign In | Apple client/team/key vars | Apple Developer | Apple sign-in staging smoke |
| Gemini | `GEMINI_API_KEY` | Google AI Studio/Cloud | provider registry smoke without real user data |
| Anthropic | `ANTHROPIC_API_KEY` | Anthropic Console | provider registry smoke and cost ledger row |
| OpenAI | `OPENAI_API_KEY` | OpenAI dashboard | fallback provider smoke |
| Stripe | Stripe secret/webhook keys | Stripe dashboard | webhook signature test and portal billing smoke |
| Garmin | provider credentials/cookies if configured | Garmin account flow | wearable connection health smoke |
| Sentry | `SENTRY_DSN` | Sentry project settings | test event reaches Sentry in staging |
| APNs | APNs key/team/bundle values | Apple Developer | TestFlight APNs token upload and safe notification |
| Cloudflare | tunnel credential JSON/API token | Cloudflare dashboard/CLI | public `/health` route reaches origin |

## Data Encryption Key Rotation

The compiled `security:rotate-data-encryption` command covers every encrypted
field that can currently inherit `OAUTH_ENCRYPTION_KEY`:

- `user_oauth_tokens.access_token` and `refresh_token`;
- `garmin_sessions.oauth1_token_json` and `oauth2_token_json`;
- `garmin_user_tokens.garmin_email` and `tokens_json`;
- `apple_health_data.encrypted_data_json`.

It defaults to a read-only dry-run, recognizes values already encrypted with
the destination keys, and aborts if any nonempty value decrypts with neither
the explicit old nor new key. Apply rotates all present tables in one SQLite
transaction and verifies the result before and after commit. A missing optional
table is reported and skipped; an existing table with an unexpected schema is
a hard failure.

### Key preparation

Generate six distinct destination keys: OAuth, Garmin, and Health for staging,
then three different values for production. Load old, new, and peer-environment
values from the encrypted vault into a non-history shell. Never put key values
on the command line, in a ticket, or in captured output.

The command requires these environment variables:

```text
OLD_OAUTH_ENCRYPTION_KEY
OLD_GARMIN_ENCRYPTION_KEY
OLD_HEALTH_DATA_ENCRYPTION_KEY
NEW_OAUTH_ENCRYPTION_KEY
NEW_GARMIN_ENCRYPTION_KEY
NEW_HEALTH_DATA_ENCRYPTION_KEY
PEER_OAUTH_ENCRYPTION_KEY
PEER_GARMIN_ENCRYPTION_KEY
PEER_HEALTH_DATA_ENCRYPTION_KEY
```

When Garmin and Health currently fall back to the old OAuth key, set both
corresponding `OLD_*` variables to that old OAuth value. Their `NEW_*` values
must still be dedicated and distinct. `PEER_*` means the active keys in the
other environment; the tool rejects cross-environment destination-key reuse.

### Dry-run

Build the exact source revision that will be used for the maintenance and run:

```bash
npm run build
npm run security:rotate-data-encryption -- \
  --environment=staging \
  --database=/absolute/path/to/staging.db
```

Review only counts and table-presence status. A dry-run does not mutate the
database and does not need a backup or service-stop acknowledgement. Resolve
every undecryptable-value or schema error before scheduling apply.

### Apply

Apply is an offline maintenance operation. For staging first, then production:

1. Stop the service and all workers that can write the database; verify writes
   are drained.
2. Create a separate SQLite-consistent backup, protect it, and retain it until
   post-restart smoke passes. Example:

   ```bash
   sqlite3 "$DATABASE_PATH" ".backup '$BACKUP_PATH'"
   chmod 600 "$BACKUP_PATH"
   sqlite3 "$BACKUP_PATH" 'PRAGMA integrity_check;'
   ```

3. Re-run dry-run against the stopped database.
4. Apply with the exact acknowledgement:

   ```bash
   npm run security:rotate-data-encryption -- \
     --environment=staging \
     --database="$DATABASE_PATH" \
     --apply \
     --backup="$BACKUP_PATH" \
     --services-stopped-ack=SERVICES_STOPPED_AND_WRITES_DRAINED
   ```

The backup must be an absolute, separate, current, owner-owned regular file
with no group or other permissions. Its SQLite integrity check and encrypted
rotation surface must match the stopped source database. Any mismatch, wrong
key, concurrent-row change, update failure, or verification failure aborts the
operation; transaction failures commit no changes.

After apply, set the environment's active `OAUTH_ENCRYPTION_KEY`,
`GARMIN_ENCRYPTION_KEY`, and `HEALTH_DATA_ENCRYPTION_KEY` to the three new
values before restart. Confirm boot, health, OAuth provider refresh, Garmin
connection/session reads, and Apple Health ingestion/readback for an authorized
test user. Rotate staging fully before production. Do not remove the protected
backup or revoke the old keys until the environment has passed focused smoke
and the owner accepts the result.

## Emergency Rotation

If a secret is suspected leaked:

1. Revoke the provider secret immediately when provider risk outweighs outage
   risk.
2. Disable affected features with runtime flags if available.
3. Rotate staging and production.
4. Run targeted smoke.
5. Audit logs for unexpected use of the old credential.
6. Add a follow-up item for any provider that could not be tested safely.
