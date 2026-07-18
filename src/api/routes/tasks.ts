// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { config } from '../../config';
import { setCache, setCacheSWR } from '../../services/cache-store';
import { sendSuccess, sendError, sendInternalError } from '../response-helpers';
import * as microsoftTodo from '../../services/microsoft-todo';
import { getTaskProviderForUser, resolveTaskProvider } from '../../services/task-store/task-router';
import { getOwnerBootstrapUser } from '../../services/user-service';
import { ensureValidTenantRouteScope } from '../tenant-route-scope';
import { assertTenantScope } from '../../services/tenant-scope';
import { invalidateTaskCaches } from '../../services/cache-coherence-registry';
import {
  capTaskPageSize,
  normalizeTaskListScope,
  statusForTaskScope,
} from '../../services/task-working-set-policy';
import { buildNexusAnswerContract } from '../../services/chat-answer-contract';
import { safeRecordChatV2DeterministicReadEvidence } from '../../services/chat-deterministic-read-evidence';
import { isSingleWritePathEnabled } from '../../services/task-store/single-write-path';
import { isValidTaskPriorityInput } from '../../services/task-store/task-priority';
import {
  addOfflineTaskChecklistItem,
  assignOfflineTaskProvider,
  createOfflineFirstTask,
  createOfflineFirstTaskList,
  deleteOfflineFirstTaskList,
  getOfflineFilteredTasks,
  getOfflineRecentlyDeletedTasks,
  getOfflineTaskById,
  getOfflineTaskChanges,
  getOfflineTaskLists,
  getOfflineTasksForList,
  getOfflineTaskSnapshot,
  moveOfflineFirstTask,
  recordLocalTaskMutation,
  restoreOfflineFirstTask,
  retryOfflineTaskSync,
  resolveOfflineNexusTaskId,
  toggleOfflineTaskChecklistItem,
  updateOfflineFirstTask,
} from '../../services/task-store/offline-first-task-service';
import { getTaskSyncOperationalMetrics } from '../../services/task-store/task-mutation-sync-worker';
import { requestTaskSync } from '../../services/task-store/task-sync-coordinator';
import { getAdapter } from '../../services/task-store/sync-engine';
import {
  setTaskListSyncSelection,
  normalizeTaskListSelectionProvider,
  type TaskListSelectionProvider,
} from '../../services/task-store/task-list-sync-selection';
import type { NormalizedTask } from '../../services/task-store/types';
import { getDb } from '../../services/database';
import {
  getTaskConflictPreview,
  resolveTaskConflict,
} from '../../services/task-store/task-conflict-resolution';

// Cache TTLs
const LISTS_CACHE_TTL = 300;  // 5 min for list names (rarely change)
const TASKS_CACHE_TTL = 120;  // 2 min for task items (change more often)

// SWR pattern: serve cached responses up to `staleSec` past the fresh boundary,
// while triggering an async refresh in the background. The user always sees
// instant responses; the next request gets the refreshed data.
const LISTS_SWR_STALE = 1800;  // 30 min stale grace for lists
const TASKS_SWR_STALE = 600;   // 10 min stale grace for individual lists

// ── POST /sync/now policy (M6) ─────────────────────────────────────────
// Bounded-wait hybrid: run-and-await up to the wait budget (env-overridable
// for tests, mirroring the task-store flag helpers) → 200 with a fresh
// /sync/status-shaped summary; already-active/coalesced, initial-import, or
// timeout → 202 { syncRequestId, status: 'queued' }. Per-user fixed-window
// rate limit mirrors the worker's provider-write bucket pattern.
const SYNC_NOW_DEFAULT_WAIT_MS = 8_000;
const SYNC_NOW_RATE_LIMIT = 6;
const SYNC_NOW_RATE_WINDOW_MS = 60_000;
const syncNowRateBuckets = new Map<number, { windowStart: number; count: number }>();

function syncNowWaitMs(): number {
  const parsed = Number(process.env.TASK_SYNC_NOW_WAIT_MS || '');
  if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  return SYNC_NOW_DEFAULT_WAIT_MS;
}

function allowSyncNow(userId: number): boolean {
  const now = Date.now();
  const bucket = syncNowRateBuckets.get(userId);
  if (!bucket || now - bucket.windowStart >= SYNC_NOW_RATE_WINDOW_MS) {
    syncNowRateBuckets.set(userId, { windowStart: now, count: 1 });
    return true;
  }
  if (bucket.count >= SYNC_NOW_RATE_LIMIT) return false;
  bucket.count += 1;
  return true;
}

/** Test-only: clear the per-user force-sync rate limiter. */
export function _resetTaskSyncNowRateLimiterForTests(): void {
  syncNowRateBuckets.clear();
}

/**
 * A provider whose very first import has not completed yet (status 'syncing'
 * with no successful sync recorded) — force-sync answers 202 while that
 * initial import (or a delta 410 resync riding the active run) is in flight.
 */
function isInitialTaskImportInProgress(userId: number): boolean {
  try {
    const row = getDb().prepare(
      `SELECT 1 FROM task_sync_state
       WHERE user_id = ? AND status = 'syncing' AND last_sync_at IS NULL
       LIMIT 1`,
    ).get(userId);
    return !!row;
  } catch {
    return false;
  }
}

