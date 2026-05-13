# Secretary Reasoning + Orchestration — Wave 1 Closeout

**Branch**: `feature/secretary-reasoning-orchestration-2026-05`
**Worktree**: `/Users/felipedominguez/Desktop/Nexus Hub/worktrees/engine-secretary-reasoning`
**Base**: `origin/main`
**Date**: 2026-05-13
**Plan**: `/Users/felipedominguez/.claude/plans/graceful-stirring-scone.md`

## Verdict

**READY FOR CODEX HOSTILE-QA VALIDATION.**

10 must-ship workstreams landed across 10 commits (M1 was source-verified
as already closed in `main`; no new commit was needed). Verification gate
green (tsc + 18 focused vitest files + Codex-untouched grep + docs:audit).
Zero touches to Codex's chat-logic lane.

## Commits (oldest → newest)

| # | SHA | Workstream | LoC + Tests |
|---|-----|------------|-------------|
| 0 | `34e98595` | reserve migration 126 placeholder | 14 / — |
| 1 | (none — M1 verified closed in `main`) | M1 R7 carryovers | — / 52 existing pass |
| 2 | `7c997dfe` | **W-A** typed `SecretaryReasonCode` enum + helpers | 277 / 8 |
| 3 | `0574f5c2` | **M2** `secretary_agenda_sync` cron registration | 153 / 5 |
| 4 | `bdc9e691` | **C3** goal-phase dynamic priority weighting | 216 / 7 |
| 5 | `3d796791` | **C1** `previewSecretarySchedulingIntent` non-persisting probe | 182 / 5 |
| 6 | `41910e38` | **W-B** `SecretaryFeedbackBus` emit-only (consumer deferred) | 298 / 5 |
| 7 | `b34a431f` | **W-E** reasoning trail — capture + persist | 379 / 7 |
| 8 | `faaac145` | **C2** trail surface (Decision Center + Telegram `/why_last`) | 533 / 9 |
| 9 | `b0aa74ac` | **C8** weekly notes Secretary contribution | 263 / 9 |
| 10 | `4950eb96` | **M5** APNs date/time anchoring + **M8** PT-PT sweep | 320 / 9 |
| | | **TOTAL** | **~2.6k LoC / 64 new tests** |

## Verification gate — all green

```
=== 1) tsc --noEmit ===
OK

=== 2) Codex-untouched grep ===
PASS: no CODEX file touched

=== 3) Cron registration uniqueness ===
1 line matches registerJob('secretary_agenda_sync', …) — exactly one.

=== 4) Migration reservation ===
migrations/126_secretary_reasoning_trail.sql present (placeholder).
No migration 127 exists.

=== 5) Focused vitest sweep ===
18 test files / 190 tests / 100% passing:
  __tests__/services/secretary-reason-codes.test.ts             (8)
  __tests__/services/secretary-feedback-bus.test.ts             (5)
  __tests__/services/secretary-scheduling-arbitrator.test.ts    (11)
  __tests__/services/secretary-scheduling-preview.test.ts       (5)
  __tests__/services/secretary-priority-weighting.test.ts       (7)
  __tests__/services/secretary-reasoning-trail.test.ts          (7)
  __tests__/services/secretary-reasoning-trail-formatter.test.ts (6)
  __tests__/services/secretary-apns-anchoring.test.ts           (9)
  __tests__/services/secretary-agenda-provider-sync.test.ts     (12)
  __tests__/services/scheduler-secretary-agenda-sync.test.ts    (5)
  __tests__/services/decision-center.test.ts                    (34)
  __tests__/services/decision-center-secretary-trail.test.ts    (3)
  __tests__/services/decision-center-logic-v2.test.ts           (19)
  __tests__/services/coach-kernel-decision-trail.test.ts        (4)
  __tests__/services/coach-kernel-secretary-weekly-summary.test.ts (9)
  __tests__/api/decisions-routes.test.ts                        (5)
  __tests__/api/content-admin-write-auth.test.ts                (18)
  __tests__/api/training-plan-calendar-sync.test.ts             (23)

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
  cannot break arbitration. Training consumer wiring deferred to a
  follow-up commit; Cooking / Finance / Content consumers = Wave 2.
- **Weekly notes Secretary contribution** (C8). coach-kernel decision
  trail now includes `Secretary: compressed 2 sessions; long run protected.`
  when the agenda store has activity in the week. Graceful degradation
  when the Secretary DB isn't reachable (unit tests).
- **APNs date/time anchoring** (M5). `apnsBodyMoved(from, to, durMin, tz, lang)`
  and `apnsBodyNeedsChoice(slot, durMin, tz, lang)` helpers ready for
  recipe wiring. PT-PT: `Hoje 15:00 → 16:00 (45 min)`. EN: `Today 3:00 PM
  → 4:00 PM (45 min)`. 78-char cap honored with graceful drop-down.
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

- **Training consumer for W-B feedback bus** — bus emits only in Wave 1.
  Training consumer (writes `compressed_session +recovery_debt` via
  `training_feedback_decisions` table) is a small follow-up commit.
- **Cooking / Finance / Content W-B consumers** — Wave 2 once Training
  consumer proves the pattern.
- **C6 confidence-aware degradation** — Wave 1 stretch S4.
- **C5 multi-week reflow** — Wave 2.
- **W-C / W-D scheduler.ts + decision-center.ts file extractions** —
  Wave 2 polish after Codex's chat work merges.
- **C1 adoption by Cooking + Finance callers** — Wave 1 stretch S6 or
  Wave 2 (Training is the only preview adopter in Wave 1).
- **Recipe wiring for M5 anchoring helpers** — helpers are ready; the
  recipe sites in `decision-center-logic-v2.ts:545-840` are a follow-up
  commit (5 lines per recipe). Deferred so this branch stays additive.

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

1. Hand off to Codex for hostile-QA validation using the prompt in
   `graceful-stirring-scone.md` Handoff section.
2. Apply Codex's mechanical fixes (if any) and re-handoff.
3. Once Codex returns GO: rebase against current `origin/main`, run
   verification gate again, push branch.
4. Codex's chat-logic merge to `main` is the trigger for rebase — follow
   the merge-execution playbook in the plan.

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
