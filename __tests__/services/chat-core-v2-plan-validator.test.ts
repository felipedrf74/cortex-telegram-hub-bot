import { describe, expect, it } from 'vitest';

import {
  validateChatTurnPlanMicroAgainstContext,
} from '../../src/services/chat-core-v2/plan-validator';
import {
  CHAT_TURN_PLAN_MICRO_PROMPT_VERSION,
  CHAT_TURN_PLAN_MICRO_SCHEMA_VERSION,
  type ChatTurnPlanMicro,
} from '../../src/services/chat-core-v2/plan-schema';

function basePlan(overrides: Partial<ChatTurnPlanMicro> = {}): ChatTurnPlanMicro {
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

describe('ChatCoreV2 plan validator', () => {
  it('accepts a grounded plan using only allowed capabilities and current context', () => {
    const result = validateChatTurnPlanMicroAgainstContext(basePlan(), {
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
    });

    expect(result).toEqual({
      ok: true,
      issues: [],
      allowedCapabilityIds: ['tasks.today_summary'],
      requiredClarificationReason: undefined,
    });
  });

  it('rejects unknown capabilities, missing evidence, stale context, and over-budget prompts', () => {
    const result = validateChatTurnPlanMicroAgainstContext(basePlan({
      capabilityIds: ['tasks.today_summary', 'unknown.write'],
      requiredReads: [{ requestId: 'read-2', capabilityId: 'unknown.read' }],
      evidenceClaimIds: ['evidence:missing'],
      contextHash: 'ctx-old',
      escalationReasons: ['ambiguous_reference', 'cloud_allowlist_candidate'],
    }), {
      contextHash: 'ctx-new',
      allowedCapabilityIds: ['tasks.today_summary'],
      availableEvidenceIds: ['evidence:1'],
      activation: {
        allowWritePreviews: false,
        allowCloudFallback: false,
        forceEvidenceForFactualClaims: true,
      },
      promptTokenCount: 4000,
      promptHardCapTokens: 3000,
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      'unknown_capability',
      'missing_grounding',
      'stale_context',
      'ambiguous_reference',
      'cloud_fallback_not_allowed',
      'budget_exceeded',
    ]));
    expect(result.requiredClarificationReason).toBe('stale_context');
  });

  it('rejects write plans while write previews are disabled', () => {
    const result = validateChatTurnPlanMicroAgainstContext(basePlan({
      intent: 'write_preview',
      proposedWrites: [{ requestId: 'write-1', capabilityId: 'tasks.complete', riskClass: 'A' }],
      capabilityIds: ['tasks.complete'],
      requiredReads: [],
    }), {
      contextHash: 'ctx-1',
      allowedCapabilityIds: ['tasks.complete'],
      availableEvidenceIds: ['evidence:1'],
      activation: {
        allowWritePreviews: false,
        allowCloudFallback: false,
        forceEvidenceForFactualClaims: true,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(['write_not_allowed_in_current_phase']);
  });
});
