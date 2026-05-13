# Secretary Reasoning + Orchestration — Wave 1 Closeout

**Branch**: `feature/secretary-reasoning-orchestration-2026-05`
**Worktree**: `/Users/felipedominguez/Desktop/Nexus Hub/worktrees/engine-secretary-reasoning`
**Base**: `origin/main`
**Date**: 2026-05-13
**Plan**: `/Users/felipedominguez/.claude/plans/graceful-stirring-scone.md`

## Verdict

**READY FOR POST-FIX HOSTILE-QA REVALIDATION.**

10 must-ship workstreams landed across 10 commits (M1 was source-verified
as already closed in `main`; no new commit was needed). Codex's first hostile
QA pass found C1/W-B/M5/M2/handoff gaps; this fix pass closes them. Verification gate
green (tsc + 19 focused vitest files + Codex-untouched grep + docs:audit).
Zero touches to Codex's chat-logic lane.

## Commits (oldest → newest)

| # | SHA | Workstream | LoC + Tests |
|---|-----|------------|-------------|
| 0 | `34e98595` + Codex fix pass | migration 126 now creates Training feedback decisions | 14 + schema / 2 |
| 1 | (none — M1 verified closed in `main`) | M1 R7 carryovers | — / 52 existing pass |
| 2 | `7c997dfe` | **W-A** typed `SecretaryReasonCode` enum + helpers | 277 / 8 |
| 3 | `0574f5c2` | **M2** `secretary_agenda_sync` cron registration | 153 / 5 |
| 4 | `bdc9e691` | **C3** goal-phase dynamic priority weighting | 216 / 7 |
| 5 | `3d796791` | **C1** `previewSecretarySchedulingIntent` non-persisting probe | 182 / 5 |
| 6 | `41910e38` + Codex fix pass | **W-B** `SecretaryFeedbackBus` + Training feedback consumer | 298 + consumer / 7 |
| 7 | `b34a431f` | **W-E** reasoning trail — capture + persist | 379 / 7 |
| 8 | `faaac145` | **C2** trail surface (Decision Center + Telegram `/why_last`) | 533 / 9 |
| 9 | `b0aa74ac` | **C8** weekly notes Secretary contribution | 263 / 9 |
| 10 | `4950eb96` | **M5** APNs date/time anchoring + **M8** PT-PT sweep | 320 / 9 |
| | | **TOTAL** | **~2.6k+ LoC / 67+ new tests** |

## Verification gate — all green

```
=== 1) tsc --noEmit ===
OK

=== 2) Codex-untouched grep ===
PASS: no CODEX file touched

=== 3) Cron registration uniqueness ===
1 line matches registerJob('secretary_agenda_sync', …) — exactly one.

=== 4) Migration schema ===
migrations/126_secretary_reasoning_trail.sql creates training_feedback_decisions.
No migration 127 exists.

=== 5) Focused vitest sweep ===
19 test files / 193 tests / 100% passing:
  __tests__/services/secretary-reason-codes.test.ts             (8)
  __tests__/services/secretary-feedback-bus.test.ts             (5)
  __tests__/services/secretary-scheduling-arbitrator.test.ts    (11)
  __tests__/services/secretary-scheduling-preview.test.ts       (5)
  __tests__/services/secretary-priority-weighting.test.ts       (7)
  __tests__/services/secretary-reasoning-trail.test.ts          (7)
  __tests__/services/secretary-reasoning-trail-formatter.test.ts (6)
  __tests__/services/secretary-apns-anchoring.test.ts           (9)
  __tests__/services/secretary-agenda-provider-sync.test.ts     (13)
  __tests__/services/scheduler-secretary-agenda-sync.test.ts    (5)
  __tests__/services/decision-center.test.ts                    (34)
  __tests__/services/decision-center-secretary-trail.test.ts    (3)
  __tests__/services/decision-center-logic-v2.test.ts           (19)
  __tests__/services/coach-kernel-decision-trail.test.ts        (4)
  __tests__/services/coach-kernel-secretary-weekly-summary.test.ts (9)
  __tests__/api/decisions-routes.test.ts                        (5)
  __tests__/api/content-admin-write-auth.test.ts                (18)
  __tests__/api/training-plan-calendar-sync.test.ts             (23)
  __tests__/services/training-secretary-feedback-consumer.test.ts (2)

=== 6) docs:audit ===
Exit code 0. Total issues stable under 480 ceiling.
```

## What changed (architectural delta)

