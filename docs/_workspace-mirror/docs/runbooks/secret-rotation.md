Status: canonical
Owner: release lead (Felipe)
Last verified: 2026-05-05
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
| `OAUTH_ENCRYPTION_KEY` | generate with `openssl rand -hex 64` | run `npx tsx scripts/rotate-oauth-encryption-key.ts --old-key ... --new-key ... --apply` |
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

## OAuth Encryption Key Rotation

Default dry-run:

```bash
OLD_OAUTH_ENCRYPTION_KEY="$old" NEW_OAUTH_ENCRYPTION_KEY="$new" \
  npx tsx scripts/rotate-oauth-encryption-key.ts
```

Apply after dry-run succeeds:

```bash
OLD_OAUTH_ENCRYPTION_KEY="$old" NEW_OAUTH_ENCRYPTION_KEY="$new" \
  npx tsx scripts/rotate-oauth-encryption-key.ts --apply
```

The script re-encrypts `user_oauth_tokens` in one SQLite transaction. If any row
fails, the table rolls back. After apply, set `OAUTH_ENCRYPTION_KEY` to the new
value and restart the service. Do not revoke the old key until provider
connection smoke passes for Google, Outlook, Notion/Todoist if configured, and
wearable providers if present.

## Emergency Rotation

If a secret is suspected leaked:

1. Revoke the provider secret immediately when provider risk outweighs outage
   risk.
2. Disable affected features with runtime flags if available.
3. Rotate staging and production.
4. Run targeted smoke.
5. Audit logs for unexpected use of the old credential.
6. Add a follow-up item for any provider that could not be tested safely.
