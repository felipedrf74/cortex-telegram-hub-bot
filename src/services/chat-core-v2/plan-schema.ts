// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ChatCoreV2Domain } from './types';

export const CHAT_TURN_PLAN_MICRO_SCHEMA_VERSION = 'chat_turn_plan_micro@1.0.0';
export const CHAT_TURN_PLAN_MICRO_PROMPT_VERSION = 'chat_turn_plan_micro_prompt@0.1.0';

export const CHAT_TURN_PLAN_MICRO_LIMITS = {
  maxDomains: 2,
  maxCapabilityIds: 3,
  maxRequiredReads: 3,
  maxProposedWrites: 1,
  maxClarificationOptions: 4,
  maxEvidenceClaimIds: 5,
} as const;

export const CHAT_TURN_PLAN_MICRO_ULTRA_COMPACT_OPTIONS = {
  numCtx: 512,
  numPredict: 180,
  temperature: 0,
} as const;

export type ChatTurnPlanMicroIntent =
  | 'answer'
  | 'read'
  | 'write_preview'
  | 'clarify'
  | 'unsupported'
  | 'escalate';

export type ChatTurnPlanMicroEscalationReason =
  | 'low_confidence'
  | 'multi_domain_complexity'
  | 'write_risk_class_c'
  | 'ambiguous_reference'
  | 'unresolved_context'
  | 'schema_repair_failed'
  | 'prompt_budget_overflow'
  | 'local_model_unavailable'
  | 'cloud_allowlist_candidate';

export const CHAT_TURN_PLAN_MICRO_DOMAIN_VALUES = [
  'secretary',
  'tasks',
  'training',
  'content',
  'cooking',
  'finance',
  'connections',
  'notifications',
  'decision_center',
] as const satisfies readonly ChatCoreV2Domain[];

export const CHAT_TURN_PLAN_MICRO_INTENT_VALUES = [
  'answer',
  'read',
  'write_preview',
  'clarify',
  'unsupported',
  'escalate',
] as const satisfies readonly ChatTurnPlanMicroIntent[];

export const CHAT_TURN_PLAN_MICRO_ESCALATION_REASON_VALUES = [
  'low_confidence',
  'multi_domain_complexity',
  'write_risk_class_c',
  'ambiguous_reference',
  'unresolved_context',
  'schema_repair_failed',
  'prompt_budget_overflow',
  'local_model_unavailable',
  'cloud_allowlist_candidate',
] as const satisfies readonly ChatTurnPlanMicroEscalationReason[];

export interface ChatTurnPlanMicroReadRequest {
  requestId: string;
  capabilityId: string;
  reason?: string;
}

export interface ChatTurnPlanMicroWriteRequest {
  requestId: string;
  capabilityId: string;
  riskClass: 'A' | 'B' | 'C';
  reason?: string;
}

export interface ChatTurnPlanMicroClarificationOption {
  id: string;
  label: string;
}

export interface ChatTurnPlanMicroClarification {
  question: string;
  options: ChatTurnPlanMicroClarificationOption[];
  expectsFreeText?: boolean;
}

export interface ChatTurnPlanMicro {
  schemaVersion: typeof CHAT_TURN_PLAN_MICRO_SCHEMA_VERSION;
  intent: ChatTurnPlanMicroIntent;
  domains: ChatCoreV2Domain[];
  capabilityIds: string[];
  requiredReads: ChatTurnPlanMicroReadRequest[];
  proposedWrites: ChatTurnPlanMicroWriteRequest[];
  clarification?: ChatTurnPlanMicroClarification;
  evidenceClaimIds: string[];
  confidence: number;
  complexityScore: number;
  escalationReasons: ChatTurnPlanMicroEscalationReason[];
  contextHash: string;
  promptVersion: string;
}

export type ChatTurnPlanMicroValidationIssueCode =
  | 'not_object'
  | 'unknown_property'
  | 'missing_required'
  | 'invalid_literal'
  | 'invalid_enum'
  | 'invalid_string'
  | 'invalid_boolean'
  | 'invalid_number'
  | 'invalid_array'
  | 'too_many_items'
  | 'context_hash_mismatch'
  | 'invalid_json';

export interface ChatTurnPlanMicroValidationIssue {
  code: ChatTurnPlanMicroValidationIssueCode;
  path: string;
  message: string;
}

export interface ChatTurnPlanMicroValidationResult {
  ok: boolean;
  plan?: ChatTurnPlanMicro;
  issues: ChatTurnPlanMicroValidationIssue[];
}

export interface UltraCompactPlannerPacketInput {
  locale: string;
  candidateCapabilityIds: string[];
  riskSignals?: string[];
  messageSummary: string;
  contextHash: string;
}

export interface UltraCompactPlannerPacket {
  locale: string;
  candidates: string[];
  risk: string[];
  msg: string;
  contextHash: string;
}

const DOMAIN_VALUES: ReadonlySet<ChatCoreV2Domain> = new Set(CHAT_TURN_PLAN_MICRO_DOMAIN_VALUES);

const INTENT_VALUES: ReadonlySet<ChatTurnPlanMicroIntent> = new Set(CHAT_TURN_PLAN_MICRO_INTENT_VALUES);

const ESCALATION_REASON_VALUES: ReadonlySet<ChatTurnPlanMicroEscalationReason> = new Set(
  CHAT_TURN_PLAN_MICRO_ESCALATION_REASON_VALUES,
);

