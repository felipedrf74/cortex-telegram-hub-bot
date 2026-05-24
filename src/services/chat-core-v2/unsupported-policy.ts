// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  buildChatCoreV2ClarificationResponse,
  buildChatCoreV2UnsupportedResponse,
  normalizeChatCoreV2Locale,
  type ChatCoreV2Locale,
  type ChatCoreV2Response,
  type ChatCoreV2ResponseKind,
} from './response-contracts';
import type {
  ChatCoreV2Domain,
  ChatCoreV2RouteMethod,
  UnsupportedReason,
} from './types';

export const CHAT_CORE_V2_UNSUPPORTED_POLICY_VERSION = 'chat_core_v2_unsupported_policy@1.0.0';

export const CHAT_CORE_V2_UNSUPPORTED_REASONS: readonly UnsupportedReason[] = [
  'not_built',
  'restricted_domain',
  'requires_external_auth',
  'unsafe_action',
  'ambiguous_scope',
  'too_large_batch',
  'manual_only',
];

export type ChatCoreV2UnsupportedSeverity = 'info' | 'warn' | 'block';

export interface ChatCoreV2UnsupportedPolicy {
  policyVersion: string;
  reason: UnsupportedReason;
  routeMethod: ChatCoreV2RouteMethod;
  responseKind: Extract<ChatCoreV2ResponseKind, 'unsupported' | 'clarification'>;
  severity: ChatCoreV2UnsupportedSeverity;
  blocksExecution: boolean;
  allowReadFallback: boolean;
  alternatives: Record<ChatCoreV2Locale, string>;
}

export interface BuildChatCoreV2UnsupportedResolutionInput {
  reason: UnsupportedReason;
  locale?: string | null;
  domain?: ChatCoreV2Domain;
  capabilityId?: string;
  question?: string;
  options?: string[];
}

export interface ChatCoreV2UnsupportedResolution {
  policyVersion: string;
  reason: UnsupportedReason;
  routeMethod: ChatCoreV2RouteMethod;
  responseKind: ChatCoreV2UnsupportedPolicy['responseKind'];
  severity: ChatCoreV2UnsupportedSeverity;
  blocksExecution: boolean;
  allowReadFallback: boolean;
  domain?: ChatCoreV2Domain;
  capabilityId?: string;
  supportedAlternative: string;
  response: ChatCoreV2Response;
}

