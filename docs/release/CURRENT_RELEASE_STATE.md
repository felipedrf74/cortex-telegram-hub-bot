# Backend Current Release State

Status: canonical
Owner: backend release lead (Felipe)
Last verified: 2026-05-22
Update policy: update after backend deploy or staging change. Workspace-level entry point is docs/release/CURRENT_RELEASE_STATE.md.

Last updated: 2026-05-22

## Active Production Release

- Source branch: `main`
- Production HEAD: `05960637`
- Production version: `4.14.186`
- Source implementation commit: `992879d6`
- Latest pushed source: `origin/main` includes a post-deploy release-state
  docs commit on top of the running production deploy commit; production
  runtime remains deployed from `05960637`.
- iOS Chat card-hiding source changes are pushed to iOS `main` at `e7cfc8b`;
  a separate signed iOS/TestFlight release is still required to reach devices.
- Official workspace root: `/Users/felipedominguez/Desktop/Nexus Hub`

## 2026-05-22 Decision Center Human Guidance v2 Production Promote

- Scope: promoted the Human Guidance v2 pass for Decision Center and
  Secretary surfaces. The existing `DecisionExplanation` contract is extended
  additively with `recommendedMove`, `ifIgnored`, `actionLabels`, and
  `displaySections`; no parallel `presentation` object and no new schema
  migration were introduced. Normal user reads now filter smoke/internal/admin
  decisions, sanitize technical strings, and keep source traces / facts / rules
  / tradeoffs out of iOS user-facing decision flows.
- Production version: `4.14.186`.
- Production deploy commit: `05960637`.
- Source implementation commit before deploy bump: `992879d6`.
- Previous production deploy commit: `17c35872`.
- Staging deploy passed from committed `main`, followed by staging smoke
  **17/17**. Authenticated staging payload audits for PT-BR, PT-PT, and EN
  users passed with zero banned user-facing terms, localized
  `secretaryToday.title`, valid `displaySections`, and no raw action labels.
- Release validation passed before production: backend typecheck passed,
  focused Decision Center tests passed, iOS focused Decision Center tests and
  simulator build had passed during implementation, pre-commit full Vitest
  passed with **634 test files / 9,430 tests**, deploy-time full validation
  passed with **639 test files / 9,468 tests**, and the final backend pre-push
  gate repeated typecheck plus full Vitest with **639 test files / 9,468 tests**
  passing before pushing `05960637`.
- Production promotion started through the standard promote path. The deploy
  script created and pushed the `4.14.186` release commit, stopped services,
  and created a production backup including `bot.db`, then tripped the
  clean-tree guard because verification refreshed the tracked registry shadow
  parity evidence file. PM2 services were restarted immediately, the generated
  evidence file was restored, and the same committed `4.14.186` artifact was
  transported manually without creating an unnecessary extra version bump.
- Production deploy completed for the committed `4.14.186` artifact. The
  production backup included `bot.db`, dependencies were installed, owner
  bootstrap preflight passed, `better-sqlite3` was rebuilt for system Node,
  and both `content-engine` and `nexus-hub` PM2 services are online.
- Production health passed after deploy: local content health and portal
  snapshot passed, `nexus-hub` package version is `4.14.186`,
  `https://api.nexushub.me/health` returned `status: healthy` at
  `2026-05-22T18:03:21Z`, and `https://api.nexushub.me/public-status` returned
  the minimal public status payload.
- Production authenticated API smoke passed **13/13** against
  `http://localhost:8200` with a short-lived owner token. Production Decision
  Center payload audit passed for active PT-BR and EN users: overview and
  plan/today returned 200, no `[SMOKE]` or banned technical strings were found
  in scanned user-facing fields, `secretaryToday.title` localized correctly
  (`Secretary hoje` / `Secretary today`), and no invalid display sections or raw
  action labels were detected. No active PT-PT production user was available
  for a live PT-PT audit.
- Production smoke cleanup dry-run passed with `inspected=0`, `expired=0`,
  confirming there were no scoped smoke rows to expire at deploy time. The
  scheduled smoke cleanup remains registered twice hourly, offset from handled
  history backfill.

## 2026-05-22 Decision Center Clarity + Secretary Intelligence Production Promote

- Scope: promoted the full Decision Center clarity and Secretary intelligence
  phase: structured `explanation` payloads for active and handled decisions,
  handled history persistence/backfill, locale-aware Secretary Today summary,
  Decision Center timeline hardening, outcome/ranking observability,
  privacy-safe notification smoke tooling, and APNs rank-gated urgent decision
  delivery. iOS rendering support was already validated on main; no iOS binary
  release was part of this backend promote.
- Production version: `4.14.183`.
- Production deploy commit: `17c35872`.
- Source implementation commit before deploy bump: `109ce2e9`.
- Previous production deploy commit: `5f64ead7`.
- Database change: migration `153_decision_center_explanations.sql` adds
  `handled_by_nexus_items.explanation_json`; runtime schema ensure also covers
  fresh/test DBs.
