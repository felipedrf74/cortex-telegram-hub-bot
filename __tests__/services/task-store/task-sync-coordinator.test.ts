/**
 * Tests for src/services/task-store/task-sync-coordinator.ts (M6).
 *
 * The coordinator is a pure orchestration layer, so the worker, sync engine,
 * unified store, and reconciliation job are mocked and the suite asserts
 * single-flight semantics, coalescing into exactly ONE follow-up run, option
 * union rules, and per-step failure isolation.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const deps = vi.hoisted(() => ({
  runTaskMutationSyncBatch: vi.fn(),
  syncProvider: vi.fn(),
  listRegisteredAdapters: vi.fn(),
  getAdapter: vi.fn(),
  isSyncEnabled: vi.fn(),
  runTaskProviderLinkReconciliation: vi.fn(),
}));

vi.mock('../../../src/services/task-store/task-mutation-sync-worker', () => ({
  runTaskMutationSyncBatch: (...args: unknown[]) => deps.runTaskMutationSyncBatch(...args),
}));
vi.mock('../../../src/services/task-store/sync-engine', () => ({
  syncProvider: (...args: unknown[]) => deps.syncProvider(...args),
  listRegisteredAdapters: (...args: unknown[]) => deps.listRegisteredAdapters(...args),
  getAdapter: (...args: unknown[]) => deps.getAdapter(...args),
}));
vi.mock('../../../src/services/task-store/unified-task-store', () => ({
  isSyncEnabled: (...args: unknown[]) => deps.isSyncEnabled(...args),
}));
vi.mock('../../../src/services/task-store/task-reconciliation-job', () => ({
  runTaskProviderLinkReconciliation: (...args: unknown[]) => deps.runTaskProviderLinkReconciliation(...args),
}));
vi.mock('../../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  requestTaskSync,
  isTaskSyncActive,
  _resetTaskSyncCoordinatorForTests,
} from '../../../src/services/task-store/task-sync-coordinator';

const SCOPE = { tenantId: 7, userId: 7 };

function makeAdapter(provider: string, options: { connected?: boolean; incremental?: boolean } = {}) {
  return {
    provider,
    isConnected: vi.fn(() => options.connected ?? true),
    capabilities: { hasIncrementalSync: options.incremental ?? false },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const PUSH_RESULT = {
  processed: 1,
  synced: 1,
  failedRetryable: 0,
  failedPermanent: 0,
  providerDisconnected: 0,
  conflicts: 0,
  deadLettered: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  _resetTaskSyncCoordinatorForTests();
  deps.runTaskMutationSyncBatch.mockResolvedValue(PUSH_RESULT);
  deps.isSyncEnabled.mockReturnValue(true);
  deps.listRegisteredAdapters.mockReturnValue(['ms_todo', 'todoist']);
  deps.getAdapter.mockImplementation((provider: string) => makeAdapter(provider));
  deps.syncProvider.mockImplementation(async (_userId: number, provider: string) => ({
    provider,
    tasksUpserted: 2,
    tasksDeleted: 0,
    projectsUpserted: 0,
    durationMs: 5,
    errors: [],
  }));
  deps.runTaskProviderLinkReconciliation.mockResolvedValue({ scannedLinks: 4 });
});

describe('task sync coordinator (M6 single-flight)', () => {
  it('runs push, pull, and reconciliation in order for a cron-shaped run', async () => {
    const order: string[] = [];
    deps.runTaskMutationSyncBatch.mockImplementation(async () => {
      order.push('push');
      return PUSH_RESULT;
    });
    deps.syncProvider.mockImplementation(async (_userId: number, provider: string) => {
      order.push(`pull:${provider}`);
      return { provider, tasksUpserted: 1, tasksDeleted: 0, projectsUpserted: 0, durationMs: 1, errors: [] };
    });
    deps.runTaskProviderLinkReconciliation.mockImplementation(async () => {
      order.push('reconcile');
      return { scannedLinks: 3 };
    });

    const request = requestTaskSync(SCOPE, 'cron', {
      push: true,
      pull: 'all',
      reconcile: true,
      mutationLimit: 25,
    });
    expect(request.status).toBe('started');
    const summary = await request.completion;

    expect(order).toEqual(['push', 'pull:ms_todo', 'pull:todoist', 'reconcile']);
    expect(deps.runTaskMutationSyncBatch).toHaveBeenCalledWith({ tenantId: 7, userId: 7, limit: 25 });
    expect(deps.syncProvider).toHaveBeenCalledWith(7, 'ms_todo', { force: false });
    expect(summary.push).toEqual(PUSH_RESULT);
    expect(summary.pull).toHaveLength(2);
    expect(summary.reconciledLinks).toBe(3);
    expect(summary.reasons).toEqual(['cron']);
    expect(summary.errors).toEqual([]);
  });

  it('coalesces overlapping requests into exactly ONE follow-up run', async () => {
    const gate = deferred<typeof PUSH_RESULT>();
    deps.runTaskMutationSyncBatch.mockReturnValueOnce(gate.promise as any);

    const first = requestTaskSync(SCOPE, 'cron', { push: true, pull: 'none' });
    expect(first.status).toBe('started');
    expect(isTaskSyncActive(7, 7)).toMatchObject({ active: true, reasons: ['cron'], queued: false });

    const second = requestTaskSync(SCOPE, 'kick', { push: true, pull: 'none' });
    const third = requestTaskSync(SCOPE, 'force_sync', { push: true, pull: 'all', pullForce: true });
    expect(second.status).toBe('coalesced');
    expect(third.status).toBe('coalesced');
    // Both coalesced requests share the single follow-up run.
    expect(second.syncRequestId).toBe(third.syncRequestId);
    expect(isTaskSyncActive(7, 7).queued).toBe(true);

    gate.resolve(PUSH_RESULT);
    const firstSummary = await first.completion;
    const followUpSummary = await third.completion;

    expect(firstSummary.pull).toEqual([]);
    expect(followUpSummary.reasons).toEqual(['kick', 'force_sync']);
    // Follow-up ran the UNION of the coalesced options: push + forced full pull.
    expect(followUpSummary.pull).toHaveLength(2);
    expect(deps.syncProvider).toHaveBeenCalledWith(7, 'ms_todo', { force: true });
    // 2 push batches total: the active run and ONE follow-up (not one per request).
    expect(deps.runTaskMutationSyncBatch).toHaveBeenCalledTimes(2);
    expect(isTaskSyncActive(7, 7)).toMatchObject({ active: false, queued: false });
  });

  it('keeps independent scopes independent', async () => {
    const gate = deferred<typeof PUSH_RESULT>();
    deps.runTaskMutationSyncBatch.mockReturnValueOnce(gate.promise as any);

    const busy = requestTaskSync(SCOPE, 'cron', { push: true });
    const other = requestTaskSync({ tenantId: 8, userId: 9 }, 'kick', { push: true });

    expect(busy.status).toBe('started');
    expect(other.status).toBe('started');
    gate.resolve(PUSH_RESULT);
    await Promise.all([busy.completion, other.completion]);
  });

  it('drops the delta-only restriction when merged with a full pull request', async () => {
    const gate = deferred<typeof PUSH_RESULT>();
    deps.runTaskMutationSyncBatch.mockReturnValueOnce(gate.promise as any);
    deps.getAdapter.mockImplementation((provider: string) =>
      makeAdapter(provider, { incremental: provider === 'todoist' }));

    requestTaskSync(SCOPE, 'cron', { push: true, pull: 'none' });
    requestTaskSync(SCOPE, 'delta_tick', { push: false, pull: 'all', deltaOnly: true });
    const merged = requestTaskSync(SCOPE, 'cron', { push: true, pull: 'all', reconcile: true });

    gate.resolve(PUSH_RESULT);
    const summary = await merged.completion;

    // deltaOnly is an AND: the cron requester wanted a full pull, so BOTH
    // providers were pulled, not just the incremental one.
    expect(summary.pull.map((r) => r.provider).sort()).toEqual(['ms_todo', 'todoist']);
    expect(summary.reconciledLinks).toBe(4);
  });

  it('delta-only pulls skip adapters without incremental sync', async () => {
    deps.getAdapter.mockImplementation((provider: string) =>
      makeAdapter(provider, { incremental: provider === 'ms_todo' }));

    const summary = await requestTaskSync(SCOPE, 'delta_tick', {
      push: false,
      pull: 'all',
      deltaOnly: true,
    }).completion;

    expect(summary.push).toBeNull();
    expect(summary.pull.map((r) => r.provider)).toEqual(['ms_todo']);
    expect(deps.runTaskMutationSyncBatch).not.toHaveBeenCalled();
  });

  it("pull 'all' honors sync-enabled preference and skips disconnected adapters", async () => {
    deps.getAdapter.mockImplementation((provider: string) =>
      makeAdapter(provider, { connected: provider === 'ms_todo' }));

    const connectedOnly = await requestTaskSync(SCOPE, 'cron', { push: false, pull: 'all' }).completion;
    expect(connectedOnly.pull.map((r) => r.provider)).toEqual(['ms_todo']);

    deps.isSyncEnabled.mockReturnValue(false);
    const disabled = await requestTaskSync(SCOPE, 'cron', { push: false, pull: 'all' }).completion;
    expect(disabled.pull).toEqual([]);
  });

  it('explicit provider lists (connect flow) reach syncProvider without the all-pull gates', async () => {
    // Connect-flow parity: syncProvider itself reports Not connected/enabled.
    deps.isSyncEnabled.mockReturnValue(false);
    deps.getAdapter.mockImplementation((provider: string) => makeAdapter(provider, { connected: false }));

    const summary = await requestTaskSync(SCOPE, 'connect', {
      push: true,
      pull: ['ms_todo'],
    }).completion;

    expect(deps.runTaskMutationSyncBatch).toHaveBeenCalledTimes(1);
    expect(deps.syncProvider).toHaveBeenCalledWith(7, 'ms_todo', { force: false });
    expect(summary.pull.map((r) => r.provider)).toEqual(['ms_todo']);
  });

  it('captures per-step failures without rejecting the completion promise', async () => {
    deps.runTaskMutationSyncBatch.mockRejectedValue(new Error('push exploded'));
    deps.syncProvider.mockRejectedValue(new Error('pull exploded'));
    deps.runTaskProviderLinkReconciliation.mockRejectedValue(new Error('reconcile exploded'));

    const summary = await requestTaskSync(SCOPE, 'cron', {
      push: true,
      pull: 'all',
      reconcile: true,
    }).completion;

    expect(summary.push).toBeNull();
    expect(summary.errors).toEqual(expect.arrayContaining([
      'push: push exploded',
      'pull ms_todo: pull exploded',
      'pull todoist: pull exploded',
      'reconcile: reconcile exploded',
    ]));
    // A failed provider still yields an error-shaped SyncResult for callers.
    expect(summary.pull).toHaveLength(2);
    expect(summary.pull[0]).toMatchObject({ provider: 'ms_todo', errors: ['pull exploded'] });
  });
});
