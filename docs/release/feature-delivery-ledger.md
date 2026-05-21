# Feature Delivery Ledger

> **Canonical "what's shipped, who owns it, what tests cover it" registry.** Agents working in worktrees consult this BEFORE starting work and update it on delivery. Pre-commit nudges + a vitest consistency test (`__tests__/scripts/feature-ledger-consistency.test.ts`) keep it from rotting.
>
> Last reviewed: 2026-05-21. Schema version: 1.

## How to use this ledger

**Before starting work** — `grep` for the feature surface you're about to touch. If a row says `in_worktree` owned by another branch, surface the overlap to the user before forking new code. If `in_prod`, you might be a fast-follow improvement — confirm with the user.

**On delivery to a worktree** — add or update the row with `status: in_worktree`, your branch as owner, the commit shas, and the test classes you added.

**On staging deploy** — flip to `in_staging` and bump `current_version`.

**On production promote** — flip to `in_prod`, set `owner_worktree: main`.

**On deprecation** — set `status: deprecated` and keep the row (history survives).

Statuses: `planned`, `in_worktree`, `in_staging`, `in_prod`, `deprecated`, `retired`.

Sort rule: rows are sorted alphabetically by `flag`. The `scripts/sort-feature-ledger.sh` helper (Phase G follow-up) auto-formats. This minimizes merge conflicts when two worktrees both edit the table.

## Ledger

