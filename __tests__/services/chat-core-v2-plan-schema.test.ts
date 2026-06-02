import { describe, expect, it } from 'vitest';

import {
  CHAT_TURN_PLAN_MICRO_ATOM_JSON_SCHEMA,
  CHAT_TURN_PLAN_MICRO_JSON_SCHEMA,
  CHAT_TURN_PLAN_MICRO_MINI_JSON_SCHEMA,
  CHAT_TURN_PLAN_MICRO_PROMPT_VERSION,
  CHAT_TURN_PLAN_MICRO_SCHEMA_VERSION,
  CHAT_TURN_PLAN_MICRO_WIRE_JSON_SCHEMA,
  buildUltraCompactPlannerPacket,
  parseAndValidateChatTurnPlanMicroJson,
  parseAndValidateChatTurnPlanMicroAtomJson,
  parseAndValidateChatTurnPlanMicroMiniJson,
  parseAndValidateChatTurnPlanMicroWireJson,
  validateChatTurnPlanMicro,
} from '../../src/services/chat-core-v2/plan-schema';

function validPlan(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: CHAT_TURN_PLAN_MICRO_SCHEMA_VERSION,
    intent: 'read',
    domains: ['training'],
    capabilityIds: ['training.session_explain'],
    requiredReads: [{ requestId: 'read-1', capabilityId: 'training.session_explain' }],
    proposedWrites: [],
    evidenceClaimIds: ['evidence:training-session'],
    confidence: 0.91,
    complexityScore: 0.2,
    escalationReasons: [],
    contextHash: 'ctx-123',
    promptVersion: CHAT_TURN_PLAN_MICRO_PROMPT_VERSION,
    ...overrides,
  };
}

