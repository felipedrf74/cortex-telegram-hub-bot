// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Content topic → Secretary sync.
 *
 * Token-zero rule: scheduling a topic is an operational REST flow, not
 * chat. Date-only topics create a task. Topics with an explicit time
 * also create/update a calendar agenda block.
 */

import { DateTime } from 'luxon';
import { config } from '../config';
import { logger } from '../utils/logger';
import { invalidateCalendarCaches } from './cache-coherence-registry';
import { getTopicById, updateTopic, type ContentTopic } from './content-scheduler';
import { invalidateTaskCaches } from './cache-coherence-registry';
import { resolveTaskCreationList } from './task-store/task-list-resolution';
import { getTaskProviderForUser } from './task-store/task-router';
import { isSingleWritePathEnabled } from './task-store/single-write-path';
import {
  createOfflineFirstTask,
  recordLocalTaskMutation,
  resolveOfflineCaptureListName,
  resolveOfflineNexusTaskId,
  updateOfflineFirstTask,
} from './task-store/offline-first-task-service';
import {
  createEvent,
  deleteEvent,
  hasWritableCalendarForUser,
  updateEvent,
  type CalendarSource,
} from './unified-calendar';
import { safeContentLogErrorFields } from './content-log-safety';

type LangLike = 'pt-BR' | 'pt-PT' | 'en' | string | undefined;

export interface ContentTopicSecretarySyncOptions {
  language?: LangLike;
  tenantId?: number;
  /** Private titles/notes are never shared unless the caller collected explicit consent. */
  shareContentTitle?: boolean;
  sharePrivateNotes?: boolean;
}

export interface ContentTopicSecretaryCleanupOptions {
  tenantId?: number;
}

export async function syncContentTopicSecretaryArtifactsById(
  userId: number,
  topicId: number,
  options: ContentTopicSecretarySyncOptions = {},
): Promise<ContentTopic | null> {
  const tenantId = options.tenantId ?? userId;
  const topic = getTopicById(userId, topicId, tenantId);
  if (!topic) return null;
  return syncContentTopicSecretaryArtifacts(userId, topic, options);
}

export async function syncContentTopicSecretaryArtifacts(
  userId: number,
  topic: ContentTopic,
  options: ContentTopicSecretarySyncOptions = {},
): Promise<ContentTopic> {
  const tenantId = options.tenantId ?? userId;
  assertContentTopicSecretaryScope(userId, tenantId, topic);
  // Migration 247 routes topic CRUD into the canonical workspace. Its
  // deadline is not permission to create a task/calendar event. Canonical
  // scheduling now requires an explicit workspace preview + confirmation.
  // This guard also makes already-queued legacy jobs harmless after rollout.
  if (topic.workspace_item_id != null) {
    logger.info(
      { userId, topicId: topic.id, workspaceItemId: topic.workspace_item_id },
      'Skipped retired content topic Secretary sync; workspace confirmation is required',
    );
    return topic;
  }
  if (!topic.scheduled_date && !topic.scheduled_at) return topic;

  const taskTitle = buildTaskTitle(
    options.shareContentTitle === true ? topic.title : null,
    options.language,
  );
  const body = buildTaskBody(topic, options.language, options.sharePrivateNotes === true);
  const dueDateTime = taskDueDateTime(topic);

  const updates: Parameters<typeof updateTopic>[2] = {
    secretary_sync_status: 'syncing',
    secretary_sync_error: null,
  };

  try {
    const taskRef = await upsertSecretaryTask(userId, tenantId, topic, {
      title: taskTitle,
      body,
      dueDateTime,
    });
    updates.secretary_task_list_id = taskRef.listId;
    updates.secretary_task_list_name = taskRef.listName;
    updates.secretary_task_external_id = taskRef.taskId;
    updates.secretary_sync_status = 'task_synced';
    invalidateTaskCaches({ userId, listIds: [taskRef.listId], includeDerivedSurfaces: true });
  } catch (err) {
    logger.warn(
      { ...safeContentLogErrorFields(err), userId, topicId: topic.id },
      'Content topic Secretary task sync failed',
    );
    updates.secretary_sync_status = 'task_failed';
    updates.secretary_sync_error = 'task_sync_failed';
    return updateTopic(userId, topic.id, updates, tenantId) ?? topic;
  }

  if (!topic.scheduled_at) {
    return updateTopic(userId, topic.id, updates, tenantId) ?? topic;
  }

  try {
    const calendarRef = await upsertCalendarAgenda(userId, topic, {
      title: taskTitle,
      body,
    });
    updates.calendar_event_id = calendarRef.eventId;
    updates.calendar_source = calendarRef.source;
    updates.secretary_sync_status = 'task_calendar_synced';
    invalidateCalendarCaches(userId);
  } catch (err) {
    const unavailable = !hasWritableCalendarForUser(userId);
    logger.warn(
      { ...safeContentLogErrorFields(err), userId, topicId: topic.id, unavailable },
      'Content topic calendar agenda sync failed',
    );
    updates.secretary_sync_status = unavailable
      ? 'task_synced_calendar_unavailable'
      : 'task_synced_calendar_failed';
    updates.secretary_sync_error = unavailable
      ? 'calendar_not_connected'
      : 'calendar_sync_failed';
  }

  return updateTopic(userId, topic.id, updates, tenantId) ?? topic;
}

