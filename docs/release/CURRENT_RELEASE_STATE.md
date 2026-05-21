# Backend Current Release State

Status: canonical
Owner: backend release lead (Felipe)
Last verified: 2026-05-21
Update policy: update after backend deploy or staging change. Workspace-level entry point is docs/release/CURRENT_RELEASE_STATE.md.

Last updated: 2026-05-21

## Active Production Release

- Source branch: `main`
- Production HEAD: `ae4e1421`
- Production version: `4.14.181`
- Source implementation commit: `67287399`
- Latest pushed source: `origin/main` is ahead of the running runtime bundle
  with post-deploy docs/tooling follow-ups. `bb68a55b` is the last
  release-state commit before the 2026-05-21 Cloudflare follow-up; later
  docs-only commits may advance the source tip without changing production
  runtime.
- iOS Chat card-hiding source changes are pushed to iOS `main` at `e7cfc8b`;
  a separate signed iOS/TestFlight release is still required to reach devices.
- Official workspace root: `/Users/felipedominguez/Desktop/Nexus Hub`

## 2026-05-21 Nexus Points QA2 + Cloudflare Edge Foundation Promote

- Scope: merged Nexus Points QA2 hardening, added Cloudflare AI-crawler
  unblock/apply tooling plus `/public-status` verification, updated the
  Cloudflare tunnel runbook, and hardened deploy transport so promotion smoke
  and pre-push/deploy verification do not dirty tracked evidence files.
- Production version: `4.14.181`.
- Production deploy commit: `ae4e1421`.
- Source implementation commits before deploy bump: Cloudflare edge tooling
  `c04200c9`, Nexus Points QA2 merge `3ab03654`, staging smoke evidence
  `dcf1e05a`, promotion smoke evidence `6bcf76f6`, and promotion-smoke
  dirty-tree fix `67287399`.
- Staging deploy passed, followed by staging smoke **17/17** at
  `docs/release/smoke-evidence/staging-smoke-3ab03654-20260521T003146Z.json`;
  promote-time staging smoke passed **17/17** again.
- Release validation passed before and during promotion: full backend
  `npm run verify` passed **632 test files / 9,407 tests** in the local,
  deploy-time, and final pre-push gates; deploy-time build passed; production
  env validation passed; owner bootstrap preflight passed; dependencies and
  native modules rebuilt; production backup included `bot.db`; and production
  PM2 showed both `nexus-hub` and `content-engine` online after restart.
- Production health passed after deploy: `https://api.nexushub.me/health`
  returned healthy, and `https://api.nexushub.me/public-status` returned only
  `{ status, service, timestamp }`.
- Important operational note: the first production promote attempt tripped the
  new dirty-worktree deploy guard after full verification refreshed
  `registry-shadow-parity-latest.json`; production PM2 services were restarted
  immediately, then the deploy completed with `NEXUS_DEPLOY_ALLOW_DIRTY=1`
  because the only dirty file was observational evidence. Commit `4b490d4a`
  fixes that loop for future deploys.
- Cloudflare edge unblock is still pending operator/API credentials. Live
  `scripts/cloudflare-edge-verify.sh` still fails for Claude/Anthropic,
  ChatGPT, and Perplexity user agents because this shell has no
  `CLOUDFLARE_API_TOKEN` and Wrangler is not authenticated. The exact apply
  command is `CLOUDFLARE_API_TOKEN=... scripts/cloudflare-edge-unblock.mjs --apply`.
- 2026-05-21 post-QA follow-up: the divergent local backend `main` worktree
  at `a8fce8fe` was preserved under workspace audit evidence
  `docs/release/worktree-recovery-audit-2026-05-21/claude-local-main-divergence/`,
  stashed as `archive: claude local main divergence before syncing origin/main
  2026-05-21`, and fast-forwarded cleanly to `bb68a55b`. A clean
  Cloudflare Pages deploy attempt for `nexushub-landing` and the edge apply
  script both stopped at the missing `CLOUDFLARE_API_TOKEN` credential, so
  live `robots.txt`/`llms.txt` and AI fetcher unblocking remain pending
  operator credentials.
