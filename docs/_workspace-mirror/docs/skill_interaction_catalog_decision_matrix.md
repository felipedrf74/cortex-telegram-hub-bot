# Skill Interaction Catalog — Decision Matrix

Status: Decision document
Owner: Felipe (release lead)
Date: 2026-05-15
Companion to: [`skill_interaction_catalog_architecture_audit.md`](skill_interaction_catalog_architecture_audit.md)
Recommendation: **Option G — Action Registry Consolidation v2** (Phase 0 = Option A; cheapest first slice = Option C; fallback if Phase 0 too expensive = Option D)

---

## 1. Options under consideration

| Option | Name | Shape |
|---|---|---|
| A | No catalog yet / cleanup first | Refactor existing structure (planner split, registry merge, manifest deletion) without adding any new metadata |
| B | Documentation-only FAQ catalog | Static markdown listing Q&A per skill; no runtime wiring |
| C | Eval/test fixture catalog only | Generate smoke fixtures from a per-action examples table; no runtime change |
| D | ChatActionRegistry extension (additive) | Add `version`, `status`, `owner`, populate `examples`, bind `slotExtractors` to function refs; leave `chat-skill-capability-registry.ts` and `skill-config.ts routing` parallel |
| E | Prompt retrieval source only | Add an examples store consumed only by few-shot retrieval; engine routing unchanged |
| F | Database-managed catalog/admin surface | Catalog rows in SQLite + admin UI; runtime cache; possibly product-owner-editable |
| G | Action Registry Consolidation v2 (additive + consolidative) | Everything D does, PLUS merge `chat-skill-capability-registry.ts` into action registry, absorb `skill-config.ts routing.keywordRoute` into per-action `readableIntents`, deprecate parallels, delete duplicates (after verification) |
| H | Something else / hybrid | E.g., G + later F for product editing |

---

## 2. Scoring (1 = poor, 5 = excellent)

15-dimension scoring against the Nexus Hub codebase specifically. Numbers reflect *this* codebase's existing infrastructure (typed registry, smoke gate, sanitization, telemetry) — not generic catalog theory.

| Dimension | A | B | C | D | E | F | G | H |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1. Code quality | 4 | 2 | 3 | 4 | 3 | 3 | 5 | 4 |
| 2. Maintainability | 4 | 1 | 3 | 4 | 3 | 2 | 5 | 4 |
| 3. Complexity (5 = simplest) | 5 | 5 | 4 | 4 | 4 | 1 | 4 | 3 |
| 4. Performance | 5 | 5 | 5 | 5 | 4 | 3 | 5 | 4 |
| 5. Latency | 5 | 5 | 5 | 5 | 4 | 3 | 5 | 4 |
| 6. LLM cost | 4 | 5 | 5 | 4 | 3 | 4 | 4 | 4 |
| 7. Routing reliability | 3 | 1 | 2 | 4 | 2 | 4 | 5 | 4 |
| 8. Response quality | 3 | 1 | 3 | 4 | 4 | 4 | 5 | 4 |
| 9. Safety / security | 5 | 3 | 4 | 5 | 3 | 3 | 5 | 4 |
| 10. Testability | 4 | 1 | 5 | 4 | 3 | 3 | 5 | 4 |
| 11. Observability | 4 | 1 | 4 | 4 | 3 | 4 | 5 | 4 |
| 12. Product scalability | 3 | 1 | 3 | 4 | 3 | 5 | 5 | 4 |
| 13. Team velocity | 4 | 2 | 3 | 4 | 3 | 2 | 4 | 3 |
| 14. Migration risk (5 = lowest) | 5 | 5 | 5 | 4 | 5 | 1 | 3 | 3 |
| 15. Compatibility with existing arch | 5 | 5 | 5 | 5 | 4 | 2 | 5 | 4 |
| **TOTAL** | **63** | **43** | **59** | **64** | **53** | **44** | **70** | **57** |

Option G wins on absolute total. Option D is close but loses on routing reliability (3 parallel registries remain) and product scalability (adding a new skill still needs touching `skill-config.ts` separately). Option A is the cheap-and-safe Phase 0 step (no metadata expansion, just cleanup). Option C is the cheapest delivery slice within G (fixture generation only). Options B, E, F all score below 55 due to combinations of safety, testability, or migration-risk debt.

---

## 3. Tradeoff narrative per option

### Option A — No catalog yet / cleanup first

**For**: Lowest risk. Captures most of the duplication wins (planner split, manifest deletion, pending-store unification) without committing to new metadata semantics. Compatible with shipping incremental refactor PRs.

**Against**: Doesn't address the population gap (44/45 actions still have empty `examples`). The intuition the CEO is asking about (better chat response handling) is not delivered by cleanup alone. Cleanup creates the *room* for consolidation but doesn't yet *do* the consolidation.

