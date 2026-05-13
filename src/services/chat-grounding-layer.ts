// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { DomainName } from '../domains/types';
import type { RouteResult } from '../router';
import type { NexusChatOwnerSkill, NexusGroundingFact, NexusChatStaleness } from './chat-answer-contract';
import {
  resolveChatSkillCapability,
  type ChatSkillCapabilityResolution,
} from './chat-skill-capability-registry';

export interface ChatGroundingEnvelope {
  capability: ChatSkillCapabilityResolution;
  groundingFacts: NexusGroundingFact[];
  missingFacts: string[];
  staleness: NexusChatStaleness;
}

export function buildChatGroundingEnvelope(input: {
  message: string;
  userId: number;
  tenantId: number;
  route?: Pick<RouteResult, 'domain' | 'method' | 'confidence'>;
  routedDomain?: DomainName;
  activeContextDomain?: DomainName | null;
  involvedSkills?: string[];
  contextSources?: Array<{ source: string; freshness?: string; confidence?: number; reason?: string }>;
}): ChatGroundingEnvelope {
  const capability = resolveChatSkillCapability({
    message: input.message,
    routedDomain: input.routedDomain ?? input.route?.domain,
    involvedSkills: input.involvedSkills,
  });
  const facts: NexusGroundingFact[] = [
    safeFact({
      statement: 'Authenticated user and tenant scope are present for this chat turn.',
      source: 'auth.scope',
      field: 'userId,tenantId',
      freshness: 'fresh',
      confidence: 1,
    }),
    safeFact({
      statement: `${capability.capability.displayName} is the current owner skill for this response.`,
      source: 'chat.skill_capability_registry',
      field: 'ownerSkill',
      freshness: 'fresh',
      confidence: 0.9,
    }),
  ];

  if (input.route) {
    facts.push(safeFact({
      statement: `Router selected ${input.route.domain} with ${input.route.method}.`,
      source: 'chat.router',
      field: 'route',
      freshness: 'fresh',
      confidence: input.route.confidence,
    }));
  }

  if (input.activeContextDomain) {
    facts.push(safeFact({
      statement: `Recent chat context was in ${input.activeContextDomain}.`,
      source: 'chat.active_context',
      field: 'domain',
      freshness: 'recent',
      confidence: 0.65,
    }));
  }

  for (const source of input.contextSources ?? []) {
    facts.push(safeFact({
      statement: source.reason || `Context source ${source.source} was available.`,
      source: `chat.context.${source.source}`,
      field: 'context',
      freshness: normalizeFreshness(source.freshness),
      confidence: source.confidence ?? 0.6,
    }));
  }

  const missingFacts = inferMissingFacts(input.message, capability.ownerSkill, capability.intent, capability.capability.requiredFields);
  const staleness = facts.some((fact) => fact.freshness === 'stale')
    ? 'stale'
    : facts.some((fact) => fact.freshness === 'recent')
      ? 'recent'
      : 'fresh';

  return {
    capability,
    groundingFacts: facts,
    missingFacts,
    staleness,
  };
}

function inferMissingFacts(
  message: string,
  ownerSkill: NexusChatOwnerSkill,
  intent: string,
  requiredFields: string[],
): string[] {
  const text = message.toLowerCase();
  const missing = new Set<string>();
  const mutating = /\.(create|adjust|destructive)$/.test(intent);
  if (!mutating) return [];

  if (ownerSkill === 'secretary') {
    if (!hasDateSignal(text)) missing.add('date');
    if (!hasTimeSignal(text)) missing.add('time');
    if (!hasTitleSignal(text)) missing.add('title');
  } else {
    for (const field of requiredFields) {
      if (field.endsWith('Reference') && !/\b(this|that|current|today|tomorrow|este|esta|isso|hoje|amanh[aã])\b/.test(text)) {
        missing.add(field);
      }
    }
  }

  return [...missing];
}

function hasDateSignal(text: string): boolean {
  return /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|hoje|amanh[aã]|segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo|[0-3]?\d\/[0-1]?\d|[0-3]?\d-[0-1]?\d)\b/.test(text);
}

function hasTimeSignal(text: string): boolean {
  return /\b([01]?\d|2[0-3])(?::|h)[0-5]\d\b|\b([01]?\d|2[0-3])h\b|\b([01]?\d|2[0-3])\s?(am|pm)\b/i.test(text);
}

function hasTitleSignal(text: string): boolean {
  return /\b(title|called|named|atividade|evento|aula|meeting|reuni[aã]o|treino|consulta|volei|v[oó]lei)\b/.test(text)
    || text.trim().split(/\s+/).length >= 6;
}

function safeFact(input: {
  statement: string;
  source: string;
  field?: string;
  freshness: NexusChatStaleness;
  confidence: number;
}): NexusGroundingFact {
  return {
    statement: input.statement.slice(0, 240),
    source: input.source,
    ...(input.field ? { field: input.field } : {}),
    freshness: input.freshness,
    confidence: Math.max(0, Math.min(1, input.confidence)),
    safeForUser: true,
  };
}

function normalizeFreshness(value: string | undefined): NexusChatStaleness {
  if (value === 'fresh' || value === 'recent' || value === 'stale') return value;
  return 'unknown';
}
