# Nexus Hub — Agent Onboarding

> **Last verified: 2026-05-18.** This doc is the canonical session-bootstrap prompt for any agent (Claude, Codex, future-self) joining Nexus Hub fresh. Read top to bottom before writing code or markdown.
>
> Felipe is the human owner. One production backend, one iOS app, one set of active worktrees.

---

## 1. Current production truth

Confirmed via read-only SSH during the worktree recovery audit on 2026-05-18.

- **Backend production version**: `4.14.170`
- **Backend `origin/main`**: `ee780102`
- **Production deploy commit** (the bump commit on the server): `65ed74f9`
- **iOS `origin/main`**: `e3908cc`
- **PM2**: `nexus-hub` online, `content-engine` online
- **API health**: `https://api.nexushub.me/health` returns `healthy`

> **WARNING — stale local checkout.** The backend `main` branch in `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot` is behind `origin/main` (local was at `a8fce8fe`, origin is `ee780102`). Do NOT treat local backend `main` as production truth until you refresh. iOS local `main` matches `origin/main` and is safe.

If you need to re-verify production version, the canonical sources are:

1. `package.json:version` in the backend repo (only trustworthy after `git pull`)
2. `curl -s https://api.nexushub.me/health` (live, definitive)
3. `docs/release/CURRENT_RELEASE_STATE.md` (workspace) — narrative; may lag actual prod

---

## 2. Repos & workspace paths

```
/Users/felipedominguez/Desktop/
├── Custom Connectors/Cortex/cortex-telegram-hub-bot/         ← backend, main worktree
├── Custom Connectors/Cortex/cortex-telegram-hub-bot-<slug>/  ← backend feature worktrees
├── Nexus Hub IOS/Nexus Hub/                                  ← iOS, main worktree
├── Nexus Hub IOS/Nexus Hub-<slug>/                           ← iOS feature worktrees
├── Nexus Hub IOS/worktrees/<slug>/                           ← iOS extra worktrees
└── Nexus Hub/                                                ← workspace docs root
    ├── docs/DOCS_INDEX.md
    ├── docs/agent/OPERATING_CONTEXT.md
    ├── docs/release/CURRENT_RELEASE_STATE.md
    ├── docs/release/feature-delivery-ledger.md      ← canonical "what's shipped"
    ├── docs/release/worktree-recovery-audit-2026-05-18.md
    ├── docs/agents/handoff-template.md              ← session-end boilerplate
    ├── docs/agents/handoffs/                        ← session handoff files
    └── worktrees/                                   ← some backend feature worktrees live here
```

The backend repo is the source-of-truth for backend code. `Nexus Hub/` (workspace) is the source-of-truth for cross-repo docs, the feature ledger, and agent handoffs.

---

## 3. Must-read bootloader docs (in this order)

Read before any code or markdown changes:

1. `/Users/felipedominguez/Desktop/Nexus Hub/docs/DOCS_INDEX.md` — workspace docs index
2. `/Users/felipedominguez/Desktop/Nexus Hub/docs/agent/OPERATING_CONTEXT.md` — agent ground rules
3. `/Users/felipedominguez/Desktop/Nexus Hub/docs/release/CURRENT_RELEASE_STATE.md` — narrative prod truth
4. `/Users/felipedominguez/Desktop/Nexus Hub/docs/release/feature-delivery-ledger.md` — THE registry: what's shipped, who owns it, what tests cover it
5. `/Users/felipedominguez/Desktop/Nexus Hub/docs/release/worktree-recovery-audit-2026-05-18.md` — what got cleaned up and preserved
6. **Most-recent file under `/Users/felipedominguez/Desktop/Nexus Hub/docs/agents/handoffs/`** — previous agent's session handoff, with pending follow-ups and first-3-actions
7. Backend `CLAUDE.md` — repo-local bootloader
8. iOS `AGENTS.md` — repo-local bootloader for iOS
9. Backend `docs/release/current-release-index.md` (per-repo) — per-release narrative
10. Backend `docs/qa/QA_BACKEND_REPORT.md` — last QA verdict

