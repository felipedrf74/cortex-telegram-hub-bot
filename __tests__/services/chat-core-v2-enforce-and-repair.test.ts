// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it, vi } from 'vitest';

import {
  enforceAndRepairChatTurnPlanMicro,
  type EnforceAndRepairChatTurnPlanMicroInput,
  type EnforceAndRepairPlanParser,
} from '../../src/services/chat-core-v2/enforce-and-repair';
import { CHAT_CORE_V2_PLANNER_REPAIR_PROMPT_VERSION } from '../../src/services/chat-core-v2/planner-repair';
import {
  CHAT_TURN_PLAN_MICRO_PROMPT_VERSION,
  CHAT_TURN_PLAN_MICRO_SCHEMA_VERSION,
  type ChatTurnPlanMicro,
  type ChatTurnPlanMicroValidationResult,
} from '../../src/services/chat-core-v2/plan-schema';
import type { PlanValidationContext } from '../../src/services/chat-core-v2/plan-validator';

function validPlan(overrides: Partial<ChatTurnPlanMicro> = {}): ChatTurnPlanMicro {
  return {
    schemaVersion: CHAT_TURN_PLAN_MICRO_SCHEMA_VERSION,
    intent: 'read',
    domains: ['tasks'],
    capabilityIds: ['tasks.today_summary'],
    requiredReads: [{ requestId: 'read-1', capabilityId: 'tasks.today_summary' }],
    proposedWrites: [],
    evidenceClaimIds: ['evidence:1'],
    confidence: 0.9,
    complexityScore: 0.2,
    escalationReasons: [],
    contextHash: 'ctx-1',
    promptVersion: CHAT_TURN_PLAN_MICRO_PROMPT_VERSION,
    ...overrides,
  };
}

function validPlanJson(overrides: Partial<ChatTurnPlanMicro> = {}): string {
  return JSON.stringify(validPlan(overrides));
}

function acceptingContext(overrides: Partial<PlanValidationContext> = {}): PlanValidationContext {
  return {
    contextHash: 'ctx-1',
    allowedCapabilityIds: ['tasks.today_summary'],
    availableEvidenceIds: ['evidence:1'],
    activation: {
      allowWritePreviews: false,
      allowCloudFallback: false,
      forceEvidenceForFactualClaims: true,
    },
    promptTokenCount: 1000,
    promptHardCapTokens: 3000,
    ...overrides,
  };
}

/** A repairModel that must never be called; fails the test loudly if it is. */
function neverCalledRepairModel(): EnforceAndRepairChatTurnPlanMicroInput['repairModel'] {
  return vi.fn(async () => {
    throw new Error('repairModel should not have been called');
  });
}