export async function cleanupContentTopicSecretaryArtifacts(
  userId: number,
  topic: ContentTopic,
  options: ContentTopicSecretaryCleanupOptions = {},
): Promise<{ taskDeleted: boolean; calendarDeleted: boolean; errors: string[] }> {
  const tenantId = options.tenantId ?? userId;
  assertContentTopicSecretaryScope(userId, tenantId, topic);
  const errors: string[] = [];
  let taskDeleted = false;
  let calendarDeleted = false;

  if (topic.secretary_task_external_id && (isSingleWritePathEnabled() || topic.secretary_task_list_id)) {
    if (isSingleWritePathEnabled()) {
      // M5 ledger path: journal task.delete against the resolved nexus task.
      // secretary_task_external_id stores the nexus task id for ledger-created
      // rows; legacy rows stored provider ids, which the resolver bridges via
      // task_provider_links. An unresolvable id means the task is already
      // gone locally — treat the cleanup as converged.
      try {
        const nexusTaskId = resolveOfflineNexusTaskId(tenantId, userId, String(topic.secretary_task_external_id));
        if (nexusTaskId) {
          recordLocalTaskMutation(tenantId, userId, {
            taskId: nexusTaskId,
            operation: 'task.delete',
            patch: { source: 'content_topic_secretary_sync' },
          });
        }
        taskDeleted = true;
        invalidateTaskCaches({
          userId,
          listIds: topic.secretary_task_list_id ? [String(topic.secretary_task_list_id)] : [],
          includeDerivedSurfaces: true,
        });
      } catch (err) {
        logger.warn({ ...safeContentLogErrorFields(err), userId, topicId: topic.id }, 'Content topic Secretary task cleanup failed');
        errors.push('task_cleanup_failed');
      }
    } else {
      // Legacy direct-provider path (TASK_SINGLE_WRITE_PATH=0).
      const todo = getTaskProviderForUser(userId);
      if (typeof todo.deleteTask === 'function') {
        try {
          const result = await todo.deleteTask(String(topic.secretary_task_list_id), String(topic.secretary_task_external_id));
          if (result?.success === false) throw new Error(result.error || 'task_delete_failed');
          taskDeleted = true;
          invalidateTaskCaches({ userId, listIds: [String(topic.secretary_task_list_id)], includeDerivedSurfaces: true });
        } catch (err) {
          logger.warn({ ...safeContentLogErrorFields(err), userId, topicId: topic.id }, 'Content topic Secretary task cleanup failed');
          errors.push('task_cleanup_failed');
        }
      } else {
        errors.push('task_delete_unsupported');
      }
    }
  }

  if (topic.calendar_event_id && topic.calendar_source) {
    try {
      await deleteEvent(String(topic.calendar_event_id), topic.calendar_source as CalendarSource, userId);
      calendarDeleted = true;
      invalidateCalendarCaches(userId);
    } catch (err) {
      logger.warn({ ...safeContentLogErrorFields(err), userId, topicId: topic.id }, 'Content topic calendar agenda cleanup failed');
      errors.push('calendar_cleanup_failed');
    }
  }

  return { taskDeleted, calendarDeleted, errors };
}

