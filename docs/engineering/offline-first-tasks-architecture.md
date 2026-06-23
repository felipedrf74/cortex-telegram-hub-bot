# Offline-First Tasks Architecture

Status: canonical
Owner: backend architecture lead
Last verified: 2026-06-23
Update policy: update when Tasks identity, sync state, mutation replay, provider mappings, or iOS offline storage contracts change.

## Principle

Nexus owns canonical task identity and the user experience. Microsoft To Do, Todoist, and future providers are eventually consistent replicas. Provider availability must never be required for first paint, local task creation, or local task mutation.

## Required Architecture

- Every task has an immutable Nexus task id. Provider ids live only in `task_provider_links`.
- Task reads use the Nexus task read model (`unified_tasks` plus sync metadata) and must not call live provider APIs.
- Every create, update, complete, reopen, delete, move, assign-provider, retry-sync, checklist add, and checklist toggle writes a durable `task_mutations` ledger row.
- iOS writes first to a tenant/user-scoped snapshot or outbox when offline, then replays with the same idempotency keys.
- Provider sync is asynchronous through the task mutation worker, provider links, capability projection, and reconciliation.
- Unsupported provider fields remain in Nexus and surface typed `task_sync_issues`; they are not dropped. In v1, Microsoft To Do checklist metadata is written back through provider checklist APIs. Providers without checklist support, including Todoist, keep checklist/subtask metadata in Nexus and surface local-only warnings.
- Conflicts are explicit. Provider changes cannot silently overwrite pending local mutations.

## Data Contracts

Core tables:

- `unified_tasks`: Nexus-local task read model with `nexus_task_id`, `tenant_id`, `local_version`, `sync_state`, `deleted_at`, `source_of_truth`, and Nexus-owned local metadata such as recurrence/checklist items inside `provider_data`.
- `unified_projects`: local Nexus task lists/projects are tenant/user scoped; same-user cross-tenant projects must not share list metadata or counts.
- `task_provider_links`: provider account, provider task/list/project ids, ownership, link state, provider version, and verification timestamps.
- `task_mutations`: authoritative mutation ledger with client/backend idempotency, retry counters, provider idempotency key, retry scheduling, and status.
- `task_container_mappings`: tenant/user-scoped Nexus list to provider list/project/section mapping.
- `task_sync_issues`: typed warnings and repair states shown to clients.
- `task_sync_observability_events`: scoped operational events such as duplicate-prevention hits.

Task ids returned to clients must be Nexus task ids. Provider ids are metadata only.

Legacy compatibility constraint: older provider adapter paths still use
`unified_tasks.external_id` as a provider-row lookup cache. Offline-first Tasks
API responses and local mutation paths must use `nexus_task_id` plus
`task_provider_links`; migrating every legacy `external_id` lookup to provider
links is a follow-up compatibility migration that requires the full focused
task/provider test gate before removing that cache.

## Sync States

Supported task sync states:

- `local_only`
- `queued`
- `syncing`
- `synced`
- `partially_synced`
- `conflict`
- `failed_retryable`
- `failed_permanent`
- `provider_disconnected`
- `provider_missing`
- `stale`
- `deleted_pending_sync`

iOS must surface these as user-facing badges/banners. Stale or degraded local data is valid data, not a panel failure.

## Idempotency

Idempotency is required at three levels:

- Client: stable `clientMutationId` and `idempotencyKey` across app restarts.
- Backend: `(tenantId, userId, clientMutationId, operation)` and `(tenantId, userId, idempotencyKey, operation)` return the same accepted mutation.
- Provider: when native idempotency is absent, Nexus uses provider-link records, provider idempotency keys, read-back, and reconciliation to avoid duplicate provider tasks.

## Provider Mapping

Provider containers are not interchangeable. Microsoft To Do uses lists; Todoist uses projects/sections. New provider writes require a tenant/user-scoped `task_container_mappings` row. If no mapping exists, Nexus saves locally, records `provider_list_missing` or `provider_project_missing`, and must not silently write to an arbitrary default provider container.

Assigning a task to a provider is itself a local-first mutation. `task.assign_provider` creates or updates the scoped provider link, queues provider sync only when a valid container mapping exists, and otherwise records a durable failed-permanent mutation plus the typed missing-container warning. Reassigning to Nexus marks the task `local_only` and links it through `nexus_local`.

Manual retry is also a local-first mutation. `task.retry_sync` reuses the existing provider link, queues retryable provider writes, blocks conflict retries with a visible conflict warning, and refuses to invent missing provider containers.

Provider full-pull deletion is conflict-aware. A provider task that disappears from a full provider pull is marked `provider_missing`; if Nexus has a pending local mutation, it is marked `conflict`. Nexus keeps the local row visible in both cases and records a typed sync issue. A Nexus-local delete remains `deleted_pending_sync` until provider reconciliation treats provider-missing as a successful delete.

## Backend API Surface

Task read routes (`/api/v1/tasks/lists`, `/working-set`, `/snapshot`, `/changes`, `/filtered`, `/list/:listId`, and `/:listId/:taskId`) must read local Nexus state only.

Task mutation routes accept stable `clientMutationId` and `idempotencyKey` values where applicable:

- `POST /api/v1/tasks`
- `PATCH /api/v1/tasks/:listId/:taskId`
- `POST /api/v1/tasks/:listId/:taskId/complete`
- `POST /api/v1/tasks/:listId/:taskId/move`
- `POST /api/v1/tasks/:listId/:taskId/checklist`
- `PATCH /api/v1/tasks/:listId/:taskId/checklist/:itemId`
- `POST /api/v1/tasks/:listId/:taskId/sync/assign-provider`
- `POST /api/v1/tasks/:listId/:taskId/sync/retry`
- `DELETE /api/v1/tasks/:listId/:taskId`

All task mutation routes resolve to the canonical Nexus task id before changing local state or writing the ledger. Missing local targets return `404` and must not fall back to live provider calls.

## Provider Adapter Contract

Provider adapters are reached through `getTaskProviderForUser(userId, providerOverride)` so sync workers can target the provider recorded in `task_provider_links`, not whatever the user's current default provider happens to be. Adapters must expose bounded create, update, complete/reopen, delete, task lookup, and list/project reads through the shared task-provider interface. Provider-specific capability differences are declared in `task-provider-capabilities.ts`; projection must return local-only fields and typed warnings instead of dropping unsupported data.

Provider writes use Nexus-generated provider idempotency keys with the shape `provider:providerAccountId:nexusTaskId:operation:mutationId`. If the provider does not support native idempotency, Nexus emulates it with existing provider links, duplicate search/recovery on retry where available, read-back verification, and reconciliation jobs.

Microsoft To Do create writes stamp `nexus_task_id` into Graph linked resources and do not use automatic create retries because Graph does not provide a task-create idempotency header. Todoist create writes send the provider idempotency key as `X-Request-Id` and append a Nexus marker to the provider description; the adapter parses the marker back into `providerData.nexus_task_id` and strips it from Nexus-visible descriptions so recovery can match Todoist replicas deterministically.

Provider conflict versions are provider-specific. Microsoft To Do stores the Graph etag. Todoist REST v2 does not expose an etag, revision, or updated-at value, so Nexus stores a synthetic `fp:<hash>` content fingerprint over the Todoist fields Nexus writes and compares it with a fresh provider read before update/complete/reopen writes.

## Worker Semantics

The mutation worker drains local mutations before provider imports in the scheduler. It:

- selects only queued or retry-scheduled mutations;
- reclaims stale `syncing` leases after the task worker lease timeout;
- applies provider write timeouts;
- uses exponential backoff for retryable failures;
- enforces in-process backpressure per global/provider/account/tenant write buckets;
- opens short-lived provider/account circuit breakers after repeated retryable provider failures;
- marks permanent failures visible without hot-looping them;
- updates provider links after create/update/delete/move verification;
- treats provider-missing delete as success;
- records typed sync issues for disconnected, timed-out, rate-limited, unsupported, missing, or conflicting provider states.
- writes Microsoft To Do checklist items after task create/update and only marks checklist metadata local-only for providers that do not support subtasks.
- drains user-requested retry mutations from the same ledger as normal local mutations, so retries remain idempotent and observable.

`GET /api/v1/tasks/changes` emits opaque composite cursors in the form `<change_seq>|<nexus task id>`, ordered by materialized `unified_tasks.change_seq` and `nexus_task_id`, so same-second bulk updates do not lose overflow rows and SQLite can use `idx_unified_tasks_changes_seq`. `change_seq` is maintained by migration triggers from `COALESCE(deleted_at, updated_at, created_at)`.

## Observability

`GET /api/v1/tasks/sync/status` returns aggregate local sync health, not raw provider data. It includes mutation backlog by status/error, task sync-state counts, open typed sync issues, local-only/provider-disconnected/provider-missing/conflict counts, provider timeout/rate-limit counters, duplicate provider-link groups, durable duplicate-prevention hits, and active worker backpressure/circuit-breaker state.

## iOS Semantics

iOS must:

- load `TaskSnapshotStore` before network refresh;
- render immediately from local snapshots;
- persist `TaskMutationOutbox` by tenant/user scope;
- keep queued mutations across app restart and tenant namespace switches;
- purge snapshots, outbox, cursors, and provider metadata on sign-out;
- never store provider tokens in task snapshot or outbox files;
- replay queued mutations with the original idempotency keys;
- rewrite placeholder task ids to backend Nexus ids after queued creates succeed.
- queue checklist add/toggle mutations offline, render the checklist change optimistically, and replay with the original idempotency keys.

## Acceptance Gates

- Tasks first paint does not depend on Microsoft Graph, Todoist, or future provider reads.
- Offline create/update/complete/reopen/delete/move/checklist add/checklist toggle mutates local UI immediately and survives restart.
- Provider failures degrade freshness and produce typed warnings; they do not break reads.
- Provider retries do not create duplicate Nexus tasks or provider tasks.
- Provider assignment and retry are idempotent, tenant/user scoped, and never choose arbitrary provider containers.
- Duplicate idempotent replays are recorded as `duplicate_prevention_hit` observability events.
- Tenant A cannot read Tenant B snapshots, outbox rows, provider links, mutations, or sync issues.
- Missing provider containers never fall back to arbitrary defaults.
- Reconciliation detects provider-missing tasks, duplicate provider links, and stale links.
