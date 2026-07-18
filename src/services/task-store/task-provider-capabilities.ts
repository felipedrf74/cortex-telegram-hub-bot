// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { OfflineTaskDto, TaskSyncWarning } from './offline-first-task-service';

export type OfflineFirstTaskProvider = 'ms_todo' | 'todoist' | 'nexus_local';

export interface OfflineFirstTaskProviderCapabilities {
  provider: OfflineFirstTaskProvider;
  supportsTitle: boolean;
  supportsNotes: boolean;
  supportsStartDate: boolean;
  supportsDueDate: boolean;
  supportsDueTime: boolean;
  supportsReminders: boolean;
  supportsRecurrence: boolean;
  supportsLabels: boolean;
  supportsSubtasks: boolean;
  supportsSections: boolean;
  supportsComments: boolean;
  supportsAttachments: boolean;
  supportsServerIdempotency: boolean;
  supportsIncrementalSync: boolean;
  supportsMoveBetweenContainers: boolean;
  deletionSemantics: 'delete' | 'archive' | 'complete_or_delete' | 'local_only';
}

export interface ProviderProjectionResult {
  providerPayload: Record<string, unknown>;
  unsupportedFields: string[];
  localOnlyFields: string[];
  warnings: TaskSyncWarning[];
}

const CAPABILITIES: Record<OfflineFirstTaskProvider, OfflineFirstTaskProviderCapabilities> = {
  nexus_local: {
    provider: 'nexus_local',
    supportsTitle: true,
    supportsNotes: true,
    supportsStartDate: true,
    supportsDueDate: true,
    supportsDueTime: true,
    supportsReminders: true,
    supportsRecurrence: true,
    supportsLabels: true,
    supportsSubtasks: true,
    supportsSections: true,
    supportsComments: true,
    supportsAttachments: true,
    supportsServerIdempotency: true,
    supportsIncrementalSync: true,
    supportsMoveBetweenContainers: true,
    deletionSemantics: 'local_only',
  },
  ms_todo: {
    provider: 'ms_todo',
    supportsTitle: true,
    supportsNotes: true,
    supportsStartDate: false,
    supportsDueDate: true,
    supportsDueTime: true,
    supportsReminders: true,
    supportsRecurrence: true,
    supportsLabels: true,
    supportsSubtasks: true,
    supportsSections: false,
    supportsComments: false,
    supportsAttachments: true,
    supportsServerIdempotency: false,
    supportsIncrementalSync: true,
    supportsMoveBetweenContainers: false,
    deletionSemantics: 'delete',
  },
  todoist: {
    provider: 'todoist',
    supportsTitle: true,
    supportsNotes: true,
    supportsStartDate: false,
    supportsDueDate: true,
    supportsDueTime: true,
    supportsReminders: true,
    supportsRecurrence: true,
    supportsLabels: true,
    supportsSubtasks: false,
    supportsSections: true,
    supportsComments: true,
    supportsAttachments: true,
    supportsServerIdempotency: false,
    supportsIncrementalSync: true,
    supportsMoveBetweenContainers: true,
    deletionSemantics: 'delete',
  },
};

export function normalizeOfflineFirstTaskProvider(provider: string | null | undefined): OfflineFirstTaskProvider {
  if (provider === 'microsoft_todo' || provider === 'ms_todo') return 'ms_todo';
  if (provider === 'todoist') return 'todoist';
  return 'nexus_local';
}

export function getOfflineFirstTaskProviderCapabilities(
  provider: string | null | undefined,
): OfflineFirstTaskProviderCapabilities {
  return CAPABILITIES[normalizeOfflineFirstTaskProvider(provider)];
}

export function taskProviderDisplayName(provider: string | null | undefined): string {
  const normalized = normalizeOfflineFirstTaskProvider(provider);
  if (normalized === 'ms_todo') return 'Microsoft To Do';
  if (normalized === 'todoist') return 'Todoist';
  return 'Nexus';
}

export function projectTaskForProvider(
  task: OfflineTaskDto,
  provider: string | null | undefined,
): ProviderProjectionResult {
  const normalized = normalizeOfflineFirstTaskProvider(provider);
  const capabilities = CAPABILITIES[normalized];
  const unsupportedFields: string[] = [];
  const localOnlyFields: string[] = [];
  const warnings: TaskSyncWarning[] = [];

  const warnLocalOnly = (field: string) => {
    unsupportedFields.push(field);
    localOnlyFields.push(field);
    warnings.push({
      code: 'unsupported_field_local_only',
      provider: normalized,
      field,
      message: `${field} stays in Nexus because ${taskProviderDisplayName(normalized)} does not support it.`,
    });
  };

  if (task.recurrence && !capabilities.supportsRecurrence) warnLocalOnly('recurrence');
  if (Array.isArray(task.checklistItems) && task.checklistItems.length > 0) {
    if (!capabilities.supportsSubtasks) {
      warnLocalOnly('subtasks');
    }
  }

  const providerPayload: Record<string, unknown> = {
    title: task.title,
    body: task.body || undefined,
    importance: task.importance,
    dueDateTime: task.dueDateTime || undefined,
    // M13: forwarded to microsoft-todo.ts createTask/updateTask, which
    // serialize it zone-naive via toGraphDateTimeTimeZone and toggle
    // isReminderOn. Mirrors dueDateTime: a set reminder rides the push; an
    // unset one is stripped below and leaves the provider reminder untouched.
    reminderDateTime: task.reminderAt || undefined,
    status: task.status,
    recurrence: task.recurrence || undefined,
    checklistItems: capabilities.supportsSubtasks ? task.checklistItems || undefined : undefined,
  };

  for (const key of Object.keys(providerPayload)) {
    if (providerPayload[key] === undefined) delete providerPayload[key];
  }

  return {
    providerPayload,
    unsupportedFields,
    localOnlyFields,
    warnings,
  };
}
