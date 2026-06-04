# Backend Current Release State

Status: canonical
Owner: backend release lead (Felipe)
Last verified: 2026-06-04
Update policy: update after backend deploy or staging change. Workspace-level entry point is docs/release/CURRENT_RELEASE_STATE.md.

Last updated: 2026-06-04

## Active Production Release

- Source branch: `main`
- Production HEAD: `6438553d`
- Production version: `4.14.202`
- Source implementation commit before deploy bump: `870ca09f` (Training
  remediation round-3 fast-follow).
- Latest pushed runtime deploy commit: `origin/main` includes `6438553d`.
  Post-deploy docs-only closeout commits may sit ahead of the runtime deploy.
- Staging remains on `4.14.201` until the next staging deploy; the promoted
  functional code passed staging smoke before production.
- Official workspace root: `/Users/felipedominguez/Desktop/Nexus Hub`

## 2026-06-04 Training Remediation Round 3 Fast-Follow Production Promote

- Scope: promoted the Training remediation round-3 fast-follow. The backend now
  closes the residual Training reflow and cancel ownership oracles, centralizes
  owner-id audit hashing, tenant-scopes cancellation active-plan reads, preserves
  acute-injury safety copy after the chest-pain precedence fix, pins ACWR and
  inferred-pain route boundaries, guards low-adherence and WeekProtection
  zero-session surfaces, and adds DB-level proof for the stale agenda index
  migration. iOS main now enforces required Garmin freshness markers and trusts
  backend-validated remote low-adherence cards during cold load.
- Production version: `4.14.202`.
- Production deploy commit: `6438553d`.
- Source implementation commit before deploy bump: `870ca09f`.
- iOS main: `40a885f` (`fix(training): enforce plan freshness markers`).
- Previous production deploy commit: `ddb8eec4` (4.14.201).
- Staging deploy passed from `main` before production; promote-time staging
  smoke passed **19/19** before production was touched.
- Release validation passed before production: focused backend round-3 suites
  passed **10 files / 300 tests**; backend `npm run verify` passed typecheck,
  science-policy pin check, and full Vitest with **816 test files / 11,951
  tests**; focused iOS Training/contract suites passed **107 tests**; the full
  iOS helper `scripts/ios-single-simulator-test.sh` passed **1,461 XCTest
  tests** plus **10 Swift Testing cases**; and the final `main` pre-push gate
  repeated typecheck, full Vitest with **816 test files / 11,951 tests**, and
  build before pushing `6438553d`.
- Production promotion completed through `./scripts/promote-to-prod.sh`:
  production backup included `bot.db`, dependencies were installed, owner
  bootstrap preflight passed, native modules rebuilt for system Node, and PM2
  restarted `content-engine` and `nexus-hub`.
- Production health passed after deploy: content engine returned `status: ok`,
  the authenticated status portal returned version `4.14.202`, the bot was
  online, and PM2 showed both production services online.
- Known caveats: staging remains on `4.14.201` after the production version
  bump; the promoted functional code was smoke-tested on staging before
  production. Moderate-injury `injury_safe_swap` remains intentionally deferred
  on the Training today read model pending product approval. No signed
  TestFlight upload, production APNs proof, physical HealthKit/Apple Watch
  proof, Garmin provider-state proof, or real two-account device walkthrough was
  part of this production promote.

## 2026-06-03 Training Remediation Production Promote

- Scope: promoted the Training remediation and coach hardening release to
  production. The backend now hardens Training plan generation, race-date
  validation, no-oracle ownership handling, cancellation tenant scoping,
  readiness/ACWR math, safety copy precedence, zone calculators, sport engines,
  chat action/parser contracts, training skill manifest knowledge, lifecycle
  cleanup, and the stale agenda unique-index migration. iOS main now carries
  aligned Training decoding, home-card sanitization, low-adherence visibility,
  two-a-day `auto` handling, and plan/coach UI contract fallbacks.
- Production version: `4.14.201`.
- Production deploy commit: `ddb8eec4`.
- Source implementation/evidence commits before deploy bump: `3aac49b4`
  (Training implementation), `fde1ad3e` (main sync), `e758d6ab` (migration
  renumber), and `caa81a28` (staging smoke evidence).
- iOS main: `c0c3f39` (`fix(training): harden coach UI contracts`).
- Previous production deploy commit: `30285bb3` (4.14.200).
- Staging deploy passed from `main` before production. Standalone staging smoke
  passed **19/19** with evidence at
  `docs/release/smoke-evidence/staging-smoke-e758d6ab-20260603T202437Z.json`;
  promote-time staging smoke also passed **19/19** before production was
  touched.