---

## 4. Architecture snapshot

**Backend** (`cortex-telegram-hub-bot`):
- Node.js 20+, TypeScript, CommonJS
- Grammy (Telegram bot composition)
- Express REST API for iOS under `/api/v1/*`
- SQLite via `better-sqlite3`
- pino logger, PM2 process manager
- AI: Gemini primary (`@google/genai`), Anthropic fallback (`@anthropic-ai/sdk`), OpenAI as second fallback. Routing in `src/config.ts > providerRouting` per task type.
- Python FastAPI content engine subprocess at `content-engine/`, ports 8100/8101
- Production: single Linux VPS at `dominguez@serverdominguez`
- HTTPS via Cloudflare Tunnel at `api.nexushub.me`

**iOS** (`Nexus Hub`):
- Swift 5.9, SwiftUI, iOS 17+
- `@Observable`, URLSession async/await
- No third-party deps
- Xcode project uses `PBXFileSystemSynchronizedRootGroup` (folder-driven — new files in the right folder auto-discover)

**Domains**: secretary, training (triathlon — gym/run/cycle/swim), content, finance, cooking, plus skills like decision-center, notifications, connections.

---

## 5. Critical rules — never break

- **Token-zero data reads.** Pure lookups (list tasks, get calendar, fetch readiness) go through REST routes under `/api/v1/`, NOT through chat. If you find yourself adding `chatViewModel.sendMessage()` for a data read, stop.
- **Gemini-first, Anthropic-fallback.** Use `getActiveProvider()` or `completeOneShotWithFallback()`. Don't hardcode model names in new code.
- **OAuth token cache.** `oauth-store.getTokens()` is cached for 10 min. Call `storeTokens()` or `disconnectProvider()` to invalidate.
- **Garmin auth safety.** `keepAlive()` must NEVER call `attemptReLogin()` — triggers MFA emails. Full login is gated behind `serializedAuthRecovery` with a 15-min cooldown.
- **External APIs ALWAYS mocked in tests.** Tests that hit real network fail CI.
- **No real secrets in tests or commits.** Pre-commit `detect-secrets` enforces.
- **Migration numbering.** Pick the next free numeric prefix. The boot-time `assertNoUnexpectedMigrationPrefixCollisions` at `src/services/database.ts:53` throws on collisions. Check sibling worktrees before claiming a number.
- **No `--amend` or `--no-verify` without explicit user approval.**
- **No production promote without explicit user authorization.** `promote-to-prod.sh` has a `type YES to confirm` gate. Don't pipe `echo YES` without owner authorization for that specific deploy.
- **Preserve work before cleanup.** Don't delete branches/remotes/worktrees without explicit approval. The 2026-05-18 worktree cleanup intentionally preserved branches and remotes; that policy stands.

---

## 6. Current worktree state (post-cleanup 2026-05-18)

Only active worktrees remain. All older, archive-only, and prod-shipped worktrees were removed after preservation. Branches and remotes were intentionally preserved.

**Backend** (`git worktree list`):

| Path | Branch | HEAD |
|---|---|---|
| `cortex-telegram-hub-bot/` | `main` | `a8fce8fe` (BEHIND `origin/main`) |
| `cortex-telegram-hub-bot-test-infra/` | `feat/test-infra-scoped-runner` | `ad52c95a` |
| `cortex-telegram-hub-bot-training-google-validation/` | `codex/training-google-validation` | `f1247c8c` |
| `Nexus Hub/worktrees/home-perf-engine/` | `fix/home-perf-pre-wave1-2026-05` | `583865d1` |
| `Nexus Hub/worktrees/training-revamp-engine-codex/` | `feature/training-revamp-engine-codex-20260516` | `65ddf2bf` |

**iOS** (`git worktree list`):

