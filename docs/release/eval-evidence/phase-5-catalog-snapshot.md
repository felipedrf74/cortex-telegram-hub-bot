# Chat Action Registry — Phase 5 Catalog Snapshot

_Generated 2026-05-15 (Phase 5: sentence-level past-tense, eval-harness PASS gates, multi-turn fixtures, PT-PT/PT-BR locale-split, telemetry-driven adversarial discovery, readableIntents proposer)._
_Builds on Phase 4 ([phase-4-catalog-snapshot.md](phase-4-catalog-snapshot.md))._

## Summary

| Metric | Phase 4 | Phase 5 | Δ |
|---|---|---|---|
| Total active actions | 45 | 45 | — |
| Total examples | 190 | 191 | +1 (new multi-turn) |
| Multi-turn examples | 0 | 1 | +1 |
| Past-tense detector cases | 37 | 42 | +5 (multi-sentence cases) |
| Cross-skill confusion fixtures | 25 | 25 | — |
| State-required scenarios | 5 | 5 | — |
| Adversarial classes | 9 | 9 | — |
| Eval-harness PASS gate tests | 0 | 8 | new |
| PT-PT vs PT-BR locale-split tests | 0 | 26 | new |
| Telemetry-driven discovery modules | 1 (report) | 3 (report + adversarial + readableIntents) | +2 modules |
| Repo-wide tests | 7994 | 8053 | +59 |
| Test files | 546 | 551 | +5 |

## Phase 5 batch summary

| Batch | Theme | Tests added | New modules / contracts |
|---|---|---|---|
| 23 | past-tense sentence-level scope | 5 multi-sentence cases | `hasPastTenseSignal` now splits on `.!?` boundaries; trips only when EVERY actionable sentence is past-tense; "Já paguei a fatura. Agenda uma reunião pra sexta." now correctly NOT past-tense |
| 24 | eval-harness PASS gates | 8 | `__tests__/services/registry-driven-eval-gates.test.ts` — macro pass rate ≥ 95%, per-tag thresholds (golden 95%, ambiguous 85%, negative 85%, prompt_injection 95%, adversarial 95%), per-skill ≥ 90% |
| 25 | multi-turn fixtures | 4 | `examples[].turns?: string[]` field added; one canonical multi-turn example (training_plan_create pending-continuation); generator propagates `turns` to scenarios |
| 26 | PT-PT vs PT-BR locale-split | 26 | `__tests__/services/pt-pt-vs-pt-br-routing.test.ts` — 12 paired phrasings across 7+ skills, asserting locale-header-independent routing |
| 27 | telemetry-driven adversarial discovery | 10 | `src/services/registry-adversarial-discovery.ts` — `discoverAdversarialCandidates(db, opts)` clusters refusal-pattern rows; classifies single_user_repeat vs distributed_attack |
| 28 | telemetry-driven readableIntents proposer | 6 | `src/services/registry-readable-intents-proposer.ts` — `proposeReadableIntentsExtensions(db, opts)` surfaces actions with undersized readableIntents bank vs clarification volume |

## New safety / quality primitives

### Past-tense sentence-level scope (batch 23)

[src/services/skills/past-tense-detector.ts](../../../src/services/skills/past-tense-detector.ts):

```typescript
export function hasPastTenseSignal(text: string): boolean {
  const sentences = splitIntoSentences(text);
  if (sentences.length <= 1) return hasPastTenseInSingleScope(text);
  let anyActionableSentence = false;
  for (const sentence of sentences) {
    if (!isActionable(sentence)) continue;
    anyActionableSentence = true;
    if (!hasPastTenseInSingleScope(sentence)) return false;
  }
  return anyActionableSentence ? true : hasPastTenseInSingleScope(text);
}
```

Key behaviors locked into the stress test:

- `Já paguei a fatura. Agenda uma reunião pra sexta.` → NOT past (forward sentence dominates)
- `I just paid the bill. Schedule a meeting with Pedro for Friday.` → NOT past (forward dominates)
- `Já paguei a fatura. Já mandei o email pra Maria.` → past (both sentences past)
- `Yesterday was busy. Schedule a meeting for Friday.` → NOT past (past sentence not actionable)
- `I scheduled my dentist yesterday and I just paid the bill` → past (single-sentence multi-construct)

### Eval-harness PASS gates (batch 24)

[__tests__/services/registry-driven-eval-gates.test.ts](../../../__tests__/services/registry-driven-eval-gates.test.ts) — runs the full registry-driven eval suite at CI time and enforces:

| Threshold | Value |
|---|---|
| Macro pass rate (all tags) | ≥ 95% |
| Per-tag pass rate — golden | ≥ 95% |
| Per-tag pass rate — ambiguous | ≥ 85% |
| Per-tag pass rate — negative | ≥ 85% |
| Per-tag pass rate — prompt_injection | ≥ 95% |
| Per-tag pass rate — adversarial | ≥ 95% |
| Per-skill pass rate (10 skills) | ≥ 90% each |

When a registry example added later drops a per-tag or per-skill rate below threshold, this test fails loudly, forcing the engineer to fix routing OR adjust the example deliberately.

### Multi-turn fixture support (batch 25)

[src/services/chat-action-registry.ts](../../../src/services/chat-action-registry.ts) extends the example shape:

```typescript
examples?: Array<{
  text: string;
  // ... existing fields ...
  turns?: string[];  // NEW: optional multi-turn sequence; turns[0] must match text
}>;
```

Canonical multi-turn example in `training.training_plan_create`:

```typescript
{
  text: 'Build me a 10K plan in 12 weeks starting Monday',
  turns: [
    'Build me a 10K plan in 12 weeks starting Monday',
    'It is 20 km a week',
  ],
  condition: 'multi_turn_pending_plan_slot_fill',
  expectedSlots: { sport: 'running', goal: '10k', durationWeeks: 12, weeklyVolumeKm: 20 },
  expectedAction: 'training_plan_create',
}
```

The registry-driven scenario builder propagates `turns` to `ChatEvalScenario.turns[]`, so the eval harness can score multi-turn scenarios correctly.

### PT-PT vs PT-BR locale-split (batch 26)

[__tests__/services/pt-pt-vs-pt-br-routing.test.ts](../../../__tests__/services/pt-pt-vs-pt-br-routing.test.ts) — 12 paired (PT-PT, PT-BR) phrasings tested under BOTH locale headers. Locks the contract that the planner's PT regex set is locale-header-independent.

| PT-PT | PT-BR | Action |
|---|---|---|
| Cria uma tarefa chamada testar chat | Bota uma tarefa chamada ligar pra Maria | tasks.create_task |
| Marca essa tarefa como feita | Marca essa tarefa como concluída | tasks.complete_task |
| Apaga a tarefa da apresentação | Deleta a tarefa da apresentação | tasks.delete_task |
| Apaga o evento da reunião | Cancela a reunião com Pedro | secretary_calendar.delete_event |
| Estou livre sexta das 15h às 16h | Tô livre sexta das 15 às 16 | secretary_calendar.check_calendar_conflicts |
| Envia um email para o Pedro | Manda um e-mail pra felipe | mail.send_email |
| Resumo da caixa de entrada do Outlook | Resume a caixa do Outlook | mail.mail_inbox_summary |
| Rascunhar um email para o Pedro | Esboça um email pro Pedro | mail.draft_email |
| Cria um plano de refeições | Faz um cardápio pra semana que vem | cooking.cooking_meal_plan |
| Desativa as notificações | Desliga as notificações | notifications.notification_update_preference |
| Dispensar essa decisão | Ignora essa decisão | decision_center.decision_dismiss |
| Como está minha conexão com o Outlook? | Como tá a conexão com o Outlook | connections.connections_status |

### Telemetry-driven adversarial discovery (batch 27)

[src/services/registry-adversarial-discovery.ts](../../../src/services/registry-adversarial-discovery.ts):

- `discoverAdversarialCandidates(db, { since, tenantId, minCount })` — clusters telemetry rows whose `failure_reason` matches `prompt_injection_marker_detected` / `embedded_llm_instruction_markers` / `embedded_llm_instruction_markers_pt` / `unsafe_title_destructive_vocabulary` / `rejected_prompt_injection` / `authorization_failure` OR whose `outcome` is `refused`/`rejected`/`denied`/`safety_block`/`unauthorized`.
- Per-cluster shape classification:
  - `single_user_repeat` — one conversation generating all rows (likely benign retry)
  - `distributed_attack` — many distinct conversations (potential coordinated attack)
  - `mixed` — review individually
- `formatAdversarialDiscoveryMarkdown(clusters)` — emits a markdown table with recommendation per cluster.

### Telemetry-driven readableIntents proposer (batch 28)

[src/services/registry-readable-intents-proposer.ts](../../../src/services/registry-readable-intents-proposer.ts):

- `proposeReadableIntentsExtensions(db, { since, tenantId, minVolume, maxCoverageScore })` — computes per-action coverage score as `readableIntents.length / (1 + clarificationVolume)`. Low scores = undersized banks for the clarification volume observed.
- Recommendation builder annotates each proposal:
  - "Add ≥2 paraphrase variants to readableIntents" (when intentsCount ≤ 1)
  - "Add ≥1 golden example covering the common user phrasing" (when examplesCount ≤ 1)
  - "High clarification rate" (when > 50%)
  - "Frequently lands in tier2 (LLM planner)" — likely missing a deterministic parser branch
