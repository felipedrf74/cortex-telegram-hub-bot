# Chat Action Registry — Phase 13 Catalog Snapshot

_Generated 2026-05-16 (Phase 13: typed-slot adoption 3 → 8, ES examples 10 → 20, capability-registry MERGE, Spanish parser 40 → 45 full, domain-handler inline-regex consolidation confirmed)._
_Builds on Phase 12 ([phase-12-catalog-snapshot.md](phase-12-catalog-snapshot.md))._

## Summary

| Metric | Phase 12 | Phase 13 | Δ |
|---|---|---|---|
| Spanish parser actions (deterministic) | ~40 | **45/45** | full coverage achieved |
| Typed slot extractors adopted | 3 | **8** | +5 (send_email, draft_email, delete_event, summarize_agenda, create_checklist) |
| Registry entries with `locale: 'es'` examples | 10 | **20** | +10 |
| Capability-registry MERGE (Phase 0 audit MERGE-1) | deferred | **DONE** (soft merge via SKILL_METADATA) | — |
| Inline regex consolidation phase 1 (domain-handler.ts) | open | **DONE + lint test** | — |
| Repo-wide chat-action + registry tests | 750 | **777** | +27 |

## Phase 13 batches

| Batch | Theme | Tests | Notes |
|---|---|---|---|
| 67 | Typed slot adoption +5 | +5 (inventory pin updated to 8) | Added `mailRecipientSlotExtractor`, `checklistSlotExtractor`, `agendaDateSlotExtractor`, `calendarMutationSlotExtractor` to `registry-typed-slot-adapters.ts`; wired into 5 action entries |
| 68 | ES examples on 10 more registry entries | 0 (data only) | Added to update_event, move_event, mail_inbox_summary, draft_email, update_task, create_checklist, training_plan_create, cooking_grocery_list, cooking_meal_plan, decision_choose |
| 69 | chat-skill-capability-registry MERGE | 0 (no behavior change) | New `SKILL_METADATA` table + `getSkillMetadata` in `chat-action-registry.ts`; capability-registry now reads shared fields (displayName/responseCardType/latencyBudgetMs/privacyPolicy) via lookup helper |
| 70 | Spanish parser 40 → 45 close-out | +5 | training_coach_report, connections_reconnect_guidance ("cómo me reconecto"), cooking_fueling_support, content_schedule_work, mail.send_email all deterministic in ES |
| 71 | Inline regex consolidation phase 1 | +4 | Verified `isTrainingPrescriptionIntent` moved to `intent-detectors.ts`; chat-message-local-responses.ts confirmed clean; lint test pins the consolidation state |

Plus one typecheck fix in `chat-message-local-responses.ts`: `export { x } from './module'` doesn't bind `x` locally; added explicit `import` so the function can be used in the same file.

## Closed Phase 12 carry-overs

| # | Item | Resolution |
|---|---|---|
| 3 | Spanish parser coverage 40 → 45 | Phase 13 batch 70 |
| 6 | chat-skill-capability-registry MERGE | Phase 13 batch 69 (soft merge) |
| 7 | Inline phrase regex consolidation | Phase 13 batch 71 (phase 1: domain-handler); secretary-fastpath remains for batch 76 |

## Carry-overs (Phase 14)

* Past-tense POS-aware variant
* Examples-as-living-test-corpus
* Typed slot adoption 8 → 45 (continued)
* ES examples 20 → 45 (continued)
* Inline regex consolidation phase 2+3 (secretary-fastpath.ts)

## Verification

```
npx tsc --noEmit                                                  # 0 errors
npx vitest run __tests__/services/{chat-action,registry,calendar-natural,chat-answer-contract}
# 777 passed across 41 test files
```
