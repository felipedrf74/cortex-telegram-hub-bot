# Chat Action Registry — Phase 10 Catalog Snapshot

_Generated 2026-05-16 (Phase 10: closed 4 Phase 9 candidates — Spanish calendar NLP, Spanish parser coverage 12→28+, Spanish multi-turn pending continuations, 2 new attack-pattern types, channel routing policy, alert-channel weekly smoke run scaffolding)._
_Builds on Phase 9 ([phase-9-catalog-snapshot.md](phase-9-catalog-snapshot.md))._

## Summary

| Metric | Phase 9 | Phase 10 | Δ |
|---|---|---|---|
| Total active actions | 45 | 45 | — |
| Pending continuations (planner state machines) | 6 | 6 | — |
| State-required scenarios | 28 | 28 | — |
| Cross-tenant attack pattern types | cross_tenant_critical/high/medium/info + low_and_slow + targeted_tenant_repeat | + credential_stuffing_probe + time_of_day_cluster | +2 pattern types |
| Alert channel implementations | 7 (PagerDuty / Slack / Telegram / Discord / Email / Datadog / Opsgenie) | 7 (same) + policy routing layer | — channels, +1 layer |
| Channel routing policies | (per-channel minSeverity only) | `ChannelRoutingPolicy` (per-severity → channelIds[]) | new module |
| Channel smoke-run scaffolding | none | weekly cron script + helper + 12 tests | new module |
| Spanish parser actions (deterministic) | 12 | ~28 (+ schedule_event, +15 expanded) | +16 actions |
| Spanish multi-turn pending continuations | 0 | 6 (all skills) | +6 |
| Spanish calendar NLP | none | weekdays + date words + time prepositions + PM/AM markers + title markers | new |
| Repo-wide tests (chat-action + registry families) | 619 | 781 | +162 |

## Phase 10 batch summary

| Batch | Theme | Tests added | New modules / artifacts |
|---|---|---|---|
| 50 | Spanish calendar-event NLP | +13 | `calendar-natural-language-parser-es.test.ts`; extensions to `calendar-natural-language-parser.ts` (weekdays-first date resolution, Spanish time prepositions, "de la mañana"/"de la tarde" PM/AM markers, "llamado" title marker, implicit-subject fallback) |
| 51 | Spanish parser coverage 12 → 28+ actions | +17 | `chat-action-es-coverage-expansion.test.ts`; ES vocabulary in 6 per-skill parsers (cooking, content, decision_center, connections, mail, training) |
| 52 | Spanish multi-turn pending continuations | +7 | `registry-multi-turn-es-state-injection.test.ts`; Spanish dietary constraints, refinement directives, choice tokens, snooze verbs |
| 53 | Credential-stuffing + time-of-day attack patterns | +12 | `discoverCredentialStuffingProbes` + `discoverTimeOfDayClusters` in adversarial discovery; `registry-credential-stuffing-attacks.test.ts` |
| 54 | Channel routing policy layer | +12 | `registry-channel-routing-policy.ts` (new module); `DEFAULT_ROUTING_POLICY` + `validateChannelRoutingPolicy` + `dispatchCrossTenantAlertsWithPolicy` |
| 55 | Alert-channel weekly smoke run scaffolding | +12 | `registry-channel-smoke.ts` (new helper); `scripts/registry-alert-channel-smoke.ts` (new runner) |

## Closed Phase 9 candidates

| Phase 9 # | Item | Resolution |
|---|---|---|
| 1 | Full Spanish parser coverage (12 → all 45) | Phase 10 batch 51 raises to 28+; remaining 17 still defer to LLM tier |
| 2 | Spanish calendar NLP | Phase 10 batch 50 |
| 3 | Spanish multi-turn pending continuations | Phase 10 batch 52 |
| 4 | More attack-pattern types | Phase 10 batch 53 (credential-stuffing + time-of-day) |

## Carry-over items (Phase 11 candidates)

These items existed at Phase 9 close-out and remain open after Phase 10:

| # | Item | Status | Notes |
|---|---|---|---|
| 1 | Past-tense POS-aware variant | OPEN | POS dependency / design call — sentence-level regex still in place |
| 2 | Examples-as-living-test-corpus | OPEN | Architectural decision needed (audit Phase 4) |
| 3 | Slot-validator function refs (not labels) | OPEN | TypeScript type-tightening; large diff |
| 4 | Spanish parser coverage 28 → 45 (full registry) | OPEN | Diminishing returns vs LLM tier — track activity in es-ES tier-1 fallback rate |
| 5 | Multi-region channel routing (US/EU/APAC) | NEW (Phase 10) | Could extend `ChannelRoutingPolicy` to per-region maps |
| 6 | Smoke-run results table in SQLite | NEW (Phase 10) | Persist `ChannelSmokeResult` rows so trend over weeks is queryable |

