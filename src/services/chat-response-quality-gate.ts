// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { NexusAnswerContract } from './chat-answer-contract';

export type ChatResponseQualityStatus = 'pass' | 'repaired' | 'blocked';

export interface ChatResponseQualityGateResult {
  status: ChatResponseQualityStatus;
  text: string;
  contract: NexusAnswerContract;
  issues: string[];
  score: number;
}

const RAW_DEBUG_PATTERNS = [
  /\bcalendar_busy_blocks\b/i,
  /\bsession_prescription\b/i,
  /\bfueling_gap_risk\b/i,
  /\bmp\d+\b/i,
  /\bprovider_failure:[a-z_]+\b/i,
  /\bCannot read properties of\b/i,
  /\bTypeError\b|\bReferenceError\b|\bSyntaxError\b/i,
  /\bstack trace\b/i,
  /<untrusted_tool_result>/i,
  /\{["']?(?:error|tool|provider|stack)["']?\s*:/i,
];

const SUCCESS_CLAIM_PATTERNS = [
  /\b(done|created|scheduled|booked|moved|updated|completed|sent)\b/i,
  /\b(pronto|criei|agendei|marquei|movi|atualizei|conclu[ií]|enviei)\b/i,
  /✅/,
];

export function applyChatResponseQualityGate(input: {
  text: string;
  contract: NexusAnswerContract;
}): ChatResponseQualityGateResult {
  const issues = detectChatResponseQualityIssues(input.text, input.contract);
  if (issues.length === 0) {
    return {
      status: 'pass',
      text: input.text,
      contract: input.contract,
      issues,
      score: 1,
    };
  }

  const sanitized = sanitizeUserFacingChatText(input.text);
  const hasFakeSuccess = issues.includes('unverified_success_claim');
  const hasUnsupportedSpecifics = issues.includes('unsupported_specific_state_claim');
  const contract: NexusAnswerContract = {
    ...input.contract,
    verificationStatus: hasFakeSuccess || hasUnsupportedSpecifics ? 'pending' : input.contract.verificationStatus,
    actionability: hasFakeSuccess || hasUnsupportedSpecifics ? 'clarify' : input.contract.actionability,
    missingFacts: [...new Set([
      ...input.contract.missingFacts,
      ...(hasFakeSuccess ? ['read_back_verification'] : []),
      ...(hasUnsupportedSpecifics ? ['scoped_state_read'] : []),
    ])],
    userFacingSummary: hasFakeSuccess || hasUnsupportedSpecifics
      ? 'Nexus needs fresher scoped state before making that claim.'
      : input.contract.userFacingSummary,
  };

  const repairedText = hasFakeSuccess
    ? 'I understood the request, but I cannot honestly mark it done until Nexus verifies the change. I did not claim success without a read-back.'
    : hasUnsupportedSpecifics
      ? 'I need a current scoped read before I can state those details confidently. Ask me to check the relevant Nexus section, and I will ground the answer first.'
    : sanitized;

  return {
    status: hasOnlyRepairableIssues(issues) ? 'repaired' : 'blocked',
    text: repairedText,
    contract,
    issues,
    score: Math.max(0, 1 - issues.length * 0.2),
  };
}

export function detectChatResponseQualityIssues(text: string, contract: NexusAnswerContract): string[] {
  const issues = new Set<string>();
  const trimmed = text.trim();

  if (!trimmed) issues.add('empty_response');
  if (RAW_DEBUG_PATTERNS.some((pattern) => pattern.test(trimmed))) issues.add('raw_internal_content');
  if (contract.actionability === 'execute'
    && SUCCESS_CLAIM_PATTERNS.some((pattern) => pattern.test(trimmed))
    && contract.verificationStatus !== 'verified'
    && contract.verificationStatus !== 'partial_failure') {
    issues.add('unverified_success_claim');
  }
  if (contract.actionability === 'answer_only'
    && !hasScopedStateGrounding(contract)
    && /\b(my|mine|today|this week|calendar|task|plan|meu|minha|hoje|esta semana|agenda|tarefa|plano)\b/i.test(trimmed)) {
    issues.add('state_claim_without_grounding');
  }
  if (contract.actionability === 'answer_only'
    && !hasScopedStateGrounding(contract)
    && hasConcreteStateSpecifics(trimmed)) {
    issues.add('unsupported_specific_state_claim');
  }
  if (/try again|tenta novamente|tentar novamente/i.test(trimmed)
    && contract.fallback.fallbackType !== 'none'
    && !contract.fallback.fallbackReason) {
    issues.add('generic_retry_without_reason');
  }

  return [...issues];
}

export function sanitizeUserFacingChatText(text: string): string {
  let sanitized = text;
  for (const pattern of RAW_DEBUG_PATTERNS) {
    sanitized = sanitized.replace(pattern, 'internal detail');
  }
  sanitized = sanitized.replace(/\s{3,}/g, ' ').trim();
  return sanitized || 'I could not produce a safe answer for that request.';
}

function hasOnlyRepairableIssues(issues: string[]): boolean {
  return issues.every((issue) => [
    'raw_internal_content',
    'unverified_success_claim',
    'generic_retry_without_reason',
    'state_claim_without_grounding',
    'unsupported_specific_state_claim',
  ].includes(issue));
}

function hasScopedStateGrounding(contract: NexusAnswerContract): boolean {
  return contract.groundingFacts.some((fact) => {
    if (!fact.safeForUser) return false;
    return ![
      'auth.scope',
      'chat.skill_capability_registry',
      'chat.router',
      'chat.active_context',
    ].includes(fact.source);
  });
}

function hasConcreteStateSpecifics(text: string): boolean {
  return /\b\d{1,2}[:h]\d{0,2}\b/.test(text)
    || /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/.test(text)
    || /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b/i.test(text)
    || /[$€£]\s?\d|\b\d+[,.]\d{2}\b/.test(text);
}
