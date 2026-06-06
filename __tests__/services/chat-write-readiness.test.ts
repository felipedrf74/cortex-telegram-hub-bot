// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import {
  evaluateChatWriteReadiness,
  type ChatWriteReadinessGateId,
  type ChatWriteReadinessSample,
} from '../../src/services/chat-write-readiness';

describe('evaluateChatWriteReadiness', () => {
  it('passes the write-preview gate for valid Class A preview cards', () => {
    const result = evaluateChatWriteReadiness({
      phase: 'write_preview',
      samples: [
        sample({ sampleId: 'task-create' }),
        sample({ sampleId: 'task-complete', diffRequired: true, visibleDiffPresent: true }),
      ],
    });

    expect(result.passed).toBe(true);
    expect(result.gates.map((gate) => [gate.gateId, gate.passed])).toEqual([
      ['class_a_preview_cards', true],
      ['zero_unvalidated_executions', true],
      ['diff_required_cards_have_visible_diffs', true],
    ]);
  });

  it('fails preview readiness when a Class A preview card is invalid', () => {
    const result = evaluateChatWriteReadiness({
      phase: 'write_preview',
      samples: [
        sample({ sampleId: 'task-create', previewValid: false }),
        sample({ sampleId: 'task-complete' }),
      ],
    });

    expect(result.passed).toBe(false);
    expect(gate(result, 'class_a_preview_cards')).toMatchObject({
      passed: false,
      observed: 0.5,
      threshold: 1,
    });
  });

  it('fails preview readiness if any execution bypasses validation or misses a required visible diff', () => {
    const result = evaluateChatWriteReadiness({
      phase: 'write_preview',
      samples: [
        sample({ sampleId: 'task-create' }),
        sample({
          sampleId: 'task-complete',
          diffRequired: true,
          visibleDiffPresent: false,
          executed: true,
          validatedBeforeExecution: false,
        }),
      ],
    });

    expect(result.passed).toBe(false);
    expect(gate(result, 'zero_unvalidated_executions')).toMatchObject({
      passed: false,
      observed: 1,
    });
    expect(gate(result, 'diff_required_cards_have_visible_diffs')).toMatchObject({
      passed: false,
      observed: 1,
    });
  });

  it('passes confirmed writes only when success claims are verified and Class C escalates', () => {
    const result = evaluateChatWriteReadiness({
      phase: 'confirmed_writes',
      samples: [
        sample({
          sampleId: 'task-complete',
          executed: true,
          successClaimed: true,
          verificationStatus: 'verified',
        }),
        sample({
          sampleId: 'training-plan-change',
          riskClass: 'C',
          executed: true,
          successClaimed: false,
          verificationStatus: 'indeterminate',
          escalatedPerPolicy: true,
        }),
      ],
    });

    expect(result.passed).toBe(true);
    expect(result.gates.map((gate) => [gate.gateId, gate.passed])).toEqual([
      ['class_a_preview_cards', true],
      ['zero_unvalidated_executions', true],
      ['diff_required_cards_have_visible_diffs', true],
      ['no_success_claim_without_verified_readback', true],
      ['class_c_escalation_policy', true],
      ['idempotency_retry_cancel', true],
    ]);
  });

  it('fails confirmed writes for unverified success claims, missed Class C escalation, or retry/idempotency gaps', () => {
    const result = evaluateChatWriteReadiness({
      phase: 'confirmed_writes',
      samples: [
        sample({
          sampleId: 'task-complete',
          executed: true,
          successClaimed: true,
          verificationStatus: 'failed',
          idempotencyPassed: false,
        }),
        sample({
          sampleId: 'email-send',
          riskClass: 'C',
          executed: true,
          successClaimed: false,
          verificationStatus: 'indeterminate',
          escalatedPerPolicy: false,
          retryCancelPassed: false,
        }),
      ],
    });

    expect(result.passed).toBe(false);
    expect(gate(result, 'no_success_claim_without_verified_readback')).toMatchObject({
      passed: false,
      observed: 1,
    });
    expect(gate(result, 'class_c_escalation_policy')).toMatchObject({
      passed: false,
      observed: 1,
    });
    expect(gate(result, 'idempotency_retry_cancel')).toMatchObject({
      passed: false,
      observed: 2,
    });
  });
});

function sample(overrides: Partial<ChatWriteReadinessSample> = {}): ChatWriteReadinessSample {
  return {
    sampleId: 'sample',
    riskClass: 'A',
    previewValid: true,
    diffRequired: true,
    visibleDiffPresent: true,
    executed: false,
    validatedBeforeExecution: true,
    successClaimed: false,
    verificationStatus: 'not_required',
    escalatedPerPolicy: true,
    idempotencyPassed: true,
    retryCancelPassed: true,
    ...overrides,
  };
}

function gate(
  result: ReturnType<typeof evaluateChatWriteReadiness>,
  gateId: ChatWriteReadinessGateId,
) {
  const found = result.gates.find((item) => item.gateId === gateId);
  expect(found).toBeDefined();
  return found!;
}