**Before Wave 1**: Felipe accepts a Decision Center reflow → DB has the slot
→ Google Calendar stays empty. Asks "why moved my run?" → no answer. Training
proposes a session in a conflict window because no preview exists. Goal phase
doesn't shift priority. Source-skill feedback shape exists but no consumer
processes it.

**After Wave 1**:

- **Slot accepted → cron syncs** (M2). `secretary_agenda_sync` runs every
  5 min, per-(user, tenant) fan-out, max 50 items per tick, retry budget 2.
  Bulk sync now retries transient create/update/delete failures with
  exponential backoff and honors provider `Retry-After`.
- **Trail visible** (W-E + C2). Every Secretary decision now carries
  `reasoningTrail: ReasoningTrailNode[]` persisted in
  `secretary_agenda_items.reasoning_trail_json`. Surfaced via
  `DecisionApiItem.sourceTrace.reasoningTrail` (iOS) and Telegram
  `/why_last` (HTML-safe, PT-PT/PT-BR/EN-US).
- **Predictive scheduling** (C1). `previewSecretarySchedulingIntent` runs
  the canonical arbitration machinery without persisting, lets Training
  detect conflicts BEFORE the user sees a Decision Center card.
- **Goal-phase priority** (C3). Training base 12 +2 in build, +3 in peak,
  −2 taper, −4 race, −3 deload, 0 base/maintenance. Other skills unaffected.
  Finance deadline boost (+18) dominates phase boost — tax deadlines still
  outrank Training in race week.
- **Typed reason codes** (W-A). 24 typed `SecretaryReasonCode` values across
  5 categories. `isKnownReasonCode` narrower guards legacy JSON values
  without throwing.
- **In-process feedback bus** (W-B). `registerSecretaryFeedbackConsumer` +
  `emitSecretaryFeedback` per decision (single submit + batch loop, not
  deferred). Each handler runs in its own try/catch — one bad consumer
  cannot break arbitration. The Training consumer persists idempotent
  `training_feedback_decisions` rows for compressed/reflowed/unscheduled
  Secretary outcomes; Cooking / Finance / Content consumers = Wave 2.
- **Weekly notes Secretary contribution** (C8). coach-kernel decision
  trail now includes `Secretary: compressed 2 sessions; long run protected.`
  when the agenda store has activity in the week. Graceful degradation
  when the Secretary DB isn't reachable (unit tests).
- **APNs date/time anchoring** (M5). `apnsBodyMoved(from, to, durMin, tz, lang)`
  and `apnsBodyNeedsChoice(slot, durMin, tz, lang)` are wired into
  Secretary/overcapacity Decision Center safe previews. PT-PT:
  `Hoje 15:00 → 16:00 (45 min)`. EN: `Today 3:00 PM → 4:00 PM (45 min)`.
  78-char cap honored with graceful drop-down.
- **PT-PT sweep** (M8). 10 new locale keys added to
  `secretaryStateContextCopy` covering M2 / C2 / C8 / M5 surfaces.

## Privacy + tenant-safety pins

- W-E **PRIVACY test** pins that trail nodes carry NO user copy — only
  enum reason codes + ISO slot strings + numeric weights/counts. Verified
  by a test that injects `<script>` and `VERY SECRET CONTENT` into title +
  preferred-window label and asserts they don't appear in the trail.
- C2 **cross-tenant leak test** pins that User B cannot fetch User A's
  reasoning trail via decisionId — the existing tenant scope on
  `getDecisionItem(id, userId, tenantId)` returns null, so the trail
  never reaches the API surface.
- C2 **HTML escape test** defends the formatter against `<script>` in
  the agenda title (which IS shown — but escaped).

## What's intentionally NOT in Wave 1

These are tracked in `graceful-stirring-scone.md` Wave 2 backlog or stretch:

- **Cooking / Finance / Content W-B consumers** — Wave 2 once Training
  consumer proves the pattern.
- **C6 confidence-aware degradation** — Wave 1 stretch S4.
- **C5 multi-week reflow** — Wave 2.
- **W-C / W-D scheduler.ts + decision-center.ts file extractions** —
  Wave 2 polish after Codex's chat work merges.
- **C1 adoption by Cooking + Finance callers** — Wave 1 stretch S6 or
  Wave 2 (Training is the only preview adopter in Wave 1).

## Codex coordination self-check (passed)