const TOP_LEVEL_KEYS = new Set([
  'schemaVersion',
  'intent',
  'domains',
  'capabilityIds',
  'requiredReads',
  'proposedWrites',
  'clarification',
  'evidenceClaimIds',
  'confidence',
  'complexityScore',
  'escalationReasons',
  'contextHash',
  'promptVersion',
]);

const REQUIRED_TOP_LEVEL_KEYS = [
  'schemaVersion',
  'intent',
  'domains',
  'capabilityIds',
  'requiredReads',
  'proposedWrites',
  'evidenceClaimIds',
  'confidence',
  'complexityScore',
  'escalationReasons',
  'contextHash',
  'promptVersion',
] as const;

export const CHAT_TURN_PLAN_MICRO_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: REQUIRED_TOP_LEVEL_KEYS,
  properties: {
    schemaVersion: { type: 'string', enum: [CHAT_TURN_PLAN_MICRO_SCHEMA_VERSION] },
    intent: { type: 'string', enum: CHAT_TURN_PLAN_MICRO_INTENT_VALUES },
    domains: {
      type: 'array',
      maxItems: CHAT_TURN_PLAN_MICRO_LIMITS.maxDomains,
      items: { type: 'string', enum: CHAT_TURN_PLAN_MICRO_DOMAIN_VALUES },
    },
    capabilityIds: {
      type: 'array',
      maxItems: CHAT_TURN_PLAN_MICRO_LIMITS.maxCapabilityIds,
      items: { type: 'string', minLength: 1 },
    },
    requiredReads: {
      type: 'array',
      maxItems: CHAT_TURN_PLAN_MICRO_LIMITS.maxRequiredReads,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['requestId', 'capabilityId'],
        properties: {
          requestId: { type: 'string', minLength: 1 },
          capabilityId: { type: 'string', minLength: 1 },
          reason: { type: 'string', minLength: 1 },
        },
      },
    },
    proposedWrites: {
      type: 'array',
      maxItems: CHAT_TURN_PLAN_MICRO_LIMITS.maxProposedWrites,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['requestId', 'capabilityId', 'riskClass'],
        properties: {
          requestId: { type: 'string', minLength: 1 },
          capabilityId: { type: 'string', minLength: 1 },
          riskClass: { type: 'string', enum: ['A', 'B', 'C'] },
          reason: { type: 'string', minLength: 1 },
        },
      },
    },
    clarification: {
      type: 'object',
      additionalProperties: false,
      required: ['question', 'options'],
      properties: {
        question: { type: 'string', minLength: 1 },
        options: {
          type: 'array',
          maxItems: CHAT_TURN_PLAN_MICRO_LIMITS.maxClarificationOptions,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'label'],
            properties: {
              id: { type: 'string', minLength: 1 },
              label: { type: 'string', minLength: 1 },
            },
          },
        },
        expectsFreeText: { type: 'boolean' },
      },
    },
    evidenceClaimIds: {
      type: 'array',
      maxItems: CHAT_TURN_PLAN_MICRO_LIMITS.maxEvidenceClaimIds,
      items: { type: 'string', minLength: 1 },
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    complexityScore: { type: 'number', minimum: 0, maximum: 1 },
    escalationReasons: {
      type: 'array',
      items: { type: 'string', enum: CHAT_TURN_PLAN_MICRO_ESCALATION_REASON_VALUES },
    },
    contextHash: { type: 'string', minLength: 1 },
    promptVersion: { type: 'string', enum: [CHAT_TURN_PLAN_MICRO_PROMPT_VERSION] },
  },
} as const;

export const CHAT_TURN_PLAN_MICRO_WIRE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['v', 'i', 'cf', 'x'],
  properties: {
    v: { type: 'integer', enum: [1] },
    i: { type: 'string', enum: ['a', 'r', 'w', 'c', 'u', 'e'] },
    d: {
      type: 'array',
      maxItems: CHAT_TURN_PLAN_MICRO_LIMITS.maxDomains,
      items: { type: 'string', enum: CHAT_TURN_PLAN_MICRO_DOMAIN_VALUES },
    },
    c: {
      type: 'array',
      maxItems: CHAT_TURN_PLAN_MICRO_LIMITS.maxCapabilityIds,
      items: { type: 'integer', minimum: 0, maximum: 7 },
    },
    r: {
      type: 'array',
      maxItems: CHAT_TURN_PLAN_MICRO_LIMITS.maxRequiredReads,
      items: { type: 'integer', minimum: 0, maximum: 7 },
    },
    w: {
      type: 'array',
      maxItems: CHAT_TURN_PLAN_MICRO_LIMITS.maxProposedWrites,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['c', 'k'],
        properties: {
          c: { type: 'integer', minimum: 0, maximum: 7 },
          k: { type: 'string', enum: ['A', 'B', 'C'] },
        },
      },
    },
    q: { type: 'string', minLength: 1 },
    o: {
      type: 'array',
      maxItems: CHAT_TURN_PLAN_MICRO_LIMITS.maxClarificationOptions,
      items: { type: 'string', minLength: 1 },
    },
    cf: { type: 'number', minimum: 0, maximum: 1 },
    x: { type: 'number', minimum: 0, maximum: 1 },
    er: {
      type: 'array',
      items: { type: 'string', enum: CHAT_TURN_PLAN_MICRO_ESCALATION_REASON_VALUES },
    },
    h: { type: 'string', minLength: 1 },
  },
} as const;

