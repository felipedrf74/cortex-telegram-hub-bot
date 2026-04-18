import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/oauth-store', () => ({
  isConnected: vi.fn(() => false),
}));

import { NativeTaskAdapter } from '../../../src/services/task-store/native-adapter';
import { getTaskProviderForUser } from '../../../src/services/task-store/task-router';

describe('task-router native wrapper', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps invalid AI list ids back to the user default native list before creating a task', async () => {
    vi.spyOn(NativeTaskAdapter.prototype, 'getProjects').mockResolvedValue([
      {
        provider: 'nexus',
        externalId: '1',
        name: 'Inbox',
        isDefault: true,
      },
    ] as any);
    const createSpy = vi.spyOn(NativeTaskAdapter.prototype, 'createTask').mockResolvedValue({
      id: 9,
      provider: 'nexus',
      externalId: '9',
      projectId: 1,
      projectName: 'Inbox',
      title: 'Review deck',
      status: 'pending',
      priority: 2,
    } as any);

    const provider = getTaskProviderForUser(42);
    const result = await provider.createTask('12345', 'Inbox', { title: 'Review deck' });

    expect(createSpy).toHaveBeenCalledWith(42, expect.objectContaining({
      title: 'Review deck',
      projectId: 1,
      projectName: 'Inbox',
    }));
    expect(result).toMatchObject({
      success: true,
      data: expect.objectContaining({
        id: '9',
        listId: '1',
        listName: 'Inbox',
        title: 'Review deck',
      }),
    });
  });

  it('filters due tasks through the native adapter when no external task provider is connected', async () => {
    vi.spyOn(NativeTaskAdapter.prototype, 'getTasks').mockResolvedValue({
      tasks: [
        {
          id: 1,
          provider: 'nexus',
          externalId: '1',
          projectId: 7,
          projectName: 'Inbox',
          title: 'Due today',
          status: 'pending',
          priority: 2,
          dueDate: '2026-04-15T10:00:00.000Z',
        },
        {
          id: 2,
          provider: 'nexus',
          externalId: '2',
          projectId: 7,
          projectName: 'Inbox',
          title: 'Due next week',
          status: 'pending',
          priority: 2,
          dueDate: '2026-04-20T10:00:00.000Z',
        },
      ],
    });

    const provider = getTaskProviderForUser(42);
    const result = await provider.getTasksDueInRange(
      '2026-04-15T00:00:00.000Z',
      '2026-04-15T23:59:59.000Z',
    );

    expect(result).toMatchObject({
      success: true,
      data: [
        expect.objectContaining({
          id: '1',
          title: 'Due today',
          listId: '7',
          listName: 'Inbox',
        }),
      ],
    });
  });

  it('searches native tasks locally when no external provider is connected', async () => {
    vi.spyOn(NativeTaskAdapter.prototype, 'getTasks').mockResolvedValue({
      tasks: [
        {
          id: 1,
          provider: 'nexus',
          externalId: '1',
          projectId: 7,
          projectName: 'Inbox',
          title: 'Review training deck',
          description: 'Slides for Friday',
          status: 'pending',
          priority: 2,
        },
        {
          id: 2,
          provider: 'nexus',
          externalId: '2',
          projectId: 7,
          projectName: 'Inbox',
          title: 'Buy groceries',
          status: 'pending',
          priority: 1,
        },
      ],
    });

    const provider = getTaskProviderForUser(42);
    const result = await provider.searchTasks('review training');

    expect(result).toMatchObject({
      success: true,
      data: [
        expect.objectContaining({
          id: '1',
          title: 'Review training deck',
        }),
      ],
    });
  });
});