```
git diff --stat origin/main -- \
  src/services/secretary-fastpath.ts \
  src/api/routes/chat-message-routes.ts \
  src/api/routes/chat-message-local-responses.ts \
  src/api/routes/chat-message-degraded-response.ts \
  src/api/routes/chat-message-execution.ts \
  src/services/tool-executor.ts \
  src/services/chat-answer-contract.ts \
  src/services/chat-grounding-layer.ts \
  src/services/chat-response-quality-gate.ts \
  src/services/chat-skill-capability-registry.ts
→ empty diff (PASS).
```

## Next steps

1. Re-run hostile-QA validation after any merge/rebase onto current `origin/main`.
2. Once validation returns GO: run the verification gate again, push branch.
3. Codex's chat-logic merge to `main` remains the trigger for final branch
   alignment — follow the merge-execution playbook in the plan.

## Post-validation Wave 2 closure pass — 2026-05-13

Felipe asked whether any Secretary reasoning waves/tasks remained open after
Claude's Wave 1 work. The following concrete Secretary-owned follow-ups were
closed in this branch without touching Codex chat-owned files:

- **Cooking / Finance / Content W-B consumers**: added a shared
  `secretary_source_skill_feedback` sink and registered source-skill consumers
  for Cooking, Finance, and Content. The sink stores tenant-scoped feedback,
  reason codes, schedule window, refresh flag, downstream implications, and
  compact hints. Training keeps its specialized
  `training_feedback_decisions` sink.
- **C1 preview adoption beyond Training**: Cooking meal-prep event creation,
  Finance tax reminder scheduling, and Content editorial scheduling now preview
  Secretary placement before persisting an agenda item.
- **C6 confidence-aware degradation**: Secretary Decision Center confidence is
  capped when external calendar sync is stale or unconfirmed, while concrete
  agenda decisions remain visible with explicit uncertainty.
- **S2 dependency summary localization**: Decision dependency summaries now
  localize for Portuguese users.
- **S3 Telegram `/day` move marker**: day overview now adds a compact
  `↪` Secretary move marker for recent reflowed/compressed items.
- **S7 finance tenant collision guard**: Finance scheduling intent IDs are
  tenant-scoped and pinned by test.

Verification after this closure pass:

```
npx tsc --noEmit
→ PASS

npx vitest run <25 Secretary/Cooking/Finance/Content focused files>
→ PASS, 25 files / 280 tests

P1 QA gaps closed after Claude validation:
- C6 now has test coverage for both stale-sync branches:
  more than 15 minutes and more than 60 minutes.
- Training feedback consumer now pins compressed, reflowed, unscheduled, and
  needs-more-context outcomes.

npm run docs:audit
→ PASS, 518 markdown files audited / 464 existing warnings
```

The prior Codex hostile validation report was moved from the workspace mirror
into canonical release docs at
`docs/release/secretary-reasoning-wave1-codex-validation.md`.

Remaining Secretary items that are intentionally not closed in this backend
worktree:

- **C5 multi-week reflow iOS card**: requires an iOS/product design pass for
  the four-week card and is not safely closable in the engine-only Secretary
  worktree.
- **W-C / W-D `scheduler.ts` and `decision-center.ts` extraction**:
  non-functional refactor/polish. Deferring avoids destabilizing the branch
  while parallel chat work is still being reconciled.
- **Full downstream planner adoption of the new feedback sinks**: Cooking,
  Finance, and Content now consume and persist Secretary feedback. Deeper
  adaptive planning use should be owned by each skill's next intelligence pass.

## Failure modes to watch in production

| Workstream | Failure mode | Mitigation already in tree |
|---|---|---|
| M2 | Outlook rate-limit storm | retry budget = 2, exponential backoff, `Promise.allSettled` per (user, source) |
| W-A | Legacy reason code in production rows | `isKnownReasonCode` → `'unknown_legacy'` sentinel, never throws |
| W-B | Bad consumer breaks arbitration | per-handler try/catch + logger.warn; arbitration return value unaffected |
| W-E | Trail row width grows | hard cap 12 nodes, `chosen` preserved over `considered` |
| C2 | Trail leaks cross-tenant | owner-scoped `getSecretaryAgendaItemById`; pinned by test |
| C8 | Secretary summary fails when DB unavailable | try/catch in `trySecretaryWeeklySummary` returns null → notes builder drops line |
| M5 | APNs body exceeds 78 chars | graceful drop-down: duration → day anchor → ellipsis. Time anchor always survives. |

---

Generated 2026-05-13 by Claude Opus 4.7 on
`feature/secretary-reasoning-orchestration-2026-05`.