/**
 * The wire-mode planner system prompt validated by the D3 calibration harness.
 *
 * HONESTY (sampling caveat): the calibration's "0 schema failures" figure was
 * measured under a DETERMINISTIC benchmark regime (seed=42, no top_p/top_k). The
 * runtime planner path (ollama-provider `dispatchLocalReasoning`) samples
 * stochastically (top_p/top_k, no seed), so the production schema-valid RATE is
 * not guaranteed to be that benchmark number. That is by design: the shadow path
 * is observe-only precisely so the LIVE shadow schema-valid rate (recorded via
 * the shadow_planner spans + schema-compliance counter) is the AUTHORITATIVE
 * gate signal — not the seeded benchmark figure. Ollama `format=` still enforces
 * the wire shape on every response regardless of sampling.
 *
 * This is STATIC INSTRUCTION TEXT ONLY — it contains no user data, no message
 * text, no tenant/user identifiers, and no packet contents. It is paired with
 * Ollama `format=CHAT_TURN_PLAN_MICRO_WIRE_JSON_SCHEMA` so the model emits the
 * tiny WIRE JSON shape, which parseAndValidateChatTurnPlanMicroWireJson then
 * auto-expands into a canonical ChatTurnPlanMicro against the bound packet.
 *
 * Single source of truth: the benchmark harness
 * (scripts/llm/chatcore-v2-planner-benchmark.ts) imports this so the production
 * planner and the calibration benchmark share byte-identical instruction text.
 */
export function buildChatCoreV2WirePlannerSystemPrompt(): string {
  return [
    'Return compact JSON only.',
    'Intent code i: a=answer r=read w=write_preview c=clarify u=unsupported e=escalate.',
    'Use c/r as 0-based indexes into candidates; w as [{"c":index,"k":"A"}].',
    'Omit empty c/r/w arrays.',
    'If msg asks status/today/what, use i=r and omit w.',
    'Never set w unless msg asks create/mark/move/delete.',
    'Use cf/x decimals 0.0..1.0.',
    'No prose.',
  ].join(' ');
}

export const CHAT_TURN_PLAN_MICRO_MINI_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['i', 'c', 's'],
  properties: {
    i: { type: 'string', enum: ['a', 'r', 'w', 'c', 'u', 'e'] },
    c: { type: 'string', pattern: '^[0-7]{0,3}$' },
    r: { type: 'string', pattern: '^[0-7]{0,3}$' },
    w: { type: 'string', pattern: '^[0-7][ABC]$' },
    q: { type: 'string', minLength: 1 },
    o: {
      type: 'array',
      maxItems: CHAT_TURN_PLAN_MICRO_LIMITS.maxClarificationOptions,
      items: { type: 'string', minLength: 1 },
    },
    s: { type: 'string', pattern: '^[0-9]{2}$' },
  },
} as const;

export const CHAT_TURN_PLAN_MICRO_ATOM_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['p'],
  properties: {
    p: {
      type: 'string',
      pattern: '^([arcue][0-7_][0-9][0-9]|w[0-7_][ABC][0-9][0-9])$',
    },
  },
} as const;

export function parseAndValidateChatTurnPlanMicroJson(
  raw: string,
  expectedContextHash?: string,
): ChatTurnPlanMicroValidationResult {
  try {
    return validateChatTurnPlanMicro(JSON.parse(raw), expectedContextHash);
  } catch (err) {
    return fail('invalid_json', '$', err instanceof Error ? err.message : String(err));
  }
}

export function parseAndValidateChatTurnPlanMicroWireJson(
  raw: string,
  packet: UltraCompactPlannerPacket,
): ChatTurnPlanMicroValidationResult {
  try {
    const wire = JSON.parse(raw);
    const expanded = expandChatTurnPlanMicroWire(wire, packet);
    if (!expanded.ok) return expanded;
    return validateChatTurnPlanMicro(expanded.plan, packet.contextHash);
  } catch (err) {
    return fail('invalid_json', '$', err instanceof Error ? err.message : String(err));
  }
}

export function parseAndValidateChatTurnPlanMicroMiniJson(
  raw: string,
  packet: UltraCompactPlannerPacket,
): ChatTurnPlanMicroValidationResult {
  try {
    const mini = JSON.parse(raw);
    const expanded = expandChatTurnPlanMicroMini(mini, packet);
    if (!expanded.ok) return expanded;
    return validateChatTurnPlanMicro(expanded.plan, packet.contextHash);
  } catch (err) {
    return fail('invalid_json', '$', err instanceof Error ? err.message : String(err));
  }
}

export function parseAndValidateChatTurnPlanMicroAtomJson(
  raw: string,
  packet: UltraCompactPlannerPacket,
): ChatTurnPlanMicroValidationResult {
  try {
    const atom = JSON.parse(raw);
    const expanded = expandChatTurnPlanMicroAtom(atom, packet);
    if (!expanded.ok) return expanded;
    return validateChatTurnPlanMicro(expanded.plan, packet.contextHash);
  } catch (err) {
    return fail('invalid_json', '$', err instanceof Error ? err.message : String(err));
  }
}

