// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ClassifierDisposition } from '../domains/types';
import type { NexusChatActionability } from './chat-answer-contract';
import type { ChatActionStatus } from './chat-response-sufficiency';

export interface ManifestClassifierTerminalResponse {
  disposition: ClassifierDisposition;
  text: string;
  domain: 'chat';
  routeMethod: 'routing-clarify' | 'unsupported';
  actionability: NexusChatActionability;
  actionStatus: ChatActionStatus;
  reasonCodes: string[];
  userActionRequired: true;
}

function isPortugueseLocale(locale: string): boolean {
  return locale.trim().toLowerCase().startsWith('pt');
}

/**
 * Turns a model's explicit abstention into a deterministic, non-executable
 * response shared by REST and WebSocket chat. Spanish is retired, so every
 * non-Portuguese locale receives the English compatibility response.
 */
export function buildManifestClassifierTerminalResponse(
  disposition: ClassifierDisposition,
  locale: string,
): ManifestClassifierTerminalResponse {
  const isPortuguese = isPortugueseLocale(locale);
  if (disposition === 'clarify') {
    return {
      disposition,
      text: isPortuguese
        ? 'Podes esclarecer o que queres que o Nexus faça?'
        : 'Could you clarify what you want Nexus to do?',
      domain: 'chat',
      routeMethod: 'routing-clarify',
      actionability: 'clarify',
      actionStatus: 'needs_clarification',
      reasonCodes: ['classifier_explicit_clarify'],
      userActionRequired: true,
    };
  }

  return {
    disposition,
    text: isPortuguese
      ? 'Ainda não consigo associar esse pedido a uma ação suportada pelo Nexus. Reformula-o como uma tarefa suportada.'
      : "I can't map that request to a supported Nexus action yet. Rephrase it as a supported task.",
    domain: 'chat',
    routeMethod: 'unsupported',
    actionability: 'blocked',
    actionStatus: 'blocked',
    reasonCodes: ['classifier_explicit_none'],
    userActionRequired: true,
  };
}
