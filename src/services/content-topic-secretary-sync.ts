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
import {
  createEvent,
  deleteEvent,
  hasWritableCalendarForUser,
  updateEvent,
  type CalendarSource,
} from './unified-calendar';

type LangLike = 'pt-BR' | 'pt-PT' | 'en' | string | undefined;

export interface ContentTopicSecretarySyncOptions {
  language?: LangLike;
}

export async function syncContentTopicSecretaryArtifactsById(
  userId: number,
  topicId: number,
  options: ContentTopicSecretarySyncOptions = {},
): Promise<ContentTopic | null> {
  const topic = getTopicById(userId, topicId);
  if (!topic) return null;
  return syncContentTopicSecretaryArtifacts(userId, topic, options);
}

export async function syncContentTopicSecretaryArtifacts(
  userId: number,
  topic: ContentTopic,
  options: ContentTopicSecretarySyncOptions = {},
): Promise<ContentTopic> {
  if (!topic.scheduled_date && !topic.scheduled_at) return topic;

  const taskTitle = buildTaskTitle(topic.title, options.language);
  const body = buildTaskBody(topic, options.language);
  const dueDateTime = taskDueDateTime(topic);

  const updates: Parameters<typeof updateTopic>[2] = {
    secretary_sync_status: 'syncing',
    secretary_sync_error: null,
  };

  try {
    const taskRef = await upsertSecretaryTask(userId, topic, {
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
      { err, userId, topicId: topic.id },
      'Content topic Secretary task sync failed',
    );
    updates.secretary_sync_status = 'task_failed';
    updates.secretary_sync_error = 'task_sync_failed';
    return updateTopic(userId, topic.id, updates) ?? topic;
  }

  if (!topic.scheduled_at) {
    return updateTopic(userId, topic.id, updates) ?? topic;
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
      { err, userId, topicId: topic.id, unavailable },
      'Content topic calendar agenda sync failed',
    );
    updates.secretary_sync_status = unavailable
      ? 'task_synced_calendar_unavailable'
      : 'task_synced_calendar_failed';
    updates.secretary_sync_error = unavailable
      ? 'calendar_not_connected'
      : 'calendar_sync_failed';
  }

  return updateTopic(userId, topic.id, updates) ?? topic;
}

export async function cleanupContentTopicSecretaryArtifacts(
  userId: number,
  topic: ContentTopic,
): Promise<{ taskDeleted: boolean; calendarDeleted: boolean; errors: string[] }> {
  const errors: string[] = [];
  let taskDeleted = false;
  let calendarDeleted = false;

  if (topic.secretary_task_external_id && topic.secretary_task_list_id) {
    const todo = getTaskProviderForUser(userId);
    if (typeof todo.deleteTask === 'function') {
      try {
        const result = await todo.deleteTask(String(topic.secretary_task_list_id), String(topic.secretary_task_external_id));
        if (result?.success === false) throw new Error(result.error || 'task_delete_failed');
        taskDeleted = true;
        invalidateTaskCaches({ userId, listIds: [String(topic.secretary_task_list_id)], includeDerivedSurfaces: true });
      } catch (err) {
        logger.warn({ err, userId, topicId: topic.id }, 'Content topic Secretary task cleanup failed');
        errors.push('task_cleanup_failed');
      }
    } else {
      errors.push('task_delete_unsupported');
    }
  }

  if (topic.calendar_event_id && topic.calendar_source) {
    try {
      await deleteEvent(String(topic.calendar_event_id), topic.calendar_source as CalendarSource, userId);
      calendarDeleted = true;
      invalidateCalendarCaches(userId);
    } catch (err) {
      logger.warn({ err, userId, topicId: topic.id }, 'Content topic calendar agenda cleanup failed');
      errors.push('calendar_cleanup_failed');
    }
  }

  return { taskDeleted, calendarDeleted, errors };
}

async function upsertSecretaryTask(
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

function buildTaskTitle(title: string, language: LangLike): string {
  return isPortuguese(language) ? `Conteúdo: ${title}` : `Content: ${title}`;
}

function buildTaskBody(topic: ContentTopic, language: LangLike): string {
  const date = topic.scheduled_at ?? topic.scheduled_date ?? '';
  const notes = topic.notes?.trim();
  const lines = isPortuguese(language)
    ? [
        'Criado pela Agenda de tópicos do Nexus Hub.',
        date ? `Quando: ${date}` : '',
        notes ? `Notas: ${notes}` : '',
      ]
    : [
        'Created by Nexus Hub Topic Schedule.',
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