export function validateChatTurnPlanMicro(
  value: unknown,
  expectedContextHash?: string,
): ChatTurnPlanMicroValidationResult {
  const issues: ChatTurnPlanMicroValidationIssue[] = [];
  if (!isRecord(value)) return fail('not_object', '$', 'Plan must be an object');

  for (const key of Object.keys(value)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      issues.push(issue('unknown_property', `$.${key}`, `Unknown property: ${key}`));
    }
  }
  for (const key of REQUIRED_TOP_LEVEL_KEYS) {
    if (!(key in value)) issues.push(issue('missing_required', `$.${key}`, `${key} is required`));
  }

  const schemaVersion = requireLiteral(
    value.schemaVersion,
    CHAT_TURN_PLAN_MICRO_SCHEMA_VERSION,
    '$.schemaVersion',
    issues,
  );
  const intent = requireEnum(value.intent, INTENT_VALUES, '$.intent', issues);
  const domains = requireEnumArray(value.domains, DOMAIN_VALUES, '$.domains', CHAT_TURN_PLAN_MICRO_LIMITS.maxDomains, issues);
  const capabilityIds = requireStringArray(
    value.capabilityIds,
    '$.capabilityIds',
    CHAT_TURN_PLAN_MICRO_LIMITS.maxCapabilityIds,
    issues,
  );
  const requiredReads = requireReadRequests(value.requiredReads, issues);
  const proposedWrites = requireWriteRequests(value.proposedWrites, issues);
  const clarification = value.clarification === undefined
    ? undefined
    : requireClarification(value.clarification, issues);
  const evidenceClaimIds = requireStringArray(
    value.evidenceClaimIds,
    '$.evidenceClaimIds',
    CHAT_TURN_PLAN_MICRO_LIMITS.maxEvidenceClaimIds,
    issues,
  );
  const confidence = requireUnitNumber(value.confidence, '$.confidence', issues);
  const complexityScore = requireUnitNumber(value.complexityScore, '$.complexityScore', issues);
  const escalationReasons = requireEnumArray(
    value.escalationReasons,
    ESCALATION_REASON_VALUES,
    '$.escalationReasons',
    Number.POSITIVE_INFINITY,
    issues,
  );
  const contextHash = requireNonEmptyString(value.contextHash, '$.contextHash', issues);
  const promptVersion = requireNonEmptyString(value.promptVersion, '$.promptVersion', issues);

  if (expectedContextHash && contextHash && contextHash !== expectedContextHash) {
    issues.push(issue(
      'context_hash_mismatch',
      '$.contextHash',
      `Plan contextHash ${contextHash} does not match expected contextHash ${expectedContextHash}`,
    ));
  }

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    issues: [],
    plan: {
      schemaVersion: schemaVersion as typeof CHAT_TURN_PLAN_MICRO_SCHEMA_VERSION,
      intent: intent as ChatTurnPlanMicroIntent,
      domains: domains as ChatCoreV2Domain[],
      capabilityIds,
      requiredReads,
      proposedWrites,
      clarification,
      evidenceClaimIds,
      confidence,
      complexityScore,
      escalationReasons: escalationReasons as ChatTurnPlanMicroEscalationReason[],
      contextHash,
      promptVersion,
    },
  };
}

function expandChatTurnPlanMicroWire(
  value: unknown,
  packet: UltraCompactPlannerPacket,
): ChatTurnPlanMicroValidationResult {
  const issues: ChatTurnPlanMicroValidationIssue[] = [];
  if (!isRecord(value)) return fail('not_object', '$', 'Wire plan must be an object');
  rejectUnknownKeys(value, ['v', 'i', 'd', 'c', 'r', 'w', 'q', 'o', 'cf', 'x', 'er', 'h'], '$', issues);
  if (value.v !== 1) issues.push(issue('invalid_literal', '$.v', '$.v must be 1'));

  const intent = expandWireIntent(value.i, issues);
  const capabilityIds = value.c === undefined
    ? []
    : requireCandidateIndexes(value.c, '$.c', CHAT_TURN_PLAN_MICRO_LIMITS.maxCapabilityIds, packet, issues);
  const requiredReadCapabilityIds = value.r === undefined
    ? (intent === 'read' ? capabilityIds.slice(0, CHAT_TURN_PLAN_MICRO_LIMITS.maxRequiredReads) : [])
    : requireCandidateIndexes(value.r, '$.r', CHAT_TURN_PLAN_MICRO_LIMITS.maxRequiredReads, packet, issues);
  const proposedWrites = value.w === undefined ? [] : requireWireWrites(value.w, packet, issues);
  const inferredDomains = inferDomainsFromCapabilities([
    ...capabilityIds,
    ...requiredReadCapabilityIds,
    ...proposedWrites.map((write) => write.capabilityId),
  ]);
  const domains = value.d === undefined
    ? inferredDomains
    : requireEnumArray(value.d, DOMAIN_VALUES, '$.d', CHAT_TURN_PLAN_MICRO_LIMITS.maxDomains, issues);
  const confidence = requireUnitNumber(value.cf, '$.cf', issues);
  const complexityScore = requireUnitNumber(value.x, '$.x', issues);
  const escalationReasons = value.er === undefined
    ? []
    : requireEnumArray(value.er, ESCALATION_REASON_VALUES, '$.er', Number.POSITIVE_INFINITY, issues);
  const contextHash = value.h === undefined
    ? packet.contextHash
    : requireNonEmptyString(value.h, '$.h', issues);
  const clarification = expandWireClarification(value.q, value.o, issues);

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    issues: [],
    plan: {
      schemaVersion: CHAT_TURN_PLAN_MICRO_SCHEMA_VERSION,
      intent,
      domains,
      capabilityIds,
      requiredReads: requiredReadCapabilityIds.map((capabilityId, index) => ({
        requestId: `r${index + 1}`,
        capabilityId,
      })),
      proposedWrites,
      clarification,
      evidenceClaimIds: [],
      confidence,
      complexityScore,
      escalationReasons,
      contextHash,
      promptVersion: CHAT_TURN_PLAN_MICRO_PROMPT_VERSION,
    },
  };
}