**Verdict**: **Adopt as Phase 0 prerequisite** to Option G, not as the final state.

### Option B — Documentation-only FAQ catalog

**For**: Cheapest to produce. No code change.

**Against**: Stale immediately (no enforcement). No runtime value. No test coverage. Becomes a maintenance tax with no payoff. Worse: if the FAQ text is ever inlined into LLM prompts, it inflates cost and creates a prompt-injection surface (LLM01). Worse still: documentation that contradicts the code is more dangerous than no documentation.

**Verdict**: **REJECT.** The Nexus Hub codebase already has `docs/chat/*` (38 markdown files) that drift from the action registry. Adding another tier of drift is anti-value.

### Option C — Eval/test fixture catalog only

**For**: Strongly aligned with existing strengths. The smoke fixture corpus is already 180 cases with EN+PT, debug-leak gate, macro-precision threshold. Wiring a fixture *generator* from registry `examples` removes hand-maintenance drift without touching runtime behavior. Excellent first slice for derisking — it proves the registry expansion works for evals before exposing it to routing or prompts.

**Against**: Doesn't help routing reliability or response quality on its own. The engine still uses scattered phrase regexes. Eval coverage is a proxy for behavior, not behavior itself.

**Verdict**: **Adopt as the cheapest first delivery slice within Option G** (Phase 2 in the implementation plan). Not standalone.

### Option D — ChatActionRegistry extension (additive)

**For**: Type-safe, CI-validated, no new file format, no migration. Adds `version`, `status`, `owner`, populates `examples`, binds `slotExtractors`. The schema extension is small and backwards-compatible.

**Against**: Leaves three parallel registries running. Doesn't fix the phrase-scatter problem; adding a new Portuguese intent still requires touching 2-3 files. Doesn't delete the legacy in-memory pending store. Doesn't delete the stale manifests. The duplication continues to grow.

**Verdict**: **Acceptable fallback if Phase 0 cleanup proves too expensive in the first iteration.** Inferior to Option G long-term.

### Option E — Prompt retrieval source only

**For**: Improves LLM examples without touching engine boundaries. Lowest risk to existing behavior.

**Against**: Improves model output but does not improve engine reliability. The model can hallucinate better answers from better prompts, but the engine still owns truth — and the engine's deterministic routing, slot extraction, and read-back verification are unchanged. Doesn't address the structural duplication. Worse: encourages reliance on prompt examples instead of typed contracts.

**Verdict**: **REJECT as standalone.** Already partially in place at `retrievePlannerExamples()`; just needs to read from registry data (Phase 3 of Option G).

### Option F — Database-managed catalog/admin surface

**For**: Product-owner-editable. Could in principle let non-engineers add intents.

**Against**:
- Migration burden (new tables, new migration files, new caches).
- Runtime cache staleness — every cache invalidation is a potential bug.
- Permission model — who can edit? Who can deploy? Edit-after-deploy semantics are dangerous.
- No CI typecheck advantage — database rows don't typecheck; the schema only validates shape.
- The codebase has no admin UI for product-owners today, and building one is non-trivial (auth, permission rules, audit trail).

**Verdict**: **REJECT for now.** Conditions for future reconsideration documented in §5.

### Option G — Action Registry Consolidation v2 (recommended)

**For**:
- Wins on absolute score (70 vs second-place 64).
- Reduces three parallel registries to one.
- Reduces phrase scatter from 5-7 files per skill to 1.
- Promotes orphan skills (connections, notifications, decision_center) to first-class.
- Deletes the legacy in-memory pending-confirmations store (after verification).
- Deletes 5 stale manifest.json files (after verification).
- Type-tightens `slotExtractors`/`slotValidators` from string labels to function references.
- All metadata stays in typed TypeScript — no YAML, no JSON, no DB. CI typecheck is the validator.
- Compatible with existing safety boundary (sanitization, auth, result-strip).
- Generates smoke fixtures from registry, eliminating hand-maintenance drift.
- Sets up clean telemetry-feedback loop (Phase 4) since metrics are already typed.

**Against**:
- Higher migration cost than Option D (have to actually consolidate, not just extend).
- Planner split risk (4336-line monolith — must be done PR-by-PR).
- Tuple-shorthand conversion risk (35 entries — must preserve risk class and confirmation policy).
- Requires executing the approved literal-title policy (planner title-span detection + migration of 4 existing tests/fixtures) in Phase 0/1; product policy already resolved 2026-05-15 (§10 of audit doc).

**Verdict**: **RECOMMENDED.** Phase 0 (Option A) → Phase 1 MVP → Phase 2 (Option C as fixture generator) → Phases 3-5.

### Option H — Hybrid (G now, F later)

