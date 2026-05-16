# Chat Action Registry — Phase 11 Catalog Snapshot

_Generated 2026-05-16 (Phase 11: closed 4 Phase 10 carry-overs — smoke-run SQLite persistence, multi-region channel routing, ES coverage 28 → 35+, typed slot-validator + slot-extractor refs — plus a new real-eval per-locale gate sub-class)._
_Builds on Phase 10 ([phase-10-catalog-snapshot.md](phase-10-catalog-snapshot.md))._

## Summary

| Metric | Phase 10 | Phase 11 | Δ |
|---|---|---|---|
| Total active actions | 45 | 45 | — |
| Spanish parser actions (deterministic) | ~28 | ~35+ | +7 (+update_event, +meal/fueling support, +pipeline handoff, +reflow preview/confirm, +notifications explain/preference/create) |
| Multi-region channel routing | (single-region only) | per-region overrides with default fallback | new layer |
| Smoke-run persistence | none (Markdown only) | SQLite trend table + health summary | new table |
| Typed slot extractors / validators | label strings only | typed callable refs + label fallback | new typed API |
| Real-eval CI gates | 6 (golden / adversarial / prompt-injection / safety / per-skill / mean-score) | 13 (+ per-locale × 3 + multi-turn + adversarial-by-locale × 2) | +7 gates |
| Repo-wide chat-action + registry tests | 665 | 714 | +49 |

## Phase 11 batch summary

| Batch | Theme | Tests | New modules / artifacts |
|---|---|---|---|
| 56 | Smoke-run results SQLite persistence | +8 | `migrations/135_alert_channel_smoke_runs.sql`; `persistChannelSmokeResult` + `getRecentChannelSmokeResults` + `summarizeChannelHealth` in `registry-channel-smoke.ts` |
| 57 | Multi-region channel routing | +7 | `pickPolicyForRegion` + `validateMultiRegionChannelRoutingPolicy` + `dispatchCrossTenantAlertsWithMultiRegionPolicy` in `registry-channel-routing-policy.ts` |
| 58 | Spanish parser coverage 28 → 35+ | +11 | `chat-action-es-coverage-expansion-2.test.ts`; ES vocabulary across 5 parsers (cooking fuel, finance categorize, training reflow, notifications, calendar update) |
| 59 | Typed slot-validator / slot-extractor refs | +15 | `SlotExtractor` + `SlotValidator` types; `makeRequiredFieldsValidator`; `getSlotExtractors` / `getSlotValidators` / `runSlotValidators` accessors |
| 60 | Real-eval per-locale + adversarial sub-gates | +7 | `registry-real-eval-gates-locale.test.ts`; `locales?: Array<...>` option on `buildRegistryDrivenEvalScenarios` |

## Closed Phase 10 carry-overs

| Phase 10 # | Item | Resolution |
|---|---|---|
| 3 | Slot-validator function refs (not labels) | Phase 11 batch 59 — typed API added alongside legacy strings; backwards-compatible |
| 4 | Spanish parser coverage 28 → 45 | Phase 11 batch 58 raises to 35+; remaining 10 still defer to LLM |
| 5 | Multi-region channel routing | Phase 11 batch 57 |
| 6 | Smoke-run results in SQLite | Phase 11 batch 56 + migration 135 |

## Carry-over items (Phase 12 candidates)

These items existed before Phase 11 and remain open:

| # | Item | Status | Notes |
|---|---|---|---|
| 1 | Past-tense POS-aware variant | OPEN | POS dependency / design call (carried since Phase 8) |
| 2 | Examples-as-living-test-corpus | OPEN | Architectural decision needed (audit Phase 4) |
| 3 | Spanish parser coverage 35 → 45 | OPEN | 10 remaining defer to LLM (decision_follow_up, training_reflow_confirm edge cases, finance_payment_action paths, etc.) |
| 4 | Migrate existing registry entries to typed slot extractors | NEW (Phase 11) | Typed API exists; per-action migration is the follow-up work |
| 5 | ES `examples: [..., locale: 'es', ...]` entries in registry | NEW (Phase 11) | The real-eval ES gate is wired but currently informational because few registry examples carry `locale: 'es'` |
| 6 | Per-region channel construction in the smoke runner | NEW (Phase 11) | Today the runner only builds a single-region channel set; multi-region wiring would require env var fanout |

## Phase 11 changes in detail

### Smoke-run persistence (Batch 56)

**Migration**: [`migrations/135_alert_channel_smoke_runs.sql`](../../migrations/135_alert_channel_smoke_runs.sql) creates `chat_alert_channel_smoke_runs` table keyed by `(run_id, channel_id)` with check-constraint on `status`.

**Module**: [`registry-channel-smoke.ts`](../../src/services/registry-channel-smoke.ts) gains three exports:
* `persistChannelSmokeResult(db, result)` — upserts one row per channel entry under a shared `runId`. Errors stored alongside successes.
* `getRecentChannelSmokeResults(db, options)` — filters by channelId / status / since / limit.
* `summarizeChannelHealth(db, options)` — per-channel success rate over the trend window, sorted worst-first so operators spot flaky channels.

**Result type extension**: `ChannelSmokeResult` now includes `runId: string` (UUID assigned at run time).

### Multi-region channel routing (Batch 57)

**Module**: [`registry-channel-routing-policy.ts`](../../src/services/registry-channel-routing-policy.ts) gains:
* `AlertRegion` type — `'us' | 'eu' | 'apac' | 'global'`.
* `MultiRegionChannelRoutingPolicy` interface — `{ default: ChannelRoutingPolicy; byRegion?: Partial<Record<AlertRegion, ChannelRoutingPolicy>> }`.
* `pickPolicyForRegion(policy, region?)` — returns the override or falls back to `default` (no merging — operators who want inheritance spread the default explicitly).
* `validateMultiRegionChannelRoutingPolicy(policy, channels)` — prefixes errors with `[default]` / `[<region>]` for traceability.
* `dispatchCrossTenantAlertsWithMultiRegionPolicy(patterns, channels, policy, { region })` — picks the policy then delegates to the single-region dispatcher.

