# Chat Action Registry — Phase 14 Catalog Snapshot

_Generated 2026-05-16 (Phase 14: typed-slot adoption 8 → 18, ES examples 20 → 45 full, examples-as-living-corpus shadow gate, past-tense detector hardened multi-locale, secretary-fastpath inline-regex inventory)._
_Builds on Phase 13 ([phase-13-catalog-snapshot.md](phase-13-catalog-snapshot.md))._

## Summary

| Metric | Phase 13 | Phase 14 | Δ |
|---|---|---|---|
| Typed slot extractors adopted | 8 | **18** | +10 |
| Registry entries with `locale: 'es'` examples | 20 | **45/45 (full)** | +25 |
| Past-tense detector multi-locale | EN + PT | **EN + PT + ES** | +ES preterite + ya/acabo-de markers |
| Examples-as-living-corpus | not yet | **shadow gate live** | new |
| Inline regex consolidation phase 2+3 | not started | **inventory + partial migration confirmed** | (full migration deferred to Phase 16+) |
| Repo-wide chat-action + registry tests | 777 | **859** | +82 |

## Phase 14 batches

| Batch | Theme | Tests | Notes |
|---|---|---|---|
| 72 | Typed slot adoption +10 | inventory updated to floor of 18 | New adapters: taskMutation, topic, dateRange, financeCategory, reminder, contentBrief, cookingMealPlan, connections, decisionChoice, notification |
| 73 | ES examples +10 (closed batch 78 too) | +ES on every remaining action | 31 → 45 ES examples; all 45 registry entries now ship `locale: 'es'` golden example |
| 74 | Examples-as-living-corpus shadow gate | +5 | New `registry-examples-as-living-corpus-shadow.test.ts`; pins every active action has ≥1 example, ≥40 golden scenarios generate, 10 skills represented, all locales represented, adversarial+injection ≥10 |
| 75 | Past-tense detector hardened | +20 | Spanish "ya + preterite -é", "acabo de + infinitive", "ayer / hace N días" past-anchor combos; multi-sentence scope respected |
| 76 | Inline regex consolidation phase 2+3 | +2 (lint-only) | secretary-fastpath.ts already imports canonical calendar NLP; full delete of duplicate helpers deferred to Phase 16 |

## Closed Phase 13 carry-overs

| # | Item | Resolution |
|---|---|---|
| Typed slot adoption 8 → 18 | Phase 14 batch 72 |
| ES examples 20 → 30 (target) | Phase 14 batch 73 overshot to 45/45 |
| Past-tense POS-aware variant | Phase 14 batch 75 (regex-based hardening; no POS dep) |
| Examples-as-living-corpus | Phase 14 batch 74 (shadow gate) |

## Carry-overs (Phase 15)

* Typed slot adoption 18 → 45 (continued in batch 77)
* Per-action minimum eval coverage gate (batch 79)
* Retrospective architecture docs (batch 80)
* Full secretary-fastpath migration (Phase 16+)

## Verification

```
npx tsc --noEmit                                                  # 0 errors
npx vitest run __tests__/services/{chat-action,registry,calendar-natural,past-tense-detector}
# 859 passed across 44 test files
```