describe('enforceAndRepairChatTurnPlanMicro', () => {
  it('returns valid on first pass without invoking the repair model (schema only)', async () => {
    const repairModel = neverCalledRepairModel();

    const result = await enforceAndRepairChatTurnPlanMicro({
      rawModelOutput: validPlanJson(),
      repairModel,
    });

    expect(result.outcome).toBe('valid');
    expect(result.plan).toBeDefined();
    expect(result.plan?.intent).toBe('read');
    expect(result.issues).toEqual([]);
    expect(result.attemptsUsed).toBe(0);
    expect(result.repairPromptVersion).toBe(CHAT_CORE_V2_PLANNER_REPAIR_PROMPT_VERSION);
    expect(repairModel).not.toHaveBeenCalled();
  });

  it('returns valid on first pass when context is provided and the plan satisfies it', async () => {
    const repairModel = neverCalledRepairModel();

    const result = await enforceAndRepairChatTurnPlanMicro({
      rawModelOutput: validPlanJson(),
      context: acceptingContext(),
      repairModel,
    });

    expect(result.outcome).toBe('valid');
    expect(result.plan).toBeDefined();
    expect(result.attemptsUsed).toBe(0);
    expect(repairModel).not.toHaveBeenCalled();
  });

  it('repairs once when the first output is schema-invalid and the repair returns valid JSON', async () => {
    const repairModel = vi.fn(async () => validPlanJson());

    const result = await enforceAndRepairChatTurnPlanMicro({
      rawModelOutput: '{"not":"a valid plan"}',
      repairModel,
    });

    expect(result.outcome).toBe('repaired');
    expect(result.plan).toBeDefined();
    expect(result.plan?.intent).toBe('read');
    expect(result.issues).toEqual([]);
    expect(result.attemptsUsed).toBe(1);
    // Proves the single-attempt bound: the repair model is called exactly once.
    expect(repairModel).toHaveBeenCalledTimes(1);
  });

  it('repairs once when the first output passes schema but fails context, and the repair satisfies context', async () => {
    // First output is schema-valid but uses a capability that is not allowed by
    // the context -> a context issue is folded in -> repair is attempted once.
    const firstOutput = validPlanJson({
      capabilityIds: ['tasks.not_allowed'],
      requiredReads: [{ requestId: 'read-1', capabilityId: 'tasks.not_allowed' }],
    });
    const repairModel = vi.fn(async () => validPlanJson());

    const result = await enforceAndRepairChatTurnPlanMicro({
      rawModelOutput: firstOutput,
      context: acceptingContext(),
      repairModel,
    });

    expect(result.outcome).toBe('repaired');
    expect(result.plan).toBeDefined();
    expect(result.attemptsUsed).toBe(1);
    expect(repairModel).toHaveBeenCalledTimes(1);
  });

  it('returns unrepairable with attemptsUsed 1 when repair output is still invalid (bounded to one attempt)', async () => {
    const repairModel = vi.fn(async () => '{"still":"invalid"}');

    const result = await enforceAndRepairChatTurnPlanMicro({
      rawModelOutput: 'not even json',
      repairModel,
    });

    expect(result.outcome).toBe('unrepairable');
    expect(result.plan).toBeUndefined();
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.attemptsUsed).toBe(1);
    // No second repair attempt is ever made.
    expect(repairModel).toHaveBeenCalledTimes(1);
  });

  it('never throws on garbage input and returns unrepairable when repair also fails to parse', async () => {
    const repairModel = vi.fn(async () => '<<< not json at all >>>');

    const result = await enforceAndRepairChatTurnPlanMicro({
      rawModelOutput: '',
      repairModel,
    });

    expect(result.outcome).toBe('unrepairable');
    expect(result.issues.some((issue) => issue.code === 'invalid_json')).toBe(true);
    expect(result.attemptsUsed).toBe(1);
    expect(repairModel).toHaveBeenCalledTimes(1);
  });

  it('never throws on empty/whitespace input (returns structured unrepairable, no repair success)', async () => {
    const repairModel = vi.fn(async () => '   ');

    const result = await enforceAndRepairChatTurnPlanMicro({
      rawModelOutput: '   ',
      repairModel,
    });

    expect(result.outcome).toBe('unrepairable');
    expect(result.attemptsUsed).toBe(1);
    expect(repairModel).toHaveBeenCalledTimes(1);
  });

  it('degrades gracefully to unrepairable (attemptsUsed 1) when the repair model throws', async () => {
    const repairModel = vi.fn(async () => {
      throw new Error('ollama unavailable');
    });

    const result = await enforceAndRepairChatTurnPlanMicro({
      rawModelOutput: '{"bad":true}',
      repairModel,
    });

    expect(result.outcome).toBe('unrepairable');
    expect(result.plan).toBeUndefined();
    expect(result.attemptsUsed).toBe(1);
    expect(repairModel).toHaveBeenCalledTimes(1);
    // Synthetic issue carries the error class name only, never the raw message.
    const synthetic = result.issues.find((issue) => issue.path === '$.repairModel');
    expect(synthetic).toBeDefined();
    expect(synthetic?.message).toBe('repair_model_failed:Error');
    expect(synthetic?.message).not.toContain('ollama unavailable');
  });

  it('does not leak raw user/model text into the issue list or messages', async () => {
    const secret = 'SUPER_SECRET_USER_MESSAGE_12345';
    const repairModel = vi.fn(async () => `{"echo":"${secret}"}`);

    const result = await enforceAndRepairChatTurnPlanMicro({
      rawModelOutput: `{"secret":"${secret}"}`,
      repairModel,
    });

    expect(result.outcome).toBe('unrepairable');
    const serialized = JSON.stringify(result.issues);
    expect(serialized).not.toContain(secret);
  });

  it('accepts an optional now field without altering the bounded behaviour', async () => {
    const repairModel = neverCalledRepairModel();

    const result = await enforceAndRepairChatTurnPlanMicro({
      rawModelOutput: validPlanJson(),
      repairModel,
      now: new Date('2026-05-30T00:00:00.000Z'),
    });

    expect(result.outcome).toBe('valid');
    expect(repairModel).not.toHaveBeenCalled();
  });

  describe('injected schema parser (parse override)', () => {
    /**
     * A wire-ish raw string the default canonical parser would REJECT (it is not
     * canonical ChatTurnPlanMicro JSON), but which the injected parser expands
     * into a valid canonical plan. This is the shadow-planner shape: the model
     * emits tiny WIRE JSON and the caller binds a packet-aware expanding parser.
     */
    const WIRE_RAW = '{"v":1,"i":"r","c":[0],"cf":0.9,"x":0.2}';

    /** Build an injected parser that returns `result` for the given raw string. */
    function fixedParser(result: ChatTurnPlanMicroValidationResult): EnforceAndRepairPlanParser {
      return vi.fn((_raw: string) => result);
    }

    const okResult: ChatTurnPlanMicroValidationResult = {
      ok: true,
      issues: [],
      plan: validPlan(),
    };

    const rejectResult: ChatTurnPlanMicroValidationResult = {
      ok: false,
      issues: [{ code: 'invalid_json', path: '$', message: 'wire parse failed' }],
    };

    it('uses the injected parser on the first pass; wire-ish input expands to a valid plan', async () => {
      const repairModel = neverCalledRepairModel();
      const parse = fixedParser(okResult);

      const result = await enforceAndRepairChatTurnPlanMicro({
        // Raw the canonical parser would reject, but the injected parser accepts.
        rawModelOutput: WIRE_RAW,
        parse,
        repairModel,
      });

      expect(result.outcome).toBe('valid');
      expect(result.plan).toBeDefined();
      expect(result.plan?.intent).toBe('read');
      expect(result.issues).toEqual([]);
      expect(result.attemptsUsed).toBe(0);
      // The injected parser ran exactly once (first pass) and the repair model
      // was never touched.
      expect(parse).toHaveBeenCalledTimes(1);
      expect(parse).toHaveBeenCalledWith(WIRE_RAW);
      expect(repairModel).not.toHaveBeenCalled();
    });

    it('control: the same wire-ish input is unrepairable WITHOUT an injected parser', async () => {
      // Proves WIRE_RAW genuinely fails the default canonical parser, so the
      // valid outcome above is attributable to the injected parser, not to the
      // raw string being canonical by accident.
      const repairModel = vi.fn(async () => WIRE_RAW);

      const result = await enforceAndRepairChatTurnPlanMicro({
        rawModelOutput: WIRE_RAW,
        repairModel,
      });

      expect(result.outcome).toBe('unrepairable');
      expect(result.attemptsUsed).toBe(1);
      expect(repairModel).toHaveBeenCalledTimes(1);
    });

    it('uses the injected parser on BOTH passes: rejects first, repair re-parses to valid', async () => {
      // First call rejects (first pass), second call accepts (post-repair pass).
      const parse = vi
        .fn<[string], ChatTurnPlanMicroValidationResult>()
        .mockReturnValueOnce(rejectResult)
        .mockReturnValueOnce(okResult);
      const repairModel = vi.fn(async () => WIRE_RAW);

      const result = await enforceAndRepairChatTurnPlanMicro({
        rawModelOutput: '{"v":1,"i":"x"}',
        parse,
        repairModel,
      });

      expect(result.outcome).toBe('repaired');
      expect(result.plan).toBeDefined();
      expect(result.plan?.intent).toBe('read');
      expect(result.issues).toEqual([]);
      expect(result.attemptsUsed).toBe(1);
      // Injected parser ran on the initial parse AND the post-repair re-parse.
      expect(parse).toHaveBeenCalledTimes(2);
      // Single-repair bound respected.
      expect(repairModel).toHaveBeenCalledTimes(1);
    });

    it('stays bounded with an injected parser that rejects both passes', async () => {
      const parse = vi
        .fn<[string], ChatTurnPlanMicroValidationResult>()
        .mockReturnValue(rejectResult);
      const repairModel = vi.fn(async () => WIRE_RAW);

      const result = await enforceAndRepairChatTurnPlanMicro({
        rawModelOutput: WIRE_RAW,
        parse,
        repairModel,
      });

      expect(result.outcome).toBe('unrepairable');
      expect(result.plan).toBeUndefined();
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.attemptsUsed).toBe(1);
      expect(parse).toHaveBeenCalledTimes(2);
      expect(repairModel).toHaveBeenCalledTimes(1);
    });

    it('still folds context validation in when an injected parser is used', async () => {
      // The injected parser only replaces the SCHEMA parse step; the context
      // policy check still runs on the schema-valid plan. Here the parsed plan
      // uses a capability the context disallows, so a repair is attempted.
      const offContextPlan: ChatTurnPlanMicroValidationResult = {
        ok: true,
        issues: [],
        plan: validPlan({
          capabilityIds: ['tasks.not_allowed'],
          requiredReads: [{ requestId: 'read-1', capabilityId: 'tasks.not_allowed' }],
        }),
      };
      const parse = vi
        .fn<[string], ChatTurnPlanMicroValidationResult>()
        .mockReturnValueOnce(offContextPlan)
        .mockReturnValueOnce(okResult);
      const repairModel = vi.fn(async () => WIRE_RAW);

      const result = await enforceAndRepairChatTurnPlanMicro({
        rawModelOutput: WIRE_RAW,
        context: acceptingContext(),
        parse,
        repairModel,
      });

      expect(result.outcome).toBe('repaired');
      expect(result.plan).toBeDefined();
      expect(result.attemptsUsed).toBe(1);
      expect(parse).toHaveBeenCalledTimes(2);
      expect(repairModel).toHaveBeenCalledTimes(1);
    });

    it('OMITTED parser is byte-identical to the canonical full-parser path (context-hash mismatch still caught)', async () => {
      // With no injected parser, the default path passes context?.contextHash
      // through to parseAndValidateChatTurnPlanMicroJson. A plan whose
      // contextHash disagrees with the context must therefore fail the schema
      // pass exactly as before this change.
      const repairModel = vi.fn(async () => validPlanJson({ contextHash: 'stale' }));

      const result = await enforceAndRepairChatTurnPlanMicro({
        rawModelOutput: validPlanJson({ contextHash: 'stale' }),
        context: acceptingContext({ contextHash: 'ctx-1' }),
        repairModel,
      });

      expect(result.outcome).toBe('unrepairable');
      expect(result.issues.some((issue) => issue.code === 'context_hash_mismatch')).toBe(true);
      expect(result.attemptsUsed).toBe(1);
      expect(repairModel).toHaveBeenCalledTimes(1);
    });
  });
});
