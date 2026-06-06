# Chat Action Registry — Phase 12 Catalog Snapshot

_Generated 2026-05-16 (Phase 12: verified Phase 0 audit DELETE CANDIDATES → reclassified as KEEP, adopted typed slot extractors on 3 high-impact actions, added 10 ES registry examples, wired per-region smoke runner, expanded Spanish parser 35 → 40+)._
_Builds on Phase 11 ([phase-11-catalog-snapshot.md](phase-11-catalog-snapshot.md))._

## Summary

| Metric | Phase 11 | Phase 12 | Δ |
|---|---|---|---|
| Total active actions | 45 | 45 | — |
| Spanish parser actions (deterministic) | ~35 | ~40+ | +5 (+move_event ES verbs, +check_calendar_conflicts ES, +create_checklist ES, +content_rewrite ES alt verbs, +decision_choose ES alt verb) |
| Typed slot extractors adopted (action entries) | 0 (type plumbing only) | 3 (schedule_event, create_task, training_plan_create) | +3 |
| Registry entries with `locale: 'es'` examples | 0 | 10 | +10 |
| Per-region channel construction in smoke runner | single-region only | env-driven regional fanout with channel-id `<type>-<region>` | new builder module |
| Phase 0 audit DELETE CANDIDATES remaining | 4 (manifest×5, pending-confirmations, capability-registry, scattered regexes) | 4 (re-verified: 2 confirmed KEEP, 1 deferred to Phase 13 MERGE, 1 outstanding) | 0 deletions; 2 reclassifications |
| Repo-wide chat-action + registry tests | 714 | 750 | +36 |

## Phase 12 batch summary

| Batch | Theme | Tests | New modules / artifacts |
|---|---|---|---|
| 61 | Verified Phase 0 DELETE CANDIDATES | 0 | finding: manifest.json files runtime-loaded by `src/skills/loader.ts:215` (KEEP); `chat-pending-confirmations.ts` self-documents Phase 0 audit reclassification (KEEP) |
| 62 | chat-skill-capability-registry audit | 0 | finding: 2 src importers + 1 test; merge feasible but deferred to Phase 13 |
| 63 | Typed slot extractor adoption | +15 | `registry-typed-slot-adapters.ts` (new); 3 actions adopt typed API (schedule_event, create_task, training_plan_create) |
| 64 | ES examples on 10 registry entries | 0 (lint passes) | 10 new `locale: 'es'` examples across schedule_event, delete_event, summarize_agenda, mail_unread_count, send_email, create_task, complete_task, delete_task, finance_summary, finance_create_reminder |
| 65 | Per-region smoke channel builder | +16 | `registry-channel-smoke-builder.ts` (new); refactored `scripts/registry-alert-channel-smoke.ts` to use the builder; env-driven `<NAME>_<REGION>` suffix support |
| 66 | Spanish parser 35 → 40+ | +5 | parser extensions for move_event ("mueve"/"reprograma"), check_calendar_conflicts ("estoy libre"), create_checklist ("crea"/"añade"), content_rewrite ("acorta"/"alarga"/"reduce"), list-conjunction "y" |

## Closed / re-classified Phase 0 audit items

| Phase 0 audit # | Item | Phase 12 resolution |
|---|---|---|
| DELETE-1 | 5 stale `src/skills/*/manifest.json` files | **Reclassified to KEEP** — files are loaded at runtime by `src/skills/loader.ts:215` and pinned by 4 active test files. The audit's "stale duplicates" claim was wrong (or based on a snapshot before `loader.ts` started consuming them). |
| DELETE-2 | `chat-pending-confirmations.ts` (in-memory) | **Reclassified to KEEP** — file's own header (lines 24-27) documents the audit reclassification: distinct concern from DB-backed `chat_pending_actions`; couples to Decision Center destructive-confirmation flow. 2 src importers, 2 active tests. |
| MERGE-1 | `chat-skill-capability-registry.ts` into action registry | **Deferred to Phase 13** — feasible but 271-line refactor with 1 src importer (chat-grounding-layer.ts) + 1 test. Too large to bundle here. |
| MERGE-2 | Inline phrase regexes in domain-handler / secretary-fastpath / chat-message-local-responses | **Still open** — not addressed this phase. |

