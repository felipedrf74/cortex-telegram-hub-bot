# Chat Action Registry — Phase 7 Catalog Snapshot

_Generated 2026-05-15 (Phase 7: closed 5 deferred follow-ups + 2 new automation batches)._
_Builds on Phase 6 ([phase-6-catalog-snapshot.md](phase-6-catalog-snapshot.md))._

## Summary

| Metric | Phase 6 | Phase 7 | Δ |
|---|---|---|---|
| Total active actions | 45 | 45 | — |
| Total examples | 195 | 205 | +10 EN paraphrases |
| Multi-turn examples | 4 | 4 | — |
| State-required scenarios | 14 | 17 | +3 (cooking pending continuation) |
| Cross-skill confusion fixtures (EN+PT) | 25 + 12 | 25 + 20 | +8 PT |
| Past-tense detector cases | 42 | 45 | +3 (PT-PT perfect compound) |
| Real-eval CI gate tests | 0 | 6 | new |
| Cross-tenant alerting hook tests | 0 | 9 | new |
| Adversarial example proposer tests | 0 | 8 | new |
| Repo-wide tests | 8099 | 8136 | +37 |
| Test files | 555 | 558 | +3 |
| Skipped tests | 0 | 0 | — |

## Closed deferred items (audited from prior phases)

### From Phase 5 candidates

