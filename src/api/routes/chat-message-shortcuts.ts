// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { randomUUID } from 'crypto';

import type { RouteResult } from '../../router';
import type { DomainName } from '../../domains/types';
import { logger } from '../../utils/logger';
import {
  DEFAULT_SCRIPT_GENERATION_EXECUTION_POLICY,
  ForwardedContentPolicyError,
  ForwardedLocalInferenceError,
  getScript,
} from '../../services/content-engine';
import { completeOneShotWithFallback } from '../../services/gemini-provider';
import {
  parseContentScriptShortcut,
  parseContentCreativeShortcut,
  inspectContentCreativeShortcut,
  parseContentStateShortcut,
  parseFinanceStateShortcut,
  resolveContentShortcutLanguage,
  resolveFinanceShortcutLanguage,
  resolveRequestedScriptLanguage,
  type ContentCreativeShortcutCommand,
  type ContentCreativeShortcutValidationReason,
} from './chat-shortcut-parsers';
import {
  ContentCreativeProposalError,
  generateContentCreativeProposal,
  type ContentCreativeProposalResult,
} from '../../services/content-creative-proposals';
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
  runWithSkillInferenceAccountAdmission,
  SkillInferencePolicyError,
} from '../../services/skill-inference-service';
import {
  assertContentOutputLanguageFields,
  ContentOutputLanguageMismatchError,
} from '../../services/content-output-language';
import { getCurrentRequestId } from '../../utils/request-context';
import { ContentResearchPolicyError } from '../../services/content-research-generation-policy';
import { safeContentLogErrorFields } from '../../services/content-log-safety';

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

function buildCreativeShortcutText(result: ContentCreativeProposalResult, language: string): string {
  const pt = language.startsWith('pt');
  const proposal = result.proposal;
  let lines: string[];
  if ('hooks' in proposal) {
    lines = proposal.hooks.map((hook, index) => `${index + 1}. ${hook.text}`);
  } else if ('titles' in proposal) {
    lines = proposal.titles.map((title, index) => `${index + 1}. ${title.title}`);
  } else if ('concepts' in proposal) {
    lines = proposal.concepts.map((concept, index) => (
      `${index + 1}. ${concept.text_overlay.main_text} — ${concept.why_it_works}`
    ));
  } else if ('caption' in proposal) {
    lines = [proposal.caption, proposal.hashtags.map((tag) => `#${tag.replace(/^#/, '')}`).join(' ')];
  } else {
    lines = proposal.outputs.map((output, index) => (
      `${index + 1}. ${output.platform} · ${output.format}\n${output.content}`
    ));
  }
  const degradedNotice = result.degraded
    ? (pt
      ? 'Alternativa degradada: a saída do fornecedor não cumpriu o contrato completo. Revisão humana obrigatória.'
      : 'Degraded fallback: provider output did not meet the full contract. Human review is required.')
    : null;
  const warningLines = result.degraded
    ? result.warnings.map((warning) => `⚠ ${warning}`)
    : [];
  const reviewNotice = result.research.sourceContextUsed
    ? (pt
      ? 'Revisão humana obrigatória: as fontes apoiam o contexto de entrada, não verificam automaticamente o texto gerado.'
      : 'Human review required: sources support the input context; they do not automatically verify generated copy.')
    : (pt ? 'Proposta apenas; nada foi guardado ou publicado.' : 'Proposal only; nothing was saved or published.');
  return [degradedNotice, ...warningLines, ...lines, '', reviewNotice].filter((line): line is string => line != null)
    .join('\n')
    .slice(0, 12_000);
}

function creativeProposalCount(result: ContentCreativeProposalResult): number {
  const proposal = result.proposal;
  if ('hooks' in proposal) return proposal.hooks.length;
  if ('titles' in proposal) return proposal.titles.length;
  if ('concepts' in proposal) return proposal.concepts.length;
  if ('outputs' in proposal) return proposal.outputs.length;
  return 1;
}

