# Skill Interaction Catalog — Implementation Plan (Action Registry Consolidation v2)

Status: Decision document
Owner: Felipe (release lead)
Date: 2026-05-15
Companion to: [`skill_interaction_catalog_architecture_audit.md`](skill_interaction_catalog_architecture_audit.md) + [`skill_interaction_catalog_decision_matrix.md`](skill_interaction_catalog_decision_matrix.md)
Recommended option: **G — Action Registry Consolidation v2** (Phase 0 = A; first slice = C; fallback = D)

This plan is intentionally repository-specific. Every file path is verified against the backend repo at `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot` at HEAD `f1247c8c` (production `4.14.164`).

---

## 0. Pre-phase decisions required from Felipe

Decision #1 below was a pre-phase blocker; it was resolved by Felipe on 2026-05-15 and is documented here for traceability. Decisions #2-5 remain open implementation-planning choices (recommendations attached) — none are blockers, but locking them in before PR work reduces churn.

1. ~~**Command-like task title policy** (audit §10)~~ **RESOLVED 2026-05-15** by Felipe. Approved: **literal-title policy**. Destructive language inside a trusted title span (after `called`/`chamada`/`titulo:`/`named`/quoted-string) is treated as literal user content; outside the title span it remains subject to standard destructive-action policy (strong confirmation or block); ambiguous cases ask a clarification. Implementation work moves to Phase 0/1 (planner change + test migration at chat-action-planner.test.ts:466-485 and chat-hybrid-action-smoke-fixtures.test.ts:195/198/216/908). See audit §10 for the full binding policy.
2. **Tuple promotion ordering**: all-at-once or per-skill (recommendation: per-skill, one PR per skill).
3. **Skill capability registry merge order**: full merge with aliasing or gradual field-by-field (recommendation: full merge with `@deprecated` aliases for one release window).
4. **Manifest deletion order**: PR per file or one bulk PR (recommendation: one bulk PR after verification gate).
5. **Few-shot retrieval cap**: 4 examples per skill subset (proposed) vs 6 (current ceiling).

Decisions are documented in `docs/release/CURRENT_RELEASE_STATE.md` (or equivalent owner-decision log) before Phase 0 commits land.

---

## Phase 0 — Architecture cleanup prerequisites

**Duration estimate**: 1-2 weeks (calendar; actual engineering days ≈ 5-8).
**Risk level**: MEDIUM (planner split has regression surface).
**Production behavior change**: NONE intended; gate is the 180-case smoke corpus staying green.

### Goals

- Shrink `chat-action-planner.ts` from 4336 lines to ≤ 2000 lines by extracting per-skill parsers.
- Promote `connections`, `notifications`, `decision_center` to first-class skills in `DEFAULT_SKILLS`.
- Merge `chat-skill-capability-registry.ts CAPABILITIES` into `ChatActionRegistry` (`responseCardType`, `latencyBudgetMs`, `privacyPolicy`, `fallbackPolicy` absorbed).
- Promote all 35 tuple-shorthand registry entries to full `ChatActionDefinition` literals; add `version`, `status`, `owner` fields.
- Type-tighten `slotExtractors`/`slotValidators` from `string[]` to `Array<{ name; fn }>` / `Array<{ name; validate }>` (typed function refs).
- Delete legacy `chat-pending-confirmations.ts` (after caller verification gate).
- Delete 5 stale `manifest.json` files (after verification gate).
- Single-source `riskClassForRisk` to `chat-action-registry.ts`; planner imports.
- Wire `retrievePlannerExamples` to read registry `examples` field.
- Execute approved literal-title policy (audit §10): implement planner title-span detection (after `called`/`chamada`/`titulo:`/`named`/quoted-string markers) and migrate the 4 existing tests/fixtures at chat-action-planner.test.ts:466-485 and chat-hybrid-action-smoke-fixtures.test.ts:195/198/216/908. Product policy already resolved 2026-05-15; this is implementation work, not a planning decision.

