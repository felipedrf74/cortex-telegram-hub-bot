// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * TaskProviderAdapter — the contract every task provider implementation must
 * satisfy. Mirrors the WearableAdapter pattern from TASK-09.
 *
 * Adapters are stateless: they take a `userId` on every call and look up the
 * user's OAuth credentials internally. The sync engine and task service never
 * touch provider APIs directly — everything goes through this interface.
 */

import {
  NormalizedTask,
  NormalizedProject,
  TaskProvider,
  TaskProviderCapabilities,
  SyncResult,
} from './types';

export interface TaskProviderAdapter {
  /** Stable provider identifier — must match the `TaskProvider` union. */
  readonly provider: TaskProvider;

  /**
   * What this adapter actually supports. The sync engine and task service
   * read these flags BEFORE invoking optional methods, so adapters with
   * `canDelete: false` never have their `deleteTask` called.
   */
  readonly capabilities: TaskProviderCapabilities;

  /**
   * Whether this adapter has the credentials it needs for the given user.
   * Cheap call — must NOT hit the network. The sync engine calls this
   * thousands of times per cron tick to skip disconnected providers.
   */
  isConnected(userId: number): boolean;

  /** Fetch all projects/lists for a user. */
  getProjects(userId: number): Promise<NormalizedProject[]>;

  /**
   * Fetch tasks. If the adapter supports incremental sync (`hasIncrementalSync`),
   * the engine passes the most recent `sinceCursor` it has stored — and the
   * adapter returns a fresh cursor in `nextCursor` for the next call.
   *
   * If the adapter does NOT support incremental sync, the engine ignores any
   * cursor and the adapter does a full pull each time.
   */
  getTasks(
    userId: number,
    options?: {
      projectId?: string;
      sinceCursor?: string;
      /**
       * Projects the caller already fetched from this adapter during the
       * current sync (the engine's project pull). Adapters that would
       * otherwise re-fetch their project/list catalogue inside `getTasks`
       * (Microsoft To Do) can reuse these to avoid a duplicate provider
       * round-trip. Optional — adapters must behave identically (minus the
       * extra fetch) when omitted.
       */
      knownProjects?: NormalizedProject[];
    },
  ): Promise<{
    tasks: NormalizedTask[];
    nextCursor?: string;
    /**
     * True when the adapter returned a partial task set because one or more
     * provider containers/pages failed. Full-pull reconciliation must not
     * treat omitted tasks as deleted when this is set.
     */
    incomplete?: boolean;
    /** Bounded, operator-readable errors for the sync state. */
    errors?: string[];
  }>;

  /**
   * Create a task in the upstream provider. Returns the fully normalized
   * task (including the provider-assigned external id) so the caller can
   * upsert it into the unified store immediately — no second sync round trip.
   */
  createTask(
    userId: number,
    task: Omit<NormalizedTask, 'id' | 'provider' | 'externalId'>,
    options?: { idempotencyKey?: string },
  ): Promise<NormalizedTask>;

  /** Mark a task complete in the upstream provider. */
  completeTask(userId: number, externalId: string): Promise<void>;

  /** Delete a task in the upstream provider. */
  deleteTask(userId: number, externalId: string): Promise<void>;

  /**
   * Patch arbitrary fields on a task. Optional — adapters whose providers
   * are write-only or have constrained update semantics (Notion property
   * mapping, for example) can omit this and the task service will fall back
   * to delete + create.
   */
  updateTask?(
    userId: number,
    externalId: string,
    updates: Partial<NormalizedTask>,
    options?: { nexusTaskId?: string },
  ): Promise<void>;

  /**
   * Handle an incoming webhook payload. Only present on adapters whose
   * `capabilities.hasWebhooks === true`. The webhook router dispatches to
   * this method after verifying the provider's signature.
   */
  handleWebhook?(userId: number, payload: unknown): Promise<SyncResult>;
}
