// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M10: ChatV2 write-evidence recorders for the /message stage pipeline and
 * /confirm-action. Moved VERBATIM from chat-message-routes.ts — behavior
 * changes are forbidden (the replay corpus pins envelopes byte-for-byte).
 */

import type { PendingChatConfirmation } from '../../../services/chat-pending-confirmations';
import {
  textClaimsUnverifiedAction,
  textHasBareAppSuccessMarker,
} from '../../../services/chat-success-claim-policy';
import type {
  ChatCoreV2ActionGatewayResult,
  ChatCoreV2CommandExecutionResult,
  PendingChatCoreV2Command,
} from '../../../services/chat-core-v2';
import { safeRecordChatV2WriteEvidence } from '../../../services/chat-write-evidence';

export function recordChatCoreV2GatewayPreviewEvidence(input: {
  tenantId: number;
  userId: number;
  requestId: string;
  result: Extract<ChatCoreV2ActionGatewayResult, { kind: 'resolved_preview' | 'resolved_execute' }>;
}): void {
  const cards = input.result.preview.response.cards ?? [];
  const diffRequired = cards.some((card) => Array.isArray(card.diff) && card.diff.length > 0)
    || Boolean(input.result.preview.confirmationToken);
  const visibleDiffPresent = diffRequired
    ? cards.some((card) => Array.isArray(card.diff) && card.diff.length > 0)
      || Boolean(input.result.preview.confirmationToken)
    : true;
  safeRecordChatV2WriteEvidence({
    tenantId: input.tenantId,
    userId: input.userId,
    requestId: input.requestId,
    sampleKey: `action-gateway:${input.result.preview.capabilityId}:${input.result.command.commandId}`,
    phase: input.result.kind === 'resolved_execute' ? 'confirmed_writes' : 'write_preview',
    riskClass: input.result.writeRiskPolicy.riskClass,
    previewValid: input.result.preview.gateVerdict.ok,
    diffRequired,
    visibleDiffPresent,
    executed: input.result.kind === 'resolved_execute',
    validatedBeforeExecution: input.result.preview.gateVerdict.ok,
    successClaimed: false,
    verificationStatus: input.result.kind === 'resolved_execute' ? 'indeterminate' : 'not_required',
    escalatedPerPolicy: input.result.writeRiskPolicy.riskClass !== 'C',
    idempotencyPassed: true,
    retryCancelPassed: true,
    safeMetadata: {
      routeMethod: 'chat-core-v2-action-gateway',
      capabilityId: input.result.preview.capabilityId,
      commandType: input.result.command.commandType,
      policyDecision: input.result.telemetry.policyDecision,
      writeExecutionGateBlocked: input.result.telemetry.writeExecutionGateBlocked === true,
    },
  });
}

export function recordChatCoreV2GatewayStopEvidence(input: {
  tenantId: number;
  userId: number;
  requestId: string;
  result: Extract<ChatCoreV2ActionGatewayResult, { kind: 'needs_clarification' | 'unsupported_write' | 'blocked_legacy_fallback' }>;
}): void {
  const riskClass = toWriteEvidenceRiskClassForGatewayStop(input.result);
  const phase = riskClass === 'C' ? 'confirmed_writes' : 'write_preview';
  const reason = input.result.kind === 'needs_clarification' ? 'needs_clarification' : input.result.reason;

  safeRecordChatV2WriteEvidence({
    tenantId: input.tenantId,
    userId: input.userId,
    requestId: input.requestId,
    sampleKey: `action-gateway-stop:${input.result.kind}:${input.result.telemetry.detectedIntent}:${reason}`,
    phase,
    riskClass,
    previewValid: true,
    diffRequired: true,
    visibleDiffPresent: true,
    executed: false,
    validatedBeforeExecution: true,
    successClaimed: false,
    verificationStatus: riskClass === 'C' ? 'indeterminate' : 'not_required',
    escalatedPerPolicy: riskClass !== 'C' || input.result.kind !== 'blocked_legacy_fallback' || input.result.telemetry.legacyFallbackBlocked,
    idempotencyPassed: true,
    retryCancelPassed: true,
    safeMetadata: {
      routeMethod: 'chat-core-v2-action-gateway',
      gatewayOutcome: input.result.kind,
      detectedIntent: input.result.telemetry.detectedIntent,
      actionType: input.result.telemetry.actionType ?? null,
      policyDecision: input.result.telemetry.policyDecision,
      legacyFallbackBlocked: input.result.telemetry.legacyFallbackBlocked,
      reason,
    },
  });
}

