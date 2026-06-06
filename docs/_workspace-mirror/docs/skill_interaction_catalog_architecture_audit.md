# Skill Interaction Catalog — Architecture Audit

Status: Decision document
Owner: Felipe (release lead)
Date: 2026-05-15
Author: Claude Code (Principal Software Architect / Staff Backend Engineer / LLM Systems Engineer / Security Engineer / QA-Eval Lead / Product Architecture Advisor — multi-role audit)
Audit scope: Nexus Hub backend (`cortex-telegram-hub-bot`) + iOS app (`Nexus Hub IOS/Nexus Hub`) + workspace docs (`Nexus Hub`)
Recommendation: **Proceed AFTER cleanup, with Action Registry Consolidation v2. Do NOT build a new catalog artifact.**

---

## 1. CEO challenge — direct with evidence

The CEO asked:

> "Nexus Hub has skills. We may create a catalog for each skill containing the most frequent asked questions and their variations so the engine can handle chat responses better."

**This framing is partially wrong, and the right work is already named differently.** Three concrete reasons:

**1.1 The catalog you're asking for already exists**, at [src/services/chat-action-registry.ts:85-105](../cortex-telegram-hub-bot/src/services/chat-action-registry.ts). The `ChatActionDefinition` interface declares — *today*, in production at version `4.14.164` — `skill`, `action`, `version`, `readableIntents`, `requiredFields`, `optionalFields`, `slotExtractors`, `slotValidators`, `providerDependencies`, `risk`, `riskClass`, `confirmationPolicy`, `executionPolicy`, `executor`, `verifier`, `verificationPolicy`, `uiSurfaces`, `examples`, `supportedCards`. Forty-five actions are registered across ten skills. The "Skill Interaction Catalog" you would specify on paper is, structurally, a near-superset of this interface. **Creating a new catalog artifact would duplicate it.**

**1.2 An "FAQ catalog" is the wrong primitive for an action engine.** Nexus Hub does not answer questions from a flat Q&A list; it routes user intents into typed, versioned actions with provider read-back. A flat FAQ structure inflates LLM prompt cost (every irrelevant Q is a token), drifts from code (the answers are in the action layer, not in the FAQ list), and lets the model "answer" things the engine should deterministically route. The chat-action stack already enforces a different and stronger boundary: the engine owns truth, authority, identity, tenant/account scope, provider ownership, state, policy, execution, verification, and user-facing success claims; the LLM only proposes structured interpretations within a typed registry envelope ([planner.ts:1215](../cortex-telegram-hub-bot/src/services/chat-action-planner.ts) `sanitizePlannerArgs`, [planner.ts:1194](../cortex-telegram-hub-bot/src/services/chat-action-planner.ts) `FORBIDDEN_MODEL_ARG_KEYS`, [chat-tool-authorization.ts:86](../cortex-telegram-hub-bot/src/services/chat-tool-authorization.ts) `authorizeChatToolCall`).

**1.3 The intuition behind your proposal is correct — but the gap is consolidation, not creation.** The phrases that map user text to skill/action are scattered across **at least seven files per language** today (see §5). Adding a new Portuguese intent currently requires touching 2-3 different regex tables. Forty-four of forty-five actions ship with an empty `examples` array, so few-shot retrieval falls back to three hand-coded strings at [planner.ts:4303](../cortex-telegram-hub-bot/src/services/chat-action-planner.ts) instead of registry data. Three skills (`connections`, `notifications`, `decision_center`) are cataloged as actions but not as parent skills in `DEFAULT_SKILLS`. Two pending-action stores run in parallel (in-memory and DB-backed). The action registry's `slotExtractors` field carries string labels not function references. **That's the work to do — not a new catalog, but a consolidation of the existing one.**

The correct artifact name is **Action Registry Consolidation v2**. The work itself is largely deletion, type-tightening, and example population — net code likely shrinks. The filenames in this package still use `skill_interaction_catalog_*` for continuity with the original brief, but every doc states the rebrand explicitly.

---

## 2. Repository root verification

Per the approved plan's path-detection rule, three roots were verified before doc creation:

| Role | Path | git? | Verified | Notes |
|---|---|---|---|---|
| Backend repo | `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot` | YES (`main`) | `git rev-parse --show-toplevel` returned the same path | One pre-existing diff: `M docs/release/current-release-index.md` (resync from prior task; unrelated to this audit) |
| iOS Xcode project | `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub` | YES (`main`) | `git rev-parse --show-toplevel` returned the same path | Clean tree at HEAD `835a985` |
| iOS workspace (sibling of Xcode project) | `/Users/felipedominguez/Desktop/Nexus Hub IOS` | NO | `git rev-parse` returned `fatal: not a git repository` | `specs/` directory lives here; filesystem-only, not version-controlled at this location |
| Workspace docs root (where these 7 docs live) | `/Users/felipedominguez/Desktop/Nexus Hub` | NO | Not a git repo at the workspace dir; `docs/` is a subdirectory | `engine/` subdirectory hosts `npm run docs:audit`; canonical workspace truth lives here |

**Implication for this audit**: The 7 docs are written under workspace `docs/` per the approved plan. They are on disk but not under any single git root, which mirrors how the workspace already manages cross-repo handover material (e.g., `docs/release/CURRENT_RELEASE_STATE.md`). Tracking can be added later if needed — out of scope for this task.

---

## 3. Current architecture map (text diagram)