async function upsertSecretaryTask(
  userId: number,
  tenantId: number,
  topic: ContentTopic,
  data: { title: string; body: string; dueDateTime: string },
): Promise<{ listId: string; listName: string; taskId: string }> {
  return isSingleWritePathEnabled()
    ? upsertSecretaryTaskViaLedger(userId, tenantId, topic, data)
    : upsertSecretaryTaskViaProvider(userId, topic, data);
}

/**
 * M5 ledger upsert. Identity contract for `secretary_task_external_id`:
 * ledger-created rows store the created task's NEXUS id (task.id from the
 * ledger DTO — the id the REST read model speaks). Rows written before M5
 * stored the PROVIDER task id; resolveOfflineNexusTaskId bridges those via
 * task_provider_links, so both generations resolve here. The stored
 * listId/listName likewise move to the local project row identity.
 */
async function upsertSecretaryTaskViaLedger(
  userId: number,
  tenantId: number,
  topic: ContentTopic,
  data: { title: string; body: string; dueDateTime: string },
): Promise<{ listId: string; listName: string; taskId: string }> {
  const existingTaskId = topic.secretary_task_external_id
    ? resolveOfflineNexusTaskId(tenantId, userId, String(topic.secretary_task_external_id))
    : null;

  if (existingTaskId) {
    const updated = updateOfflineFirstTask(tenantId, userId, {
      taskId: existingTaskId,
      title: data.title,
      body: data.body,
      importance: 'normal',
      dueDateTime: data.dueDateTime,
    });
    return {
      listId: updated.task.listId != null ? String(updated.task.listId) : String(topic.secretary_task_list_id || ''),
      listName: updated.task.listName || topic.secretary_task_list_name || 'Inbox',
      taskId: updated.task.id,
    };
  }

  const created = createOfflineFirstTask(tenantId, userId, {
    title: data.title,
    body: data.body,
    importance: 'normal',
    dueDateTime: data.dueDateTime,
    listName: resolveOfflineCaptureListName(tenantId, userId, topic.secretary_task_list_name || 'Tarefas'),
  });
  return {
    listId: created.task.listId != null ? String(created.task.listId) : '',
    listName: created.task.listName || 'Tarefas',
    taskId: created.task.id,
  };
}

/** Legacy direct-provider upsert (TASK_SINGLE_WRITE_PATH=0 revert lever). */
async function upsertSecretaryTaskViaProvider(
  userId: number,
  topic: ContentTopic,
  data: { title: string; body: string; dueDateTime: string },
): Promise<{ listId: string; listName: string; taskId: string }> {
  const todo = getTaskProviderForUser(userId);
  const list = topic.secretary_task_list_id
    ? {
        id: topic.secretary_task_list_id,
        displayName: topic.secretary_task_list_name || 'Inbox',
      }
    : await resolveTaskCreationList(todo, 'Tarefas');

  if (!list) {
    throw new Error('No task list available for content topic sync');
  }

  const listId = String(list.id);
  const listName = String(list.displayName || (list as any).name || 'Inbox');
  const existingTaskId = topic.secretary_task_external_id;

  if (existingTaskId && typeof todo.updateTask === 'function') {
    const result = await todo.updateTask(listId, String(existingTaskId), {
      title: data.title,
      body: data.body,
      importance: 'normal',
      dueDateTime: data.dueDateTime,
    }, listName);

    if (result?.success) {
      return { listId, listName, taskId: String(result.data?.id || existingTaskId) };
    }
  }

  const result = await todo.createTask(listId, listName, {
    title: data.title,
    body: data.body,
    importance: 'normal',
    dueDateTime: data.dueDateTime,
  });

  if (!result?.success || !result.data?.id) {
    throw new Error(result?.error || 'Task provider did not return a task id');
  }

  return { listId, listName, taskId: String(result.data.id) };
}

