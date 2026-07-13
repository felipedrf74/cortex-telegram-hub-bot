// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import type { ChatPromptContext } from '../../src/services/chat-context-engine';
import { buildSecretaryContextSnapshotFromPromptContext } from '../../src/services/chat-core-v2/secretary-context-snapshot';
import {
  parseAndValidateSecretaryReasoning,
  SECRETARY_REASONING_PROMPT_VERSION,
  SECRETARY_REASONING_SCHEMA_VERSION,
} from '../../src/services/chat-core-v2/secretary-candidate-schema';

function snapshot(scope: { tenantId?: number; userId?: number } = {}) {
  const tenantId = scope.tenantId ?? 7;
  const userId = scope.userId ?? 7;
  const context: ChatPromptContext = {
    tenantId,
    userId,
    domain: 'secretary',
    intent: {
      relevantDomains: ['secretary'], ambiguousFollowUp: false, asksWhy: false, memoryRecall: false,
      memoryWrite: false, correction: false, tenantBoundaryMention: false, planning: false,
      actionReference: false, promptInjectionAttempt: false,
    },
    items: [{
      id: 'current-turn', tenantId, userId, ownerUserId: userId, scope: 'user_private',
      source: 'current_turn', content: 'What should I focus on?', freshness: 'fresh', confidence: 1,
      relevanceScore: 1, priority: 100, permissionRequirements: ['authenticated_user'],
      staleAfter: '2026-07-10T12:10:00.000Z', critical: true, reason: 'current request',
    }],
    weakSignals: [], block: '', budgetChars: 2600, usedChars: 30,
  };
  return buildSecretaryContextSnapshotFromPromptContext(context, { now: new Date('2026-07-10T12:00:00.000Z') });
}

function candidatePayload() {
  const context = snapshot();
  return {
    context,
    value: {
      schemaVersion: SECRETARY_REASONING_SCHEMA_VERSION,
      promptVersion: SECRETARY_REASONING_PROMPT_VERSION,
      snapshotId: context.snapshotId,
      contextHash: context.contextHash,
      candidates: [{
        behavior: 'answer',
        userFacingText: 'Focus on the item with the closest confirmed deadline.',
        conciseRationale: 'The current request asks for prioritization.',
        evidenceIds: ['current-turn'],
        assumptions: [],
        unresolvedQuestions: [],
        factors: {
          relevance: 'direct', confidence: 'medium', urgency: 'today', expectedImpact: 'medium',
          risk: 'low', reversibility: 'not_applicable', requiredPermissions: [], requiredApproval: 'none',
          dependencies: [], contextFreshness: 'fresh',
        },
      }],
    },
  };
}

