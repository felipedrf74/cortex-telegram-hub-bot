# Open Items

Status: canonical
Owner: release lead (Felipe)
Last verified: 2026-06-05
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
| PROD-FINANCE-ENCRYPTION | P0 | finance | OPEN / OWNER ACTION | Set `FINANCE_ENCRYPTION_KEY` in production with a 32-byte secret before finance tracking is enabled. |
| PROD-BACKUP-ENCRYPTION | P0 | backup / DR | OPEN / OWNER ACTION | Set `BACKUP_ENCRYPT=true`, provide `BACKUP_KEY`, and confirm offsite encrypted backup storage before production promotion. |
| PROD-OPERATOR-ALERTS | P1 | ops | OPEN / OWNER ACTION | Set `OPERATOR_ALERT_WEBHOOK_URL` for production alert delivery. |
| PROD-APNS | P1 | notifications | OPEN / OWNER ACTION | Confirm `NOTIFICATION_DELIVERY_MODE=apns` and provide/verify production APNs credentials before live notification rollout. |
| PROD-SENTRY | P1 | observability | OPEN / OWNER ACTION | Set `SENTRY_DSN` for production error tracking. |
| LEGAL-REVIEW | P0 | legal | OPEN / LAWYER REVIEW | Lawyer review remains required before treating the Terms, Privacy, Cookie, Refund/Cancellation, and Acceptable Use policy drafts as launch-approved. |
| LEGAL-ENTITY | P0 | legal | OPEN / OWNER ACTION | Confirm final legal entity, governing law, jurisdiction, age/children clause, and refund/cancellation wording. |
| DEVICE-PROOF | P1 | iOS launch | OPEN / OWNER ACTION | Complete signed TestFlight archive/upload, two-account physical walkthrough, and real provider-state proof for Gmail/Outlook/Health/Garmin/APNs. |
| MARKETING-CF-AUTH | P1 | marketing site | OPEN / OWNER ACTION | Refresh Cloudflare Wrangler authentication or provide a Pages-capable `CLOUDFLARE_API_TOKEN`; the local Astro build is green, but `wrangler pages deploy` currently fails with Cloudflare API auth error `10000`. |

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
- Live Portuguese root was verified on 2026-06-05 as stale versus the local
  Astro build: it still displayed Pro `R$125` and Max `R$225`. The local source
  and `dist/llms.txt` already carry the confirmed Pro/Max pricing.
- Do not materially change the visual system during pricing/legal deployment.
  Validate the local build with desktop and mobile screenshots before deploying
  Cloudflare Pages.
- 2026-06-05 local validation passed `npm run check`, `npm run build`, and
  Browser pricing smoke on `http://127.0.0.1:4321/`; Cloudflare production
  deploy is blocked by `MARKETING-CF-AUTH`.