### Files likely touched (verified paths)

- [src/services/chat-action-planner.ts](../cortex-telegram-hub-bot/src/services/chat-action-planner.ts) — extract per-skill parsers; reference imports
- [src/services/chat-action-registry.ts](../cortex-telegram-hub-bot/src/services/chat-action-registry.ts) — tuple → full literal promotion; add `version`/`status`/`owner`; absorb fields from capability registry
- [src/services/chat-skill-capability-registry.ts](../cortex-telegram-hub-bot/src/services/chat-skill-capability-registry.ts) — merge into registry; mark `@deprecated`; eventual deletion
- [src/skills/skill-config.ts](../cortex-telegram-hub-bot/src/skills/skill-config.ts) — add 3 orphan skills to `DEFAULT_SKILLS`; remove redundant `keywordRoute` regexes that registry covers
- [src/services/chat-pending-confirmations.ts](../cortex-telegram-hub-bot/src/services/chat-pending-confirmations.ts) — DELETE CANDIDATE after callers migrate to `chat-action-state.ts`
- `src/skills/{secretary,triathlon,content,cooking,finance}/manifest.json` — DELETE CANDIDATE (5 files)
- New: `src/services/skills/<skill>/action-parsers.ts` (one file per skill: tasks, secretary_calendar, mail, training, content, cooking, finance, connections, notifications, decision_center) — homes the extracted parsers
- `src/services/chat-action-planner.ts:4303 retrievePlannerExamples` — rewire to registry data
- Optional new lint: `scripts/lint-registry.mjs` — verifies no tuple-shorthand remains; `examples` text passes PII/injection scan

### New types / contracts

```ts
// chat-action-registry.ts — extended fields
export interface ChatActionDefinition {
  // … existing fields preserved …
  version: `${number}.${number}.${number}`;
  status: 'active' | 'deprecated' | 'experimental';
  owner: 'productivity' | 'training' | 'content' | 'finance' | 'cooking' | 'platform';
  priority?: number;
  // typed function refs (replacing string[] labels):
  slotExtractors?: Array<{ name: string; fn: (text: string, ctx: SlotContext) => SlotResult }>;
  slotValidators?: Array<{ name: string; validate: (slots: Record<string, unknown>) => ValidationResult }>;
  // absorbed from capability registry:
  responseCardType?: string;
  privacyPolicy?: 'safe_preview' | 'private_detail' | 'sensitive_redacted' | 'owner_admin_only';
  latencyBudgetMs?: number;
  fallbackPolicy?: 'deterministic_summary' | 'clarify' | 'decision_center' | 'provider_degraded' | 'blocked';
}

export interface SlotContext {
  userId: number;            // already authorized; provided by AsyncLocalStorage
  tenantId: number;
  locale: 'en' | 'pt' | 'es' | 'mixed';
  timezone: string;
  pendingActionId?: string;
  recentEntities?: Array<{ kind: string; id: string }>;
}

export interface SlotResult {
  ok: boolean;
  slots?: Record<string, unknown>;
  rejected?: Record<string, string>; // field -> reason
}

export interface ValidationResult {
  valid: boolean;
  errors?: Array<{ field: string; reason: string }>;
}
```

(Schema detail in [`skill_interaction_catalog_schema_proposal.md`](skill_interaction_catalog_schema_proposal.md).)

### Tests required

- New: `__tests__/services/chat-action-registry-completeness.test.ts` — asserts every entry has `version`, `status`, `owner`; asserts no tuple-shorthand entries remain; asserts `slotExtractors` are typed function refs not strings.
- Existing smoke corpus must stay green at every commit ([__tests__/services/chat-hybrid-action-smoke-fixtures.test.ts](../cortex-telegram-hub-bot/__tests__/services/chat-hybrid-action-smoke-fixtures.test.ts)). The pin `toHaveLength(180)` stays unchanged in Phase 0; relaxed only in Phase 2.
- Per-skill parser regression test for each extracted parser module — same inputs as today, same outputs.
- Migration test for `chat-pending-confirmations.ts` deletion: every caller that was using in-memory now reads/writes DB-backed `chat_pending_actions` correctly.
- Lint script test: `__tests__/scripts/lint-registry.test.ts`.

