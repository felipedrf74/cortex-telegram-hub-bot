// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { randomUUID } from 'crypto';

import type { RouteResult } from '../../router';
import type { DomainName } from '../../domains/types';
import { logger } from '../../utils/logger';
import {
  DEFAULT_SCRIPT_GENERATION_EXECUTION_POLICY,
  ForwardedLocalInferenceError,
  getScript,
} from '../../services/content-engine';
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
import { rethrowAiUsageFailClosedError } from '../../services/api-usage-fallback';
import { localPrimaryInferenceConfig } from '../../services/local-primary-config';
import { getLocalInferenceRuntimeControl } from '../../services/local-inference-runtime-control';
import {
  executeSkillInference,
  isLocalInferenceUserEnrolled,
  rejectSkillInferenceApplicationResult,
  SkillInferencePolicyError,
} from '../../services/skill-inference-service';
import {
  assertContentOutputLanguageFields,
  ContentOutputLanguageMismatchError,
} from '../../services/content-output-language';
import { getCurrentRequestId } from '../../utils/request-context';

export type ActiveChatContext = {
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

export type LocalPrimaryContentChatShortcutAdmission = 'content' | 'chat';

function buildChatWarningCode(code: 'content_engine_unavailable' | 'content_refine_unavailable'): string[] {
  return [code];
}

function isChatLocalPrimaryUserEnrolled(userId: number): boolean {
  if (!localPrimaryInferenceConfig.chatEnabled) return false;
  const control = getLocalInferenceRuntimeControl();
  return control.mode === 'active'
    || (control.mode === 'canary'
      && isLocalInferenceUserEnrolled(userId, control.rolloutPercent));
}

function isContentLocalPrimaryUserEnrolled(userId: number): boolean {
  if (!localPrimaryInferenceConfig.contentProxyEnabled) return false;
  const control = getLocalInferenceRuntimeControl();
  return control.mode === 'active'
    || (control.mode === 'canary'
      && isLocalInferenceUserEnrolled(userId, control.rolloutPercent));
}

export function isContentModelBackedChatShortcutRequest(input: {
  normalizedText: string;
  activeContext: ActiveChatContext;
}): boolean {
  if (parseContentScriptShortcut(input.normalizedText)) return true;
  return input.activeContext?.domain === 'content'
    && isContentRefinementFollowUp(input.normalizedText)
    && Boolean(extractContentRefinementSourceText(input.activeContext.lastAssistantMessage));
}

/**
 * Resolve early Content ownership without invoking a model or a tier gate.
 * A non-enrolled request remains entirely under the legacy route, preserving
 * its classifier, budget, trace, and response contracts.
 */
export function resolveLocalPrimaryContentChatShortcutAdmission(input: {
  normalizedText: string;
  activeContext: ActiveChatContext;
  userId: number;
}): LocalPrimaryContentChatShortcutAdmission | null {
  if (parseContentScriptShortcut(input.normalizedText)) {
    return isContentLocalPrimaryUserEnrolled(input.userId) ? 'content' : null;
  }
  const refinementRequest = input.activeContext?.domain === 'content'
    && isContentRefinementFollowUp(input.normalizedText)
    && Boolean(extractContentRefinementSourceText(input.activeContext.lastAssistantMessage));
  if (!refinementRequest) return null;
  return isChatLocalPrimaryUserEnrolled(input.userId) ? 'chat' : null;
}

/**
 * Own explicit script/refinement commands before the generic local Chat
 * answerer. The same existing shortcut contract remains the response owner;
 * this wrapper only avoids the legacy classifier/cloud-budget preflight when
 * the corresponding local-primary route is actually admitted.
 */
export async function tryBuildLocalPrimaryContentChatShortcutResponse(input: {
  normalizedText: string;
  userId: number;
  tenantId: number;
  userLanguage: string;
  activeContext: ActiveChatContext;
  abortSignal?: AbortSignal;
  localPrimaryAdmission?: LocalPrimaryContentChatShortcutAdmission;
}): Promise<ChatShortcutRouteResult | null> {
  const scriptRequest = parseContentScriptShortcut(input.normalizedText);
  const refinementRequest = input.activeContext?.domain === 'content'
    && isContentRefinementFollowUp(input.normalizedText)
    && Boolean(extractContentRefinementSourceText(input.activeContext.lastAssistantMessage));
  if (!scriptRequest && !refinementRequest) return null;
  const localPrimaryAdmission = input.localPrimaryAdmission
    ?? resolveLocalPrimaryContentChatShortcutAdmission(input);
  if (!localPrimaryAdmission) return null;
  return tryBuildContentShortcutResponse({
    ...input,
    localPrimaryAdmission,
    route: {
      domain: 'content',
      method: refinementRequest ? 'context' : 'pattern',
      confidence: 0.99,
      strippedMessage: input.normalizedText,
    },
  });
}

function buildShortcutResponse(input: {
  text: string;
  domain: DomainName;
  routeMethod: string;
  confidence: number;
  metadata: Record<string, unknown> | null;
}): ChatShortcutRouteResult {
  const response = {
    id: `msg-${randomUUID()}`,
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
  localPrimaryAdmission?: 'content' | 'chat';
  abortSignal?: AbortSignal;
}): Promise<ChatShortcutRouteResult | null> {
  const { route, normalizedText, userId, tenantId, userLanguage, activeContext } = input;
  const contentStateShortcut = parseContentStateShortcut(normalizedText);
  if (contentStateShortcut) {
    const requestedLanguage = resolveContentShortcutLanguage(normalizedText, userLanguage);
    const shortcut = await buildContentStateShortcutResponse(contentStateShortcut, userId, requestedLanguage, tenantId);
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
        undefined,
        undefined,
        'detailed',
        false,
        undefined,
        undefined,
        tenantId,
        undefined,
        DEFAULT_SCRIPT_GENERATION_EXECUTION_POLICY,
        {
          operationId: getCurrentRequestId() ?? randomUUID(),
          abortSignal: input.abortSignal,
          localPrimaryAdmitted: input.localPrimaryAdmission === 'content',
        },
      );

      return buildShortcutResponse({
        text: buildScriptShortcutText(scriptResult, requestedLanguage, scriptShortcut.format),
        domain: 'content',
        routeMethod: 'content-script',
        confidence: route.confidence,
        metadata: buildScriptShortcutMetadata(scriptResult, scriptShortcut.format),
      });
    } catch (err) {
      rethrowAiUsageFailClosedError(err);
      if (input.abortSignal?.aborted
          || err instanceof SkillInferencePolicyError
          || err instanceof ForwardedLocalInferenceError) throw err;
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
      const operationId = getCurrentRequestId() ?? randomUUID();
      const governedRunId = `content-refine:${randomUUID()}`;
      const systemPrompt = buildContentRefinementSystemPrompt(requestedLanguage);
      const userPrompt = buildContentRefinementUserPrompt(sourceText, normalizedText, requestedLanguage);
      const localRefinementEnrolled = input.localPrimaryAdmission === 'chat'
        || (input.localPrimaryAdmission === undefined && isChatLocalPrimaryUserEnrolled(userId));
      const completion = localRefinementEnrolled
        ? await executeSkillInference({
          tenantId,
          userId,
          skillId: 'content',
          taskType: 'content_chat_refine',
          riskClass: 'low',
          executionClass: 'interactive',
          operationId,
          runId: governedRunId,
          prompt: userPrompt,
          applicationGuidance: systemPrompt,
          schemaId: 'text',
          requestedOutputTokens: 1200,
          temperature: 0.5,
          containsPrivateData: true,
          allowCloudEscalation: false,
          redactionRequired: false,
          requestSource: 'interactive',
          budgetRequest: {
            userId,
            requestSource: 'interactive',
            baseCategory: 'content_chat_refine',
            jobName: 'content_chat_refine',
            runId: operationId,
          },
          cloudBudgetBoundary: async () => {
            throw new Error('Private Chat refinement is local-only after local admission');
          },
          abortSignal: input.abortSignal,
          deadlineMs: 45_000,
        })
        : await completeOneShotWithFallback(
          systemPrompt,
          userPrompt,
          'content_chat_refine',
          async () => {
            throw new Error('Anthropic fallback disabled');
          },
          {
            maxTokens: 1200,
            temperature: 0.5,
            userId,
            tenantId,
            abortSignal: input.abortSignal,
          },
        );
      const refinedText = completion.text.trim();
      try {
        if (localRefinementEnrolled) {
          assertContentOutputLanguageFields(requestedLanguage, [refinedText], 'content-chat-refine');
        }
      } catch (error) {
        if (error instanceof ContentOutputLanguageMismatchError) {
          rejectSkillInferenceApplicationResult({
            runId: governedRunId,
            tenantId,
            userId,
            reason: 'content_chat_refine_locale_mismatch',
          });
          throw error;
        }
        throw error;
      }

      return buildShortcutResponse({
        text: refinedText,
        domain: 'content',
        routeMethod: 'content-refine',
        confidence: route.confidence,
        metadata: {
          type: 'content_refine',
          sourceLength: sourceText.length,
          degraded: false,
          ...(localRefinementEnrolled ? {
            provider: completion.provider,
            route: 'local',
            localeFallbackApplied: false,
          } : {}),
        },
      });
    } catch (err) {
      rethrowAiUsageFailClosedError(err);
      if (input.abortSignal?.aborted
          || err instanceof SkillInferencePolicyError
          || err instanceof ForwardedLocalInferenceError) throw err;
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
  tenantId?: number;
  userLanguage: string;
}): ChatShortcutRouteResult | null {
  const { route, normalizedText, userId, tenantId, userLanguage } = input;
  const financeStateShortcut = parseFinanceStateShortcut(normalizedText);
  if (!financeStateShortcut) {
    return null;
  }

  const requestedLanguage = resolveFinanceShortcutLanguage(userLanguage);
  const shortcut = buildFinanceStateShortcutResponse(financeStateShortcut, userId, requestedLanguage, tenantId);
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
  tenantId: number;
  userLanguage: string;
}): Promise<ChatShortcutRouteResult | null> {
  const contentStateShortcut = parseContentStateShortcut(input.normalizedText);
  if (contentStateShortcut) {
    const requestedLanguage = resolveContentShortcutLanguage(input.normalizedText, input.userLanguage);
    const shortcut = await buildContentStateShortcutResponse(
      contentStateShortcut,
      input.userId,
      requestedLanguage,
      input.tenantId,
    );
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
  abortSignal?: AbortSignal;
}): Promise<ChatShortcutRouteResult | null> {
  if (input.route.domain === 'content') {
    return tryBuildContentShortcutResponse(input);
  }

  if (input.route.domain === 'finance') {
    return tryBuildFinanceShortcutResponse(input);
  }

  return null;
}
