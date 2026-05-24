import { describe, expect, it } from 'vitest';

import {
  CHAT_CORE_V2_CAPABILITIES,
  buildChatCoreV2ActionPreviewResponse,
  buildChatCoreV2ClarificationResponse,
  buildChatCoreV2CommandResultResponse,
  buildChatCoreV2MessageResponse,
  buildChatCoreV2UnsupportedResponse,
  chatCoreV2CardTypeRequiresVisibleDiff,
  getChatCoreV2Capability,
  normalizeChatCoreV2Locale,
  validateChatCoreV2ResponseCard,
  type AICommandEnvelope,
  type CapabilityDefinition,
  type ChatCoreV2ResponseCardType,
} from '../../src/services/chat-core-v2';

function commandEnvelope(overrides: Partial<AICommandEnvelope> = {}): AICommandEnvelope {
  return {
    commandId: 'cmd_123',
    commandSchemaVersion: 'tasks.create@1.0.0',
    previewSchemaVersion: 'task_preview_card@1.0.0',
    responseSchemaVersion: 'chat_response_v2@1.0.0',
    tenantId: 'tenant-1',
    userId: 'user-1',
    domain: 'tasks',
    commandType: 'tasks.create',
    origin: 'chat',
    payload: { title: 'Call Joao tomorrow' },
    basedOn: {
      entityIds: ['task-draft-1'],
      entityVersions: { 'task-draft-1': 'v1' },
      contextHash: 'context-hash',
      createdAt: '2026-05-24T03:00:00.000Z',
    },
    preconditions: {
      requiredEntityVersions: { 'task-draft-1': 'v1' },
      invariants: [],
    },
    authorization: {
      actorUserId: 'user-1',
      tenantId: 'tenant-1',
      actingSurface: 'ios_chat',
      delegatedScopes: ['tasks:read', 'tasks:write'],
      permissionSnapshotVersion: 'permissions@1',
      authTime: '2026-05-24T03:00:00.000Z',
    },
    expiresAt: '2026-05-24T03:10:00.000Z',
    idempotencyKey: 'chat:v2:cmd_123',
    ...overrides,
  };
}