function expandChatTurnPlanMicroMini(
  value: unknown,
  packet: UltraCompactPlannerPacket,
): ChatTurnPlanMicroValidationResult {
  const issues: ChatTurnPlanMicroValidationIssue[] = [];
  if (!isRecord(value)) return fail('not_object', '$', 'Mini plan must be an object');
  rejectUnknownKeys(value, ['i', 'c', 'r', 'w', 'q', 'o', 's'], '$', issues);

  const intent = expandWireIntent(value.i, issues);
  if (!('c' in value)) issues.push(issue('missing_required', '$.c', '$.c is required; use empty string when no capability applies'));
  const capabilityIds = requireMiniCandidateIndexes(
    value.c ?? '',
    '$.c',
    CHAT_TURN_PLAN_MICRO_LIMITS.maxCapabilityIds,
    packet,
    issues,
  );
  const requiredReadCapabilityIds = value.r === undefined
    ? (intent === 'read' ? capabilityIds.slice(0, CHAT_TURN_PLAN_MICRO_LIMITS.maxRequiredReads) : [])
    : requireMiniCandidateIndexes(value.r, '$.r', CHAT_TURN_PLAN_MICRO_LIMITS.maxRequiredReads, packet, issues);
  const proposedWrites = value.w === undefined ? [] : requireMiniWrite(value.w, packet, issues);
  const scores = requireMiniScores(value.s, issues);
  const clarification = expandWireClarification(value.q, value.o, issues);
  const inferredDomains = inferDomainsFromCapabilities([
    ...capabilityIds,
    ...requiredReadCapabilityIds,
    ...proposedWrites.map((write) => write.capabilityId),
  ]);

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    issues: [],
    plan: {
      schemaVersion: CHAT_TURN_PLAN_MICRO_SCHEMA_VERSION,
      intent,
      domains: inferredDomains,
      capabilityIds,
      requiredReads: requiredReadCapabilityIds.map((capabilityId, index) => ({
        requestId: `r${index + 1}`,
        capabilityId,
      })),
      proposedWrites,
      clarification,
      evidenceClaimIds: [],
      confidence: scores.confidence,
      complexityScore: scores.complexityScore,
      escalationReasons: [],
      contextHash: packet.contextHash,
      promptVersion: CHAT_TURN_PLAN_MICRO_PROMPT_VERSION,
    },
  };
}

function expandChatTurnPlanMicroAtom(
  value: unknown,
  packet: UltraCompactPlannerPacket,
): ChatTurnPlanMicroValidationResult {
  const issues: ChatTurnPlanMicroValidationIssue[] = [];
  if (!isRecord(value)) return fail('not_object', '$', 'Atom plan must be an object');
  rejectUnknownKeys(value, ['p'], '$', issues);
  const atom = requireNonEmptyString(value.p, '$.p', issues);
  const match = atom.match(/^([arcue])([0-7_])([0-9])([0-9])$/)
    ?? atom.match(/^(w)([0-7_])([ABC])([0-9])([0-9])$/);
  if (!match) {
    issues.push(issue('invalid_string', '$.p', '$.p must be compact atom form like r191 or w0A91'));
    return { ok: false, issues };
  }

  const intentCode = match[1];
  const candidateToken = match[2];
  const riskClass = intentCode === 'w' ? match[3] as 'A' | 'B' | 'C' : undefined;
  const confidenceDigit = intentCode === 'w' ? match[4] : match[3];
  const complexityDigit = intentCode === 'w' ? match[5] : match[4];
  const intent = expandWireIntent(intentCode, issues);
  const capabilityIds = candidateToken === '_'
    ? []
    : requireMiniCandidateIndexes(candidateToken, '$.p[1]', 1, packet, issues);
  const proposedWrites = intent === 'write_preview' && capabilityIds[0]
    ? [{
        requestId: 'w1',
        capabilityId: capabilityIds[0],
        riskClass: riskClass ?? 'C',
      }]
    : [];
  const requiredReadCapabilityIds = intent === 'read'
    ? capabilityIds.slice(0, CHAT_TURN_PLAN_MICRO_LIMITS.maxRequiredReads)
    : [];
  const inferredDomains = inferDomainsFromCapabilities([
    ...capabilityIds,
    ...requiredReadCapabilityIds,
    ...proposedWrites.map((write) => write.capabilityId),
  ]);

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    issues: [],
    plan: {
      schemaVersion: CHAT_TURN_PLAN_MICRO_SCHEMA_VERSION,
      intent,
      domains: inferredDomains,
      capabilityIds,
      requiredReads: requiredReadCapabilityIds.map((capabilityId, index) => ({
        requestId: `r${index + 1}`,
        capabilityId,
      })),
      proposedWrites,
      clarification: undefined,
      evidenceClaimIds: [],
      confidence: Number(confidenceDigit) / 10,
      complexityScore: Number(complexityDigit) / 10,
      escalationReasons: [],
      contextHash: packet.contextHash,
      promptVersion: CHAT_TURN_PLAN_MICRO_PROMPT_VERSION,
    },
  };
}