| Path | Branch | HEAD |
|---|---|---|
| `Nexus Hub IOS/Nexus Hub/` | `main` | `e3908cc` |
| `Nexus Hub IOS/Nexus Hub-test-infra/` | `feat/test-infra-scoped-runner` | `63b6bef` |
| `Nexus Hub IOS/worktrees/batch17-n2/` | `feature/tech-debt-2026-05-n2-content-xcuitest-pack` | `69f409c` |
| `Nexus Hub IOS/worktrees/home-perf-ios/` | `fix/home-perf-pre-wave1-2026-05` | `b69a0ce` |
| `Nexus Hub IOS/worktrees/skill-hardening-ios-codex/` | `feature/skill-hardening-ios-codex-20260517` | `c17b785` |
| `Nexus Hub IOS/worktrees/training-revamp-ios-codex/` | `feature/training-revamp-ios-codex-20260516` | `d077a07` |

---

## 7. Current feature ledger truth

The Home Orchestration Focus rollout is **shipped to production** as of `4.14.169`.

Rows currently `in_prod` (5 promoted in this push):
- `decision_streak_v1`
- `home_day_dial_v1`
- `home_focus_pill_v1`
- `provider_preferences_v1`
- `secretary_orchestration_snapshot_v1`

Plus the four earlier Phase 16 rows already `in_prod`. Ledger status counts: `in_prod: 9, in_worktree: 0, in_staging: 0`.

Source of truth: `/Users/felipedominguez/Desktop/Nexus Hub/docs/release/feature-delivery-ledger.md`.

---

## 8. The test-infra scoped runner — IMPORTANT framing

There's a "scoped test runner" infrastructure plan that **landed on `feat/test-infra-scoped-runner` but is NOT yet merged to either repo's `main`**. Felipe's #1 recommended priority is to "merge or archive" this work.

**What lives on `feat/test-infra-scoped-runner` (and works there):**

Backend (`ad52c95a`):
- `scripts/changed-area-classifier.sh` — git-diff → JSON describing vitest globs, XCTest classes, migration-prefix collisions
- `scripts/worktree-inventory.sh` — list worktrees by age + merge state (`--stale`, `--prune-merged`, `--json`)
- `scripts/gate-dashboard-parity.sh` — local-vs-`origin/main` cannot-skip gate count comparison
- `scripts/cannot-skip-gate-dashboard.sh` — backbone of the per-PR gate count
- `docs/release/feature-delivery-ledger.md` (mirror of workspace ledger)
- `docs/agents/handoff-template.md` (mirror of workspace template)
- `docs/agents/handoffs/` (mirror — seed entry written)
- `CLAUDE.md` updated to point new agents at the ledger + most-recent handoff

iOS (`63b6bef`):
- `scripts/ios-changed-area-runner.sh` — reads backend classifier, builds `xcodebuild -only-testing:` args, invokes the single-simulator runner. Last-green cache at `~/.cache/nexus-ios-last-green/`.
- `scripts/ios-single-simulator-test.sh` — per-worktree `simctl clone` (e.g., `iPhone 17 Pro — <worktree-slug>`). Two worktrees can run `xcodebuild test` concurrently without contention. Opt out with `IOS_SIM_PER_WORKTREE=0`.
- `.husky/pre-commit` — invokes the focused runner. Escape hatches: `NEXUS_IOS_FOCUSED=0`, `NEXUS_IOS_NO_CACHE=1`, `NEXUS_IOS_PRECOMMIT_SKIP=1`.
- `AGENTS.md` updated similarly to backend `CLAUDE.md`.

**What lives on `origin/main` of each repo today:**

Backend `origin/main` (`ee780102`):
- Does NOT have `worktree-inventory.sh`, `gate-dashboard-parity.sh`, `changed-area-classifier.sh`
- Does NOT have a backend mirror of `feature-delivery-ledger.md`
- Does NOT have a backend `handoff-template.md` or `handoffs/` directory
- These are all on `feat/test-infra-scoped-runner` waiting to merge