- Follow-up hardening added `scripts/cloudflare-edge-release.sh` as the
  single operator path for the remaining block: it validates/deploys the
  landing Pages bundle, applies the Cloudflare edge rules, waits for
  propagation, and runs strict verification once a Cloudflare API token is
  available. `scripts/cloudflare-edge-verify.sh` now also fails if `llms.txt`
  is missing or carries stale Pro/Max prices.

## 2026-05-18 Beta Registry And Stripe Billing Promote

- Scope: double opt-in beta registry, waitlist email validation, confirmed-only
  portal approval, 30-day DB invite emails, DB invite redemption, long-lived
  static reviewer-code expiry, expired beta-trial paywall handling, public
  website Stripe Checkout routes, webhook idempotency, verified-user checkout
  claim flow, and Pro/Max monthly USD/BRL Stripe price mapping.
- Production version: `4.14.171`.
- Production deploy commit: `1587fc5d`.
- Source implementation commit before deploy bump: `0df40622`.
- Staging deploy passed, followed by a five-minute soak and staging smoke
  **18/18** at
  `docs/release/smoke-evidence/staging-smoke-0df40622-20260518T194456Z.json`;
  promote-time staging smoke passed **18/18** again at
  `docs/release/smoke-evidence/staging-smoke-0df40622-20260518T194531Z.json`.
- Deploy-time validation passed: backend `npm run verify` passed
  **618 test files / 9,172 tests**, deploy-time build passed, production env
  validation passed, production backup included `bot.db`, dependencies updated,
  native modules rebuilt, owner bootstrap preflight passed, and production PM2
  showed both `nexus-hub` and `content-engine` online after restart.
- Production health passed after deploy: `https://api.nexushub.me/health`
  returned `status: healthy`, `server.status: online`, and
  `database: connected`.
- Operator note: the Cloudflare Pages direct upload for `https://nexushub.me`
  did not run in this shell because Wrangler has no non-interactive
  `CLOUDFLARE_API_TOKEN`. The synced static files are present under
  `/Users/felipedominguez/Desktop/nexushub-landing-deploy`.

## Scope

Chat General Action Intelligence production promote:

- Natural-language Chat action candidates now go through a canonical action
  registry and planner before Gmail/email/read-only fast paths.
- The Portuguese regression command
  `Cria um evento na agenda do Gmail chamado igreja das 10 ao meio-dia e meio nesse domingo`
  resolves to Google Calendar event creation, not Gmail unread count.
- Durable action state uses `chat_action_runs` idempotency with provider/local
  read-back before verified success.
- Deterministic executors cover Calendar, Tasks, Content, Cooking, Finance,
  Connections, Training, Notifications, and Decision Center paths where a safe
  verified contract exists. Unsupported mutation surfaces fail closed.
- Model-assisted planner arguments recursively strip user/tenant/account/owner
  identity aliases from nested objects and arrays before dispatch.

## Validation Before Promotion

- Pre-promote staging deploy: PASS.
- Pre-promote staging smoke: 17 passed / 0 failed / 17 total.
- Deploy-time validation: full vitest PASS, 533 files / 7534 tests.
- Deploy-time build: PASS.
- Production promote: completed at `4.14.162`.
- Production health: API health healthy, portal snapshot version `4.14.162`,
  PM2 `nexus-hub` and `content-engine` online at `4.14.162`.
- Real Google Calendar provider mutation/read-back from TestFlight remains
  blocked until an authenticated device/session with Calendar write scope is
  available and owner approval is given to create/delete a live provider event.

## Evidence

- Final staging smoke:
  - `docs/release/smoke-evidence/staging-smoke-feb1b022-20260514T172558Z.json`
  - `docs/release/smoke-evidence/staging-smoke-feb1b022-20260514T172629Z.json`
- Deployment transcript showed production content engine OK, status portal OK,
  bot online, and PM2 online for production `nexus-hub` and `content-engine`.

## Required Post-Promotion Checks

Production-safe follow-ups:

- Cut a signed iOS/TestFlight build from iOS `main` if the Chat
  structured-card hiding changes should reach devices.
- Run an owner-approved live Google Calendar mutation/read-back smoke from an
  authenticated device/session before claiming live provider calendar creation
  end-to-end.