describe('Chat Core v2 response contracts', () => {
  it('normalizes supported locales without changing user-provided copy', () => {
    expect(normalizeChatCoreV2Locale('pt-BR')).toBe('pt-BR');
    expect(normalizeChatCoreV2Locale('pt')).toBe('pt-PT');
    expect(normalizeChatCoreV2Locale('es-ES')).toBe('es');
    expect(normalizeChatCoreV2Locale('fr')).toBe('en');

    const capability = getChatCoreV2Capability('tasks.create') as CapabilityDefinition;
    const response = buildChatCoreV2ActionPreviewResponse({
      capability,
      command: commandEnvelope(),
      title: 'Criar tarefa "Call Joao"',
      summary: 'Vou criar exatamente a tarefa "Call Joao".',
      locale: 'pt-PT',
      confirmationToken: 'confirm-token',
      expiresAt: '2026-05-24T03:10:00.000Z',
    });

    expect(response.locale).toBe('pt-PT');
    expect(response.cards[0].title).toBe('Criar tarefa "Call Joao"');
    expect(response.cards[0].summary).toBe('Vou criar exatamente a tarefa "Call Joao".');
    expect(response.cards[0].primaryAction?.label).toBe('Confirmar');
  });

  it('builds a versioned confirmation preview from capability metadata', () => {
    const capability = getChatCoreV2Capability('tasks.create') as CapabilityDefinition;
    const response = buildChatCoreV2ActionPreviewResponse({
      capability,
      command: commandEnvelope(),
      title: 'Create task',
      summary: 'Create "Call Joao tomorrow".',
      confirmationToken: 'confirm-token',
      expiresAt: '2026-05-24T03:10:00.000Z',
    });

    expect(response).toMatchObject({
      schemaVersion: 'chat_response_v2@1.0.0',
      kind: 'action_preview',
      locale: 'en',
      reasonCodes: [],
    });
    expect(response.cards[0]).toMatchObject({
      type: 'task_preview_card',
      version: 'task_preview_card@1.0.0',
      capabilityId: 'tasks.create',
      commandId: 'cmd_123',
      confirmationToken: 'confirm-token',
      expiresAt: '2026-05-24T03:10:00.000Z',
      sourceEntityIds: ['task-draft-1'],
      primaryAction: {
        id: 'confirm',
        kind: 'confirm',
        label: 'Confirm',
        style: 'primary',
        confirmationToken: 'confirm-token',
      },
    });
    expect(response.cards[0].secondaryActions.map((action) => action.kind)).toEqual(['edit', 'cancel']);
  });

  it('requires visible diffs for change-heavy preview card types', () => {
    const capability = getChatCoreV2Capability('training.modify_session_preview') as CapabilityDefinition;
    const withoutDiff = buildChatCoreV2ActionPreviewResponse({
      capability,
      command: commandEnvelope({ domain: 'training', commandType: 'training.modify_session' }),
      title: 'Make session lighter',
      summary: 'Reduce intensity for Friday.',
    });

    expect(chatCoreV2CardTypeRequiresVisibleDiff('training_change_preview_card')).toBe(true);
    expect(withoutDiff.reasonCodes).toContain('missing_visible_diff');

    const withDiff = buildChatCoreV2ActionPreviewResponse({
      capability,
      command: commandEnvelope({ domain: 'training', commandType: 'training.modify_session' }),
      title: 'Make session lighter',
      summary: 'Reduce intensity for Friday.',
      diff: [{ label: 'Intensity', before: 'hard', after: 'easy' }],
    });

    expect(withDiff.reasonCodes).not.toContain('missing_visible_diff');
    expect(withDiff.cards[0].primaryAction?.kind).toBe('view');
  });

  it('keeps unsupported capabilities deterministic and explicit', () => {
    const response = buildChatCoreV2UnsupportedResponse({
      reason: 'restricted_domain',
      locale: 'en',
      supportedAlternative: 'I can create a reminder to review it manually.',
    });

    expect(response.kind).toBe('unsupported');
    expect(response.cards).toEqual([]);
    expect(response.reasonCodes).toEqual(['restricted_domain']);
    expect(response.text).toContain("I can't do that directly yet");
    expect(response.text).toContain('create a reminder');
  });

  it('builds deterministic message responses without action cards', () => {
    const response = buildChatCoreV2MessageResponse({
      text: 'You have no open tasks right now.',
      locale: 'en-US',
      reasonCodes: ['deterministic_read', 'tasks.today_summary'],
    });

    expect(response).toEqual({
      schemaVersion: 'chat_response_v2@1.0.0',
      kind: 'message',
      locale: 'en',
      text: 'You have no open tasks right now.',
      cards: [],
      reasonCodes: ['deterministic_read', 'tasks.today_summary'],
    });
  });

  it('renders result cards with undo only when the capability supports it and a token is present', () => {
    const taskCapability = getChatCoreV2Capability('tasks.complete') as CapabilityDefinition;
    const taskResult = buildChatCoreV2CommandResultResponse({
      capability: taskCapability,
      commandId: 'cmd_done',
      title: 'Task completed',
      summary: 'Done - I marked the task complete.',
      status: 'verified',
      undoToken: 'undo-token',
    });

    expect(taskResult.cards[0].type).toBe('command_result_card');
    expect(taskResult.cards[0].secondaryActions).toMatchObject([
      { kind: 'undo', label: 'Undo', confirmationToken: 'undo-token' },
    ]);

    const financeCapability = getChatCoreV2Capability('finance.payment_or_tax_action_blocked') as CapabilityDefinition;
    const financeResult = buildChatCoreV2CommandResultResponse({
      capability: financeCapability,
      commandId: 'cmd_finance',
      title: 'Finance action blocked',
      summary: 'This needs manual review.',
      status: 'rejected_by_policy',
      undoToken: 'not-used',
    });

    expect(financeResult.cards[0].secondaryActions).toEqual([]);
  });

  it('keeps every registry preview card type parseable and versioned', () => {
    for (const capability of CHAT_CORE_V2_CAPABILITIES.filter((item) => item.previewCardType)) {
      const cardType = capability.previewCardType!.split('@')[0] as ChatCoreV2ResponseCardType;
      const response = buildChatCoreV2ActionPreviewResponse({
        capability,
        command: commandEnvelope({ domain: capability.domain, commandType: capability.commandType ?? capability.capabilityId }),
        title: `${capability.capabilityId} preview`,
        summary: 'Review the proposed change.',
        diff: chatCoreV2CardTypeRequiresVisibleDiff(cardType)
          ? [{ label: 'Change', before: 'Before', after: 'After' }]
          : [],
        confirmationToken: capability.support.execute === 'supported' ? 'confirm-token' : undefined,
      });

      expect(response.cards[0].version, capability.capabilityId).toMatch(/@\d+\.\d+\.\d+$/);
      expect(validateChatCoreV2ResponseCard(response.cards[0]).issues, capability.capabilityId).not.toContain('unknown_card_type');
    }
  });

  it('builds clarification cards without pretending an action is available', () => {
    const response = buildChatCoreV2ClarificationResponse({
      question: 'Which task do you mean?',
      options: ['Call Joao', 'Send invoice'],
      reasonCodes: ['ambiguous_entity'],
    });

    expect(response.kind).toBe('clarification');
    expect(response.cards[0].type).toBe('clarification_card');
    expect(response.cards[0].primaryAction).toBeUndefined();
    expect(response.cards[0]).toMatchObject({ options: ['Call Joao', 'Send invoice'] });
    expect(response.reasonCodes).toEqual(['ambiguous_entity']);
  });
});
