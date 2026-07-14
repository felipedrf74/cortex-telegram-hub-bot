# Open Items

Status: canonical
Owner: release lead (Felipe)
Last verified: 2026-07-14
Update policy: keep only current carryovers here. Move closed items to the
monthly archive after the production release is complete.

## Pre-Launch Owner / Operator Gates

These items are intentionally not closed by code because they require a live
production account, production secrets, legal review, or physical/device proof.

| ID | Severity | Area | Status | Next step |
| --- | --- | --- | --- | --- |
| STRIPE-PROD-ACCOUNT | P0 | billing | OPEN / OWNER ACTION | Create the production Stripe account. Current implementation and tests were validated against sandbox Stripe only. |
| STRIPE-LIVE-PRICES | P0 | billing | OPEN / OWNER ACTION | In live Stripe, create or update the subscription price objects to match the owner-confirmed amounts: Pro USD `1499`, Pro BRL `7499`, Max USD `1999`, Max BRL `9999`. If annual prices are enabled, keep the 15% annual references aligned: Pro USD `15290`, Pro BRL `76490`, Max USD `20390`, Max BRL `101990`. |
| STRIPE-WEBHOOK-VERSION | P0 | billing | OPEN / DASHBOARD CONFIRMATION | Configure the production Stripe webhook endpoint API version to `2026-03-25.dahlia`, matching the pinned backend client contract. |
| STRIPE-DUNNING-EMAILS | P0 | billing | OPEN / DASHBOARD CONFIRMATION | Enable Stripe Customer Emails for receipts/cancellations and Smart Retries/dunning before charging live cards. |
| PROD-FINANCE-ENCRYPTION | P0 | finance | OPEN / OWNER CONFIRMATION | Production `FINANCE_ENCRYPTION_KEY` was observed present on 2026-06-06. Confirm key custody/rotation plan before finance tracking is enabled. |
| PROD-BACKUP-ENCRYPTION | P0 | backup / DR | OPEN / OWNER CONFIRMATION | Production `BACKUP_ENCRYPT` and `BACKUP_KEY` were observed present on 2026-06-06, and the 4.14.205 deploy backup included `bot.db`. Confirm offsite encrypted backup storage and restore proof before closing. |
| PROD-OPERATOR-ALERTS | P1 | ops | OPEN / OWNER ACTION | `OPERATOR_ALERT_WEBHOOK_URL` was still missing in production on 2026-06-06. Set it for production alert delivery. |
| PROD-APNS | P1 | notifications | OPEN / OWNER CONFIRMATION | Production notification delivery mode and APNs credential keys were observed present on 2026-06-06. Confirm values, APNs production mode, and real-device delivery proof before live notification rollout. |
| PROD-SENTRY | P1 | observability | OPEN / OWNER ACTION | `SENTRY_DSN` was still missing in production on 2026-06-06. Set it for production error tracking. |
| LEGAL-REVIEW | P0 | legal | OPEN / LAWYER REVIEW | Lawyer review remains required before treating the Terms, Privacy, Cookie, Refund/Cancellation, and Acceptable Use policy drafts as launch-approved. |
| LEGAL-ENTITY | P0 | legal | OPEN / OWNER ACTION | Confirm final legal entity, governing law, jurisdiction, age/children clause, and refund/cancellation wording. |
| DEVICE-PROOF | P1 | iOS launch | OPEN / OWNER ACTION | Signed build 55 is uploaded and `Testing` in internal `Nexus Hub Betinha` and external `Betinhas`; App Store Connect showed zero build-55 installs at the final check. Install/open build 55 and complete the Training walkthrough plus remaining two-account/provider/APNs device proof. Keep build 54 active until the build-55 smoke passes. |
| MARKETING-CF-AUTH | P1 | marketing site | OPEN / OWNER ACTION | Refresh Cloudflare Wrangler authentication or provide a Pages-capable `CLOUDFLARE_API_TOKEN` plus account/project access. No Cloudflare token env was present locally on 2026-06-06, and `npx wrangler whoami` could not retrieve account IDs, so production Pages deploy remains blocked. |

## Current Pricing Decision

Owner-confirmed public prices as of 2026-06-05:

| Plan | USD monthly | BRL monthly |
| --- | ---: | ---: |
| Pro | `$14.99` | `R$74.99` |
| Max | `$19.99` | `R$99.99` |

Backend env comments, the portal landing surface, active quota docs, and the
marketing site's source/built `llms.txt` must stay aligned with these values.
The static contract test is `__tests__/billing/pricing-display-contract.test.ts`.

## Marketing / Legal Site

- The editable marketing/legal site source is the non-git Astro directory at
  `/Users/felipedominguez/Desktop/nexushub-landing-astro`.
- The production site is `https://nexushub.me/`.
- Live Portuguese root was verified again on 2026-06-06 as stale versus the
  local Astro build: it still displayed Pro `R$125` and Max `R$225`. The local source
  and `dist/llms.txt` already carry the confirmed Pro/Max pricing.
- Do not materially change the visual system during pricing/legal deployment.
  Validate the local build with desktop and mobile screenshots before deploying
  Cloudflare Pages.
- 2026-06-05 local validation passed `npm run check`, `npm run build`, and
  Browser pricing smoke on `http://127.0.0.1:4321/`. 2026-06-06 Cloudflare
  auth recheck still failed at `npx wrangler whoami`; production deploy is
  blocked by `MARKETING-CF-AUTH`.
