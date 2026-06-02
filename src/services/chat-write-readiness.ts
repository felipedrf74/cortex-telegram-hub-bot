// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export const NEXUS_CHAT_WRITE_READINESS_VERSION = 'nexus_chat_write_readiness.v1';

export type ChatWriteReadinessPhase = 'write_preview' | 'confirmed_writes';
export type ChatWriteRiskClass = 'A' | 'B' | 'C';
export type ChatWriteVerificationStatus = 'verified' | 'partial' | 'failed' | 'indeterminate' | 'not_required';

export interface ChatWriteReadinessSample {
  sampleId: string;
  riskClass: ChatWriteRiskClass;
  previewValid: boolean;
  diffRequired: boolean;
  visibleDiffPresent: boolean;
  executed: boolean;
  validatedBeforeExecution: boolean;
  successClaimed: boolean;
  verificationStatus: ChatWriteVerificationStatus;
  escalatedPerPolicy: boolean;
  idempotencyPassed: boolean;
  retryCancelPassed: boolean;
}

export interface ChatWriteReadinessInput {
  phase: ChatWriteReadinessPhase;
  samples: ChatWriteReadinessSample[];
}

export type ChatWriteReadinessGateId =
  | 'class_a_preview_cards'
  | 'zero_unvalidated_executions'
  | 'diff_required_cards_have_visible_diffs'
  | 'no_success_claim_without_verified_readback'
  | 'class_c_escalation_policy'
  | 'idempotency_retry_cancel';

export interface ChatWriteReadinessGateResult {
  gateId: ChatWriteReadinessGateId;
  passed: boolean;
  sampleCount: number;
  observed: number;
  threshold: number;
  reasonCode?: string;
}

export interface ChatWriteReadinessResult {
  version: typeof NEXUS_CHAT_WRITE_READINESS_VERSION;
  phase: ChatWriteReadinessPhase;
  passed: boolean;
  gates: ChatWriteReadinessGateResult[];
}

export function evaluateChatWriteReadiness(input: ChatWriteReadinessInput): ChatWriteReadinessResult {
  const gates: ChatWriteReadinessGateResult[] = [
    evaluateClassAPreviews(input.samples),
    evaluateUnvalidatedExecutions(input.samples),
    evaluateVisibleDiffs(input.samples),
  ];
  if (input.phase === 'confirmed_writes') {
    gates.push(
      evaluateVerifiedSuccessClaims(input.samples),
      evaluateClassCEscalation(input.samples),
      evaluateIdempotencyRetryCancel(input.samples),
    );
  }
  return {
    version: NEXUS_CHAT_WRITE_READINESS_VERSION,
    phase: input.phase,
    passed: gates.every((gate) => gate.passed),
    gates,
  };
}

function evaluateClassAPreviews(samples: ChatWriteReadinessSample[]): ChatWriteReadinessGateResult {
  const classA = samples.filter((sample) => sample.riskClass === 'A');
  const valid = classA.filter((sample) => sample.previewValid).length;
  const observed = classA.length > 0 ? valid / classA.length : 0;
  return {
    gateId: 'class_a_preview_cards',
    passed: classA.length > 0 && observed === 1,
    sampleCount: classA.length,
    observed,
    threshold: 1,
    reasonCode: classA.length > 0 ? undefined : 'missing_class_a_preview_samples',
  };
}

function evaluateUnvalidatedExecutions(samples: ChatWriteReadinessSample[]): ChatWriteReadinessGateResult {
  const violations = samples.filter((sample) =>
    sample.executed && !sample.validatedBeforeExecution,
  ).length;
  return {
    gateId: 'zero_unvalidated_executions',
    passed: samples.length > 0 && violations === 0,
    sampleCount: samples.length,
    observed: violations,
    threshold: 0,
    reasonCode: samples.length > 0 ? undefined : 'missing_write_samples',
  };
}

function evaluateVisibleDiffs(samples: ChatWriteReadinessSample[]): ChatWriteReadinessGateResult {
  const diffRequired = samples.filter((sample) => sample.diffRequired);
  const missingDiff = diffRequired.filter((sample) => !sample.visibleDiffPresent).length;
  return {
    gateId: 'diff_required_cards_have_visible_diffs',
    passed: diffRequired.length > 0 && missingDiff === 0,
    sampleCount: diffRequired.length,
    observed: missingDiff,
    threshold: 0,
    reasonCode: diffRequired.length > 0 ? undefined : 'missing_diff_required_samples',
  };
}

function evaluateVerifiedSuccessClaims(samples: ChatWriteReadinessSample[]): ChatWriteReadinessGateResult {
  const executed = samples.filter((sample) => sample.executed);
  const violations = executed.filter((sample) =>
    sample.successClaimed && sample.verificationStatus !== 'verified',
  ).length;
  return {
    gateId: 'no_success_claim_without_verified_readback',
    passed: executed.length > 0 && violations === 0,
    sampleCount: executed.length,
    observed: violations,
    threshold: 0,
    reasonCode: executed.length > 0 ? undefined : 'missing_executed_write_samples',
  };
}

function evaluateClassCEscalation(samples: ChatWriteReadinessSample[]): ChatWriteReadinessGateResult {
  const classC = samples.filter((sample) => sample.riskClass === 'C');
  const missed = classC.filter((sample) => !sample.escalatedPerPolicy).length;
  return {
    gateId: 'class_c_escalation_policy',
    passed: classC.length > 0 && missed === 0,
    sampleCount: classC.length,
    observed: missed,
    threshold: 0,
    reasonCode: classC.length > 0 ? undefined : 'missing_class_c_samples',
  };
}

function evaluateIdempotencyRetryCancel(samples: ChatWriteReadinessSample[]): ChatWriteReadinessGateResult {
  const executed = samples.filter((sample) => sample.executed);
  const violations = executed.filter((sample) =>
    !sample.idempotencyPassed || !sample.retryCancelPassed,
  ).length;
  return {
    gateId: 'idempotency_retry_cancel',
    passed: executed.length > 0 && violations === 0,
    sampleCount: executed.length,
    observed: violations,
    threshold: 0,
    reasonCode: executed.length > 0 ? undefined : 'missing_idempotency_samples',
  };
}
