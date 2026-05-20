// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { RouteResult } from '../../router';
import type { DomainName } from '../../domains/types';
import { logger } from '../../utils/logger';
import { getScript } from '../../services/content-engine';
import { completeOneShotWithFallback } from '../../services/gemini-provider';
import {
  parseContentScriptShortcut,
  parseContentStateShortcut,
  parseFinanceStateShortcut,
  resolveContentShortcutLanguage,
  resolveFinanceShortcutLanguage,
  resolveRequestedScriptLanguage,
} from './chat-shortcut-parsers';
import {
  buildContentRefinementSystemPrompt,
  buildContentRefinementUnavailableResponse,
  buildContentRefinementUserPrompt,
  buildHeuristicContentRefinementFallback,
  extractContentRefinementSourceText,
  isContentRefinementFollowUp,
} from './chat-content-refinement';
import {
  buildContentStateShortcutResponse,
  buildFinanceStateShortcutResponse,
} from './chat-state-shortcuts';
import {
  buildScriptShortcutMetadata,
  buildScriptShortcutText,
  buildScriptUnavailableResponse,
  getUserBrandVoiceForChatScript,
} from './chat-script-shortcut-response';

type ActiveChatContext = {
  domain: DomainName;
  lastAssistantMessage: string;
} | null;

export type ChatShortcutRouteResponse = {
  id: string;
  text: string;
  domain: DomainName;
  routeMethod: string;
  confidence: number;
  buttons: null;
  metadata: Record<string, unknown> | null;
  timestamp: string;
};

export type ChatShortcutRouteResult = {
  response: ChatShortcutRouteResponse;
  conversationDomain: DomainName;
};

function buildChatWarningCode(code: 'content_engine_unavailable' | 'content_refine_unavailable'): string[] {
  return [code];
}

function buildShortcutResponse(input: {
  text: string;
  domain: DomainName;
  routeMethod: string;
  confidence: number;
  metadata: Record<string, unknown> | null;
}): ChatShortcutRouteResult {
  const response = {
    id: `msg-${Date.now()}`,
    text: input.text,
    domain: input.domain,
    routeMethod: input.routeMethod,
    confidence: input.confidence,
    buttons: null,
    metadata: input.metadata,
    timestamp: new Date().toISOString(),
  };

  return {
    response,
    conversationDomain: input.domain,
  };
}

async function tryBuildContentShortcutResponse(input: {
  route: RouteResult;
  normalizedText: string;
  userId: number;
  tenantId: number;
  userLanguage: string;
  activeContext: ActiveChatContext;
}): Promise<ChatShortcutRouteResult | null> {
  const { route, normalizedText, userId, tenantId, userLanguage, activeContext } = input;
  const contentStateShortcut = parseContentStateShortcut(normalizedText);
  if (contentStateShortcut) {
    const requestedLanguage = resolveContentShortcutLanguage(normalizedText, userLanguage);
    const shortcut = await buildContentStateShortcutResponse(contentStateShortcut, userId, requestedLanguage);
    return buildShortcutResponse({
      text: shortcut.text,
      domain: 'content',
      routeMethod: 'content-intelligence-shortcut',
      confidence: route.confidence,
      metadata: shortcut.metadata,
    });
  }

  const scriptShortcut = parseContentScriptShortcut(normalizedText);
  if (scriptShortcut) {
    const requestedLanguage = resolveRequestedScriptLanguage(normalizedText, userLanguage);
    try {
      const brandVoice = getUserBrandVoiceForChatScript(userId);
      const scriptResult = await getScript(
        scriptShortcut.topic,
        'general',
        scriptShortcut.maxDurationMinutes,
        scriptShortcut.format,
        scriptShortcut.mode,
        brandVoice,
        requestedLanguage,
        'chat',
        userId,
      );

      return buildShortcutResponse({
        text: buildScriptShortcutText(scriptResult, requestedLanguage, scriptShortcut.format),
        domain: 'content',
        routeMethod: 'content-script',
        confidence: route.confidence,
        metadata: buildScriptShortcutMetadata(scriptResult, scriptShortcut.format),
      });
    } catch (err) {
      logger.warn(
        {
          err,
          userId,
          textLength: normalizedText.length,
          shortcutFormat: scriptShortcut.format,
          shortcutMode: scriptShortcut.mode,
        },
        'content-script shortcut failed — falling back to generic content handler',
      );
      return buildShortcutResponse({
        text: buildScriptUnavailableResponse(requestedLanguage),
        domain: 'content',
        routeMethod: 'content-script-unavailable',
        confidence: route.confidence,
        metadata: {
          type: 'content_script_unavailable',
          format: scriptShortcut.format,
          degraded: true,
          warnings: buildChatWarningCode('content_engine_unavailable'),
        },
      });
    }
  }

  if (route.method === 'context' && isContentRefinementFollowUp(normalizedText) && activeContext?.lastAssistantMessage) {
    const requestedLanguage = resolveRequestedScriptLanguage(normalizedText, userLanguage);
    const sourceText = extractContentRefinementSourceText(activeContext.lastAssistantMessage);
    try {
      const { text: refinedText } = await completeOneShotWithFallback(
        buildContentRefinementSystemPrompt(requestedLanguage),
        buildContentRefinementUserPrompt(sourceText, normalizedText, requestedLanguage),
        'content_chat_refine',
        async () => {
          throw new Error('Anthropic fallback disabled');
        },
        {
          maxTokens: 1200,
          temperature: 0.5,
          userId,
          tenantId,
        },
      );

      return buildShortcutResponse({
        text: refinedText.trim(),
        domain: 'content',
        routeMethod: 'content-refine',
        confidence: route.confidence,
        metadata: {
          type: 'content_refine',
          sourceLength: sourceText.length,
          degraded: false,
        },
      });
    } catch (err) {
      logger.warn(
        {
          err,
          userId,
          textLength: normalizedText.length,
          sourceLength: sourceText.length,
        },
        'content refine shortcut failed — returning degraded message',
      );
      const heuristicFallback = buildHeuristicContentRefinementFallback(sourceText, normalizedText, requestedLanguage);
      if (heuristicFallback) {
        return buildShortcutResponse({
          text: heuristicFallback,
          domain: 'content',
          routeMethod: 'content-refine-fallback',
          confidence: route.confidence,
          metadata: {
            type: 'content_refine_fallback',
            degraded: true,
            warnings: buildChatWarningCode('content_refine_unavailable'),
          },
        });
      }

      return buildShortcutResponse({
        text: buildContentRefinementUnavailableResponse(requestedLanguage),
        domain: 'content',
        routeMethod: 'content-refine-unavailable',
        confidence: route.confidence,
        metadata: {
          type: 'content_refine_unavailable',
          degraded: true,
          warnings: buildChatWarningCode('content_refine_unavailable'),
        },
      });
    }
  }

  return null;
}