## Spanish coverage matrix (Phase 10 end-state)

| Skill | Deterministic ES actions | Defer-to-LLM ES actions |
|---|---|---|
| tasks | create_task, complete_task, delete_task, update_task | (rest) |
| secretary_calendar | schedule_event ¹, delete_event, summarize_agenda (read-intent) | update_event, move_event, list_calendars |
| mail | send_email, draft_email (incl. reply ²), mail_inbox_summary, mail_unread_count | (none) |
| cooking | cooking_meal_plan, cooking_grocery_list | cooking_meal_support, cooking_fueling_support |
| content | content_brief_create, content_script_create, content_rewrite, content_schedule_work | content_pipeline_handoff |
| decision_center | decision_choose, decision_dismiss, decision_snooze | decision_follow_up |
| connections | connections_retry_sync, connections_status, connections_reconnect_guidance | (none) |
| finance | finance_summary, finance_create_reminder | finance_payment_action, finance_categorize_receipt (LLM only) |
| training | training_plan_create, training_adjust_plan, training_explain_session, training_coach_report | training_reflow_preview/confirm |
| notifications | (deferred) | all |

¹ Phase 10 batch 50 added Spanish calendar NLP via `calendar-natural-language-parser.ts` extensions.
² Spanish "Responde al correo" routes through `draft_email` (reply is a kind of draft); no separate `mail_reply` action exists in the registry.

## Phase 10 changes in detail

### Calendar parser (Spanish NLP)

`src/services/calendar-natural-language-parser.ts` extensions:
* WEEKDAYS array: Spanish weekday names (lunes, martes, miércoles, jueves, viernes, sábado, domingo) added alongside PT/EN.
* DATE_WORD_PATTERN: el/la/pasado mañana/mañana date prefixes accepted.
* resolveDate: weekdays checked FIRST (Phase 10 §50.1 invariant — "el lunes" wins over "mañana" inside "de la mañana"). Pasado mañana checked before plain tomorrow. Bare "mañana" excludes occurrences inside "de la mañana"/"por la mañana"/"a la mañana" via folded-text gating.
* parseSingleTime: PM/AM detection runs on un-stripped folded text so "de la tarde"/"de la noche"/"de la mañana" markers survive the preposition strip.
* timeAtom: trailing 'h' suffix made optional (the digit suffix after 'h' is now optional, so "14h" parses without trailing digits) + Spanish PM/AM tail variants.
* hasCalendarObject regex: Spanish "reunión" / "reunion" (folded) + "cita" added.
* extractTitle: "llamado"/"llamada"/"titulado" Spanish title markers added; implicit-subject fallback (returns the calendar noun if no other title is extracted).

### Per-skill parsers (Spanish vocabulary expansion)

| Skill | Spanish surface added |
|---|---|
| cooking | comida[s], cena, almuerzo, desayuno, menú, "lista de la compra", planea, crea + menu |
| content | guion/guión, contenido, publicación, campaña, reescribe, programa, "hacer más corto" |
| decision_center | decisión, opción, elig[eo][r]?, elijo, pospón (imperative trailing-vowel optional), aplazar |
| connections | conexión, integración, proveedor, reconectar, actualizar; corrected fold: `conexi[oó]n` (Spanish ó folds to o, not a — distinct from PT `conex[aã]o`) |
| mail | correo, bandeja de entrada, resumen, responde, "al último correo" |
| training | entrenamiento, sesión/sesion, gimnasio, ajusta, correr, explica + Spanish-distance phrasings |

### Pending continuations (Spanish)

`src/services/chat-action-planner.ts`:
* `buildPendingCookingMealPlanContinuation`: Spanish gender-inflected adjectives (vegetariana/vegetariano, vegana/vegano), "alta/alto en proteína", "bajo en carbohidratos", "sin <food>" exclusions.
* `buildPendingMailDraftContinuation`: Spanish "más" (accented) refinement directives, "incluye"/"añade"/"quita"/"elimina" content edits, gender-inflected adjectives.
* `buildPendingDecisionChooseContinuation`: Spanish "Opción B"/"elijo C"/"voy con D"/"me quedo con A".