### Validation commands

```bash
# Backend repo
cd "/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot"
npm run typecheck
npm run verify  # vitest run + tsc --noEmit
node scripts/lint-registry.mjs --strict
./scripts/cannot-skip-gate-dashboard.sh --json --no-evidence
./scripts/deploy-staging.sh   # only after focused tests green
./scripts/staging-smoke.sh    # 17/17 gate
```

### Risks

- **Planner split regression**: extracting parsers changes import graph and execution path. A subtle re-ordering could change Tier 0 sequencing. Mitigation: PR-by-PR per skill; smoke corpus green at every commit; one parser extracted per PR.
- **Phrase coverage regression**: removing redundant regexes in `domain-handler.ts`, `secretary-fastpath.ts`, `chat-message-local-responses.ts` could miss a PT variant. Mitigation: PT smoke fixtures pin 60 cases; they break if coverage drops.
- **Risk class loss on tuple promotion**: bad copy-paste could change `risk` or `confirmationPolicy`. Mitigation: paired smoke test per tuple converted, asserting risk class preserved.
- **Caller migration risk for chat-pending-confirmations.ts**: callers could break if migrated naively to DB-backed store with different semantics (TTL, account-switch cancellation). Mitigation: read all caller sites first; document semantic diffs; migration test per caller.

### Success criteria

- `wc -l src/services/chat-action-planner.ts` ≤ 2000
- `node scripts/lint-registry.mjs` exits 0 (no tuple shorthand)
- `chat-pending-confirmations.ts` not present in repo OR exists with deprecation banner + zero caller imports
- `src/skills/{secretary,triathlon,content,cooking,finance}/manifest.json` not present in repo
- `DEFAULT_SKILLS` has 8 entries (5 current + 3 promoted: connections, notifications, decision_center)
- `chat-skill-capability-registry.ts` either deleted or contains only re-exports for backward compatibility
- Smoke corpus 180/180 green
- `chat-evaluation-harness` gate metrics still met
- Staging smoke 17/17 green
- Approved literal-title policy executed (audit §10): planner title-span detection lands, the 4 enumerated tests/fixtures at chat-action-planner.test.ts:466-485 and chat-hybrid-action-smoke-fixtures.test.ts:195/198/216/908 are migrated, and a paired bare-destructive test case is added asserting confirmation/block when the destructive verb is outside a title span

### Rollback strategy

- Each PR is its own commit; rollback = `git revert <sha>`. No migration involved.
- Feature flags: not strictly needed for Phase 0 (refactor only), but `getChatHybridPlannerMode()` already supports `off | shadow | active`. If a split regression appears, set planner mode to `shadow` for the affected tier to log without acting.
- Deletion of `manifest.json` and `chat-pending-confirmations.ts` are reversible from git history.

---

## Phase 1 — Registry metadata MVP

**Duration estimate**: 1-2 weeks.
**Risk level**: LOW (data population only; no behavior change yet).
**Production behavior change**: NONE (data only; runtime still uses scattered phrases until Phase 3).

### Goals

- Populate `examples` array for **5 high-impact actions** in EN + PT (per refined brief):
  - `tasks.create_task`
  - `tasks.complete_task`
  - `secretary_calendar.schedule_event`
  - `secretary_calendar.summarize_agenda`
  - `training.training_plan_create` (with pending-continuation handling)
- Bind `slotExtractors` to actual function references for those 5 actions.
- Add `priority` field (0-100) to drive few-shot ranking.

### Per-action example block contract

