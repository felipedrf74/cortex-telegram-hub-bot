# Skill Interaction Catalog — Decision Matrix (Retrospective)

_Phase 15 batch 80 (2026-05-16): retrospective record of the option-scoring that selected "Action Registry Consolidation v2" (Option G)._

## Options scored (1 = poor, 5 = excellent)

8 options × 15 dimensions. Recommended: **Option G**. Selected: Option G (with Option A as Phase 0 prerequisite, Option C as cheapest first slice, Option D as fallback).

### Dimensions

1. Code quality / type safety
2. Maintainability
3. Complexity (5 = low)
4. Performance
5. LLM cost
6. Routing accuracy
7. Response quality
8. Safety (prompt injection, authorization)
9. Testability
10. Observability
11. Migration risk (5 = low)
12. Backwards compatibility
13. New-skill velocity
14. Multi-locale coverage
15. Eval reusability

### Options

| Option | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | TOTAL | Recommend |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **A. No catalog, cleanup-first** | 4 | 4 | 5 | 5 | 4 | 3 | 3 | 5 | 4 | 4 | 5 | 5 | 3 | 3 | 3 | 60 | Phase 0 step |
| **B. Doc-only catalog** | 2 | 1 | 5 | 5 | 5 | 1 | 1 | 3 | 1 | 1 | 5 | 5 | 2 | 1 | 1 | 39 | REJECT |
| **C. Eval-fixture-only catalog** | 3 | 3 | 4 | 5 | 5 | 2 | 3 | 4 | 5 | 4 | 5 | 4 | 3 | 3 | 5 | 58 | Partial slice |
| **D. Extend ChatActionRegistry (additive)** | 5 | 5 | 4 | 5 | 4 | 5 | 5 | 5 | 5 | 5 | 4 | 5 | 4 | 4 | 4 | 69 | Fallback |
| **E. Prompt retrieval source only** | 3 | 3 | 4 | 4 | 3 | 2 | 4 | 3 | 3 | 3 | 5 | 4 | 2 | 2 | 3 | 48 | REJECT |
| **F. DB-managed product surface** | 3 | 2 | 1 | 3 | 4 | 4 | 4 | 3 | 3 | 4 | 1 | 2 | 3 | 4 | 4 | 45 | REJECT |
| **G. Action Registry Consolidation v2** | **5** | **5** | **3** | **5** | **5** | **5** | **5** | **5** | **5** | **5** | **3** | **5** | **5** | **5** | **5** | **71** | **SELECTED** |
| **H. Something else (LangChain/CrewAI wrapper)** | 2 | 2 | 1 | 3 | 2 | 3 | 4 | 2 | 2 | 3 | 1 | 1 | 3 | 2 | 2 | 33 | REJECT |

### Why Option G

**Option D** is additive only — populate examples + bind slotExtractors. Leaves `chat-skill-capability-registry.ts` + `skill-config.ts` routing as parallel surfaces.

**Option G** = additive + consolidative — does everything D does, PLUS merges capability-registry into action registry (Phase 13 batch 69), absorbs `keywordRoute` regexes (Phase 0), deprecates the parallels.

For this codebase, the duplication was the bigger long-term tax → Option G beats D on dimensions 1, 2, 11, 13, 14, 15.

Runtime QA correction (2026-05-16): "deprecates the parallels" does not mean deleting `chat-skill-capability-registry.ts`. That file remains the runtime grounding bridge for broader chat owner skills and `owner_admin`; the duplicate metadata moved into `SKILL_METADATA`, while capability-specific fields and routing helpers remain there intentionally.

### Why not options B/E/F/H

* **B (doc-only)**: docs drift from code immediately. Dimensions 9, 14 score 1.
* **E (prompt retrieval)**: insufficient for routing accuracy + safety. Dimensions 6, 8 score 2-3.
* **F (DB-managed)**: migration burden, cache staleness, no CI typecheck gain. Dimensions 3, 11 score 1.
* **H (LangChain/CrewAI)**: framework overhead, lock-in, multi-tenant identity safety concerns. Dimensions 8, 11, 12 score 1-2.

## Acceptance / rejection summary

| Option | Accepted? | Phase that executed (or rejection reason) |
|---|---|---|
| A | YES — as Phase 0 prerequisite | Phase 0 (per-skill split, MERGE, cleanup) |
| B | REJECTED | docs-only drifts; Phases 13+ snapshots serve as evidence |
| C | YES — partial within Option G | Phase 14 batch 74 (shadow-mode generator) |
| D | YES — fallback path absorbed into G | Phases 11+ (typed slot API additive over legacy strings) |
| E | REJECTED | insufficient for the safety + routing-accuracy bar |
| F | REJECTED | migration risk + cache staleness |
| **G** | **YES — primary** | **Phases 0-15 all 80 batches** |
| H | REJECTED | framework overhead + identity-safety risk |

## Tradeoff narrative

* **Migration risk (dim 11)** is Option G's lowest score (3). Mitigated by: per-batch shadow runs, per-locale gates, typed adoption alongside legacy strings (no breaking change), every batch ships a snapshot doc.
* **Complexity (dim 3)** is moderate (3). The cost: ~80 batches across 15 phases. The benefit: the registry now drives 45/45 actions with typed extractors + 45/45 ES coverage + per-action eval minimums.
* **New-skill velocity (dim 13)** is Option G's biggest win. Adding a new skill now: ship a per-skill parser module, add 1 registry entry with `examples`, `typedSlotExtractors`, `typedSlotValidators`. ~150 lines for a fully-instrumented new skill vs ~600 lines pre-consolidation.

## When an admin-editable catalog surface might be appropriate later

Not now. If a future cohort of non-engineer operators needs to add example phrases, a thin admin UI over the typed `examples` field could ship — but only after the registry surface stabilizes (Phase 15+).