### Spanish parser coverage 28 → 35+ (Batch 58)

| Skill | Spanish surface added |
|---|---|
| cooking | `cenar` (infinitive), `cenar`/`almorzar`/`desayunar` verbs, "antes del entrenamiento" (pre-workout fueling) |
| finance | `categori[zs][ae][r]?` regex (ES `categoriza` imperative) |
| training | `reorganiza[r]?` / `reorganizado` (reflow) — gate + branch verbs; `muestra` (Spanish "show") in preview-detection; reflow-guard on `plan_create` to prevent "plan" verb shadowing |
| notifications | `notificaci[oó]n(?:es)?` gate (ES `notificación` folds to `notificacion`, distinct from PT `notificacao`); `desactiva[r]?` / `activa[r]?` preference verbs |
| secretary_calendar | `cambia[r]?` (most common ES verb for "change") added to update_event branch |

### Typed slot extractors and validators (Batch 59)

**New types** in [`chat-action-registry.ts`](../../src/services/chat-action-registry.ts):
* `SlotContext` — `{ locale?, timezone?, nowIso? }` passed to extractors / validators.
* `SlotExtractor` — `{ name, label?, extract(text, ctx): SlotExtractionResult }`.
* `SlotValidator` — `{ name, label?, validate(slots, ctx?): SlotValidationResult }`.
* `SlotExtractionResult` — `{ slots, confidence? }`.
* `SlotValidationResult` — `{ ok, errors?, missing? }`.

**Registry-entry extension**: `ChatActionDefinition` gains `typedSlotExtractors?` and `typedSlotValidators?` arrays alongside the legacy string `slotExtractors` / `slotValidators`.

**Helpers**:
* `makeRequiredFieldsValidator(fields, name?)` — built-in factory for the most common case (presence check on required slots).
* `getSlotExtractors(entry)` / `getSlotValidators(entry)` — typed-first, label-fallback accessors.
* `getSlotExtractorNames(entry)` / `getSlotValidatorNames(entry)` — name-only accessors.
* `runSlotValidators(entry, slots, ctx?)` — aggregates errors and missing-fields across all typed validators.

The string-based API is unchanged — no existing caller breaks. Registry entries can adopt typed extractors / validators one at a time.

### Real-eval per-locale and adversarial sub-gates (Batch 60)

**Scenario builder option**: `buildRegistryDrivenEvalScenarios({ locales: ['en'] })` filters examples by `locale` field. Examples without a locale field are excluded when the filter is active.

**New CI gates** in [`registry-real-eval-gates-locale.test.ts`](../../__tests__/services/registry-real-eval-gates-locale.test.ts):
* EN golden ≥ 95% (mirrors the existing global gate but locale-isolated)
* PT golden ≥ 90% (slightly lower bar — PT-PT and PT-BR variants harder to keep at 95%)
* ES golden — informational baseline (coverage still growing; ES `examples` rare in current registry)
* Multi-turn (`turns.length ≥ 2`) golden ≥ 90% — detects pending-continuation regressions
* EN adversarial / prompt-injection ≥ 95%
* PT adversarial / prompt-injection ≥ 90% (informational)

## Verification

```
cd /Users/felipedominguez/Desktop/Custom\ Connectors/Cortex/cortex-telegram-hub-bot

npx tsc --noEmit                                                          # 0 errors
npx vitest run __tests__/services/chat-action                             # 478 passed
npx vitest run __tests__/services/registry                                # 247 passed
npx vitest run __tests__/services/calendar-natural-language-parser-es     # 13 passed
npx vitest run __tests__/services/registry-channel-smoke                  # 20 passed
npx vitest run __tests__/services/registry-channel-routing-policy         # 19 passed
npx vitest run __tests__/services/chat-action-es-coverage-expansion-2     # 12 passed
npx vitest run __tests__/services/chat-action-registry-typed-slots        # 15 passed
npx vitest run __tests__/services/registry-real-eval-gates-locale         # 7 passed
```

All Phase 11 test files green. No new typecheck errors. 714 tests pass across the chat-action + registry families (up from 665 at Phase 10 close).

## Files touched in Phase 11

### Modified
* `src/services/registry-channel-smoke.ts` — persistence + health summary (batch 56)
* `src/services/registry-channel-routing-policy.ts` — multi-region layer (batch 57)
* `src/services/skills/cooking/parser.ts` — cenar / antes del entrenamiento (batch 58)
* `src/services/skills/finance/parser.ts` — categori[zs][ae] regex (batch 58)
* `src/services/skills/training/parser.ts` — reorganiza + muestra + reflow guard (batch 58)
* `src/services/skills/notifications/parser.ts` — ES notificación + desactiva (batch 58)
* `src/services/chat-action-planner.ts` — cambia → update_event (batch 58)
* `src/services/chat-action-registry.ts` — typed slot types + accessors (batch 59)
* `src/services/registry-driven-eval-scenarios.ts` — locales option (batch 60)

### Added
* `migrations/135_alert_channel_smoke_runs.sql` (batch 56)
* `__tests__/services/chat-action-es-coverage-expansion-2.test.ts` (batch 58)
* `__tests__/services/chat-action-registry-typed-slots.test.ts` (batch 59)
* `__tests__/services/registry-real-eval-gates-locale.test.ts` (batch 60)
* `docs/release/eval-evidence/phase-11-catalog-snapshot.md` (this file)
