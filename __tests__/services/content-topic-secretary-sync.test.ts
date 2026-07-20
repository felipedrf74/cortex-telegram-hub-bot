import { beforeEach, describe, expect, it, vi } from 'vitest';

let taskProvider: any;
let listResult: any;
let calendarWritable = true;

vi.mock('../../src/config', () => ({
  config: { app: { timezone: 'Europe/Lisbon' } },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/services/task-store/task-router', () => ({
  resolveTaskProvider: vi.fn(() => 'nexus'),
  getTaskProviderForUser: vi.fn(() => taskProvider),
}));

vi.mock('../../src/services/task-store/task-list-resolution', () => ({
  resolveTaskCreationList: vi.fn(async () => listResult),
}));

// M5 single write path: secretary task sync writes the offline-first ledger
// by default; the direct provider path survives behind TASK_SINGLE_WRITE_PATH=0.
const mockCreateOfflineFirstTask = vi.fn();
const mockUpdateOfflineFirstTask = vi.fn();
const mockRecordLocalTaskMutation = vi.fn();
const mockResolveOfflineNexusTaskId = vi.fn();
const mockResolveOfflineCaptureListName = vi.fn();

vi.mock('../../src/services/task-store/offline-first-task-service', () => ({
  createOfflineFirstTask: (...args: unknown[]) => mockCreateOfflineFirstTask(...args),
  updateOfflineFirstTask: (...args: unknown[]) => mockUpdateOfflineFirstTask(...args),
  recordLocalTaskMutation: (...args: unknown[]) => mockRecordLocalTaskMutation(...args),
  resolveOfflineNexusTaskId: (...args: unknown[]) => mockResolveOfflineNexusTaskId(...args),
  resolveOfflineCaptureListName: (...args: unknown[]) => mockResolveOfflineCaptureListName(...args),
}));

vi.mock('../../src/services/cache-coherence-registry', () => ({
  ...{
    CacheCoherenceEvents: {},
    _resetDashboardCacheInvalidationStatsForTests: vi.fn(),
    getDashboardCacheInvalidationStats: vi.fn(),
    invalidateCacheForEvent: vi.fn(),
    invalidateCalendarCaches: vi.fn(),
    invalidateContentDerivedCaches: vi.fn(),
    invalidateCookingDerivedCaches: vi.fn(),
    invalidateDashboardCaches: vi.fn(),
    invalidateDashboardCoordinationCaches: vi.fn(),
    invalidateDashboardHomeCaches: vi.fn(),
    invalidateDashboardReadinessCaches: vi.fn(),
    invalidateDashboardRootCaches: vi.fn(),
    invalidateExecutiveBriefCaches: vi.fn(),
    invalidateFinanceDerivedCaches: vi.fn(),
    invalidateIntegrationDerivedCaches: vi.fn(),
    invalidateOnboardingDerivedCaches: vi.fn(),
    invalidatePlanningCaches: vi.fn(),
    invalidateTaskCaches: vi.fn(),
    invalidateTrainingDerivedCaches: vi.fn(),
  },
  invalidateTaskCaches: vi.fn(),
  invalidateCalendarCaches: vi.fn(),
}));

vi.mock('../../src/services/unified-calendar', () => ({
  hasWritableCalendarForUser: vi.fn(() => calendarWritable),
  createEvent: vi.fn(async () => ({ id: 'evt-1', source: 'google' })),
  updateEvent: vi.fn(async () => ({ id: 'evt-existing', source: 'outlook' })),
  deleteEvent: vi.fn(async () => undefined),
}));

vi.mock('../../src/services/content-scheduler', () => ({
  getTopicById: vi.fn(() => null),
  updateTopic: vi.fn((_userId: number, topicId: number, updates: any, tenantId: number = _userId) => ({
    id: topicId,
    user_id: _userId,
    tenant_id: tenantId,
    owner_user_id: _userId,
    visibility_scope: 'user_private',
    scope_status: 'active',
    title: 'Topic test',
    notes: null,
    scheduled_date: '2026-04-26',
    scheduled_at: updates.scheduled_at ?? null,
    status: 'planned',
    created_at: '2026-04-25T10:00:00.000Z',
    updated_at: '2026-04-25T10:05:00.000Z',
    ...updates,
  })),
}));