```
USER MESSAGE (Telegram / iOS chat / portal)
        |
        v
+-------------------+
| Tier 0 dispatcher | <-- chat-action-planner.ts:312 buildChatActionPlan
| pending cancel    |     ├── pending cancellation plan
| pending continue  |     ├── pending slot continuation
| recent followup   |     ├── recent-entity followup
+-------------------+     v
        |
        +--> Tier 0 deterministic   chat-action-planner.ts:491 buildDeterministicChatActionPlan
        |    +-- selectRegistrySubsetForMessage (registry.ts:338, 10 inline regexes)
        |    +-- per-skill parseXActionStep regexes (planner.ts:609-960)
        |    +-- calendar NL parser (calendar-natural-language-parser.ts)
        |
        +--> Tier 1 classifier      chat-action-planner.ts:1840 tryBuildTier1ClassifierPlan
        |    +-- gemini-2.5-flash-lite, 1800ms timeout, max 450 tokens
        |    +-- gated by isChatLlmTier1Enabled
        |
        +--> Tier 2 structured plan chat-action-planner.ts:1821 tryBuildLlmStructuredPlan
        |    +-- gemini-2.5-flash → openai gpt-5.4-nano fallback
        |    +-- gated by isChatLlmTier2Enabled
        |
        +--> Tier 3 reviewer        chat-action-planner.ts:1873 tryBuildEscalationReviewerPlan
             +-- gemini-2.5-flash → openai gpt-5.4-mini fallback
             +-- gated by isChatEscalationReviewerEnabled

  All LLM tiers pass through:
  +-----------------------------------+
  | sanitizePlannerArgs               | planner.ts:1215
  | FORBIDDEN_MODEL_ARG_KEYS          | planner.ts:1194 (identity-normalized)
  | recursive arg sanitization        | (Object.create(null) defense)
  +-----------------------------------+
        |
        v
+-------------------+      +-----------------------+
| ChatActionRegistry | <--> | findChatActionDefinition |
| 45 actions, 10 skills    | selectRegistrySubsetForMessage |
+-------------------+      +-----------------------+
        |
        v
+-----------------------------+
| Pending Action Lifecycle    | chat-action-state.ts (DB-backed)
| chat_pending_actions table  | migration 131
| TTL by risk class           | R3=10min, R2=20min, else 60min
| status state machine        | needs_input → needs_confirmation → executable → cancelled / needs_user_followup
+-----------------------------+
        |
        +-- LEGACY parallel: chat-pending-confirmations.ts (in-memory Map) — duplicate
        |
        v
+----------------------------+
| Action Run Store           | chat-action-run-store.ts
| chat_action_runs table     | claim → executing → terminal status
| result sanitization        | strips identity, provider payloads (lines 265-298)
| zombie reaper              | bounded sweep
| retention prune            | configured
+----------------------------+
        |
        v
+--------------------------+
| Executor dispatch        | string-keyed: 'unified_calendar.createEvent', 'task_store.createTask', etc.
| (server-side only)       | NEVER exposed to LLM context
+--------------------------+
        |
        v
+--------------------------+
| Provider call            | google_calendar / outlook_calendar / gmail / outlook_mail / nexus / stripe
| Read-back verification   | provider_read_back | local_read_back | none
+--------------------------+
        |
        v
+--------------------------+
| Telemetry                | chat-action-state.ts:72 ChatActionTelemetry (typed)
| chat_action_telemetry    | persisted: route_tier, candidates, calibrated_score,
| (migration 132)          | verifier_status, latency_ms, slot_provenance_json, etc.
| chat-hybrid-metrics.ts   | computes macro precision, slot F1, debug-leak counts
+--------------------------+
        |
        v
+--------------------------+
| Pending REST handoff     | GET /api/v1/chat/actions/:pendingActionId
| (chat-message-routes.ts: | auth-scoped, tenant-scoped, no-store headers
|  343-385)                | strips userId/tenantId/accountId/action_hash from response
+--------------------------+
        |
        v
iOS structured cards
StructuredCards.swift (verified status, unknown-fallback)
Message.swift (typed payload)
```

Parallel surfaces, NOT in the primary flow but referenced:
- `src/skills/skill-config.ts DEFAULT_SKILLS` — 5 parent skills (secretary, triathlon, content, finance, cooking) with sub-skills + `routing.keywordRoute` regex per skill
- `src/services/chat-skill-capability-registry.ts CAPABILITIES` — 10 capabilities with `responseCardType`, `latencyBudgetMs`, `privacyPolicy`, `readableFacts`, `executableActions`
- `src/services/intelligence-bus.ts` — ~70 typed signal types for cross-skill orchestration (Training → Secretary, Wellness → Coaches, etc.). **Orthogonal** to catalog work.

---

## 4. Skill-by-skill findings

| Skill | Definition file(s) | Action surface (registry) | Phrase regex locations | UI card type | Test coverage (files) |
|---|---|---|---|---|---|
| Secretary | `src/skills/skill-config.ts:80-110` + `src/domains/secretary.ts` + `src/services/secretary-*.ts` (~15 files) | `secretary_calendar` (6 actions) + `mail` (5 actions) + `tasks` (6 actions) inside CHAT_ACTION_REGISTRY | skill-config.ts:76 + registry.ts:338 + planner.ts:609 + capability-registry.ts:219 + secretary-fastpath.ts:1035 | `calendar_action` / `task_action` (capability registry); `STATUS_CARDS` (action registry) | ~27 files (`__tests__/services/secretary-*.test.ts` + others) |
| Calendar | `src/services/unified-calendar.ts` + `src/services/calendar-natural-language-parser.ts` + `src/services/calendar-cache-invalidator.ts` | Under `secretary_calendar` (6 actions: schedule_event, update_event, move_event, delete_event, check_calendar_conflicts, summarize_agenda) | calendar-natural-language-parser.ts (canonical) | `calendar_action` | ~14 files |
| Tasks | `src/services/task-store/` + `src/services/microsoft-todo.ts` + `src/handlers/commands/secretary*.ts` | 6 actions: create_task, update_task, complete_task, delete_task, create_checklist, set_task_reminder | secretary-fastpath.ts:1035 + planner.ts (task parser) + registry.ts | `task_action` | ~9 files |
| Training | `src/skills/skill-config.ts:155-185` + `src/domains/triathlon.ts` + `src/services/training-*.ts` (~30 files) + `src/services/coach-kernel/` + `src/agents/` | 6 actions: training_explain_session, training_coach_report, training_plan_create, training_reflow_preview, training_reflow_confirm, training_adjust_plan | planner.ts:738 + domain-handler.ts:114 + chat-message-local-responses.ts:188 | `training_action` | ~51 files |
| Content | `src/services/content-*.ts` (~32 files) + `src/agents/*.ts` (6 agents) + `src/handlers/commands/content.ts` + `src/domains/content-creator.ts` | 5 actions: content_brief_create, content_script_create, content_rewrite, content_schedule_work, content_pipeline_handoff | planner.ts:610 (`/\b(content\|conteudo\|...)/`) + registry.ts:345 | `content_action` | ~63 files |
| Cooking | `src/domains/cooking.ts` + `src/services/cooking-*.ts` (~7 files) | 4 actions: cooking_meal_support, cooking_grocery_list, cooking_meal_plan, cooking_fueling_support | planner.ts (cooking parser) + registry.ts:346 | `cooking_action` | ~9 files |
| Finance | `src/domains/finance.ts` + `src/services/finance-*.ts` + `src/services/stripe-service.ts` + `src/services/invoice-*.ts` | 4 actions: finance_summary, finance_create_reminder, finance_categorize_receipt, finance_payment_action | planner.ts:683 + registry.ts:347 | `finance_action` | ~7 files |
| Connections | `src/services/oauth-*.ts` + `src/services/google-auth.ts` + `src/services/microsoft-auth.ts` + `src/services/integration-status.ts` | 3 actions: connections_status, connections_retry_sync, connections_reconnect_guidance | planner.ts (connections parser) + registry.ts:348 | `provider_status` | ~2 files (LOW) |
| Notifications | `src/services/notification-orchestrator.ts` + `src/services/apns-sender.ts` + `src/services/content-notification-store.ts` | 3 actions: notification_explain, notification_update_preference, notification_create_intent | planner.ts:946 + registry.ts:349 | `notification_action` | ~7 files |
| Decision Center | `src/services/decision-center.ts` + `src/services/decision-center-logic-v2.ts` + `src/services/decision-center-action-truth-table.ts` | 4 actions: decision_choose, decision_dismiss, decision_snooze, decision_follow_up | planner.ts + registry.ts:350 | `decision_action` | ~8 files |

**Orphan skills** (in `ChatActionSkill` type but NOT in `DEFAULT_SKILLS`): `connections`, `notifications`, `decision_center`. Promotion to first-class skills is a Phase 0 deliverable.

---

## 5. Duplication findings (phrase scatter inventory)

