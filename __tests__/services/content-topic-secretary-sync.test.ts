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
  updateTopic: vi.fn((_userId: number, topicId: number, updates: any) => ({
    id: topicId,
    user_id: _userId,
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

import { cleanupContentTopicSecretaryArtifacts, syncContentTopicSecretaryArtifacts } from '../../src/services/content-topic-secretary-sync';
import { invalidateCalendarCaches } from '../../src/services/cache-coherence-registry';
import { updateTopic } from '../../src/services/content-scheduler';
import { invalidateTaskCaches } from '../../src/services/cache-coherence-registry';
import { createEvent, deleteEvent, updateEvent } from '../../src/services/unified-calendar';

function topic(overrides: Partial<any> = {}) {
  return {
    id: 42,
    user_id: 77,
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
      createTask: vi.fn(async () => ({ success: true, data: { id: 'task-1', title: 'Conteúdo: Topic test' } })),
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
      task: { id: 'task_nexus_topic', title: 'Conteúdo: Topic test', listId: '88', listName: 'Tarefas', status: 'notStarted', syncState: 'local_only' },
      mutationId: 'mutation-topic-create',
      idempotentReplay: false,
      warnings: [],
    });
    mockUpdateOfflineFirstTask.mockReturnValue({
      task: { id: 'task_nexus_existing', title: 'Content: Topic test', listId: '90', listName: 'Content', status: 'notStarted', syncState: 'queued' },
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

  it('creates a ledger Secretary task for a date-only topic and does not create a calendar event', async () => {
    await syncContentTopicSecretaryArtifacts(77, topic(), { language: 'pt-BR' });

    expect(mockCreateOfflineFirstTask).toHaveBeenCalledWith(77, 77, expect.objectContaining({
      title: 'Conteúdo: Topic test',
      dueDateTime: '2026-04-26T23:59:00',
      importance: 'normal',
      listName: 'Tarefas',
    }));
    expect(taskProvider.createTask).not.toHaveBeenCalled();
    expect(createEvent).not.toHaveBeenCalled();
    // secretary_task_external_id now stores the NEXUS task id (see the
    // identity-contract comment in upsertSecretaryTaskViaLedger).
    expect(updateTopic).toHaveBeenCalledWith(77, 42, expect.objectContaining({
      secretary_task_list_id: '88',
      secretary_task_list_name: 'Tarefas',
      secretary_task_external_id: 'task_nexus_topic',
      secretary_sync_status: 'task_synced',
    }));
    expect(invalidateTaskCaches).toHaveBeenCalledWith({
      userId: 77,
      listIds: ['88'],
      includeDerivedSurfaces: true,
    });
  });

  it('legacy flag-off path creates the Secretary task through the provider', async () => {
    vi.stubEnv('TASK_SINGLE_WRITE_PATH', '0');
    await syncContentTopicSecretaryArtifacts(77, topic(), { language: 'pt-BR' });

    expect(taskProvider.createTask).toHaveBeenCalledWith('list-1', 'Tarefas', expect.objectContaining({
      title: 'Conteúdo: Topic test',
      dueDateTime: '2026-04-26T23:59:00',
    }));
    expect(mockCreateOfflineFirstTask).not.toHaveBeenCalled();
    expect(updateTopic).toHaveBeenCalledWith(77, 42, expect.objectContaining({
      secretary_task_list_id: 'list-1',
      secretary_task_external_id: 'task-1',
      secretary_sync_status: 'task_synced',
    }));
  });

  it('creates a calendar agenda when the topic includes date and time', async () => {
    await syncContentTopicSecretaryArtifacts(77, topic({
      scheduled_at: '2026-04-26T09:30:00',
    }), { language: 'pt-BR' });

    expect(mockCreateOfflineFirstTask).toHaveBeenCalled();
    expect(createEvent).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Conteúdo: Topic test',
      start: '2026-04-26T09:30:00+01:00',
      end: '2026-04-26T10:30:00+01:00',
      categories: ['Content'],
    }), undefined, 77);
    expect(updateTopic).toHaveBeenCalledWith(77, 42, expect.objectContaining({
      calendar_event_id: 'evt-1',
      calendar_source: 'google',
      secretary_sync_status: 'task_calendar_synced',
    }));
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
    }), { language: 'en' });

    expect(mockResolveOfflineNexusTaskId).toHaveBeenCalledWith(77, 77, 'task-existing');
    expect(mockUpdateOfflineFirstTask).toHaveBeenCalledWith(77, 77, expect.objectContaining({
      taskId: 'task_nexus_existing',
      title: 'Content: Topic test',
    }));
    expect(taskProvider.updateTask).not.toHaveBeenCalled();
    expect(mockCreateOfflineFirstTask).not.toHaveBeenCalled();
    expect(taskProvider.createTask).not.toHaveBeenCalled();
    expect(updateEvent).toHaveBeenCalledWith(expect.objectContaining({
      event_id: 'evt-existing',
      new_title: 'Content: Topic test',
    }), 'outlook', 77);
  });

  it('keeps the task when calendar sync is unavailable', async () => {
    calendarWritable = false;
    vi.mocked(createEvent).mockRejectedValueOnce(new Error('No calendar provider is connected'));

    await syncContentTopicSecretaryArtifacts(77, topic({
      scheduled_at: '2026-04-26T09:30:00',
    }), { language: 'pt-BR' });

    expect(updateTopic).toHaveBeenCalledWith(77, 42, expect.objectContaining({
      secretary_task_external_id: 'task_nexus_topic',
      secretary_sync_status: 'task_synced_calendar_unavailable',
      secretary_sync_error: 'calendar_not_connected',
    }));
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
});
