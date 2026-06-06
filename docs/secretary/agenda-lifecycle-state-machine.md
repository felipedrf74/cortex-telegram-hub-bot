# Secretary Agenda Lifecycle State Machine

Date: 2026-04-29

Secretary agenda items use the eleven schema lifecycle states in `secretary_agenda_items.lifecycle_state`.

| State | Runtime meaning | Typical transition source |
| --- | --- | --- |
| `proposed` | Intent was captured but not placed yet. | Future clarification/proposal flow. |
| `scheduled` | Secretary selected a valid local agenda slot; provider sync has not completed. | Scheduling decision `scheduled`. |
| `synced` | Provider create/update succeeded and provider mapping is attached. | `syncSecretaryAgendaItemToProvider()` success. |
| `reflowed` | Item was moved because a newer decision superseded a prior placement. | Scheduling decision `reflowed`. |
| `compressed` | Item was shortened to fit available capacity. | Scheduling decision `compressed`. |
| `deferred` | Item remains important but should be placed later. | Decision engine fallback. |
| `unscheduled` | Secretary could not find a valid slot. | No-valid-slot decision. |
| `canceled` | User/source skill canceled the agenda item. | `cancelSecretaryAgendaItem()`. |
| `superseded` | A newer agenda version replaced this item. | `persistDecision()` version replacement. |
| `failed_sync` | Provider create/update/readback/delete failed or a provider-backed item lacks a valid time. | Provider sync failure path. |
| `completed` | Scheduled end time has passed. | `markCompletedSecretaryAgendaItems()` scheduler hook. |

Provider sync state mapping:

- `provider_sync_state = synced` maps agenda lifecycle to `synced`.
- `create_failed`, `update_failed`, `readback_failed`, and `delete_failed` map agenda lifecycle to `failed_sync`.
- `deleted` keeps the current lifecycle state, usually `canceled`, `superseded`, `unscheduled`, or `deferred`.
- `not_synced` keeps the current lifecycle state.

Reminder linkage:

- Reminders may now carry `agenda_item_id`.
- Canceling an agenda item cancels active reminders linked to that agenda item.
- Superseding an agenda item cancels active reminders linked to the superseded agenda item so stale reminders do not fire after reflow.

Operational note:

`markCompletedSecretaryAgendaItems()` is intentionally separated from provider cleanup. Completed historical calendar events should not be deleted as a side effect of marking the local agenda item complete.