export function recordChatReasoningWriteEvidence(input: {
  tenantId: number;
  userId: number;
  requestId: string;
  normalizedText: string;
  status: string;
  response: { text?: unknown; metadata?: Record<string, unknown> | undefined };
}): void {
  const metadata = input.response.metadata && typeof input.response.metadata === 'object'
    ? input.response.metadata
    : {};
  const actionFrame = metadata.actionFrame && typeof metadata.actionFrame === 'object'
    ? metadata.actionFrame as Record<string, unknown>
    : {};
  const riskClass = toWriteEvidenceRiskClass(actionFrame.riskLevel, metadata);
  const verificationStatus = toWriteEvidenceVerificationStatus(
    typeof metadata.verificationStatus === 'string' ? metadata.verificationStatus : undefined,
    input.status,
  );
  const executed = input.status === 'completed' || input.status === 'partial_failure' || input.status === 'failed';
  // Class C items are non-executing escalations in v1, but the Phase 6 gate
  // still needs runtime evidence that the escalation policy caught them.
  const phase = executed || riskClass === 'C' ? 'confirmed_writes' : 'write_preview';
  const previewValid = executed
    || input.status === 'needs_confirmation'
    || input.status === 'needs_clarification'
    || Boolean(metadata.actionConfirmation || Object.keys(actionFrame).length > 0);
  const diffRequired = Boolean(
    metadata.actionConfirmation
      || metadata.type === 'chat_action_confirmation_required'
      || metadata.type === 'chat_action_clarification_required'
      || Object.keys(actionFrame).length > 0
      || metadata.type === 'task_created'
      || metadata.type === 'task_subtasks_added',
  );
  const visibleDiffPresent = diffRequired
    ? Boolean(
      metadata.actionConfirmation
        || metadata.title
        || metadata.reason
        || (Array.isArray(metadata.subtasks) && metadata.subtasks.length > 0)
        || actionFrame.primaryIntent,
    )
    : true;

  safeRecordChatV2WriteEvidence({
    tenantId: input.tenantId,
    userId: input.userId,
    requestId: input.requestId,
    sampleKey: `${input.status}:${String(metadata.type ?? 'chat_reasoning_write')}:${String(actionFrame.primaryIntent ?? '')}`,
    phase,
    riskClass,
    previewValid,
    diffRequired,
    visibleDiffPresent,
    executed,
    validatedBeforeExecution: true,
    successClaimed: executed && /\b(?:created|added|marked|done|criada?|criado|adicionei|conclu[ií]|feito|feita)\b/i
      .test(String(input.response.text ?? '')),
    verificationStatus,
    escalatedPerPolicy: riskClass !== 'C'
      || Boolean(metadata.escalatedPerPolicy)
      || input.status === 'needs_confirmation'
      || input.status === 'needs_clarification'
      || input.status === 'deferred',
    idempotencyPassed: metadata.idempotentReplay === true || Boolean(metadata.actionPlanId) || !executed,
    retryCancelPassed: true,
    safeMetadata: {
      routeMethod: 'chat-reasoning-engine',
      status: input.status,
      metadataType: typeof metadata.type === 'string' ? metadata.type : null,
      primaryIntent: typeof actionFrame.primaryIntent === 'string' ? actionFrame.primaryIntent : null,
      reason: typeof metadata.reason === 'string' ? metadata.reason : null,
      verificationStatus,
    },
  });
}

export function recordConfirmedChatActionWriteEvidence(input: {
  tenantId: number;
  userId: number;
  requestId: string;
  pending: PendingChatConfirmation;
  status: string;
  response: { text?: unknown; metadata?: Record<string, unknown> | undefined };
}): void {
  const metadata = input.response.metadata && typeof input.response.metadata === 'object'
    ? input.response.metadata
    : {};
  const verificationStatus = toWriteEvidenceVerificationStatus(
    typeof metadata.verificationStatus === 'string' ? metadata.verificationStatus : undefined,
    input.status,
  );
  const riskClass = toWriteEvidenceRiskClassForIntent(input.pending.intentClass);
  const executed = input.status === 'completed' || verificationStatus === 'verified' || verificationStatus === 'partial';
  const successClaimed = executed && responseAppearsToClaimWriteSuccess(String(input.response.text ?? ''));

  safeRecordChatV2WriteEvidence({
    tenantId: input.tenantId,
    userId: input.userId,
    requestId: input.requestId,
    sampleKey: `confirm-action:${input.pending.intentClass}:${input.status}:${String(metadata.type ?? '')}`,
    phase: 'confirmed_writes',
    riskClass,
    previewValid: true,
    diffRequired: true,
    visibleDiffPresent: true,
    executed,
    validatedBeforeExecution: true,
    successClaimed,
    verificationStatus,
    escalatedPerPolicy: riskClass !== 'C' || input.status === 'needs_confirmation' || input.status === 'needs_clarification',
    idempotencyPassed: true,
    retryCancelPassed: true,
    safeMetadata: {
      routeMethod: 'confirm-action',
      status: input.status,
      metadataType: typeof metadata.type === 'string' ? metadata.type : null,
      intentClass: input.pending.intentClass,
      verificationStatus,
    },
  });
}