## Carry-over items (Phase 13 candidates)

| # | Item | Status | Notes |
|---|---|---|---|
| 1 | Past-tense POS-aware variant | OPEN | Carried since Phase 8; POS dependency / design call |
| 2 | Examples-as-living-test-corpus | OPEN | Architectural decision (audit Phase 4) |
| 3 | Spanish parser coverage 40 → 45 | OPEN | 5 remaining actions still defer to LLM |
| 4 | Migrate remaining 42 registry entries to typed slot extractors | OPEN (Phase 11) | 3 of 45 adopted in Phase 12; the rest stay on legacy strings |
| 5 | `locale: 'es'` examples on remaining 35 registry entries | OPEN (Phase 11) | 10 of 45 added in Phase 12 |
| 6 | `chat-skill-capability-registry.ts` merge | NEW (Phase 12) | Deferred from Phase 0 audit MERGE-1 |
| 7 | Inline phrase regex consolidation | NEW (Phase 12) | Deferred from Phase 0 audit MERGE-2 |

## Phase 12 changes in detail

### Phase 0 audit DELETE CANDIDATE verification (Batches 61-62)

**manifest.json files**: `rg -n "manifest.json" src/` surfaced [src/skills/loader.ts:215](src/skills/loader.ts) which loads `<skillDir>/manifest.json` at runtime, plus test files (`__tests__/skills/secretary-skill-package.test.ts`, etc.) that pin manifest existence and format. The audit's "stale duplicates of skill-config.ts" claim is no longer accurate. **Kept.**

**chat-pending-confirmations.ts**: The file's own source header (lines 24-27) documents the Phase 0 audit reclassification — distinct concern from the typed `chat_pending_actions` table (Decision-Center destructive-confirmation coupling vs typed action lifecycle). 2 src importers and 2 tests in active use. **Kept.**

**chat-skill-capability-registry.ts**: 271 lines, 1 src importer (chat-grounding-layer.ts), 1 test (chat-answer-contract.test.ts). Merge into the action registry is feasible — extract `CAPABILITIES` fields into action entries (responseCardType, latencyBudgetMs, privacyPolicy), update chat-grounding-layer to read from the action registry, migrate the test. Deferred to **Phase 13** as a focused batch.

### Typed slot extractor adoption (Batch 63)

**New module** [`registry-typed-slot-adapters.ts`](../../src/services/registry-typed-slot-adapters.ts):
* `calendarEventSlotExtractor` — wraps `parseNaturalLanguageCalendarEvent` from the calendar NLP module. Projects parsed output onto slot map (`title`, `startDateTime`, `endDateTime`, `timezone`, `provider`, `attendees`, `location`, `notes`, `recurrence`).
* `simpleTaskSlotExtractor` — extracts title via quoted-string (highest confidence 0.95) or explicit-marker regex covering EN ("called"/"named"), PT ("chamado"/"chamada"), ES ("llamado"/"llamada"), titulado.
* `trainingPlanSlotExtractor` — wraps `extractTrainingPlanSlots` from training helpers. Builds synthetic planner input so the helper API works without exposing it through the registry boundary.

**Registry wiring**: 3 action entries gained `typedSlotExtractors` + `typedSlotValidators` arrays:
* `secretary_calendar.schedule_event`
* `tasks.create_task`
* `training.training_plan_create`

Legacy string-based `slotExtractors` / `slotValidators` arrays remain unchanged — typed-first accessors (`getSlotExtractors`, `runSlotValidators`) returned in Phase 11 keep working as before.

### `locale: 'es'` examples (Batch 64)

Added 10 ES golden examples to the registry, one per action:

| Action | Spanish example |
|---|---|
| secretary_calendar.schedule_event | `Crea un evento llamado sync el viernes a las 14h` |
| secretary_calendar.delete_event | `Cancela la reunión con Pedro` |
| secretary_calendar.summarize_agenda | `Qué tengo el viernes` |
| mail.mail_unread_count | `Cuántos correos sin leer tengo` |
| mail.send_email | `Envía un correo a felipe@example.com sobre la propuesta` |
| tasks.create_task | `Crea una tarea llamada llamar a María` |
| tasks.complete_task | `Marca esa tarea como hecha` |
| tasks.delete_task | `Borra la tarea de la presentación` |
| finance.finance_summary | `Cuánto gasté este mes` |
| finance.finance_create_reminder | `Recuérdame pagar la factura el viernes` |