describe('secretary-candidate-schema', () => {
  it('accepts a strict evidence-bound envelope, including a JSON fence', () => {
    const { context, value } = candidatePayload();
    const parsed = parseAndValidateSecretaryReasoning(`\`\`\`json\n${JSON.stringify(value)}\n\`\`\``, context);
    expect(parsed.ok).toBe(true);
    expect(parsed.result?.candidates[0].behavior).toBe('answer');
    expect(parsed.result?.candidates[0].candidateId).toMatch(/^secretary_candidate_[a-f0-9]{24}$/);
  });

  it('rejects unknown evidence, stale scope, and unknown properties', () => {
    const { context, value } = candidatePayload();
    const invalid = {
      ...value,
      contextHash: 'wrong',
      unexpected: true,
      candidates: [{ ...value.candidates[0], evidenceIds: ['other-user-evidence'] }],
    };
    const parsed = parseAndValidateSecretaryReasoning(JSON.stringify(invalid), context);

    expect(parsed.ok).toBe(false);
    expect(parsed.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'scope_mismatch', 'unknown_property', 'unknown_evidence',
    ]));
  });

  it('rejects extra candidate fields instead of accepting an unbounded model contract', () => {
    const { context, value } = candidatePayload();
    const invalid = {
      ...value,
      candidates: [{ ...value.candidates[0], chainOfThought: 'private reasoning' }],
    };
    const parsed = parseAndValidateSecretaryReasoning(JSON.stringify(invalid), context);
    expect(parsed.ok).toBe(false);
    expect(parsed.issues).toContainEqual({ code: 'unknown_property', path: '$.candidates[0].chainOfThought' });
  });

  it('rejects a model-supplied candidate id because identity belongs to server code', () => {
    const { context, value } = candidatePayload();
    const invalid = { ...value, candidates: [{ ...value.candidates[0], candidateId: 'model_controls_order' }] };
    const parsed = parseAndValidateSecretaryReasoning(JSON.stringify(invalid), context);
    expect(parsed.ok).toBe(false);
    expect(parsed.issues).toContainEqual({ code: 'unknown_property', path: '$.candidates[0].candidateId' });
  });

  it('derives candidate identity within tenant and user scope', () => {
    const first = candidatePayload();
    const secondContext = snapshot({ tenantId: 8, userId: 8 });
    const secondValue = {
      ...first.value,
      snapshotId: secondContext.snapshotId,
      contextHash: secondContext.contextHash,
    };

    const firstParsed = parseAndValidateSecretaryReasoning(JSON.stringify(first.value), first.context);
    const secondParsed = parseAndValidateSecretaryReasoning(JSON.stringify(secondValue), secondContext);

    expect(firstParsed.ok).toBe(true);
    expect(secondParsed.ok).toBe(true);
    expect(firstParsed.result?.candidates[0].candidateId)
      .not.toBe(secondParsed.result?.candidates[0].candidateId);
  });

  it('accepts only evidence-referenced bounded action drafts for action behavior', () => {
    const { context, value } = candidatePayload();
    const action = {
      ...value,
      candidates: [{
        ...value.candidates[0],
        behavior: 'decision_center',
        capabilityId: 'secretary.schedule_event_preview',
        actionDraft: {
          intent: 'review_schedule_change',
          targetEvidenceIds: ['current-turn'],
          requestedWindow: { start: '2026-07-11T09:00:00Z', end: '2026-07-11T10:00:00Z', timezone: 'Europe/Lisbon' },
          expectedEffectCodes: ['calendar_preview'],
          prohibitedEffectCodes: ['automatic_calendar_write'],
        },
      }],
    };
    const parsed = parseAndValidateSecretaryReasoning(JSON.stringify(action), context);
    expect(parsed.ok).toBe(true);
    expect(parsed.result?.candidates[0].actionDraft?.targetEvidenceIds).toEqual(['current-turn']);
  });

  it('rejects an action assumption that is not evidence-bound', () => {
    const { context, value } = candidatePayload();
    const action = {
      ...value,
      candidates: [{
        ...value.candidates[0],
        behavior: 'decision_center',
        capabilityId: 'secretary.schedule_event_preview',
        actionDraft: {
          intent: 'review_schedule_change',
          targetEvidenceIds: ['current-turn'],
          expectedEffectCodes: ['calendar_preview'],
          prohibitedEffectCodes: ['automatic_calendar_write'],
        },
        assumptions: [{ summary: 'An unsupported assumption affects this action.', evidenceIds: [] }],
      }],
    };

    const parsed = parseAndValidateSecretaryReasoning(JSON.stringify(action), context);

    expect(parsed.ok).toBe(false);
    expect(parsed.issues).toContainEqual({ code: 'invalid_schema', path: '$.candidates[0].assumptions' });
  });

  it('rejects an uncited assumption in a factual answer', () => {
    const { context, value } = candidatePayload();
    const answer = {
      ...value,
      candidates: [{
        ...value.candidates[0],
        behavior: 'answer',
        assumptions: [{ summary: 'The rest of the calendar is probably clear.', evidenceIds: [] }],
      }],
    };

    const parsed = parseAndValidateSecretaryReasoning(JSON.stringify(answer), context);

    expect(parsed.ok).toBe(false);
    expect(parsed.issues).toContainEqual({ code: 'invalid_schema', path: '$.candidates[0].assumptions' });
  });

  it('interprets offset-free action windows in the explicitly declared timezone', () => {
    const { context, value } = candidatePayload();
    const action = {
      ...value,
      candidates: [{
        ...value.candidates[0],
        behavior: 'decision_center',
        capabilityId: 'secretary.schedule_event_preview',
        actionDraft: {
          intent: 'review_schedule_change',
          targetEvidenceIds: ['current-turn'],
          requestedWindow: {
            start: '2026-07-10T09:00:00',
            end: '2026-07-10T10:00:00',
            timezone: 'Europe/Lisbon',
          },
          expectedEffectCodes: ['calendar_preview'],
          prohibitedEffectCodes: ['automatic_calendar_write'],
        },
      }],
    };

    const parsed = parseAndValidateSecretaryReasoning(JSON.stringify(action), context);

    expect(parsed.ok).toBe(true);
    expect(parsed.result?.candidates[0].actionDraft?.requestedWindow).toMatchObject({
      start: '2026-07-10T08:00:00.000Z',
      end: '2026-07-10T09:00:00.000Z',
      timezone: 'Europe/Lisbon',
    });
  });

  it('rejects an action window with an invalid timezone', () => {
    const { context, value } = candidatePayload();
    const action = {
      ...value,
      candidates: [{
        ...value.candidates[0],
        behavior: 'decision_center',
        capabilityId: 'secretary.schedule_event_preview',
        actionDraft: {
          intent: 'review_schedule_change',
          targetEvidenceIds: ['current-turn'],
          requestedWindow: {
            start: '2026-07-10T09:00:00',
            end: '2026-07-10T10:00:00',
            timezone: 'Not/A_Timezone',
          },
          expectedEffectCodes: ['calendar_preview'],
          prohibitedEffectCodes: ['automatic_calendar_write'],
        },
      }],
    };

    const parsed = parseAndValidateSecretaryReasoning(JSON.stringify(action), context);

    expect(parsed.ok).toBe(false);
    expect(parsed.issues).toContainEqual({ code: 'invalid_schema', path: '$.candidates[0].actionDraft.requestedWindow' });
  });
});