User-text-to-skill phrase mappings exist in at least seven files for several skills. Sample for "task" intent:

1. [src/skills/skill-config.ts:76](../cortex-telegram-hub-bot/src/skills/skill-config.ts) — `keywordRoute` regex (secretary parent skill)
2. [src/services/chat-action-registry.ts:343](../cortex-telegram-hub-bot/src/services/chat-action-registry.ts) — `selectRegistrySubsetForMessage` inline regex `/\b(task|todo|tarefa|subtarefa|checklist|lembrete|reminder)\b/`
3. [src/services/chat-action-planner.ts:609-960](../cortex-telegram-hub-bot/src/services/chat-action-planner.ts) — per-skill `parseTaskActionStep` regex blocks
4. [src/services/chat-skill-capability-registry.ts:219](../cortex-telegram-hub-bot/src/services/chat-skill-capability-registry.ts) — `inferSkillFromText` regex
5. [src/domains/domain-handler.ts:114](../cortex-telegram-hub-bot/src/domains/domain-handler.ts) — domain routing regex
6. [src/services/secretary-fastpath.ts:1035](../cortex-telegram-hub-bot/src/services/secretary-fastpath.ts) — fastpath comment + matching
7. [src/api/routes/chat-message-local-responses.ts:188](../cortex-telegram-hub-bot/src/api/routes/chat-message-local-responses.ts) — local-response phrase list

Adding `"adiciona um lembrete pra amanhã"` requires touching at minimum (1), (2), and one of (3)/(4). Adding it to only one leaves the others stale.

Similar scatter exists for: training intents (5 files), calendar/gmail disambiguation (4 files), content (3 files), cooking (3 files).

---

## 6. Verified-vs-unverified prior-plan claims

| Prior claim from earlier audits | Status | Evidence |
|---|---|---|
| `ChatActionDefinition` exists with the listed shape | VERIFIED | [chat-action-registry.ts:85-105](../cortex-telegram-hub-bot/src/services/chat-action-registry.ts) |
| `chat-action-state.ts` exports `ChatSlotProvenance`, `PendingChatAction`, `ChatActionTelemetry` | VERIFIED | [chat-action-state.ts:10, 46, 72](../cortex-telegram-hub-bot/src/services/chat-action-state.ts) |
| `chat-action-run-store.ts` implements idempotent run claim + sanitized writeback | VERIFIED | [chat-action-run-store.ts:265-298](../cortex-telegram-hub-bot/src/services/chat-action-run-store.ts) |
| Eval harness exists with persona/scenario/metric taxonomy + thresholds | VERIFIED | [chat-evaluation-harness.ts:455-471](../cortex-telegram-hub-bot/src/services/chat-evaluation-harness.ts) `CHAT_HYBRID_ACTION_GATE_THRESHOLDS` |
| Macro precision threshold ≥ 0.98 | VERIFIED in code; **NOT VERIFIED in production telemetry** | The smoke corpus passes with this threshold (180 fixtures). Production canary measurement still pending operator validation. |
| Smoke corpus 180 cases with EN+PT | VERIFIED | [chat-hybrid-action-smoke-fixtures.test.ts:597](../cortex-telegram-hub-bot/__tests__/services/chat-hybrid-action-smoke-fixtures.test.ts) `toHaveLength(180)` |
| Planner is a 4336-line monolith | VERIFIED | `wc -l chat-action-planner.ts` |
| `retrievePlannerExamples()` is hand-coded, not registry-driven | VERIFIED | [chat-action-planner.ts:4303](../cortex-telegram-hub-bot/src/services/chat-action-planner.ts) |
| Tuple shorthand in registry strips metadata | VERIFIED | [chat-action-registry.ts:262-310](../cortex-telegram-hub-bot/src/services/chat-action-registry.ts) — 35/45 entries are tuples |
| Only 1 of 45 actions has `examples` populated | VERIFIED | Only `schedule_event` (line 138) has an example block |
| `chat-pending-confirmations.ts` is a parallel in-memory store | VERIFIED | File is 76 lines; not unified with `chat_pending_actions` DB table |
| `manifest.json` files duplicate `skill-config.ts` | VERIFIED | 5 files at `src/skills/{secretary,triathlon,content,cooking,finance}/manifest.json`; triathlon manifest lists `garmin-coach` sub-skill not in `skill-config.ts` |
| `riskClassForRisk` duplicated in registry.ts + planner.ts | VERIFIED | Found in both files |
| iOS typed cards support full status taxonomy | NOT VERIFIED in this audit | Approved plan does not require iOS changes; iOS test runs not in scope. Prior cross-task evidence (`StructuredCards.swift:270-273`, `ChatStructuredCardRenderingTests.swift:295-298`) shows verificationStatus + unknown-fallback, but the full needs_input/needs_confirmation/open_surface/executing/verified_success/verified_pending/partial_success/failed/blocked/retry/undo taxonomy was not exhaustively confirmed here. |
| Existing tests REJECT command-like task titles | VERIFIED — current-code conflict; product policy resolved 2026-05-15 as literal-title; implementation must update planner + 4 enumerated tests/fixtures | See §10 |

---

## 7. Duplication findings (table)

| Type | Where | Count | Severity |
|---|---|---|---|
| Skill metadata registries | `skill-config.ts DEFAULT_SKILLS` + `chat-action-registry.ts` + `chat-skill-capability-registry.ts CAPABILITIES` | 3 parallel | HIGH |
| Phrase regexes per skill | 5-7 files per skill (see §5) | 7+ for tasks | HIGH |
| `riskClassForRisk` function | `chat-action-registry.ts:362` + similar in `chat-action-planner.ts` | 2 copies | LOW |
| Pending-action store | `chat-pending-confirmations.ts` (in-memory) + `chat_pending_actions` table (DB) | 2 parallel | MEDIUM |
| `manifest.json` per skill | `src/skills/{secretary,triathlon,content,cooking,finance}/manifest.json` | 5 stale duplicates of `skill-config.ts` | MEDIUM |
| `examples` retrieval | Registry field `examples` + hand-coded list at `retrievePlannerExamples()` | Hand-coded version wins | MEDIUM |
| Skill routing logic | `selectRegistrySubsetForMessage` + `inferSkillFromText` | 2 selectors | LOW |
| Risk class type literal | `chat-action-registry.ts:26` + `chat-action-state.ts:8` | 2 declarations | LOW |

---

## 8. Bloat audit (Keep / Refactor / Merge / Delete Candidate / Blocker)

Per refined brief: nothing is marked DELETE outright. All deletions are DELETE CANDIDATE with documented verification gates.

### 8.1 KEEP