| flag | feature | status | owner_worktree | current_version | commits | tests | evidence | last_verified | notes |
|---|---|---|---|---|---|---|---|---|---|
| `beta_registry_v1` | Public beta registry double opt-in, MX/disposable validation, 30-day invite email approval, DB invite redemption, and static reviewer-code expiry policy | in_prod | main | 4.14.171 | [0df40622](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/0df40622), [1587fc5d](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/1587fc5d) | `waitlist-routes.test.ts`, `portal-waitlist-routes.test.ts`, `email-sender.test.ts`, `user-service.test.ts`, auth/entitlement coverage | docs/release/smoke-evidence/staging-smoke-0df40622-20260518T194531Z.json | 2026-05-18 | Backend routes/env are live in production. Cloudflare Pages direct upload is still pending because this shell has no `CLOUDFLARE_API_TOKEN`; live `nexushub.me` remains on the previous static page until that deploy runs. |
| `chat_response_blocks` | Typed responseBlocks envelope (Phase 16) | in_prod | main | 4.14.165 | [4d11852e](https://github.com/owner/repo/commit/4d11852e), [121fc487](https://github.com/owner/repo/commit/121fc487) | `chat-response-blocks.test.ts`, `ChatResponseBlockPresentationTests` | docs/release/eval-evidence/phase-16-catalog-snapshot.md | 2026-05-17 | iOS renderer hardened in Batch 88. Five-layer markdown defense. |
| `chat_response_cards` | Typed responseCards envelope (Phase 16) | in_prod | main | 4.14.165 | [4d11852e](https://github.com/owner/repo/commit/4d11852e) | `chat-response-cards.test.ts` | docs/release/eval-evidence/phase-16-catalog-snapshot.md | 2026-05-17 | 15 card kinds defined; refusal/clarification/confirmation emitting today. Others light up as executors migrate. |
| `decision_streak_v1` | Decision Center streak gamification (Home Orchestration Focus) | in_prod | main | 4.14.169 | [07139505](https://github.com/owner/repo/commit/07139505), [a1959d82](https://github.com/owner/repo/commit/a1959d82), [523f0d1b](https://github.com/owner/repo/commit/523f0d1b) | `home-orchestration-focus.test.ts` (decision rollup blocks), classifier maps to `NotificationDecisionCenterUITests` | docs/release/worktree-recovery-audit-2026-05-18.md | 2026-05-18 | Confirmed in production during worktree recovery audit; live backend package version is 4.14.170, and Home Orchestration was promoted in 4.14.169. |
| `home_day_dial_v1` | 24-hour day dial with Apple Health sleep (Home Orchestration Focus) | in_prod | main | 4.14.169 | [07139505](https://github.com/owner/repo/commit/07139505), iOS fix `20cb9d3`, [a1959d82](https://github.com/owner/repo/commit/a1959d82), [523f0d1b](https://github.com/owner/repo/commit/523f0d1b) | `HomeWeekNavigationPerformanceUITests`, `AppShellVisualSnapshotUITests`, `HealthDaySnapshotPayloadTests`, `home-orchestration-focus.test.ts` | docs/release/worktree-recovery-audit-2026-05-18.md | 2026-05-18 | Confirmed in production/source-main during worktree recovery audit; hostile-QA fractional-seconds ISO fix is in iOS main before `e3908cc`. |
| `home_focus_pill_v1` | Horizontal Home quick-action pill + Focus/Pomodoro (Home Orchestration Focus) | in_prod | main | 4.14.169 | [07139505](https://github.com/owner/repo/commit/07139505), [a1959d82](https://github.com/owner/repo/commit/a1959d82), [523f0d1b](https://github.com/owner/repo/commit/523f0d1b) | `home-orchestration-focus.test.ts` (Pomodoro math + conflict-precheck blocks), classifier maps to Home UI tests | docs/release/worktree-recovery-audit-2026-05-18.md | 2026-05-18 | Confirmed in production during worktree recovery audit; live backend package version is 4.14.170, and Home Orchestration was promoted in 4.14.169. |
| `nexus_points_usage_limits_v1` | Nexus Points usage-limit ledger, model-pricing observability, fallback settlement, refund alerts, transfer helper, and deploy provenance guardrails | in_worktree | codex/nexus-points-qa2-hardening | 4.14.179 | [6737cc97](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/6737cc97ec831349647d387a5971c038544f75cb), [2b85f8af](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/2b85f8afecbcb8e13fb334b8975619d62a77b9b0), [51a614a5](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/51a614a57bbafadc378b66e1c109493cd948ebf8) | `cost-validation.test.ts`, `cost-breakdown.test.ts`, `openai-provider.test.ts`, `nexus-points.test.ts`, `billing-routes.test.ts`, `chat-routes.test.ts`, `billing-apple-notifications-jws-verify.test.ts` | docs/release/nexus-points-usage-limits.md | 2026-05-21 | QA2 P2/P3 hardening is implemented and rebased onto production `4.14.179`; staging/prod promotion still requires a clean deploy and explicit Felipe approval. |
| `provider_preferences_v1` | Explicit Gmail-mail vs Google Calendar separation (Home Orchestration Focus) | in_prod | main | 4.14.169 | [07139505](https://github.com/owner/repo/commit/07139505), [a1959d82](https://github.com/owner/repo/commit/a1959d82), [523f0d1b](https://github.com/owner/repo/commit/523f0d1b) | `home-orchestration-focus.test.ts` (preference + warning-code blocks), `__tests__/api/settings-routes.test.ts` | docs/release/worktree-recovery-audit-2026-05-18.md | 2026-05-18 | Confirmed in production during worktree recovery audit; live backend package version is 4.14.170, and Home Orchestration was promoted in 4.14.169. |
| `secretary_orchestration_snapshot_v1` | Secretary all-clear gate honors task/provider/calendar truth (Home Orchestration Focus) | in_prod | main | 4.14.169 | [07139505](https://github.com/owner/repo/commit/07139505), [a1959d82](https://github.com/owner/repo/commit/a1959d82), [523f0d1b](https://github.com/owner/repo/commit/523f0d1b) | `home-orchestration-focus.test.ts` (secretary-summary blocks) | docs/release/worktree-recovery-audit-2026-05-18.md | 2026-05-18 | Confirmed in production during worktree recovery audit; live backend package version is 4.14.170, and Home Orchestration was promoted in 4.14.169. |
| `stripe_web_checkout_v1` | Public website Stripe Checkout for Pro/Max monthly USD/BRL plus webhook idempotency and verified-user checkout claim | in_prod | main | 4.14.171 | [0df40622](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/0df40622), [1587fc5d](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/1587fc5d) | `billing-routes.test.ts`, `public-billing-routes.test.ts`, `stripe-service.test.ts`, Stripe webhook idempotency/claim tests | docs/release/smoke-evidence/staging-smoke-0df40622-20260518T194531Z.json | 2026-05-18 | Backend checkout/webhook/claim routes are live with sandbox Stripe prices: Pro USD `price_1TYUtmEnGIEp1Q5vqsfLN9Ml`, Pro BRL `price_1TYUtnEnGIEp1Q5vMfu5XXt1`, Max USD `price_1TYUtoEnGIEp1Q5vievUfmeu`, Max BRL `price_1TYUtpEnGIEp1Q5vtuAejLdn`. Cloudflare Pages deploy is pending for the visible website CTA. |
| `—` | Spanish locale routing through Telegram + HTTP (Phases 10-15 + Phase 16 batch 80 fix) | in_prod | main | 4.14.165 | Phase 10-15 + `406dd52e` | `chat-locale-detection-es.test.ts` + per-skill ES parser tests | docs/release/eval-evidence/phase-16-batch-80.md | 2026-05-17 | Batch 80 fixed detectLanguageFromTelegram + normalizeLangHeader collapsing es-* to pt-BR, which had silently disabled every Spanish branch added in Phases 10-15 for Telegram users. |
| `—` | Score-based intent picking in parseBroadSkillActionIntent (Phase 16 batch 89) | in_prod | main | 4.14.165 | `121fc487` | `chat-action-planner-score-based-intent.test.ts` | docs/release/eval-evidence/phase-16-catalog-snapshot.md | 2026-05-17 | Slot-completeness tie-break bonus = 0.005 (smaller than smallest inter-skill priority gap of 0.01). Test pins this invariant. |

## Cross-references

- **Backend runtime flags source-of-truth**: [src/services/runtime-flags.ts](../../src/services/runtime-flags.ts). Every `is*Enabled` helper here should have a matching row.
- **iOS feature flag DTO**: [Nexus Hub/Models/ServerStatus.swift](../../../Nexus Hub IOS/Nexus Hub/Models/ServerStatus.swift) — `DashboardFeatureFlags` struct mirrors the backend flags for iOS-side rendering decisions.
- **Classifier mapping**: [scripts/changed-area-classifier.sh](../../scripts/changed-area-classifier.sh) — per-feature `HAS_IOS_*` flags pair with the `tests` column here.
- **Release index**: [docs/release/current-release-index.md](current-release-index.md) — the narrative; this ledger is the structured index.
- **Phase 16 evidence**: [docs/release/eval-evidence/phase-16-catalog-snapshot.md](eval-evidence/phase-16-catalog-snapshot.md).

## Enforcement

`__tests__/scripts/feature-ledger-consistency.test.ts` parses this markdown and asserts:

1. Every feature flag declared in `src/services/runtime-flags.ts` has a matching row (warning, not failure — to allow staged rollout).
2. Every row's `tests` field references test classes/globs that exist on disk.
3. Every `in_prod` row's `current_version` is `≤` the live `package.json` version.
4. Every commit SHA in the `commits` column resolves via `git cat-file -e`.

Pre-commit nudges agents who touch `runtime-flags.ts` without updating this file. Soft warning, not blocking — emergency hotfixes still ship.

## Status counts (auto-update on next ledger edit)

- `in_prod`: 11
- `in_worktree`: 1
- `in_staging`: 0
- `planned`: 0
- `deprecated`: 0

## Schema version history

- **1** (2026-05-18): initial schema. Markdown table, 10 columns. Sort by `flag` alphabetically.
