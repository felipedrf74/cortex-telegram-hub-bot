# Chat Action Registry — Phase 9 Catalog Snapshot

_Generated 2026-05-16 (Phase 9: closed 6 Phase 8 candidates — content pending continuation, extended cross-tenant attack patterns, 4 new alert channels, alert-channel CI gate, Spanish parser expansion 3→12, multi-turn state-injection harness)._
_Builds on Phase 8 ([phase-8-catalog-snapshot.md](phase-8-catalog-snapshot.md))._

## Summary

| Metric | Phase 8 | Phase 9 | Δ |
|---|---|---|---|
| Total active actions | 45 | 45 | — |
| Pending continuations (planner state machines) | 5 (training, cooking, mail, decision_choose, finance) | 6 (+ content brief/script) | +1 |
| State-required scenarios | 25 | 28 | +3 (content brief/script) |
| Cross-tenant attack pattern types | cross_tenant_critical/high/medium/info | + low_and_slow, targeted_tenant_repeat | +2 pattern types |
| Alert channel implementations | 3 (PagerDuty / Slack / Telegram) | 7 (+ Discord / Email / Datadog / Opsgenie) | +4 |
| Spanish parser actions | 3 (create_task / delete_event / send_email) | 12 (+ 9 more) | +9 |
| Spanish confusion fixtures | 3 | 12 | +9 |
| Multi-turn state-injection scenarios | (covered ad-hoc) | 7 dedicated end-to-end scenarios | new file |
| Repo-wide tests | 8166 | 8252 | +86 |
| Test files | 560 | 564 | +4 |
| Skipped tests | 0 | 0 | — |

## Phase 9 batch summary

| Batch | Theme | Tests added | New modules / artifacts |
|---|---|---|---|
| 44 | Content brief/script pending continuation | +3 state-required scenarios | `buildPendingContentSpecContinuation` in planner |
| 45 | Low-and-slow + targeted-tenant attack patterns | +10 | `discoverLowAndSlowAttacks` + `discoverTargetedTenantRepeats` in adversarial discovery |
| 46 | Discord / Email / Datadog / Opsgenie alert channels | +20 | 4 new channel adapters + formatters in alert-channels module |
| 47 | Alert channel CI contract gate | +36 | `registry-alert-channels-ci-gate.test.ts` validates 7-channel contract |
| 48 | Spanish parser coverage 3 → 12 actions | +13 ES confusion tests | Spanish verb/noun extensions across 6 parsers + calendar-read patterns |
| 49 | Multi-turn turn-2 state-injection scenarios | +8 | `registry-multi-turn-state-injection.test.ts` covers 6 skill continuations + TTL safety |

## Closed Phase 8 candidates

| Phase 8 # | Item | Resolution |
|---|---|---|
| 1 | Content brief / script-create pending continuations | Phase 9 batch 44 |
| 2 | Past-tense POS-aware variant | STILL OPEN (POS dependency / design call) |
| 3 | Examples-as-living-test-corpus | STILL OPEN (architectural decision) |
| 4 | Full Spanish parser coverage | Phase 9 batch 48 partial (3 → 12 actions; remaining 33 fall through to LLM tier) |
| 5 | CI gate for alert channels | Phase 9 batch 47 |
| 6 | More cross-tenant attack patterns | Phase 9 batch 45 (low_and_slow + targeted_tenant_repeat) |
| 7 | PagerDuty alternative channels | Phase 9 batch 46 (Discord / Email / Datadog / Opsgenie) |
| 8 | Multi-turn fixtures with state-injection | Phase 9 batch 49 |

## New tooling

### Content brief / script-create pending continuation (batch 44)

[src/services/chat-action-planner.ts](../../../src/services/chat-action-planner.ts) — `buildPendingContentSpecContinuation` mirrors the cooking/mail/decision/finance pattern. Recognises content-spec vocabulary:

- **Audience tokens**: `audience`, `público`
- **Tone adjectives**: `punchy`, `inspirational`, `educational`, `tutorial`, `professional`, `casual`, `formal`, `tom`, `inspirador`, `educacional`, `coloquial`
- **Length targets**: `under N seconds/words/minutes`, `short`, `long`, `curto`, `longo`, `abaixo de N`, `menos de N`
- **Format hints**: `hook`, `gancho`, `brief`

Honors the "do not invent" rule: if no recognised vocabulary, returns null.

### Extended cross-tenant attack patterns (batch 45)

[src/services/registry-adversarial-discovery.ts](../../../src/services/registry-adversarial-discovery.ts) adds two new pattern detectors:

- **`discoverLowAndSlowAttacks`** — detects distributed campaigns with low per-tenant volume (≤3 mean rows/tenant) but spread over an extended window (≥7 days) across many tenants (≥3). Classic stealth-attack signal that the regular cross-tenant detector misses (because severity is short-window-biased).
- **`discoverTargetedTenantRepeats`** — detects single-tenant repeated attacks across distinct conversations (≥3 conversations) within a short window (≤7 days). Useful when one tenant is actively being exploited from inside its own user base.

Both have configurable thresholds (`minTenantCount`, `maxMeanRowsPerTenant`, `minWindowDays`, `minConversationCount`, `maxWindowDays`).

### Discord / Email / Datadog / Opsgenie alert channels (batch 46)

[src/services/registry-cross-tenant-alert-channels.ts](../../../src/services/registry-cross-tenant-alert-channels.ts) — 4 new channel adapters following the Phase 7 pattern (`AlertChannel` interface + factory function + pure payload formatter):

| Channel | Factory | Default minSeverity | Auth |
|---|---|---|---|
| Discord | `createDiscordChannel({ webhookUrl, username? })` | medium | webhook URL |
| Email | `createEmailChannel({ from, to, sender })` | high | injectable sender |
| Datadog | `createDatadogChannel({ apiKey, site? })` | medium | DD-API-KEY header |
| Opsgenie | `createOpsgenieChannel({ apiKey, region? })` | high | GenieKey header |

Each ships:
- Severity-mapped payload format (color/priority/alert_type)
- HTML escaping where applicable (Discord embed, Email HTML body)
- Injectable HTTP transport for testing
- Async error surfacing on non-2xx responses

Now 7 channels total: PagerDuty / Slack / Telegram / Discord / Email / Datadog / Opsgenie.

### Alert channel CI contract gate (batch 47)

[__tests__/services/registry-alert-channels-ci-gate.test.ts](../../../__tests__/services/registry-alert-channels-ci-gate.test.ts) pins the per-channel contract:

- Each channel has a recognised `id` from the documented set
- `minSeverity` is one of the four CrossTenantSeverity levels
- `send(payload)` does not mutate the payload (no side effects on shared input)
- Handles all four severities without throwing
- HTTP-backed channels surface non-2xx as `throw`
- Dispatcher can fan all 7 channels in parallel; shadowMode skips them all

Total: 36 contract tests across 7 channels.

### Spanish parser coverage expansion (batch 48)

Parser extensions adding 9 more Spanish actions to the 3 covered in Phase 8:

| Parser | Extension |
|---|---|
| `parseSimpleTaskStep` / `hasSimpleTaskWriteIntent` | added `añade[r]?` / `agreg[ae][r]?` create verbs |
| `parseTaskMutationIntent` outer gate | added `tarea[s]?` (was missing — caused ES task mutations to fail) |
| `parseTaskMutationIntent` delete branch | added `borra[r]?` Spanish delete verb |
| `parseTaskMutationIntent` update branch | added `cambia[r]?` Spanish change verb |
| `parseCompleteTaskByMarkIntent` | added `marca/marcar` + Spanish `tarea` + `hecha/hecho/completada/terminada/lista` |
| `parseMailActionStep` unread branch | added `correos sin leer` Spanish pattern |
| `parseFinanceActionStep` gate | added `gasté/gasté/factura/tarjeta de crédito/recuérdame/recordatorio` |
| `parseFinanceActionStep` reminder branch | added `recu[eé]rdame/recordatorio` |
| `hasCalendarReadIntent` | added Spanish `qué hay en mi agenda` / `qué tengo el <day>` patterns |
| `hasCalendarWriteIntent` | added Spanish `crea/programa/añade` write verbs |

12 Spanish confusion fixtures lock the priority winner across: create_task, delete_event, send_email, complete_task, delete_task, update_task, mail_unread_count, finance_summary, finance_create_reminder, summarize_agenda (×2), añade-task. Locale-header-independent.

### Multi-turn turn-2 state-injection harness (batch 49)

[__tests__/services/registry-multi-turn-state-injection.test.ts](../../../__tests__/services/registry-multi-turn-state-injection.test.ts) — 8 end-to-end tests:

- 6 skill continuations (training / cooking / mail / decision_choose / finance / content)
- 1 cross-skill assertion that every multi-turn registry example covers a supported skill
- 1 TTL expiry safety test (expired pending action → no claim)

Each test injects a pending action via `getActivePendingChatAction` mock, runs `buildChatActionPlan` over turn 2, and asserts the continuation fires with the correct slot populated.