- Release validation passed before production: focused backend Training suites
  passed **11 files / 260 tests**; backend `npm run verify` passed typecheck,
  science-policy pin check, and full Vitest with **815 test files / 11,942
  tests**; focused iOS Training/contract suites passed **128 tests**; the full
  iOS helper `scripts/ios-single-simulator-test.sh` passed **1,458 XCTest
  tests** plus **10 Swift Testing cases**; and the final `main` pre-push gate
  repeated typecheck, full Vitest with **815 test files / 11,942 tests**, and
  build before pushing `ddb8eec4`.
- Production promotion completed through `./scripts/promote-to-prod.sh` with
  `NEXUS_DEPLOY_SKIP_VERIFY=auto-when-staged`: production backup included
  `bot.db`, dependencies were installed, owner bootstrap preflight passed,
  native modules rebuilt for system Node, and PM2 restarted `content-engine`
  and `nexus-hub`.
- Production health passed after deploy: content engine returned `status: ok`,
  the authenticated status portal returned version `4.14.201`, the bot was
  online, PM2 showed both production services online, and
  `https://api.nexushub.me/public-status` returned `status: ok`.
- Known caveats: staging remains on `4.14.200` after the production version
  bump; the promoted functional code was smoke-tested on staging before
  production. No signed TestFlight upload, production APNs proof, physical
  HealthKit/Apple Watch proof, or real two-account device walkthrough was part
  of this production promote.

## 2026-06-03 Decision Center Execution + iOS Smoke Production Promote

- Scope: promoted the Decision Center execution plan after ChatV2 main sync,
  without editing `src/services/chat-core-v2/**`. The release includes
  Decision Center API v2 helpers, lifecycle/status/events, metrics/dashboard,
  active expiry, semantic dedup/supersede, relationship types, fatigue and
  type suppression, refresh/reconnect/choice/skill-card/freshness/human-review
  guardrails, and the default-off Decision Center Command Bus dismiss adapter.
- Production version: `4.14.200`.
- Production deploy commit: `30285bb3`.
- Source implementation/evidence commits before deploy bump: `c7f049e1`;
  staging smoke evidence commit `ddcf211e`.
- iOS main: `9f5649c` adds the Decision Center local-backend smoke harness and
  aligns Decision Center primary actions with the backend action route.
- Previous production deploy commit: `09a1c96d` (4.14.199).
- Release validation passed before production: backend `npm run verify` passed
  **812 test files / 11,848 tests**; focused Decision Center peer validation
  passed; local Docker + iOS simulator smoke passed with evidence under
  `.local/decision-center-ios-smoke/evidence/20260603-134101` and peer rerun
  evidence under `.local/decision-center-ios-smoke/evidence/20260603-135756`;
  staging smoke passed **19/19** at
  `docs/release/smoke-evidence/staging-smoke-c7f049e1-20260603T135207Z.json`;
  deploy-time verify passed **812 test files / 11,848 tests**; final `main`
  pre-push typecheck, full Vitest, and build passed.
- Production deploy completed through the standard `promote-to-prod.sh` path.
  PM2 restarted `content-engine` and `nexus-hub`; both returned online.
- Production health passed after deploy:
  `https://api.nexushub.me/health` returned `status: healthy`,
  `https://api.nexushub.me/public-status` returned `status: ok`, and
  unauthenticated Decision Center overview, summary, and handled endpoints each
  returned `401`.
- Evidence limits: most new Decision Center behavior is default-off or scoped
  by runtime flags until rollout approval. The iOS proof is local
  Docker-backed simulator proof, not production APNs, TestFlight, or physical
  device proof.

## 2026-05-25 Training Outlook Default-Enabled Production Promote