async function awaitSyncCompletion<T>(completion: Promise<T>, waitMs: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      completion,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), waitMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function dateKeyInAppTimezone(
  value: Date | string,
  timezone = config.app.timezone || 'Europe/Lisbon',
): string | null {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  try {
    return date.toLocaleDateString('en-CA', { timeZone: timezone });
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export function taskDueDateKey(
  task: any,
  timezone = config.app.timezone || 'Europe/Lisbon',
): string | null {
  const raw = task?.dueDateTime?.dateTime || task?.dueDateTime;
  if (!raw) return null;
  return dateKeyInAppTimezone(raw, timezone);
}

function normalizedTaskStatus(value: unknown): string {
  return String(value || '').trim().toLowerCase().replace(/[\s_-]/g, '');
}

/**
 * M10 (NEX-17): validate an optional wire `priority`. Absent (undefined or
 * null) is fine — anything else must be an integer 0–4 (0 = none, 1 = P1
 * highest … 4 = P4 lowest) or the route answers 400 VALIDATION.
 */
function sendInvalidTaskPriority(res: Response, value: unknown): boolean {
  if (value == null || isValidTaskPriorityInput(value)) return false;
  sendError(res, 'VALIDATION', 'priority must be an integer between 0 and 4 (0 = none, 1 = P1 highest, 4 = P4 lowest)', 400);
  return true;
}

function isTaskStatusOnlyPatch(body: unknown): body is { status?: unknown; idempotencyKey?: unknown; clientMutationId?: unknown; baseLocalVersion?: unknown } {
  if (!body || typeof body !== 'object') return false;
  const keys = Object.keys(body as Record<string, unknown>);
  return keys.length > 0 && keys.every((key) => ['status', 'idempotencyKey', 'clientMutationId', 'baseLocalVersion'].includes(key));
}

/**
 * Map a VERSION_CONFLICT (optional client OCC, NEX-24) to the 409 contract:
 * the current task DTO rides in error.details so the client can rebase
 * without a second read. Returns true when the error was handled.
 */
function sendVersionConflict(res: Response, err: any): boolean {
  if (err?.code !== 'VERSION_CONFLICT') return false;
  sendError(res, 'VERSION_CONFLICT', err.message || 'Task changed since the client base version', 409, {
    currentTask: err.currentTask || null,
  });
  return true;
}

function isCompletedLikeTask(task: any): boolean {
  switch (normalizedTaskStatus(task?.status)) {
    case 'completed':
    case 'complete':
    case 'done':
    case 'cancelled':
    case 'canceled':
      return true;
    default:
      return false;
  }
}

function recordTasksFilteredApiReadEvidence(input: {
  userId: number;
  tenantId: number | undefined;
  filter: string;
  payload: { count?: unknown };
  cached: boolean;
}): void {
  const tenantId = typeof input.tenantId === 'number' && input.tenantId > 0 ? input.tenantId : input.userId;
  const normalizedMessage = `GET /api/v1/tasks/filtered?filter=${input.filter}`;
  const requestId = `tasks-filtered:${tenantId}:${input.userId}:${input.filter}:${Date.now()}`;
  const count = typeof input.payload.count === 'number' ? input.payload.count : 0;
  safeRecordChatV2DeterministicReadEvidence({
    tenantId,
    userId: input.userId,
    requestId,
    normalizedMessage,
    tokenZeroSurface: 'api',
    tokenZeroPreserved: true,
    tenantUserIsolationPassed: true,
    response: {
      id: requestId,
      text: `Tasks API returned ${count} item${count === 1 ? '' : 's'}.`,
      domain: 'tasks',
      routeMethod: 'api',
      metadata: {
        chatReasoning: buildNexusAnswerContract({
          intent: 'tasks.read',
          ownerSkill: 'tasks',
          routeMethod: 'api',
          routeKind: 'local_read',
          groundingRequirement: 'local',
          expectedResponseShape: 'task_options',
          language: 'en',
          actionability: 'answer_only',
          verificationStatus: 'not_required',
          confidence: 1,
          traceId: requestId,
          fallback: input.cached ? { fallbackType: 'cached_read' } : undefined,
        }),
      },
    },
  });
}

/**
 * Get the task provider for the current request's user.
 * If the user has MS To-Do connected → microsoft-todo module.
 * If not → native SQLite task adapter (same interface).
 *
 * M5: only the legacy (TASK_SINGLE_WRITE_PATH=0) branches of the two list
 * routes still call this; it goes away with the flag after the soak.
 */
function getTodo(req?: any) {
  if (req?.userId) {
    try {
      return getTaskProviderForUser(req.userId);
    } catch {
      // task-router not available — fall back to MS To-Do
    }
  }
  return microsoftTodo;
}

/** Provider list id a pulled task belongs to (Microsoft `listId`, Todoist `project_id`). */
function taskPreviewListId(task: NormalizedTask): string | null {
  const data = task.providerData as Record<string, unknown> | undefined;
  const raw =
    data?.listId ?? data?.list_id ?? data?.parentFolderId ?? data?.project_id ?? data?.projectId;
  if (raw != null && String(raw).trim()) return String(raw);
  return task.projectId != null ? String(task.projectId) : null;
}

/**
 * Active local-origin tasks that the connect flow would push upstream (the "M
 * local tasks" in "uploads M local tasks"). These are Nexus-created rows, not
 * provider imports.
 */
function countLocalUploadableTasks(tenantId: number, userId: number): number {
  try {
    const row = getDb().prepare(
      `SELECT COUNT(*) AS count
       FROM unified_tasks
       WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ?
         AND provider = 'nexus' AND is_deleted = 0`,
    ).get(userId, tenantId) as { count: number } | undefined;
    return row?.count || 0;
  } catch {
    return 0;
  }
}

/**
 * The set of provider list ids to reason about at connect time. Prefers a live
 * probe (authoritative, includes lists added since the last import); falls back
 * to already-imported projects so connect never fails just because the provider
 * is briefly unreachable.
 */
async function resolveProviderListUniverse(
  tenantId: number,
  userId: number,
  provider: TaskListSelectionProvider,
): Promise<Set<string>> {
  const ids = new Set<string>();
  const adapter = getAdapter(provider);
  if (adapter && adapter.isConnected(userId)) {
    try {
      const projects = await adapter.getProjects(userId);
      for (const project of projects) {
        if (project.externalId) ids.add(project.externalId);
      }
      return ids;
    } catch (err) {
      logger.warn({ err, userId, provider }, 'Connect list-universe probe failed; using imported projects');
    }
  }
  try {
    const rows = getDb().prepare(
      `SELECT external_id FROM unified_projects
       WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ? AND provider = ?`,
    ).all(userId, tenantId, provider) as Array<{ external_id: string | null }>;
    for (const row of rows) {
      if (row.external_id) ids.add(row.external_id);
    }
  } catch {
    /* unified_projects unavailable — return whatever the probe found. */
  }
  return ids;
}

export function taskRoutes(): Router {
  const router = Router();

  router.use((req, res, next) => {
    const { userId } = req as AuthenticatedRequest;
    if (!ensureValidTenantRouteScope(res as Response, userId, 'tasks_route', {
      method: req.method,
      path: req.path,
    })) return;
    next();
  });

  /**
   * GET /api/v1/tasks/lists — cached in SQLite with SWR semantics.
   *
   * - Within 5 min of fetch: served instantly as fresh.
   * - 5 min – 35 min: served instantly as stale, background refresh triggered.
   * - >35 min: synchronous fetch (cold path, very rare given 2-min cache warmer).
   */
  router.get('/lists', async (req, res: Response) => {
    try {
      const { userId, tenantId } = assertTenantScope(req as any, 'tasks_lists_local_read');
      sendSuccess(res, getOfflineTaskLists(tenantId, userId));
    } catch (err: any) {
      logger.error({ err }, 'iOS tasks/lists failed');
      sendInternalError(res, 'Failed to fetch lists');
    }
  });

  router.get('/snapshot', async (req, res: Response) => {
    try {
      const { userId, tenantId } = assertTenantScope(req as any, 'tasks_snapshot_local_read');
      sendSuccess(res, getOfflineTaskSnapshot(tenantId, userId, {
        pageSize: capTaskPageSize(req.query.pageSize, 75, 200),
      }));
    } catch (err: any) {
      logger.error({ err }, 'iOS tasks/snapshot failed');
      sendInternalError(res, 'Failed to fetch task snapshot');
    }
  });

  router.get('/changes', async (req, res: Response) => {
    try {
      const { userId, tenantId } = assertTenantScope(req as any, 'tasks_changes_local_read');
      const sinceCursor = typeof req.query.sinceCursor === 'string' ? req.query.sinceCursor : undefined;
      sendSuccess(res, getOfflineTaskChanges(tenantId, userId, sinceCursor));
    } catch (err: any) {
      logger.error({ err }, 'iOS tasks/changes failed');
      sendInternalError(res, 'Failed to fetch task changes');
    }
  });

  /**
   * GET /api/v1/tasks/deleted?limit=50 — Recently Deleted read (M11).
   *
   * Token-zero local read over tombstoned rows (is_deleted = 1) for the
   * requesting tenant/user, newest effective deletion first, capped limit
   * (default 50, max 100). Only tombstones from the last 90 days are shown
   * (RECENTLY_DELETED_WINDOW_DAYS — pinned to the ledger retention horizon;
   * tombstoned task rows themselves are never pruned by retention).
   *
   * Contract (pinned with the iOS Recently Deleted section):
   *   200 { tasks: [{ id, title, listId, listName, deletedAt, syncProvider,
   *                   restorable }], count }
   * `count` is the TOTAL in-window tombstone count (it can exceed
   * tasks.length when the limit clamps the page) and always equals
   * /sync/status.deletedRecentCount. `restorable: false` only for merged
   * twin-repair tombstones, where POST /:listId/:taskId/restore (M9) would
   * answer 409 NOT_RESTORABLE; every other tombstone restores.
   */
  router.get('/deleted', async (req, res: Response) => {
    try {
      const { userId, tenantId } = assertTenantScope(req as any, 'tasks_deleted_local_read');
      sendSuccess(res, getOfflineRecentlyDeletedTasks(tenantId, userId, {
        limit: capTaskPageSize(req.query.limit, 50, 100),
      }));
    } catch (err: any) {
      logger.error({ err }, 'iOS tasks/deleted failed');
      sendInternalError(res, 'Failed to fetch recently deleted tasks');
    }
  });

  router.get('/sync/status', async (req, res: Response) => {
    try {
      const { userId, tenantId } = assertTenantScope(req as any, 'tasks_sync_status_local_read');
      sendSuccess(res, getTaskSyncOperationalMetrics(tenantId, userId));
    } catch (err: any) {
      logger.error({ err }, 'iOS tasks/sync/status failed');
      sendInternalError(res, 'Failed to fetch task sync status');
    }
  });

  /**
   * POST /api/v1/tasks/sync/now — real force-sync (M6, token-zero surface).
   *
   * Runs push + forced pull through the task-sync coordinator (single-flight
   * per scope — providers are only ever reached through it, and delta mode
   * only when TASK_MS_DELTA_SYNC is on). Bounded-wait hybrid:
   *   - run finished within the wait budget → 200 with the run summary plus
   *     a fresh /sync/status-shaped payload;
   *   - a sync was already active (request coalesced), an initial import or
   *     410 resync is in flight, or the wait budget elapsed → 202
   *     { syncRequestId, status: 'queued' } — the run keeps going.
   * Rate-limited per user (fixed window) → 429 RATE_LIMITED.
   */
  router.post('/sync/now', async (req, res: Response) => {
    try {
      const { userId, tenantId } = assertTenantScope(req as any, 'tasks_sync_now_mutation');
      if (!allowSyncNow(userId)) {
        sendError(res, 'RATE_LIMITED', 'Too many sync requests. Try again shortly.', 429);
        return;
      }

      const request = requestTaskSync({ tenantId, userId }, 'force_sync', {
        push: true,
        pull: 'all',
        pullForce: true,
      });

      if (request.status === 'coalesced' || isInitialTaskImportInProgress(userId)) {
        sendSuccess(res, { syncRequestId: request.syncRequestId, status: 'queued' }, { status: 202 });
        return;
      }

      const summary = await awaitSyncCompletion(request.completion, syncNowWaitMs());
      if (!summary) {
        sendSuccess(res, { syncRequestId: request.syncRequestId, status: 'queued' }, { status: 202 });
        return;
      }

      sendSuccess(res, {
        syncRequestId: request.syncRequestId,
        status: 'completed',
        sync: {
          startedAt: summary.startedAt,
          finishedAt: summary.finishedAt,
          push: summary.push,
          pull: summary.pull,
          errors: summary.errors,
        },
        ...getTaskSyncOperationalMetrics(tenantId, userId),
      });
    } catch (err: any) {
      logger.error({ err }, 'iOS tasks/sync/now failed');
      sendInternalError(res, 'Failed to run task sync');
    }
  });

  /**
   * GET /api/v1/tasks/sync/import-preview?provider=ms_todo — merge preview (M12).
   *
   * A live, token-zero (no-AI) probe of the freshly-connected provider so iOS
   * can show "Imports N tasks · uploads M local tasks" and a per-list checkbox
   * list BEFORE the full import. Contract (pinned with the iOS connect screen):
   *   200 {
   *     provider,
   *     lists: [{ providerListId, name, taskCount }],
   *     localTaskCount,          // active Nexus-origin tasks that would upload
   *     wouldImportTaskCount,    // total provider tasks across all lists
   *     incomplete               // provider returned a partial set (some lists errored)
   *   }
   *   400 BAD_REQUEST          — provider missing / not selectable
   *   409 PROVIDER_NOT_CONNECTED — provider has no live connection yet
   *   503 PROVIDER_UNAVAILABLE — the live probe could not reach the provider
   *
   * `taskCount` is derived by bucketing the live task pull by list id, so it is
   * exact even on a first connect (before anything is imported locally).
   */
  router.get('/sync/import-preview', async (req, res: Response) => {
    try {
      const { userId, tenantId } = assertTenantScope(req as any, 'tasks_import_preview_read');
      const provider = normalizeTaskListSelectionProvider(req.query.provider);
      if (!provider) {
        sendError(res, 'BAD_REQUEST', 'provider must be one of ms_todo, todoist, notion.', 400);
        return;
      }
      const adapter = getAdapter(provider);
      if (!adapter || !adapter.isConnected(userId)) {
        sendError(res, 'PROVIDER_NOT_CONNECTED', 'Connect this provider before previewing its lists.', 409);
        return;
      }

      let projects;
      let pull;
      try {
        projects = await adapter.getProjects(userId);
        pull = await adapter.getTasks(userId, { knownProjects: projects });
      } catch (err) {
        logger.warn({ err, userId, provider }, 'Import preview provider probe failed');
        sendError(res, 'PROVIDER_UNAVAILABLE', 'Could not reach the provider to build an import preview. Try again shortly.', 503);
        return;
      }

      const countsByList = new Map<string, number>();
      for (const task of pull.tasks) {
        const listId = taskPreviewListId(task);
        if (!listId) continue;
        countsByList.set(listId, (countsByList.get(listId) || 0) + 1);
      }
      const lists = projects.map((project) => ({
        providerListId: project.externalId,
        name: project.name,
        taskCount: countsByList.get(project.externalId) || 0,
      }));

      sendSuccess(res, {
        provider,
        lists,
        localTaskCount: countLocalUploadableTasks(tenantId, userId),
        wouldImportTaskCount: pull.tasks.length,
        incomplete: Boolean(pull.incomplete),
      });
    } catch (err: any) {
      logger.error({ err }, 'iOS tasks/sync/import-preview failed');
      sendInternalError(res, 'Failed to build import preview');
    }
  });

  /**
   * POST /api/v1/tasks/sync/connect — record the user's list selection (M12).
   *
   * Body: { provider, selectedListIds: string[] }. Persists one selection row
   * per provider list: enabled for the ids in `selectedListIds`, disabled for
   * the rest of the known universe (live probe, else already-imported
   * projects), then kicks the coordinated connect sync (push-before-pull) so
   * the initial import + ongoing sync only touch the selected lists. Resilient:
   * it never 503s on provider flakiness — the selection is always persisted.
   *   200 { provider, selectedListIds, enabledCount, disabledCount, syncStarted }
   *   400 BAD_REQUEST — provider not selectable / selectedListIds not string[]
   */
  router.post('/sync/connect', async (req, res: Response) => {
    try {
      const { userId, tenantId } = assertTenantScope(req as any, 'tasks_sync_connect_mutation');
      const provider = normalizeTaskListSelectionProvider(req.body?.provider);
      if (!provider) {
        sendError(res, 'BAD_REQUEST', 'provider must be one of ms_todo, todoist, notion.', 400);
        return;
      }
      const rawSelected = req.body?.selectedListIds;
      if (!Array.isArray(rawSelected) || !rawSelected.every((id) => typeof id === 'string')) {
        sendError(res, 'BAD_REQUEST', 'selectedListIds must be an array of provider list ids.', 400);
        return;
      }

      const selectedSet = new Set(rawSelected.map((id) => id.trim()).filter((id) => id.length > 0));
      const universe = await resolveProviderListUniverse(tenantId, userId, provider);

      const entries = [
        ...[...selectedSet].map((providerListId) => ({ providerListId, syncEnabled: true })),
        ...[...universe]
          .filter((providerListId) => !selectedSet.has(providerListId))
          .map((providerListId) => ({ providerListId, syncEnabled: false })),
      ];
      const { enabledCount, disabledCount } = setTaskListSyncSelection({ tenantId, userId, provider, entries });

      let syncStarted = false;
      try {
        const request = requestTaskSync({ tenantId, userId }, 'connect', { push: true, pull: [provider] });
        // The coordinator's completion never rejects, but attach a guard so an
        // unexpected error can't surface as an unhandled rejection.
        Promise.resolve(request.completion).catch(() => undefined);
        syncStarted = true;
      } catch (err) {
        logger.warn({ err, userId, provider }, 'Connect sync kick failed (selection still saved)');
      }

      sendSuccess(res, {
        provider,
        selectedListIds: [...selectedSet],
        enabledCount,
        disabledCount,
        syncStarted,
      });
    } catch (err: any) {
      logger.error({ err }, 'iOS tasks/sync/connect failed');
      sendInternalError(res, 'Failed to save list selection');
    }
  });

  /**
   * GET /api/v1/tasks/working-set — bounded app-facing snapshot.
   *
   * This is the first-load contract for iOS. It returns enough active task
   * truth to paint the Tasks tab without pulling completed history into the
   * active UI state. Historical completed tasks stay behind explicit,
   * paginated list reads.
   */
  router.get('/working-set', async (req, res: Response) => {
    try {
      const { userId, tenantId } = assertTenantScope(req as any, 'tasks_working_set_local_read');
      sendSuccess(res, getOfflineTaskSnapshot(tenantId, userId, {
        pageSize: capTaskPageSize(req.query.pageSize, 75, 200),
      }));
    } catch (err: any) {
      if (err?.code || err?.status) {
        sendError(res, err?.code ?? 'UNAUTHORIZED', err?.message ?? 'Authenticated user required', err?.status ?? 401);
        return;
      }
      logger.error({ err }, 'iOS tasks/working-set failed');
      sendInternalError(res, 'Failed to fetch task working set');
    }
  });

  /**
   * POST /api/v1/tasks/lists — create a new task list.
   * Body: { name: string }
   * M5: writes the offline-first ledger (instant local visibility, async
   * provider push); the legacy provider route survives behind
   * TASK_SINGLE_WRITE_PATH=0.
   */
  router.post('/lists', async (req, res: Response) => {
    try {
      const userId = (req as any).userId;
      const { name } = req.body;
      if (!name || typeof name !== 'string' || !name.trim()) {
        sendError(res, 'VALIDATION', 'name is required', 400);
        return;
      }
      if (isSingleWritePathEnabled()) {
        // M5 ledger path (NEX-10): the local unified_projects row exists
        // immediately, so GET /lists shows the new list instantly; the
        // provider push is journaled for the mutation worker.
        const { userId: scopedUserId, tenantId } = assertTenantScope(req as any, 'tasks_lists_create_local_mutation');
        const result = createOfflineFirstTaskList(tenantId, scopedUserId, {
          name: name.trim(),
          idempotencyKey: req.body?.idempotencyKey,
          clientMutationId: req.body?.clientMutationId,
        });
        invalidateTaskCaches({ userId: scopedUserId, includeDerivedSurfaces: false });
        // CONTRACT PIN: deployed iOS decodes `id` and `displayName` as
        // NON-OPTIONAL strings and uses `id` for subsequent reads, so `id`
        // MUST be the local project row id that GET /lists returns.
        sendSuccess(res, { id: result.list.id, displayName: result.list.name }, { status: 201 });
        return;
      }
      // Legacy direct-provider path (TASK_SINGLE_WRITE_PATH=0).
      const todo = getTodo(req);
      const result = await todo.createList(name.trim());
      if (!result?.success) {
        sendError(res, 'UNSUPPORTED', result?.error || 'Task list creation is not supported by the active task provider', 400);
        return;
      }
      invalidateTaskCaches({ userId, includeDerivedSurfaces: false });
      sendSuccess(res, result.data, { status: 201 });
    } catch (err: any) {
      if (err?.code === 'BAD_REQUEST') {
        sendError(res, 'VALIDATION', err.message || 'Invalid list create request', 400);
        return;
      }
      logger.error({ err }, 'iOS tasks/lists POST failed');
      sendInternalError(res, 'Failed to create list');
    }
  });

  /**
   * GET /api/v1/tasks/filtered?filter=overdue|dueToday|all
   * Returns tasks across ALL lists in a single call (no N+1).
   * SWR-cached: 2 min fresh, 10 min stale grace.
   */
  router.get('/filtered', async (req, res: Response) => {
    const filter = (req.query.filter as string) || 'all';
    try {
      const { userId, tenantId } = assertTenantScope(req as any, 'tasks_filtered_local_read');
      const payload = getOfflineFilteredTasks(tenantId, userId, filter);
      recordTasksFilteredApiReadEvidence({
        userId,
        tenantId,
        filter,
        payload,
        cached: false,
      });
      sendSuccess(res, payload);
    } catch (err: any) {
      logger.error({ err }, 'iOS tasks/filtered failed');
      sendInternalError(res, 'Failed to fetch tasks');
    }
  });

  /**
   * GET /api/v1/tasks/list/:listId — SWR-cached per list.
   *
   * - 2 min fresh window
   * - 10 min stale grace (background refresh on stale hits)
   */
  router.get('/list/:listId', async (req, res: Response) => {
    const { listId } = req.params;
    const scope = normalizeTaskListScope(req.query.scope, req.query.status);
    const status = statusForTaskScope(scope, req.query.status);
    const pageSize = capTaskPageSize(req.query.pageSize ?? req.query.limit, scope === 'completed' ? 50 : 75, 150);
    try {
      const { userId, tenantId } = assertTenantScope(req as any, 'tasks_list_local_read');
      sendSuccess(res, getOfflineTasksForList(tenantId, userId, listId, {
        status,
        pageSize,
        listName: typeof req.query.listName === 'string' ? req.query.listName : undefined,
      }));
      return;
    } catch (err: any) {
      logger.error({ err }, 'iOS tasks/list failed');
      sendInternalError(res, 'Failed to fetch list tasks');
      return;
    }

  });

  /** GET /api/v1/tasks/:listId/:taskId — full task detail for drill-down/edit flows */
  router.get('/:listId/:taskId', async (req, res: Response) => {
    try {
      const { taskId } = req.params;
      const { userId, tenantId } = assertTenantScope(req as any, 'tasks_detail_local_read');
      const task = getOfflineTaskById(tenantId, userId, taskId);
      if (!task) {
        sendError(res, 'NOT_FOUND', 'Task not found in local task store', 404);
        return;
      }
      sendSuccess(res, { task });
    } catch (err: any) {
      logger.error({ err }, 'iOS task detail failed');
      sendInternalError(res, 'Failed to fetch task detail');
    }
  });

  /** POST /api/v1/tasks — create a new task */
  router.post('/', async (req, res: Response) => {
    try {
      const { userId, tenantId } = assertTenantScope(req as any, 'tasks_create_local_mutation');
      const { title, listName, dueDateTime, reminderAt, importance, priority, body, recurrence, idempotencyKey, clientMutationId } = req.body;

      if (!title) {
        sendError(res, 'BAD_REQUEST', 'title is required');
        return;
      }
      if (sendInvalidTaskPriority(res, priority)) return;

      const result = createOfflineFirstTask(tenantId, userId, {
        title,
        listName,
        dueDateTime,
        reminderAt,
        importance,
        priority: priority ?? undefined,
        body,
        recurrence,
        idempotencyKey,
        clientMutationId,
      });
      invalidateTaskRouteCaches(result.task.listId || undefined, userId);
      sendSuccess(res, result, { status: 201 });
    } catch (err: any) {
      if (err?.code === 'BAD_REQUEST') {
        sendError(res, 'BAD_REQUEST', err.message || 'Invalid task payload', 400);
        return;
      }
      logger.error({ err }, 'iOS tasks create failed');
      sendInternalError(res, 'Failed to create task');
    }
  });

  /** PATCH /api/v1/tasks/:listId/:taskId — update a task */
  router.patch('/:listId/:taskId', async (req, res: Response) => {
    try {
      {
        const { listId, taskId } = req.params;
        if (sendInvalidTaskPriority(res, req.body?.priority)) return;
        const { userId: scopedUserId, tenantId: scopedTenantId } = assertTenantScope(req as any, 'tasks_update_local_mutation');
        const nexusTaskId = resolveOfflineNexusTaskId(scopedTenantId, scopedUserId, taskId);
        if (nexusTaskId) {
          const statusOnlyPatch = isTaskStatusOnlyPatch(req.body);
          const normalizedStatus = normalizedTaskStatus(req.body?.status);
          if (statusOnlyPatch && ['completed', 'complete', 'done'].includes(normalizedStatus)) {
            const result = recordLocalTaskMutation(scopedTenantId, scopedUserId, {
              taskId: nexusTaskId,
              operation: 'task.complete',
              idempotencyKey: req.body?.idempotencyKey,
              clientMutationId: req.body?.clientMutationId,
              patch: { status: 'completed' },
              baseLocalVersion: req.body?.baseLocalVersion,
            });
            invalidateTaskRouteCaches(listId, scopedUserId);
            sendSuccess(res, result);
            return;
          }
          if (statusOnlyPatch && ['notstarted', 'pending', 'open', 'inprogress'].includes(normalizedStatus)) {
            const result = recordLocalTaskMutation(scopedTenantId, scopedUserId, {
              taskId: nexusTaskId,
              operation: 'task.reopen',
              idempotencyKey: req.body?.idempotencyKey,
              clientMutationId: req.body?.clientMutationId,
              patch: { status: req.body?.status || 'notStarted' },
              baseLocalVersion: req.body?.baseLocalVersion,
            });
            invalidateTaskRouteCaches(listId, scopedUserId);
            sendSuccess(res, result);
            return;
          }
          const result = updateOfflineFirstTask(scopedTenantId, scopedUserId, {
            taskId: nexusTaskId,
            title: req.body?.title,
            body: req.body?.body,
            importance: req.body?.importance,
            priority: req.body?.priority ?? undefined,
            status: req.body?.status,
            dueDateTime: req.body?.dueDateTime,
            reminderAt: req.body?.reminderAt,
            recurrence: req.body?.recurrence,
            idempotencyKey: req.body?.idempotencyKey,
            clientMutationId: req.body?.clientMutationId,
            baseLocalVersion: req.body?.baseLocalVersion,
          });
          invalidateTaskRouteCaches(listId, scopedUserId);
          sendSuccess(res, result);
          return;
        }
      }

      sendError(res, 'NOT_FOUND', 'Task not found in local task store', 404);
    } catch (err: any) {
      if (sendVersionConflict(res as Response, err)) return;
      if (err?.code === 'BAD_REQUEST') {
        sendError(res, 'BAD_REQUEST', err.message || 'Invalid task payload', 400);
        return;
      }
      logger.error({ err }, 'iOS tasks update failed');
      sendInternalError(res, 'Failed to update task');
    }
  });

  /** POST /api/v1/tasks/:listId/:taskId/complete */
  router.post('/:listId/:taskId/complete', async (req, res: Response) => {
    try {
      const { listId, taskId } = req.params;
      {
        const { userId: scopedUserId, tenantId: scopedTenantId } = assertTenantScope(req as any, 'tasks_complete_local_mutation');
        const nexusTaskId = resolveOfflineNexusTaskId(scopedTenantId, scopedUserId, taskId);
        if (nexusTaskId) {
          const result = recordLocalTaskMutation(scopedTenantId, scopedUserId, {
            taskId: nexusTaskId,
            operation: 'task.complete',
            idempotencyKey: req.body?.idempotencyKey,
            clientMutationId: req.body?.clientMutationId,
            patch: { status: 'completed' },
            baseLocalVersion: req.body?.baseLocalVersion,
          });
          invalidateTaskRouteCaches(listId, scopedUserId);
          sendSuccess(res, {
            ...result,
            alreadyCompleted: false,
            message: `✅ Completed: ${result.task.title || 'task'}`,
          });
          return;
        }
      }

      sendError(res, 'NOT_FOUND', 'Task not found in local task store', 404);
    } catch (err: any) {
      if (sendVersionConflict(res as Response, err)) return;
      logger.error({ err }, 'iOS tasks complete failed');
      sendInternalError(res, 'Failed to complete task');
    }
  });

  /** PATCH /api/v1/tasks/:listId/:taskId/checklist/:itemId — toggle a checklist item */
  router.patch('/:listId/:taskId/checklist/:itemId', async (req, res: Response) => {
    try {
      const { listId, taskId, itemId } = req.params;
      const { isChecked } = req.body;

      if (typeof isChecked !== 'boolean') {
        sendError(res, 'VALIDATION', 'isChecked (boolean) is required', 400);
        return;
      }

      const { userId, tenantId } = assertTenantScope(req as any, 'tasks_checklist_toggle_local_mutation');
      const nexusTaskId = resolveOfflineNexusTaskId(tenantId, userId, taskId);
      if (!nexusTaskId) {
        sendError(res, 'NOT_FOUND', 'Task not found in local task store', 404);
        return;
      }
      const result = toggleOfflineTaskChecklistItem(tenantId, userId, {
        taskId: nexusTaskId,
        itemId,
        isChecked,
        idempotencyKey: req.body?.idempotencyKey,
        clientMutationId: req.body?.clientMutationId,
      });
      invalidateTaskRouteCaches(listId, userId);
      sendSuccess(res, {
        item: result.item,
        task: result.task,
        mutationId: result.mutationId,
        clientMutationId: result.clientMutationId,
        idempotencyKey: result.idempotencyKey,
        idempotentReplay: result.idempotentReplay,
      });
    } catch (err: any) {
      if (err?.code === 'NOT_FOUND') {
        sendError(res, 'NOT_FOUND', err.message || 'Checklist item not found', 404);
        return;
      }
      if (err?.code === 'BAD_REQUEST') {
        sendError(res, 'VALIDATION', err.message || 'Invalid checklist mutation', 400);
        return;
      }
      logger.error({ err }, 'iOS checklist toggle failed');
      sendInternalError(res, 'Failed to toggle checklist item');
    }
  });

  /** POST /api/v1/tasks/:listId/:taskId/checklist — add a checklist item */
  router.post('/:listId/:taskId/checklist', async (req, res: Response) => {
    try {
      const { listId, taskId } = req.params;
      const displayName = String(req.body?.displayName || '').trim();

      if (!displayName) {
        sendError(res, 'VALIDATION', 'displayName is required', 400);
        return;
      }

      const { userId, tenantId } = assertTenantScope(req as any, 'tasks_checklist_add_local_mutation');
      const nexusTaskId = resolveOfflineNexusTaskId(tenantId, userId, taskId);
      if (!nexusTaskId) {
        sendError(res, 'NOT_FOUND', 'Task not found in local task store', 404);
        return;
      }
      const result = addOfflineTaskChecklistItem(tenantId, userId, {
        taskId: nexusTaskId,
        displayName,
        itemId: req.body?.itemId,
        idempotencyKey: req.body?.idempotencyKey,
        clientMutationId: req.body?.clientMutationId,
      });
      invalidateTaskRouteCaches(listId, userId);
      sendSuccess(
        res,
        {
          item: result.item,
          task: result.task,
          mutationId: result.mutationId,
          clientMutationId: result.clientMutationId,
          idempotencyKey: result.idempotencyKey,
          idempotentReplay: result.idempotentReplay,
        },
        { status: 201 },
      );
    } catch (err: any) {
      if (err?.code === 'NOT_FOUND') {
        sendError(res, 'NOT_FOUND', err.message || 'Task not found', 404);
        return;
      }
      if (err?.code === 'BAD_REQUEST') {
        sendError(res, 'VALIDATION', err.message || 'Invalid checklist mutation', 400);
        return;
      }
      logger.error({ err }, 'iOS checklist add failed');
      sendInternalError(res, 'Failed to add checklist item');
    }
  });

  /** POST /api/v1/tasks/:listId/:taskId/move — move task to a different list */
  router.post('/:listId/:taskId/move', async (req, res: Response) => {
    try {
      const { listId, taskId } = req.params;
      const { targetListId } = req.body;

      if (!targetListId) {
        sendError(res, 'VALIDATION', 'targetListId is required', 400);
        return;
      }

      {
        const { userId, tenantId } = assertTenantScope(req as any, 'tasks_move_local_mutation');
        const nexusTaskId = resolveOfflineNexusTaskId(tenantId, userId, taskId);
        if (nexusTaskId) {
          const result = moveOfflineFirstTask(tenantId, userId, {
            taskId: nexusTaskId,
            targetListId,
            idempotencyKey: req.body?.idempotencyKey,
            clientMutationId: req.body?.clientMutationId,
            baseLocalVersion: req.body?.baseLocalVersion,
          });
          invalidateTaskRouteCaches(listId, userId);
          invalidateTaskRouteCaches(targetListId, userId);
          sendSuccess(res, { ...result, movedFrom: listId, movedTo: targetListId });
          return;
        }
      }

      sendError(res, 'NOT_FOUND', 'Task not found in local task store', 404);
    } catch (err: any) {
      if (sendVersionConflict(res as Response, err)) return;
      logger.error({ err }, 'iOS task move failed');
      sendInternalError(res, 'Failed to move task');
    }
  });

  /** POST /api/v1/tasks/:listId/:taskId/sync/assign-provider — choose provider sync target. */
  router.post('/:listId/:taskId/sync/assign-provider', async (req, res: Response) => {
    try {
      const { listId, taskId } = req.params;
      const provider = req.body?.provider;
      if (!provider) {
        sendError(res, 'VALIDATION', 'provider is required', 400);
        return;
      }

      const { userId, tenantId } = assertTenantScope(req as any, 'tasks_assign_provider_local_mutation');
      const nexusTaskId = resolveOfflineNexusTaskId(tenantId, userId, taskId);
      if (!nexusTaskId) {
        sendError(res, 'NOT_FOUND', 'Task not found in local task store', 404);
        return;
      }

      const result = assignOfflineTaskProvider(tenantId, userId, {
        taskId: nexusTaskId,
        provider,
        idempotencyKey: req.body?.idempotencyKey,
        clientMutationId: req.body?.clientMutationId,
      } as any);
      invalidateTaskRouteCaches(listId, userId);
      sendSuccess(res, result);
    } catch (err: any) {
      if (err?.code === 'BAD_REQUEST') {
        sendError(res, 'VALIDATION', err.message || 'Invalid provider assignment', 400);
        return;
      }
      if (err?.code === 'NOT_FOUND') {
        sendError(res, 'NOT_FOUND', err.message || 'Task not found', 404);
        return;
      }
      logger.error({ err }, 'iOS task assign provider failed');
      sendInternalError(res, 'Failed to assign task provider');
    }
  });

  /**
   * GET /api/v1/tasks/:listId/:taskId/sync/conflict — conflict resolve preview.
   *
   * Live re-fetches the provider copy (reconciliation-style getTask probe,
   * 10s timeout) so the user decides against the provider's CURRENT content:
   * { conflictId, mine, theirs|null, providerVersion, providerMissing,
   * fetchedAt }. 404 CONFLICT_NOT_FOUND when the task has no unresolved
   * conflict; 503 PROVIDER_UNAVAILABLE when the provider cannot be reached.
   */
  router.get('/:listId/:taskId/sync/conflict', async (req, res: Response) => {
    try {
      const { taskId } = req.params;
      const { userId, tenantId } = assertTenantScope(req as any, 'tasks_conflict_preview_read');
      const preview = await getTaskConflictPreview(tenantId, userId, taskId);
      sendSuccess(res, preview);
    } catch (err: any) {
      if (err?.code === 'NOT_FOUND') {
        sendError(res, 'NOT_FOUND', err.message || 'Task not found in local task store', 404);
        return;
      }
      if (err?.code === 'CONFLICT_NOT_FOUND') {
        sendError(res, 'CONFLICT_NOT_FOUND', err.message || 'Task has no unresolved sync conflict', 404);
        return;
      }
      if (err?.code === 'PROVIDER_UNAVAILABLE') {
        sendError(res, 'PROVIDER_UNAVAILABLE', err.message || 'Provider is unreachable. Try again shortly.', 503);
        return;
      }
      logger.error({ err }, 'iOS task conflict preview failed');
      sendInternalError(res, 'Failed to load task conflict preview');
    }
  });

  /**
   * POST /api/v1/tasks/:listId/:taskId/sync/resolve — resolve a sync conflict.
   * Body: { strategy: 'keep_local'|'keep_provider', expectedProviderVersion?,
   * idempotencyKey?, clientMutationId? }. A provided expectedProviderVersion
   * that no longer matches the live provider copy returns 409 CONFLICT_STALE
   * with a refreshed preview in error.details.preview.
   */
  router.post('/:listId/:taskId/sync/resolve', async (req, res: Response) => {
    try {
      const { listId, taskId } = req.params;
      const strategy = req.body?.strategy;
      if (strategy !== 'keep_local' && strategy !== 'keep_provider') {
        sendError(res, 'VALIDATION', "strategy must be 'keep_local' or 'keep_provider'", 400);
        return;
      }

      const { userId, tenantId } = assertTenantScope(req as any, 'tasks_conflict_resolve_local_mutation');
      const result = await resolveTaskConflict(tenantId, userId, {
        taskId,
        strategy,
        expectedProviderVersion: req.body?.expectedProviderVersion,
        idempotencyKey: req.body?.idempotencyKey,
        clientMutationId: req.body?.clientMutationId,
      });
      invalidateTaskRouteCaches(listId, userId);
      sendSuccess(res, result);
    } catch (err: any) {
      if (err?.code === 'BAD_REQUEST') {
        sendError(res, 'VALIDATION', err.message || 'Invalid conflict resolution request', 400);
        return;
      }
      if (err?.code === 'NOT_FOUND') {
        sendError(res, 'NOT_FOUND', err.message || 'Task not found in local task store', 404);
        return;
      }
      if (err?.code === 'CONFLICT_NOT_FOUND') {
        sendError(res, 'CONFLICT_NOT_FOUND', err.message || 'Task has no unresolved sync conflict', 404);
        return;
      }
      if (err?.code === 'CONFLICT_STALE') {
        sendError(res, 'CONFLICT_STALE', err.message || 'Provider copy changed since the conflict preview', 409, {
          preview: err.preview || null,
        });
        return;
      }
      if (err?.code === 'PROVIDER_UNAVAILABLE') {
        sendError(res, 'PROVIDER_UNAVAILABLE', err.message || 'Provider is unreachable. Try again shortly.', 503);
        return;
      }
      logger.error({ err }, 'iOS task conflict resolve failed');
      sendInternalError(res, 'Failed to resolve task conflict');
    }
  });

  /** POST /api/v1/tasks/:listId/:taskId/sync/retry — retry queued/failed provider sync. */
  router.post('/:listId/:taskId/sync/retry', async (req, res: Response) => {
    try {
      const { listId, taskId } = req.params;
      const { userId, tenantId } = assertTenantScope(req as any, 'tasks_retry_sync_local_mutation');
      const nexusTaskId = resolveOfflineNexusTaskId(tenantId, userId, taskId);
      if (!nexusTaskId) {
        sendError(res, 'NOT_FOUND', 'Task not found in local task store', 404);
        return;
      }

      const result = retryOfflineTaskSync(tenantId, userId, {
        taskId: nexusTaskId,
        idempotencyKey: req.body?.idempotencyKey,
        clientMutationId: req.body?.clientMutationId,
      });
      invalidateTaskRouteCaches(listId, userId);
      sendSuccess(res, result);
    } catch (err: any) {
      if (err?.code === 'NOT_FOUND') {
        sendError(res, 'NOT_FOUND', err.message || 'Task not found', 404);
        return;
      }
      logger.error({ err }, 'iOS task retry sync failed');
      sendInternalError(res, 'Failed to retry task sync');
    }
  });

  /** DELETE /api/v1/tasks/lists/:listId — delete a task list/project when supported. */
  router.delete('/lists/:listId', async (req, res: Response) => {
    try {
      const { listId } = req.params;
      if (isSingleWritePathEnabled()) {
        // M5 ledger path (NEX-10): the local row disappears from GET /lists
        // immediately; the provider push (with the PROVIDER container id
        // captured at journal time, never the local numeric row id) runs on
        // the mutation worker.
        const { userId, tenantId } = assertTenantScope(req as any, 'tasks_lists_delete_local_mutation');
        deleteOfflineFirstTaskList(tenantId, userId, {
          listId,
          idempotencyKey: req.body?.idempotencyKey || (req.query?.idempotencyKey as string | undefined),
          clientMutationId: req.body?.clientMutationId || (req.query?.clientMutationId as string | undefined),
        });
        invalidateTaskCaches({ userId, listIds: [listId], includeDerivedSurfaces: true });
        sendSuccess(res, { deleted: true });
        return;
      }

      // Legacy direct-provider path (TASK_SINGLE_WRITE_PATH=0).
      const todo = getTodo(req);
      if (typeof todo.deleteList !== 'function') {
        sendError(res, 'UNSUPPORTED', 'Task list deletion is not supported by the active task provider', 400);
        return;
      }

      const result = await todo.deleteList(listId);
      if (!result?.success) {
        sendError(res, 'UNSUPPORTED', result?.error || 'Task list deletion is not supported by the active task provider', 400);
        return;
      }

      invalidateTaskCaches({ userId: (req as any).userId, listIds: [listId], includeDerivedSurfaces: true });
      sendSuccess(res, { deleted: true });
    } catch (err: any) {
      if (err?.code === 'NOT_FOUND') {
        sendError(res, 'NOT_FOUND', err.message || 'List not found', 404);
        return;
      }
      if (err?.code === 'BAD_REQUEST') {
        sendError(res, 'VALIDATION', err.message || 'Invalid list delete request', 400);
        return;
      }
      logger.error({ err }, 'iOS tasks list delete failed');
      sendInternalError(res, 'Failed to delete task list');
    }
  });

  /** DELETE /api/v1/tasks/:listId/:taskId */
  router.delete('/:listId/:taskId', async (req, res: Response) => {
    try {
      const { listId, taskId } = req.params;
      {
        const { userId, tenantId } = assertTenantScope(req as any, 'tasks_delete_local_mutation');
        const nexusTaskId = resolveOfflineNexusTaskId(tenantId, userId, taskId);
        if (nexusTaskId) {
          const result = recordLocalTaskMutation(tenantId, userId, {
            taskId: nexusTaskId,
            operation: 'task.delete',
            idempotencyKey: req.body?.idempotencyKey || req.query?.idempotencyKey,
            clientMutationId: req.body?.clientMutationId || req.query?.clientMutationId,
            patch: { deleted: true },
            baseLocalVersion: req.body?.baseLocalVersion ?? (req.query?.baseLocalVersion as number | undefined),
          });
          invalidateTaskRouteCaches(listId, userId);
          sendSuccess(res, { deleted: true, ...result });
          return;
        }
      }

      sendError(res, 'NOT_FOUND', 'Task not found in local task store', 404);
    } catch (err: any) {
      if (sendVersionConflict(res as Response, err)) return;
      logger.error({ err }, 'iOS tasks delete failed');
      sendInternalError(res, 'Failed to delete task');
    }
  });

  /**
   * POST /api/v1/tasks/:listId/:taskId/restore — undo a task delete (M9).
   *
   * Contract (pinned for the iOS undo toast):
   *   200 { restored: true, path: 'superseded_delete' | 'undeleted', task }
   *   404 NOT_FOUND      — unknown task id
   *   409 NOT_DELETED    — task is not deleted (an idempotent replay of a
   *                        restore that already succeeded returns 200 with
   *                        idempotentReplay: true instead)
   *   409 NOT_RESTORABLE — merged twin-repair tombstone
   *
   * 'superseded_delete': the journaled task.delete was still held (M6
   * available_at holdback) and is retired without any provider write.
   * 'undeleted': the delete already reached the provider — the tombstone is
   * cleared and a canonical-links re-push (pending_create link + one queued
   * task.update) is journaled for the sync worker.
   */
  router.post('/:listId/:taskId/restore', async (req, res: Response) => {
    try {
      const { listId, taskId } = req.params;
      const { userId, tenantId } = assertTenantScope(req as any, 'tasks_restore_local_mutation');
      const nexusTaskId = resolveOfflineNexusTaskId(tenantId, userId, taskId);
      if (!nexusTaskId) {
        sendError(res, 'NOT_FOUND', 'Task not found in local task store', 404);
        return;
      }
      const result = restoreOfflineFirstTask(tenantId, userId, {
        taskId: nexusTaskId,
        idempotencyKey: req.body?.idempotencyKey,
        clientMutationId: req.body?.clientMutationId,
      });
      invalidateTaskRouteCaches(listId, userId);
      sendSuccess(res, result);
    } catch (err: any) {
      if (err?.code === 'NOT_FOUND') {
        sendError(res, 'NOT_FOUND', err.message || 'Task not found in local task store', 404);
        return;
      }
      if (err?.code === 'NOT_DELETED') {
        sendError(res, 'NOT_DELETED', err.message || 'Task is not deleted', 409);
        return;
      }
      if (err?.code === 'NOT_RESTORABLE') {
        sendError(res, 'NOT_RESTORABLE', err.message || 'Task cannot be restored', 409);
        return;
      }
      logger.error({ err }, 'iOS task restore failed');
      sendInternalError(res, 'Failed to restore task');
    }
  });

  return router;
}

/** Invalidate task caches after mutations (create, update, complete, delete).
 * Clears both user-specific and legacy (owner) keys for backward compat. */
function invalidateTaskRouteCaches(listId?: string, userId?: number): void {
  invalidateTaskCaches({
    userId,
    listIds: listId ? [listId] : [],
    includeDerivedSurfaces: true,
  });
  // Re-warm cache in background after mutation
  setTimeout(() => warmTaskCache().catch(() => {}), 1000);
}

/**
 * Pre-populate task cache in background from the Nexus local read model.
 * Called on startup and every 2 minutes via setInterval.
 */
export async function warmTaskCache(): Promise<void> {
  try {
    const owner = getOwnerBootstrapUser();
    if (!owner?.id) {
      logger.debug('Skipping task cache warm — owner bootstrap user unavailable');
      return;
    }
    const snapshot = getOfflineTaskSnapshot(owner.id, owner.id, { pageSize: 200 });
    const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
    const lists = Array.isArray(snapshot.lists) ? snapshot.lists : [];
    const pendingTasks = tasks.filter((task: any) => !isCompletedLikeTask(task));
    const formatted = lists.map((list: any) => ({
      id: String(list.id),
      name: list.name || 'Tasks',
      taskCount: Number(list.taskCount || 0),
    }));
    // Hardening 2026-04-21: the warmer previously wrote to GLOBAL keys
    // (`task-lists`, `fastpath:pending-tasks`, `tasks:${listId}:notStarted`)
    // containing the OWNER'S data. Any read that fell back to those
    // keys leaked owner data to non-owner callers. All three write
    // sites are now scoped to the owner's userId. The iOS route
    // reads from `u:${userId}:*` and the Telegram fastpath reads via
    // `getPendingTasksCacheKey(userId)` which already composes the
    // scoped key when userId is provided.
    setCacheSWR(`u:${owner.id}:task-lists`, { lists: formatted }, LISTS_CACHE_TTL, LISTS_SWR_STALE);

    // Cache the cross-list "all pending tasks" snapshot used by both
    // /api/v1/tasks/filtered AND the chat fast-path (/overdue, /duetoday, etc.)
    // so the iOS chat command flow can render from Nexus local truth.
    try {
      setCache(`u:${owner.id}:fastpath:pending-tasks`, pendingTasks, TASKS_CACHE_TTL);
    } catch {
      // Non-critical — fast-path will fall back to a fresh fetch on miss
    }

    for (const list of formatted) {
      const taskFormatted = pendingTasks.filter((task: any) => String(task.listId || '') === String(list.id));
      setCacheSWR(
        `u:${owner.id}:tasks:${list.id}:notStarted`,
        { listName: list.name, tasks: taskFormatted },
        TASKS_CACHE_TTL,
        TASKS_SWR_STALE,
      );
    }

    logger.debug({ listCount: formatted.length }, 'Task cache warmed from local task read model');
  } catch (err) {
    logger.debug({ err }, 'Task cache warming failed (non-critical)');
  }
}
