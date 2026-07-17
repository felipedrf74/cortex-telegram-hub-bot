// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Microsoft To Do adapter for the unified/offline-first task store.
 *
 * The legacy task routes can read Microsoft Graph directly, but the iOS Tasks
 * surface reads from `unified_tasks`. This adapter lets the scheduler import
 * connected Outlook / Microsoft To Do accounts into that local read model.
 */

import { Client } from '@microsoft/microsoft-graph-client';
import { logger } from '../../utils/logger';
import { isConnected } from '../oauth-store';
import { getGraphClientForUser } from '../microsoft-auth';
import { getDb } from '../database';
import { config } from '../../config';
import { graphRetryDelayMs, recordGraphRateLimitHit } from '../graph-request-policy';
import { toGraphDateTimeTimeZone } from '../microsoft-graph-datetime';
import { isTaskMsDeltaSyncEnabled } from './task-sync-flags';
import type { TaskProviderAdapter, TaskPullRemoval } from './adapter-interface';
import type { NormalizedChecklistItem, NormalizedProject, NormalizedStatus, NormalizedTask, TaskProviderCapabilities } from './types';

type GraphTodoList = {
  id?: string;
  displayName?: string;
  isOwner?: boolean;
  isShared?: boolean;
  wellknownListName?: string;
};

type GraphTodoTask = {
  id?: string;
  title?: string;
  body?: { content?: string };
  importance?: string;
  status?: string;
  dueDateTime?: { dateTime?: string; timeZone?: string };
  reminderDateTime?: { dateTime?: string; timeZone?: string };
  createdDateTime?: string;
  completedDateTime?: { dateTime?: string; timeZone?: string } | string;
  recurrence?: unknown;
  checklistItems?: Array<{ id?: string; displayName?: string; isChecked?: boolean }>;
  linkedResources?: Array<{ applicationName?: string; externalId?: string; displayName?: string }>;
  lastModifiedDateTime?: string;
  updatedDateTime?: string;
  '@odata.etag'?: string;
  etag?: string;
  eTag?: string;
};

type ResolvedGraphTask = {
  list: NormalizedProject;
  task: GraphTodoTask;
};

const MS_GRAPH_PAGE_SIZE = 100;
const DEFAULT_MS_GRAPH_REQUEST_TIMEOUT_MS = 15_000;