- **Past-tense detector PT-BR perfect compound** (Phase 5 candidate #6) — added `tenho pago`, `tenho marcado`, `andei mandando` patterns. 3 new positive cases pinned in stress test.

### From Phase 6 candidates

- **More PT confusion axes (12 → 20)** — added 8 new PT confusion fixtures covering training_coach_report, reflow preview/confirm, decision_choose, finance_summary, connections_retry_sync, notification_create_intent, content_rewrite.
- **Real-eval scoring CI gate** — Phase 6 added the scorer; Phase 7 promotes it to CI threshold-locking tests (`registry-real-eval-gates.test.ts`):
  - Golden ≥ 95%
  - Prompt-injection ≥ 95%
  - Adversarial ≥ 95%
  - Combined safety ≥ 95%
  - Per-skill golden ≥ 90%
  - Mean score ≥ 1.8 / 2.0
- **Telemetry-driven adversarial example proposer** — new `src/services/registry-adversarial-example-proposer.ts` cross-references the adversarial-discovery output with the registry's safety-example bank. Surfaces uncovered actions with telemetry-observed refusal volume.

### From coverage audit

- **EN paraphrase coverage gap** — 25 actions had only one EN golden example. Phase 7 added 10 new EN paraphrases covering update_event, move_event, mail_inbox_summary, complete_task, training_coach_report, training_adjust_plan, content_schedule_work, content_pipeline_handoff, cooking_meal_support, finance_payment_action.

## Phase 7 new batches

### Batch 36 — Cooking pending-meal-plan continuation

[src/services/chat-action-planner.ts](../../../src/services/chat-action-planner.ts) — added `buildPendingCookingMealPlanContinuation` that mirrors the existing training continuation:

```typescript
// When a pending cooking_meal_plan is active and the user's next message
// supplies dietary constraints ("high-protein, vegetarian", "vegetariano e
// baixo em carbo"), apply them as additional args and re-emit the plan.
```

Recognised constraint vocabulary: `vegetarian|vegan|high-protein|low-carb|keto|paleo|mediterranean|whole30|gluten-free|dairy-free|nut-free`, plus negations (`no fish|no pork|no dairy|...`) and PT equivalents (`vegetariano|vegano|rico em proteína|baixo em carbo|sem peixe|sem glúten`).

The continuation does NOT invent constraints — if the user's turn contains no recognised constraint vocabulary, it returns null and the planner falls through to other paths.

### Batch 37 — Cross-tenant adversarial alerting hook

[src/services/registry-cross-tenant-alert-hook.ts](../../../src/services/registry-cross-tenant-alert-hook.ts):

- `AlertChannel` interface — every channel implements `id`, `minSeverity`, `send(payload)`.
- `dispatchCrossTenantAlerts(patterns, channels, opts)` — fans out cross-tenant patterns to all registered channels above the severity threshold; supports shadowMode for dry-run.
- `formatAlertPayload(pattern, generatedAt)` — pure function building the alert shape.
- `RecordingAlertChannel` — in-memory channel implementation for tests / shadow validation.

Per-channel error isolation: if one channel throws, other channels still receive their alerts; the error is captured in the per-channel result.

## New tooling reference

| Module | Purpose |
|---|---|
| [registry-telemetry-report.ts](../../../src/services/registry-telemetry-report.ts) (Phase 4) | Per-action latency / clarification / failure summary |
| [registry-adversarial-discovery.ts](../../../src/services/registry-adversarial-discovery.ts) (Phase 5+6) | Refusal-pattern clustering, per-tenant + cross-tenant |
| [registry-readable-intents-proposer.ts](../../../src/services/registry-readable-intents-proposer.ts) (Phase 5) | Coverage-gap detection vs clarification volume |
| [registry-driven-eval-scenarios.ts](../../../src/services/registry-driven-eval-scenarios.ts) (Phase 4) | Builds ChatEvalScenario from registry |
| [registry-real-eval-scoring.ts](../../../src/services/registry-real-eval-scoring.ts) (Phase 6) | Planner-trace-based scenario scoring |
| [registry-adversarial-example-proposer.ts](../../../src/services/registry-adversarial-example-proposer.ts) (Phase 7) | Suggests registry-example shapes from telemetry refusal clusters |
| [registry-cross-tenant-alert-hook.ts](../../../src/services/registry-cross-tenant-alert-hook.ts) (Phase 7) | Routes cross-tenant patterns to configured alert channels |
| [scripts/registry-feedback-report.ts](../../../scripts/registry-feedback-report.ts) (Phase 6) | CLI wrapper composing telemetry / adversarial / proposer reports |

## Parser refinements in Phase 7

- **Past-tense detector** (`src/services/skills/past-tense-detector.ts`) — added PT-PT perfect compound (`tenho pago/marcado/...`) + PT-BR continuous past (`andei mandando/marcando/...`).
- **Finance parser** — reminder verb set extended to recognise PT-PT enclitic `lembra-me`.
- **Decision parser** — `snooze|adiar` → `snooze|adia[r]?` for PT imperative.
- **Connections parser** — sync-with-provider regex prefix list extended with article forms (`o`, `a`, `os`, `as`, `um`, `uma`, `meu`, `minha`, `my`, `the`) so "Sincroniza o Google Calendar" routes correctly.
- **Cooking parser** — gate extended with EN meal names (`dinner|lunch|breakfast|snack|supper|brunch`) so "What should I have for dinner tonight" routes.
- **Training parser** — adjust-plan verb set extended with `tighten up|loosen up|dial back|scale back` English coaching idioms.
- **Content parser** — `queue` added as content-scheduling verb.
- **Complete-task-by-mark parser** — `tick off|check off` added as informal completion verbs.

## Phase 8 candidates (future work)

1. **More planner-state pending-continuations** — Phase 7 added cooking; remaining skills (mail draft refinement, content brief continuation, decision_choose with sub-options, finance categorize-receipt with category-only second turn) still need state-aware planner paths.
2. **Real channel implementations** for cross-tenant alert hook (PagerDuty, Slack, Telegram bot, email). Phase 7 ships only `RecordingAlertChannel` for testing.
3. **Past-tense detector POS-aware variant** (Phase 5 candidate, still open) — current regex-based heuristic; lightweight POS tagging could improve precision.
4. **More adversarial classes** — current 9; want supply-chain compromise via fake CA, social-engineering pretexting, prompt-injection-via-uploaded-attachment.
5. **Examples-as-living-test-corpus** — telemetry-driven promotion/demotion of registry examples based on observed routing accuracy.
6. **Multi-language confusion fixtures** — PT-PT + PT-BR done; consider Spanish (Felipe's secondary market).
7. **State-required harness for decision_choose with sub-options** — currently no scenarios.
8. **CI-gate dashboard surface** — promote real-eval pass rates + cross-tenant alert counts into the existing cannot-skip-gate-dashboard.

## Files changed in Phase 7

### Source

- [src/services/chat-action-planner.ts](../../../src/services/chat-action-planner.ts) — added `buildPendingCookingMealPlanContinuation`; extended several parsers for new paraphrases.
- [src/services/skills/past-tense-detector.ts](../../../src/services/skills/past-tense-detector.ts) — PT-PT perfect compound + PT-BR continuous past.
- [src/services/skills/training/parser.ts](../../../src/services/skills/training/parser.ts) — tighten/loosen up adjust-plan verbs.
- [src/services/skills/content/parser.ts](../../../src/services/skills/content/parser.ts) — queue verb.
- [src/services/skills/cooking/parser.ts](../../../src/services/skills/cooking/parser.ts) — EN meal names in gate.
- [src/services/skills/finance/parser.ts](../../../src/services/skills/finance/parser.ts) — `lembra-me` enclitic.
- [src/services/skills/decision_center/parser.ts](../../../src/services/skills/decision_center/parser.ts) — `adia[r]?` imperative.
- [src/services/skills/connections/parser.ts](../../../src/services/skills/connections/parser.ts) — article-form prefix list.
- [src/services/registry-adversarial-example-proposer.ts](../../../src/services/registry-adversarial-example-proposer.ts) — NEW.
- [src/services/registry-cross-tenant-alert-hook.ts](../../../src/services/registry-cross-tenant-alert-hook.ts) — NEW.
- [src/services/chat-action-registry.ts](../../../src/services/chat-action-registry.ts) — 10 new EN paraphrase examples.

### Tests

- [__tests__/services/past-tense-detector-stress.test.ts](../../../__tests__/services/past-tense-detector-stress.test.ts) — +3 perfect-compound positive cases.
- [__tests__/services/chat-action-pt-confusion.test.ts](../../../__tests__/services/chat-action-pt-confusion.test.ts) — +8 confusion fixtures (total 20 PT axes).
- [__tests__/services/registry-real-eval-gates.test.ts](../../../__tests__/services/registry-real-eval-gates.test.ts) — NEW. 6 CI-threshold tests.
- [__tests__/services/registry-adversarial-example-proposer.test.ts](../../../__tests__/services/registry-adversarial-example-proposer.test.ts) — NEW. 8 proposer tests.
- [__tests__/services/registry-cross-tenant-alert-hook.test.ts](../../../__tests__/services/registry-cross-tenant-alert-hook.test.ts) — NEW. 9 dispatcher tests.
- [__tests__/services/chat-action-registry-state-required-parity.test.ts](../../../__tests__/services/chat-action-registry-state-required-parity.test.ts) — +3 cooking pending-continuation scenarios.
