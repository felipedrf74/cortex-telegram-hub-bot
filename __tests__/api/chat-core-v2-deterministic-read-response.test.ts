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

    expect(built.conversationDomain).toBe('secretary');
    expect(built.logContext).toEqual({
      capabilityId: 'tasks.today_summary',
      contextHash: 'abc123def4567890',
    });
    expect(built.response).toMatchObject({
      id: `msg-${requestStartedAt}`,
      text: 'You have 2 open tasks.',
      domain: 'secretary',
      routeMethod: 'chat-core-v2-deterministic-read',
      confidence: 0.82,
      buttons: null,
      timestamp: '2026-05-24T12:34:56.000Z',
      metadata: {
        type: 'chat_core_v2_deterministic_read',
        chatCoreV2: {
          capabilityId: 'tasks.today_summary',
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
});