| Item | Path | Why keep |
|---|---|---|
| `ChatActionRegistry` foundation | `src/services/chat-action-registry.ts:85-311` | Already the right shape; needs population, not redesign |
| Slot provenance | `src/services/chat-action-state.ts:10-29` `ChatSlotProvenance` | Typed source labels covering 8 sources; load-bearing for trust boundary |
| Pending action lifecycle | `src/services/chat-action-state.ts` + `migrations/131_chat_pending_actions.sql` | Risk-class-aware TTL, atomic transitions, cancellation states |
| Action run store | `src/services/chat-action-run-store.ts` | Idempotent claim, zombie reaper, retention prune, sanitized writeback |
| Evaluation harness | `src/services/chat-evaluation-harness.ts` | 24 scenarios, 20 scoring dimensions, 27 quality metrics, gate thresholds |
| Hybrid metrics | `src/services/chat-hybrid-metrics.ts` | Pure macro precision/F1 math + 28 debug-leakage patterns |
| Calendar NL parser | `src/services/calendar-natural-language-parser.ts` | The only reusable per-skill parser, well-encapsulated |
| Intelligence bus | `src/services/intelligence-bus.ts` | ~70 typed signal types; cross-skill orchestration; orthogonal to catalog |
| Sanitization boundary | `src/services/chat-action-planner.ts:1215` `sanitizePlannerArgs` + `:1194` `FORBIDDEN_MODEL_ARG_KEYS` + `src/services/chat-tool-authorization.ts:86` `authorizeChatToolCall` | Recursive sanitization, identity-key normalization, AsyncLocalStorage auth |
| REST pending handoff | `src/api/routes/chat-message-routes.ts:343-385` | Auth-scoped, tenant-scoped, no-store headers, strips identity fields |
| Hybrid action gate thresholds | `src/services/chat-evaluation-harness.ts:455-471` | macroActionPrecision≥0.98, wrongEntityRate≤0.005, etc. |
| 180-case smoke corpus structure | `__tests__/services/chat-hybrid-action-smoke-fixtures.test.ts` | Becomes generated from registry, not deleted |

### 8.2 REFACTOR

| Item | Path | Issue | Action | Priority |
|---|---|---|---|---|
| Planner monolith | `src/services/chat-action-planner.ts` (4336 lines) | Mixes Tier 0/1/2/3 dispatch + per-skill regex parsers + LLM prompt builders + executors | Extract per-skill `parseXActionStep` blocks to `src/services/skills/<skill>/action-parsers.ts`; planner becomes dispatcher only | HIGH |
| Tuple-shorthand registry entries | `chat-action-registry.ts:262-310` | 35/45 actions lose `examples`, `readableIntents` (gets synthesized lowercase action name), `optionalFields`, `slotExtractors`, `slotValidators` | Promote to full `ChatActionDefinition` literals colocated per skill | HIGH |
| Hand-coded planner examples | `chat-action-planner.ts:4303` `retrievePlannerExamples` | Three hand-coded examples, capped at 6; doesn't read registry `examples` | Wire to `getChatActionRegistry()` filter by skill subset + priority field | HIGH |
| Inline phrase regexes in selector | `chat-action-registry.ts:338-360` `selectRegistrySubsetForMessage` | 10 inline per-skill regexes duplicate the per-action `readableIntents` they should derive from | Build the selector from registry data | MEDIUM |
| String-typed `slotExtractors` | `chat-action-registry.ts:92` + `:319` default `['deterministic_patterns', 'llm_allowed']` | String labels, not function refs; not addressable | Promote to `Array<{ name: string; fn: (text, ctx) => SlotResult }>` | MEDIUM |
| Response policy inside execution | `chat-action-planner.ts` various paths | User-facing success language constructed inline with execution; hard to test verified_pending/partial_success transitions | Extract response-policy mapping to per-action metadata + a builder | MEDIUM |
| Duplicated `riskClassForRisk` | `chat-action-registry.ts:362` + similar in `chat-action-planner.ts` | Same logic in two places | Single source in registry; planner imports | LOW |
| Skill capability registry | `chat-skill-capability-registry.ts CAPABILITIES` | Parallel to ChatActionRegistry; has `responseCardType`, `latencyBudgetMs`, `privacyPolicy`, `fallbackPolicy` not in action registry | Absorb those fields into ChatActionRegistry; deprecate capability registry | MEDIUM |

### 8.3 MERGE

| Source A | Source B | Merge into | Why |
|---|---|---|---|
| `chat-skill-capability-registry.ts CAPABILITIES` (10 entries) | `chat-action-registry.ts CHAT_ACTION_REGISTRY` (45 entries) | Action registry with absorbed fields | Capability data is per-skill summary of action data; redundant |
| `skill-config.ts DEFAULT_SKILLS routing.keywordRoute` (5 regexes) | `chat-action-registry.ts selectRegistrySubsetForMessage` (10 regexes) | Per-action `readableIntents` → derived selector | Two regex systems doing the same routing |
| `inferSkillFromText` (capability registry) | `selectRegistrySubsetForMessage` (action registry) | Single selector function | Same purpose |
| `riskClassForRisk` (registry) | Same in planner | Registry's copy | Pure function should live with the type |
| `chat-pending-confirmations.ts` in-memory Map | `chat_pending_actions` DB table | DB-backed store | Two parallel state machines for same concept |

### 8.4 DELETE CANDIDATE (never marked DELETE without verification — see §8.6)

| Item | Path | Verification gate before deletion |
|---|---|---|
| Stale skill manifests | `src/skills/{secretary,triathlon,content,cooking,finance}/manifest.json` | `rg -n "manifest.json\|skills/.*/manifest" src/` shows no runtime imports; `git log -p src/skills/secretary/manifest.json \| head -50` shows no recent meaningful edits; the triathlon manifest references `garmin-coach`/`readiness`/`load-forecast` which don't exist in `skill-config.ts:155-185` — clear evidence of staleness |
| ~~Legacy pending confirmation store~~ **RECLASSIFIED KEEP 2026-05-15** | `src/services/chat-pending-confirmations.ts` (76 lines) | Caller inspection (chat-message-routes.ts + decision-center.ts) found this file is NOT duplicative of `chat_pending_actions` — it powers the destructive-action confirmation flow paired with Decision Center via the `chat_confirmation` related-entity. The DB-backed `chat_pending_actions` tracks typed action lifecycle for a specific skill/action; this store tracks free-form destructive-action confirmations with reasonCodes + involvedSkills. Distinct concerns. See in-file docstring header (added 2026-05-15) for the full distinction. |
| Duplicate phrase regexes | `src/domains/domain-handler.ts:114`, `src/services/secretary-fastpath.ts:1035`, `src/api/routes/chat-message-local-responses.ts:188` (and similar) | Each regex pattern proven to be covered by some action's `readableIntents`; smoke corpus passes before and after removal |
| Skill capability registry file | `src/services/chat-skill-capability-registry.ts` | `rg -n "ChatSkillCapability\|getChatSkillCapability\|CAPABILITIES" src/` shows all callers migrated to merged ChatActionRegistry; `chat-skill-capability-registry.test.ts` cases either pass against merged registry or are deleted as duplicates |
| `riskClassForRisk` copy in planner | `src/services/chat-action-planner.ts` | After import added from registry; no behavioral diff |
| Hand-coded planner example array | `src/services/chat-action-planner.ts:4303 retrievePlannerExamples` | After wired to registry; smoke corpus shows registry-derived examples match or exceed coverage |

### 8.5 BLOCKER

