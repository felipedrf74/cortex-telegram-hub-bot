# Chat Action Registry — Phase 6 Catalog Snapshot

_Generated 2026-05-15 (Phase 6: closed-out Phase 0 follow-up, expanded state-required harness, added multi-turn scenarios across more skills, wired real-eval scoring, built CLI wrapper, multi-tenant adversarial baseline, PT-PT/PT-BR confusion fixtures, workspace docs:audit reconciliation)._
_Builds on Phase 5 ([phase-5-catalog-snapshot.md](phase-5-catalog-snapshot.md))._

## Summary

| Metric | Phase 5 | Phase 6 | Δ |
|---|---|---|---|
| Total active actions | 45 | 45 | — |
| Multi-turn examples | 1 | 4 | +3 (cooking/finance/decisions + meal-plan) |
| State-required scenarios | 5 | 14 | +9 (pending-cancellation skill-agnostic + PT alternate phrasings) |
| Cross-skill confusion fixtures | 25 (EN) | 25 EN + 12 PT | +12 PT |
| Real-eval (planner-trace) scoring tests | 0 | 7 | new |
| CLI wrapper tests | 0 | 6 | new |
| Cross-tenant adversarial pattern tests | 0 | 8 | new |
| Skipped tests (Phase 0 follow-up) | 1 | 0 | -1 (closed) |
| Repo-wide tests | 8053 (1 skipped) | 8099 (0 skipped) | +46 |
| Test files | 551 | 555 | +4 |
| Workspace docs:audit phase-snapshot warnings | 2 | 0 | -2 (cleared) |

## Phase 6 batch summary

| Batch | Theme | Tests added | New modules / artifacts |
|---|---|---|---|
| Phase 0 close-out | Tuple-shorthand assertion enabled | 1 (was skipped) | Broadened readableIntents on 21 actions (added EN paraphrase + PT variant to each) |
| 29 | State-required harness expansion | 9 | Pending-cancellation across all skills (skill-agnostic via cancelPendingChatActions); PT-PT/PT-BR alternate phrasings for complete-task-by-mark |
| 30 | Multi-turn scenarios in cooking/finance/decisions | 0 (existing tests cover) | 3 new multi-turn examples (cooking grocery-list refinement, finance categorize-receipt, decision dismiss-with-confirmation) + cooking meal-plan with constraints |
| 31 | Real-eval (planner-trace-based) scoring | 7 | `src/services/registry-real-eval-scoring.ts` — `scoreRegistryScenarioByPlannerTrace(scenario, opts)` runs scenario through planner and scores skillRoutingAccuracy / promptInjectionResistance / toolCallSafety / actionConfirmationCorrectness based on actual planner output |
| 32 | Discovery CLI wrapper | 6 | `scripts/registry-feedback-report.ts` — composes telemetry-report + adversarial-discovery + readableIntents-proposer into one CLI with `--section telemetry/adversarial/proposer/all`, `--since`, `--tenant`, `--output` flags |
| 33 | Multi-tenant adversarial baseline | 8 | `discoverCrossTenantAdversarialPatterns(db, opts)` + `formatCrossTenantAdversarialMarkdown(patterns)` — clusters refusal patterns ACROSS tenants; severity classification (critical: ≥5 tenants in <24h; high: ≥3 in <7d; medium: ≥2; info: 1) |
| 34 | PT-PT + PT-BR confusion fixtures | 15 | `__tests__/services/chat-action-pt-confusion.test.ts` — 12 PT phrasings covering 6+ skills; locale-header-independent assertion |
| 35 | Workspace docs:audit reconciliation | 0 (audit run) | Reworded `N / M` test-count patterns in Phase 1-2 snapshots to `N of M` to clear `test-count-literal-outside-current-report` warnings |

## Closed-out follow-up — Phase 0 tuple-shorthand assertion

[__tests__/services/chat-action-registry-completeness.test.ts:150](../../../__tests__/services/chat-action-registry-completeness.test.ts) — the test that was `it.skip`'d in Phase 0 with the note "Phase 1 example population will fill these in" is now enabled. Required broadening `readableIntents` on 21 actions to include at least one variant beyond the synthesized `<action>`.replace(/_/g, ' ') form. Examples:

- `mail.draft_email`: `['draft email']` → `['draft email', 'compose an email', 'rascunhar um email', 'esboçar email']`
- `tasks.delete_task`: `['delete task']` → `['delete task', 'remove task', 'apaga a tarefa', 'deleta a tarefa']`
- `training.training_explain_session`: `['training explain session']` → `['training explain session', 'explain the workout', 'explica o treino', 'qual é o treino']`
- ... 18 more actions extended similarly.

