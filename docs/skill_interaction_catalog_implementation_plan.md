# Skill Interaction Catalog — Implementation Plan (Retrospective)

_Phase 15 batch 80 (2026-05-16): retrospective record of the phased implementation plan as it was executed (Phases 0-15)._

## Phase-by-phase summary

| Phase | Theme | Batches | Result |
|---|---|---|---|
| **0** | Pre-cleanup | n/a | Per-skill parser split, capability-registry inspection, manifest verification |
| **1-3** | Tuple → full-form, registry consolidation, ES seed | ~20 | 35 → 0 tuple entries; orphan skills promoted; ES 0 → 3 |
| **4-5** | Multi-turn, batch state-injection | ~10 | 6 pending continuations; state-required parity |
| **6-7** | Adversarial discovery, alert hook | ~10 | Cross-tenant pattern detection + alert dispatcher interface |
| **8** | Alert channels (PagerDuty/Slack/Telegram) | 1 | 3 channel adapters + dispatcher |
| **9** | Discord/Email/Datadog/Opsgenie + ES expansion | 6 | 7 channel adapters; ES 3 → 12; CI contract gate; multi-turn state-injection |
| **10** | Spanish calendar NLP + attack-pattern types | 6 | Spanish calendar parser; credential-stuffing + time-of-day; routing policy; smoke runs |
| **11** | Smoke persistence + typed slot system | 5 | SQLite trend; per-region routing; typed slot API (plumbing); per-locale eval gates |
| **12** | DELETE CANDIDATE verification + typed adoption | 6 | 2 candidates reclassified KEEP; typed adoption 0 → 3; ES examples 10 → 20 |
| **13** | Migration + capability-registry MERGE | 5 | Typed adoption 3 → 8; capability soft-merge; ES parser 40 → 45 full |
| **14** | Architectural items | 5 | Typed adoption 8 → 18; ES examples 20 → 45 (full); past-tense ES; examples-as-living-corpus shadow gate |
| **15** | Full close-out | 4 + final | Typed adoption 18 → **45/45**; per-action eval gate; this doc set |

## Goals + files touched (per phase)

### Phase 0 — prerequisite cleanup
* **Goals**: shrink planner, unify registries, delete dead code, expand types
* **Files**: per-skill parsers extracted to `src/services/skills/<skill>/parser.ts`; `chat-skill-capability-registry.ts` inspected; `manifest.json` loader/direct-call check
* **Validation**: smoke corpus stayed green at every commit
* **Result**: planner ≤ 4336 lines start → ≤ 4300 after extraction; 0 tuple-shorthand remaining

### Phase 1 — Populate `examples` for MVP scope
* **Scope**: tasks.create_task, tasks.complete_task, secretary_calendar.schedule_event, secretary_calendar.summarize_agenda, training.training_plan_create
* **Result**: 5 actions × 4-6 examples (golden + ambiguous + negative + prompt_injection)

### Phases 2-5 — Multi-locale + multi-turn
* **Scope**: PT-PT + PT-BR + ES seed; multi-turn pending continuations
* **Result**: 6 pending continuations; state-required parity harness; 180-case smoke corpus

### Phases 6-9 — Adversarial + alert infrastructure
* **Scope**: telemetry-driven adversarial discovery; cross-tenant alert pipeline; 7 channel adapters
* **Result**: real-eval scoring + CI gates; alert-channel CI contract gate

### Phases 10-12 — Spanish + typed slots + audit cleanup
* **Scope**: Spanish calendar NLP; multi-region routing; smoke persistence; typed slot adoption start
* **Result**: 28+ ES actions; per-region routing layer; SQLite smoke-run trend

### Phases 13-15 — Full close-out
* **Scope**: typed slot adoption to 45/45; ES examples to 45/45; capability-registry soft merge; per-action eval gate; retrospective docs
* **Result**: full coverage on every axis

## Phase 16+ candidates (open)

* **Skill manifest startup decision** — `src/skills/loader.ts` validates and loads manifests when called directly, but Stage 8 QA found no production startup import. Decide whether manifests should become runtime inputs or remain test/maintenance artifacts.
* **Examples-as-living-corpus hard cutover** — Phase 14 batch 74 ships the shadow gate. Cutover (delete the 183-case hand-maintained corpus) requires every action's examples to fully cover the hand-maintained edge cases.
* **Admin-editable catalog surface** — if a future operator cohort needs to ship example phrases without code changes, a thin admin UI over the typed `examples` field could ship.

Closed after the retrospective: `secretary-fastpath.ts` calendar-create parsing now delegates to the canonical calendar natural-language parser and is pinned by equivalence/regression tests.

## Validation per phase

| Phase | Command | Pass count |
|---|---|---|
| 12 | `npx vitest run __tests__/services/{chat-action,registry,calendar-natural}` | 750 |
| 13 | same | 777 |
| 14 | same | 859 |
| 15 | same + `__tests__/services/past-tense-detector-multi-locale.test.ts` | _final_ |

## Rollback strategy

Each batch is its own commit (revertible). Phase-final snapshot docs preserve evidence so a revert can be scoped surgically. No phase introduces irreversible schema migrations beyond `migrations/135_alert_channel_smoke_runs.sql` (Phase 11 batch 56), which is additive and reversible via DROP TABLE.

## Out-of-scope discipline (held throughout)

* No new YAML/JSON/DB catalog file shipped
* No new framework, library, or dependency added
* No new LangChain/CrewAI/AutoGen-style abstraction
* No "Chat v2"
* No production behavior change (every batch passed regression suites)
* No catalog admin UI
* No editing of CLAUDE.md, AGENTS.md, or release docs
