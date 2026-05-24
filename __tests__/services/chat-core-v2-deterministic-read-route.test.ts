import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { NormalizedTask } from '../../src/services/task-store/types';

vi.mock('../../src/services/task-store/task-service', () => ({
  listTasks: vi.fn(),
}));

import { listTasks } from '../../src/services/task-store/task-service';
import { tryBuildChatCoreV2DeterministicReadRoute } from '../../src/services/chat-core-v2';

const FIXED_NOW = new Date('2026-05-24T10:00:00.000Z');
const ENABLED_ENV = {
  CHAT_CORE_V2_ENABLED: 'true',
  CHAT_CORE_V2_READS_ENABLED: 'true',
} as NodeJS.ProcessEnv;

function task(overrides: Partial<NormalizedTask>): NormalizedTask {
  return {
    id: 1,
    provider: 'nexus',
    externalId: `task-${overrides.id ?? 1}`,
    title: 'Task',
    status: 'pending',
    priority: 0,
    projectName: 'Inbox',
    ...overrides,
  };
}

describe('Chat Core v2 deterministic read route', () => {
  beforeEach(() => {
    vi.mocked(listTasks).mockReset();
  });

  it('stays disabled unless both global and read flags are explicitly enabled', () => {
    vi.mocked(listTasks).mockReturnValue([]);

    const disabled = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'What tasks do I have today?',
      userId: 42,
      tenantId: 84,
      now: FIXED_NOW,
      env: {},
    });
    expect(disabled).toBeNull();
    expect(listTasks).not.toHaveBeenCalled();

    const globalOnly = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'What tasks do I have today?',
      userId: 42,
      tenantId: 84,
      now: FIXED_NOW,
      env: { CHAT_CORE_V2_ENABLED: 'true' } as NodeJS.ProcessEnv,
    });
    expect(globalOnly).toBeNull();
    expect(listTasks).not.toHaveBeenCalled();
  });

  it('answers task summary questions without model calls or provider reads', () => {
    vi.mocked(listTasks).mockReturnValue([
      task({ id: 1, title: 'Review proposal', dueDate: '2026-05-24', priority: 3 }),
      task({ id: 2, title: 'Send invoice', dueDate: '2026-05-23', priority: 2 }),
      task({ id: 3, title: 'Buy groceries', dueDate: '2026-05-26', priority: 1 }),
    ]);

    const result = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'What tasks do I have today?',
      userId: 42,
      tenantId: 84,
      locale: 'en-US',
      timezone: 'Europe/Lisbon',
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });

    expect(result).not.toBeNull();
    expect(listTasks).toHaveBeenCalledWith(42, { status: 'pending' });
    expect(result?.response).toMatchObject({
      schemaVersion: 'chat_response_v2@1.0.0',
      kind: 'message',
      locale: 'en',
      cards: [],
      reasonCodes: ['deterministic_read', 'tasks.today_summary'],
    });
    expect(result?.response.text).toContain('You have 3 open tasks.');
    expect(result?.response.text).toContain('1 due today');
    expect(result?.response.text).toContain('1 overdue');
    expect(result?.response.text).toContain('- Send invoice (overdue)');
    expect(result?.response.text).toContain('- Review proposal (today)');
    expect(result?.readModel).toMatchObject({
      capabilityId: 'tasks.today_summary',
      domain: 'tasks',
      sensitivity: 'personal',
      freshness: { status: 'live' },
      data: {
        pendingCount: 3,
        dueTodayCount: 1,
        overdueCount: 1,
        highPriorityCount: 1,
      },
    });
    expect(result?.contextPack.contextHash).toMatch(/^[a-f0-9]{16}$/);
  });

  it('localizes deterministic task summaries for Portuguese users', () => {
    vi.mocked(listTasks).mockReturnValue([
      task({ id: 1, title: 'Enviar proposta', dueDate: '2026-05-24', priority: 1 }),
    ]);

    const pt = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'Que tarefas tenho hoje?',
      userId: 42,
      tenantId: 84,
      locale: 'pt-PT',
      timezone: 'Europe/Lisbon',
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });

    expect(pt?.response.locale).toBe('pt-PT');
    expect(pt?.response.text).toContain('Tens 1 tarefa aberta.');
    expect(pt?.response.text).toContain('1 para hoje');
    expect(pt?.response.text).toContain('- Enviar proposta (hoje)');

    const br = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'Que tarefas tenho hoje?',
      userId: 42,
      tenantId: 84,
      locale: 'pt-BR',
      timezone: 'America/Sao_Paulo',
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });
    expect(br?.response.locale).toBe('pt-BR');
    expect(br?.response.text).toContain('Você tem 1 tarefa aberta.');
  });

  it('does not intercept task writes or multi-domain questions', () => {
    vi.mocked(listTasks).mockReturnValue([]);

    const write = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'Create a task to call Joao tomorrow',
      userId: 42,
      tenantId: 84,
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });
    const portugueseWrite = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'Cria uma tarefa para ligar ao Joao amanha',
      userId: 42,
      tenantId: 84,
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });
    const multiDomain = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'Show my tasks and training today',
      userId: 42,
      tenantId: 84,
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });

    expect(write).toBeNull();
    expect(portugueseWrite).toBeNull();
    expect(multiDomain).toBeNull();
    expect(listTasks).not.toHaveBeenCalled();
  });
});
