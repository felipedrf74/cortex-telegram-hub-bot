# Secretary Orchestration Audit

Audit date: 2026-04-29
Backend branch observed: `feature/chat-p0-tenant-security-audit`
Backend commit observed: `34add9a`

## Verdict

Secretary is no longer just a thin chat domain: the backend already has a read-side orchestration stack for daily/weekly planning, cross-skill mesh signals, focus recommendations, provider-aware calendar reads/writes, and Training-specific calendar lifecycle hardening.

It is not yet the universal agenda authority. The strongest ownership model is currently Training-specific (`training_agenda_event_ownership`). A broader Secretary agenda ledger schema exists in migration `083_secretary_agenda_ledger.sql`, but no runtime service or route currently writes or reads `secretary_agenda_items`. Calendar writes can still happen through generic iOS calendar routes, generic Secretary tools, Training sync/cancel paths, and Content topic sync without a single Secretary scheduling intent/decision pipeline.

No broad date-range provider deletion was found in this audit. Calendar deletes inspected are event-id based. The main production risk is architectural: schedule state is fragmented across skill-specific tables and provider event IDs, so Secretary cannot yet guarantee global reflow, duplicate prevention, stale event repair, or cross-skill capacity arbitration.

## Evidence Inspected

Backend Secretary and planning:
- `src/domains/secretary.ts`
- `src/services/secretary-tools.ts`
- `src/services/secretary-orchestrator.ts`
- `src/services/weekly-plan-orchestrator.ts`
- `src/services/daily-brief-orchestrator.ts`
- `src/services/conflict-resolver.ts`
- `src/services/cross-agent-learning.ts`
- `src/services/focus-planner.ts`

Calendar/provider lifecycle:
- `src/services/unified-calendar.ts`
- `src/services/google-calendar.ts`
- `src/services/outlook-calendar.ts`
- `src/api/routes/calendar.ts`
- `src/services/training-calendar-scope.ts`
- `src/tools/training-calendar-staging-smoke.ts`

Skill-specific schedule ownership:
- `src/services/training-plan-lifecycle.ts`
- `src/services/training-agenda-reconciliation.ts`
- `src/api/routes/training-plan-calendar-sync.ts`
- `src/api/routes/training-plan-cancellation.ts`
- `src/api/routes/training-plan-persistence.ts`
- `src/services/content-topic-secretary-sync.ts`
- `src/services/content-scheduler.ts`

Reminder/follow-up state:
- `src/state/reminders.ts`
- `src/api/routes/reminders.ts`
- `migrations/001_initial.sql`
- `migrations/029_user_data_isolation.sql`

Agenda ownership migrations:
- `migrations/081_training_agenda_event_ownership.sql`
- `migrations/083_secretary_agenda_ledger.sql`

iOS contracts, read-only:
- `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub/Models/CalendarEvent.swift`
- `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub/Core/Services/CalendarService.swift`
- `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub/Core/Services/PlanService.swift`
- `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub/Views/Dashboard/DashboardSecretaryCalendarPresentation.swift`
- `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub/Views/Dashboard/EventDetailSheet.swift`

## Current Architecture Map

| Area | Current implementation | Audit read |
| --- | --- | --- |
| Secretary chat/tool domain | `handleSecretary` loads scoped tasks/calendar/reminders/mail/Garmin/planner context and uses provider routing. `secretary-tools` narrows tool packs by intent. | Useful interaction layer, but tool calls still write directly to calendar/reminders rather than through a durable agenda intent ledger. |
| Daily planning | `/api/v1/plan/today` calls `composeDailyBrief`, which calls weekly planning and `buildSecretaryCoordination`. | Strong read-side coordination with explanations, blockers, handoffs, and posture; not a stateful schedule placement engine. |
| Weekly planning | `composeWeeklyPlan` reads Training, Secretary, Cooking, Content, and Finance mesh contexts, builds signals, resolves directive conflicts, and returns cross-skill plan days. | Good cross-skill intelligence substrate; decisions are advisory/projection state, not agenda-item lifecycle state. |
| Conflict handling | `conflict-resolver` ranks same-day/same-target mesh directives by priority and produces conflict notes. | Detects planning conflicts in the mesh, but does not move/cancel/update provider events except in Training-specific sync flows. |
| Focus/capacity | `focus-planner` scores candidate windows using calendar load, readiness, and Training context. | Useful capacity primitive for focus recommendations; not yet generalized to schedule all skill intents. |
| Universal agenda ledger | `secretary_agenda_items` migration has source intent, lifecycle, provider sync, decision reason, supersession, and tenant/user fields. | Schema exists but is unused at runtime. `rg` found no service or route references beyond the migration and a Chat rehearsal doc. |
| Training agenda lifecycle | Training owns a dedicated ledger, idempotent ownership recording, cancellation cleanup, stale link repair, and orphan reconciliation. | Best current lifecycle implementation. It proves the pattern Secretary should generalize. |
| Content scheduling | Content topics sync to Microsoft To Do and optionally calendar through `content-topic-secretary-sync`, storing provider event ID/source on `content_topics`. | Good idempotent upsert for Content, but bypasses universal Secretary decision/ledger/reflow ownership. |
| Finance/Cooking schedule input | Weekly mesh contexts provide finance/cooking signals and planning pressure. | No structured scheduling intents found for bill review, meal prep, grocery blocks, or cooking windows. |
| Reminders | `reminders` table is user-scoped with message, remind time, recurring, status. Routes and tools are user-scoped. | Simple reminder lifecycle; no tenant_id, source skill/entity, lifecycle reason, dedupe fingerprint, snooze/defer/escalation, or follow-up model. |
| Calendar providers | `unified-calendar` wraps Google/Outlook, dedupes reads, creates/updates/deletes by provider event ID. | Provider layer is usable and safer than title/date matching, but has no agenda ownership boundary by default. |
| iOS agenda contract | `CalendarEvent.swift` can decode `agendaItemId`, `sourceIntentId`, `sourceSkill`, lifecycle state, provider sync state, decision reasons, conflicts, alternatives, and scheduled segments. | Frontend is ahead of backend generic calendar payloads; backend `formatEvent` currently drops those fields for normal calendar events. |

