import { describe, expect, it } from 'vitest';

import {
  buildChatV2LegacyParityObservation,
  compareLegacyParityProjection,
  projectChatCoreV2CandidateForParity,
  projectLegacyChatResponseForParity,
  routeIdsForLegacyParityResponse,
} from '../../src/services/chat-legacy-parity-observation-harness';
import {
  normalizeChatV2LegacyParityOwnerLabel,
  validateChatV2LegacyParityObservation,
} from '../../src/services/chat-legacy-parity-labels';

const hmacSecret = 'chat-v2-legacy-parity-observation-test-secret';

describe('chat legacy parity observation harness', () => {
  it('normalizes owner/replacement labels before HMAC-only runtime import validation', () => {
    expect(normalizeChatV2LegacyParityOwnerLabel('domain adapters + command bus')).toBe('domain adapters command bus');
    expect(normalizeChatV2LegacyParityOwnerLabel('ChatV2 read/answer planner + evidence policy')).toBe(
      'ChatV2 read/answer planner evidence policy',
    );
  });

  it('builds HMAC-only importable observations from matched safe projections', () => {
    const legacyBody = responseBody({
      domain: 'tasks',
      routeMethod: 'chat-reasoning-engine',
      intent: 'tasks.create',
      actionability: 'write_preview',
      routeKind: 'action',
      metadata: {
        actionConfirmation: { id: 'safe-confirmation-id' },
        actionFrame: { primaryIntent: 'tasks.create' },
      },
    });
    const chatV2Body = responseBody({
      domain: 'tasks',
      routeMethod: 'chat-core-v2-command-preview',
      intent: 'tasks.create',
      actionability: 'write_preview',
      routeKind: 'action',
      metadata: {
        actionConfirmation: { id: 'safe-confirmation-id' },
        actionFrame: { primaryIntent: 'tasks.create' },
        chatCoreV2: {
          capabilityId: 'tasks.create',
          command: { commandId: 'safe-command-id' },
        },
        type: 'chat_core_v2_command_preview',
      },
    });
    const legacyProjection = projectLegacyChatResponseForParity({
      routeId: 'general_action_planner',
      body: legacyBody,
      status: 202,
    });
    const chatV2Projection = projectChatCoreV2CandidateForParity({
      routeId: 'general_action_planner',
      body: chatV2Body,
      status: 202,
    });
    const observation = buildChatV2LegacyParityObservation({
      routeId: 'general_action_planner',
      sampleKey: 'sample-1',
      oldOwner: 'chat-action-planner.ts',
      replacement: 'ChatV2 command preview/write gateway',
      evaluator: 'runtime_tool',
      evidenceSource: 'local_sandbox_seed',
      legacyProjection,
      chatV2Projection,
      hmacSecret,
    });

    expect(observation).toMatchObject({
      routeId: 'general_action_planner',
      matched: true,
      tested: true,
      reasonCode: 'matched',
      evidenceSource: 'local_sandbox_seed',
    });
    expect(observation.sampleHmac).toMatch(/^hmac:legacy-parity:[a-f0-9]{64}$/);
    expect(JSON.stringify(observation)).not.toMatch(/prompt|message|response|text|title|content|tasktitle/i);
    expect(validateChatV2LegacyParityObservation(observation)).toMatchObject({ ok: true });
  });

  it('does not mark observations matched when the ChatV2 projection is missing', () => {
    const body = {
      domain: 'tasks',
      routeMethod: 'chat-reasoning-engine',
      metadata: {
        actionConfirmation: { id: 'safe-confirmation-id' },
        actionFrame: { primaryIntent: 'tasks.create' },
      },
    };
    const legacyProjection = projectLegacyChatResponseForParity({
      routeId: 'general_action_planner',
      body,
      status: 202,
    });
    const chatV2Projection = projectChatCoreV2CandidateForParity({
      routeId: 'general_action_planner',
      body,
      status: 202,
    });
    const comparison = compareLegacyParityProjection(legacyProjection, chatV2Projection);

    expect(chatV2Projection).toBeNull();
    expect(comparison).toEqual({
      matched: false,
      reasonCodes: ['missing_chatv2_projection'],
    });
  });

  it('does not accept generic enriched legacy metadata as a ChatV2 replacement signal', () => {
    const body = responseBody({
      domain: 'tasks',
      routeMethod: 'chat-reasoning-engine',
      intent: 'tasks.create',
      actionability: 'write_preview',
      routeKind: 'action',
      metadata: {
        actionConfirmation: { id: 'safe-confirmation-id' },
        actionFrame: { primaryIntent: 'tasks.create' },
      },
    });

    expect(projectChatCoreV2CandidateForParity({
      routeId: 'general_action_planner',
      body,
      status: 202,
    })).toBeNull();
  });

  it('fails parity when safe semantic projections differ', () => {
    const legacyProjection = projectLegacyChatResponseForParity({
      routeId: 'chat_message_shortcut_after_route',
      body: responseBody({
        domain: 'tasks',
        routeMethod: 'fast-path',
        intent: 'tasks.read',
        actionability: 'read',
        routeKind: 'local_read',
      }),
      status: 200,
    });
    const chatV2Projection = projectLegacyChatResponseForParity({
      routeId: 'chat_message_shortcut_after_route',
      body: responseBody({
        domain: 'tasks',
        routeMethod: 'chat-reasoning-engine',
        intent: 'tasks.create',
        actionability: 'write_preview',
        routeKind: 'action',
        metadata: { actionConfirmation: { id: 'safe-confirmation-id' } },
      }),
      status: 202,
    });

    expect(compareLegacyParityProjection(legacyProjection, chatV2Projection)).toMatchObject({
      matched: false,
      reasonCodes: expect.arrayContaining([
        'actionability_mismatch',
        'card_kind_mismatch',
        'confirmation_policy_mismatch',
      ]),
    });
  });

  it('accepts stricter ChatV2 command envelopes as the reasoning-engine write-preview replacement', () => {
    const legacyProjection = projectLegacyChatResponseForParity({
      routeId: 'chat_reasoning_engine_v1',
      body: responseBody({
        domain: 'tasks',
        routeMethod: 'chat-reasoning-engine',
        intent: 'tasks.create',
        actionability: 'write_preview',
        routeKind: 'action',
        metadata: {
          actionConfirmation: { id: 'safe-confirmation-id' },
        },
      }),
      status: 202,
    });
    const chatV2Projection = projectLegacyChatResponseForParity({
      routeId: 'chat_reasoning_engine_v1',
      body: responseBody({
        domain: 'tasks',
        routeMethod: 'chat-core-v2-command-preview',
        intent: 'tasks.create',
        actionability: 'write_preview',
        routeKind: 'action',
        metadata: {
          actionConfirmation: { id: 'safe-confirmation-id' },
          chatCoreV2: {
            command: { commandId: 'safe-command-id' },
          },
        },
      }),
      status: 202,
    });

    expect(compareLegacyParityProjection(legacyProjection, chatV2Projection)).toEqual({
      matched: true,
      reasonCodes: [],
    });
  });

  it('projects plain execute actionability as write execution, not preview parity', () => {
    const legacyProjection = projectLegacyChatResponseForParity({
      routeId: 'chat_reasoning_engine_v1',
      body: responseBody({
        domain: 'tasks',
        routeMethod: 'chat-reasoning-engine',
        intent: 'tasks.create',
        actionability: 'execute',
        routeKind: 'action',
      }),
      status: 200,
    });
    const chatV2Projection = projectLegacyChatResponseForParity({
      routeId: 'chat_reasoning_engine_v1',
      body: responseBody({
        domain: 'tasks',
        routeMethod: 'chat-core-v2-command-preview',
        intent: 'tasks.create',
        actionability: 'write_preview',
        routeKind: 'action',
        metadata: {
          type: 'chat_core_v2_command_preview',
          actionConfirmation: { id: 'safe-confirmation-id' },
          chatCoreV2: {
            command: { commandId: 'safe-command-id' },
          },
        },
      }),
      status: 202,
    });

    expect(legacyProjection).toMatchObject({
      actionability: 'write_execute',
      cardKind: 'action_result',
      requiresConfirmation: false,
    });
    expect(compareLegacyParityProjection(legacyProjection, chatV2Projection)).toMatchObject({
      matched: false,
      reasonCodes: expect.arrayContaining([
        'actionability_mismatch',
        'card_kind_mismatch',
        'confirmation_policy_mismatch',
      ]),
    });
  });

  it('accepts write-firewall bundle route coupling only for safe write-preview contracts', () => {
    const legacyProjection = projectLegacyChatResponseForParity({
      routeId: 'chat_reasoning_engine_v1',
      body: responseBody({
        domain: 'tasks',
        routeMethod: 'chat-action-deterministic',
        intent: 'tasks.create',
        actionability: 'write_preview',
        routeKind: 'action',
        metadata: {
          actionConfirmation: { id: 'safe-confirmation-id' },
          actionFrame: { primaryIntent: 'tasks.create' },
        },
      }),
      status: 202,
    });
    const chatV2Projection = projectLegacyChatResponseForParity({
      routeId: 'chat_reasoning_engine_v1',
      body: responseBody({
        domain: 'tasks',
        routeMethod: 'chat-core-v2-command-preview',
        intent: 'tasks.create',
        actionability: 'write_preview',
        routeKind: 'action',
        metadata: {
          type: 'chat_core_v2_command_preview',
          actionConfirmation: { id: 'safe-confirmation-id' },
          chatCoreV2: {
            command: { commandId: 'safe-command-id' },
          },
        },
      }),
      status: 202,
    });

    expect(legacyProjection.observedRouteIds).not.toContain('chat_reasoning_engine_v1');
    expect(legacyProjection.observedRouteIds).toEqual(expect.arrayContaining(['general_action_planner']));
    expect(compareLegacyParityProjection(legacyProjection, chatV2Projection)).toEqual({
      matched: true,
      reasonCodes: [],
    });
  });

  it('does not use write-firewall route coupling to bless answer-only duplicate-title drift', () => {
    const legacyProjection = projectLegacyChatResponseForParity({
      routeId: 'general_action_planner',
      body: responseBody({
        domain: 'tasks',
        routeMethod: 'keyword',
        intent: 'tasks.answer',
        actionability: 'answer_only',
        routeKind: 'answer',
      }),
      status: 200,
    });
    const chatV2Projection = projectLegacyChatResponseForParity({
      routeId: 'general_action_planner',
      body: responseBody({
        domain: 'tasks',
        routeMethod: 'chat-core-v2-action-gateway',
        intent: 'tasks.complete',
        actionability: 'clarify',
        routeKind: 'clarification',
        metadata: {
          type: 'chat_core_v2_write_intent_guard',
          responseKind: 'clarification',
        },
      }),
      status: 202,
    });

    expect(compareLegacyParityProjection(legacyProjection, chatV2Projection)).toMatchObject({
      matched: false,
      reasonCodes: expect.arrayContaining([
        'legacy_route_not_observed',
        'chatv2_route_not_observed',
        'actionability_mismatch',
      ]),
    });
  });

  it('does not count a safer ChatV2 clarification as functional parity for legacy destructive confirmation', () => {
    const legacyProjection = projectLegacyChatResponseForParity({
      routeId: 'destructive_confirmation_hold',
      body: responseBody({
        domain: 'tasks',
        routeMethod: 'confirmation-required',
        intent: 'secretary.destructive',
        actionability: 'write_preview',
        routeKind: 'action',
        metadata: {
          actionConfirmation: { id: 'safe-confirmation-id' },
        },
      }),
      status: 202,
    });
    const chatV2Projection = projectLegacyChatResponseForParity({
      routeId: 'destructive_confirmation_hold',
      body: responseBody({
        domain: 'tasks',
        routeMethod: 'chat-core-v2-action-gateway',
        intent: 'secretary.destructive',
        actionability: 'clarify',
        routeKind: 'clarification',
        metadata: {
          responseKind: 'clarification',
        },
      }),
      status: 202,
    });

    expect(compareLegacyParityProjection(legacyProjection, chatV2Projection)).toMatchObject({
      matched: false,
      reasonCodes: expect.arrayContaining([
        'actionability_mismatch',
        'card_kind_mismatch',
        'confirmation_policy_mismatch',
      ]),
    });
  });

  it('does not count clarification without a command envelope as parity when legacy carried confirmation state', () => {
    const legacyProjection = projectLegacyChatResponseForParity({
      routeId: 'destructive_confirmation_hold',
      body: responseBody({
        domain: 'tasks',
        routeMethod: 'confirmation-required',
        intent: 'secretary.destructive',
        actionability: 'clarify',
        routeKind: 'clarification',
        metadata: {
          actionConfirmation: { id: 'safe-confirmation-id' },
        },
      }),
      status: 202,
    });
    const chatV2Projection = projectLegacyChatResponseForParity({
      routeId: 'destructive_confirmation_hold',
      body: responseBody({
        domain: 'tasks',
        routeMethod: 'chat-core-v2-action-gateway',
        intent: 'secretary.destructive',
        actionability: 'clarify',
        routeKind: 'clarification',
        metadata: {
          responseKind: 'clarification',
        },
      }),
      status: 202,
    });

    expect(compareLegacyParityProjection(legacyProjection, chatV2Projection)).toMatchObject({
      matched: false,
      reasonCodes: expect.arrayContaining([
        'confirmation_policy_mismatch',
        'command_envelope_mismatch',
        'visible_diff_mismatch',
      ]),
    });
  });

  it('counts ChatV2 guard-only destructive confirmation as preview contract parity', () => {
    const legacyProjection = projectLegacyChatResponseForParity({
      routeId: 'destructive_confirmation_hold',
      body: responseBody({
        domain: 'tasks',
        routeMethod: 'confirmation-required',
        intent: 'secretary.destructive',
        actionability: 'write_preview',
        routeKind: 'action',
        metadata: {
          actionConfirmation: { id: 'safe-confirmation-id' },
        },
      }),
      status: 202,
    });
    const chatV2Projection = projectLegacyChatResponseForParity({
      routeId: 'destructive_confirmation_hold',
      body: responseBody({
        domain: 'tasks',
        routeMethod: 'chat-core-v2-action-gateway',
        intent: 'secretary.destructive',
        actionability: 'preview',
        routeKind: 'action',
        metadata: {
          type: 'chat_core_v2_write_intent_guard',
          responseKind: 'action_preview',
          actionConfirmation: {
            title: 'Confirmation needed',
            actionLabel: 'Keep paused',
            destructive: true,
            confirmationToken: 'safe-token',
          },
          pendingConfirmation: {
            id: 'safe-pending-id',
            intentClass: 'chat_core_v2_destructive_hold',
          },
          chatCoreV2: {
            actionGateway: {
              guardOnlyConfirmation: true,
            },
          },
        },
      }),
      status: 202,
    });

    expect(chatV2Projection).toMatchObject({
      actionability: 'write_preview',
      cardKind: 'action_preview',
      requiresConfirmation: true,
      hasCommandEnvelope: true,
      hasVisibleDiff: true,
    });
    expect(compareLegacyParityProjection(legacyProjection, chatV2Projection)).toEqual({
      matched: true,
      reasonCodes: [],
    });
  });

  it('detects nested ChatV2 command envelope and visible diff metadata in preview responses', () => {
    const legacyProjection = projectLegacyChatResponseForParity({
      routeId: 'general_action_planner',
      body: responseBody({
        domain: 'tasks',
        routeMethod: 'chat-action-deterministic',
        intent: 'tasks.create',
        actionability: 'write_preview',
        routeKind: 'action',
        metadata: {
          actionConfirmation: { id: 'safe-confirmation-id' },
          actionFrame: { primaryIntent: 'tasks.create' },
        },
      }),
      status: 202,
    });
    const chatV2Projection = projectChatCoreV2CandidateForParity({
      routeId: 'general_action_planner',
      body: responseBody({
        domain: 'tasks',
        routeMethod: 'chat-core-v2-command-preview',
        intent: 'tasks.create',
        actionability: 'write_preview',
        routeKind: 'action',
        metadata: {
          type: 'chat_core_v2_command_preview',
          chatCoreV2: {
            command: { commandId: 'safe-command-id' },
            response: {
              kind: 'action_preview',
              cards: [{
                type: 'task_preview_card',
                diff: [{ label: 'Task', after: 'safe-title-hash-only' }],
              }],
            },
          },
        },
      }),
      status: 202,
    });

    expect(chatV2Projection).toMatchObject({
      hasCommandEnvelope: true,
      hasVisibleDiff: true,
      cardKind: 'action_preview',
    });
    expect(compareLegacyParityProjection(legacyProjection, chatV2Projection)).toEqual({
      matched: true,
      reasonCodes: [],
    });
  });

  it('projects explicit ChatV2 capability metadata before generic reasoning intent', () => {
    const chatV2Projection = projectChatCoreV2CandidateForParity({
      routeId: 'decision_confirmation_shortcut',
      body: responseBody({
        domain: 'secretary',
        routeMethod: 'chat-core-v2-command-preview',
        intent: 'secretary.answer',
        actionability: 'write_preview',
        routeKind: 'action',
        metadata: {
          type: 'chat_core_v2_command_preview',
          chatCoreV2: {
            capabilityId: 'decision_center.dismiss',
            command: { commandId: 'safe-command-id' },
            response: {
              kind: 'action_preview',
              cards: [{
                type: 'decision_preview_card',
                diff: [{ label: 'Decision', after: 'safe-decision-hash-only' }],
              }],
            },
          },
        },
      }),
      status: 202,
    });

    expect(chatV2Projection).toMatchObject({
      capabilityFamily: 'decision_center',
      observedRouteIds: expect.arrayContaining(['decision_confirmation_shortcut']),
    });
  });

  it('accepts ChatV2 decision command previews when legacy decision preview lacked capability labels', () => {
    const legacyProjection = projectLegacyChatResponseForParity({
      routeId: 'decision_confirmation_shortcut',
      body: responseBody({
        domain: 'unknown',
        routeMethod: 'chat-action-deterministic',
        intent: 'unknown',
        actionability: 'write_preview',
        routeKind: 'action',
        metadata: {
          actionConfirmation: { id: 'safe-confirmation-id', decisionId: 'safe-decision-id' },
          actionFrame: { primaryIntent: 'decision_center.dismiss' },
        },
      }),
      status: 202,
    });
    const chatV2Projection = projectChatCoreV2CandidateForParity({
      routeId: 'decision_confirmation_shortcut',
      body: responseBody({
        domain: 'decision_center',
        routeMethod: 'chat-core-v2-command-preview',
        intent: 'secretary.answer',
        actionability: 'write_preview',
        routeKind: 'action',
        metadata: {
          type: 'chat_core_v2_command_preview',
          chatCoreV2: {
            capabilityId: 'decision_center.dismiss',
            command: { commandId: 'safe-command-id' },
            response: {
              kind: 'action_preview',
              cards: [{
                type: 'decision_preview_card',
                diff: [{ label: 'Decision', after: 'safe-decision-hash-only' }],
              }],
            },
          },
        },
      }),
      status: 202,
    });

    expect(compareLegacyParityProjection(legacyProjection, chatV2Projection)).toEqual({
      matched: true,
      reasonCodes: [],
    });
  });

  it('does not infer command envelope or visible diff when only the ChatV2 route signal is present', () => {
    const legacyProjection = projectLegacyChatResponseForParity({
      routeId: 'general_action_planner',
      body: responseBody({
        domain: 'tasks',
        routeMethod: 'chat-action-deterministic',
        intent: 'tasks.create',
        actionability: 'write_preview',
        routeKind: 'action',
        metadata: {
          actionConfirmation: { id: 'safe-confirmation-id' },
          actionFrame: { primaryIntent: 'tasks.create' },
        },
      }),
      status: 202,
    });
    const chatV2Projection = projectChatCoreV2CandidateForParity({
      routeId: 'general_action_planner',
      body: responseBody({
        domain: 'tasks',
        routeMethod: 'chat-core-v2-command-preview',
        intent: 'tasks.create',
        actionability: 'write_preview',
        routeKind: 'action',
        metadata: {
          type: 'chat_core_v2_command_preview',
        },
      }),
      status: 202,
    });

    expect(chatV2Projection).toMatchObject({
      hasCommandEnvelope: false,
      hasVisibleDiff: false,
      cardKind: 'action_preview',
    });
    expect(compareLegacyParityProjection(legacyProjection, chatV2Projection)).toMatchObject({
      matched: false,
      reasonCodes: expect.arrayContaining([
        'command_envelope_mismatch',
        'visible_diff_mismatch',
      ]),
    });
  });

  it('accepts ChatV2 local answer ownership as the classifier/domain-handler replacement for answer-only routes', () => {
    const legacyProjection = projectLegacyChatResponseForParity({
      routeId: 'classifier_route_skill_orchestration',
      body: responseBody({
        domain: 'cooking',
        routeMethod: 'classifier',
        intent: 'cooking.answer',
        actionability: 'answer_only',
        routeKind: 'answer',
      }),
      status: 200,
    });
    const chatV2Projection = projectChatCoreV2CandidateForParity({
      routeId: 'classifier_route_skill_orchestration',
      body: responseBody({
        domain: 'chat',
        routeMethod: 'chat-core-v2-local-llm',
        intent: 'chat.answer',
        actionability: 'answer_only',
        routeKind: 'answer',
        metadata: {
          type: 'chat_core_v2_local_llm',
        },
      }),
      status: 200,
    });

    expect(compareLegacyParityProjection(legacyProjection, chatV2Projection)).toEqual({
      matched: true,
      reasonCodes: [],
    });
  });

  it('does not count mutual degraded responses as parity', () => {
    const legacyProjection = projectLegacyChatResponseForParity({
      routeId: 'selective_internet_research',
      body: responseBody({
        domain: 'training',
        routeMethod: 'internet-research',
        intent: 'training.research',
        actionability: 'degraded',
        routeKind: 'answer',
      }),
      status: 200,
    });
    const chatV2Projection = projectChatCoreV2CandidateForParity({
      routeId: 'selective_internet_research',
      body: responseBody({
        domain: 'training',
        routeMethod: 'chat-core-v2-internet-research',
        intent: 'training.research',
        actionability: 'degraded',
        routeKind: 'answer',
        metadata: {
          type: 'chat_core_v2_internet_research',
        },
      }),
      status: 200,
    });

    expect(compareLegacyParityProjection(legacyProjection, chatV2Projection)).toMatchObject({
      matched: false,
      reasonCodes: expect.arrayContaining(['degraded_not_comparable']),
    });
  });

  it('does not count ChatV2 provider refusal text as parity when legacy answered', () => {
    const legacyProjection = projectLegacyChatResponseForParity({
      routeId: 'selective_internet_research',
      body: responseBody({
        text: 'Public sources summarize the EU AI Act obligations.',
        domain: 'chat',
        routeMethod: 'internet-research',
        intent: 'chat.research',
        actionability: 'answer_only',
        routeKind: 'answer',
      }),
      status: 200,
    });
    const chatV2Projection = projectChatCoreV2CandidateForParity({
      routeId: 'selective_internet_research',
      body: responseBody({
        text: 'I could not produce a safe answer for that request.',
        domain: 'chat',
        routeMethod: 'chat-core-v2-internet-research',
        intent: 'chat.research',
        actionability: 'answer_only',
        routeKind: 'answer',
        metadata: {
          type: 'chat_core_v2_internet_research',
        },
      }),
      status: 200,
    });

    expect(compareLegacyParityProjection(legacyProjection, chatV2Projection)).toMatchObject({
      matched: false,
      reasonCodes: expect.arrayContaining(['chatv2_provider_refusal']),
    });
  });

  it('does not count mutual provider refusals as retirement parity', () => {
    const legacyProjection = projectLegacyChatResponseForParity({
      routeId: 'selective_internet_research',
      body: responseBody({
        text: "I can't assist with that.",
        domain: 'chat',
        routeMethod: 'internet-research',
        intent: 'chat.research',
        actionability: 'answer_only',
        routeKind: 'answer',
      }),
      status: 200,
    });
    const chatV2Projection = projectChatCoreV2CandidateForParity({
      routeId: 'selective_internet_research',
      body: responseBody({
        text: "I can't provide legal advice.",
        domain: 'chat',
        routeMethod: 'chat-core-v2-internet-research',
        intent: 'chat.research',
        actionability: 'answer_only',
        routeKind: 'answer',
        metadata: {
          type: 'chat_core_v2_internet_research',
        },
      }),
      status: 200,
    });

    expect(legacyProjection.responseQuality).toBe('provider_refusal');
    expect(chatV2Projection?.responseQuality).toBe('provider_refusal');
    expect(compareLegacyParityProjection(legacyProjection, chatV2Projection)).toMatchObject({
      matched: false,
      reasonCodes: expect.arrayContaining(['chatv2_provider_refusal']),
    });
  });

  it('does not count incomplete ChatV2 research answers as retirement parity', () => {
    const legacyProjection = projectLegacyChatResponseForParity({
      routeId: 'selective_internet_research',
      body: responseBody({
        text: 'Official public sources list passport validity, completed forms, current fees, appointment requirements, and applicable entry permissions.',
        domain: 'chat',
        routeMethod: 'internet-research',
        intent: 'chat.research',
        actionability: 'answer_only',
        routeKind: 'answer',
      }),
      status: 200,
    });
    const chatV2Projection = projectChatCoreV2CandidateForParity({
      routeId: 'selective_internet_research',
      body: responseBody({
        text: 'Official public sources say the requirements include',
        domain: 'chat',
        routeMethod: 'chat-core-v2-internet-research',
        intent: 'chat.research',
        actionability: 'answer_only',
        routeKind: 'answer',
        metadata: {
          type: 'chat_core_v2_internet_research',
        },
      }),
      status: 200,
    });

    expect(legacyProjection.responseQuality).toBe('usable');
    expect(chatV2Projection?.responseQuality).toBe('incomplete_answer');
    expect(compareLegacyParityProjection(legacyProjection, chatV2Projection)).toMatchObject({
      matched: false,
      reasonCodes: expect.arrayContaining(['chatv2_incomplete_answer']),
    });
  });

  it('does not count long no-terminal ChatV2 research answers as retirement parity', () => {
    const legacyProjection = projectLegacyChatResponseForParity({
      routeId: 'selective_internet_research',
      body: responseBody({
        text: 'Official public sources list passport validity, completed forms, current fees, appointment requirements, and applicable entry permissions.',
        domain: 'chat',
        routeMethod: 'internet-research',
        intent: 'chat.research',
        actionability: 'answer_only',
        routeKind: 'answer',
      }),
      status: 200,
    });
    const chatV2Projection = projectChatCoreV2CandidateForParity({
      routeId: 'selective_internet_research',
      body: responseBody({
        text: `${'Official public sources describe the application timeline, required forms, appointment steps, document checklist, and fee categories. '.repeat(7)}The remaining requirement is`,
        domain: 'chat',
        routeMethod: 'chat-core-v2-internet-research',
        intent: 'chat.research',
        actionability: 'answer_only',
        routeKind: 'answer',
        metadata: {
          type: 'chat_core_v2_internet_research',
        },
      }),
      status: 200,
    });

    expect(legacyProjection.responseQuality).toBe('usable');
    expect(chatV2Projection?.responseQuality).toBe('incomplete_answer');
    expect(compareLegacyParityProjection(legacyProjection, chatV2Projection)).toMatchObject({
      matched: false,
      reasonCodes: expect.arrayContaining(['chatv2_incomplete_answer']),
    });
  });

  it('strips source footers before detecting mid-sentence ChatV2 research cutoffs', () => {
    const legacyProjection = projectLegacyChatResponseForParity({
      routeId: 'selective_internet_research',
      body: responseBody({
        text: 'Official public sources list passport validity, completed forms, appointment requirements, and applicable entry permissions.',
        domain: 'chat',
        routeMethod: 'internet-research',
        intent: 'chat.research',
        actionability: 'answer_only',
        routeKind: 'answer',
      }),
      status: 200,
    });
    const chatV2Projection = projectChatCoreV2CandidateForParity({
      routeId: 'selective_internet_research',
      body: responseBody({
        text: 'Official public sources describe passport validity, completed forms, and applicable entry permissions, while the remaining current requirement is\n\nSources consulted: https://example.gov/entry',
        domain: 'chat',
        routeMethod: 'chat-core-v2-internet-research',
        intent: 'chat.research',
        actionability: 'answer_only',
        routeKind: 'answer',
        metadata: {
          type: 'chat_core_v2_internet_research',
        },
      }),
      status: 200,
    });

    expect(legacyProjection.responseQuality).toBe('usable');
    expect(chatV2Projection?.responseQuality).toBe('incomplete_answer');
    expect(compareLegacyParityProjection(legacyProjection, chatV2Projection)).toMatchObject({
      matched: false,
      reasonCodes: expect.arrayContaining(['chatv2_incomplete_answer']),
    });
  });

  it('treats auth, quota, and provider HTTP failures as non-comparable evidence', () => {
    const legacyProjection = projectLegacyChatResponseForParity({
      routeId: 'training_plan_shortcut',
      body: {
        error: 'Quota exceeded',
        details: {
          // The projection must ignore body details; they may contain customer-facing quota metadata.
          limitUsd: 0.06,
          usedUsd: 0.061,
        },
      },
      status: 429,
    });
    const chatV2Projection = projectChatCoreV2CandidateForParity({
      routeId: 'training_plan_shortcut',
      body: {
        error: 'Provider unavailable',
      },
      status: 503,
    });

    expect(legacyProjection).toMatchObject({
      owner: 'transport',
      routeMethod: 'http_status_429',
      actionability: 'degraded',
      cardKind: 'degraded',
      observedRouteIds: ['training_plan_shortcut'],
    });
    expect(chatV2Projection).toMatchObject({
      owner: 'transport',
      routeMethod: 'http_status_503',
      actionability: 'degraded',
      cardKind: 'degraded',
      observedRouteIds: ['training_plan_shortcut'],
    });
    expect(compareLegacyParityProjection(legacyProjection, chatV2Projection)).toMatchObject({
      matched: false,
      reasonCodes: ['degraded_not_comparable'],
    });
  });

  it('maps safe response metadata to Phase 7 route ids without raw text', () => {
    expect(routeIdsForLegacyParityResponse({
      owner: 'training',
      routeMethod: 'keyword',
      capability: 'training.read',
      actionability: 'read',
      cardKind: 'read_result',
    })).toEqual(expect.arrayContaining([
      'classifier_route_skill_orchestration',
      'training_plan_shortcut',
      'domain_handler_execution',
    ]));

    expect(routeIdsForLegacyParityResponse({
      owner: 'tasks',
      routeMethod: 'confirmation-required',
      capability: 'secretary.destructive',
      actionability: 'write_preview',
      cardKind: 'action_preview',
      requiresConfirmation: true,
    })).toEqual(expect.arrayContaining([
      'destructive_confirmation_hold',
      'general_action_planner',
      'domain_handler_execution',
    ]));

    const tokenZeroRouteIds = routeIdsForLegacyParityResponse({
      owner: 'tasks',
      routeMethod: 'fast-path',
      capability: 'tasks.read',
      actionability: 'read',
      cardKind: 'read_result',
      metadata: {
        tokenZeroSurface: 'slash',
      },
    });
    expect(tokenZeroRouteIds).toEqual(expect.arrayContaining(['token_zero_message_shortcuts']));
    expect(tokenZeroRouteIds).not.toContain('chat_message_shortcut_after_route');

    expect(routeIdsForLegacyParityResponse({
      owner: 'secretary',
      routeMethod: 'confirmation-required',
      capability: 'secretary.destructive',
      actionability: 'write_preview',
      cardKind: 'action_preview',
      metadata: {
        pendingConfirmation: {
          id: 'safe-pending-id',
          decisionId: 'safe-decision-id',
        },
      },
    })).toEqual(expect.arrayContaining([
      'decision_confirmation_shortcut',
      'destructive_confirmation_hold',
    ]));
  });
});

function responseBody(input: {
  text?: string;
  domain: string;
  routeMethod: string;
  intent: string;
  actionability: string;
  routeKind: string;
  metadata?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    ...(input.text ? { text: input.text } : {}),
    domain: input.domain,
    routeMethod: input.routeMethod,
    metadata: {
      ...(input.metadata ?? {}),
      chatReasoning: {
        ownerSkill: input.domain,
        routeMethod: input.routeMethod,
        intent: input.intent,
        actionability: input.actionability,
        routeKind: input.routeKind,
        verificationStatus: input.actionability === 'read' ? 'not_required' : 'pending',
      },
      finalAnswerComposition: {
        mode: 'templated',
      },
    },
  };
}
