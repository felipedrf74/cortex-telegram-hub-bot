# Secretary Reasoning + Orchestration Wave 1 — Claude Hostile QA

**Date**: 2026-05-13
**Validated worktree**: `/Users/felipedominguez/Desktop/Nexus Hub/worktrees/engine-secretary-reasoning`
**Branch**: `feature/secretary-reasoning-orchestration-2026-05`
**Plan**: `/Users/felipedominguez/.claude/plans/graceful-stirring-scone.md` (Wave 1.5 section)
**Companion report**: `docs/_workspace-mirror/docs/release/secretary-reasoning-wave1-validation.md` (Codex's prior hostile pass, GO_WITH_CONDITIONS)

## Verdict

**GO_WITH_CONDITIONS.**

The Wave 1 plan and the post-closeout Wave 2 backfill (Cooking / Finance /
Content consumers, full Training/Cooking/Finance/Content preview adoption,
C6 staleness degradation, M9 Telegram `↪` marker, M5 recipe wiring) are
**source-verified** and **behavior-tested**. The 20-file focused vitest
sweep passes 199/199 (six more than the dossier's 193). All 15 hostile
probes return the expected result. No tenant-isolation regression. No
reasoning-trail PII leak. No Codex-lane violation. `tsc --noEmit` clean.
`docs:audit` exit 0.

The single blocker before remote handoff is **mergeability**: the entire
Wave 2 closure pass (24 modified + 5 untracked = 29 files, +978 / −115
LoC) is sitting **uncommitted** on the worktree. `git log` shows zero
commits past my Wave 1 closeout dossier commit `c8dc4411`. Nothing is
pushed.

## Conditions before merge

1. **Commit the uncommitted closure pass** as 1–3 focused commits
   (suggested split: `feat(secretary): W-B Cooking/Finance/Content
   consumers + tenant-scoped feedback sink`, `feat(secretary): C1 preview
   adoption across Cooking/Finance/Content + recipe wiring`, and
   `feat(secretary): C6 staleness degradation + M9 ↪ day-overview
   marker`). Each must keep the pre-commit hook gate intact.
2. **Add the two minor test gaps** the audit found:
   - `decision-center-secretary-trail.test.ts` covers `>60min` staleness
     but not `>15min`. Source has both branches at
     `src/services/decision-center-logic-v2.ts:678-679`. One test case
     would close the gap.
   - `training-secretary-feedback-consumer.test.ts` covers
     `compressed` only; the source already handles `reflowed`,
     `unscheduled`, `deferred`, and `needs_more_context` at
     `src/services/training-secretary-feedback-consumer.ts:134-137`.
     Three additional cases would close the gap.
   - Optional: a rendering smoke test for the `↪` marker
     (`secretary-helpers.ts:377-403`).
   - Optional: a recipe-integration assertion that
     `secretaryAnchoredSafePreviewBody` actually produces an anchored
     copy (the current test asserts shape, not provenance).

After (1) and (2) (mandatory) + optional probes (1-3 days of test work),
this is ready to rebase against `origin/main` and hand off to Codex for
final cross-stream merge validation.

## Phase A — Canonical gate (all green)

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | PASS (exit 0) |
| Focused 20-file vitest sweep | **199/199 passing** (6 more than dossier) |
| Codex-untouched grep | PASS (empty diff) |
| `npm run docs:audit` | PASS (exit 0; ≤480 issue ceiling held) |

Files in the focused sweep:

```
__tests__/services/secretary-reason-codes.test.ts              (8)
__tests__/services/secretary-feedback-bus.test.ts              (5)
__tests__/services/secretary-scheduling-arbitrator.test.ts     (11)
__tests__/services/secretary-scheduling-preview.test.ts        (5)
__tests__/services/secretary-priority-weighting.test.ts        (7)
__tests__/services/secretary-reasoning-trail.test.ts           (7)
__tests__/services/secretary-reasoning-trail-formatter.test.ts (6)
__tests__/services/secretary-apns-anchoring.test.ts            (9)
__tests__/services/secretary-agenda-provider-sync.test.ts      (13)
__tests__/services/scheduler-secretary-agenda-sync.test.ts     (5)
__tests__/services/decision-center.test.ts                     (34)
__tests__/services/decision-center-secretary-trail.test.ts     (4)
__tests__/services/decision-center-logic-v2.test.ts            (19)
__tests__/services/coach-kernel-decision-trail.test.ts         (4)
__tests__/services/coach-kernel-secretary-weekly-summary.test.ts (9)
__tests__/services/training-secretary-feedback-consumer.test.ts (2)
__tests__/services/secretary-source-skill-feedback-consumers.test.ts (5)
__tests__/api/decisions-routes.test.ts                          (5)
__tests__/api/content-admin-write-auth.test.ts                  (18)
__tests__/api/training-plan-calendar-sync.test.ts               (23)
TOTAL: 20 files / 199 passing
```

## Phase B — Source-claim verification (8 closures, all verified)

| # | Closure | Source evidence | Verdict |
|---|---|---|---|
| B1 | W-B Training feedback consumer | `src/services/training-secretary-feedback-consumer.ts:53-95,118-131` writes to `training_feedback_decisions` with `ON CONFLICT(user_id, tenant_id, agenda_item_id, source_intent_id)` upsert. `feedbackTypeForTrainingFeedback:134-137` and `hintsForTrainingFeedback:142-148` handle all five feedback types (compressed, reflowed, unscheduled, deferred, needs_more_context). | ✓ |
| B2 | W-B Cooking/Finance/Content consumers | `src/services/secretary-source-skill-feedback-consumers.ts:21,45-54` registers all three via loop over `SOURCE_SKILLS`. Writer at `:62-101` writes to `secretary_source_skill_feedback` with 5-tuple dedupe `(user_id, tenant_id, target_skill, agenda_item_id, source_intent_id)`. List path at `:106-118` filters by `WHERE user_id = ? AND tenant_id = ?`. | ✓ |
| B3 | C1 preview adoption across 4 skills | Training at `src/api/routes/training-plan-calendar-sync.ts:568`, Cooking at `src/services/cooking-secretary-integration.ts:31`, Finance at `src/services/finance-secretary-integration.ts:41`, Content at `src/services/content-editorial-workflow.ts:1167`. | ✓ (exceeds Wave 1 plan, which had Training only) |
| B4 | C6 confidence-aware degradation | `src/services/decision-center-logic-v2.ts:669-682` `secretaryConfidenceWithSyncFreshness`: caps confidence at `lowContentMissingEntity` when `ageMinutes > 60`, at `mediumOwnerAdminOps` when `ageMinutes > 15`. Both thresholds present. `providerSyncUpdatedAt` populated end-to-end from `agenda.updatedAt` at `src/services/decision-center.ts:1617` — unknown from initial Explore now RESOLVED. | ✓ |
| B5 | M9 Telegram `↪` marker | `src/handlers/commands/secretary-helpers.ts:377-403` `secretaryMoveMarkersForDay`. Filters by `lifecycleState ∈ ['reflowed', 'compressed']` + day-bound `startAt` + `updatedAt >= now - 24h`. Caps at 3. Format `↪ {time} {title} — {reason}.` with HTML escape on title and reason. Invoked from `handleDayOverview` at line `342`. | ✓ |
| B6 | Migration 126 schema | `migrations/126_secretary_reasoning_trail.sql`: `CREATE TABLE IF NOT EXISTS` for both `training_feedback_decisions` (with composite UNIQUE) and `secretary_source_skill_feedback` (with 5-key UNIQUE). Indexes match query patterns. Idempotent. | ✓ |
| B7 | M2 retry hardening | `src/services/secretary-agenda-provider-sync.ts:213-227` retry loop bounded by `retryBudget` (default 2). `providerRetryDelayMs:478-487` honors explicit `retryAfter`, otherwise exponential `base * (2 ** attempt)` capped at max (250ms → 2000ms). `retryAfterHeader:500-515` parses both numeric seconds and RFC-1123 timestamps from `response.headers` or `error.headers`. | ✓ |
| B8 | M5 recipe wiring | `src/services/decision-center-logic-v2.ts:1065-1090` `secretaryAnchoredSafePreviewBody`: calls `apnsBodyMoved` when `currentStartAt` is present, otherwise `apnsBodyNeedsChoice`. Both anchored to user timezone + locale (`tz`, `lang`). Default duration 45min. Imports at line 10-11. | ✓ |

## Phase C — 15 hostile probes

| # | Probe | Result |
|---|---|---|
| P1 | `providerSyncUpdatedAt` end-to-end populated | ✓ PASS (`decision-center.ts:1617` feeds from `agenda.updatedAt`) |
| P2 | Training consumer handles all 5 feedback types | ✓ PASS (`feedbackTypeForTrainingFeedback:134-137` + `hintsForTrainingFeedback:142-148`) |
| P3 | C6 `>15min` threshold present in source | ✓ PASS (line 679 + line 698 i18n message) |
| P4 | `↪` marker reachable from rendered template | ✓ PASS (`secretary-helpers.ts:397` — invoked by handleDayOverview at line 342) |
| P5 | `apnsBodyMoved` / `apnsBodyNeedsChoice` called from recipe | ✓ PASS (lines 1079, 1089) |
| P6 | Cross-tenant scoping on new tables | ✓ PASS (both tables filter `WHERE user_id = ? AND tenant_id = ?` on SELECT; UNIQUE constraints include `tenant_id`) |
| P7 | Cron retry loop bounded | ✓ PASS (`while (isRetryable(latest) && attempt < retryBudget)` at line 216; retryBudget default 2) |
| P8 | W-E privacy contract still pinned | ✓ PASS (`secretary-reasoning-trail.test.ts` 7/7 passing) |
| P9 | Trail size cap unchanged | ✓ PASS (`REASONING_TRAIL_MAX_NODES = 12` at line 262; `capReasoningTrail` at line 270) |
| P10 | Migration 126 idempotency | ✓ PASS (`sqlite3 :memory:` apply twice — no error) |
| P11 | Pre-commit hook bypass scan | ✓ PASS (no `--no-verify` / `--amend` / `skip-hook` in `git log origin/main..HEAD`) |
| P12 | Cross-tenant Decision Center test | ✓ PASS (`decision-center-secretary-trail.test.ts` 4/4 passing, includes PRIVACY case) |
| P13 | Wave 2 consumers tenant-scoped tests | ✓ PASS (`secretary-source-skill-feedback-consumers.test.ts` 5/5 passing) |
| P14 | `findAgendaItemById` unscoped helper not exported | ✓ PASS (no `export.*findAgendaItemById` match in arbitrator) |
| P15 | Migration 126 prefix uniqueness | ✓ PASS (exactly one `126_*.sql` file; no `127_*.sql`) |

## P0 / P1 findings introduced

### P0 — Mergeability (BLOCKER)

**Finding**: The entire Wave 2 closure pass is uncommitted.
- 24 modified files (production + tests + closeout dossier + migration 126)
- 5 untracked files (2 new production services, 2 new tests, 1 Codex QA report)
- Net diff: **+978 / −115 LoC**
- `git log c8dc4411..HEAD` returns empty.

**Risk**: Nothing to push to remote. Branch advertises 11 commits but the
work that the closeout dossier and the in-tree Codex QA report claim has
landed is not actually committed. Any `git pull --rebase` or fresh clone
will lose it.

**Mechanical fix**: Stage and commit in three focused commits before
remote handoff. Suggested boundaries:

1. `feat(secretary): W-B Cooking/Finance/Content consumers + tenant-scoped feedback sink`
   — new `secretary-source-skill-feedback-consumers.ts` + the migration
   126 second-table addition + its test.
2. `feat(secretary): C1 preview adoption across Cooking/Finance/Content + recipe wiring`
   — `cooking-secretary-integration.ts`, `finance-secretary-integration.ts`,
   `content-editorial-workflow.ts` preview callers + `decision-center-logic-v2.ts`
   recipe wiring + `secretary-apns-anchoring.ts` updates.
3. `feat(secretary): C6 staleness degradation + M9 ↪ day-overview marker`
   — `decision-center-logic-v2.ts` `secretaryConfidenceWithSyncFreshness`
   + `secretary-helpers.ts` move marker + the closeout dossier edit.

The Codex QA report (`docs/_workspace-mirror/docs/release/secretary-reasoning-wave1-validation.md`)
should be relocated from `_workspace-mirror` into `docs/release/`
directly and committed as the canonical Codex hostile-QA evidence.

### P1 — Test coverage gaps

- **C6 staleness only tests >60min branch**. Source has both `>15min`
  (line 679) and `>60min` (line 678). Test
  `decision-center-secretary-trail.test.ts:171-197` only exercises
  >60min. One test case at the 15–60min range would close.

- **Training consumer tests only cover `compressed`**. Source
  (`training-secretary-feedback-consumer.ts:134-137`) handles five
  feedback types; only one is regression-pinned at
  `training-secretary-feedback-consumer.test.ts:77-97`. Three cases for
  `reflowed`, `unscheduled`, `needs_more_context` would close.

### P2 — Rendering / integration test gaps

- **M9 `↪` marker has no rendering test**. The function
  (`secretaryMoveMarkersForDay`) ships, is invoked, returns a string
  containing `↪` — but no test pins the exact output. Suggestion: add a
  `handleDayOverview` smoke that asserts a reflowed-in-past-24h agenda
  item produces a `↪` line.

- **M5 recipe-level test asserts shape, not provenance**. The Secretary
  recipe test asserts the body contains a time pattern, but doesn't pin
  that `apnsBodyMoved` / `apnsBodyNeedsChoice` were the producers. A
  spy-based test would close this.

### P3 — Code hygiene

- **`findAgendaItemById` unscoped helper**. Internal-only and
  always called from already-scoped callers — but a future contributor
  could export it. Suggested rename to `_findAgendaItemByIdUnscopedInternal`
  with a JSDoc tag.

- **Reason hardcoded in EN in M9 marker**. The reason string
  ('compressed to fit capacity', 'moved to a feasible slot', 'adjusted by
  Secretary') at `secretary-helpers.ts:392-396` is hardcoded English.
  Doesn't go through `localizeSecretaryContext`. PT-PT users get a mixed
  rendering. Suggested: thread `user.language` through and add three
  more keys to the M8 sweep.

## Cross-stream coordination

**Codex-untouched grep**: PASS. Zero modifications to:
- `src/services/secretary-fastpath.ts`
- `src/api/routes/chat-message-{routes,local-responses,degraded-response,execution}.ts`
- `src/services/tool-executor.ts`
- `src/services/chat-{answer-contract,grounding-layer,response-quality-gate,skill-capability-registry}.ts`

The branch remains additive over `origin/main`. Safe to rebase whenever
Codex's chat-logic work merges.

## Independent corroboration

Codex ran its own hostile QA on the same state (see
`docs/_workspace-mirror/docs/release/secretary-reasoning-wave1-validation.md`)
and reached **GO_WITH_CONDITIONS** with the same general posture (closures
verified at source; minor conditions before merge). The two passes
converge on the same verdict via independent probe sets.

## Mergeability

**Not yet — fix P0 first.** Once the 29 uncommitted files are split into
3 focused commits, the branch is ready to rebase against `origin/main`
and push.

## Hand-off recommendation

**Ship with conditions.** Commit the closure pass (~30min mechanical
work), add 4 test cases (~1 hour), then rebase and push. Hand off to
Codex one more time for final cross-stream merge validation per the
prompt in `graceful-stirring-scone.md` Codex Handoff section.

---

Generated 2026-05-13 by Claude Opus 4.7 on branch
`feature/secretary-reasoning-orchestration-2026-05`.
