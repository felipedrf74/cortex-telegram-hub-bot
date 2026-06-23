// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from '../database';
import type { TaskProviderType } from './task-router';
import type { TaskSyncState, TaskSyncWarning } from './offline-first-task-service';

export type TaskProviderLinkProvider = 'ms_todo' | 'todoist' | 'nexus_local';

export interface TaskContainerMapping {
  nexusListId: string;
  provider: 'ms_todo' | 'todoist';
  providerContainerType: 'todo_list' | 'project' | 'section';
  providerContainerId: string;
  syncDirection: 'none' | 'pull_only' | 'push_only' | 'bidirectional';
}

export interface TaskSyncPolicy {
  mode:
    | 'local_only'
    | 'sync_to_preferred_provider'
    | 'sync_to_specific_provider'
    | 'pull_only'
    | 'bidirectional';
  preferredProvider?: 'ms_todo' | 'todoist';
  providerAccountId?: string;
}

export interface TaskSyncTarget {
  provider: TaskProviderLinkProvider;
  providerAccountId: string;
  providerListId: string | null;
  providerProjectId: string | null;
  syncState: TaskSyncState;
  mutationStatus: 'queued' | 'synced' | 'failed';
  linkState: 'linked' | 'pending_create' | 'stale' | 'disconnected';
  warning?: TaskSyncWarning;
}

function providerAccountId(userId: number, provider: TaskProviderLinkProvider): string {
  return `${provider}:${userId}`;
}

function providerForTaskProvider(provider: TaskProviderType): TaskProviderLinkProvider {
  return provider === 'nexus' ? 'nexus_local' : provider;
}

export function getTaskContainerMapping(
  tenantId: number,
  userId: number,
  nexusListId: string,
  provider: 'ms_todo' | 'todoist',
): TaskContainerMapping | null {
  const row = getDb().prepare(
    `SELECT nexus_list_id, provider, provider_container_type, provider_container_id, sync_direction
     FROM task_container_mappings
     WHERE tenant_id = ? AND user_id = ? AND nexus_list_id = ? AND provider = ?
     LIMIT 1`,
  ).get(tenantId, userId, nexusListId, provider) as {
    nexus_list_id: string;
    provider: 'ms_todo' | 'todoist';
    provider_container_type: 'todo_list' | 'project' | 'section';
    provider_container_id: string;
    sync_direction: 'none' | 'pull_only' | 'push_only' | 'bidirectional';
  } | undefined;
  if (!row) return null;
  return {
    nexusListId: row.nexus_list_id,
    provider: row.provider,
    providerContainerType: row.provider_container_type,
    providerContainerId: row.provider_container_id,
    syncDirection: row.sync_direction,
  };
}

export function resolveTaskSyncTarget(input: {
  tenantId: number;
  userId: number;
  nexusListId: string;
  preferredProvider: TaskProviderType;
}): TaskSyncTarget {
  const provider = providerForTaskProvider(input.preferredProvider);
  if (provider === 'nexus_local') {
    return {
      provider,
      providerAccountId: providerAccountId(input.userId, provider),
      providerListId: input.nexusListId,
      providerProjectId: input.nexusListId,
      syncState: 'local_only',
      mutationStatus: 'synced',
      linkState: 'linked',
    };
  }

  const mapping = getTaskContainerMapping(input.tenantId, input.userId, input.nexusListId, provider);
  if (!mapping || mapping.syncDirection === 'none' || mapping.syncDirection === 'pull_only') {
    const isTodoist = provider === 'todoist';
    return {
      provider,
      providerAccountId: providerAccountId(input.userId, provider),
      providerListId: null,
      providerProjectId: null,
      syncState: 'failed_permanent',
      mutationStatus: 'failed',
      linkState: 'stale',
      warning: {
        code: isTodoist ? 'provider_project_missing' : 'provider_list_missing',
        provider,
        message: isTodoist
          ? 'The provider project no longer exists. Choose a new sync target.'
          : 'The provider list no longer exists. Choose a new sync target.',
      },
    };
  }

  return {
    provider,
    providerAccountId: providerAccountId(input.userId, provider),
    providerListId: mapping.providerContainerType === 'todo_list' ? mapping.providerContainerId : null,
    providerProjectId: mapping.providerContainerType !== 'todo_list' ? mapping.providerContainerId : null,
    syncState: 'queued',
    mutationStatus: 'queued',
    linkState: 'pending_create',
  };
}