## Key Strengths To Preserve

- Token-zero operational routes for calendar, reminders, tasks, and plans stay out of the AI chat pipeline.
- Provider deletes inspected are event-id based, not broad date/title sweeps.
- Training cancellation/sync has durable event ownership, idempotent recording, precise stale cleanup, and orphan reconciliation.
- Weekly/daily planning already consumes multi-skill mesh context and tenant/user scope checks.
- iOS already has resilient enums and rendering support for richer Secretary agenda metadata.
- Calendar cache invalidation is triggered after provider writes.
- Planning routes return degraded safe fallbacks when source context fails.

## Major Gaps

### P1: Universal Secretary agenda ledger is not wired

`migrations/083_secretary_agenda_ledger.sql` defines the right durable table, but runtime code does not create, transition, query, or repair `secretary_agenda_items`. This prevents Secretary from being the authoritative lifecycle owner across Training, Cooking, Finance, Content, reminders, and user-created agenda blocks.

Impact:
- No universal source intent identity.
- No universal lifecycle state for scheduled/reflowed/compressed/deferred/unscheduled/canceled/superseded.
- No universal provider sync state.
- No single repair queue for stale provider/local mismatches.
- iOS can decode fields the backend rarely sends.

### P1: Calendar writes bypass Secretary arbitration

Calendar writes happen through:
- `POST/PATCH/DELETE /api/v1/calendar/events`
- Secretary tool calls `create_calendar_event`, `update_calendar_event`, `delete_calendar_event`
- Training plan sync/cancel routes
- Content topic sync

These paths are useful and mostly scoped, but they do not all create Secretary agenda records first. That means Secretary cannot reliably answer “why did this get scheduled?”, “what skill owns this?”, or “what changed after reflow?” for every event.

### P1: Daily/weekly planning is advisory rather than executable

`composeWeeklyPlan` and `composeDailyBrief` produce coherent planning views, conflict notes, and suggested actions. They do not persist chosen blocks as agenda items, reserve provider events, or run lifecycle transitions. The system can say a day is busy or a block should move, but only Training-specific flows currently perform durable schedule repair.

### P1: Cross-skill scheduling intent contract is incomplete

Chat routing now states that Secretary owns schedule placement, but the backend lacks a formal skill-to-Secretary scheduling intent service. Training has its own sync lifecycle. Content has direct Secretary artifact sync. Cooking and Finance appear in weekly planning through mesh context, but not as structured scheduling requests with duration, priority, flexibility, deadline, dependencies, and source identity.

### P1: Reminder/follow-up lifecycle is too thin

Reminders are user-scoped and operationally safe at the basic level, but they are not yet Secretary-grade:
- no tenant_id in the legacy reminders table,
- no source skill/source entity,
- no dedupe key,
- no snooze/defer/escalation metadata,
- no separate follow-up/commitment model,
- no decision reason or connection to an agenda item.

### P1: Backend calendar DTO does not emit generic agenda metadata

iOS `CalendarEvent` supports the richer Secretary agenda fields. Backend `formatEvent` in `src/api/routes/calendar.ts` only emits provider event basics (`id`, `title`, `description`, `start`, `end`, `source`, categories/color/all-day). Until backend generic calendar reads join agenda ownership, iOS cannot render source skill/lifecycle/decision reasons for normal Secretary-owned events.

### P2: Conflict detection does not universally repair schedule state