- Scope: removed the opt-in `TRAINING_CALENDAR_OUTLOOK_ENABLED` env requirement
  for selecting Outlook as the training calendar in the iOS New Plan flow.
  Pre-fix, picking "Outlook" returned a 503 ("That calendar is not available
  for Training plans yet"). The same Outlook adapter
  (`secretary-unified-calendar-provider-adapter`) had been writing
  training-owned events to Outlook in production for months via the
  secretary-agenda path, so the defensive gate was effectively stale. Outlook
  is now ON by default, matching Google's contract. The kill switch
  `TRAINING_CALENDAR_OUTLOOK_DISABLED=1` is retained for fast emergency
  rollback without a redeploy.
- Production version: `4.14.195`.
- Production deploy commit: `0682b34b`.
- Source implementation/evidence commits before deploy bump: PR #138 merge
  `0bae01cb`; staging smoke evidence `e2c21415`.
- Previous production deploy commit: `fb1f844e` (4.14.194).
- Release validation passed before production: PR #138 GitHub checks all green
  (Tests focused, Build, Lint & Type Check, Science-policy version, CodeQL,
  OpenSSF Scorecard, Migration check skipped, Python content-engine audit),
  staging smoke passed **17/17** at evidence
  `docs/release/smoke-evidence/staging-smoke-0bae01cb-20260525T161058Z.json`,
  and the deploy-time `npm run verify` passed
  **718 test files / 10,555 tests** (floor previously 10,544; +11 net new from
  the +5 operational-switches tests, +9 calendar-source tests with the new
  default-on contract minus 4 pre-fix tests, +4 calendar-event-writer tests).
- Production deploy completed through the standard `promote-to-prod.sh` path.
  Deploy ordering bug from PR #136 stayed clear: the clean-tree check now
  precedes the PM2 stop so a dirty evidence file never strands prod.
- Production health passed after deploy: public
  `https://api.nexushub.me/health` returned `status: healthy` with fresh
  `uptime: 21s`, PM2 showed both `nexus-hub` and `content-engine` online,
  and the production package version is `4.14.195`.
- Behavior change downstream: `createTrainingCalendarEvent` no longer forces
  `'google'` as the auto-target fallback — with Outlook default-enabled, the
  writer passes `undefined` and lets `unified-calendar.createEvent` resolve
  per the user's actual connected calendars. Tests updated to pin the new
  shape.

## 2026-05-25 Training Bug-Fix Triplet Production Promote

- Scope: PR #137 closed three user-reported Training bugs in one PR:
  (1) cancelling a plan left orphan Outlook/Google calendar events from
  prior `plan_version` regenerations because the cancel cascade's
  `findMatchingSecretaryAgendaItems` query pinned the current version;
  (2) iOS-sent `twoADayPreference: "auto"` was silently dropped at the route
  validator (only `never|optional|preferred` accepted) AND the hybrid branch
  of `resolveWeeklyTargets` silently rewrote explicit `(running=5, strength=5)`
  to `(running=2, strength=4)` based on `sessionsPerWeek=6`, preventing
  two-a-day day generation; (3) Outlook/Google calendar event bodies showed
  raw `NEXUS_SECRETARY_*` correlation metadata when `session.description` was
  empty for some session types, collapsing the visible content to just the
  metadata footer.
- Production version: `4.14.194`.
- Production deploy commit: `fb1f844e`.
- Source implementation/evidence commits before deploy bump: PR #137 merge
  `d94c2d1a`; staging smoke evidence `b3bfb4e8`.
- Previous production deploy commit: `fb1ca66d` (4.14.193).
- Release validation passed before production: PR #137 GitHub checks all
  green, staging smoke passed **17/17** at evidence
  `docs/release/smoke-evidence/staging-smoke-d94c2d1a-20260525T101747Z.json`,
  and deploy-time `npm run verify` passed
  **718 test files / 10,544 tests** (floor was 10,525; +19 net new tests
  across cancel-cascade, two-a-day, secretary-adapter, and route entitlement
  surfaces).
- Production deploy completed through the standard `promote-to-prod.sh`
  path. PM2 restarted `nexus-hub` (PID 2804361) and `content-engine`
  (PID 2804352); health checks green.
- Production health passed after deploy: public
  `https://api.nexushub.me/health` returned `status: healthy` with fresh
  `uptime: 30s`, PM2 reported both services online, and the production
  package version was `4.14.194`.
- Track A — Cancel cascade fixes (`src/services/training-plan-cancellation-cascade.ts`,
  `src/api/routes/training-plan-cancellation.ts`): pushed the matching query
  into SQL via `source_intent_id LIKE 'training:${planId}:%'`, added
  `findSecretaryAgendaCalendarEventsForPlan` helper so the deletion-targets
  builder also enumerates Secretary-owned events without
  `training_agenda_event_ownership` rows.
- Track B — Volume + two-a-day fixes (`src/api/routes/training-plan-routes.ts`,
  `src/services/training-coach-kernel-plan-generator.ts`,
  `src/services/training-plan-volume-enforcement.ts`,
  `src/services/coach-kernel/types.ts`,
  `src/services/training-profile-model.ts`): added `'auto'` to the
  `twoADayPreference` enum + a first-class `'auto'` branch in
  `resolveMaxSessionsPerDay`; hybrid `resolveWeeklyTargets` branch now
  respects explicit per-sport asks when both `runSessionsPerWeek` AND
  `strengthSessionsPerWeek > 0` are provided; volume enforcer sums the
  explicit per-sport values into `requestedTotal` regardless of
  `planSport`.
- Track C — Calendar event body (Stage 1) (`src/services/secretary-unified-calendar-provider-adapter.ts`):
  `sourceBodyForSecretaryCalendarEvent` is now a 3-priority hydration chain
  (stored description → re-rendered from `description_json` via
  `renderSectionsAsText` → minimal `title · intensity · duration min`
  fallback). Body now puts workout content FIRST, then a `────────────`
  divider, then the metadata markers. `extractSecretaryAgendaMarker` is
  unchanged so legacy events still resolve.
- Track C — Stage 2 deferred: moving `NEXUS_SECRETARY_*` markers entirely
  to Google `extendedProperties.private` and Outlook
  `singleValueExtendedProperties` is queued as a separate PR. There is zero
  existing extended-properties plumbing in `google-calendar.ts` or
  `outlook-calendar.ts`, so that change would double this PR's size + need
  cross-provider integration testing. Stage 1 above solves the user-visible
  symptom.

## 2026-05-25 Coach Periodization v2.1 + Deploy Safety Production Promote

- Scope: promoted PR #135 Coach Periodization v2.1 training changes and PR #136
  deploy safety hardening. PR #135 added the v2.1 training implementation,
  tests, CI/operator docs, and R1-R8 closeout fixes. PR #136 fixed the deploy
  ordering hazard where a generated registry-shadow-parity evidence timestamp
  could dirty the worktree after PM2 services had already been stopped.
- Production version: `4.14.193`.
- Production deploy commit: `fb1ca66d`.
- Source implementation/evidence commits before deploy bump: PR #135 merge
  `99992ddc`; deploy safety merge `256aa591`.
- Previous production deploy commit: `bac44816`.
- Release validation passed before production: PR #136 GitHub checks passed,
  staging smoke passed **17/17**, deploy-time `npm run verify` passed
  **718 test files / 10,525 tests**, and the final `main` pre-push gate repeated
  typecheck, full Vitest, and build before pushing `fb1ca66d`.
- Production deploy completed through the standard `promote-to-prod.sh` path
  after local dependencies were refreshed with `npm ci`. The deploy installed
  dependencies on the server, ran owner bootstrap preflight, rebuilt native
  modules for system Node, restarted `content-engine` and `nexus-hub`, and
  saved the PM2 process list.
- Production health passed after deploy: public
  `https://api.nexushub.me/health` returned HTTP 200 repeatedly, server-local
  `http://127.0.0.1:8200/health` returned 200, PM2 showed `nexus-hub` and
  `content-engine` online, and the production package version is `4.14.193`.
- Incident recovery note: Cloudflare Tunnel was found stopped during the
  deploy recovery window and was restarted as detached `cloudflared` user
  processes. Public health is currently green through the tunnel, but the next
  infra follow-up should install/enable a supervised service for `cloudflared`.
- Local cleanup note: obsolete clean/merged worktrees from prior Decision
  Center, Chat Core, Cloudflare, confirmation, and training validation branches
  were removed after promotion. Dirty or unmerged worktrees were intentionally
  left in place.

## 2026-05-23 Beta Hardening Confirmation Contract Production Promote

- Scope: promoted the beta-hardening confirmation contract for chat-driven
  operational actions. The backend now fails closed for unclassified tools,
  validates signed confirmation tokens for user/tenant/intent scope before any
  side effect, preserves idempotent confirm-action replay behavior, and keeps
  iOS confirmation/rate-limit UX contracts aligned with the backend.
- Production version: `4.14.190`.
- Production deploy commit: `bac44816`.
- Source implementation/evidence commit before deploy bumps: `8ee3ad95`.
- Previous production deploy commit: `05960637`.
- Staging deploy passed at runtime commit `76ac6684` / version `4.14.188`,
  followed by staging smoke. Promote-time staging smoke passed **17/17** before
  production was touched. Targeted staging confirmation-contract smoke also
  passed for pending-confirmation emission, confirm-action execution, idempotent
  replay, missing/wrong-user/wrong-intent token rejects, and the structured
  rate-limit path.
- Release validation passed before production: backend typecheck passed,
  focused confirmation contract coverage passed, the final `main` pre-push
  gates ran full Vitest with **641 test files / 9,490 tests** passing, and iOS
  focused confirmation/rate-limit simulator tests passed **28/28**.
- Production promotion started through the standard promote path. The deploy
  script created and pushed release bump commits, stopped services, and created
  production backups including `bot.db`, then tripped the clean-tree guard
  because the `chat-action-registry-shadow-parity` pre-push evidence refreshed
  the tracked registry shadow parity timestamp. PM2 services were restarted
  immediately after each interrupted attempt. The generated evidence file was
  restored, and the clean committed `4.14.190` artifact was transported with the
  same stop / backup / rsync / dependency install / native rebuild / start
  sequence from `deploy.sh`.
- Production deploy completed for the committed `4.14.190` artifact. The
  production backup included `bot.db`, dependencies were installed, owner
  bootstrap preflight passed, `better-sqlite3` was rebuilt for system Node, and
  both `content-engine` and `nexus-hub` PM2 services are online.
- Production health passed after deploy: local content health returned
  `status: ok`, the authenticated portal snapshot returned version `4.14.190`,
  and PM2 showed both production services online. Staging remains on
  `4.14.188`; this is expected after production deploy version bumps, and the
  promoted functional code was smoke-tested on staging before production.

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