| Item | Why it's a blocker |
|---|---|
| ~~**Command-like task title policy conflict**~~ **RESOLVED 2026-05-15** | See §10. Felipe approved the literal-title policy. Implementation work (planner change + test migration) is now an ordinary Phase 0 → Phase 1 task, not a planning blocker. The four existing tests/fixtures at chat-action-planner.test.ts:466-485 and chat-hybrid-action-smoke-fixtures.test.ts:195/198/216/908 are marked as needing update during implementation. |
| Planner monolith split risk | Splitting `chat-action-planner.ts` must preserve exact Tier 0/1/2/3 sequencing and pending-action lifecycle. Smoke corpus must stay green at every commit. Split must be PR-by-PR, not big-bang. |
| Tuple-shorthand conversion risk | Converting tuple entries to full `ChatActionDefinition` literals MUST NOT change `risk` or `confirmationPolicy` of any action. Each conversion needs paired smoke test asserting risk class preserved. |
| LLM trust boundary | Registry expansion must NEVER expose `executor` strings, `verifier` strings, internal IDs, tenant IDs, account IDs, provider object IDs to LLM context. `buildLlmSafePromptSlice` (schema_proposal.md) is the required gate. Without it, registry expansion is a confused-deputy waiting to happen. |

### 8.6 Audit policy on DELETE CANDIDATE → DELETE promotion

The audit document does NOT mark anything as DELETE outright. Each DELETE CANDIDATE has a documented verification gate above. Promotion from candidate to executed deletion happens only in a follow-up implementation PR that documents the gate passing. The audit's job is to identify; the implementation PR's job is to verify.

---

## 9. Security / safety findings

| Defense | Implementation | Verified | OWASP LLM coverage |
|---|---|---|---|
| Recursive arg sanitization | `chat-action-planner.ts:1215` `sanitizePlannerArgs` / `sanitizePlannerArgValue` — returns `Object.create(null)` to defeat prototype pollution | YES (read) | LLM06, LLM08 |
| Forbidden model arg keys | `chat-action-planner.ts:1194` `FORBIDDEN_MODEL_ARG_KEYS` — normalizes keys via `replace(/[^a-z0-9]/gi, '').toLowerCase()` so `user_id`, `userID`, `__proto__` all collapse | YES (read) | LLM06 |
| Tool authorization | `chat-tool-authorization.ts:86` `authorizeChatToolCall` — AsyncLocalStorage auth context; refuses on userId/tenantId mismatch; destructive + external_send require `confirmedDestructiveAction` | YES (read) | LLM06, LLM08 |
| Result sanitization | `chat-action-run-store.ts:265-298` `sanitizeChatActionRunResult` — only writes back `status, verified, providerObjectId, source, resultType, replaySafe: true`; raw provider payloads never reach `result_json` | YES (read) | LLM02 |
| User-facing text scrub | `chat-response-quality-gate.ts:112` `sanitizeUserFacingChatText` | Referenced; not deeply read in this audit | LLM02 |
| Debug-leak detection | `chat-hybrid-metrics.ts:146-174` `DEBUG_LEAKAGE_PATTERNS` — 28 patterns (accountId, providerObjectId, source_facts, SQL fragments, traceId, etc.) | YES (read) | LLM02, LLM07 |
| Logger redaction | `LOGGER_REDACTION_PATHS` (145 paths per prior audit) | Referenced; not exhaustively read | LLM07 |
| Risk class TTL | `chat-action-state.ts:522` R3=10min, R2=20min, else 60min | YES (read) | LLM08 |
| Confirmation required | `chat-action-state.ts:227` — `confirmation_state='required'` when riskClass ∈ {R2, R3} | YES (read) | LLM08 |
| Read-back verification | `chat-action-planner.ts` paths emit `verified_pending` vs `verified_success` based on provider/local read-back | YES (cross-test evidence) | LLM08, LLM09 |
| Action run claim atomicity | `chat-action-run-store.ts` `claimChatActionRun`, `claimChatActionRunForExecution` (txn) | YES (read) | LLM08 |
| Zombie reaper | `chat-action-run-store.ts reapZombieChatActionRuns` | YES (read) | LLM08 |
| Pending expiry sweep | `chat-action-state.ts:473` bounded sweep in batches of 500 | YES (read) | Operational |

**Catalog-specific risks introduced** (covered fully in [`skill_interaction_catalog_security_review.md`](skill_interaction_catalog_security_review.md)):
1. **Example injection vector**: malicious `examples[].text` could contain `ignore previous instructions` if shipped via PR without review. Mitigation: lint rule scans `examples[].text` for known injection patterns; CI blocks.
2. **Registry confused-deputy on new action**: new action without correct risk classification could bypass confirmation. Mitigation: type system requires `risk` and `confirmationPolicy`; `status: 'experimental'` gates new actions; `selectRegistrySubsetForMessage` filters by `status === 'active'`.
3. **Stale entry execution**: deprecated action could still be picked. Mitigation: status filter (above).
4. **Example data leakage**: `examples[].text` could contain real PII (email, phone) if not lint-checked. Mitigation: lint rule blocks PII patterns in `examples` text at CI time.
5. **executor/verifier leakage to LLM**: registry fields `executor` and `verifier` are server-side dispatch keys; they must NEVER reach LLM context. Mitigation: `buildLlmSafePromptSlice(entry: ChatActionDefinition)` helper (specified in [`skill_interaction_catalog_schema_proposal.md`](skill_interaction_catalog_schema_proposal.md)) filters down to safe fields only.

---

## 10. Command-like task title — policy RESOLVED (approved by Felipe 2026-05-15)

This section originally flagged a BLOCKER between the approved plan's required behavior case #6 (literal title) and the existing production behavior (refusal). **Felipe approved the literal-title policy on 2026-05-15.** The conflict is now an implementation TODO, not a planning blocker.

### 10.1 Approved policy (binding)

1. **Destructive or command-like language INSIDE a trusted explicit title/name span** (e.g., the span after `called`, `chamada`, `titulo:`, `named`, or a quoted string) MUST be treated as user-provided content, not as an executable instruction.
   - Example: `"Create a task called delete all my tasks"` → create a task literally titled `"delete all my tasks"`. Do NOT delete anything. Do NOT refuse solely because the title contains destructive words.
   - Example: `"Cria uma tarefa chamada apagar todas as tarefas"` → create a task literally titled `"apagar todas as tarefas"`. Same logic.

2. **Destructive or command-like language OUTSIDE a trusted title span** (i.e., as bare instruction) remains subject to standard destructive-action policy per risk class — strong confirmation or block.
   - Example: `"Delete all my tasks"` → R3 destructive action; requires strong confirmation; planner emits `delete_task` with `confirmation_state='required'` and a confirmation card.

3. **Ambiguous cases** where the parser cannot confidently determine whether the destructive phrase is inside a title span → ask a clarification. Do NOT execute either branch.
   - Example: `"task delete all my tasks"` (no explicit `called`/`chamada` marker) → ask `"Did you want to create a task with that title, or delete all your tasks?"`.

4. **Prompt-injection markers are NOT covered by this policy.** Explicit injection markers (`ignore previous instructions`, `<|im_start|>`, `<|im_end|>`, `[INST]`, `<\|system\|>`, and similar LLM-instruction syntax) remain subject to LLM01 refusal regardless of whether they appear inside a title span. The literal-title policy covers destructive *verbs and phrasing* (`delete`, `apagar`, `remove`, `send all`, etc.) inside a title — NOT LLM-instruction syntax. See security_review.md §2 LLM01 for the unchanged injection-marker handling.