Each action gets at minimum:
- 1-2 **golden** examples (1 EN + 1 PT) with `tags: ['golden']`
- 1 **ambiguous** example with `tags: ['ambiguous']` and explicit `condition` (e.g., `multiple_recent_tasks`)
- 1 **negative** example with `tags: ['negative']` (looks like the action but isn't — calibrates the planner against false positives)
- 1 **prompt-injection** example with `tags: ['prompt_injection']` and `expectedAction: null` (refusal)

### Action-specific notes

- **`tasks.create_task`**: per audit §10 policy resolution (literal-title, approved 2026-05-15), tag `"Create a task called delete all my tasks"` as a **golden** example with `expectedSlots.title: 'delete all my tasks'` and `expectedAction: 'create_task'`. Add a paired **bare-destructive** test case (e.g., `"Delete all my tasks"` as bare instruction) asserting confirmation/block under the destructive-action policy. Add an **ambiguous** example (e.g., `"task delete all my tasks"` without an explicit title marker) expecting clarification, not execution. The existing tests at chat-action-planner.test.ts:466-485 and chat-hybrid-action-smoke-fixtures.test.ts:195/198/216/908 must be migrated alongside the planner change in this phase.
- **`tasks.complete_task`**: must demonstrate the `"Mark this task as done"` follow-up case — ambiguous example with multiple recent task candidates, expected behavior is clarification (not guess). Already pinned by [chat-action-planner.test.ts:548](../cortex-telegram-hub-bot/__tests__/services/chat-action-planner.test.ts).
- **`secretary_calendar.schedule_event`**: keep the existing example (line 138) — `"Cria um evento na agenda do Gmail chamado igreja das 10 ao meio-dia e meio nesse domingo"` — and add EN golden + PT-BR golden + 1 negative ("Schedule a meeting with my future self" → ambiguous, no concrete time).
- **`secretary_calendar.summarize_agenda`**: golden examples for "what's on my agenda today" (EN) + "agenda de hoje" (PT) + ambiguous "agenda?" (no date context) → clarification.
- **`training.training_plan_create`**: cover both:
  - Without pending plan: `"Create a training plan"` → ambiguous → ask targeted missing-slot question
  - With pending plan: `"It is 20 km a week"` → fill `weeklyVolumeKm`. Tag the second example with `requiresPendingActionId: true` so the fixture generator builds the pending state.

### Files likely touched

- `src/services/skills/{tasks,secretary_calendar,training}/actions.ts` — created in Phase 0; populated in Phase 1
- `src/services/skills/{tasks,secretary_calendar,training}/slot-extractors.ts` — typed function refs bound to existing extractors (e.g., `extractTrainingPlanSlots`, calendar NL parser fields)

### Tests required

- Generated smoke fixtures: ~20 (4 categories × 5 actions). Add via Phase 2 generator (developed in parallel) or hand-mirror initially.
- Registry completeness extension: `chat-action-registry-completeness.test.ts` asserts the 5 actions have ≥ 4 examples each with required `tags`.

### Validation commands

```bash
cd "/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot"
npm run typecheck
npm run verify
npx vitest run __tests__/services/chat-action-registry-completeness.test.ts
npx vitest run __tests__/services/chat-hybrid-action-smoke-fixtures.test.ts
```

### Risks

- **Felipe time dependency**: populating canonical phrases per action requires product input. If delayed, Phase 1 stretches.
- **Mismatch with planner regex behavior**: example expected outputs must match what the planner actually does today. Mismatches surface as smoke regressions.

### Success criteria

- 5 actions with ≥ 4 examples each
- `slotExtractors` bound to function refs for all 5 actions
- `priority` field populated for each (proposed default: 50; high-value actions like `create_task` get 80)
- Smoke corpus passes (now with 20 new fixtures or hand-mirrored equivalents)
- No production behavior change observed in staging

### Rollback

- Revert example block PR. Generator (Phase 2) falls back to hand-maintained corpus.

---

## Phase 2 — Eval/test generation (the cheapest first slice)

**Duration estimate**: 1 week.
**Risk level**: LOW (test infrastructure only).
**Production behavior change**: NONE.

### Goals

- Shift `chat-hybrid-action-smoke-fixtures.test.ts` from hand-maintained corpus to **registry-derived corpus**, with hand-maintained fallback for actions whose `examples` is not yet populated.
- Generator emits `PlannerFixture[]` entries from `getChatActionRegistry()` filtered by `examples != null`.
- Tag-based category coverage: every action with `examples` must contribute at least 1 golden + 1 ambiguous + 1 negative + 1 prompt-injection case.
- Shadow/parity rollout: registry-derived fixtures run alongside hand-maintained for one CI cycle; mismatches logged.

### Files likely touched

- New: `__tests__/lib/registry-fixture-builder.ts` (~150 lines) — pure function `buildFixturesFromRegistry(registry: ChatActionDefinition[]): PlannerFixture[]`
- `__tests__/services/chat-hybrid-action-smoke-fixtures.test.ts` — adopt the builder; relax `toHaveLength(180)` pin to `toBeGreaterThanOrEqual(180)`
- New: `__tests__/lib/registry-fixture-builder.test.ts` — unit tests for the builder itself (golden/ambiguous/negative/prompt-injection generation)

### New contracts

```ts
export interface RegistryFixtureBuilderOptions {
  registry: ChatActionDefinition[];
  includeActions?: ChatActionName[];   // for shadow mode
  excludeActions?: ChatActionName[];
  perActionMax?: number;               // default: all examples
  injectPendingActionState?: boolean;  // for tags.requiresPendingActionId
}

export function buildFixturesFromRegistry(opts: RegistryFixtureBuilderOptions): PlannerFixture[];
```

### Tests required

- Builder unit tests (above)
- Shadow-parity test: registry-derived fixtures for the 5 MVP actions produce the same `expectedSkill`/`expectedAction`/`expectedTitle`/`expectDueDateTime` as hand-maintained equivalents.
- Coverage report: emit a JSON summary `{ totalRegistryActions, actionsWithExamples, exampleToFixtureRatio }` to `docs/release/eval-evidence/<timestamp>.json` (informational only, not gated).

### Validation commands

```bash
cd "/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot"
npx vitest run __tests__/lib/registry-fixture-builder.test.ts
npx vitest run __tests__/services/chat-hybrid-action-smoke-fixtures.test.ts
npm run verify
```

### Risks

- **Generator parity gap**: registry-derived fixtures could differ subtly from hand-maintained ones. Mitigation: shadow mode for 1 CI cycle; differences logged as warnings; reconciliation PR before flipping to registry-primary.
- **Pin assertion change**: relaxing `toHaveLength(180)` to `toBeGreaterThanOrEqual(180)` could mask a future regression that removes hand-maintained cases. Mitigation: keep the hand-maintained corpus visible as a floor; the generator augments it.

### Success criteria

- Builder produces ≥ 20 fixtures from the 5 MVP actions
- Shadow-mode parity within 0 mismatches for those 5
- `toBeGreaterThanOrEqual(180)` passes
- Coverage report emitted

### Rollback

- Switch the builder off via test-only env var `NEXUS_DISABLE_REGISTRY_FIXTURE_BUILDER=1`. Test falls back to hand-maintained corpus.

---

## Phase 3 — Limited runtime integration

**Duration estimate**: 2-3 weeks.
**Risk level**: MEDIUM (production routing path touched).
**Production behavior change**: Gradual; feature-flagged per action.

### Goals

- Populate `examples` for the next 9 highest-priority actions (after MVP 5): Calendar (update_event, move_event, delete_event), Tasks (update_task, delete_task, create_checklist, set_task_reminder), Training (training_adjust_plan, training_reflow_preview).
- Wire `selectRegistrySubsetForMessage` to read `readableIntents` from registry entries instead of inline regexes.
- Wire `retrievePlannerExamples` to filter registry by skill subset + `priority` field; cap at 4 examples per skill subset.
- Wire `buildLlmSafePromptSlice(entry: ChatActionDefinition)` helper (schema_proposal.md §6) and route all Tier 1/2/3 LLM context construction through it.

### Files likely touched

- `src/services/chat-action-registry.ts` — `selectRegistrySubsetForMessage` rewritten as registry-driven
- `src/services/chat-action-planner.ts` — `retrievePlannerExamples` rewritten; LLM prompt builders adopt `buildLlmSafePromptSlice`
- Per-skill `actions.ts` files (added in Phase 0) — populated for the next 9 actions

### New contracts

- `buildLlmSafePromptSlice(entry: ChatActionDefinition): LlmSafeActionView` — see schema_proposal.md §6 for shape

### Tests required

- New: `__tests__/services/chat-action-prompt-safety.test.ts` — asserts `executor`, `verifier`, internal IDs, tenant/account IDs are NEVER present in the output of `buildLlmSafePromptSlice`
- Regression test on `selectRegistrySubsetForMessage`: same inputs produce the same skill subsets as before
- Cost telemetry assertion: Tier 1/2/3 prompt sizes for the 5 MVP actions are within ±10% of pre-Phase-3 baseline

### Validation commands

```bash
cd "/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot"
npm run verify
npx vitest run __tests__/services/chat-action-prompt-safety.test.ts
./scripts/deploy-staging.sh
./scripts/staging-smoke.sh
# Monitor production telemetry for 7 days in shadow mode before promoting
```

### Risks

- **Routing regression**: rewiring `selectRegistrySubsetForMessage` could drop a regex variant. Mitigation: comprehensive registry coverage in Phase 0 + shadow mode for 7 days.
- **Prompt size drift**: registry-derived examples could be longer than hand-coded ones, raising cost. Mitigation: `perActionMax` cap; cost telemetry gate.
- **LLM-safe slice leakage**: if `buildLlmSafePromptSlice` accidentally exposes a forbidden field, that's a security incident. Mitigation: dedicated test + lint rule + code review checklist (security_review.md §6).

### Success criteria

- Top 14 actions (5 MVP + 9 next) have `examples` populated
- `selectRegistrySubsetForMessage` has 0 inline per-skill regexes (registry-driven only)
- `retrievePlannerExamples` reads registry
- `buildLlmSafePromptSlice` is the sole path for LLM context construction
- Shadow mode: 0 mismatches for 7 consecutive days on staging
- Production smoke 17/17 green after promotion

### Rollback

- Feature flag `chatRegistryDrivenSubset = false` reverts to inline regexes (kept in code as comment-block fallback for the transition window).
- Per-action flag (Phase 5) gates production switchover.

---

## Phase 4 — Telemetry feedback loop

**Duration estimate**: 1 week.
**Risk level**: LOW (read-only telemetry).
**Production behavior change**: NONE.

### Goals

- Run a script over `chat_action_telemetry` (90-day window) that emits:
  - Top phrases by skill (frequency-ranked, anonymized)
  - Failed routes by action (planner null / refusal / clarification)
  - Clarification rate by action
  - p95 latency by tier × skill
  - Wrong-entity rate by action
  - Provider read-back failure rate by action
  - PT vs EN fixture pass rate by action
  - Cost per verified success by action
- Output as portal report (HTML) + machine-readable JSON in `docs/release/registry-telemetry-evidence/<timestamp>.json`.
- **No automatic registry mutation from telemetry.** Feedback is human-reviewed input to Phase 3 priority adjustments.

### Files likely touched

- New: `scripts/registry-telemetry-report.ts` (~150 lines)
- New: `src/portal/registry-telemetry-page.html` (optional) or markdown emission
- New: `__tests__/scripts/registry-telemetry-report.test.ts` — fixture telemetry rows in/out

### Tests required

- Unit tests for the aggregator: given fixture telemetry rows, asserts metric outputs
- Privacy test: emitted phrases must not contain emails, phone numbers, real names — assert with regex set

### Validation commands

```bash
cd "/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot"
node scripts/registry-telemetry-report.ts --days=90 --out=docs/release/registry-telemetry-evidence/$(date -u +%Y%m%dT%H%M%SZ).json
npx vitest run __tests__/scripts/registry-telemetry-report.test.ts
```

### Risks

- **PII leakage in emitted phrases**: if anonymization is incomplete, emails/phones could leak into the report. Mitigation: privacy regex check + LOGGER_REDACTION_PATHS reuse.
- **Misinterpretation of clarification rate**: high clarification rate could be a feature (good ambiguity handling) or a bug (over-asking). Mitigation: report includes per-action context, not just numbers.

### Success criteria

- Report runs locally against staging telemetry; surfaces 5+ actionable phrase gaps
- Privacy check passes
- Output format consumable by Felipe for priority decisions

### Rollback

- Script is read-only; rollback = stop running it.

---

## Phase 5 — Rollout (gradual, flag-gated)

**Duration estimate**: indefinite; one action at a time.
**Risk level**: LOW per action.
**Production behavior change**: Gradual.

### Goals

- Promote each consolidated action from `shadow` → `active` mode one by one, after 7+ days of shadow parity.
- Per-action mode flag added: `getActionMode(skill: ChatActionSkill, action: ChatActionName): 'off' | 'shadow' | 'active'` (built on top of existing `getChatHybridPlannerMode`).
- Production monitoring with rollback triggers (decision_matrix.md §8).

### Files likely touched

- `src/config.ts` — extended feature flag map per action
- `src/services/chat-action-planner.ts` — uses `getActionMode` per action

### Tests required

- Feature flag test matrix: `off`, `shadow`, `active` per action
- Rollback drill: per-action flag flip from `active` to `shadow` rolls back routing within 1 min (cache invalidation)

### Validation commands

```bash
cd "/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot"
npm run verify
./scripts/deploy-staging.sh
./scripts/staging-smoke.sh
./scripts/promote-to-prod.sh   # only after smoke gate
```

### Risks

- **Flag state confusion**: per-action flags could drift from each other. Mitigation: portal page displays current mode per action; weekly review.
- **Cascading rollback**: if one action's rollback unmasks an issue in another (shared parser code), the rollback could ripple. Mitigation: per-skill modules (from Phase 0) keep parser isolation.

### Success criteria

- All Phase 1 MVP actions in `active` mode for 30+ days with no regression
- Phase 3 actions (next 9) progressing through shadow → active without rollback
- macroActionPrecision ≥ 0.98 maintained across the rollout

### Rollback strategy

- Per-action flag: `getActionMode(skill, action) = 'shadow'` → routing falls back to legacy hand-coded path
- Phase 3 routing regex fallback kept in code as comment-block for 90 days
- Per-PR rollback via `git revert <sha>`

---

## What we should refuse to build now

These are out of scope for this initiative and should be explicitly rejected if proposed:

1. **YAML/JSON catalog files.** No file format outside TypeScript. CI typecheck is the validator.
2. **A second LLM "FAQ-answerer" layer.** The engine answers; the LLM proposes interpretations.
3. **A database-backed catalog.** Decision matrix §3.F — premature; conditions documented in §5.
4. **A catalog admin UI.** No product-owner authoring surface today; building one is unjustified.
5. **A "Chat v2" rewrite.** The cc17b75c stack stays; this is consolidation, not replacement.
6. **LangChain / CrewAI / AutoGen / new orchestration framework.** Out of scope.
7. **Redis or new caching layer.** SQLite is the backend; cache layers (oauth-store LRU, swr) are sufficient.
8. **A new provider/auth stack.** OAuth flows are stable; no changes.
9. **Renaming `chat-action-planner.ts` to `chat-orchestrator-v2.ts`** (or similar). Names are stable; behavior changes; references stay valid.
10. **Migrations.** No new SQL files until Phase 4 (telemetry report writes to existing tables; new tables are out of scope).

---

## Dependencies & ordering

```
Phase 0  ──────►  Phase 1  ──────►  Phase 2  ──────►  Phase 3  ──────►  Phase 5
   │                  │                  │                  │
   │                  │                  │                  ├─────► Phase 4 (parallel)
   │                  │                  │                  │
   │                  │                  └─ depends on ─────┘
   │                  │
   │                  └─ requires Phase 0 deliverables
   │
   └─ requires pre-phase decisions (esp. command-like title policy)
```

Phase 4 can run in parallel with Phase 3 once telemetry data is sufficient (≥ 30 days at ≥ 10% sample). Phase 5 promotion of any individual action requires Phase 3 wiring complete for that action.

---

## Migration risks (codebase-wide)

- **Cross-cutting**: Removing the `chat-pending-confirmations.ts` legacy store touches every caller of pending-confirmation semantics. Audit caller list before deletion.
- **Capability-registry merge**: callers of `ChatSkillCapability` API need to read from `ChatActionDefinition` fields instead. Migration helper `getCapabilityFromAction(action: ChatActionDefinition): ChatSkillCapability` preserves API shape during transition; deprecated after one release.
- **Manifest deletion**: ensure no portal or test reads `src/skills/<skill>/manifest.json`. The `getSkillCatalog` REST endpoint reads from `DEFAULT_SKILLS`, not from manifests, but verify.
- **Skill promotion to DEFAULT_SKILLS**: adding `connections`, `notifications`, `decision_center` to `DEFAULT_SKILLS` changes the response shape of `GET /api/v1/skills/catalog`. iOS clients should treat this as additive (new entries appear); but verify iOS does not assume a fixed skill count.

---

## Success metrics (end-state — measured at Phase 5 stabilization)

| Metric | Baseline (now) | Target (post-rollout) | Measurement |
|---|---|---|---|
| `examples` populated per action | 1/45 = 2.2% | ≥ 80% (top-priority 36 of 45) | Registry completeness test |
| Files containing per-skill phrase regexes | 5-7 per skill | 1 per skill (action definition) | `rg -l <phrase>` per skill |
| Number of skill-metadata registries | 3 (skill-config + chat-action-registry + chat-skill-capability-registry) | 1 (consolidated chat-action-registry) | File existence |
| Skills in `DEFAULT_SKILLS` | 5 | 8 (5 + 3 promoted orphans) | Test assertion |
| Planner LOC | 4336 | ≤ 2000 | `wc -l` |
| Tuple-shorthand registry entries | 35/45 | 0/45 | Lint script |
| Hand-maintained smoke fixtures | 180 | ≤ 100 (rest registry-derived) | Fixture count by source |
| macroActionPrecision | ≥ 0.98 (smoke gate) | ≥ 0.98 (production canary) | Production telemetry post-canary |
| Wrong-entity rate | ≤ 0.005 (smoke gate) | ≤ 0.005 (production) | Production telemetry |
| Time-to-add-new-Portuguese-intent | 2-3 file edits | 1 example-block addition | Engineer self-report |

---

## Cross-references

- Architecture audit: [`skill_interaction_catalog_architecture_audit.md`](skill_interaction_catalog_architecture_audit.md)
- Decision matrix: [`skill_interaction_catalog_decision_matrix.md`](skill_interaction_catalog_decision_matrix.md)
- Schema proposal: [`skill_interaction_catalog_schema_proposal.md`](skill_interaction_catalog_schema_proposal.md)
- Eval plan: [`skill_interaction_catalog_eval_plan.md`](skill_interaction_catalog_eval_plan.md)
- Security review: [`skill_interaction_catalog_security_review.md`](skill_interaction_catalog_security_review.md)
- Independent QA prompt: [`claude_code_qa_prompt_for_catalog_plan.md`](claude_code_qa_prompt_for_catalog_plan.md)