The Phase 11 real-eval ES gate (`registry-real-eval-gates-locale.test.ts`) now has actual data to score against (previously informational-only).

### Per-region smoke channel builder (Batch 65)

**New module** [`registry-channel-smoke-builder.ts`](../../src/services/registry-channel-smoke-builder.ts):
* `SMOKE_REGIONS` constant — `US / EU / APAC / GLOBAL`.
* `pickRegionalEnv(env, requiredKeys)` — walks env for `<KEY>_<REGION>` variants; falls back to base form when no regional vars exist.
* `withRegionalChannelId(channel, region?)` — rewrites channel id as `<id>-<region>`.
* `buildSmokeChannelSetFromEnv(env)` — constructs all six channel types per region from env vars.

**Runner refactor** [`scripts/registry-alert-channel-smoke.ts`](../../scripts/registry-alert-channel-smoke.ts): now imports `buildSmokeChannelSetFromEnv` instead of building channels inline. Each channel type accepts `SMOKE_<NAME>_<REGION>` env vars (e.g. `SMOKE_SLACK_WEBHOOK_URL_US`) and produces a channel with id `<type>-<region>` (e.g. `slack-us`) that the routing-policy layer can target.

### Spanish parser 35 → 40+ (Batch 66)

| Skill | Spanish surface added |
|---|---|
| secretary_calendar (move_event) | `mueve[r]?` (imperative of mover), `reprograma[r]?` |
| secretary_calendar (check_calendar_conflicts) | `estoy\s+libre`, `estoy\s+disponible` (ES distinct from PT-PT `estou`) |
| tasks (create_checklist) | `crea[r]?`, `a[nñ]ade` create-verbs; `\s+y\s+` Spanish list conjunction |
| content (content_rewrite) | `acorta[r]?`, `alarga[r]?`, `reduce` single-verb rewrite forms |

## Verification

```
cd /Users/felipedominguez/Desktop/Custom\ Connectors/Cortex/cortex-telegram-hub-bot

npx tsc --noEmit                                                                  # 0 errors
npx vitest run __tests__/services/chat-action                                     # 506 passed
npx vitest run __tests__/services/registry                                        # 244 passed
npx vitest run __tests__/services/chat-action-es-coverage-expansion-3             # 5 passed
npx vitest run __tests__/services/chat-action-registry-typed-slot-adoption        # 15 passed
npx vitest run __tests__/services/registry-channel-smoke-builder                  # 16 passed
```

All Phase 12 test files green. No new typecheck errors. **750 tests** pass across the chat-action + registry families (up from 714 at Phase 11 close).

## Files touched in Phase 12

### Modified
* `src/services/chat-action-planner.ts` — calendar move ES verbs, check_calendar_conflicts ES, checklist ES verbs + list conjunction (batches 66)
* `src/services/chat-action-registry.ts` — typed slot extractor imports + adoption on 3 actions; 10 ES examples added (batches 63-64)
* `src/services/skills/content/parser.ts` — content_rewrite ES alt verbs (batch 66)
* `scripts/registry-alert-channel-smoke.ts` — refactored to use builder module (batch 65)

### Added
* `src/services/registry-typed-slot-adapters.ts` (batch 63)
* `src/services/registry-channel-smoke-builder.ts` (batch 65)
* `__tests__/services/chat-action-registry-typed-slot-adoption.test.ts` (batch 63)
* `__tests__/services/registry-channel-smoke-builder.test.ts` (batch 65)
* `__tests__/services/chat-action-es-coverage-expansion-3.test.ts` (batch 66)
* `docs/release/eval-evidence/phase-12-catalog-snapshot.md` (this file)

### Not modified (Phase 0 audit DELETE CANDIDATES reclassified as KEEP)
* `src/skills/{content,cooking,finance,secretary,training}/manifest.json` (runtime-loaded)
* `src/services/chat-pending-confirmations.ts` (distinct concern from typed pending actions)