## Parser refinements in Phase 9

- `hasSimpleTaskWriteIntent` + `parseSimpleTaskStep` — added Spanish `añade/agrega` create verbs
- `parseTaskMutationIntent` — extended outer gate to accept Spanish `tarea`; added Spanish `borra/cambia` to delete + update branches
- `parseCompleteTaskByMarkIntent` — Spanish `marca esa tarea como hecha/completada/terminada/lista`
- `parseMailActionStep` — Spanish `correos sin leer` unread pattern
- `parseFinanceActionStep` — Spanish gate vocab + reminder branch extension
- `hasCalendarReadIntent` (in calendar-natural-language-parser) — Spanish read patterns
- `hasCalendarWriteIntent` — Spanish write verbs

## Phase 10 candidates (future work)

1. **Spanish calendar-event NLP parser** — current `parseNaturalLanguageCalendarEvent` doesn't recognise Spanish date words (`viernes`, `a las 14h`, `lunes próximo`). 3 of the 12 Spanish actions still don't reach this path.
2. **Spanish parser coverage 12 → 30+ actions** — remaining 33 actions fall through to LLM tier. Phase 10 could expand training, content, cooking, connections, notifications.
3. **Past-tense POS-aware variant** (still open from Phase 7) — requires POS tagger dependency / Felipe's design call.
4. **Examples-as-living-test-corpus** (still open from Phase 7) — telemetry-driven promotion/demotion. Requires architectural decision on registry mutability.
5. **Alert-channel CI smoke run** — Phase 9 batch 47 validates contract at unit-test level. A separate weekly smoke run could exercise real channel endpoints against test-routing-keys (PagerDuty test routing key, Slack test webhook, etc.) to detect channel-side regressions.
6. **More attack-pattern types** — credential-stuffing-shaped patterns, time-of-day clusters, cross-skill attack chaining.
7. **Spanish multi-turn pending continuations** — pending mail/cooking/finance/decision continuation regexes are EN+PT. Spanish equivalents would require ES vocabulary in each `buildPending*` function.
8. **Channel routing policy** — currently every channel above its minSeverity receives every alert. A routing-policy layer could distribute alerts (e.g., critical to PagerDuty + Telegram; medium to Slack + Discord; weekly summary to email).

## Files changed in Phase 9

### Source

- [src/services/chat-action-planner.ts](../../../src/services/chat-action-planner.ts) — `buildPendingContentSpecContinuation` + content continuation wired into `buildChatActionPlan`; Spanish parser extensions (task create / mutation / complete-by-mark gates).
- [src/services/calendar-natural-language-parser.ts](../../../src/services/calendar-natural-language-parser.ts) — Spanish read + write patterns added.
- [src/services/skills/mail/parser.ts](../../../src/services/skills/mail/parser.ts) — Spanish unread pattern.
- [src/services/skills/finance/parser.ts](../../../src/services/skills/finance/parser.ts) — Spanish gate + reminder vocabulary.
- [src/services/registry-adversarial-discovery.ts](../../../src/services/registry-adversarial-discovery.ts) — `discoverLowAndSlowAttacks` + `discoverTargetedTenantRepeats`.
- [src/services/registry-cross-tenant-alert-channels.ts](../../../src/services/registry-cross-tenant-alert-channels.ts) — Discord / Email / Datadog / Opsgenie channels + formatters.

### Tests

- [__tests__/services/chat-action-registry-state-required-parity.test.ts](../../../__tests__/services/chat-action-registry-state-required-parity.test.ts) — +3 content pending continuation scenarios.
- [__tests__/services/registry-extended-attack-patterns.test.ts](../../../__tests__/services/registry-extended-attack-patterns.test.ts) — NEW. 10 low-and-slow + targeted-tenant tests.
- [__tests__/services/registry-extended-alert-channels.test.ts](../../../__tests__/services/registry-extended-alert-channels.test.ts) — NEW. 20 tests for Discord / Email / Datadog / Opsgenie payload + dispatch.
- [__tests__/services/registry-alert-channels-ci-gate.test.ts](../../../__tests__/services/registry-alert-channels-ci-gate.test.ts) — NEW. 36 contract-gate tests across all 7 channels.
- [__tests__/services/chat-action-es-confusion.test.ts](../../../__tests__/services/chat-action-es-confusion.test.ts) — +9 Spanish confusion fixtures (total 12 actions).
- [__tests__/services/registry-multi-turn-state-injection.test.ts](../../../__tests__/services/registry-multi-turn-state-injection.test.ts) — NEW. 8 end-to-end multi-turn scenarios.