function inferDomainsFromCapabilities(capabilityIds: string[]): ChatCoreV2Domain[] {
  const domains = new Set<ChatCoreV2Domain>();
  for (const capabilityId of capabilityIds) {
    const prefix = capabilityId.split('.')[0];
    if (DOMAIN_VALUES.has(prefix as ChatCoreV2Domain)) {
      domains.add(prefix as ChatCoreV2Domain);
    } else if (prefix === 'task') {
      domains.add('tasks');
    } else if (prefix === 'decision') {
      domains.add('decision_center');
    }
    if (domains.size >= CHAT_TURN_PLAN_MICRO_LIMITS.maxDomains) break;
  }
  return [...domains];
}

function expandWireIntent(value: unknown, issues: ChatTurnPlanMicroValidationIssue[]): ChatTurnPlanMicroIntent {
  if (value === 'a') return 'answer';
  if (value === 'r') return 'read';
  if (value === 'w') return 'write_preview';
  if (value === 'c') return 'clarify';
  if (value === 'u') return 'unsupported';
  if (value === 'e') return 'escalate';
  issues.push(issue('invalid_enum', '$.i', '$.i must be one of a,r,w,c,u,e'));
  return 'unsupported';
}

function requireCandidateIndexes(
  value: unknown,
  path: string,
  maxItems: number,
  packet: UltraCompactPlannerPacket,
  issues: ChatTurnPlanMicroValidationIssue[],
): string[] {
  if (!Array.isArray(value)) {
    issues.push(issue('invalid_array', path, `${path} must be an array`));
    return [];
  }
  if (value.length > maxItems) issues.push(issue('too_many_items', path, `${path} exceeds max ${maxItems}`));
  return value.slice(0, maxItems).map((entry, index) => {
    const itemPath = `${path}[${index}]`;
    if (!Number.isInteger(entry)) {
      issues.push(issue('invalid_number', itemPath, `${itemPath} must be an integer candidate index`));
      return '';
    }
    const capabilityId = packet.candidates[entry as number];
    if (!capabilityId) {
      issues.push(issue('invalid_number', itemPath, `${itemPath} does not map to a candidate capability`));
      return '';
    }
    return capabilityId;
  }).filter(Boolean);
}

function requireMiniCandidateIndexes(
  value: unknown,
  path: string,
  maxItems: number,
  packet: UltraCompactPlannerPacket,
  issues: ChatTurnPlanMicroValidationIssue[],
): string[] {
  if (typeof value !== 'string') {
    issues.push(issue('invalid_string', path, `${path} must be a compact string of candidate indexes`));
    return [];
  }
  if (!/^[0-7]*$/.test(value)) {
    issues.push(issue('invalid_string', path, `${path} must contain only candidate indexes 0-7`));
    return [];
  }
  if (value.length > maxItems) issues.push(issue('too_many_items', path, `${path} exceeds max ${maxItems}`));
  return [...value.slice(0, maxItems)].map((entry, index) => {
    const itemPath = `${path}[${index}]`;
    const candidateIndex = Number(entry);
    const capabilityId = packet.candidates[candidateIndex];
    if (!capabilityId) {
      issues.push(issue('invalid_number', itemPath, `${itemPath} does not map to a candidate capability`));
      return '';
    }
    return capabilityId;
  }).filter(Boolean);
}

function requireMiniWrite(
  value: unknown,
  packet: UltraCompactPlannerPacket,
  issues: ChatTurnPlanMicroValidationIssue[],
): ChatTurnPlanMicroWriteRequest[] {
  if (typeof value !== 'string') {
    issues.push(issue('invalid_string', '$.w', '$.w must be compact write form like 0A'));
    return [];
  }
  const match = value.match(/^([0-7])([ABC])$/);
  if (!match) {
    issues.push(issue('invalid_string', '$.w', '$.w must be compact write form like 0A'));
    return [];
  }
  const capabilityId = requireMiniCandidateIndexes(match[1], '$.w[0]', 1, packet, issues)[0] ?? '';
  return [{
    requestId: 'w1',
    capabilityId,
    riskClass: match[2] as 'A' | 'B' | 'C',
  }];
}

function requireMiniScores(
  value: unknown,
  issues: ChatTurnPlanMicroValidationIssue[],
): { confidence: number; complexityScore: number } {
  if (typeof value !== 'string' || !/^[0-9]{2}$/.test(value)) {
    issues.push(issue('invalid_string', '$.s', '$.s must be two digits: confidence then complexity'));
    return { confidence: 0, complexityScore: 1 };
  }
  return {
    confidence: Number(value[0]) / 10,
    complexityScore: Number(value[1]) / 10,
  };
}