iOS `origin/main` (`e3908cc`):
- DOES have `scripts/ios-single-simulator-test.sh`, `scripts/ios-ui-suite-chunked-test.sh`
- Does NOT have `ios-changed-area-runner.sh` or `.husky/`

**Practical implication for a new agent:**

- If you're working from `main` on either repo, the scoped-runner scripts are not available. Use full-suite verification (`npm run verify`, full `xcodebuild test`).
- If you attach to `feat/test-infra-scoped-runner`, the full kit works and the focused-test cadence applies.
- Before designing significant new work, raise with Felipe whether to merge or archive the test-infra branch — it determines which tooling assumptions are safe to bake in.

---

## 9. Deploy pipeline (validated promote)

Production deploys run from Felipe's Mac. GitHub Actions cannot reach the VPS.

```bash
# 1. Ship to staging on :8201
./scripts/deploy-staging.sh

# 2. Let staging soak (5 min minimum)

# 3. Run smoke tests (writes evidence JSON to docs/release/smoke-evidence/)
./scripts/staging-smoke.sh

# 4. Promote to prod — asks for "type YES to confirm" before running deploy.sh
./scripts/promote-to-prod.sh

# 5. Verify production
curl -s https://api.nexushub.me/health
```

`scripts/deploy.sh` exists for trivial hotfixes but the default is always promote-to-prod.

**Production promotes require explicit Felipe authorization.** Never bypass the YES gate. Never auto-promote.

---

## 10. Standard workflow loop

1. **Read the bootloader docs** (section 3 above).
2. **`grep` the feature ledger** for your task's surface. If a row says `in_worktree` owned by another branch, surface the overlap to Felipe before forking new code.
3. **Attach to an existing worktree or create a new one** with name `feat/<slug>` / `fix/<slug>` / `qa/<slug>`. Don't commit directly to `main` for non-trivial work.
4. **Refresh local `main`** if working from the backend — `git fetch origin && git rebase origin/main` on your feature branch before starting. Local `main` is stale.
5. **Write the change.** Read 1-2 neighboring files first to match existing patterns.
6. **Verify**:
   - Backend: `npm run typecheck && npm run verify`
   - iOS: `xcodebuild test` (focused via `-only-testing:` if you know your area; otherwise the chunked suite)
7. **Update the feature ledger** for any flag you touched.
8. **Commit per convention**: `type(scope): description`. Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `perf`, `qa`.
9. **Write the handoff doc at session end** at `/Users/felipedominguez/Desktop/Nexus Hub/docs/agents/handoffs/<YYYY-MM-DD>-<slug>.md` using `handoff-template.md`.
10. **Surface to Felipe for prod promote.** Don't auto-promote.

---

## 11. Verification commands

```bash
# Backend (from any worktree)
npm run typecheck
npm run verify                                         # vitest --changed origin/main (fast); --full for everything
npm run docs:audit                                     # markdown hygiene

# iOS — from the iOS main worktree (origin/main scripts only)
xcodebuild -scheme "Nexus Hub" -destination "platform=iOS Simulator,name=iPhone 17 Pro" build
scripts/ios-single-simulator-test.sh                   # full suite, single sim
scripts/ios-ui-suite-chunked-test.sh                   # chunked full UI suite

# iOS — from feat/test-infra-scoped-runner worktree (focused runner available)
scripts/ios-changed-area-runner.sh                     # focused per-diff
IOS_RUNNER_DRY_RUN=1 scripts/ios-changed-area-runner.sh  # print what it would run
NEXUS_IOS_FOCUSED=0 scripts/ios-changed-area-runner.sh   # full suite escape hatch

# Backend — from feat/test-infra-scoped-runner worktree (extra scripts available)
bash scripts/changed-area-classifier.sh --json --files <path1>,<path2>
bash scripts/cannot-skip-gate-dashboard.sh --json --no-evidence
bash scripts/worktree-inventory.sh --stale
bash scripts/gate-dashboard-parity.sh
```

Quick sanity check before doing any work:

```bash
git worktree list
git status --short --branch
git log -5 --oneline
```

---

## 12. Where to write things — drift prevention

| Concern | Canonical location |
|---|---|
| What feature flags exist + status | `docs/release/feature-delivery-ledger.md` (workspace) |
| Current production state | `docs/release/CURRENT_RELEASE_STATE.md` (workspace) + `docs/release/current-release-index.md` (per-repo) |
| Per-phase QA evidence | `docs/release/eval-evidence/phase-<NN>-*.md` (per-repo) |
| Per-deploy smoke evidence | `docs/release/smoke-evidence/staging-smoke-<sha>-<timestamp>.json` (backend) |
| Session handoff | `docs/agents/handoffs/<YYYY-MM-DD>-<slug>.md` (workspace) |
| Worktree audit/cleanup record | `docs/release/worktree-recovery-audit-<date>.md` + `artifacts/` (workspace) |
| Operating principles | `CLAUDE.md` (backend), `AGENTS.md` (iOS), workspace `docs/agent/OPERATING_CONTEXT.md` |

Don't create new scattered "final report" docs. Link new evidence from the relevant existing index doc.

---

## 13. Key backend files to know

| File | Purpose |
|---|---|
| `src/config.ts` | All env vars, provider routing, feature flags |
| `src/services/provider-registry.ts` | Per-task primary/fallback provider init |
| `src/services/gemini-provider.ts` | Gemini SDK wrapper + `completeOneShotWithFallback` |
| `src/services/anthropic.ts` | Anthropic SDK wrapper (fallback path) |
| `src/services/oauth-store.ts` | Encrypted token storage + LRU cache |
| `src/services/garmin.ts` | Garmin integration (MFA-aware, rate-limited) |
| `src/services/database.ts:53` | `assertNoUnexpectedMigrationPrefixCollisions` |
| `src/services/runtime-flags.ts` | Feature flag source — should match the workspace ledger |
| `src/services/scheduler.ts` | All cron jobs |
| `src/api/routes/*.ts` | iOS REST endpoints (token-zero) |
| `src/portal/server.ts` | Admin dashboard + OAuth callbacks |
| `src/utils/request-context.ts` | AsyncLocalStorage for `reqId` |

---

## 14. Recommended next priorities (from Felipe, 2026-05-18)

1. **Merge or archive the test-infra scoped runner first** — Backend `feat/test-infra-scoped-runner` + iOS `feat/test-infra-scoped-runner`. Until this decision is made, the focused-test cadence is not available on `main`.
2. **Reconcile training work** — Backend `feature/training-revamp-engine-codex-20260516` + dirty candidate `codex/training-google-validation` + iOS `feature/training-revamp-ios-codex-20260516`.
3. **Review smaller remaining candidates** — home-perf pair (backend + iOS), iOS content XCUITest pack (`batch17-n2`), iOS skill-hardening finance/training follow-up.

---

## 15. First 3 actions for a fresh agent

1. Run `git worktree list && git status --short --branch && git log -5 --oneline` in whichever repo you're picking up.
2. Read the bootloader docs (section 3 above), in order. Pay special attention to the most-recent handoff at `/Users/felipedominguez/Desktop/Nexus Hub/docs/agents/handoffs/`.
3. `grep` the feature ledger for your task surface. Surface any conflict with an `in_worktree` row to Felipe before forking new code.

---

## 16. Style + brevity

- Default to writing no comments. Add one only when the WHY is non-obvious.
- Don't reference the current task in code comments (rots).
- Lead with the verdict; details follow.
- Use `file_path:line_number` for code citations.
- One sentence per status update is almost always enough.
- Never use `--no-verify` or `--amend` without explicit user authorization.
- Never push to `main` or run `promote-to-prod.sh` without explicit user authorization.

---

Acknowledge you've read this, then ask Felipe what task to pick up. If walking into a specific QA or feature handoff, read the most-recent file under `docs/agents/handoffs/` first.
