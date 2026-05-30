import { describe, expect, it, vi } from 'vitest';

import {
  detectChatCoreV2WriteIntent,
  resolveChatCoreV2ActionGatewayMode,
  runChatCoreV2ActionGateway,
  shouldGateReadFastPathsForWriteIntent,
} from '../../src/services/chat-core-v2/action-gateway';
import { classifyShadowRoute } from '../../src/services/chat-core-v2/shadow-route-classifier';

vi.mock('../../src/services/chat-core-v2/command-preview-route', () => ({
  tryBuildChatCoreV2CommandPreviewRoute: vi.fn((input: { normalizedText: string }) => {
    if (!input.normalizedText.includes('comprar suplementos')) return null;
    return {
      capabilityId: 'tasks.complete',
      gateVerdict: { ok: true },
      command: {
        commandId: 'cmd-task-1',
        idempotencyKey: 'idem-task-1',
        basedOn: { entityIds: ['native_tasks:5'] },
      },
    };
  }),
}));

vi.mock('../../src/services/chat-core-v2/shadow-route-classifier', () => ({
  classifyShadowRoute: vi.fn(() => ({
    intent: 'answer',
    domains: [],
    capabilityIds: [],
  })),
}));

describe('ChatCoreV2 action gateway', () => {
  const baseInput = {
    requestId: 'req-1',
    normalizedText: 'Mark comprar suplementos task as done',
    userId: 42,
    tenantId: 84,
    conversationId: 'conv-1',
    messageId: 'msg-1',
    locale: 'en',
    timezone: 'Europe/Lisbon',
    now: new Date('2026-05-28T12:00:00.000Z'),
    env: {
      CHAT_CORE_V2_ACTION_GATEWAY_MODE: 'enforce',
      CHAT_CORE_V2_LEGACY_WRITE_FALLTHROUGH_BLOCK: 'on',
      CHAT_CORE_V2_WRITE_INTENT_HASH_SECRET: 'test-secret',
    } as NodeJS.ProcessEnv,
  };

  it('keeps orchestrator off as the master switch for the gateway', () => {
    expect(resolveChatCoreV2ActionGatewayMode({
      CHAT_CORE_V2_ORCHESTRATOR_MODE: 'off',
      CHAT_CORE_V2_ACTION_GATEWAY_MODE: 'enforce',
      CHAT_CORE_V2_ENABLED: 'true',
      CHAT_CORE_V2_WRITES_ENABLED: 'true',
    } as NodeJS.ProcessEnv)).toBe('off');
  });

  it('only gates read fast paths for write intents when the gateway is enforcing', () => {
    const enforceEnv = { CHAT_CORE_V2_ACTION_GATEWAY_MODE: 'enforce' } as NodeJS.ProcessEnv;
    const offEnv = {
      CHAT_CORE_V2_ORCHESTRATOR_MODE: 'off',
      CHAT_CORE_V2_ACTION_GATEWAY_MODE: 'enforce',
    } as NodeJS.ProcessEnv;
    const shadowEnv = { CHAT_CORE_V2_ACTION_GATEWAY_MODE: 'shadow' } as NodeJS.ProcessEnv;

    expect(shouldGateReadFastPathsForWriteIntent('Mark comprar suplementos task as done', enforceEnv)).toBe(true);
    expect(shouldGateReadFastPathsForWriteIntent('Give me one small next step for today.', enforceEnv)).toBe(false);
    expect(shouldGateReadFastPathsForWriteIntent('Mark comprar suplementos task as done', offEnv)).toBe(false);
    expect(shouldGateReadFastPathsForWriteIntent('Mark comprar suplementos task as done', shadowEnv)).toBe(false);
  });

  it('detects task completion writes without treating negation as executable', () => {
    expect(detectChatCoreV2WriteIntent('Mark comprar suplementos task as done')).toEqual(expect.objectContaining({
      mayMutate: true,
      detectedIntent: 'task_complete',
      actionType: 'tasks.complete',
    }));

    expect(detectChatCoreV2WriteIntent('Don’t mark comprar suplementos task as done')).toEqual(expect.objectContaining({
      mayMutate: true,
      detectedIntent: 'task_complete',
      reasonCodes: ['write_intent_safety_guard'],
    }));
  });

  it('does not treat next-step advice follow-ups as task writes', () => {
    expect(detectChatCoreV2WriteIntent('Agora me dá um próximo passo pequeno para hoje.')).toEqual(expect.objectContaining({
      mayMutate: false,
      detectedIntent: 'none',
    }));

    expect(detectChatCoreV2WriteIntent('Give me one small next step for today.')).toEqual(expect.objectContaining({
      mayMutate: false,
      detectedIntent: 'none',
    }));

    expect(detectChatCoreV2WriteIntent('Crie uma tarefa para comprar suplementos QA: k2 d3 creatina')).toEqual(expect.objectContaining({
      mayMutate: true,
      detectedIntent: 'task_create',
      actionType: 'tasks.create',
    }));
  });

  it('flags bare ambiguous cancel/move/postpone as a write intent (not a free-text answer)', () => {
    for (const text of ['cancel that', 'cancela isso', 'move it pra sexta', 'Adia o meu treino de hoje para amanhã', 'muda essa para amanhã']) {
      expect(detectChatCoreV2WriteIntent(text)).toEqual(expect.objectContaining({ mayMutate: true }));
    }
  });

  it('does not let a shadow-route action guess flag a plain read question as a write', () => {
    vi.mocked(classifyShadowRoute).mockReturnValueOnce(
      { intent: 'modify_action', domains: ['secretary'], capabilityIds: ['secretary.schedule_event'] } as unknown as ReturnType<typeof classifyShadowRoute>,
    );
    expect(detectChatCoreV2WriteIntent('o que eu tenho na agenda hoje?')).toEqual(expect.objectContaining({ mayMutate: false, detectedIntent: 'none' }));
  });

  it('answers a how-to question rather than treating it as a mutation', () => {
    expect(detectChatCoreV2WriteIntent('how do I cancel my subscription?')).toEqual(expect.objectContaining({ mayMutate: false }));
  });

  it('returns resolved_execute only through a command preview and HMAC-only telemetry', () => {
    const result = runChatCoreV2ActionGateway({
      ...baseInput,
      // WP-10: resolved_execute requires the explicit write-execution gate; the
      // gate ONLY governs the auto-execute envelope, not the firewall. The flag
      // is resolved through resolveChatCoreV2ActivationConfig (WP-00.5), which
      // only honors it when the orchestrator mode is explicitly 'on'.
      env: {
        ...baseInput.env,
        CHAT_CORE_V2_ALLOW_WRITE_EXECUTION: 'true',
        CHAT_CORE_V2_ORCHESTRATOR_MODE: 'on',
      } as NodeJS.ProcessEnv,
      shouldAutoExecute: () => true,
    });

    expect(result.kind).toBe('resolved_execute');
    if (result.kind !== 'resolved_execute') throw new Error('expected resolved_execute');
    expect(result.command.commandId).toBe('cmd-task-1');
    expect(result.telemetry.resolvedEntityIds).toEqual(['native_tasks:5']);
    expect(result.telemetry.messageHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result.telemetry)).not.toContain('comprar suplementos');
  });

  it('does not use a hardcoded fallback secret when write-intent HMAC config is missing', () => {
    const { CHAT_CORE_V2_WRITE_INTENT_HASH_SECRET, ...envWithoutSecret } = baseInput.env;
    expect(CHAT_CORE_V2_WRITE_INTENT_HASH_SECRET).toBe('test-secret');

    const result = runChatCoreV2ActionGateway({
      ...baseInput,
      env: {
        ...envWithoutSecret,
        CHAT_CORE_V2_ALLOW_WRITE_EXECUTION: 'true',
        CHAT_CORE_V2_ORCHESTRATOR_MODE: 'on',
      } as NodeJS.ProcessEnv,
      shouldAutoExecute: () => true,
    });

    expect(result.kind).toBe('resolved_execute');
    expect(result.telemetry.messageHash).toBe('hmac_unavailable');
    expect(JSON.stringify(result.telemetry)).not.toContain('comprar suplementos');
  });

  it('blocks negated write intents before legacy fallthrough in enforce mode', () => {
    const result = runChatCoreV2ActionGateway({
      ...baseInput,
      normalizedText: 'Don’t mark comprar suplementos task as done',
    });

    expect(result.kind).toBe('unsupported_write');
    if (result.kind !== 'unsupported_write') throw new Error('expected unsupported_write');
    expect(result.reason).toBe('write_intent_negated_or_hypothetical');
    expect(result.telemetry.legacyFallbackBlocked).toBe(true);
    expect(result.telemetry.reasonCodes).toContain('negation_or_hypothetical_guard');
  });

  it('logs but does not enforce write blocking in shadow mode', () => {
    const result = runChatCoreV2ActionGateway({
      ...baseInput,
      normalizedText: 'Mark unknown task as done',
      env: {
        ...baseInput.env,
        CHAT_CORE_V2_ACTION_GATEWAY_MODE: 'shadow',
      } as NodeJS.ProcessEnv,
    });

    expect(result.kind).toBe('no_write_intent');
    expect(result.telemetry.policyDecision).toBe('shadow_would_block');
    expect(result.telemetry.legacyFallbackBlocked).toBe(false);
  });
});