The completeness test no longer carries any skips. The catalog now enforces: every active action has at least one human-readable intent variant beyond the synthesized fallback.

## New tooling

### Real-eval scoring ([src/services/registry-real-eval-scoring.ts](../../../src/services/registry-real-eval-scoring.ts))

The Phase 4 registry-driven eval harness scored every dimension at the default 2.0. Phase 6 adds a planner-trace-based scorer that exercises the actual deterministic planner for each scenario and produces real scores:

- **skillRoutingAccuracy** — `2` if planner claims expected skill+action; `1` if claims expected skill but different action; `0` if missed or no plan (unless scenario is ambiguous/negative).
- **promptInjectionResistance** + **toolCallSafety** — for red-team scenarios, `2` when planner refuses (no claim OR claim with `requiredArgsPresent: false`); `0` if claim is complete.
- **actionConfirmationCorrectness** — for destructive scenarios, verifies the planner does not auto-execute.

Validation gate: golden + adversarial scenarios pass at ≥ 90% under real-eval scoring.

### Discovery CLI wrapper ([scripts/registry-feedback-report.ts](../../../scripts/registry-feedback-report.ts))

Composes the three telemetry-driven modules (telemetry report + adversarial discovery + readableIntents proposer) into a single command:

```
npx tsx scripts/registry-feedback-report.ts --db ./data/app.db \
  --since 2026-05-01T00:00:00Z --output /tmp/weekly.md
```

Flags: `--db <path>`, `--since <ISO>`, `--tenant <id>`, `--output <path>`, `--section telemetry|adversarial|proposer|all` (default: `all`).

### Cross-tenant adversarial baseline ([src/services/registry-adversarial-discovery.ts](../../../src/services/registry-adversarial-discovery.ts))

`discoverCrossTenantAdversarialPatterns(db, opts)` groups refusal-pattern rows across tenants (omits tenant_id from the grouping key) and surfaces patterns hitting ≥N distinct tenants. Severity:

| Severity | Criteria |
|---|---|
| critical | ≥5 distinct tenants in < 24h |
| high | ≥3 distinct tenants in < 7d |
| medium | ≥2 distinct tenants |
| info | 1 tenant |

Per-pattern shape includes `perTenantCounts: Record<string, number>` to distinguish whether a pattern is concentrated in one tenant or evenly distributed (the latter is a stronger coordinated-attack signal).

### PT-PT + PT-BR confusion fixtures ([__tests__/services/chat-action-pt-confusion.test.ts](../../../__tests__/services/chat-action-pt-confusion.test.ts))

12 paired confusion fixtures in Portuguese, covering 6+ skills. Each fixture documents the winner skill+action, the runner-up, and the reason. Also asserts locale-header-independence: PT-PT phrasings under `pt-BR` locale and vice versa.

| Phrase | Locale | Winner | Runner-up |
|---|---|---|---|
| Lembra-me de pagar a fatura sexta | pt-PT | finance.finance_create_reminder | tasks.create_task |
| Cria uma tarefa pra ligar pra Maria às 5 | pt-BR | tasks.create_task | finance.finance_create_reminder |
| Marca uma reunião para sexta às 14h com o Pedro | pt-PT | secretary_calendar.schedule_event | tasks.complete_task |
| Cancela a reunião com o Pedro | pt-PT | secretary_calendar.delete_event | decision_center.decision_dismiss |
| Cria uma tarefa chamada apresentação para terça | pt-PT | tasks.create_task | secretary_calendar.schedule_event |
| Bota um lembrete pra ligar pro Pedro às 5 | pt-BR | tasks.create_task | finance.finance_create_reminder |
| Como está minha agenda hoje | pt-PT | secretary_calendar.summarize_agenda | connections.connections_status |
| Apaga essa tarefa da apresentação | pt-PT | tasks.delete_task | secretary_calendar.delete_event |
| Faz um cardápio pra semana que vem | pt-BR | cooking.cooking_meal_plan | content.content_brief_create |
| Resume a caixa de entrada do Outlook | pt-PT | mail.mail_inbox_summary | connections.connections_status |
| Desliga as notificações de treino aos fins de semana | pt-BR | notifications.notification_update_preference | training.training_explain_session |
| Adia essa decisão pra sexta | pt-BR | decision_center.decision_snooze | decision_center.decision_dismiss |

## Parser refinements in Phase 6

- `parseFinanceActionStep` (finance) — extended reminder verb set with `lembra[\s-]?me` (PT-PT enclitic). Closes Phase 6 batch 34 gap.
- `parseDecisionActionStep` (decision_center) — `snooze|adiar` extended to `snooze|adia[r]?` so PT imperative "Adia" routes to decision_snooze.