function requireWireWrites(
  value: unknown,
  packet: UltraCompactPlannerPacket,
  issues: ChatTurnPlanMicroValidationIssue[],
): ChatTurnPlanMicroWriteRequest[] {
  if (!Array.isArray(value)) {
    issues.push(issue('invalid_array', '$.w', '$.w must be an array'));
    return [];
  }
  if (value.length > CHAT_TURN_PLAN_MICRO_LIMITS.maxProposedWrites) {
    issues.push(issue('too_many_items', '$.w', '$.w exceeds max 1'));
  }
  return value.slice(0, CHAT_TURN_PLAN_MICRO_LIMITS.maxProposedWrites).map((entry, index) => {
    const path = `$.w[${index}]`;
    if (!isRecord(entry)) {
      issues.push(issue('not_object', path, 'wire write must be an object'));
      return { requestId: '', capabilityId: '', riskClass: 'C' };
    }
    rejectUnknownKeys(entry, ['c', 'k'], path, issues);
    const capabilityId = requireCandidateIndexes([entry.c], `${path}.c`, 1, packet, issues)[0] ?? '';
    const riskClass = requireEnum(entry.k, new Set(['A', 'B', 'C']), `${path}.k`, issues) as 'A' | 'B' | 'C';
    return {
      requestId: `w${index + 1}`,
      capabilityId,
      riskClass,
    };
  });
}

function expandWireClarification(
  question: unknown,
  options: unknown,
  issues: ChatTurnPlanMicroValidationIssue[],
): ChatTurnPlanMicroClarification | undefined {
  if (question === undefined && options === undefined) return undefined;
  const parsedQuestion = requireNonEmptyString(question, '$.q', issues);
  let parsedOptions: ChatTurnPlanMicroClarificationOption[] = [];
  if (options !== undefined) {
    if (!Array.isArray(options)) {
      issues.push(issue('invalid_array', '$.o', '$.o must be an array'));
    } else {
      if (options.length > CHAT_TURN_PLAN_MICRO_LIMITS.maxClarificationOptions) {
        issues.push(issue('too_many_items', '$.o', '$.o exceeds max 4'));
      }
      parsedOptions = options.slice(0, CHAT_TURN_PLAN_MICRO_LIMITS.maxClarificationOptions).map((label, index) => ({
        id: `o${index + 1}`,
        label: requireNonEmptyString(label, `$.o[${index}]`, issues),
      }));
    }
  }
  return { question: parsedQuestion, options: parsedOptions };
}

export function buildUltraCompactPlannerPacket(input: UltraCompactPlannerPacketInput): UltraCompactPlannerPacket {
  return {
    locale: input.locale.trim() || 'unknown',
    candidates: input.candidateCapabilityIds
      .map((capabilityId) => capabilityId.trim())
      .filter(Boolean)
      .slice(0, CHAT_TURN_PLAN_MICRO_LIMITS.maxCapabilityIds),
    risk: (input.riskSignals ?? [])
      .map((signal) => signal.trim())
      .filter(Boolean)
      .slice(0, 3),
    msg: input.messageSummary.trim().slice(0, 120),
    contextHash: input.contextHash.trim(),
  };
}

function requireReadRequests(
  value: unknown,
  issues: ChatTurnPlanMicroValidationIssue[],
): ChatTurnPlanMicroReadRequest[] {
  if (!Array.isArray(value)) {
    issues.push(issue('invalid_array', '$.requiredReads', 'requiredReads must be an array'));
    return [];
  }
  if (value.length > CHAT_TURN_PLAN_MICRO_LIMITS.maxRequiredReads) {
    issues.push(issue('too_many_items', '$.requiredReads', 'requiredReads exceeds max 3'));
  }
  return value.slice(0, CHAT_TURN_PLAN_MICRO_LIMITS.maxRequiredReads).map((entry, index) => {
    const path = `$.requiredReads[${index}]`;
    if (!isRecord(entry)) {
      issues.push(issue('not_object', path, 'read request must be an object'));
      return { requestId: '', capabilityId: '' };
    }
    rejectUnknownKeys(entry, ['requestId', 'capabilityId', 'reason'], path, issues);
    return {
      requestId: requireNonEmptyString(entry.requestId, `${path}.requestId`, issues),
      capabilityId: requireNonEmptyString(entry.capabilityId, `${path}.capabilityId`, issues),
      reason: entry.reason === undefined ? undefined : requireNonEmptyString(entry.reason, `${path}.reason`, issues),
    };
  });
}

function requireWriteRequests(
  value: unknown,
  issues: ChatTurnPlanMicroValidationIssue[],
): ChatTurnPlanMicroWriteRequest[] {
  if (!Array.isArray(value)) {
    issues.push(issue('invalid_array', '$.proposedWrites', 'proposedWrites must be an array'));
    return [];
  }
  if (value.length > CHAT_TURN_PLAN_MICRO_LIMITS.maxProposedWrites) {
    issues.push(issue('too_many_items', '$.proposedWrites', 'proposedWrites exceeds max 1'));
  }
  return value.slice(0, CHAT_TURN_PLAN_MICRO_LIMITS.maxProposedWrites).map((entry, index) => {
    const path = `$.proposedWrites[${index}]`;
    if (!isRecord(entry)) {
      issues.push(issue('not_object', path, 'write request must be an object'));
      return { requestId: '', capabilityId: '', riskClass: 'C' };
    }
    rejectUnknownKeys(entry, ['requestId', 'capabilityId', 'riskClass', 'reason'], path, issues);
    return {
      requestId: requireNonEmptyString(entry.requestId, `${path}.requestId`, issues),
      capabilityId: requireNonEmptyString(entry.capabilityId, `${path}.capabilityId`, issues),
      riskClass: requireEnum(entry.riskClass, new Set(['A', 'B', 'C']), `${path}.riskClass`, issues) as 'A' | 'B' | 'C',
      reason: entry.reason === undefined ? undefined : requireNonEmptyString(entry.reason, `${path}.reason`, issues),
    };
  });
}

