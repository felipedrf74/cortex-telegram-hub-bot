// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Todoist Task Provider Adapter (TASK-16b).
 *
 * Two Todoist APIs in play:
 *   - REST v2 (https://api.todoist.com/rest/v2)
 *       Simple resource CRUD: GET /tasks, POST /tasks, POST /tasks/:id/close,
 *       DELETE /tasks/:id. Used for create/complete/delete write-back and
 *       for the very first project list. Does NOT return completed tasks.
 *
 *   - Sync API v9 (https://api.todoist.com/sync/v9)
 *       Incremental delta API: POST /sync with a sync_token, get back the
 *       changes since that token + a fresh token. Used for ALL `getTasks`
 *       calls — first sync uses sync_token='*' (Todoist's magic "everything"
 *       value), subsequent syncs reuse the cursor we stored last time.
 *
 * Tokens are non-expiring bearer tokens. There is no refresh flow — the
 * exchangeTodoistCode helper in oauth-flow.ts stores access_token in both
 * the access and refresh slots so the standard OAuthTokens shape works.
 */

import { logger } from '../../utils/logger';
import { getTokens, isConnected } from '../oauth-store';
import { TaskProviderAdapter } from './adapter-interface';
import { appendTodoistNexusMarker, parseTodoistNexusMarker } from './todoist-correlation';
import { NormalizedProject, NormalizedTask, TaskProviderCapabilities } from './types';

const TODOIST_REST_API = 'https://api.todoist.com/rest/v2';
const TODOIST_SYNC_API = 'https://api.todoist.com/sync/v9';

// Todoist priority enum: 1=normal, 2=medium, 3=high, 4=urgent (no "none")
// Nexus priority:        0=none, 1=low, 2=medium, 3=high, 4=urgent
//
// Why are these tables exported? They're tested independently to lock the
// mapping behavior — if a future contributor changes one direction without
// the other, the round-trip property test (low→todoist→nexus) would fail.
export const TODOIST_PRIORITY_FROM_NEXUS: Record<number, number> = {
  0: 1,  // none → normal
  1: 1,  // low → normal (Todoist has no "low")
  2: 2,  // medium → medium
  3: 3,  // high → high
  4: 4,  // urgent → urgent
};

export const TODOIST_PRIORITY_TO_NEXUS: Record<number, number> = {
  1: 0,  // normal → none
  2: 2,  // medium → medium
  3: 3,  // high → high
  4: 4,  // urgent → urgent
};

/**
 * Todoist user id → Nexus telegram id index.
 *
 * Populated lazily as syncs happen and the adapter sees task payloads with
 * `user_id`. Used by the webhook router to route an incoming push notification
 * to the right Nexus user without scanning the OAuth table on every request.
 *
 * In-memory only — rebuilds on restart from the next sync.
 */
const todoistUserIdToNexus = new Map<number, number>();

export function rememberTodoistUserMapping(todoistUserId: number, nexusUserId: number): void {
  todoistUserIdToNexus.set(todoistUserId, nexusUserId);
}

export function findNexusUserByTodoistId(todoistUserId: number): number | undefined {
  return todoistUserIdToNexus.get(todoistUserId);
}

/** Test-only: clear the mapping cache. */
export function _resetTodoistUserCacheForTests(): void {
  todoistUserIdToNexus.clear();
}

// ─── Adapter ────────────────────────────────────────────────────────

export class TodoistAdapter implements TaskProviderAdapter {
  readonly provider = 'todoist' as const;

  readonly capabilities: TaskProviderCapabilities = {
    canCreate: true,
    canComplete: true,
    canDelete: true,
    canUpdate: true,
    canAssignDue: true,
    hasWebhooks: true,
    hasIncrementalSync: true,
  };

  isConnected(userId: number): boolean {
    return isConnected(userId, 'todoist');
  }

  // ── Reads ────────────────────────────────────────────────────────

  async getProjects(userId: number): Promise<NormalizedProject[]> {
    const token = this.getToken(userId);
    if (!token) return [];

    const response = await fetch(`${TODOIST_REST_API}/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Todoist getProjects failed: ${response.status} ${text}`);
    }
    const projects = (await response.json()) as any[];
    return projects.map((p) => ({
      provider: 'todoist' as const,
      externalId: String(p.id),
      name: p.name,
      color: p.color,
      isDefault: !!p.is_inbox_project,
    }));
  }

  /**
   * Fetch tasks via the Sync API. The Sync API is the only Todoist endpoint
   * that supports cursors AND returns enough metadata for change detection.
   *
   * - First call: sync_token='*' → full snapshot + a fresh cursor
   * - Subsequent calls: sync_token=<saved cursor> → delta since that point
   */
  async getTasks(
    userId: number,
    options?: { projectId?: string; sinceCursor?: string },
  ): Promise<{ tasks: NormalizedTask[]; nextCursor?: string }> {
    const token = this.getToken(userId);
    if (!token) return { tasks: [] };

    const syncToken = options?.sinceCursor || '*';

    const response = await fetch(`${TODOIST_SYNC_API}/sync`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sync_token: syncToken,
        // We pull `items` (tasks) and `projects` so we can resolve project
        // names locally. `user` lets us cache the todoist_user_id → nexus_user_id
        // mapping for the webhook router.
        resource_types: ['items', 'projects', 'user'],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Todoist sync failed: ${response.status} ${text}`);
    }

    const data = (await response.json()) as any;

    // Cache the user_id → nexus mapping for the webhook router
    if (data.user?.id) {
      rememberTodoistUserMapping(Number(data.user.id), userId);
    }

    // Build a project_id → name lookup so each task gets a `projectName`
    const projectsById = new Map<string, string>();
    for (const p of data.projects || []) {
      projectsById.set(String(p.id), p.name);
    }

    const items = (data.items || []) as any[];
    const tasks = items
      // Filter out items the user has soft-deleted (Sync API still returns them)
      .filter((t) => !t.is_deleted)
      // Optional project filter for callers that want a single project
      .filter((t) => !options?.projectId || String(t.project_id) === options.projectId)
      .map((t) => this.mapTask(t, projectsById));

    return {
      tasks,
      nextCursor: data.sync_token,
    };
  }

  // ── Writes ───────────────────────────────────────────────────────

  async createTask(
    userId: number,
    task: Omit<NormalizedTask, 'id' | 'provider' | 'externalId'>,
    options: { idempotencyKey?: string } = {},
  ): Promise<NormalizedTask> {
    const token = this.getToken(userId);
    if (!token) throw new Error('Todoist not connected');

    const body: Record<string, unknown> = {
      content: task.title,
      priority: TODOIST_PRIORITY_FROM_NEXUS[task.priority] ?? 1,
    };
    const projectId = typeof task.providerData?.project_id === 'string' || typeof task.providerData?.project_id === 'number'
      ? String(task.providerData.project_id)
      : null;
    const nexusTaskId = typeof task.providerData?.nexus_task_id === 'string' || typeof task.providerData?.nexus_task_id === 'number'
      ? String(task.providerData.nexus_task_id)
      : null;
    const descriptionWithMarker = appendTodoistNexusMarker(task.description, nexusTaskId);
    if (descriptionWithMarker) body.description = descriptionWithMarker;
    if (projectId) body.project_id = projectId;
    if (task.dueDate) {
      // Todoist supports either due_date (date only) or due_datetime (with time).
      if (task.dueIsDatetime) body.due_datetime = task.dueDate;
      else body.due_date = task.dueDate;
    }
    if (task.tags && task.tags.length > 0) body.labels = task.tags;

    const response = await fetch(`${TODOIST_REST_API}/tasks`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(options.idempotencyKey ? { 'X-Request-Id': options.idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Todoist createTask failed: ${response.status} ${text}`);
    }

    const created = (await response.json()) as any;
    return this.mapTask(created);
  }

  async completeTask(userId: number, externalId: string): Promise<void> {
    const token = this.getToken(userId);
    if (!token) throw new Error('Todoist not connected');

    const response = await fetch(`${TODOIST_REST_API}/tasks/${externalId}/close`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok && response.status !== 204) {
      const text = await response.text();
      throw new Error(`Todoist completeTask failed: ${response.status} ${text}`);
    }
  }

  async deleteTask(userId: number, externalId: string): Promise<void> {
    const token = this.getToken(userId);
    if (!token) throw new Error('Todoist not connected');

    const response = await fetch(`${TODOIST_REST_API}/tasks/${externalId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok && response.status !== 204) {
      const text = await response.text();
      throw new Error(`Todoist deleteTask failed: ${response.status} ${text}`);
    }
  }

  async updateTask(
    userId: number,
    externalId: string,
    updates: Partial<NormalizedTask>,
    options: { nexusTaskId?: string } = {},
  ): Promise<void> {
    const token = this.getToken(userId);
    if (!token) throw new Error('Todoist not connected');

    const body: Record<string, unknown> = {};
    if (updates.title !== undefined) body.content = updates.title;
    if (updates.description !== undefined) {
      const nexusTaskId = options.nexusTaskId
        || (typeof updates.providerData?.nexus_task_id === 'string' || typeof updates.providerData?.nexus_task_id === 'number'
          ? String(updates.providerData.nexus_task_id)
          : undefined);
      body.description = appendTodoistNexusMarker(updates.description, nexusTaskId);
    }
    if (updates.priority !== undefined) {
      body.priority = TODOIST_PRIORITY_FROM_NEXUS[updates.priority] ?? 1;
    }
    if (updates.dueDate !== undefined) {
      if (updates.dueIsDatetime) body.due_datetime = updates.dueDate;
      else body.due_date = updates.dueDate;
    }
    if (updates.tags !== undefined) body.labels = updates.tags;
    if (Object.keys(body).length === 0) return;

    const response = await fetch(`${TODOIST_REST_API}/tasks/${externalId}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok && response.status !== 204) {
      const text = await response.text();
      throw new Error(`Todoist updateTask failed: ${response.status} ${text}`);
    }
  }

  // ── Mapping helpers ───────────────────────────────────────────────

  /**
   * Convert a raw Todoist item (from REST or Sync API) to a NormalizedTask.
   * Both APIs use compatible item shapes for the fields we care about.
   */
  mapTask(t: any, projectsById?: Map<string, string>): NormalizedTask {
    // Sync API uses `checked` (1/0), REST uses `is_completed` (boolean)
    const isCompleted = t.is_completed === true || t.checked === 1 || t.checked === true;

    // due may be { date, datetime, ... } in REST or { date, ... } in Sync
    const due = t.due || null;
    const dueDate = due?.date || due?.datetime || undefined;
    const dueIsDatetime = !!due?.datetime;

    const projectId = t.project_id != null ? String(t.project_id) : undefined;
    const projectName = projectId && projectsById?.get(projectId) || undefined;

    const parsedDescription = parseTodoistNexusMarker(t.description);
    const providerData = {
      ...t,
      description: parsedDescription.description,
      ...(parsedDescription.nexusTaskId ? { nexus_task_id: parsedDescription.nexusTaskId } : {}),
    };

    return {
      provider: 'todoist',
      externalId: String(t.id),
      title: t.content || '',
      description: parsedDescription.description,
      status: isCompleted ? 'completed' : 'pending',
      priority: TODOIST_PRIORITY_TO_NEXUS[t.priority] ?? 0,
      dueDate,
      dueIsDatetime,
      tags: Array.isArray(t.labels) ? t.labels : [],
      completedAt: t.completed_at || undefined,
      url: t.url || undefined,
      projectName,
      providerData,
    };
  }

  // ── Internal ──────────────────────────────────────────────────────

  private getToken(userId: number): string | null {
    const tokens = getTokens(userId, 'todoist');
    if (!tokens) {
      logger.debug({ userId }, 'Todoist not connected');
      return null;
    }
    return tokens.accessToken;
  }
}