- Staging deploy passed from the committed RC, followed by staging smoke
  **19/19** with evidence at
  `docs/release/smoke-evidence/staging-smoke-5f64ead7-20260522T130003Z.json`.
- Release validation passed before and during promotion: backend typecheck
  passed, focused Decision Center / Secretary / notification / smoke-tool
  suites passed during implementation, the pre-commit hook ran full Vitest
  with **633 test files / 9,419 tests** passing, and the final `main`
  fast-forward pre-push gate repeated typecheck plus full Vitest with
  **633 test files / 9,419 tests** passing.
- Production deploy completed for the committed `4.14.183` artifact. The first
  deploy attempt tripped the dirty-worktree guard after verification refreshed
  observational registry evidence; production PM2 services were restarted
  immediately, the evidence timestamp was restored, and the deploy continued
  manually with the same committed artifact rather than creating an unnecessary
  extra version bump.
- Production health passed after deploy: `content-engine` returned OK,
  `nexus-hub` package version is `4.14.183`, both production PM2 services are
  online, `https://api.nexushub.me/health` returned `status: healthy`, and
  `https://api.nexushub.me/public-status` returned only the minimal public
  status payload.
- Production APNs proof passed after setting
  `NOTIFICATION_DELIVERY_MODE=apns` in the production engine environment and
  restarting `nexus-hub` with updated env. Decision Center notification smoke
  run `decision-center-notification-smoke-20260522132201-ixfe21` passed with
  the visible urgent decision push accepted by APNs (`provider=apns`,
  `status=sent`) and the low-rank smoke item held to digest/in-app as expected.
  The smoke report redacted notification copy and exposed only safe payload
  length/hash evidence.
- Staging may lag production after the promote/version bump; the promoted
  functional code was smoke-tested on staging before the production bump.

## 2026-05-21 Cloudflare Edge Unblock Apply (Completion)

- Scope: completed the operator-credentialed half of the Cloudflare edge
  unblock work — deployed the landing Pages bundle, applied the three
  Cloudflare WAF rules, disabled the managed `robots.txt` and AI bots
  protection on the marketing zone, and validated the live edge contract
  end-to-end. No backend code or version change.
- Pages deploy: `nexushub-landing` project on branch `main` redeployed at
  `https://eeb8585c.nexushub-landing.pages.dev` (production alias is
  `https://nexushub.me`). Bundle excluded `.wrangler/`, `.DS_Store`, and
  `.bak*` per `scripts/cloudflare-edge-release.sh`.
- WAF apply: `node scripts/cloudflare-edge-unblock.mjs --apply
  --include-staging --skip-bot-management` upserted three rules on the
  `nexushub.me` zone `5d4cc89b638871ae7084ee65c5f3320d`:
  - `nexus_marketing_ai_crawler_skip_v1` — SKIP for AI fetchers on
    `nexushub.me` and `www.nexushub.me`.
  - `nexus_api_public_status_ai_monitor_skip_v1` — SKIP for AI and monitor
    UAs on `api.nexushub.me` and `api-staging.nexushub.me` at path
    `/public-status` only.
  - `nexus_api_ai_fetcher_block_except_public_status_v1` — BLOCK for AI
    fetchers on `api.nexushub.me` and `portal.nexushub.me` at every path
    other than `/public-status`.
- Bot Management toggle: the full-payload `PUT /zones/{id}/bot_management`
  call in `scripts/cloudflare-edge-unblock.mjs` was rejected with `400 Bad
  Request` on the Free plan zone (Free rejects writes to read-only fields
  like `enable_js`, `fight_mode`, `using_latest_model`). A focused PUT with
  only `{"ai_bots_protection":"disabled","is_robots_txt_managed":false}`
  succeeded. The script's full-payload merge needs a follow-up fix to use a
  focused payload on Free plans — tracked as a follow-up; current behavior
  works around it with `--skip-bot-management` + a manual focused `curl`.
- Verification: `scripts/cloudflare-edge-verify.sh` returned **13/13 PASS**:
  marketing site reachable to ClaudeBot/Claude-Web/anthropic-ai/ChatGPT-User/
  PerplexityBot, `api.nexushub.me/public-status` reachable to ClaudeBot and
  UptimeRobot, `api.nexushub.me/health` still 403 to ClaudeBot,
  `robots.txt` no longer carries Cloudflare Managed content and explicitly
  allows ClaudeBot, `llms.txt` starts with `# Nexus Hub` and carries the
  current Pro `$14.99/R$69.99` and Max `$24.99/R$119.99` prices.
- `--include-staging` was used so `api-staging.nexushub.me/public-status` is
  on the same allowlist as production.
- Token: Felipe-supplied Cloudflare API token with TTL through
  `2026-06-30T23:59:59Z`. Token was exposed in chat transcript during the
  apply; rotate via the Cloudflare dashboard once this section is committed.
  The Cloudflare account ID `413581f656838e03191273def66d5e3a` was supplied
  via `CLOUDFLARE_ACCOUNT_ID` because the token lacked the User-read scope
  that `npx wrangler whoami` requires for auto-detect.
- No manual dashboard step was needed for the apply; the entire flow ran
  via API/CLI from the Mac.

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
