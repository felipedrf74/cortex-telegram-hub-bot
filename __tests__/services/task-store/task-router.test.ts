import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockIsConnected = vi.fn(() => false);
const mockGetTokens = vi.fn(() => null);

vi.mock('../../../src/services/oauth-store', () => ({
  isConnected: (...args: unknown[]) => mockIsConnected(...args),
  getTokens: (...args: unknown[]) => mockGetTokens(...args),
}));

import { NativeTaskAdapter } from '../../../src/services/task-store/native-adapter';
import { getTaskProviderForUser } from '../../../src/services/task-store/task-router';

describe('task-router native wrapper', () => {
  beforeEach(() => {
    mockIsConnected.mockReset();
    mockIsConnected.mockReturnValue(false);
    mockGetTokens.mockReset();
    mockGetTokens.mockReturnValue(null);
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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

  it('routes Todoist users to the Todoist adapter instead of Microsoft To Do', async () => {
    mockIsConnected.mockImplementation((userId: number, provider: string) =>
      userId === 42 && provider === 'todoist'
    );
    mockGetTokens.mockReturnValue({ accessToken: 'todoist-token' });
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [
        { id: 'todoist-inbox', name: 'Inbox', is_inbox_project: true, color: 'charcoal' },
      ],
    } as Response);

    const provider = getTaskProviderForUser(42);
    const result = await provider.getLists();

    expect(fetchMock).toHaveBeenCalledWith('https://api.todoist.com/rest/v2/projects', {
      headers: { Authorization: 'Bearer todoist-token' },
    });
    expect(result).toMatchObject({
      success: true,
      data: [
        expect.objectContaining({
          id: 'todoist-inbox',
          displayName: 'Inbox',
          wellknownListName: 'defaultList',
        }),
      ],
    });
  });

  it('creates Todoist tasks with the requested Todoist project id', async () => {
    mockIsConnected.mockImplementation((userId: number, provider: string) =>
      userId === 42 && provider === 'todoist'
    );
    mockGetTokens.mockReturnValue({ accessToken: 'todoist-token' });
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'task-123',
        content: 'Review Secretary QA',
        description: 'Audit follow-up',
        priority: 3,
        project_id: 'project-9',
        due: { datetime: '2026-04-27T10:00:00.000Z' },
        url: 'https://todoist.com/showTask?id=task-123',
      }),
    } as Response);

    const provider = getTaskProviderForUser(42);
    const result = await provider.createTask('project-9', 'Work', {
      title: 'Review Secretary QA',
      body: 'Audit follow-up',
      importance: 'high',
      dueDateTime: '2026-04-27T10:00:00.000Z',
    });

    const [, request] = fetchMock.mock.calls[0];
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.todoist.com/rest/v2/tasks');
    expect(JSON.parse(String((request as RequestInit).body))).toMatchObject({
      content: 'Review Secretary QA',
      description: 'Audit follow-up',
      priority: 3,
      project_id: 'project-9',
      due_datetime: '2026-04-27T10:00:00.000Z',
    });
    expect(result).toMatchObject({
      success: true,
      data: expect.objectContaining({
        id: 'task-123',
        listId: 'project-9',
        listName: 'Work',
        title: 'Review Secretary QA',
      }),
    });
  });
});
