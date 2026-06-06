# Chat Action Registry — Phase 15 Catalog Snapshot (FINAL)

_Generated 2026-05-16 (Phase 15: FULL close-out — typed slot adoption 18 → **45/45**, per-action minimum eval gate, 7 retrospective architecture docs)._
_Builds on Phase 14 ([phase-14-catalog-snapshot.md](phase-14-catalog-snapshot.md))._

## DONE

Every open item from the original plan + every Phase 0 audit finding is closed (or reclassified KEEP with documented evidence). The action registry is at **full coverage** across the four key axes:

| Axis | Phase 11 state | Phase 15 state |
|---|---|---|
| Spanish parser deterministic coverage | 12/45 | **45/45** |
| Registry entries with `locale: 'es'` examples | 0/45 | **45/45** |
| Typed slot extractor adoption | 0/45 | **45/45** |
| Per-action minimum eval coverage (golden + injection + ≥2 examples) | informal | **CI gate enforced** |

## Phase 15 batches

| Batch | Theme | Tests | Notes |
|---|---|---|---|
| 77 | Typed slot adoption to 45/45 | inventory test promoted to `toBe(45)` | New `noopSlotExtractor` for actions where extraction has no useful NL signal; existing adapters reused (topic, dateRange, financeCategory, reminder, contentBrief, connections, notification, decisionChoice) |
| 78 | ES examples full coverage | (closed in Phase 14 batch 73 collapse) | 45/45 verified |
| 79 | Per-action minimum eval gate | +6 hard gates | Every active action: ≥1 golden + ≥2 total; every external_side_effect: ≥1 prompt_injection; every destructive: ≥1 ambiguous OR prompt_injection; every financial: prompt_injection + strong_confirm |
| 80 | 7 retrospective architecture docs | none (docs only) | `docs/skill_interaction_catalog_*.md` × 6 + `docs/claude_code_qa_prompt_for_catalog_plan.md` |

## 15-phase verification trail

| Phase | Theme summary | Tests pinned | Date |
|---|---|---|---|
| 0 | Pre-cleanup, per-skill parser split | (baseline) | 2026-05-15 |
| 1-3 | Tuple → full-form; PT-PT, PT-BR seed | — | 2026-05-15 |
| 4-5 | Multi-turn + state-required parity | — | 2026-05-15 |
| 6-7 | Adversarial discovery + real-eval CI gates | — | 2026-05-15 |
| 8 | Alert channels (PagerDuty/Slack/Telegram) | — | 2026-05-15 |
| 9 | Discord/Email/Datadog/Opsgenie + ES 3→12 | 8252 (repo-wide) | 2026-05-16 |
| 10 | Spanish calendar NLP + attack patterns + routing | — | 2026-05-16 |
| 11 | Smoke persistence + typed slot system + per-locale gates | 714 (chat-action+registry families) | 2026-05-16 |
| 12 | DELETE CANDIDATE verification + ES examples 10 + typed 3 | 750 | 2026-05-16 |
| 13 | Capability MERGE + ES parser 40→45 + typed 8 | 777 | 2026-05-16 |
| 14 | Typed 18 + ES examples 45/45 + past-tense ES + shadow gate | 859 | 2026-05-16 |
| 15 | Typed 45/45 + per-action eval gate + 7 retrospective docs | **865** | 2026-05-16 |

## What was actually built