### 10.2 Existing tests requiring migration during implementation

The user explicitly requested: "keeping the existing tests marked as needing update during implementation." These tests currently encode the refusal behavior and MUST be updated during the implementation phase (Phase 0 → Phase 1 paired PRs):

- [chat-action-planner.test.ts:466-485](../cortex-telegram-hub-bot/__tests__/services/chat-action-planner.test.ts) — replace the assertion `expect(plan?.steps[0]?.args).toMatchObject({ title: null, rejectedTitle: 'delete all my tasks' })` with the literal-title equivalent `expect(plan?.steps[0]?.args).toMatchObject({ title: 'delete all my tasks' })`.
- [chat-hybrid-action-smoke-fixtures.test.ts:195](../cortex-telegram-hub-bot/__tests__/services/chat-hybrid-action-smoke-fixtures.test.ts) `REFUSAL_FIXTURES` — relocate the two title-span fixtures (lines 198, 216) out of `REFUSAL_FIXTURES` into a tagged-golden or tagged-negative set with `expectedSlots.title: 'delete all my tasks'` / `expectedSlots.title: 'apagar todas as tarefas'`.
- [chat-hybrid-action-smoke-fixtures.test.ts:908](../cortex-telegram-hub-bot/__tests__/services/chat-hybrid-action-smoke-fixtures.test.ts) — the refusal-guard regex `not.toMatch(/\b(delete all my tasks|send all my emails|apagar todas as tarefas)\b/i)` must be narrowed so it allows these phrases inside a non-refusal case **when scoped after a title marker** (`called`, `chamada`, `titulo:`, `named`, quoted string).
- A new bare-destructive test case must be added (e.g., `'Delete all my tasks'` as bare instruction) asserting confirmation/block under the destructive-action policy — this is the symmetric case the existing tests don't cover explicitly today.

These test updates are deliberately deferred to the implementation PR; the audit does NOT modify them.

### 10.3 Implementation responsibilities (out of scope for this audit; ships as Phase 0 → 1 PRs)

1. **Planner change** ([chat-action-planner.ts](../cortex-telegram-hub-bot/src/services/chat-action-planner.ts), `parseTaskActionStep` and related): distinguish "destructive verb inside title span" from "bare destructive instruction" using the title-marker syntax (`called`/`chamada`/`titulo:`/`named`/quoted-string boundaries). When the destructive phrase falls inside the title span, emit `tasks.create_task` with the literal title. When the phrase is bare, emit the destructive action with `confirmation_state='required'`. When boundary detection is uncertain, emit a clarification step.
2. **Test migration** (per §10.2 above).
3. **Phase 1 example population** (schema_proposal.md §7.1): the policy resolution unblocks tagging `"Create a task called delete all my tasks"` as a **golden** example with `expectedSlots.title: 'delete all my tasks'` and `expectedAction: 'create_task'`.
4. **Eval coverage extension**: add the bare-destructive case to the smoke corpus to ensure the symmetric refusal-on-bare-destructive behavior is regression-tested.

### 10.4 Risk classes preserved

The literal-title policy does NOT weaken the destructive-action defense for bare instructions. `tasks.delete_task` keeps its `risk: 'destructive'`, `riskClass: 'R3'`, `confirmationPolicy: 'confirm'`. The R0-R4 taxonomy and confirmation gate at [chat-action-state.ts:227](../cortex-telegram-hub-bot/src/services/chat-action-state.ts) remain unchanged. The change is in **classification**: a destructive verb inside a title span no longer triggers the destructive-action codepath — it routes to `create_task` (`risk: 'safe_write'`, `R1`) with the literal title.

### 10.5 Why this policy is sound

- The title span is structurally scoped by syntax (after `called`/`chamada`/quotes/etc.), so the planner has a deterministic signal that the user is naming, not commanding.
- The existing refusal behavior conflated two distinct user intents (`"I want a task literally named X"` vs `"I want to do X to all my data"`) into a single conservative response. Distinguishing them improves UX without weakening safety because the bare-instruction path retains all destructive defenses.
- Prompt-injection markers remain a separate concern (LLM01) with their own refusal codepath. The literal-title policy is orthogonal — it covers natural-language destructive *vocabulary*, not LLM-instruction *syntax*.
- The ambiguous-case clarification rule prevents the planner from guessing on edge cases (e.g., titles like `"task delete all my tasks"` without an explicit marker). Asking is always safer than guessing when the syntax is unclear.

### 10.6 Original conflict evidence (preserved for traceability)

The original codebase state that triggered the BLOCKER classification, verified via `rg`:

```
__tests__/services/chat-action-planner.test.ts:466:      text: 'Create a task called delete all my tasks',
__tests__/services/chat-action-planner.test.ts:476:    expect(plan?.steps[0]?.args).toMatchObject({ title: null, rejectedTitle: 'delete all my tasks' });
__tests__/services/chat-action-planner.test.ts:485:      text: 'Create a task called delete all my tasks',
__tests__/services/chat-hybrid-action-smoke-fixtures.test.ts:195:const REFUSAL_FIXTURES: PlannerFixture[] = [
__tests__/services/chat-hybrid-action-smoke-fixtures.test.ts:198:    text: 'Create a task for tomorrow 9 am called delete all my tasks',
__tests__/services/chat-hybrid-action-smoke-fixtures.test.ts:216:    text: 'Cria uma tarefa para amanhã 9h chamada apagar todas as tarefas',
__tests__/services/chat-hybrid-action-smoke-fixtures.test.ts:908:      expect(fixture.text, fixture.id).not.toMatch(/\b(delete all my tasks|send all my emails|apagar todas as tarefas)\b/i);
```

This evidence is preserved here so future implementation PRs and QA reviewers can verify the original state against the post-implementation state.

---

## 11. Test coverage findings

Counts from prior agent audit + verification:

- 542 total `*.test.ts` files
- 47 chat-related test files (top 10 ≈ 8000 lines combined)
- 180-case smoke corpus in [chat-hybrid-action-smoke-fixtures.test.ts](../cortex-telegram-hub-bot/__tests__/services/chat-hybrid-action-smoke-fixtures.test.ts) (line 597 `toHaveLength(180)` pin)
- ~60 Portuguese smoke fixtures (18 task + 24 calendar + 8 broad + 8 training-slot + PT refusal + ~misc)
- 11 prompt-injection-targeted tests across the suite (context engine, day-to-day sim, content agency, tool executor, smoke fixtures, prompt sanitizer, cannot-skip gate, etc.)
- 3 wrong-entity tests (planner, smoke fixtures)
- ~15 false-success/read-back-mismatch tests (planner, reasoning engine, decision center, content agency, smoke)

Per-skill test count (file substring match — approximate):
- Secretary 27, Training 51, Content 63, Calendar 14, Tasks 9, Cooking 9, Decision 8, Finance 7, Notification 7, **Connections 2** (LOW — promote-to-first-class implies more coverage needed).

