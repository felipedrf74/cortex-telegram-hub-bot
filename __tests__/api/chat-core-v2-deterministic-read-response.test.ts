import { describe, expect, it } from 'vitest';

import { buildChatCoreV2DeterministicReadShortcutResponse } from '../../src/api/routes/chat-core-v2-deterministic-read-response';
import type { ChatCoreV2DeterministicReadRouteResult } from '../../src/services/chat-core-v2';

describe('Chat Core v2 deterministic read API adapter', () => {
  it('maps a deterministic read result into the legacy iOS chat envelope', () => {
    const requestStartedAt = Date.parse('2026-05-24T12:34:56.000Z');
    const result: ChatCoreV2DeterministicReadRouteResult = {
      capabilityId: 'tasks.today_summary',
      routeGuess: {
        intent: 'app_question',
        confidence: 0.82,
        domains: ['tasks'],
        capabilityIds: ['tasks.today_summary'],
      },
      response: {
        schemaVersion: 'chat_response_v2@1.0.0',
        kind: 'message',
        locale: 'en',
        text: 'You have 2 open tasks.',
        cards: [],
        reasonCodes: ['deterministic_read', 'tasks.today_summary'],
      },
      readModel: {
        schemaVersion: 'chat_core_v2_read_model@1.0.0',
        capabilityId: 'tasks.today_summary',
        domain: 'tasks',
        data: {
          pendingCount: 2,
          dueTodayCount: 1,
          overdueCount: 0,
          highPriorityCount: 0,
          timezone: 'Europe/Lisbon',
          topTasks: [],
        },
        sourceEntityIds: ['task:1'],
        sourceVersions: { 'task:1': 'read-model-version' },
        freshness: {
          generatedAt: '2026-05-24T12:34:56.000Z',
          maxSourceAgeSeconds: 60,
          status: 'live',
        },
        sensitivity: 'personal',
        summary: 'You have 2 open tasks.',
        locale: 'en',
      },
      contextPack: {
        schemaVersion: 'chat_core_v2_read_context_pack@1.0.0',
        results: [],
        domains: ['tasks'],
        sourceEntityIds: ['task:1'],
        sourceVersions: { 'task:1': 'context-version' },
        sensitivity: 'personal',
        generatedAt: '2026-05-24T12:34:56.000Z',
        contextHash: 'abc123def4567890',
      },
    };

    const built = buildChatCoreV2DeterministicReadShortcutResponse({
      result,
      requestStartedAt,
    });

    expect(built.conversationDomain).toBe('tasks');
    expect(built.logContext).toEqual({
      capabilityId: 'tasks.today_summary',
      contextHash: 'abc123def4567890',
    });
    expect(built.response).toMatchObject({
      id: `msg-${requestStartedAt}`,
      text: 'You have 2 open tasks.',
      domain: 'tasks',
      routeMethod: 'chat-core-v2-deterministic-read',
      confidence: 0.82,
      buttons: null,
      timestamp: '2026-05-24T12:34:56.000Z',
      metadata: {
        type: 'chat_core_v2_deterministic_read',
        chatCoreV2: {
          capabilityId: 'tasks.today_summary',
          capabilityIds: ['tasks.today_summary'],
          response: {
            schemaVersion: 'chat_response_v2@1.0.0',
            kind: 'message',
            locale: 'en',
            reasonCodes: ['deterministic_read', 'tasks.today_summary'],
          },
          readModel: {
            schemaVersion: 'chat_core_v2_read_model@1.0.0',
            capabilityId: 'tasks.today_summary',
            domain: 'tasks',
            data: result.readModel.data,
            sourceEntityIds: ['task:1'],
            freshness: result.readModel.freshness,
            sensitivity: 'personal',
          },
          readModels: [
            {
              schemaVersion: 'chat_core_v2_read_model@1.0.0',
              capabilityId: 'tasks.today_summary',
              domain: 'tasks',
              data: result.readModel.data,
              sourceEntityIds: ['task:1'],
              freshness: result.readModel.freshness,
              sensitivity: 'personal',
            },
          ],
          contextPack: {
            schemaVersion: 'chat_core_v2_read_context_pack@1.0.0',
            domains: ['tasks'],
            sourceEntityIds: ['task:1'],
            sourceVersions: { 'task:1': 'context-version' },
            generatedAt: '2026-05-24T12:34:56.000Z',
            contextHash: 'abc123def4567890',
            sensitivity: 'personal',
          },
        },
      },
    });
  });

  it('preserves multi-domain capability and read-model metadata for the iOS envelope', () => {
    const requestStartedAt = Date.parse('2026-05-24T12:34:56.000Z');
    const baseFreshness = {
      generatedAt: '2026-05-24T12:34:56.000Z',
      maxSourceAgeSeconds: 60,
      status: 'live' as const,
    };
    const result: ChatCoreV2DeterministicReadRouteResult = {
      capabilityId: 'tasks.today_summary',
      capabilityIds: ['tasks.today_summary', 'training.session_explain'],
      routeGuess: {
        intent: 'app_question',
        confidence: 0.82,
        domains: ['tasks', 'training'],
        capabilityIds: ['tasks.today_summary', 'training.session_explain'],
      },
      response: {
        schemaVersion: 'chat_response_v2@1.0.0',
        kind: 'message',
        locale: 'en',
        text: 'Tasks\nYou have no open tasks right now.\n\nTraining\nTraining plan: Base.',
        cards: [],
        reasonCodes: ['deterministic_read', 'multi_domain_read', 'tasks.today_summary', 'training.session_explain'],
      },
      readModel: {
        schemaVersion: 'chat_core_v2_read_model@1.0.0',
        capabilityId: 'tasks.today_summary',
        domain: 'tasks',
        data: { pendingCount: 0 },
        sourceEntityIds: [],
        sourceVersions: {},
        freshness: baseFreshness,
        sensitivity: 'personal',
        summary: 'You have no open tasks right now.',
        locale: 'en',
      },
      readModels: [
        {
          schemaVersion: 'chat_core_v2_read_model@1.0.0',
          capabilityId: 'tasks.today_summary',
          domain: 'tasks',
          data: { pendingCount: 0 },
          sourceEntityIds: [],
          sourceVersions: {},
          freshness: baseFreshness,
          sensitivity: 'personal',
          summary: 'You have no open tasks right now.',
          locale: 'en',
        },
        {
          schemaVersion: 'chat_core_v2_read_model@1.0.0',
          capabilityId: 'training.session_explain',
          domain: 'training',
          data: { hasActivePlan: true, planName: 'Base' },
          sourceEntityIds: ['training_plan:1'],
          sourceVersions: { 'training_plan:1': 'v1' },
          freshness: baseFreshness,
          sensitivity: 'health_adjacent',
          summary: 'Training plan: Base.',
          locale: 'en',
        },
      ],
      contextPack: {
        schemaVersion: 'chat_core_v2_read_context_pack@1.0.0',
        results: [],
        domains: ['tasks', 'training'],
        sourceEntityIds: ['training_plan:1'],
        sourceVersions: { 'training_plan:1': 'v1' },
        sensitivity: 'health_adjacent',
        generatedAt: '2026-05-24T12:34:56.000Z',
        contextHash: 'multi1234567890',
      },
    };

    const built = buildChatCoreV2DeterministicReadShortcutResponse({
      result,
      requestStartedAt,
    });

    expect(built.response.metadata.chatCoreV2.capabilityIds).toEqual([
      'tasks.today_summary',
      'training.session_explain',
    ]);
    expect(built.response.metadata.chatCoreV2.readModels).toHaveLength(2);
    expect(built.response.metadata.chatCoreV2.readModels.map((readModel) => readModel.domain)).toEqual([
      'tasks',
      'training',
    ]);
    expect(built.response.metadata.chatCoreV2.contextPack.domains).toEqual(['tasks', 'training']);
    expect(built.response.text).toContain('Tasks');
    expect(built.response.text).toContain('Training');
  });
});