export function recordConfirmedChatCoreV2CommandWriteEvidence(input: {
  tenantId: number;
  userId: number;
  requestId: string;
  pending: PendingChatCoreV2Command;
  execution: ChatCoreV2CommandExecutionResult;
  response: { text?: unknown; metadata?: Record<string, unknown> | undefined };
}): void {
  const metadata = input.response.metadata && typeof input.response.metadata === 'object'
    ? input.response.metadata
    : {};
  const verificationStatus = toWriteEvidenceVerificationStatus(
    typeof metadata.verificationStatus === 'string' ? metadata.verificationStatus : undefined,
    input.execution.status,
  );
  const riskClass = toWriteEvidenceRiskClassForIntent(input.pending.command.commandType);
  const hasResultResponse = Boolean(input.execution.response);
  const executed = hasResultResponse
    && input.execution.status !== 'rejected_by_policy'
    && input.execution.status !== 'failed';
  const successClaimed = responseAppearsToClaimWriteSuccess(String(input.response.text ?? ''));
  const cards = input.execution.response?.cards ?? [];
  const diffRequired = true;
  const visibleDiffPresent = cards.some((card) => Array.isArray(card.diff) && card.diff.length > 0);

  safeRecordChatV2WriteEvidence({
    tenantId: input.tenantId,
    userId: input.userId,
    requestId: input.requestId,
    sampleKey: `confirm-action:${input.pending.command.commandType}:${input.execution.status}:${String(metadata.type ?? '')}`,
    phase: 'confirmed_writes',
    riskClass,
    previewValid: true,
    diffRequired,
    visibleDiffPresent,
    executed,
    validatedBeforeExecution: true,
    successClaimed,
    verificationStatus,
    escalatedPerPolicy: riskClass !== 'C' || input.execution.status === 'queued',
    idempotencyPassed: true,
    retryCancelPassed: true,
    safeMetadata: {
      routeMethod: 'chat-core-v2-command-confirmation',
      status: input.execution.status,
      metadataType: typeof metadata.type === 'string' ? metadata.type : null,
      commandType: input.pending.command.commandType,
      capabilityId: input.pending.capabilityId,
      verificationStatus,
    },
  });
}

function toWriteEvidenceRiskClass(
  value: unknown,
  metadata?: Record<string, unknown>,
): 'A' | 'B' | 'C' {
  if (value === 'high' || metadata?.riskLevel === 'high' || metadata?.reason === 'destructive_action') return 'C';
  if (value === 'medium' || metadata?.riskLevel === 'medium') return 'B';
  return 'A';
}

function toWriteEvidenceRiskClassForIntent(intentClass: string | null | undefined): 'A' | 'B' | 'C' {
  const intent = String(intentClass ?? '').toLowerCase();
  if (/(delete|remove|cancel|send|email|payment|transfer|finance|external)/.test(intent)) return 'C';
  if (/(calendar|recurring|schedule|reschedule|move)/.test(intent)) return 'B';
  return 'A';
}

function toWriteEvidenceRiskClassForGatewayStop(
  result: Extract<ChatCoreV2ActionGatewayResult, { kind: 'needs_clarification' | 'unsupported_write' | 'blocked_legacy_fallback' }>,
): 'A' | 'B' | 'C' {
  if (result.kind === 'unsupported_write' && result.writeRiskPolicy) {
    return result.writeRiskPolicy.riskClass;
  }
  if (result.telemetry.writeRiskClass === 'A' || result.telemetry.writeRiskClass === 'B' || result.telemetry.writeRiskClass === 'C') {
    return result.telemetry.writeRiskClass;
  }
  const actionType = String(result.telemetry.actionType ?? '').toLowerCase();
  const reasonCodes = result.telemetry.reasonCodes.join(' ').toLowerCase();
  if (
    result.telemetry.detectedIntent === 'task_delete'
    || actionType.includes('delete')
    || actionType.includes('destructive')
    || actionType.includes('finance')
    || actionType.includes('training')
    || reasonCodes.includes('write_risk_class_c')
    || reasonCodes.includes('unsupported_task_mutation_intent')
  ) {
    return 'C';
  }
  return result.kind === 'needs_clarification' ? 'B' : 'C';
}

function toWriteEvidenceVerificationStatus(
  verification: string | undefined,
  status: string,
): 'verified' | 'partial' | 'failed' | 'indeterminate' | 'not_required' {
  if (verification === 'verified' || verification === 'verified_success') return 'verified';
  if (verification === 'partial_failure' || verification === 'partial') return 'partial';
  if (status === 'failed' || status === 'verification_failed') return 'failed';
  if (status === 'completed') return 'verified';
  if (status === 'verified') return 'verified';
  if (status === 'verified_success') return 'verified';
  if (status === 'partial_failure') return 'partial';
  if (status === 'needs_confirmation' || status === 'needs_clarification' || status === 'in_progress') {
    return 'indeterminate';
  }
  return 'not_required';
}

function responseAppearsToClaimWriteSuccess(text: string): boolean {
  return textClaimsUnverifiedAction(text)
    || textHasBareAppSuccessMarker(text)
    || /\b(?:created|added|marked|done|criada?|criado|adicionei|conclu[ií]|feito|feita)\b/i.test(text);
}