async function upsertCalendarAgenda(
  userId: number,
  topic: ContentTopic,
  data: { title: string; body: string },
): Promise<{ eventId: string; source: CalendarSource }> {
  const window = calendarWindow(topic.scheduled_at);
  if (!window) throw new Error('Invalid scheduled_at for content topic calendar sync');

  const existingEventId = topic.calendar_event_id;
  const existingSource = topic.calendar_source as CalendarSource | undefined;

  if (existingEventId && existingSource) {
    const event = await updateEvent({
      event_id: existingEventId,
      new_start: window.start,
      new_end: window.end,
      new_title: data.title,
    }, existingSource, userId);
    return { eventId: event.id, source: event.source };
  }

  const event = await createEvent({
    title: data.title,
    start: window.start,
    end: window.end,
    description: data.body,
    categories: ['Content'],
  }, undefined, userId);

  return { eventId: event.id, source: event.source };
}

function buildTaskTitle(title: string | null, language: LangLike): string {
  if (!title) return isPortuguese(language) ? 'Bloco de trabalho de conteúdo' : 'Content work block';
  return isPortuguese(language) ? `Conteúdo: ${title}` : `Content: ${title}`;
}

function buildTaskBody(topic: ContentTopic, language: LangLike, sharePrivateNotes: boolean): string {
  const date = topic.scheduled_at ?? topic.scheduled_date ?? '';
  const notes = sharePrivateNotes ? topic.notes?.trim() : null;
  const lines = isPortuguese(language)
    ? [
        'Criado pela Agenda de tópicos do Nexus Hub.',
        `Referência privada: content-topic-${topic.id}`,
        date ? `Quando: ${date}` : '',
        notes ? `Notas: ${notes}` : '',
      ]
    : [
        'Created by Nexus Hub Topic Schedule.',
        `Private reference: content-topic-${topic.id}`,
        date ? `When: ${date}` : '',
        notes ? `Notes: ${notes}` : '',
      ];
  return lines.filter(Boolean).join('\n');
}

function taskDueDateTime(topic: ContentTopic): string {
  const zone = config.app.timezone;
  if (topic.scheduled_at) {
    const parsed = DateTime.fromISO(topic.scheduled_at, { zone });
    if (parsed.isValid) {
      return parsed.toISO({ suppressMilliseconds: true, includeOffset: false })!;
    }
  }
  const date = DateTime.fromISO(topic.scheduled_date || DateTime.now().setZone(zone).toISODate()!, { zone });
  return date.set({ hour: 23, minute: 59, second: 0, millisecond: 0 })
    .toISO({ suppressMilliseconds: true, includeOffset: false })!;
}

function calendarWindow(scheduledAt?: string | null): { start: string; end: string } | null {
  if (!scheduledAt) return null;
  const start = DateTime.fromISO(scheduledAt, { zone: config.app.timezone });
  if (!start.isValid) return null;
  return {
    start: start.toISO({ suppressMilliseconds: true })!,
    end: start.plus({ minutes: 60 }).toISO({ suppressMilliseconds: true })!,
  };
}

function isPortuguese(language: LangLike): boolean {
  return String(language || '').toLowerCase().startsWith('pt');
}

function assertContentTopicSecretaryScope(
  userId: number,
  tenantId: number,
  topic: ContentTopic,
): void {
  if (
    (topic.tenant_id != null && Number(topic.tenant_id) !== tenantId)
    || (topic.owner_user_id != null && Number(topic.owner_user_id) !== userId)
  ) {
    throw new Error('content_topic_secretary_sync_scope_mismatch');
  }
}