function tryBuildFinanceShortcutResponse(input: {
  route: RouteResult;
  normalizedText: string;
  userId: number;
  userLanguage: string;
}): ChatShortcutRouteResult | null {
  const { route, normalizedText, userId, userLanguage } = input;
  const financeStateShortcut = parseFinanceStateShortcut(normalizedText);
  if (!financeStateShortcut) {
    return null;
  }

  const requestedLanguage = resolveFinanceShortcutLanguage(userLanguage);
  const shortcut = buildFinanceStateShortcutResponse(financeStateShortcut, userId, requestedLanguage);
  return buildShortcutResponse({
    text: shortcut.text,
    domain: 'finance',
    routeMethod: 'finance-state-shortcut',
    confidence: route.confidence,
    metadata: shortcut.metadata,
  });
}

export async function tryBuildTokenZeroChatMessageShortcutResponse(input: {
  normalizedText: string;
  userId: number;
  userLanguage: string;
}): Promise<ChatShortcutRouteResult | null> {
  const contentStateShortcut = parseContentStateShortcut(input.normalizedText);
  if (contentStateShortcut) {
    const requestedLanguage = resolveContentShortcutLanguage(input.normalizedText, input.userLanguage);
    const shortcut = await buildContentStateShortcutResponse(contentStateShortcut, input.userId, requestedLanguage);
    return buildShortcutResponse({
      text: shortcut.text,
      domain: 'content',
      routeMethod: 'content-intelligence-shortcut',
      confidence: 0.95,
      metadata: shortcut.metadata,
    });
  }

  const financeStateShortcut = parseFinanceStateShortcut(input.normalizedText);
  if (financeStateShortcut) {
    const requestedLanguage = resolveFinanceShortcutLanguage(input.userLanguage);
    const shortcut = buildFinanceStateShortcutResponse(financeStateShortcut, input.userId, requestedLanguage);
    return buildShortcutResponse({
      text: shortcut.text,
      domain: 'finance',
      routeMethod: 'finance-state-shortcut',
      confidence: 0.95,
      metadata: shortcut.metadata,
    });
  }

  return null;
}

export async function tryBuildChatMessageShortcutResponse(input: {
  route: RouteResult;
  normalizedText: string;
  userId: number;
  tenantId: number;
  userLanguage: string;
  activeContext: ActiveChatContext;
}): Promise<ChatShortcutRouteResult | null> {
  if (input.route.domain === 'content') {
    return tryBuildContentShortcutResponse(input);
  }

  if (input.route.domain === 'finance') {
    return tryBuildFinanceShortcutResponse(input);
  }

  return null;
}