function buildCreativeShortcutValidationText(
  reason: ContentCreativeShortcutValidationReason,
  command: ContentCreativeShortcutCommand,
  language: string,
): string {
  const subjectLimit = command === 'genthumbnail' ? '1,400' : '2,000';
  const detail = language === 'pt-PT'
    ? {
      message_too_long: 'O pedido completo não pode exceder 4 096 caracteres.',
      unsupported_control_character: 'O pedido contém um carácter de controlo não suportado.',
      subject_required: 'Indique um tema com, pelo menos, 3 caracteres.',
      single_line_required: 'Apenas /repurpose aceita várias linhas.',
      subject_too_long: `O tema de /${command} não pode exceder ${subjectLimit} caracteres.`,
    }[reason]
    : language === 'pt-BR'
      ? {
        message_too_long: 'A solicitação completa não pode exceder 4.096 caracteres.',
        unsupported_control_character: 'A solicitação contém um caractere de controle não permitido.',
        subject_required: 'Informe um assunto com pelo menos 3 caracteres.',
        single_line_required: 'Somente /repurpose aceita várias linhas.',
        subject_too_long: `O assunto de /${command} não pode exceder ${subjectLimit} caracteres.`,
      }[reason]
      : {
        message_too_long: 'The complete request cannot exceed 4,096 characters.',
        unsupported_control_character: 'The request contains an unsupported control character.',
        subject_required: 'Provide a subject with at least 3 characters.',
        single_line_required: 'Only /repurpose accepts multiple lines.',
        subject_too_long: `The /${command} subject cannot exceed ${subjectLimit} characters.`,
      }[reason];
  if (language === 'pt-PT') return `O comando criativo é inválido. ${detail} Nada foi gerado, guardado ou publicado.`;
  if (language === 'pt-BR') return `O comando criativo é inválido. ${detail} Nada foi gerado, salvo ou publicado.`;
  return `The creative command is invalid. ${detail} Nothing was generated, saved, or published.`;
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
  if (parseContentScriptShortcut(input.normalizedText)
      || parseContentCreativeShortcut(input.normalizedText)) return true;
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
  if (parseContentScriptShortcut(input.normalizedText)
      || parseContentCreativeShortcut(input.normalizedText)) {
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
  const creativeRequest = parseContentCreativeShortcut(input.normalizedText);
  const refinementRequest = input.activeContext?.domain === 'content'
    && isContentRefinementFollowUp(input.normalizedText)
    && Boolean(extractContentRefinementSourceText(input.activeContext.lastAssistantMessage));
  if (!scriptRequest && !creativeRequest && !refinementRequest) return null;
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

  const creativeShortcut = parseContentCreativeShortcut(normalizedText);
  if (creativeShortcut) {
    const requestedLanguage = resolveRequestedScriptLanguage(normalizedText, userLanguage);
    try {
      const result = await runWithSkillInferenceAccountAdmission({
        userId,
        abortSignal: input.abortSignal,
      }, async (abortSignal) => generateContentCreativeProposal({
        ...creativeShortcut,
        userId,
        tenantId,
        language: requestedLanguage,
        abortSignal,
      }));
      return buildShortcutResponse({
        text: buildCreativeShortcutText(result, requestedLanguage),
        domain: 'content',
        routeMethod: 'content-creative-proposal',
        confidence: route.confidence,
        metadata: {
          type: 'content_creative_proposal',
          operation: result.operation,
          proposalCount: creativeProposalCount(result),
          degraded: result.degraded,
          warnings: result.warnings,
          authority: result.authority,
          research: result.research,
          sourcePackage: result.sourcePackage,
        },
      });
    } catch (err) {
      if (err instanceof ContentCreativeProposalError) {
        if (err.code === 'CONTENT_CREATIVE_OUTPUT_UNAVAILABLE') {
          return buildShortcutResponse({
            text: err.message,
            domain: 'content',
            routeMethod: 'content-creative-proposal-unavailable',
            confidence: route.confidence,
            metadata: {
              type: 'content_creative_proposal_unavailable',
              operation: creativeShortcut.operation,
              degraded: true,
              warnings: Array.isArray(err.details?.warnings) ? err.details.warnings : [],
              authority: {
                status: 'unavailable',
                canonicalWorkspaceMutation: false,
                publicationExecution: 'not_performed',
              },
            },
          });
        }
        return buildShortcutResponse({
          text: err.message,
          domain: 'content',
          routeMethod: 'content-creative-proposal-blocked',
          confidence: route.confidence,
          metadata: {
            type: 'content_creative_proposal_blocked',
            operation: creativeShortcut.operation,
            code: err.code,
            authority: {
              status: 'blocked',
              canonicalWorkspaceMutation: false,
              publicationExecution: 'not_performed',
            },
          },
        });
      }
      rethrowAiUsageFailClosedError(err);
      if (input.abortSignal?.aborted
          || err instanceof SkillInferencePolicyError
          || err instanceof ForwardedContentPolicyError
          || err instanceof ForwardedLocalInferenceError) throw err;
      logger.warn({
        ...safeContentLogErrorFields(err),
        userId,
        operation: creativeShortcut.operation,
      }, 'Content creative shortcut failed');
      return buildShortcutResponse({
        text: requestedLanguage.startsWith('pt')
          ? 'A proposta criativa está temporariamente indisponível. Nenhuma proposta criativa foi guardada ou publicada.'
          : 'The creative proposal is temporarily unavailable. No creative proposal was saved or published.',
        domain: 'content',
        routeMethod: 'content-creative-proposal-unavailable',
        confidence: route.confidence,
        metadata: {
          type: 'content_creative_proposal_unavailable',
          operation: creativeShortcut.operation,
          degraded: true,
          authority: {
            canonicalWorkspaceMutation: false,
            publicationExecution: 'not_performed',
          },
        },
      });
    }
  }

  const scriptShortcut = parseContentScriptShortcut(normalizedText);
  if (scriptShortcut) {
    const requestedLanguage = resolveRequestedScriptLanguage(normalizedText, userLanguage);
    try {
      const brandVoice = getUserBrandVoiceForChatScript(userId, tenantId);
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
      if (err instanceof ContentResearchPolicyError) {
        const highRisk = err.code === 'CONTENT_HIGH_RISK_REVIEW_REQUIRED';
        return buildShortcutResponse({
          text: requestedLanguage.startsWith('pt')
            ? highRisk
              ? 'Este tema exige um pacote de fontes revisto por uma pessoa antes da geração. Essa autoridade de revisão ainda não é suportada.'
              : 'Não posso gerar conteúdo para esse pedido. Reformule com um objetivo seguro e legítimo.'
            : err.message,
          domain: 'content',
          routeMethod: 'content-script-blocked',
          confidence: route.confidence,
          metadata: {
            type: 'content_script_blocked',
            format: scriptShortcut.format,
            code: err.code,
            authority: {
              status: 'blocked',
              canonicalWorkspaceMutation: false,
              publicationExecution: 'not_performed',
            },
          },
        });
      }
      rethrowAiUsageFailClosedError(err);
      if (input.abortSignal?.aborted
          || err instanceof SkillInferencePolicyError
          || err instanceof ForwardedContentPolicyError
          || err instanceof ForwardedLocalInferenceError) throw err;
      logger.warn(
        {
          ...safeContentLogErrorFields(err),
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
            maxRetries: 0,
            userId,
            tenantId,
            abortSignal: input.abortSignal,
            allowFallbackAfterProviderFailure: false,
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
          || err instanceof ForwardedContentPolicyError
          || err instanceof ForwardedLocalInferenceError) throw err;
      logger.warn(
        {
          ...safeContentLogErrorFields(err),
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
  const creativeInspection = inspectContentCreativeShortcut(input.normalizedText);
  if (creativeInspection.status === 'invalid') {
    const requestedLanguage = resolveRequestedScriptLanguage(input.normalizedText, input.userLanguage);
    return buildShortcutResponse({
      text: buildCreativeShortcutValidationText(
        creativeInspection.reason,
        creativeInspection.command,
        requestedLanguage,
      ),
      domain: 'content',
      routeMethod: 'content-creative-command-validation',
      confidence: 1,
      metadata: {
        type: 'content_creative_command_validation',
        code: 'CONTENT_CREATIVE_SHORTCUT_VALIDATION_FAILED',
        command: `/${creativeInspection.command}`,
        reason: creativeInspection.reason,
        authority: {
          status: 'rejected',
          canonicalWorkspaceMutation: false,
          publicationExecution: 'not_performed',
        },
      },
    });
  }

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
