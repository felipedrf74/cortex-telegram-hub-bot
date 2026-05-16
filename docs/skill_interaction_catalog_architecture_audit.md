# Skill Interaction Catalog — Architecture Audit (Retrospective)

_Phase 15 batch 80 (2026-05-16): retrospective record of the audit findings that drove Phases 1-15 of the chat action registry consolidation._

## Direct CEO challenge (opening, with evidence)

The CEO proposed creating a per-skill "FAQ catalog" so the engine could handle chat responses better. **The right artifact already existed** at [src/services/chat-action-registry.ts](../src/services/chat-action-registry.ts) — the `ChatActionDefinition` interface declared `skill`, `action`, `readableIntents`, `requiredFields`, `optionalFields`, `slotExtractors`, `slotValidators`, `providerDependencies`, `risk`, `riskClass`, `confirmationPolicy`, `executionPolicy`, `executor`, `verifier`, `verificationPolicy`, `uiSurfaces`, `examples`, `supportedCards`. The proposal was a near-superset of what already shipped.

**Building a new "catalog" artifact would have duplicated this.** The real gap was registry consolidation + scattered-phrase unification + fixture generation — which is what Phases 1-15 delivered.

## Audit findings (verified at start of work, 2026-05-15)

| Area | File / Location | Finding | Phase that closed it |
|---|---|---|---|
| Action registry | [chat-action-registry.ts:85-105](../src/services/chat-action-registry.ts) | `ChatActionDefinition` already declares the proposed catalog shape | n/a — already existed |
| Action registry | tuple-shorthand entries | 35 of 45 actions used positional-tuple shorthand stripping `examples`, `readableIntents`, etc. | Phases 1-3 expanded full-form entries |
| Action registry | `examples` field | Only `schedule_event` had `examples` populated (1/45) | Phase 12 (10/45) → Phase 14 batch 73 (**45/45 full**) |
| Phrase scatter | per-skill `parseXActionStep` blocks | Inlined in 4336-line planner monolith | Phase 0 split per-skill into `src/services/skills/<skill>/parser.ts` |
| Phrase scatter | `chat-action-registry.ts:338-360 selectRegistrySubsetForMessage` | 10 inline per-skill regexes | Wired to `readableIntents` |
| Phrase scatter | `domain-handler.ts` training intent | Inline regex | Phase 13 batch 71 — moved to `src/services/skills/training/intent-detectors.ts` |
| Parallel registries | `DEFAULT_SKILLS` vs `CHAT_ACTION_REGISTRY` vs `CAPABILITIES` | 3 sources of skill metadata | Phase 13 batch 69 soft-merge via `SKILL_METADATA` |
| Orphan skills | `connections`, `notifications`, `decision_center` | In type but not in `DEFAULT_SKILLS` | Promoted in Phase 1 |
| Pending-action stores | `chat-pending-confirmations.ts` legacy in-memory | DELETE CANDIDATE | Phase 12 batch 61: **reclassified KEEP** — distinct concern (Decision-Center coupling), self-documented |
| Stale manifests | `src/skills/<skill>/manifest.json` (5 files) | DELETE CANDIDATE | Phase 12 batch 61: **reclassified KEEP** — loader exists and is tested, but Stage 8 QA found no production startup import; Phase 16 should either wire startup loading or retire the manifests |
| Slot extractors | `slotExtractors`/`slotValidators` string labels | Not addressable | Phase 11 batch 59 typed API; Phase 15 batch 77 **45/45 adoption** |
| Risk class | `riskClassForRisk` duplicated | Merged in Phase 0 |
| Examples retrieval | `retrievePlannerExamples` hand-coded 3 examples | Wired to registry in Phase 11+ |
| Eval | 180-case smoke corpus hand-maintained | Phase 14 batch 74: shadow-mode generator gate + per-action minimum eval (batch 79) |
| Planner monolith | `chat-action-planner.ts` 4336 lines | Per-skill parser split closed across phases |
| Intelligence bus | `intelligence-bus.ts` ~70 signal types | KEEP — orthogonal to catalog |

## Repo-root detection results

* Backend: single git root at `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/`.
* iOS: separate Xcode project at `Nexus Hub IOS/Nexus Hub/`; the iOS workspace dir at `Nexus Hub IOS/` is NOT a git repo (`specs/` is filesystem-only).
* Workspace docs: own git working tree at `/Users/felipedominguez/Desktop/Nexus Hub/`.

## Bloat audit summary

| Bucket | Count at start | Status at Phase 15 end |
|---|---|---|
| KEEP | 14 | 14 — unchanged |
| REFACTOR | 6 | 6 — all done in phases 0-15 |
| MERGE | 5 | 5 done — capability-registry soft merge verified; secretary fast-path calendar-create parsing delegates to the canonical calendar NLP parser |
| DELETE CANDIDATE | 4 | 0 promoted to DELETE (all reclassified KEEP after caller-verification gate) |
| BLOCKER | 3 | 0 — all addressed |

## Verification trail

| Pass | Tests | Date |
|---|---|---|
| Phase 11 close | 714 | 2026-05-16 |
| Phase 12 close | 750 (+36) | 2026-05-16 |
| Phase 13 close | 777 (+27) | 2026-05-16 |
| Phase 14 close | 859 (+82) | 2026-05-16 |
| Phase 15 close | _final_ | 2026-05-16 |

## Recommendation (locked in)

**Option G — Action Registry Consolidation v2.** Extends existing `ChatActionRegistry`. NOT a new catalog. Phases 1-15 executed this directly:

1. **Phase 0**: per-skill parser split, capability-registry merge, deletions verified
2. **Phases 1-9**: tuple-to-full-form, ES/PT expansion, examples populated to 12/45, adversarial detection, channels
3. **Phases 10-12**: ES coverage 40+/45, multi-region routing, typed slot adoption 0 → 18
4. **Phases 13-14**: capability-registry soft merge, ES examples 45/45, past-tense hardened, examples-as-living-corpus shadow gate
5. **Phase 15**: typed slot adoption 18 → **45/45**, per-action minimum eval gate, this retrospective doc set

## 2026-05-16 runtime QA correction

Codex Stage 8 runtime checks corrected two retrospective statements:

* `chat-skill-capability-registry.ts` remains purposeful. It is not a dead duplicate: it maps broader `NexusChatOwnerSkill` values (`secretary`, `owner_admin`, `chat`) into grounding capability rows, reads shared metadata from `SKILL_METADATA` for the overlapping action skills, and feeds `chat-grounding-layer.ts`.
* `src/skills/loader.ts` is a valid direct-call manifest loader and is covered by tests, but no `src/` production startup path imports `loadManifest`. Manifest drift is therefore a Phase 16 product/runtime decision, not a current production-loader fact.

## External references (cited as evidence, not decoration)

* OpenAI Structured Outputs — guides the `expectedSlots` shape used in every registry example
* OWASP LLM01 Prompt Injection — drives the `prompt_injection` required example for every `external_side_effect` action (enforced in batch 79)
* NCSC "Prompt injection is not SQL injection" — argues for the trust-boundary separation between user text and executor labels (Phase 0 audit; `executor` strings never reach LLM context)
* NIST AI RMF — measurement / monitoring / governance / rollback alignment for the per-skill per-locale CI gates (Phase 11+)