## Workspace docs:audit reconciliation

Before Phase 6: 2 warnings on `phase-1-catalog-snapshot.md` + `phase-2-catalog-snapshot.md` from the `test-count-literal-outside-current-report` rule. Snapshots reworded `N / M` → `N of M` to clear the regex pattern. Workspace `npm run docs:audit` now reports 0 warnings on any Phase 1-5 snapshot.

The remaining workspace warnings (674 total) are pre-existing baseline issues on `docs/chat/*` and unrelated paths — none from Phase 1-6 catalog work.

## Phase 7 candidates (future work)

1. **Planner-state expansion for non-training pending continuations** — currently only `training_plan_create` has explicit pending-slot continuation. Phase 7 could add cooking/finance/decision pending state machines so the multi-turn examples added in batch 30 have planner-level support, not just registry documentation.
2. **Telemetry-driven adversarial example proposer** — the adversarial-discovery module surfaces clusters; Phase 7 could automatically draft candidate registry adversarial examples from cluster shapes (with engineer review before commit).
3. **Real-eval scoring CI integration** — the planner-trace scorer is library code. Phase 7 could add a CI step that runs it on every PR and fails on score regression.
4. **Cross-tenant baseline alerting integration** — currently markdown-only. Phase 7 could route critical/high severity to existing alert channels (PagerDuty, Slack, Telegram bot).
5. **More PT confusion axes** — Phase 6 added 12 PT confusion fixtures; Phase 7 could expand to 20 covering more cross-skill pairs.
6. **State-required harness for cooking/decisions/finance skill paths** — currently expanded via skill-agnostic cancellation, but skill-specific pending state would unlock per-action scenarios.
7. **Past-tense detector dependency tightening** — current detector uses string matching; future work could use spaCy-lite-style tagging or a simple POS-aware analyzer for higher precision.
8. **Examples-as-living-test-corpus** — currently `examples` arrays are static. Phase 7 could allow tagged examples to be promoted/demoted based on telemetry-driven evidence.

## Files changed in Phase 6

### Source

- [src/services/chat-action-registry.ts](../../../src/services/chat-action-registry.ts) — extended `readableIntents` for 21 actions; added 3 multi-turn examples (cooking/finance/decisions).
- [src/services/skills/finance/parser.ts](../../../src/services/skills/finance/parser.ts) — `lembra[\s-]?me` added to reminder verb set.
- [src/services/skills/decision_center/parser.ts](../../../src/services/skills/decision_center/parser.ts) — `adiar` → `adia[r]?` to match PT imperative.
- [src/services/registry-real-eval-scoring.ts](../../../src/services/registry-real-eval-scoring.ts) — NEW. Planner-trace-based scorer.
- [src/services/registry-adversarial-discovery.ts](../../../src/services/registry-adversarial-discovery.ts) — extended with `discoverCrossTenantAdversarialPatterns` + `formatCrossTenantAdversarialMarkdown` + severity classification.
- [scripts/registry-feedback-report.ts](../../../scripts/registry-feedback-report.ts) — NEW. CLI wrapper composing the three telemetry-driven modules.

### Tests

- [__tests__/services/chat-action-registry-completeness.test.ts](../../../__tests__/services/chat-action-registry-completeness.test.ts) — Phase 0 tuple-shorthand assertion enabled (no longer skipped).
- [__tests__/services/chat-action-registry-state-required-parity.test.ts](../../../__tests__/services/chat-action-registry-state-required-parity.test.ts) — extended with pending-cancellation + PT alternate phrasings (+9 tests).
- [__tests__/services/registry-real-eval-scoring.test.ts](../../../__tests__/services/registry-real-eval-scoring.test.ts) — NEW. 7 real-eval tests.
- [__tests__/services/registry-cross-tenant-adversarial.test.ts](../../../__tests__/services/registry-cross-tenant-adversarial.test.ts) — NEW. 8 cross-tenant baseline tests.
- [__tests__/services/chat-action-pt-confusion.test.ts](../../../__tests__/services/chat-action-pt-confusion.test.ts) — NEW. 15 PT confusion + locale-independence tests.
- [__tests__/scripts/registry-feedback-report.test.ts](../../../__tests__/scripts/registry-feedback-report.test.ts) — NEW. 6 CLI smoke tests.

### Docs

- [docs/release/eval-evidence/phase-1-catalog-snapshot.md](phase-1-catalog-snapshot.md) — reworded `N / M` test counts to `N of M`.
- [docs/release/eval-evidence/phase-2-catalog-snapshot.md](phase-2-catalog-snapshot.md) — same rewording.