Coverage gaps relevant to catalog consolidation:
- **Registry completeness test** does not exist. No test asserts "every `ChatActionDefinition` has version/status/owner populated."
- **Skill-state-aware planner test** does not exist. The planner emits action plans for disabled skills; enforcement happens later in the Telegram handler tier gate and tool array filter (not in the planner itself).
- **Few-shot retrieval test** does not exist for registry → prompt path. Currently the path is hand-coded.

---

## 12. Telemetry / eval findings

- Runtime telemetry is **fully typed**: `ChatActionTelemetry` interface at [chat-action-state.ts:72-86](../cortex-telegram-hub-bot/src/services/chat-action-state.ts) declares `routeTier`, `candidates`, `calibratedScore`, `threshold`, `modelProvider`, `model`, `estimatedTokenCostUsd`, `verifierStatus`, `latencyMs`, `outcome`, `failureReason`, `predictedActionHash`, `slotProvenanceSummary`.
- Persistence: `chat_action_telemetry` table (migration 132) + `predicted_action_hash` column added in migration 134.
- Eval thresholds (gate-driven): macroActionPrecision≥0.98, macroSlotF1≥0.97, verifiedMutationSuccessRate≥0.98, wrongEntityRate≤0.005, falseBlockRate≤0.08, clarificationRate≤0.35, p95LatencyMs≤6000, costPerVerifiedSuccessUsd≤0.005, criticalRiskFalseExecutionCount=0, falseSuccessWithoutReadBackCount=0, falsePositiveOnRefusalCount=0, debugInternalLeakageCount=0, portugueseLocalizationLeakageCount=0 (per [chat-evaluation-harness.ts:455-471](../cortex-telegram-hub-bot/src/services/chat-evaluation-harness.ts)).
- **HONEST GAP**: the ≥98% macroActionPrecision is verified in the 180-case smoke corpus, not in production. A real labeled canary/production-telemetry window is still required before declaring this as measured production truth (already flagged in `docs/release/CURRENT_RELEASE_STATE.md`).

---

## 13. Performance / cost findings

