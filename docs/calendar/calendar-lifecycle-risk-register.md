# Calendar Lifecycle Risk Register

Date: 2026-04-29

Scope: Secretary and Training agenda/calendar lifecycle, provider sync, local mock support, stale state repair, duplicate prevention, and iOS-facing calendar contracts.

Severity definitions:

- P0: must block release because it can delete unrelated events, leak cross-user state, or corrupt production calendar data at scale.
- P1: must fix before relying on Secretary as universal agenda owner in production.
- P2: should fix before broad rollout; acceptable with monitoring or explicit scope limits.
- P3: useful cleanup or documentation follow-up.

## Summary

No P0 broad-delete or title-only deletion issue was found in inspected paths. The top risks are P1 architectural lifecycle gaps: generic calendar writes bypass the Secretary agenda ledger, Secretary ledger rows are not provider-synced, and generic provider creates are not idempotent across retries.

## Risk Register

| ID | Severity | Risk | Evidence | Impact | Recommended action | Status |
| --- | --- | --- | --- | --- | --- | --- |
| CAL-P1-01 | P1 | Generic calendar writes bypass Secretary agenda ownership | `src/api/routes/calendar.ts` creates/updates/deletes via `unified-calendar`; `src/services/tool-executor.ts` performs calendar tool writes directly | Secretary cannot arbitrate, explain, repair, dedupe, or cancel these events as owned agenda items | Convert generic writes into Secretary scheduling intents or create audited provider-only escape hatches with explicit lifecycle limits | Open |
| CAL-P1-02 | P1 | Secretary agenda ledger lacks provider sync and reconciliation | Original audit found ledger fields with no provider sync. | Secretary decisions could exist without real Google/Outlook/local calendar events; provider stale state could not be repaired. | Added `secretary-agenda-provider-sync.ts` and provider-specific read-back adapter; local and real Google/Outlook staging smokes passed. | Resolved for Secretary-owned agenda items; generic bypass paths remain separate risks |
| CAL-P1-03 | P1 | iOS/generic calendar payload drops agenda lifecycle metadata | `calendar.ts` formats provider events without Secretary state, decision reason, source skill, sync state, stale flags, or unscheduled state | iOS can flatten richer Secretary lifecycle and hide stale/reflowed/compressed/unscheduled states | Add agenda-aware API payloads and keep provider event DTO backward compatible | Open |
| CAL-P1-04 | P1 | Generic calendar create can duplicate events on retry | Generic create has no source intent ID, idempotency key, ownership lookup, or provider read-back before retry | Network/client retry after provider success can create duplicate provider events | Require source intent IDs for calendar writes and add idempotent create semantics via Secretary ledger | Open |
| CAL-P1-05 | P1 | Content topic calendar sync has stale reference risk outside Secretary ledger | `content-topic-secretary-sync.ts` stores `calendar_event_id`/`calendar_source` on topic rows and marks failures, but lacks universal repair/reconcile | Provider update failure or external deletion can leave stale topic refs and mismatched calendar state | Bridge Content sync into Secretary ownership or add a content calendar reconciliation job | Open |
| CAL-P1-06 | P1 | Training provider create can still duplicate after partial success before DB link | Training has markers and matching repair, but if provider create succeeds and DB link/ownership write fails, retry depends on successful provider fetch and marker detection | Rare duplicate generated training event if provider read-back is unavailable during retry | Add explicit idempotency token/marker preflight or provider read-back verification before create retry | Open |
| CAL-P1-07 | P1 | No first-class local mock provider for Secretary lifecycle | Original audit found no Secretary provider lifecycle mock. | Local proof could not validate Secretary create/update/move/cancel/read-back/repair end-to-end. | Added focused mock-provider lifecycle suite covering create/update/move/cancel/regenerate/replace/retry/stale cleanup/duplicate prevention. | Resolved for focused local lifecycle smoke; full-product local smoke remains separate |
| CAL-P2-01 | P2 | Training legacy title/date relink fallback remains for old events | Training matching can allow legacy title/date/duration relink when `allowLegacyTitleMatch` is true | Older generated events can be relinked with weaker identity than new marker-based events | Retire fallback after migrating/reconciling old generated events; monitor relink logs until removed | Open |
| CAL-P2-02 | P2 | Reminders lack tenant/source/agenda ownership metadata | `state/reminders.ts` has user/status fields, but no tenant ID, source skill/intent, agenda item ID, provider sync, or duplicate group | Cross-skill reminder cleanup, tenant-aware dedupe, and agenda lifecycle linkage are weak | Extend reminder model or bridge reminders into Secretary intent/agenda ledger | Open |
| CAL-P2-03 | P2 | Training cancellation hard-deletes local plan after best-effort external cleanup | Cancellation records failed provider deletes as orphaned and then deletes local plan | App view is clean, but provider stale events rely on later reconciliation and monitoring | Keep orphan reconciliation mandatory; add production alerting for orphan count and retry failures | Open |
| CAL-P2-04 | P2 | Same-shape training event update failure leaves linked event and logs only | Training sync catches update failure and keeps existing event linked | Provider event may retain stale title/time/details even though local session progressed | Promote update failures to sync-state metadata visible in release monitoring | Open |
| CAL-P2-05 | P2 | Provider external deletion repair is Training-specific | Training detects missing linked events; generic calendar, Content, reminders, and Secretary ledger originally did not have equivalent repair | Externally deleted provider events can leave active local agenda state outside Training | Secretary-owned agenda items now repair external deletion via marker read-back and recreate/remap. Content/reminders/generic calendar still need bridging. | Partially resolved |
| CAL-P3-01 | P3 | Calendar lifecycle docs and tests are spread across Training, Secretary, Content, and local smoke docs | Evidence exists, but the lifecycle model is fragmented across many docs/tests | Slower release review and higher operator confusion | Keep this audit and risk register as the release-facing calendar lifecycle index | Open |

## Non-Issues Confirmed

| Check | Result | Notes |
| --- | --- | --- |
| Broad date-range provider deletion | Not found | Training may scan a date span for generated identity markers, but deletes by exact event ID only |
| Title-only deletion | Not found | No inspected provider deletion uses title-only matching |
| Google deletion primitive | Safe primitive | Exact `eventId` delete |
| Outlook deletion primitive | Safe primitive | Exact `/me/events/{eventId}` delete |
| Training generated event ownership | Strong | Uses plan/session identity, shape hash, provider ID, ownership table, and generated markers |

## Release Gate Interpretation

Calendar lifecycle is not a P0 blocker for Training-only rollout based on the inspected risks.

Calendar lifecycle is a P1 blocker for declaring Secretary the universal agenda/calendar owner until the Secretary ledger is wired to provider sync, generic calendar writes are idempotent and ledger-owned, and local mock lifecycle proof exists.

## Next Implementation Batch

Recommended next batch:

1. Implement `secretary-agenda-provider-sync` for local mock provider first.
2. Add idempotent create/update/cancel semantics keyed by `source_intent_id`, `owner_user_id`, `tenant_id`, and `source_skill`.
3. Add tests for retry duplicate prevention, stale provider deletion, external provider deletion, and canceled/superseded item visibility.
4. Route Chat/tool calendar writes through Secretary intents.
5. Add iOS/API DTO support for lifecycle state, source skill, decision reason, and provider sync state.