**For**: Captures Option G's wins now and leaves room for Option F as a product-editable surface later if needed (e.g., enterprise customers want to add their own intents). The hybrid keeps the typed registry as runtime source of truth; the future F adds a non-runtime authoring surface that compiles back into registry shape on commit.

**Against**: Speculation about future demand. Building toward F too early creates abstraction debt.

**Verdict**: **Defer.** Reconsider only when a real customer demand for product-owner authoring materializes. Document the conditions in §5.

---

## 4. Why each rejected option is rejected

### Why a FAQ catalog (Option B) is insufficient
- An FAQ structure is flat; Nexus Hub's action engine is typed and stateful. Flat Q&A cannot represent slot provenance, risk class, confirmation policy, verifier choice, or pending-action lifecycle.
- FAQ text is prose; if inlined to LLM prompts, it inflates cost and creates a prompt-injection surface (per [NCSC](https://www.ncsc.gov.uk/blog-post/prompt-injection-is-not-sql-injection) — the boundary is architectural, not prose).
- FAQs drift fast. The Nexus Hub codebase already has 38 markdown files under `docs/chat/` that drift from the action registry. Adding more drift is anti-value.
- No CI enforcement. A typo in an FAQ is a silent regression.

### Why a database/admin catalog (Option F) is premature
- No product-owner authoring surface exists today; building one is unjustified by current demand.
- Migration + cache + permission complexity outweighs current need.
- Runtime cache staleness creates a confused-deputy risk that the typed-registry-with-CI-typecheck doesn't have.
- Re-evaluation triggers (see §5).

### Why prompt-only examples (Option E) are insufficient
- Improves prompt quality but doesn't address: phrase scatter, parallel registries, orphan skills, legacy pending store, stale manifests, response policy duplication.
- The engine's reliability is not bounded by LLM example quality alone — it's bounded by deterministic routing, slot extraction, read-back verification, and trust-boundary enforcement.
- Per [OpenAI Evals](https://developers.openai.com/api/docs/guides/evals) and [Eval Best Practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices), eval coverage drives reliability. Catalog examples should serve evals first, prompts second.

### Why Option G is the target
- The chat-action infrastructure shipped in `cc17b75c` (production `4.14.164`) already provides 80% of the structure a catalog would need. Building a parallel artifact would duplicate it. Consolidation captures the unrealized 80% without rebuilding from scratch.
- The 20% gap (population, type-tightening, registry merge) is mostly *deletion and refactor*, not addition. Net code likely shrinks.
- Safety boundary is preserved: `executor`/`verifier` stay server-side; `buildLlmSafePromptSlice` (schema_proposal.md §6) gates LLM context exposure.
- Evals scale linearly with `examples` populated: each action's example block generates fixtures via Phase 2's generator. Coverage is measurable.
- Telemetry feeds back into priority ranking (Phase 4), creating a closed loop without auto-mutation.

---

## 5. When a future admin-editable catalog might become appropriate

The conditions under which Option F (DB-managed) would become defensible:

1. **Real customer demand** for product-owner intent authoring (e.g., enterprise customer wants to add their own jargon mappings without an engineering PR).
2. **Stable runtime** with Option G fully delivered and ≥ 6 months of telemetry showing the schema is mature.
3. **Permission model** designed: who can edit, who approves, audit trail, edit-after-deploy semantics.
4. **CI gate** that compiles DB-stored catalog rows into the same typed shape used by code-defined rows, with the same `buildLlmSafePromptSlice` filter applied at both compile and runtime.
5. **Migration path** that preserves Option G's typed-registry-with-CI-typecheck as the authoritative source for *core* actions; the DB layer is for *custom* extensions only.

Until all 5 conditions hold, Option F is premature.

---

## 6. Assumptions

- The smoke corpus and macro-precision gate stay green throughout the cleanup. (If any phase breaks the gate, that phase rolls back.)
- The cc17b75c hardening work remains the foundation; no parallel "Chat v2" is in flight.
- Felipe authorized the command-like-title literal-title policy on 2026-05-15 (audit §10). The planner change (title-span detection) and migration of the 4 enumerated existing tests/fixtures ship in Phase 0/1 before the first registry-driven example.
- The workspace docs root at `/Users/felipedominguez/Desktop/Nexus Hub/docs/` remains the canonical location for cross-repo decision documents.
- iOS code does not change in this initiative. If the catalog's `supportedCards` field implies new iOS states, a separate iOS audit is required.

---

## 7. Open questions (for human decision)

1. ~~**Command-like task title policy** (BLOCKER per audit §10)~~ **RESOLVED 2026-05-15** — Felipe approved the literal-title policy. Destructive language inside a trusted title span (after `called`/`chamada`/`titulo:`/`named`/quoted-string) is treated as literal user content; outside the title span it remains subject to standard destructive-action policy; ambiguous cases ask a clarification. Implementation TODO: planner change + migrate 4 tests at chat-action-planner.test.ts:466-485 and chat-hybrid-action-smoke-fixtures.test.ts:195/198/216/908. See audit §10 for the full approved policy.
2. **Tuple-shorthand promotion ordering**: convert all 35 entries to full literals in Phase 0 (one PR), or convert per skill (incremental, larger PR count, lower per-PR risk)? Recommendation: incremental by skill.
3. **Manifest.json deletion order**: delete all 5 at once or one-per-skill? Recommendation: one-per-skill PR with smoke-corpus-green check.
4. **Skill capability registry merge**: full merge in Phase 0 or gradual field-by-field migration (`responseCardType` first, then `latencyBudgetMs`, etc.)? Recommendation: full merge with backward-compatible aliasing for the transition window.
5. **Few-shot retrieval cap**: 4 examples per skill subset (proposed) or 6 (current hand-coded ceiling)? Recommendation: 4 — fewer is cheaper and pushes priority ranking to do work.
6. **Generated fixture floor**: when Phase 2 ships the generator, what's the minimum-passing-case floor? Recommendation: ≥180 (today's pin), monotonically increasing as `examples` populated.
7. **Telemetry feedback cadence**: Phase 4 report runs weekly (proposed), daily, or ad-hoc? Recommendation: weekly via cron job, with ad-hoc trigger from portal.
8. **Phase 4 → telemetry-informed Phase 1 expansion**: should the report's findings auto-prioritize the next 10 actions for Phase 3 population, or stay human-reviewed? Recommendation: human-reviewed — never auto-mutate registry from telemetry.

---

## 8. Conditions for stopping / rolling back the consolidation

Mid-rollout signals that would trigger a halt + rollback:
- Smoke corpus macroActionPrecision drops below 0.98 on a Phase 0 PR.
- PT smoke fixture pass rate drops below 95% (currently effectively 100%).
- Wrong-entity rate rises above 0.005.
- Production telemetry shows clarification rate rising > 10% week-over-week after a Phase 3 routing-source switch.
- A new debug-leakage pattern fires (production telemetry).
- Felipe redirects.

Rollback path: each phase is feature-flag-gated; rollback = flag off + revert PR.

---

## 9. Decision summary

| Decision | Outcome |
|---|---|
| Recommended option | **G — Action Registry Consolidation v2** |
| Phase 0 prerequisite | A (cleanup) |
| Cheapest first delivery slice | C (fixture generator only) |
| Fallback if Phase 0 too expensive | D (additive extension) |
| Rejected outright | B (docs-only), E (prompt-only standalone), F (DB-managed, for now) |
| Deferred reconsideration | H (hybrid G+F) — only if §5 conditions hold |
| Hardest implementation issue | Command-like-title current-code conflict (§10 of audit); product policy resolved 2026-05-15 as literal-title; implementation must update planner and 4 enumerated tests/fixtures |
| Net code impact | Likely negative (deletions + merges > new fields) |
| Runtime production behavior change | None during Phase 0; gradual flag-gated changes from Phase 3 onward |

---

## 10. Cross-references

- Architecture audit (master): [`skill_interaction_catalog_architecture_audit.md`](skill_interaction_catalog_architecture_audit.md)
- Implementation plan: [`skill_interaction_catalog_implementation_plan.md`](skill_interaction_catalog_implementation_plan.md)
- Schema proposal: [`skill_interaction_catalog_schema_proposal.md`](skill_interaction_catalog_schema_proposal.md)
- Eval plan: [`skill_interaction_catalog_eval_plan.md`](skill_interaction_catalog_eval_plan.md)
- Security review: [`skill_interaction_catalog_security_review.md`](skill_interaction_catalog_security_review.md)
- Independent QA prompt: [`claude_code_qa_prompt_for_catalog_plan.md`](claude_code_qa_prompt_for_catalog_plan.md)

External evidence cited:
- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [OpenAI Evaluation Best Practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices)
- [OpenAI Evals](https://developers.openai.com/api/docs/guides/evals)
- [Google Gemini Function Calling](https://ai.google.dev/gemini-api/docs/function-calling)
- [Google Gemini Structured Output](https://ai.google.dev/gemini-api/docs/structured-output)
- [Google Vertex/Gemini structured output reference](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/multimodal/control-generated-output)
- [OWASP Top 10 for LLM Applications](https://owasp.org/www-project-top-10-for-large-language-model-applications/)
- [OWASP LLM01 Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)
- [NCSC Prompt Injection is not SQL Injection](https://www.ncsc.gov.uk/blog-post/prompt-injection-is-not-sql-injection)
- [NIST AI Risk Management Framework](https://www.nist.gov/itl/ai-risk-management-framework)