The mesh resolver detects directive conflicts, and Training-specific reconciliation repairs orphaned Training events. There is no general Secretary repair worker for:
- provider event deleted externally,
- local item active but provider canceled,
- provider event active while source entity is canceled,
- duplicate events from retries,
- source skill plan changed without agenda update.

### P2: Local calendar mock coverage is Training-heavy

The real provider smoke harness is Training-calendar oriented. A universal Secretary local mock should exercise create/update/move/cancel/reflow/duplicate/stale cleanup for Secretary agenda items independent of Training.

## Bypass Matrix

| Source | Current scheduling path | Bypass risk |
| --- | --- | --- |
| iOS smart block/calendar UI | Direct `/api/v1/calendar/events` provider write. | Creates provider events without Secretary agenda identity/lifecycle. |
| Secretary chat tools | `tool-executor` calls `unified-calendar` directly. | Tool result lacks durable Secretary agenda item unless future ledger write is added. |
| Training | Dedicated Training calendar sync/cancel paths. | Strong lifecycle locally, but not mediated by universal Secretary intent model. |
| Content Creation | `syncContentTopicSecretaryArtifacts` writes task/calendar refs on content topic. | Idempotent but separate lifecycle; no universal reflow/repair source of truth. |
| Cooking | Mesh signals influence weekly plan. | No durable meal-prep/grocery scheduling intent found. |
| Finance | Mesh signals influence weekly plan. | No durable bill/budget/subscription scheduling intent found. |
| Reminders | `/api/v1/reminders` and `set_reminder` write reminder rows. | No source ownership/dedupe/follow-up state model. |

## Recommended Implementation Sequence

1. Add a Secretary agenda service around `secretary_agenda_items`.
   - Create/transition/list/repair agenda records.
   - Enforce owner_user_id and tenant_id scope.
   - Use source intent identity and source shape hash for idempotency.

2. Add a scheduling intent contract.
   - Normalize skill requests into one typed input model.
   - Include duration, windows, priority, flexibility, deadline, dependencies, source skill/entity, user/tenant, and reason.

3. Wrap calendar writes in agenda ownership.
   - For user-created blocks and tool-created events, create agenda row before/after provider sync with idempotency.
   - Emit agenda metadata from calendar reads by joining provider_event_id/source.

4. Generalize Training’s proven lifecycle pattern.
   - Port precise event-id cleanup, orphan marking, stale link repair, and reconciliation queue semantics to the universal ledger.
   - Keep Training’s existing table during transition, or mirror it into the universal ledger until cutover is proven.

5. Add cross-skill adapters.
   - Training, Cooking, Finance, and Content should submit scheduling intents.
   - Secretary returns scheduled/reflowed/compressed/deferred/unscheduled/rejected/needs_more_context.

6. Upgrade reminders/follow-ups.
   - Add source identity, tenant_id, lifecycle, dedupe fingerprint, snooze/defer/escalation, agenda link, and follow-up/commitment models.

7. Make daily/weekly planning executable.
   - Convert accepted directives into candidate scheduling intents.
   - Persist selected agenda outcomes and expose explanation/decision reasons to iOS.

8. Add repair workers and smoke tests.
   - Local mock provider first.
   - Then Google/Outlook staging provider read-back/cleanup.

## Release-Gate Classification

| Priority | Item | Release-gate meaning |
| --- | --- | --- |
| P0 | None confirmed in this read-only audit. No broad date/title provider delete was found. | Re-check during implementation and provider staging. |
| P1 | Wire universal agenda ledger service and route all new Secretary-owned calendar writes through it. | Required before claiming Secretary is central agenda owner. |
| P1 | Add scheduling intent contract and Secretary response contract. | Required before other skills can stop bypassing Secretary. |
| P1 | Emit agenda metadata in calendar API responses. | Required for iOS to show lifecycle/source/reasons from real backend data. |
| P1 | Add reminder/follow-up ownership and dedupe model. | Required before Secretary can own accountability loops reliably. |
| P1 | Add general stale/duplicate/repair logic outside Training. | Required before production trust for cancellation/reflow across skills. |
| P2 | Generalize local provider mock and smoke beyond Training. | Required before confident full-product local validation. |
| P2 | Add Cooking/Finance durable scheduling intents. | Important for full cross-skill orchestration; can stage behind flags. |
| P3 | Polish copy and expanded iOS presentation once backend emits stable metadata. | Deferrable after backend lifecycle contract is real. |

## Do-Not-Break List

- Do not remove existing direct token-zero REST flows; wrap them with agenda ownership rather than replacing them with chat.
- Do not weaken Training’s existing event-id-only cleanup and ownership audit.
- Do not delete provider events by title/date/range.
- Do not make iOS responsible for enforcing agenda ownership.
- Do not hardcode special skill flows that cannot use the common intent/response contract.
- Do not force all provider writes into an AI/model call path.
- Do not expose inactive/canceled/superseded events as normal active schedule blocks.