function microsoftGraphRequestTimeoutMs(): number {
  const parsed = Number(process.env.MS_TODO_GRAPH_REQUEST_TIMEOUT_MS || '');
  if (Number.isFinite(parsed) && parsed >= 1000) return Math.floor(parsed);
  return DEFAULT_MS_GRAPH_REQUEST_TIMEOUT_MS;
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = microsoftGraphRequestTimeoutMs()): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out`);
      (err as any).code = 'ETIMEDOUT';
      reject(err);
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeMsGraphDateTime(dt?: { dateTime?: string; timeZone?: string } | string): string | undefined {
  if (!dt) return undefined;
  if (typeof dt === 'string') return dt || undefined;
  if (!dt.dateTime) return undefined;

  let normalized = dt.dateTime.replace(/\.\d+/, '');
  if ((!dt.timeZone || dt.timeZone === 'UTC') && !/[Zz]$|[+-]\d{2}:?\d{2}$/.test(normalized)) {
    normalized += 'Z';
  }
  return normalized;
}

function graphStatusToNexus(value: unknown): NormalizedStatus {
  switch (String(value || '').trim().toLowerCase()) {
    case 'completed':
      return 'completed';
    case 'inprogress':
    case 'in_progress':
      return 'in_progress';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    default:
      return 'pending';
  }
}

function nexusStatusToGraph(value: unknown): string | undefined {
  switch (String(value || '').trim().toLowerCase()) {
    case 'completed':
      return 'completed';
    case 'in_progress':
    case 'inprogress':
      return 'inProgress';
    case 'pending':
    case 'notstarted':
      return 'notStarted';
    default:
      return undefined;
  }
}

function graphImportanceToPriority(value: unknown): number {
  switch (String(value || '').trim().toLowerCase()) {
    case 'high':
      return 3;
    case 'low':
      return 1;
    case 'normal':
      return 2;
    default:
      return 0;
  }
}

function priorityToGraphImportance(value: unknown): 'low' | 'normal' | 'high' | undefined {
  const priority = Number(value);
  if (!Number.isFinite(priority)) return undefined;
  if (priority >= 3) return 'high';
  if (priority === 1) return 'low';
  if (priority === 2) return 'normal';
  return undefined;
}

function normalizeChecklistItems(value: GraphTodoTask['checklistItems']): NormalizedChecklistItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => {
      const id = String(item.id || '').trim();
      const displayName = String(item.displayName || '').trim();
      if (!id || !displayName) return null;
      return {
        id,
        displayName,
        isChecked: item.isChecked ?? false,
      };
    })
    .filter((item): item is NormalizedChecklistItem => item != null);
  return items.length > 0 ? items : undefined;
}

function projectFromGraphList(list: GraphTodoList): NormalizedProject {
  return {
    provider: 'ms_todo',
    externalId: String(list.id || ''),
    name: String(list.displayName || '(Unnamed)').trim() || '(Unnamed)',
    isDefault: list.wellknownListName === 'defaultList',
    taskCount: 0,
  };
}

function taskProviderData(task: GraphTodoTask, list: NormalizedProject): Record<string, unknown> {
  return {
    ...task,
    listId: list.externalId,
    listName: list.name,
    etag: task['@odata.etag'] || task.etag || task.eTag,
  };
}

function taskFromGraphTask(task: GraphTodoTask, list: NormalizedProject): NormalizedTask {
  const dueDate = normalizeMsGraphDateTime(task.dueDateTime);
  return {
    provider: 'ms_todo',
    externalId: String(task.id || ''),
    projectName: list.name,
    title: String(task.title || '(Untitled)').trim() || '(Untitled)',
    description: task.body?.content || undefined,
    notes: task.body?.content || undefined,
    status: graphStatusToNexus(task.status),
    priority: graphImportanceToPriority(task.importance),
    dueDate,
    dueIsDatetime: !!dueDate && dueDate.includes('T'),
    completedAt: normalizeMsGraphDateTime(task.completedDateTime),
    recurrence: task.recurrence,
    checklistItems: normalizeChecklistItems(task.checklistItems),
    providerData: taskProviderData(task, list),
  };
}

function graphTaskBodyFromNormalized(task: Partial<NormalizedTask>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (task.title !== undefined) body.title = task.title || '(Untitled)';
  if (task.description !== undefined || task.notes !== undefined) {
    body.body = {
      content: task.description ?? task.notes ?? '',
      contentType: 'text',
    };
  }
  const importance = priorityToGraphImportance(task.priority);
  if (importance) body.importance = importance;
  const status = nexusStatusToGraph(task.status);
  if (status) body.status = status;
  if (task.dueDate !== undefined) {
    // NEX-29: Graph expects zone-naive wall-clock dateTime strings inside
    // dateTimeTimeZone payloads (see microsoft-graph-datetime.ts).
    body.dueDateTime = task.dueDate
      ? toGraphDateTimeTimeZone(task.dueDate, config.app.timezone)
      : null;
  }
  if (task.recurrence !== undefined) body.recurrence = task.recurrence || null;
  return body;
}

function extractProviderListId(task: Partial<NormalizedTask>): string | null {
  const candidates = [
    task.providerData?.listId,
    task.providerData?.list_id,
    task.providerData?.projectId,
    task.providerData?.project_id,
  ];
  for (const candidate of candidates) {
    if (candidate != null && String(candidate).trim()) return String(candidate).trim();
  }
  return null;
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 1): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await withTimeout(fn(), 'Microsoft To Do Graph request');
    } catch (err: any) {
      const status = Number(err?.statusCode || err?.status || err?.code || err?.response?.status);
      if (status === 429) recordGraphRateLimitHit('microsoft-todo-adapter');
      const retryable = status === 429 || status === 503;
      if (!retryable || attempt === maxRetries) throw err;
      // M6: honor the provider's Retry-After budget when present; the legacy
      // exponential backoff is the header-less fallback.
      const delay = graphRetryDelayMs(err, attempt);
      logger.warn({ attempt, delay, status }, 'Retrying Microsoft To Do adapter Graph call');
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error('Unreachable');
}

async function graphGetPaged<T>(client: Client, path: string, query?: Record<string, string>): Promise<T[]> {
  const rows: T[] = [];
  let request = client.api(path);
  if (query) request = request.query(query);
  let response = await withRetry(() => request.get());
  rows.push(...(response.value || []));

  while (response['@odata.nextLink']) {
    response = await withRetry(() => client.api(response['@odata.nextLink']).get());
    rows.push(...(response.value || []));
  }

  return rows;
}

// ─── Delta pull machinery (M6, flag TASK_MS_DELTA_SYNC) ────────────────
//
// Incremental mode stores ONE composite cursor JSON in
// task_sync_state.sync_cursor: `{ [listId]: deltaLink, '@lists': deltaLink }`
// where every value is the WHOLE `@odata.deltaLink` URL Graph returned. The
// reserved '@lists' key holds the `/me/todo/lists/delta` cursor (Graph list
// ids never start with '@'). Delta responses may contain PARTIAL task rows,
// so rows are merged by id onto the locally known raw provider state before
// normalization; `@removed` entries surface on the `removals` channel; and an
// HTTP 410 / expired sync token triggers a LIST-scoped resync (honoring the
// 410's Location URL when present), reported via `resyncedListIds`.
//
// NOTE: no `$expand` on delta requests — the `$expand`-on-delta behavior is
// gated on an owner-run staging probe (see the M6 plan); checklist detail
// continues to ride full pulls and per-task reads.

const MS_LISTS_DELTA_CURSOR_KEY = '@lists';

type MsDeltaCursor = Record<string, string>;

function parseMsDeltaCursor(raw?: string): MsDeltaCursor {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const cursor: MsDeltaCursor = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim()) cursor[key] = value;
    }
    return cursor;
  } catch {
    return {};
  }
}

function graphErrorStatus(err: unknown): number | null {
  const candidates = [
    (err as any)?.statusCode,
    (err as any)?.status,
    (err as any)?.response?.status,
    (err as any)?.response?.statusCode,
  ];
  for (const candidate of candidates) {
    const status = Number(candidate);
    if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
  }
  return null;
}

/**
 * True when the stored delta token is no longer usable and Graph demands a
 * full resync: HTTP 410 Gone (error code `resyncRequired`) or the
 * `syncStateNotFound` error code — delta tokens have no guaranteed lifetime.
 */
function isGraphSyncStateExpired(err: unknown): boolean {
  if (graphErrorStatus(err) === 410) return true;
  const code = String((err as any)?.code || (err as any)?.body?.error?.code || '');
  const message = String((err as any)?.message || '');
  return /syncstatenotfound|resyncrequired/i.test(`${code} ${message}`);
}

/** Location header of a 410 response — the full-resync URL Graph hands back. */
function graphResyncLocation(err: unknown): string | null {
  const headerSources = [
    (err as any)?.headers,
    (err as any)?.response?.headers,
    (err as any)?.rawResponse?.headers,
  ];
  for (const headers of headerSources) {
    if (!headers || typeof headers !== 'object') continue;
    const viaGet = typeof (headers as any).get === 'function'
      ? (headers as any).get('location') ?? (headers as any).get('Location')
      : undefined;
    if (viaGet != null && String(viaGet).trim()) return String(viaGet);
    for (const key of Object.keys(headers as Record<string, unknown>)) {
      if (key.toLowerCase() === 'location') {
        const value = (headers as Record<string, unknown>)[key];
        if (value != null && String(value).trim()) return String(value);
      }
    }
  }
  return null;
}

/** Page through a delta feed, accumulating rows until the deltaLink page. */
async function graphGetDeltaRows(
  client: Client,
  startUrl: string,
  query?: Record<string, string>,
): Promise<{ rows: GraphTodoTask[]; deltaLink?: string }> {
  const rows: GraphTodoTask[] = [];
  let request = client.api(startUrl);
  if (query) request = request.query(query);
  let response = await withRetry(() => request.get());
  rows.push(...(response.value || []));
  while (response['@odata.nextLink']) {
    const nextLink = response['@odata.nextLink'];
    response = await withRetry(() => client.api(nextLink).get());
    rows.push(...(response.value || []));
  }
  const deltaLink = response['@odata.deltaLink'];
  return { rows, deltaLink: typeof deltaLink === 'string' && deltaLink ? deltaLink : undefined };
}

function looksLikeGraphTask(value: unknown): value is GraphTodoTask {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.title === 'string'
    || typeof record.status === 'string'
    || typeof record['@odata.etag'] === 'string';
}

/**
 * Delta rows may be partial — merge by id onto the known raw provider state,
 * never treat them as full copies. When no Graph-shaped base is known (new
 * task, or a Nexus-origin row whose provider_data is not a Graph payload),
 * the delta row stands alone.
 */
function mergeDeltaRow(known: GraphTodoTask | undefined, delta: GraphTodoTask): GraphTodoTask {
  if (!known || !looksLikeGraphTask(known)) return delta;
  return { ...known, ...delta };
}

async function graphGetTodoTasksForList(
  client: Client,
  userId: number,
  listId: string,
): Promise<GraphTodoTask[]> {
  const path = `/me/todo/lists/${encodeURIComponent(listId)}/tasks`;
  try {
    return await graphGetPaged<GraphTodoTask>(
      client,
      path,
      {
        $top: String(MS_GRAPH_PAGE_SIZE),
        $orderby: 'createdDateTime DESC',
        $expand: 'checklistItems,linkedResources',
      },
    );
  } catch (err) {
    logger.warn(
      { err, userId, listId },
      'Microsoft To Do adapter expanded list fetch failed — retrying basic task fetch',
    );
    return graphGetPaged<GraphTodoTask>(
      client,
      path,
      {
        $top: String(MS_GRAPH_PAGE_SIZE),
        $orderby: 'createdDateTime DESC',
      },
    );
  }
}

export class MicrosoftTodoAdapter implements TaskProviderAdapter {
  readonly provider = 'ms_todo' as const;

  /**
   * `hasIncrementalSync` follows TASK_MS_DELTA_SYNC (re-read per access, like
   * every M6 flag): flag off keeps the pre-M6 full-pull contract — the sync
   * engine's poll-interval gate, cursor handling, and full-pull
   * reconciliation all behave byte-identically to today.
   */
  get capabilities(): TaskProviderCapabilities {
    return {
      canCreate: true,
      canComplete: true,
      canDelete: true,
      canUpdate: true,
      canAssignDue: true,
      hasWebhooks: false,
      hasIncrementalSync: isTaskMsDeltaSyncEnabled(),
    };
  }

  isConnected(userId: number): boolean {
    return isConnected(userId, 'outlook');
  }

  async getProjects(userId: number): Promise<NormalizedProject[]> {
    const client = getGraphClientForUser(userId);
    const lists = await graphGetPaged<GraphTodoList>(client, '/me/todo/lists');
    return lists
      .filter((list) => String(list.id || '').trim())
      .map(projectFromGraphList);
  }

  async getTasks(
    userId: number,
    options?: { projectId?: string; sinceCursor?: string; knownProjects?: NormalizedProject[] },
  ): Promise<{
    tasks: NormalizedTask[];
    nextCursor?: string;
    incomplete?: boolean;
    errors?: string[];
    removals?: TaskPullRemoval[];
    resyncedListIds?: string[];
  }> {
    if (isTaskMsDeltaSyncEnabled()) {
      return this.getTasksViaDelta(userId, options);
    }

    // Reuse the caller's already-fetched list set when provided (the sync
    // engine pulls lists via getProjects immediately before calling us) —
    // otherwise every sync fetched all lists from Graph a second time.
    const allProjects = options?.knownProjects ?? await this.getProjects(userId);
    const projects = options?.projectId
      ? allProjects.filter((project) => project.externalId === options.projectId)
      : allProjects;
    const client = getGraphClientForUser(userId);
    const tasks: NormalizedTask[] = [];
    const errors: string[] = [];

    for (const project of projects) {
      try {
        const rawTasks = await graphGetTodoTasksForList(client, userId, project.externalId);
        tasks.push(
          ...rawTasks
            .filter((task) => String(task.id || '').trim())
            .map((task) => taskFromGraphTask(task, project)),
        );
      } catch (err: any) {
        const message = err?.message || String(err);
        errors.push(`list ${project.externalId}: ${message}`);
        logger.warn({ err, userId, listId: project.externalId }, 'Microsoft To Do adapter failed to fetch list tasks');
      }
    }

    return {
      tasks,
      incomplete: errors.length > 0,
      errors: errors.length > 0
        ? [`Microsoft To Do failed to fetch ${errors.length} list${errors.length === 1 ? '' : 's'}`]
        : undefined,
    };
  }

  /**
   * Incremental pull (TASK_MS_DELTA_SYNC): per-list
   * `GET /me/todo/lists/{id}/tasks/delta` plus `GET /me/todo/lists/delta`
   * for list renames/deletes, driven by the composite deltaLink cursor.
   */
  private async getTasksViaDelta(
    userId: number,
    options?: { projectId?: string; sinceCursor?: string; knownProjects?: NormalizedProject[] },
  ): Promise<{
    tasks: NormalizedTask[];
    nextCursor?: string;
    incomplete?: boolean;
    errors?: string[];
    removals?: TaskPullRemoval[];
    resyncedListIds?: string[];
  }> {
    const cursor = parseMsDeltaCursor(options?.sinceCursor);
    const nextCursor: MsDeltaCursor = {};
    const removals: TaskPullRemoval[] = [];
    const resyncedListIds: string[] = [];
    const errors: string[] = [];
    const tasks: NormalizedTask[] = [];
    const client = getGraphClientForUser(userId);

    // Lists delta first: `@removed` lists become project removals so the
    // engine can run its soft-handling; renames/creates propagate through
    // the engine's regular full getProjects → upsertProject on every sync.
    const priorListsLink = cursor[MS_LISTS_DELTA_CURSOR_KEY];
    try {
      const listsDelta = await this.pullListsDelta(client, priorListsLink);
      for (const removedListId of listsDelta.removedListIds) {
        removals.push({ kind: 'project', externalId: removedListId });
      }
      if (listsDelta.deltaLink) nextCursor[MS_LISTS_DELTA_CURSOR_KEY] = listsDelta.deltaLink;
      else if (priorListsLink) nextCursor[MS_LISTS_DELTA_CURSOR_KEY] = priorListsLink;
    } catch (err: any) {
      // Preserve the unadvanced lists cursor; list catalogue changes still
      // arrive via getProjects, so this failure is non-fatal.
      if (priorListsLink) nextCursor[MS_LISTS_DELTA_CURSOR_KEY] = priorListsLink;
      errors.push(`lists delta: ${err?.message || String(err)}`);
      logger.warn({ err, userId }, 'Microsoft To Do lists delta pull failed');
    }

    const allProjects = options?.knownProjects ?? await this.getProjects(userId);
    const projects = options?.projectId
      ? allProjects.filter((project) => project.externalId === options.projectId)
      : allProjects;
    const knownRawTasks = this.loadKnownRawTaskMap(userId);
    const removedProjectIds = new Set(
      removals.filter((removal) => removal.kind === 'project').map((removal) => removal.externalId),
    );

    for (const project of projects) {
      if (removedProjectIds.has(project.externalId)) continue;
      const prior = cursor[project.externalId];
      try {
        const { rows, deltaLink, resynced } = await this.pullListTasksDelta(client, project.externalId, prior);
        for (const row of rows) {
          const id = String(row.id || '').trim();
          if (!id) continue;
          if ((row as Record<string, unknown>)['@removed']) {
            removals.push({ kind: 'task', externalId: id, listId: project.externalId });
            continue;
          }
          tasks.push(taskFromGraphTask(mergeDeltaRow(knownRawTasks.get(id), row), project));
        }
        if (deltaLink) nextCursor[project.externalId] = deltaLink;
        else if (prior) nextCursor[project.externalId] = prior;
        if (resynced) resyncedListIds.push(project.externalId);
      } catch (err: any) {
        const message = err?.message || String(err);
        // Failed lists keep their unadvanced deltaLink — never drop entries
        // that did not move forward this pull.
        if (prior) nextCursor[project.externalId] = prior;
        errors.push(`list ${project.externalId}: ${message}`);
        logger.warn({ err, userId, listId: project.externalId }, 'Microsoft To Do delta pull failed for list');
      }
    }

    return {
      tasks,
      nextCursor: JSON.stringify(nextCursor),
      incomplete: errors.length > 0,
      errors: errors.length > 0
        ? [`Microsoft To Do delta pull failed for ${errors.length} feed${errors.length === 1 ? '' : 's'}`]
        : undefined,
      removals: removals.length > 0 ? removals : undefined,
      resyncedListIds: resyncedListIds.length > 0 ? resyncedListIds : undefined,
    };
  }

  /** Task delta for one list, with LIST-scoped 410/expired-token resync. */
  private async pullListTasksDelta(
    client: Client,
    listId: string,
    priorDeltaLink: string | undefined,
  ): Promise<{ rows: GraphTodoTask[]; deltaLink?: string; resynced: boolean }> {
    const freshPath = `/me/todo/lists/${encodeURIComponent(listId)}/tasks/delta`;
    const freshQuery = { $top: String(MS_GRAPH_PAGE_SIZE) };
    if (!priorDeltaLink) {
      const first = await graphGetDeltaRows(client, freshPath, freshQuery);
      return { ...first, resynced: false };
    }
    try {
      const incremental = await graphGetDeltaRows(client, priorDeltaLink);
      return { ...incremental, resynced: false };
    } catch (err) {
      if (!isGraphSyncStateExpired(err)) throw err;
      // Full resync for THIS list only — honor the 410's Location URL when
      // Graph provides one, otherwise restart the delta feed from scratch.
      const location = graphResyncLocation(err);
      const resynced = location
        ? await graphGetDeltaRows(client, location)
        : await graphGetDeltaRows(client, freshPath, freshQuery);
      return { ...resynced, resynced: true };
    }
  }

  /** Lists delta (`/me/todo/lists/delta`) with the same resync contract. */
  private async pullListsDelta(
    client: Client,
    priorDeltaLink: string | undefined,
  ): Promise<{ removedListIds: string[]; deltaLink?: string }> {
    const freshPath = '/me/todo/lists/delta';
    let feed: { rows: GraphTodoTask[]; deltaLink?: string };
    if (!priorDeltaLink) {
      feed = await graphGetDeltaRows(client, freshPath);
    } else {
      try {
        feed = await graphGetDeltaRows(client, priorDeltaLink);
      } catch (err) {
        if (!isGraphSyncStateExpired(err)) throw err;
        const location = graphResyncLocation(err);
        feed = await graphGetDeltaRows(client, location || freshPath);
      }
    }
    const removedListIds = feed.rows
      .filter((row) => (row as Record<string, unknown>)['@removed'] && String(row.id || '').trim())
      .map((row) => String(row.id));
    return { removedListIds, deltaLink: feed.deltaLink };
  }

  /**
   * Locally known raw Graph payloads keyed by provider task id — the merge
   * base for partial delta rows. Covers both provider-origin rows and
   * canonical-linked (Nexus-pushed) rows. Best-effort: an unavailable store
   * simply means delta rows stand alone.
   */
  private loadKnownRawTaskMap(userId: number): Map<string, GraphTodoTask> {
    const known = new Map<string, GraphTodoTask>();
    try {
      const db = getDb();
      const providerRows = db.prepare(
        `SELECT external_id, provider_data
         FROM unified_tasks
         WHERE user_id = ? AND provider = 'ms_todo' AND is_deleted = 0`,
      ).all(userId) as Array<{ external_id: string; provider_data: string | null }>;
      const linkedRows = db.prepare(
        `SELECT l.provider_task_id AS external_id, t.provider_data
         FROM task_provider_links l
         JOIN unified_tasks t
           ON t.nexus_task_id = l.task_id
          AND t.user_id = l.user_id
         WHERE l.user_id = ? AND l.provider = 'ms_todo'
           AND l.provider_task_id IS NOT NULL
           AND l.link_state NOT IN ('orphaned')
           AND t.is_deleted = 0`,
      ).all(userId) as Array<{ external_id: string; provider_data: string | null }>;
      for (const row of [...providerRows, ...linkedRows]) {
        if (!row.external_id || !row.provider_data || known.has(row.external_id)) continue;
        try {
          const parsed = JSON.parse(row.provider_data);
          if (looksLikeGraphTask(parsed)) known.set(row.external_id, parsed as GraphTodoTask);
        } catch { /* non-JSON provider_data — no merge base */ }
      }
    } catch (err) {
      logger.debug({ err, userId }, 'Microsoft To Do delta merge-base lookup unavailable');
    }
    return known;
  }

  async createTask(
    userId: number,
    task: Omit<NormalizedTask, 'id' | 'provider' | 'externalId'>,
  ): Promise<NormalizedTask> {
    const project = await this.resolveProjectForWrite(userId, task);
    const client = getGraphClientForUser(userId);
    const body = graphTaskBodyFromNormalized(task);
    if (!body.title) body.title = task.title || '(Untitled)';
    const response = await withRetry(() =>
      client.api(`/me/todo/lists/${encodeURIComponent(project.externalId)}/tasks`).post(body),
    );
    return taskFromGraphTask(response, project);
  }

  async completeTask(userId: number, externalId: string): Promise<void> {
    await this.updateTask(userId, externalId, { status: 'completed' });
  }

  async deleteTask(userId: number, externalId: string): Promise<void> {
    const found = await this.findTask(userId, externalId);
    const client = getGraphClientForUser(userId);
    await withRetry(() =>
      client.api(`/me/todo/lists/${encodeURIComponent(found.list.externalId)}/tasks/${encodeURIComponent(externalId)}`).delete(),
    );
  }

  async updateTask(
    userId: number,
    externalId: string,
    updates: Partial<NormalizedTask>,
  ): Promise<void> {
    const found = await this.findTask(userId, externalId);
    const client = getGraphClientForUser(userId);
    const body = graphTaskBodyFromNormalized(updates);
    if (Object.keys(body).length === 0) return;
    await withRetry(() =>
      client.api(`/me/todo/lists/${encodeURIComponent(found.list.externalId)}/tasks/${encodeURIComponent(externalId)}`).patch(body),
    );
  }

  private async resolveProjectForWrite(userId: number, task: Partial<NormalizedTask>): Promise<NormalizedProject> {
    const projects = await this.getProjects(userId);
    const providerListId = extractProviderListId(task);
    const byId = providerListId ? projects.find((project) => project.externalId === providerListId) : null;
    if (byId) return byId;

    const projectName = String(task.projectName || '').trim().toLowerCase();
    const byName = projectName ? projects.find((project) => project.name.toLowerCase() === projectName) : null;
    if (byName) return byName;

    const fallback = projects.find((project) => project.isDefault) || projects[0];
    if (!fallback) throw new Error('Microsoft To Do has no lists for this user');
    return fallback;
  }

  private async findTask(userId: number, externalId: string): Promise<ResolvedGraphTask> {
    const projects = await this.getProjects(userId);
    const client = getGraphClientForUser(userId);
    for (const project of projects) {
      try {
        const task = await withRetry(() =>
          client.api(`/me/todo/lists/${encodeURIComponent(project.externalId)}/tasks/${encodeURIComponent(externalId)}`)
            .query({ $expand: 'checklistItems,linkedResources' })
            .get(),
        );
        if (task?.id) return { list: project, task };
      } catch (err: any) {
        const status = Number(err?.statusCode || err?.status || err?.code || err?.response?.status);
        if (status !== 404) {
          logger.warn({ err, userId, listId: project.externalId }, 'Microsoft To Do adapter task lookup failed for list');
        }
      }
    }
    throw new Error('Microsoft To Do task not found');
  }
}

export const __testing = {
  graphImportanceToPriority,
  graphStatusToNexus,
  normalizeMsGraphDateTime,
  projectFromGraphList,
  taskFromGraphTask,
  withTimeout,
  parseMsDeltaCursor,
  mergeDeltaRow,
  isGraphSyncStateExpired,
  graphResyncLocation,
  MS_LISTS_DELTA_CURSOR_KEY,
};