import {
  cleanupContentTopicSecretaryArtifacts,
  syncContentTopicSecretaryArtifacts,
  syncContentTopicSecretaryArtifactsById,
} from '../../src/services/content-topic-secretary-sync';
import { invalidateCalendarCaches } from '../../src/services/cache-coherence-registry';
import { getTopicById, updateTopic } from '../../src/services/content-scheduler';
import { invalidateTaskCaches } from '../../src/services/cache-coherence-registry';
import { createEvent, deleteEvent, updateEvent } from '../../src/services/unified-calendar';

function topic(overrides: Partial<any> = {}) {
  return {
    id: 42,
    user_id: 77,
    tenant_id: 77,
    owner_user_id: 77,
    visibility_scope: 'user_private',
    scope_status: 'active',
    title: 'Topic test',
    notes: 'Film the practical angle',
    scheduled_date: '2026-04-26',
    scheduled_at: null,
    status: 'planned',
    created_at: '2026-04-25T10:00:00.000Z',
    updated_at: '2026-04-25T10:00:00.000Z',
    ...overrides,
  };
}

describe('content topic Secretary sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calendarWritable = true;
    listResult = { id: 'list-1', displayName: 'Tarefas' };
    taskProvider = {
      createTask: vi.fn(async () => ({ success: true, data: { id: 'task-1', title: 'Bloco de trabalho de conteúdo' } })),
      updateTask: vi.fn(async () => ({ success: true, data: { id: 'task-existing' } })),
      deleteTask: vi.fn(async () => ({ success: true })),
    };
    vi.unstubAllEnvs();
    mockCreateOfflineFirstTask.mockReset();
    mockUpdateOfflineFirstTask.mockReset();
    mockRecordLocalTaskMutation.mockReset();
    mockResolveOfflineNexusTaskId.mockReset();
    mockResolveOfflineCaptureListName.mockReset();
    mockCreateOfflineFirstTask.mockReturnValue({
      task: { id: 'task_nexus_topic', title: 'Bloco de trabalho de conteúdo', listId: '88', listName: 'Tarefas', status: 'notStarted', syncState: 'local_only' },
      mutationId: 'mutation-topic-create',
      idempotentReplay: false,
      warnings: [],
    });
    mockUpdateOfflineFirstTask.mockReturnValue({
      task: { id: 'task_nexus_existing', title: 'Content work block', listId: '90', listName: 'Content', status: 'notStarted', syncState: 'queued' },
      mutationId: 'mutation-topic-update',
      idempotentReplay: false,
    });
    mockRecordLocalTaskMutation.mockReturnValue({
      task: { id: 'task_nexus_existing', status: 'cancelled' },
      mutationId: 'mutation-topic-delete',
      idempotentReplay: false,
    });
    mockResolveOfflineNexusTaskId.mockReturnValue('task_nexus_existing');
    mockResolveOfflineCaptureListName.mockImplementation((_tenantId: unknown, _userId: unknown, name: unknown) => (name as string) || 'Tarefas');
  });

  it('makes queued legacy sync jobs harmless after a topic is linked to the canonical workspace', async () => {
    const canonical = topic({
      workspace_item_id: 9001,
      compatibility_mode: 'canonical_workspace',
      secretary_sync_status: 'workspace_confirmation_required',
    });

    await expect(syncContentTopicSecretaryArtifacts(77, canonical, {
      language: 'en',
      tenantId: 77,
      shareContentTitle: true,
      sharePrivateNotes: true,
    })).resolves.toBe(canonical);

    expect(mockCreateOfflineFirstTask).not.toHaveBeenCalled();
    expect(mockUpdateOfflineFirstTask).not.toHaveBeenCalled();
    expect(taskProvider.createTask).not.toHaveBeenCalled();
    expect(taskProvider.updateTask).not.toHaveBeenCalled();
    expect(createEvent).not.toHaveBeenCalled();
    expect(updateTopic).not.toHaveBeenCalled();
  });

  it('creates a privacy-safe ledger Secretary task for a date-only topic and does not create a calendar event', async () => {
    await syncContentTopicSecretaryArtifacts(77, topic(), { language: 'pt-BR', tenantId: 77 });

    expect(mockCreateOfflineFirstTask).toHaveBeenCalledWith(77, 77, expect.objectContaining({
      title: 'Bloco de trabalho de conteúdo',
      dueDateTime: '2026-04-26T23:59:00',
      importance: 'normal',
      listName: 'Tarefas',
    }));
    const createPayload = mockCreateOfflineFirstTask.mock.calls[0][2];
    expect(createPayload.body).toContain('Referência privada: content-topic-42');
    expect(createPayload.body).not.toContain('Topic test');
    expect(createPayload.body).not.toContain('Film the practical angle');
    expect(taskProvider.createTask).not.toHaveBeenCalled();
    expect(createEvent).not.toHaveBeenCalled();
    // secretary_task_external_id now stores the NEXUS task id (see the
    // identity-contract comment in upsertSecretaryTaskViaLedger).
    expect(updateTopic).toHaveBeenCalledWith(77, 42, expect.objectContaining({
      secretary_task_list_id: '88',
      secretary_task_list_name: 'Tarefas',
      secretary_task_external_id: 'task_nexus_topic',
      secretary_sync_status: 'task_synced',
    }), 77);
    expect(invalidateTaskCaches).toHaveBeenCalledWith({
      userId: 77,
      listIds: ['88'],
      includeDerivedSurfaces: true,
    });
  });

  it('writes the Secretary task to the explicit tenant ledger when tenant and owner differ', async () => {
    await syncContentTopicSecretaryArtifacts(77, topic({ tenant_id: 88 }), {
      language: 'en',
      tenantId: 88,
    });

    expect(mockCreateOfflineFirstTask).toHaveBeenCalledWith(88, 77, expect.objectContaining({
      title: 'Content work block',
      listName: 'Tarefas',
    }));
    expect(mockResolveOfflineCaptureListName).toHaveBeenCalledWith(88, 77, 'Tarefas');
    expect(updateTopic).toHaveBeenCalledWith(77, 42, expect.objectContaining({
      secretary_task_external_id: 'task_nexus_topic',
      secretary_sync_status: 'task_synced',
    }), 88);
  });

  it('legacy flag-off path creates the Secretary task through the provider', async () => {
    vi.stubEnv('TASK_SINGLE_WRITE_PATH', '0');
    await syncContentTopicSecretaryArtifacts(77, topic(), {
      language: 'pt-BR',
      tenantId: 77,
      shareContentTitle: true,
    });

    expect(taskProvider.createTask).toHaveBeenCalledWith('list-1', 'Tarefas', expect.objectContaining({
      title: 'Conteúdo: Topic test',
      dueDateTime: '2026-04-26T23:59:00',
    }));
    expect(mockCreateOfflineFirstTask).not.toHaveBeenCalled();
    expect(updateTopic).toHaveBeenCalledWith(77, 42, expect.objectContaining({
      secretary_task_list_id: 'list-1',
      secretary_task_external_id: 'task-1',
      secretary_sync_status: 'task_synced',
    }), 77);
  });

  it('creates a calendar agenda when the topic includes date and time', async () => {
    await syncContentTopicSecretaryArtifacts(77, topic({
      scheduled_at: '2026-04-26T09:30:00',
    }), { language: 'pt-BR', tenantId: 77 });

    expect(mockCreateOfflineFirstTask).toHaveBeenCalled();
    expect(createEvent).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Bloco de trabalho de conteúdo',
      start: '2026-04-26T09:30:00+01:00',
      end: '2026-04-26T10:30:00+01:00',
      categories: ['Content'],
    }), undefined, 77);
    const calendarPayload = vi.mocked(createEvent).mock.calls[0][0];
    expect(calendarPayload.description).not.toContain('Topic test');
    expect(calendarPayload.description).not.toContain('Film the practical angle');
    expect(updateTopic).toHaveBeenCalledWith(77, 42, expect.objectContaining({
      calendar_event_id: 'evt-1',
      calendar_source: 'google',
      secretary_sync_status: 'task_calendar_synced',
    }), 77);
    expect(invalidateCalendarCaches).toHaveBeenCalledWith(77);
  });

  it('updates existing task and calendar references instead of duplicating them', async () => {
    await syncContentTopicSecretaryArtifacts(77, topic({
      scheduled_at: '2026-04-26T09:30:00',
      secretary_task_list_id: 'list-old',
      secretary_task_list_name: 'Content',
      secretary_task_external_id: 'task-existing',
      calendar_event_id: 'evt-existing',
      calendar_source: 'outlook',
    }), { language: 'en', tenantId: 77 });

    expect(mockResolveOfflineNexusTaskId).toHaveBeenCalledWith(77, 77, 'task-existing');
    expect(mockUpdateOfflineFirstTask).toHaveBeenCalledWith(77, 77, expect.objectContaining({
      taskId: 'task_nexus_existing',
      title: 'Content work block',
    }));
    expect(taskProvider.updateTask).not.toHaveBeenCalled();
    expect(mockCreateOfflineFirstTask).not.toHaveBeenCalled();
    expect(taskProvider.createTask).not.toHaveBeenCalled();
    expect(updateEvent).toHaveBeenCalledWith(expect.objectContaining({
      event_id: 'evt-existing',
      new_title: 'Content work block',
    }), 'outlook', 77);
  });

  it('keeps the task when calendar sync is unavailable', async () => {
    calendarWritable = false;
    vi.mocked(createEvent).mockRejectedValueOnce(new Error('No calendar provider is connected'));

    await syncContentTopicSecretaryArtifacts(77, topic({
      scheduled_at: '2026-04-26T09:30:00',
    }), { language: 'pt-BR', tenantId: 77 });

    expect(updateTopic).toHaveBeenCalledWith(77, 42, expect.objectContaining({
      secretary_task_external_id: 'task_nexus_topic',
      secretary_sync_status: 'task_synced_calendar_unavailable',
      secretary_sync_error: 'calendar_not_connected',
    }), 77);
  });

  it('shares the private title and notes only after explicit per-field opt in', async () => {
    await syncContentTopicSecretaryArtifacts(77, topic(), {
      language: 'en',
      tenantId: 77,
      shareContentTitle: true,
      sharePrivateNotes: true,
    });

    const payload = mockCreateOfflineFirstTask.mock.calls[0][2];
    expect(payload.title).toBe('Content: Topic test');
    expect(payload.body).toContain('Notes: Film the practical angle');
    expect(taskProvider.createTask).not.toHaveBeenCalled();
    expect(updateTopic).toHaveBeenCalledWith(77, 42, expect.any(Object), 77);
  });

  it('passes tenant scope through id-based lookups before attempting external sync', async () => {
    await expect(syncContentTopicSecretaryArtifactsById(77, 42, {
      language: 'en',
      tenantId: 88,
    })).resolves.toBeNull();

    expect(getTopicById).toHaveBeenCalledWith(77, 42, 88);
    expect(mockCreateOfflineFirstTask).not.toHaveBeenCalled();
    expect(taskProvider.createTask).not.toHaveBeenCalled();
    expect(createEvent).not.toHaveBeenCalled();
  });

  it.each([
    ['tenant', { tenant_id: 88 }],
    ['owner', { owner_user_id: 88 }],
  ])('rejects a %s scope mismatch before sharing anything externally', async (_scope, overrides) => {
    await expect(syncContentTopicSecretaryArtifacts(77, topic(overrides), {
      language: 'en',
      tenantId: 77,
      shareContentTitle: true,
      sharePrivateNotes: true,
    })).rejects.toThrow('content_topic_secretary_sync_scope_mismatch');

    expect(mockCreateOfflineFirstTask).not.toHaveBeenCalled();
    expect(mockUpdateOfflineFirstTask).not.toHaveBeenCalled();
    expect(taskProvider.createTask).not.toHaveBeenCalled();
    expect(taskProvider.updateTask).not.toHaveBeenCalled();
    expect(createEvent).not.toHaveBeenCalled();
    expect(updateTopic).not.toHaveBeenCalled();
  });

  it('cleans up existing Secretary task and calendar artifacts', async () => {
    const result = await cleanupContentTopicSecretaryArtifacts(77, topic({
      secretary_task_list_id: 'list-old',
      secretary_task_list_name: 'Content',
      secretary_task_external_id: 'task-existing',
      calendar_event_id: 'evt-existing',
      calendar_source: 'outlook',
    }));

    expect(result).toEqual({ taskDeleted: true, calendarDeleted: true, errors: [] });
    expect(mockResolveOfflineNexusTaskId).toHaveBeenCalledWith(77, 77, 'task-existing');
    expect(mockRecordLocalTaskMutation).toHaveBeenCalledWith(77, 77, {
      taskId: 'task_nexus_existing',
      operation: 'task.delete',
      patch: { source: 'content_topic_secretary_sync' },
    });
    expect(taskProvider.deleteTask).not.toHaveBeenCalled();
    expect(deleteEvent).toHaveBeenCalledWith('evt-existing', 'outlook', 77);
    expect(invalidateTaskCaches).toHaveBeenCalledWith({
      userId: 77,
      listIds: ['list-old'],
      includeDerivedSurfaces: true,
    });
    expect(invalidateCalendarCaches).toHaveBeenCalledWith(77);
  });

  it('cleans up the task in the explicit tenant ledger when tenant and owner differ', async () => {
    const result = await cleanupContentTopicSecretaryArtifacts(77, topic({
      tenant_id: 88,
      secretary_task_list_id: 'list-old',
      secretary_task_external_id: 'task-existing',
    }), { tenantId: 88 });

    expect(result).toEqual({ taskDeleted: true, calendarDeleted: false, errors: [] });
    expect(mockResolveOfflineNexusTaskId).toHaveBeenCalledWith(88, 77, 'task-existing');
    expect(mockRecordLocalTaskMutation).toHaveBeenCalledWith(88, 77, {
      taskId: 'task_nexus_existing',
      operation: 'task.delete',
      patch: { source: 'content_topic_secretary_sync' },
    });
  });

  it('rejects cross-scope cleanup before reading or mutating task and calendar artifacts', async () => {
    await expect(cleanupContentTopicSecretaryArtifacts(77, topic({
      tenant_id: 88,
      secretary_task_list_id: 'list-old',
      secretary_task_external_id: 'task-existing',
      calendar_event_id: 'evt-existing',
      calendar_source: 'outlook',
    }), { tenantId: 77 })).rejects.toThrow('content_topic_secretary_sync_scope_mismatch');

    expect(mockResolveOfflineNexusTaskId).not.toHaveBeenCalled();
    expect(mockRecordLocalTaskMutation).not.toHaveBeenCalled();
    expect(taskProvider.deleteTask).not.toHaveBeenCalled();
    expect(deleteEvent).not.toHaveBeenCalled();
  });

  it('treats cleanup of a task the ledger no longer knows as converged', async () => {
    mockResolveOfflineNexusTaskId.mockReturnValue(null);

    const result = await cleanupContentTopicSecretaryArtifacts(77, topic({
      secretary_task_list_id: 'list-old',
      secretary_task_external_id: 'task-gone',
    }));

    expect(result.taskDeleted).toBe(true);
    expect(result.errors).toEqual([]);
    expect(mockRecordLocalTaskMutation).not.toHaveBeenCalled();
  });

  it('legacy flag-off path cleans up through the provider', async () => {
    vi.stubEnv('TASK_SINGLE_WRITE_PATH', '0');

    const result = await cleanupContentTopicSecretaryArtifacts(77, topic({
      secretary_task_list_id: 'list-old',
      secretary_task_list_name: 'Content',
      secretary_task_external_id: 'task-existing',
    }));

    expect(result.taskDeleted).toBe(true);
    expect(taskProvider.deleteTask).toHaveBeenCalledWith('list-old', 'task-existing');
    expect(mockRecordLocalTaskMutation).not.toHaveBeenCalled();
  });

  it('skips task cleanup entirely when the topic never had a Secretary task', async () => {
    const result = await cleanupContentTopicSecretaryArtifacts(77, topic());

    expect(result).toEqual({ taskDeleted: false, calendarDeleted: false, errors: [] });
    expect(mockResolveOfflineNexusTaskId).not.toHaveBeenCalled();
    expect(mockRecordLocalTaskMutation).not.toHaveBeenCalled();
    expect(taskProvider.deleteTask).not.toHaveBeenCalled();
  });

  it('invalidates without list scope when the topic kept no Secretary list id', async () => {
    const result = await cleanupContentTopicSecretaryArtifacts(77, topic({
      secretary_task_external_id: 'task-existing',
    }));

    expect(result.taskDeleted).toBe(true);
    expect(invalidateTaskCaches).toHaveBeenCalledWith({
      userId: 77,
      listIds: [],
      includeDerivedSurfaces: true,
    });
  });

  it('legacy flag-off cleanup records the failure when the provider rejects the delete', async () => {
    vi.stubEnv('TASK_SINGLE_WRITE_PATH', '0');
    taskProvider.deleteTask = vi.fn(async () => ({ success: false, error: 'graph timeout' }));

    const result = await cleanupContentTopicSecretaryArtifacts(77, topic({
      secretary_task_list_id: 'list-old',
      secretary_task_external_id: 'task-existing',
    }));

    expect(result.taskDeleted).toBe(false);
    expect(result.errors).toEqual(['task_cleanup_failed']);
  });

  it('legacy flag-off cleanup maps a reasonless provider rejection to the generic delete failure', async () => {
    vi.stubEnv('TASK_SINGLE_WRITE_PATH', '0');
    taskProvider.deleteTask = vi.fn(async () => ({ success: false }));

    const result = await cleanupContentTopicSecretaryArtifacts(77, topic({
      secretary_task_list_id: 'list-old',
      secretary_task_external_id: 'task-existing',
    }));

    expect(result.taskDeleted).toBe(false);
    expect(result.errors).toEqual(['task_cleanup_failed']);
  });

  it('legacy flag-off cleanup reports providers without task deletion support', async () => {
    vi.stubEnv('TASK_SINGLE_WRITE_PATH', '0');
    delete taskProvider.deleteTask;

    const result = await cleanupContentTopicSecretaryArtifacts(77, topic({
      secretary_task_list_id: 'list-old',
      secretary_task_external_id: 'task-existing',
    }));

    expect(result.taskDeleted).toBe(false);
    expect(result.errors).toEqual(['task_delete_unsupported']);
  });

  it('ledger update falls back to the stored topic list identity when the local row has none', async () => {
    mockUpdateOfflineFirstTask.mockReturnValue({
      task: { id: 'task_nexus_existing', title: 'Content work block', listId: null, listName: null, status: 'notStarted', syncState: 'queued' },
      mutationId: 'mutation-topic-update',
      idempotentReplay: false,
    });

    await syncContentTopicSecretaryArtifacts(77, topic({
      secretary_task_list_id: 'list-old',
      secretary_task_list_name: 'Content',
      secretary_task_external_id: 'task-existing',
    }), { language: 'en', tenantId: 77 });

    expect(updateTopic).toHaveBeenCalledWith(77, 42, expect.objectContaining({
      secretary_task_list_id: 'list-old',
      secretary_task_list_name: 'Content',
    }), 77);
  });

  it('ledger update defaults to the Inbox label when neither the row nor the topic has a list', async () => {
    mockUpdateOfflineFirstTask.mockReturnValue({
      task: { id: 'task_nexus_existing', title: 'Content work block', listId: null, listName: null, status: 'notStarted', syncState: 'queued' },
      mutationId: 'mutation-topic-update',
      idempotentReplay: false,
    });

    await syncContentTopicSecretaryArtifacts(77, topic({
      secretary_task_external_id: 'task-existing',
    }), { language: 'en', tenantId: 77 });

    expect(updateTopic).toHaveBeenCalledWith(77, 42, expect.objectContaining({
      secretary_task_list_id: '',
      secretary_task_list_name: 'Inbox',
    }), 77);
  });

  it('ledger create defaults to the Tarefas label when the created row carries no list identity', async () => {
    mockCreateOfflineFirstTask.mockReturnValue({
      task: { id: 'task_nexus_topic', title: 'Bloco de trabalho de conteúdo', listId: null, listName: null, status: 'notStarted', syncState: 'local_only' },
      mutationId: 'mutation-topic-create',
      idempotentReplay: false,
      warnings: [],
    });

    await syncContentTopicSecretaryArtifacts(77, topic(), { language: 'pt-BR', tenantId: 77 });

    expect(updateTopic).toHaveBeenCalledWith(77, 42, expect.objectContaining({
      secretary_task_list_id: '',
      secretary_task_list_name: 'Tarefas',
      secretary_task_external_id: 'task_nexus_topic',
    }), 77);
  });
});