const POLICIES: Record<UnsupportedReason, ChatCoreV2UnsupportedPolicy> = {
  not_built: policy({
    reason: 'not_built',
    routeMethod: 'unsupported',
    responseKind: 'unsupported',
    severity: 'info',
    blocksExecution: true,
    allowReadFallback: true,
    alternatives: {
      en: 'I can explain the steps or create a safer reminder instead.',
      'pt-PT': 'Posso explicar os passos ou criar um lembrete mais seguro.',
      'pt-BR': 'Posso explicar os passos ou criar um lembrete mais seguro.',
      es: 'Puedo explicar los pasos o crear un recordatorio más seguro.',
    },
  }),
  restricted_domain: policy({
    reason: 'restricted_domain',
    routeMethod: 'blocked',
    responseKind: 'unsupported',
    severity: 'block',
    blocksExecution: true,
    allowReadFallback: false,
    alternatives: {
      en: 'I can prepare a manual review note, but I will not execute this from chat.',
      'pt-PT': 'Posso preparar uma nota para revisão manual, mas não vou executar isto pelo chat.',
      'pt-BR': 'Posso preparar uma nota para revisão manual, mas não vou executar isso pelo chat.',
      es: 'Puedo preparar una nota para revisión manual, pero no lo ejecutaré desde el chat.',
    },
  }),
  requires_external_auth: policy({
    reason: 'requires_external_auth',
    routeMethod: 'blocked',
    responseKind: 'unsupported',
    severity: 'warn',
    blocksExecution: true,
    allowReadFallback: false,
    alternatives: {
      en: 'Reconnect the account first, then I can help with a read-only check.',
      'pt-PT': 'Volta a ligar a conta primeiro; depois posso ajudar com uma verificação sem alterações.',
      'pt-BR': 'Reconecte a conta primeiro; depois posso ajudar com uma verificação sem alterações.',
      es: 'Reconecta la cuenta primero; después puedo ayudarte con una revisión sin cambios.',
    },
  }),
  unsafe_action: policy({
    reason: 'unsafe_action',
    routeMethod: 'blocked',
    responseKind: 'unsupported',
    severity: 'block',
    blocksExecution: true,
    allowReadFallback: false,
    alternatives: {
      en: 'I can explain safer options, but I will not perform the unsafe action.',
      'pt-PT': 'Posso explicar opções mais seguras, mas não vou executar a ação insegura.',
      'pt-BR': 'Posso explicar opções mais seguras, mas não vou executar a ação insegura.',
      es: 'Puedo explicar opciones más seguras, pero no ejecutaré la acción insegura.',
    },
  }),
  ambiguous_scope: policy({
    reason: 'ambiguous_scope',
    routeMethod: 'needs_clarification',
    responseKind: 'clarification',
    severity: 'info',
    blocksExecution: true,
    allowReadFallback: true,
    alternatives: {
      en: 'Which item or date range do you mean?',
      'pt-PT': 'A que item ou intervalo de datas te referes?',
      'pt-BR': 'A qual item ou intervalo de datas você se refere?',
      es: '¿A qué elemento o rango de fechas te refieres?',
    },
  }),
  too_large_batch: policy({
    reason: 'too_large_batch',
    routeMethod: 'blocked',
    responseKind: 'unsupported',
    severity: 'warn',
    blocksExecution: true,
    allowReadFallback: false,
    alternatives: {
      en: 'Narrow the request and I can prepare an itemized preview.',
      'pt-PT': 'Reduz o pedido e posso preparar uma pré-visualização itemizada.',
      'pt-BR': 'Reduza o pedido e eu posso preparar uma prévia itemizada.',
      es: 'Reduce el alcance y puedo preparar una vista previa por elementos.',
    },
  }),
  manual_only: policy({
    reason: 'manual_only',
    routeMethod: 'blocked',
    responseKind: 'unsupported',
    severity: 'warn',
    blocksExecution: true,
    allowReadFallback: false,
    alternatives: {
      en: 'I can summarize what to review manually.',
      'pt-PT': 'Posso resumir o que deve ser revisto manualmente.',
      'pt-BR': 'Posso resumir o que deve ser revisado manualmente.',
      es: 'Puedo resumir lo que debe revisarse manualmente.',
    },
  }),
};

export function listChatCoreV2UnsupportedPolicies(): ChatCoreV2UnsupportedPolicy[] {
  return CHAT_CORE_V2_UNSUPPORTED_REASONS.map((reason) => clonePolicy(POLICIES[reason]));
}

export function getChatCoreV2UnsupportedPolicy(reason: UnsupportedReason): ChatCoreV2UnsupportedPolicy {
  return clonePolicy(POLICIES[reason]);
}

export function buildChatCoreV2UnsupportedResolution(
  input: BuildChatCoreV2UnsupportedResolutionInput,
): ChatCoreV2UnsupportedResolution {
  const policy = getChatCoreV2UnsupportedPolicy(input.reason);
  const locale = normalizeChatCoreV2Locale(input.locale);
  const supportedAlternative = policy.alternatives[locale];
  const response = policy.responseKind === 'clarification'
    ? buildChatCoreV2ClarificationResponse({
      question: input.question ?? supportedAlternative,
      locale,
      options: input.options,
      reasonCodes: [input.reason],
    })
    : buildChatCoreV2UnsupportedResponse({
      reason: input.reason,
      locale,
      supportedAlternative,
    });

  return {
    policyVersion: policy.policyVersion,
    reason: policy.reason,
    routeMethod: policy.routeMethod,
    responseKind: policy.responseKind,
    severity: policy.severity,
    blocksExecution: policy.blocksExecution,
    allowReadFallback: policy.allowReadFallback,
    domain: input.domain,
    capabilityId: input.capabilityId,
    supportedAlternative,
    response,
  };
}

function policy(input: Omit<ChatCoreV2UnsupportedPolicy, 'policyVersion'>): ChatCoreV2UnsupportedPolicy {
  return {
    policyVersion: CHAT_CORE_V2_UNSUPPORTED_POLICY_VERSION,
    ...input,
  };
}

function clonePolicy(policy: ChatCoreV2UnsupportedPolicy): ChatCoreV2UnsupportedPolicy {
  return {
    ...policy,
    alternatives: { ...policy.alternatives },
  };
}
