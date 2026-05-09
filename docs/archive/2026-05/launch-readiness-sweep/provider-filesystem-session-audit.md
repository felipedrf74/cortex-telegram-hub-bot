# Launch Readiness Sweep Provider Filesystem Session Audit

Status: source audit complete
Date: 2026-05-10
Branch: `launch-readiness-sweep-2026-05`

## Scope

This memo closes the P0 Garmin closeout P3 carryover to audit Amazon and Uber
collectors for Garmin-style legacy filesystem session leakage. No runtime fix
was made in this round; dirty findings are intentionally carried as follow-ups.

## Amazon Collector

File evidence:
- `src/services/amazon-collector.ts:91` reads global Amazon enablement,
  email, and password from `config.invoices`.
- `src/services/amazon-collector.ts:112` reads the shared
  `config.invoices.amazonSessionPath`.
- `src/services/amazon-collector.ts:116` loads the saved Playwright
  `storageState` file when it exists.
- `src/services/amazon-collector.ts:918` accepts a `userId` and records
  discovered/duplicate/filed invoice rows under that user.
- `src/services/scheduler.ts:1043` limits scheduled Amazon collection to
  `getOwnerTenantIds()`.
- `src/handlers/commands/finance.ts:188` resolves any authenticated Telegram
  caller to a canonical user and `src/handlers/commands/finance.ts:250` passes
  that user into `collectAmazonInvoices`.

Pattern exists: yes. Amazon uses one global filesystem browser session path and
one global credential pair.

Owner-only gating enforced: partial. Scheduled cron is owner-only, but the
manual `/amazon` Telegram command is not owner-only before invoking the global
Amazon session.

Severity verdict: `dirty-different-mechanism`.

Recommendation: `scoped-architecture-round`. This is not the exact Garmin leak:
there is no per-user provider token table being contaminated with owner token
material. The risk is still real because a non-owner manual command can use the
global Amazon browser session and then store invoice filing rows under their own
`user_id`. Fix options should be designed with the finance skill owner model:
either owner-only these global collectors or introduce per-user collector
sessions/credentials before Wave 2 finance rollout.

## Uber Collector

File evidence:
- `src/services/uber-collector.ts:90` reads global Uber enablement, email, and
  password from `config.invoices`.
- `src/services/uber-collector.ts:110` reads the shared
  `config.invoices.uberSessionPath`.
- `src/services/uber-collector.ts:113` loads the saved Playwright
  `storageState` file when it exists.
- `src/services/uber-collector.ts:821` accepts a `userId` and records
  discovered/duplicate/filed invoice rows under that user.
- `src/services/scheduler.ts:1062` limits scheduled Uber collection to
  `getOwnerTenantIds()`.
- `src/handlers/commands/finance.ts:271` resolves any authenticated Telegram
  caller to a canonical user and `src/handlers/commands/finance.ts:330` passes
  that user into `collectUberInvoices`.

Pattern exists: yes. Uber uses one global filesystem browser session path and
one global credential pair.

Owner-only gating enforced: partial. Scheduled cron is owner-only, but the
manual `/uber` Telegram command is not owner-only before invoking the global
Uber session.

Severity verdict: `dirty-different-mechanism`.

Recommendation: `scoped-architecture-round`. As with Amazon, this does not copy
owner tokens into a user-scoped provider-session table, but it can let a
non-owner invoke a global owner browser session and write resulting invoice
filing rows under their own `user_id`. Keep out of this launch sweep and open a
finance collector tenant-safety follow-up.

## Summary

Both collectors are dirty by tenant-safety standards, but not dirty in the same
mechanism as Garmin. The scheduler path is already owner-only. The manual
Telegram commands are the exposure and should be handled in a focused finance
collector tenant-safety round rather than patched opportunistically here.
