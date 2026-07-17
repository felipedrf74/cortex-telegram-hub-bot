/**
 * Chat Core v2 confirmation shortcut response — task card identity contract.
 *
 * M5 single write path: created-task cards must prefer the NEXUS task id
 * (the id the REST read model speaks) and keep the numeric row id only as
 * the legacy flag-off shape. Pinned here as a direct unit contract because
 * the deployed iOS client uses card taskId for follow-up reads.
 */

import { describe, expect, it } from 'vitest';
import { buildChatCoreV2CommandConfirmationShortcutResponse } from '../../src/api/routes/chat-core-v2-command-confirmation-response';

const REQUEST_STARTED_AT = 1_752_745_000_000;

function pending(commandType: string, payload: Record<string, unknown>) {
  return {
    commandId: 'cmd-confirm-1',
    capabilityId: commandType,
    expiresAt: '2026-07-17T11:00:00.000Z',
    command: {
      commandId: 'cmd-confirm-1',
      commandType,
      payload,
    },
  } as any;
}

function execution(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    executorVersion: 'executor-test-1',
    commandId: 'cmd-confirm-1',
    capabilityId: 'tasks.create',
    status: 'verified',
    response: { text: 'Done — created.' },
    gateVerdict: {
      ok: true,
      operation: 'execute',
      gateVersion: 'gate-test-1',
      commandStatus: 'executed',
      capabilityId: 'tasks.create',
    },
    ...overrides,
  } as any;
}

describe('buildChatCoreV2CommandConfirmationShortcutResponse task cards', () => {
  it('prefers the NEXUS task id on created-task cards (single write path)', () => {
    const response = buildChatCoreV2CommandConfirmationShortcutResponse({
      pending: pending('tasks.create', { title: 'Comprar suplementos', dueDateTime: '2026-07-20T09:00:00.000Z', list: 'Inbox' }),
      execution: execution({ createdTaskNexusId: 'task_nexus_77', createdTaskId: 42 }),
      requestStartedAt: REQUEST_STARTED_AT,
    });

    expect(response.responseCards).toEqual([{
      kind: 'taskCard',
      taskId: 'task_nexus_77',
      title: 'Comprar suplementos',
      status: 'created',
      dueAt: '2026-07-20T09:00:00.000Z',
      listName: 'Inbox',
    }]);
    expect(response.metadata.chatCoreV2.commandType).toBe('tasks.create');
  });

  it('falls back to the numeric row id as a string for the legacy flag-off shape', () => {
    const response = buildChatCoreV2CommandConfirmationShortcutResponse({
      pending: pending('tasks.create', { title: 'Legacy row id' }),
      execution: execution({ createdTaskNexusId: undefined, createdTaskId: 42 }),
      requestStartedAt: REQUEST_STARTED_AT,
    });

    expect(response.responseCards[0]).toMatchObject({ kind: 'taskCard', taskId: '42', title: 'Legacy row id' });
  });

  it('renders a pending card without a task id when no id came back at all', () => {
    const response = buildChatCoreV2CommandConfirmationShortcutResponse({
      pending: pending('tasks.create', { title: 'Sem id' }),
      execution: execution({ createdTaskNexusId: undefined, createdTaskId: undefined, status: 'verification_failed' }),
      requestStartedAt: REQUEST_STARTED_AT,
    });

    expect(response.responseCards[0]).toMatchObject({ kind: 'taskCard', taskId: null, status: 'pending' });
  });
});
