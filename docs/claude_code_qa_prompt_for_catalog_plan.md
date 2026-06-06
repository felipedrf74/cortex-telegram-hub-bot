# QA Prompt — Skill Interaction Catalog Plan (Retrospective)

_Phase 15 batch 80 (2026-05-16): self-contained QA prompt for an independent reviewer to verify the Phase 1-15 work._

## Reviewer instructions

You are an independent Claude Code instance reviewing the Skill Interaction Catalog work that landed across Phases 0-15. Your job is to verify EVERY claim in this doc set against the actual codebase. **Trust nothing on faith — verify by reading files.**

## Scope

* The 7 docs in this directory (this file + 6 others starting with `skill_interaction_catalog_`)
* The 15 phase snapshots in [`docs/release/eval-evidence/phase-*-catalog-snapshot.md`](release/eval-evidence/)
* The codebase at HEAD: `src/services/chat-action-registry.ts` + per-skill parsers + tests

## Methodology

Run, in order:

```bash
cd "/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot"

# 1. Typecheck (must be 0 errors)
npx tsc --noEmit

# 2. Verify registry stats
rg -n "locale: 'es'" src/services/chat-action-registry.ts | wc -l
# Expected: 45+ (one ES example per action)
rg -n "typedSlotExtractors:" src/services/chat-action-registry.ts | wc -l
# Expected: 45+ (full adoption)

# 3. Run the registry + eval test suites
npx vitest run __tests__/services/chat-action __tests__/services/registry
# Expected: all pass

# 4. Verify the per-action eval gate
npx vitest run __tests__/services/registry-per-action-minimum-eval-gate.test.ts
# Expected: 6 passed

# 5. Verify the typed slot inventory
npx vitest run __tests__/services/chat-action-registry-typed-slot-adoption.test.ts
# Expected: 15 passed, including "all 45 registry actions have typedSlotExtractors"
```

## Specific claims to spot-check

| Claim | File:line | How to verify |
|---|---|---|
| 45/45 actions have typed slot extractors | `chat-action-registry.ts` whole file | `rg -c "typedSlotExtractors:" src/services/chat-action-registry.ts` |
| 45/45 ES examples | same | `rg -c "locale: 'es'" src/services/chat-action-registry.ts` |
| `executor` strings never reach LLM | `chat-action-planner.ts` + `chat-action-registry.ts` | grep for `FORBIDDEN_MODEL_ARG_KEYS`; verify the list excludes `executor` |
| capability-registry MERGE via SKILL_METADATA | `chat-skill-capability-registry.ts:32-43` | confirm import from `chat-action-registry`; confirm `buildCapability` uses `metadataFor` |
| Phase 0 DELETE CANDIDATES reclassified | `chat-pending-confirmations.ts:24-27` | confirm header self-documents reclassification |

## Look for

* **Missed findings** — any inline phrase regexes still scattered in non-canonical locations?
* **Overfit to CEO idea** — does the implementation actually consolidate, or does it just add fields?
* **Executor / verifier leakage** — could any of `executor`, `verifier`, `executionPolicy`, or tenant identity fields slip into LLM context via the registry?
* **Delete-candidate safety** — were the 2 reclassified KEEP items (manifest.json + chat-pending-confirmations) verified to be load-bearing?

## Required verdict (in your review response)

Use ONE of:

* **PASS** — every claim verified, no missed findings
* **PASS WITH MINOR ISSUES** — minor docs typos or stale references; everything load-bearing is correct
* **PARTIAL** — some claims verify, some don't; rebuild the disputed section
* **FAIL** — claims contradict the codebase
* **NOT VERIFIED** — could not check (e.g., tests didn't run)

## Required response sections

1. **Scope** — what you reviewed
2. **Methodology** — what you ran
3. **Findings table** — claim-by-claim verification
4. **Missed findings** — anything the original work didn't catch
5. **Recommendation parity** — do you agree Option G (Registry Consolidation v2) was the right call?
6. **Verdict**

## Specific challenges for the reviewer

1. **Soft merge vs hard merge**: the audit recommended MERGE of `chat-skill-capability-registry.ts` into action registry. The actual Phase 13 batch 69 work did a SOFT merge — `SKILL_METADATA` moved, but capability-registry still exists for `NexusChatOwnerSkill` ('owner_admin' / 'chat'). Is this acceptable, or should you push for a hard merge?

2. **Examples-as-living-corpus shadow vs cutover**: Phase 14 batch 74 ships shadow mode. The hand-maintained 183-case corpus still exists. Is the migration target reachable from the current state? What's missing?

3. **secretary-fastpath.ts inline parsers**: still has `resolveCalendarCreateDate` + `parseCalendarTimeRange` despite importing `parseNaturalLanguageCalendarEvent`. Argue whether full delete is safe or requires more shadow work.

4. **noopSlotExtractor**: Phase 15 batch 77 uses a noop extractor for ~10 entries where extraction has no useful NL signal. Is this an acceptable form of "adoption" or a workaround that should be removed?

5. **DELETE CANDIDATE reclassifications**: are the 2 reclassified-KEEP items REALLY load-bearing, or was the audit gate just under-investigated initially?

## Files to read (priority order)

1. `src/services/chat-action-registry.ts` — the central artifact
2. `src/services/registry-typed-slot-adapters.ts` — typed extractor definitions
3. `src/services/chat-skill-capability-registry.ts` — soft-merge state
4. `src/services/chat-action-planner.ts` — phrase-detection + safety
5. `__tests__/services/registry-per-action-minimum-eval-gate.test.ts` — Phase 15 batch 79 gates
6. `docs/release/eval-evidence/phase-15-catalog-snapshot.md` — final snapshot
