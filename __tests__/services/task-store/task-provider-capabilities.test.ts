import { describe, it, expect } from 'vitest';
import { projectTaskForProvider } from '../../../src/services/task-store/task-provider-capabilities';
import type { OfflineTaskDto } from '../../../src/services/task-store/offline-first-task-service';

function makeDto(overrides: Partial<OfflineTaskDto> = {}): OfflineTaskDto {
  return {
    id: 'task_1',
    title: 'Ship reminders',
    body: null,
    importance: 'normal',
    priority: 3,
    status: 'notStarted',
    dueDateTime: null,
    dueIsDatetime: false,
    reminderAt: null,
    recurrence: null,
    listId: null,
    listName: null,
    checklistItems: null,
    createdDateTime: null,
    syncProvider: 'ms_todo',
    syncState: 'queued',
    syncWarnings: [],
    localVersion: 1,
    deletedAt: null,
    ...overrides,
  };
}

describe('projectTaskForProvider reminder forwarding (M13)', () => {
  it('forwards a set reminderAt as reminderDateTime for the provider push', () => {
    // microsoft-todo.ts createTask/updateTask read `reminderDateTime` and
    // serialize it zone-naive via toGraphDateTimeTimeZone, so the projection
    // must carry the raw instant under that key.
    const projection = projectTaskForProvider(makeDto({ reminderAt: '2026-07-21T07:45:00Z' }), 'ms_todo');
    expect(projection.providerPayload.reminderDateTime).toBe('2026-07-21T07:45:00Z');
  });

  it('omits reminderDateTime entirely when the task has no reminder', () => {
    const projection = projectTaskForProvider(makeDto({ reminderAt: null }), 'ms_todo');
    expect(projection.providerPayload).not.toHaveProperty('reminderDateTime');
  });
});
