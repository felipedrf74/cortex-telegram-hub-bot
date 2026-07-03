// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Type definitions for the unified task store and provider adapters.
 *
 * Why a separate types module? Adapters import these without depending on
 * the rest of the task-store machinery — keeps the dependency graph clean
 * and avoids circular imports between adapters and the sync engine.
 */

/** Supported task providers. Add new ones here as adapters are written. */
export type TaskProvider = 'ms_todo' | 'todoist' | 'notion' | 'nexus';

/** Normalized task status — providers map their states into these four. */
export type NormalizedStatus = 'pending' | 'completed' | 'in_progress' | 'cancelled';

/**
 * A normalized task. Every adapter produces records in this shape regardless
 * of how the upstream provider models things. Adapters keep the raw provider
 * payload in `providerData` for fields we don't normalize (e.g., Todoist's
 * `child_order`, Notion's per-property metadata).
 */
export interface NormalizedTask {
  /** SQLite row id — assigned on insert, undefined when constructing for upsert. */
  id?: number;
  provider: TaskProvider;
  /** Provider-specific stable id (Todoist UUID, MS Graph id, Notion page id). */
  externalId: string;
  /** FK to unified_projects.id, populated by the store after project upsert. */
  projectId?: number;
  /** Denormalized project name for fast list reads without a JOIN. */
  projectName?: string;
  title: string;
  description?: string;
  status: NormalizedStatus;
  /** 0=none, 1=low, 2=medium, 3=high, 4=urgent. */
  priority: number;
  /** ISO 8601 date or datetime. Combine with dueIsDatetime to know which. */
  dueDate?: string;
  dueIsDatetime?: boolean;
  tags?: string[];
  notes?: string;
  completedAt?: string;
  assignee?: string;
  /** Deep link to the task in the provider's native UI. */
  url?: string;
  /** Full provider response — preserved so we can re-render rich provider UI. */
  providerData?: Record<string, unknown>;
  /** Provider-native or Nexus-normalized recurrence pattern. */
  recurrence?: unknown;
  /** Checklist/subtask rows normalized across Microsoft To Do and Nexus native tasks. */
  checklistItems?: NormalizedChecklistItem[];
}

export interface NormalizedChecklistItem {
  id: string;
  displayName: string;
  isChecked: boolean;
}

/** Normalized project / task list. */
export interface NormalizedProject {
  /** SQLite row id — assigned on insert. */
  id?: number;
  provider: TaskProvider;
  externalId: string;
  name: string;
  color?: string;
  isDefault?: boolean;
  taskCount?: number;
}

/**
 * What an adapter says it can do. The sync engine uses these to decide
 * whether to call adapter methods at all (skip `completeTask` for adapters
 * with `canComplete: false`, etc.) and the task service uses them to choose
 * a write-back target — it falls back to local storage when the default
 * provider can't satisfy the requested operation.
 */
export interface TaskProviderCapabilities {
  canCreate: boolean;
  canComplete: boolean;
  canDelete: boolean;
  canUpdate: boolean;
  canAssignDue: boolean;
  hasWebhooks: boolean;
  /** True if the adapter accepts a sync cursor / since-token for polling. */
  hasIncrementalSync: boolean;
}

/** What `syncProvider` returns to the caller. */
export interface SyncResult {
  provider: TaskProvider;
  tasksUpserted: number;
  tasksDeleted: number;
  projectsUpserted: number;
  durationMs: number;
  errors: string[];
  /**
   * Set when the engine intentionally skipped this provider's pull without
   * contacting it — currently only the poll-interval gate for full-pull
   * (non-incremental) providers. Absent on real sync attempts.
   */
  skipped?: 'skipped_poll_interval';
}

/** Sync state row as stored in SQLite (snake_case fields). */
export interface SyncStateRow {
  user_id: number;
  provider: TaskProvider;
  last_sync_at: string | null;
  sync_cursor: string | null;
  status: 'idle' | 'syncing' | 'error';
  error_message: string | null;
  tasks_synced: number;
  sync_duration_ms: number | null;
}