### Attack-pattern types

`src/services/registry-adversarial-discovery.ts`:
* `discoverCredentialStuffingProbes` (new): single tenant generates refusals across ≥ 5 distinct (skill, action) pairs spanning ≥ 3 skills within ≤ 24h. Surfaces post-compromise surface-probing distinct from `targeted_tenant_repeat` (same-action repeats) and `low_and_slow` (cross-tenant distributed campaigns).
* `discoverTimeOfDayClusters` (new): refusals concentrated in narrow hour-of-day windows ≥ 3× baseline mean, with a `minCount` floor (default 5) to suppress small-sample false positives.

### Channel routing policy

`src/services/registry-channel-routing-policy.ts` (new module):
* `ChannelRoutingPolicy` type — per-severity → channelIds[] map.
* `DEFAULT_ROUTING_POLICY` constant — sensible operator baseline.
* `validateChannelRoutingPolicy` — verifies every channel id maps to a registered channel and every severity is present.
* `dispatchCrossTenantAlertsWithPolicy` — fans patterns through channels selected by the policy. Per-channel `minSeverity` still gates each delivery (policy describes intent, channel describes capacity). Errors captured per-channel; one bad channel doesn't abort the fanout.

### Alert-channel weekly smoke run

`src/services/registry-channel-smoke.ts` (new module):
* `buildSmokeAlertPayload` — synthetic info-severity payload labeled "[SMOKE]" so human readers recognise it.
* `runChannelSmoke` — probes every registered channel with the synthetic payload; per-channel timeout; captures per-channel success/failure; survives one bad channel.
* `formatChannelSmokeMarkdown` — stable Markdown report shape suitable for weekly archival.
* `scripts/registry-alert-channel-smoke.ts` (new runner) — env-driven channel construction; CLI flags for `--dry-run`, `--output`, `--timeout-ms`. Exits non-zero if any channel failed.

## Verification

```
cd /Users/felipedominguez/Desktop/Custom\ Connectors/Cortex/cortex-telegram-hub-bot

npx tsc --noEmit                                                        # 0 errors
npx vitest run __tests__/services/chat-action                           # 431 passed
npx vitest run __tests__/services/registry                              # 220 passed
npx vitest run __tests__/services/calendar-natural-language-parser-es   # 13 passed
npx vitest run __tests__/services/registry-channel-smoke                # 12 passed
npx vitest run __tests__/services/registry-credential-stuffing-attacks  # 12 passed
npx vitest run __tests__/services/registry-channel-routing-policy       # 12 passed
```

All Phase 10 test files green. No new typecheck errors.

## Files touched in Phase 10

### Modified
* `src/services/calendar-natural-language-parser.ts` — Spanish NLP (batch 50)
* `src/services/skills/cooking/parser.ts` — Spanish vocabulary (batch 51)
* `src/services/skills/content/parser.ts` — Spanish vocabulary (batch 51)
* `src/services/skills/decision_center/parser.ts` — Spanish vocabulary (batch 51)
* `src/services/skills/connections/parser.ts` — Spanish vocabulary + accent fixes (batch 51)
* `src/services/skills/mail/parser.ts` — Spanish vocabulary (batch 51)
* `src/services/skills/training/parser.ts` — Spanish vocabulary (batch 51)
* `src/services/chat-action-planner.ts` — Spanish pending continuations (batch 52)
* `src/services/registry-adversarial-discovery.ts` — new attack patterns (batch 53)

### Added
* `src/services/registry-channel-routing-policy.ts` (batch 54)
* `src/services/registry-channel-smoke.ts` (batch 55)
* `scripts/registry-alert-channel-smoke.ts` (batch 55)
* `__tests__/services/calendar-natural-language-parser-es.test.ts` (batch 50)
* `__tests__/services/chat-action-es-coverage-expansion.test.ts` (batch 51)
* `__tests__/services/registry-multi-turn-es-state-injection.test.ts` (batch 52)
* `__tests__/services/registry-credential-stuffing-attacks.test.ts` (batch 53)
* `__tests__/services/registry-channel-routing-policy.test.ts` (batch 54)
* `__tests__/services/registry-channel-smoke.test.ts` (batch 55)
* `docs/release/eval-evidence/phase-10-catalog-snapshot.md` (this file)
