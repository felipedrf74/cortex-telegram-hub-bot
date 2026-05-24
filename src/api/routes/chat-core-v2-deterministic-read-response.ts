// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ChatCoreV2DeterministicReadRouteResult } from '../../services/chat-core-v2';

export interface ChatCoreV2DeterministicReadShortcutResponse {
  id: string;
  text: string;
  domain: 'secretary';
  routeMethod: 'chat-core-v2-deterministic-read';
  confidence: number;
  buttons: null;
  metadata: {
    type: 'chat_core_v2_deterministic_read';
    chatCoreV2: {
      capabilityId: ChatCoreV2DeterministicReadRouteResult['capabilityId'];
      response: {
        schemaVersion: string;
        kind: string;
        locale: string;
        reasonCodes: string[];
      };
      routeGuess: ChatCoreV2DeterministicReadRouteResult['routeGuess'];
      readModel: {
        schemaVersion: string;
        capabilityId: string;
        domain: string;
        data: unknown;
        sourceEntityIds: string[];
        freshness: ChatCoreV2DeterministicReadRouteResult['readModel']['freshness'];
        sensitivity: ChatCoreV2DeterministicReadRouteResult['readModel']['sensitivity'];
      };
      contextPack: {
        schemaVersion: string;
        domains: string[];
        sourceEntityIds: string[];
        sourceVersions: Record<string, string>;
        generatedAt: string;
        contextHash: string;
        sensitivity: ChatCoreV2DeterministicReadRouteResult['contextPack']['sensitivity'];
      };
    };
  };
  timestamp: string;
}

export interface BuildChatCoreV2DeterministicReadShortcutResponseInput {
  result: ChatCoreV2DeterministicReadRouteResult;
  requestStartedAt: number;
}

export interface BuildChatCoreV2DeterministicReadShortcutResponseResult {
  conversationDomain: 'secretary';
  response: ChatCoreV2DeterministicReadShortcutResponse;
  logContext: {
    capabilityId: ChatCoreV2DeterministicReadRouteResult['capabilityId'];
    contextHash: string;
  };
}

export function buildChatCoreV2DeterministicReadShortcutResponse(
  input: BuildChatCoreV2DeterministicReadShortcutResponseInput,
): BuildChatCoreV2DeterministicReadShortcutResponseResult {
  const { result, requestStartedAt } = input;
  const conversationDomain = 'secretary';
  return {
    conversationDomain,
    response: {
      id: `msg-${requestStartedAt}`,
      text: result.response.text,
      domain: conversationDomain,
      routeMethod: 'chat-core-v2-deterministic-read',
      confidence: result.routeGuess.confidence,
      buttons: null,
      metadata: {
        type: 'chat_core_v2_deterministic_read',
        chatCoreV2: {
          capabilityId: result.capabilityId,
          response: {
            schemaVersion: result.response.schemaVersion,
            kind: result.response.kind,
            locale: result.response.locale,
            reasonCodes: result.response.reasonCodes,
          },
          routeGuess: result.routeGuess,
          readModel: {
            schemaVersion: result.readModel.schemaVersion,
            capabilityId: result.readModel.capabilityId,
            domain: result.readModel.domain,
            data: result.readModel.data,
            sourceEntityIds: result.readModel.sourceEntityIds,
            freshness: result.readModel.freshness,
            sensitivity: result.readModel.sensitivity,
          },
          contextPack: {
            schemaVersion: result.contextPack.schemaVersion,
            domains: result.contextPack.domains,
            sourceEntityIds: result.contextPack.sourceEntityIds,
            sourceVersions: result.contextPack.sourceVersions,
            generatedAt: result.contextPack.generatedAt,
            contextHash: result.contextPack.contextHash,
            sensitivity: result.contextPack.sensitivity,
          },
        },
      },
      timestamp: new Date(requestStartedAt).toISOString(),
    },
    logContext: {
      capabilityId: result.capabilityId,
      contextHash: result.contextPack.contextHash,
    },
  };
}