- `formatReadableIntentsProposalsMarkdown(proposals)` — emits a markdown table sorted by coverage score (lowest = highest priority).

## Phase 5 parser refinements

- Training gate (batch 25) extended with `(?:5|10|21|42|3|15)\s*k\s+plan` and `(?:5|10|21|42|3|15)\s*km\s+plan` bigrams so "Build me a 10K plan in 12 weeks" reaches `parseTrainingActionStep`.
- Past-tense detector internal helpers `splitIntoSentences` + `isActionable` added; preserves backwards-compat single-scope behavior for one-sentence messages.

## Phase 6 candidates (future work)

1. **State-required harness coverage expansion** — currently 5 scenarios. Add one per pending-action class across the 10 skills (currently only training has pending-action examples).
2. **Multi-turn scenarios in cooking/finance/decisions** — current 1 multi-turn example is training-only. Cooking grocery-list confirmation, finance categorize-receipt confirmation, decision-snooze-then-revisit are natural multi-turn flows.
3. **Real-eval scoring of registry scenarios** — current harness uses default 2.0 scores unless red-team/destructive. Phase 6 could plug in actual planner-trace-based scoring (i.e., run each scenario's turns through `buildChatActionPlan` and score against acceptance criteria).
4. **Discovery script CLI** — both adversarial-discovery and readableIntents-proposer are library functions. A CLI wrapper (`scripts/registry-feedback-report.ts`) would let Felipe run them ad-hoc.
5. **Multi-tenant adversarial baseline** — discovery script doesn't yet correlate across tenants. Phase 6 could detect coordinated cross-tenant attacks.
6. **Past-tense detector — PT-BR colloquial constructs** — current PT set covers preterite. Could extend to PT-BR perfect compound (`tenho pago`, `tenho marcado`) — but those are PT-EU; PT-BR rarely uses compound past in casual chat.
7. **Locale-aware confusion fixtures** — Phase 4 cross-skill confusion is mostly EN. Phase 6 could add a PT-PT and PT-BR confusion fixture file.
8. **Workspace docs:audit reconciliation** — Phase 1-5 snapshots live in `docs/release/eval-evidence/`. Confirm none trigger `workspace-mirror-stale` warnings; if any do, decide whether to mirror to the workspace docs root.

## Files changed in Phase 5

### Source

- [src/services/skills/past-tense-detector.ts](../../../src/services/skills/past-tense-detector.ts) — sentence-level scope (splitIntoSentences + isActionable helpers).
- [src/services/skills/training/parser.ts](../../../src/services/skills/training/parser.ts) — gate accepts distance-plan bigrams (5K/10K/21K/42K/3K/15K plan).
- [src/services/chat-action-registry.ts](../../../src/services/chat-action-registry.ts) — examples shape extended with optional `turns?: string[]`; one canonical multi-turn example added.
- [src/services/registry-driven-eval-scenarios.ts](../../../src/services/registry-driven-eval-scenarios.ts) — propagates `turns` from registry to scenarios.
- [src/services/registry-adversarial-discovery.ts](../../../src/services/registry-adversarial-discovery.ts) — NEW. Telemetry clustering for refusal patterns.
- [src/services/registry-readable-intents-proposer.ts](../../../src/services/registry-readable-intents-proposer.ts) — NEW. Coverage-gap proposer.

### Tests

- [__tests__/services/past-tense-detector-stress.test.ts](../../../__tests__/services/past-tense-detector-stress.test.ts) — extended with 5 multi-sentence cases.
- [__tests__/services/registry-driven-eval-gates.test.ts](../../../__tests__/services/registry-driven-eval-gates.test.ts) — NEW. 8 PASS-gate tests.
- [__tests__/services/registry-multi-turn-examples.test.ts](../../../__tests__/services/registry-multi-turn-examples.test.ts) — NEW. 4 multi-turn shape + propagation tests.
- [__tests__/services/pt-pt-vs-pt-br-routing.test.ts](../../../__tests__/services/pt-pt-vs-pt-br-routing.test.ts) — NEW. 26 locale-split tests.
- [__tests__/services/registry-adversarial-discovery.test.ts](../../../__tests__/services/registry-adversarial-discovery.test.ts) — NEW. 10 discovery tests over in-memory SQLite.
- [__tests__/services/registry-readable-intents-proposer.test.ts](../../../__tests__/services/registry-readable-intents-proposer.test.ts) — NEW. 6 proposer tests.