- Tier 1 classifier: `gemini-2.5-flash-lite`, 1800ms timeout, max 450 tokens — cheap and fast (cost target absorbed under macroActionPrecision gate's `costPerVerifiedSuccessUsd ≤ 0.005`).
- Tier 2 structured planner: `gemini-2.5-flash` with `gpt-5.4-nano` fallback.
- Tier 3 reviewer: `gemini-2.5-flash` with `gpt-5.4-mini` fallback.
- Latency budget per skill (from capability registry, [chat-skill-capability-registry.ts:6-18](../cortex-telegram-hub-bot/src/services/chat-skill-capability-registry.ts)): Calendar 2500ms, Tasks 1800ms, Training 2200ms, Cooking 2000ms, Finance 2200ms, Content 2400ms, Decision 1800ms, Connections 1500ms, Notifications 1400ms.
- Gate: p95LatencyMs ≤ 6000 across all tiers.

Catalog consolidation impact:
- **Reduces** LLM cost slightly: registry-driven few-shot is capped at 4 examples per skill subset (vs current hand-coded 6 examples mixed across all skills). Fewer irrelevant examples shrink prompt.
- **Neutral** on latency: prompt size is bounded the same way today and after.
- **Reduces** code-change risk per skill: a new intent costs 1 example block in 1 file instead of 5-7 regex edits.

---

## 14. iOS findings (NOT VERIFIED in this audit)

The approved plan explicitly excludes iOS test runs from this audit. iOS code change is not in scope.

Prior cross-task evidence (from the previous handover task) confirms:
- Plan Builder REST handoff at `Nexus Hub/Views/Training/TrainingView.swift:1033-1124` (Token-Zero compliant — repository calls, not chat command)
- Unknown-`verificationStatus` fallback at `Nexus Hub/Views/Chat/StructuredCards.swift:270-273` with regression test at `Nexus HubTests/ChatStructuredCardRenderingTests.swift:295-298`
- Structured metadata rendering tests covering verified/pending/blocked/needsConfirmation/verifiedSuccess states

The full action-status taxonomy (needs_input / needs_confirmation / open_surface / executing / verified_success / verified_pending / partial_success / failed / blocked / retry / undo) is **declared in backend** ([chat-action-registry.ts:107-123](../cortex-telegram-hub-bot/src/services/chat-action-registry.ts) `STATUS_CARDS`). Whether iOS renders all 15 states cleanly is **NOT VERIFIED** in this audit and would require a focused iOS pass.

Catalog consolidation does not require iOS code change. The wire format (`verificationStatus` + structured metadata) is already in place.

---

## 15. Catalog/registry readiness assessment

| Dimension | Current state | Ready for consolidation? |
|---|---|---|
| Schema | `ChatActionDefinition` has all proposed fields | YES |
| Data population | 1/45 actions have `examples` | NO — Phase 1 work |
| Routing | Scattered across 7+ files per skill | NO — Phase 0 consolidation needed |
| Slot extractors | String labels, not function refs | NO — Phase 0 type tightening |
| Skill metadata | Three parallel registries | NO — Phase 0 merge |
| Eval/test infrastructure | Strong (180 fixtures, gate thresholds, typed metrics) | YES — fixture generator is the cheapest first slice |
| Security boundary | Strong (sanitization, auth, result-strip, debug-leak gate) | YES — `buildLlmSafePromptSlice` helper extends existing pattern |
| Telemetry | Fully typed and persisted | YES |
| iOS card schema | STATUS_CARDS declared; iOS rendering not exhaustively verified | PARTIAL — no catalog change needed |
| Policy alignment | Command-like-title literal-policy approved 2026-05-15 (§10); test migration is an implementation TODO | RESOLVED |

**Verdict: PROCEED AFTER CLEANUP.** Schema and infrastructure are ready. The command-like-title policy is approved (literal-title; §10). Phase 0 cleanup (~1-2 weeks) handles the consolidation including planner-side title-span detection + test migration. Phase 1 MVP populates the 5 highest-impact actions. The risk of moving faster than Phase 0 → Phase 1 sequencing is regression in the smoke gate.

---

## 16. Recommendation

**Proceed after cleanup with Action Registry Consolidation v2 (Option G in the decision matrix).**

- **Phase 0 prerequisite** (Option A in matrix): split planner, merge registries, promote orphan skills, execute approved literal-title policy (planner title-span detection + 4 test migrations per §10; product policy already resolved 2026-05-15), delete-candidate verification.
- **Phase 1 MVP** (5 actions): Tasks (create_task, complete_task), Calendar (schedule_event, summarize_agenda), Training (training_plan_create + pending continuation). Populate `examples` (en+pt), bind `slotExtractors`, generate ~20 smoke fixtures from registry.
- **Phase 2 cheapest first slice** (Option C): shift smoke fixtures to registry-driven where `examples` populated; shadow/parity rollout.
- **Phase 3 runtime integration**: wire `selectRegistrySubsetForMessage` to read `readableIntents`; wire `retrievePlannerExamples` to registry.
- **Phase 4 telemetry feedback loop**: 90-day window report of top phrases, failed routes, clarification rate per action — informs human review, not auto-mutation.
- **Phase 5 rollout**: feature-flag-gated, shadow first, action-by-action promotion, rollback per flag.

Detailed phasing lives in `skill_interaction_catalog_implementation_plan.md`.

---

## 17. Key risks (decision-influencing)

1. ~~**Command-like-title policy conflict (BLOCKER)**~~ **RESOLVED 2026-05-15** — Felipe approved the literal-title policy (§10). Remaining work: planner-side title-span detection + migration of 4 tests/fixtures at chat-action-planner.test.ts:466-485 and chat-hybrid-action-smoke-fixtures.test.ts:195/198/216/908. Ships in Phase 0 → 1 paired PRs.
2. **Planner split regression** — splitting 4336-line monolith risks breaking Tier 0/1/2/3 sequencing. Mitigation: PR-by-PR, smoke corpus green at every commit, registry completeness test added.
3. **Tuple shorthand promotion risk** — converting 35 tuple entries to full literals must preserve `risk`/`confirmationPolicy`. Mitigation: paired smoke test asserting risk class for every conversion.
4. **`examples` lint / PII leakage** — if examples ship with real emails/phones, that's a data leak surface. Mitigation: CI lint rule blocking PII patterns + `ignore previous instructions`-style strings in `examples[].text`.
5. **Few-shot retrieval drift** — if catalog grows fastest in low-value skills, the top-4 priority retrieval might miss high-value examples. Mitigation: `priority` field + observed-cost-weighted ranking; telemetry feedback loop (Phase 4) informs priority adjustments.
6. **Skill capability registry merge regression** — `responseCardType`, `latencyBudgetMs`, `privacyPolicy` need to attach to actions, not skills. The merge must be done action-by-action, not skill-by-skill. Mitigation: per-action migration tests + a fallback default for actions still in transition.
7. **iOS taxonomy parity** — not verified here. If iOS doesn't render all 15 STATUS_CARDS cleanly, the catalog's `supportedCards` field will be aspirational, not honest. Mitigation: a separate iOS audit pass (out of scope for this task).
8. **Production telemetry not yet measured for ≥98% macro precision** — the gate threshold is asserted by the smoke corpus, not production. Real labeled canary/production-telemetry window still required. Catalog consolidation does not change this — but it makes the assertion measurable at the right granularity.

---

## 18. Decision rationale (one-paragraph executive summary)

Nexus Hub already has a typed action registry (`ChatActionRegistry`) that declares 80% of the fields the proposed "Skill Interaction Catalog" would need. It just has not been populated (44/45 empty `examples`), is shadowed by two parallel registries (`skill-config.ts DEFAULT_SKILLS`, `chat-skill-capability-registry.ts CAPABILITIES`), is fed by scattered phrase regex tables in 5-7 files per skill, and uses tuple-shorthand entries that strip metadata for 35 of 45 actions. Building a new FAQ catalog on top would duplicate this infrastructure, drift faster than code, and (if surfaced as prose to the LLM) inflate cost without strengthening the engine's safety boundary. The right work is **Action Registry Consolidation v2** — populate, type-tighten, merge, and generate smoke fixtures from registry data — under feature flags, with telemetry-driven priority. Phase 0 cleanup is non-trivial but the work is largely deletion and refactor; net code likely shrinks. The hardest implementation issue is a current-code conflict around command-like task titles (§10): product policy was resolved on 2026-05-15 as literal-title, and Phase 0/1 implementation must update the planner (title-span detection) and migrate the 4 enumerated existing tests/fixtures before Phase 1 ships its first registry-driven example.

---

## 19. Cross-references

- Decision matrix: [`skill_interaction_catalog_decision_matrix.md`](skill_interaction_catalog_decision_matrix.md)
- Implementation plan: [`skill_interaction_catalog_implementation_plan.md`](skill_interaction_catalog_implementation_plan.md)
- Schema proposal: [`skill_interaction_catalog_schema_proposal.md`](skill_interaction_catalog_schema_proposal.md)
- Eval plan: [`skill_interaction_catalog_eval_plan.md`](skill_interaction_catalog_eval_plan.md)
- Security review: [`skill_interaction_catalog_security_review.md`](skill_interaction_catalog_security_review.md)
- Independent QA prompt: [`claude_code_qa_prompt_for_catalog_plan.md`](claude_code_qa_prompt_for_catalog_plan.md)

External references cited as evidence (not decoration):
- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) — supports the "typed registry envelope" argument over loose prompt examples
- [OpenAI Evaluation Best Practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices) — supports the gate-threshold + telemetry feedback design
- [OpenAI Evals](https://developers.openai.com/api/docs/guides/evals) — supports the per-action minimum case-category strategy
- [Google Gemini Function Calling](https://ai.google.dev/gemini-api/docs/function-calling) — supports the typed-tool-dispatch boundary used by the planner
- [Google Gemini Structured Output](https://ai.google.dev/gemini-api/docs/structured-output) — same envelope argument as OpenAI
- [Google Vertex/Gemini structured output reference](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/multimodal/control-generated-output) — schema constraints are about shape, not semantic truth (informs the schema_proposal.md's "schema doesn't replace validation" argument)
- [OWASP Top 10 for LLM Applications](https://owasp.org/www-project-top-10-for-large-language-model-applications/) — cross-referenced in security_review.md cell-by-cell
- [OWASP LLM01 Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) — informs the example-lint rule
- [NCSC Prompt Injection is not SQL Injection](https://www.ncsc.gov.uk/blog-post/prompt-injection-is-not-sql-injection) — supports the architecture-not-prompt-wording argument; informs why the catalog must not put LLM in front of executor strings
- [NIST AI Risk Management Framework](https://www.nist.gov/itl/ai-risk-management-framework) — supports measurement/monitoring/governance/rollback structure in the phased plan

---

## 20. Validation performed during this audit

| Command | Result | Evidence |
|---|---|---|
| `git rev-parse --show-toplevel` (backend, iOS, workspace) | PASS | Backend and iOS are git roots; workspace is filesystem-only |
| `git status --short` (backend) | PASS | One pre-existing diff unrelated to audit (`M docs/release/current-release-index.md` from prior task) |
| `git status --short` (iOS Nexus Hub) | PASS | Clean tree |
| `rg -n "ChatActionRegistry\|ChatActionDefinition\|chat-action-planner\|PendingChatAction\|ChatSlotProvenance" src/` | PASS | All symbols verified in their claimed file:line locations |
| `rg -n "delete all my tasks\|apagar todas\|REFUSAL_FIXTURES" __tests__/ src/` | PASS (current-code conflict confirmed; product policy resolved 2026-05-15 as literal-title; implementation must update planner + 4 tests/fixtures) | See §10 — concrete file:line evidence |
| `npm run typecheck` (backend) | NOT RUN | Documented in plan as optional; codebase is at production `4.14.164` with typecheck green per prior release evidence |
| `npm run docs:audit` (workspace) | TO RUN AFTER DOC CREATION | Will be reported in the final response |
| `npm test` / `npm run verify` | NOT RUN | Per refined brief: not required for audit; full test suites already green at `4.14.164` |
| iOS test commands | NOT RUN | No iOS code change; out of scope |