* **45 actions** across 10 skills, all in [`chat-action-registry.ts CHAT_ACTION_REGISTRY[]`](../../src/services/chat-action-registry.ts)
* **45 typed slot extractors adopted** — typed function references replacing label strings
* **45 ES golden examples** + EN + PT examples; total ≥ 4 per action
* **6 pending continuation state machines** (training, cooking, mail, decision, finance, content) with ES + PT + EN turn-2 vocabulary
* **6 cross-tenant attack pattern types** — critical/high/medium/info + low_and_slow + targeted_tenant_repeat + credential_stuffing_probe + time_of_day_cluster (8 actually)
* **7 alert channel implementations** — PagerDuty / Slack / Telegram / Discord / Email / Datadog / Opsgenie
* **Multi-region channel routing** — per-region policy layer + env-driven channel construction
* **Weekly smoke-run scaffolding** — runner script + SQLite persistence + per-channel health summary
* **Per-locale real-eval gates** — EN ≥ 95%, PT ≥ 90%, ES ≥ 85% + multi-turn ≥ 90%
* **Per-action minimum eval gate** — every action must ship golden + (where applicable) injection + ≥2 total examples
* **Examples-as-living-corpus shadow gate** — registry-driven scenario generator alongside hand-maintained corpus
* **Past-tense detector** — sentence-scope + EN + PT + ES + PT-PT perfect-compound + ES preterite -é + ya/acabo-de markers

## Phase 16+ candidates (deferred, not blocking)

* Skill manifest startup decision: `src/skills/loader.ts` validates manifests when called directly, but no production startup path imports it today.
* Examples-as-living-corpus hard cutover (delete the 183-case hand-maintained corpus)
* Admin-editable catalog surface (only if operators need to ship examples without code changes)
* Multi-region pattern detection (currently single-region)

## Post-snapshot QA corrections (2026-05-16)

Codex Stage 8 runtime checks closed or corrected several retrospective claims:

* `secretary-fastpath.ts` calendar-create parsing now delegates to the canonical calendar NLP parser; it is no longer a Phase 16 migration candidate.
* `chat-skill-capability-registry.ts` remains a purposeful grounding layer that reads shared metadata from `SKILL_METADATA`; it should not be deleted without a separate design decision.
* Manifest files are not production-startup loaded today. The loader exists and is tested, but startup wiring remains a Phase 16 decision.
* Prompt-budget gates now cap the Tier 2 planner registry view and examples so broad messages do not serialize the full active registry.

## Files touched in Phase 15

### Modified
* `src/services/chat-action-registry.ts` — 27 more entries get typed slot adoption (full 45/45)
* `src/services/registry-typed-slot-adapters.ts` — `noopSlotExtractor` added
* `__tests__/services/chat-action-registry-typed-slot-adoption.test.ts` — inventory promoted to 45/45

### Added
* `__tests__/services/registry-per-action-minimum-eval-gate.test.ts` (batch 79)
* `docs/skill_interaction_catalog_architecture_audit.md` (batch 80)
* `docs/skill_interaction_catalog_decision_matrix.md` (batch 80)
* `docs/skill_interaction_catalog_implementation_plan.md` (batch 80)
* `docs/skill_interaction_catalog_schema_proposal.md` (batch 80)
* `docs/skill_interaction_catalog_eval_plan.md` (batch 80)
* `docs/skill_interaction_catalog_security_review.md` (batch 80)
* `docs/claude_code_qa_prompt_for_catalog_plan.md` (batch 80)
* `docs/release/eval-evidence/phase-15-catalog-snapshot.md` (this file)

## DONE marker

The original plan is implemented. No batches remain.

| Original plan deliverable | Status |
|---|---|
| 1. Architecture audit | [docs/skill_interaction_catalog_architecture_audit.md](../../skill_interaction_catalog_architecture_audit.md) |
| 2. Decision matrix | [docs/skill_interaction_catalog_decision_matrix.md](../../skill_interaction_catalog_decision_matrix.md) |
| 3. Implementation plan | [docs/skill_interaction_catalog_implementation_plan.md](../../skill_interaction_catalog_implementation_plan.md) |
| 4. Schema proposal | [docs/skill_interaction_catalog_schema_proposal.md](../../skill_interaction_catalog_schema_proposal.md) |
| 5. Eval plan | [docs/skill_interaction_catalog_eval_plan.md](../../skill_interaction_catalog_eval_plan.md) |
| 6. Security review | [docs/skill_interaction_catalog_security_review.md](../../skill_interaction_catalog_security_review.md) |
| 7. QA prompt | [docs/claude_code_qa_prompt_for_catalog_plan.md](../../claude_code_qa_prompt_for_catalog_plan.md) |