function requireClarification(
  value: unknown,
  issues: ChatTurnPlanMicroValidationIssue[],
): ChatTurnPlanMicroClarification | undefined {
  if (!isRecord(value)) {
    issues.push(issue('not_object', '$.clarification', 'clarification must be an object'));
    return undefined;
  }
  rejectUnknownKeys(value, ['question', 'options', 'expectsFreeText'], '$.clarification', issues);
  const question = requireNonEmptyString(value.question, '$.clarification.question', issues);
  const options = requireClarificationOptions(value.options, issues);
  let expectsFreeText: boolean | undefined;
  if (value.expectsFreeText !== undefined) {
    if (typeof value.expectsFreeText !== 'boolean') {
      issues.push(issue('invalid_boolean', '$.clarification.expectsFreeText', 'expectsFreeText must be boolean'));
    } else {
      expectsFreeText = value.expectsFreeText;
    }
  }
  return { question, options, expectsFreeText };
}

function requireClarificationOptions(
  value: unknown,
  issues: ChatTurnPlanMicroValidationIssue[],
): ChatTurnPlanMicroClarificationOption[] {
  if (!Array.isArray(value)) {
    issues.push(issue('invalid_array', '$.clarification.options', 'clarification options must be an array'));
    return [];
  }
  if (value.length > CHAT_TURN_PLAN_MICRO_LIMITS.maxClarificationOptions) {
    issues.push(issue('too_many_items', '$.clarification.options', 'clarification options exceeds max 4'));
  }
  return value.slice(0, CHAT_TURN_PLAN_MICRO_LIMITS.maxClarificationOptions).map((entry, index) => {
    const path = `$.clarification.options[${index}]`;
    if (!isRecord(entry)) {
      issues.push(issue('not_object', path, 'clarification option must be an object'));
      return { id: '', label: '' };
    }
    rejectUnknownKeys(entry, ['id', 'label'], path, issues);
    return {
      id: requireNonEmptyString(entry.id, `${path}.id`, issues),
      label: requireNonEmptyString(entry.label, `${path}.label`, issues),
    };
  });
}

function requireEnumArray<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  path: string,
  maxItems: number,
  issues: ChatTurnPlanMicroValidationIssue[],
): T[] {
  if (!Array.isArray(value)) {
    issues.push(issue('invalid_array', path, `${path} must be an array`));
    return [];
  }
  if (value.length > maxItems) {
    issues.push(issue('too_many_items', path, `${path} exceeds max ${maxItems}`));
  }
  return value.slice(0, maxItems).map((entry, index) => requireEnum(entry, allowed, `${path}[${index}]`, issues));
}

function requireStringArray(
  value: unknown,
  path: string,
  maxItems: number,
  issues: ChatTurnPlanMicroValidationIssue[],
): string[] {
  if (!Array.isArray(value)) {
    issues.push(issue('invalid_array', path, `${path} must be an array`));
    return [];
  }
  if (value.length > maxItems) {
    issues.push(issue('too_many_items', path, `${path} exceeds max ${maxItems}`));
  }
  return value.slice(0, maxItems).map((entry, index) => requireNonEmptyString(entry, `${path}[${index}]`, issues));
}

function requireLiteral(
  value: unknown,
  expected: string,
  path: string,
  issues: ChatTurnPlanMicroValidationIssue[],
): string {
  if (value !== expected) {
    issues.push(issue('invalid_literal', path, `${path} must be ${expected}`));
    return '';
  }
  return value;
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  path: string,
  issues: ChatTurnPlanMicroValidationIssue[],
): T {
  if (typeof value !== 'string' || !allowed.has(value as T)) {
    issues.push(issue('invalid_enum', path, `${path} is not an allowed value`));
    return [...allowed][0];
  }
  return value as T;
}

function requireUnitNumber(
  value: unknown,
  path: string,
  issues: ChatTurnPlanMicroValidationIssue[],
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    issues.push(issue('invalid_number', path, `${path} must be a number between 0 and 1`));
    return 0;
  }
  return value;
}

function requireNonEmptyString(
  value: unknown,
  path: string,
  issues: ChatTurnPlanMicroValidationIssue[],
): string {
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push(issue('invalid_string', path, `${path} must be a non-empty string`));
    return '';
  }
  return value.trim();
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: string[],
  path: string,
  issues: ChatTurnPlanMicroValidationIssue[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      issues.push(issue('unknown_property', `${path}.${key}`, `Unknown property: ${key}`));
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function issue(
  code: ChatTurnPlanMicroValidationIssueCode,
  path: string,
  message: string,
): ChatTurnPlanMicroValidationIssue {
  return { code, path, message };
}

function fail(
  code: ChatTurnPlanMicroValidationIssueCode,
  path: string,
  message: string,
): ChatTurnPlanMicroValidationResult {
  return { ok: false, issues: [issue(code, path, message)] };
}