describe('ChatTurnPlanMicro schema', () => {
  it('accepts a minimal bounded read plan', () => {
    const result = validateChatTurnPlanMicro(validPlan(), 'ctx-123');

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.plan).toMatchObject({
      intent: 'read',
      domains: ['training'],
      capabilityIds: ['training.session_explain'],
      contextHash: 'ctx-123',
    });
  });

  it('parses model JSON and rejects context hash drift', () => {
    const result = parseAndValidateChatTurnPlanMicroJson(JSON.stringify(validPlan()), 'ctx-different');

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'context_hash_mismatch',
      path: '$.contextHash',
    }));
  });

  it('rejects unknown top-level fields instead of accepting model drift', () => {
    const result = validateChatTurnPlanMicro(validPlan({ rawAnswer: 'I will do it.' }));

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'unknown_property',
      path: '$.rawAnswer',
    }));
  });

  it('enforces micro-plan hard bounds', () => {
    const result = validateChatTurnPlanMicro(validPlan({
      domains: ['training', 'tasks', 'finance'],
      capabilityIds: ['a', 'b', 'c', 'd'],
      requiredReads: [
        { requestId: 'r1', capabilityId: 'a' },
        { requestId: 'r2', capabilityId: 'b' },
        { requestId: 'r3', capabilityId: 'c' },
        { requestId: 'r4', capabilityId: 'd' },
      ],
      proposedWrites: [
        { requestId: 'w1', capabilityId: 'a', riskClass: 'A' },
        { requestId: 'w2', capabilityId: 'b', riskClass: 'B' },
      ],
      evidenceClaimIds: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6'],
    }));

    expect(result.ok).toBe(false);
    expect(result.issues.filter((entry) => entry.code === 'too_many_items')).toHaveLength(5);
  });

  it('requires clarification options to stay small and structured', () => {
    const result = validateChatTurnPlanMicro(validPlan({
      intent: 'clarify',
      clarification: {
        question: 'Which one?',
        options: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
          { id: 'c', label: 'C' },
          { id: 'd', label: 'D' },
          { id: 'e', label: 'E' },
        ],
        unexpected: true,
      },
    }));

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'too_many_items', path: '$.clarification.options' }),
      expect.objectContaining({ code: 'unknown_property', path: '$.clarification.unexpected' }),
    ]));
  });

  it('rejects invalid domains, intents, risk classes, and confidence values', () => {
    const result = validateChatTurnPlanMicro(validPlan({
      intent: 'publish',
      domains: ['triathlon'],
      confidence: 1.4,
      complexityScore: -0.1,
      proposedWrites: [{ requestId: 'w1', capabilityId: 'training.modify_session_preview', riskClass: 'D' }],
      escalationReasons: ['unknown_reason'],
    }));

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'invalid_enum', path: '$.intent' }),
      expect.objectContaining({ code: 'invalid_enum', path: '$.domains[0]' }),
      expect.objectContaining({ code: 'invalid_number', path: '$.confidence' }),
      expect.objectContaining({ code: 'invalid_number', path: '$.complexityScore' }),
      expect.objectContaining({ code: 'invalid_enum', path: '$.proposedWrites[0].riskClass' }),
      expect.objectContaining({ code: 'invalid_enum', path: '$.escalationReasons[0]' }),
    ]));
  });

  it('builds an ultra-compact planner packet without leaking excess context', () => {
    const packet = buildUltraCompactPlannerPacket({
      locale: 'pt-PT',
      candidateCapabilityIds: ['training.session_explain', 'tasks.today_summary', 'finance.summary', 'extra.capability'],
      riskSignals: ['health_adjacent', 'calendar_write', 'finance', 'extra'],
      messageSummary: 'x'.repeat(200),
      contextHash: 'ctx-abc',
    });

    expect(packet).toEqual({
      locale: 'pt-PT',
      candidates: ['training.session_explain', 'tasks.today_summary', 'finance.summary'],
      risk: ['health_adjacent', 'calendar_write', 'finance'],
      msg: 'x'.repeat(120),
      contextHash: 'ctx-abc',
    });
  });

  it('exports a strict Ollama JSON schema for benchmark and planner calls', () => {
    expect(CHAT_TURN_PLAN_MICRO_JSON_SCHEMA).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        intent: {
          enum: ['answer', 'read', 'write_preview', 'clarify', 'unsupported', 'escalate'],
        },
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
        },
        complexityScore: {
          type: 'number',
          minimum: 0,
          maximum: 1,
        },
        promptVersion: {
          enum: [CHAT_TURN_PLAN_MICRO_PROMPT_VERSION],
        },
      },
    });
    expect(CHAT_TURN_PLAN_MICRO_JSON_SCHEMA.required).toContain('contextHash');
    expect(CHAT_TURN_PLAN_MICRO_JSON_SCHEMA.properties.requiredReads.items.additionalProperties).toBe(false);
    expect(CHAT_TURN_PLAN_MICRO_JSON_SCHEMA.properties.proposedWrites.items.additionalProperties).toBe(false);
  });

  it('expands a compact wire plan into the canonical ChatTurnPlanMicro contract', () => {
    const packet = buildUltraCompactPlannerPacket({
      locale: 'en',
      candidateCapabilityIds: ['training.session_explain', 'tasks.today_summary', 'clarify_reference'],
      messageSummary: 'what is my training today?',
      contextHash: 'ctx-wire',
    });

    const result = parseAndValidateChatTurnPlanMicroWireJson(JSON.stringify({
      v: 1,
      i: 'r',
      c: [0],
      cf: 0.92,
      x: 0.2,
    }), packet);

    expect(result.ok).toBe(true);
    expect(result.plan).toMatchObject({
      schemaVersion: CHAT_TURN_PLAN_MICRO_SCHEMA_VERSION,
      promptVersion: CHAT_TURN_PLAN_MICRO_PROMPT_VERSION,
      intent: 'read',
      domains: ['training'],
      capabilityIds: ['training.session_explain'],
      requiredReads: [{ requestId: 'r1', capabilityId: 'training.session_explain' }],
      proposedWrites: [],
      evidenceClaimIds: [],
      contextHash: 'ctx-wire',
    });
  });

  it('rejects compact wire plans that reference candidates outside the prepass allowlist', () => {
    const packet = buildUltraCompactPlannerPacket({
      locale: 'en',
      candidateCapabilityIds: ['tasks.today_summary'],
      messageSummary: 'today?',
      contextHash: 'ctx-wire',
    });

    const result = parseAndValidateChatTurnPlanMicroWireJson(JSON.stringify({
      v: 1,
      i: 'r',
      d: ['tasks'],
      c: [2],
      r: [2],
      w: [],
      cf: 0.8,
      x: 0.1,
      er: [],
      h: 'ctx-wire',
    }), packet);

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'invalid_number', path: '$.c[0]' }),
      expect.objectContaining({ code: 'invalid_number', path: '$.r[0]' }),
    ]));
  });

  it('exports a strict compact wire schema for the latency-sensitive benchmark path', () => {
    expect(CHAT_TURN_PLAN_MICRO_WIRE_JSON_SCHEMA).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['v', 'i', 'cf', 'x'],
      properties: {
        i: { enum: ['a', 'r', 'w', 'c', 'u', 'e'] },
        c: { items: { type: 'integer', minimum: 0, maximum: 7 } },
        cf: { type: 'number', minimum: 0, maximum: 1 },
      },
    });
    expect(CHAT_TURN_PLAN_MICRO_WIRE_JSON_SCHEMA.required).toEqual(['v', 'i', 'cf', 'x']);
  });

  it('expands a mini wire plan with digit scores into the canonical contract', () => {
    const packet = buildUltraCompactPlannerPacket({
      locale: 'en',
      candidateCapabilityIds: ['training.session_explain', 'tasks.today_summary', 'clarify_reference'],
      messageSummary: 'what is my training today?',
      contextHash: 'ctx-mini',
    });

    const result = parseAndValidateChatTurnPlanMicroMiniJson(JSON.stringify({
      i: 'r',
      c: '0',
      s: '92',
    }), packet);

    expect(result.ok).toBe(true);
    expect(result.plan).toMatchObject({
      schemaVersion: CHAT_TURN_PLAN_MICRO_SCHEMA_VERSION,
      promptVersion: CHAT_TURN_PLAN_MICRO_PROMPT_VERSION,
      intent: 'read',
      domains: ['training'],
      capabilityIds: ['training.session_explain'],
      requiredReads: [{ requestId: 'r1', capabilityId: 'training.session_explain' }],
      proposedWrites: [],
      evidenceClaimIds: [],
      confidence: 0.9,
      complexityScore: 0.2,
      contextHash: 'ctx-mini',
    });
  });

  it('rejects mini wire plans that reference candidates outside the prepass allowlist', () => {
    const packet = buildUltraCompactPlannerPacket({
      locale: 'en',
      candidateCapabilityIds: ['tasks.today_summary'],
      messageSummary: 'today?',
      contextHash: 'ctx-mini',
    });

    const result = parseAndValidateChatTurnPlanMicroMiniJson(JSON.stringify({
      i: 'r',
      c: '2',
      s: '91',
    }), packet);

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'invalid_number', path: '$.c[0]' }),
    ]));
  });

  it('exports a strict mini wire schema for the lowest-latency benchmark path', () => {
    expect(CHAT_TURN_PLAN_MICRO_MINI_JSON_SCHEMA).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['i', 'c', 's'],
      properties: {
        i: { enum: ['a', 'r', 'w', 'c', 'u', 'e'] },
        c: { type: 'string', pattern: '^[0-7]{0,3}$' },
        s: { type: 'string', pattern: '^[0-9]{2}$' },
      },
    });
  });

  it('expands an atom plan into the canonical contract', () => {
    const packet = buildUltraCompactPlannerPacket({
      locale: 'en',
      candidateCapabilityIds: ['training.session_explain', 'tasks.today_summary', 'clarify_reference'],
      messageSummary: 'today?',
      contextHash: 'ctx-atom',
    });

    const result = parseAndValidateChatTurnPlanMicroAtomJson(JSON.stringify({
      p: 'r191',
    }), packet);

    expect(result.ok).toBe(true);
    expect(result.plan).toMatchObject({
      intent: 'read',
      domains: ['tasks'],
      capabilityIds: ['tasks.today_summary'],
      requiredReads: [{ requestId: 'r1', capabilityId: 'tasks.today_summary' }],
      confidence: 0.9,
      complexityScore: 0.1,
      contextHash: 'ctx-atom',
    });
  });

  it('exports a strict atom schema for the lowest-token benchmark path', () => {
    expect(CHAT_TURN_PLAN_MICRO_ATOM_JSON_SCHEMA).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['p'],
      properties: {
        p: {
          type: 'string',
          pattern: '^([arcue][0-7_][0-9][0-9]|w[0-7_][ABC][0-9][0-9])$',
        },
      },
    });
  });
});
