# Feature Delivery Ledger

> **Canonical "what's shipped, who owns it, what tests cover it" registry.** Agents working in worktrees consult this BEFORE starting work and update it on delivery. Pre-commit nudges + a vitest consistency test (`__tests__/scripts/feature-ledger-consistency.test.ts`) keep it from rotting.
>
> Last reviewed: 2026-05-18. Schema version: 1.

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
| `chat_response_blocks` | Typed responseBlocks envelope (Phase 16) | in_prod | main | 4.14.165 | [4d11852e](https://github.com/owner/repo/commit/4d11852e), [121fc487](https://github.com/owner/repo/commit/121fc487) | `chat-response-blocks.test.ts`, `ChatResponseBlockPresentationTests` | docs/release/eval-evidence/phase-16-catalog-snapshot.md | 2026-05-17 | iOS renderer hardened in Batch 88. Five-layer markdown defense. |
| `chat_response_cards` | Typed responseCards envelope (Phase 16) | in_prod | main | 4.14.165 | [4d11852e](https://github.com/owner/repo/commit/4d11852e) | `chat-response-cards.test.ts` | docs/release/eval-evidence/phase-16-catalog-snapshot.md | 2026-05-17 | 15 card kinds defined; refusal/clarification/confirmation emitting today. Others light up as executors migrate. |
| `decision_streak_v1` | Decision Center streak gamification (Home Orchestration Focus) | in_worktree | codex/home-orchestration-focus | — | [07139505](https://github.com/owner/repo/commit/07139505) | `home-orchestration-focus.test.ts` (decision rollup blocks), classifier maps to `NotificationDecisionCenterUITests` | docs/qa/PHASE_16_CODEX_QA_PROMPT.md, hostile-QA verdict 2026-05-18 | 2026-05-18 | Hostile-QA found currentStreakDays capped at 14 + bestStreakDays missing gap-day reset. Both fixed in 07139505 (walk full clearedByDate; contiguous date range with break-on-gap). |
| `home_day_dial_v1` | 24-hour day dial with Apple Health sleep (Home Orchestration Focus) | in_worktree | codex/home-orchestration-focus | — | original Codex commit + Claude's iOS fix `20cb9d3` | `HomeWeekNavigationPerformanceUITests`, `AppShellVisualSnapshotUITests`, `HealthDaySnapshotPayloadTests`, `home-orchestration-focus.test.ts` | docs/release/phase-17-claude-hostile-qa.md | 2026-05-18 | Hostile-QA found fractional-seconds ISO parser bug breaking the ring layout. Fixed in `20cb9d3` (DayDialIsoTimestamp helper with two-formatter fallback). |
| `home_focus_pill_v1` | Horizontal Home quick-action pill + Focus/Pomodoro (Home Orchestration Focus) | in_worktree | codex/home-orchestration-focus | — | original Codex commit + Claude's calendar/idempotency fix `07139505` | `home-orchestration-focus.test.ts` (Pomodoro math + conflict-precheck blocks), classifier maps to Home UI tests | docs/qa/PHASE_16_CODEX_QA_PROMPT.md | 2026-05-18 | Hostile-QA found: 404→403 semantics for flag-disabled; idempotency on POST /focus-blocks; provider-error try/catch wrapping createEvent. All fixed in 07139505. |
| `provider_preferences_v1` | Explicit Gmail-mail vs Google Calendar separation (Home Orchestration Focus) | in_worktree | codex/home-orchestration-focus | — | `07139505` | `home-orchestration-focus.test.ts` (preference + warning-code blocks), `__tests__/api/settings-routes.test.ts` | docs/qa/PHASE_16_CODEX_QA_PROMPT.md | 2026-05-18 | Hostile-QA found: tenantId not passed to resolveCalendarWritePreference/resolveMailReadPreference; cross-tenant users got the default. Fixed in 07139505 across calendar.ts (3 sites) and notifications.ts (2 sites). |
| `secretary_orchestration_snapshot_v1` | Secretary all-clear gate honors task/provider/calendar truth (Home Orchestration Focus) | in_worktree | codex/home-orchestration-focus | — | `07139505` | `home-orchestration-focus.test.ts` (secretary-summary blocks) | docs/qa/PHASE_16_CODEX_QA_PROMPT.md | 2026-05-18 | Hostile-QA P0 found gating INVERTED — flag=false forced 'ready' status, making rollback lie. Fixed in 07139505. Plus 'stale' state propagation through dashboard. |
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

- `in_prod`: 4
- `in_worktree`: 5
- `in_staging`: 0
- `planned`: 0
- `deprecated`: 0

## Schema version history

- **1** (2026-05-18): initial schema. Markdown table, 10 columns. Sort by `flag` alphabetically.
