// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type {
  BatchPolicy,
  CapabilityDefinition,
} from './types';

export const CHAT_CORE_V2_BATCH_POLICY_VERSION = 'chat_core_v2_batch_policy@1.0.0';

export type ChatCoreV2BatchPolicyStage = 'proposal' | 'preview' | 'confirmation';

export type ChatCoreV2BatchPolicyReason =
  | 'single_item'
  | 'batch_allowed'
  | 'batch_policy_missing'
  | 'too_large_batch'
  | 'diff_preview_required'
  | 'typed_confirmation_required';

export interface ChatCoreV2BatchPolicyInput {
  capability: Pick<CapabilityDefinition, 'capabilityId' | 'risk' | 'batchPolicy'>;
  itemCount: number;
  stage: ChatCoreV2BatchPolicyStage;
  diffPreviewItemCount?: number;
  typedConfirmationText?: string | null;
}

export interface ChatCoreV2BatchPolicyVerdict {
  ok: boolean;
  policyVersion: string;
  capabilityId: string;
  itemCount: number;
  stage: ChatCoreV2BatchPolicyStage;
  reason: ChatCoreV2BatchPolicyReason;
  requiresSpecialConfirmation: boolean;
  requiresDiffPreview: boolean;
  requiredTypedConfirmationText?: string;
  maxItemsAbsolute?: number;
  maxItemsWithoutSpecialConfirmation?: number;
}

export function evaluateChatCoreV2BatchPolicy(input: ChatCoreV2BatchPolicyInput): ChatCoreV2BatchPolicyVerdict {
  const itemCount = Math.max(0, Math.floor(input.itemCount));
  const batchPolicy = input.capability.batchPolicy;
  const base = {
    policyVersion: CHAT_CORE_V2_BATCH_POLICY_VERSION,
    capabilityId: input.capability.capabilityId,
    itemCount,
    stage: input.stage,
  };

  if (itemCount <= 1) {
    return {
      ...base,
      ok: true,
      reason: 'single_item',
      requiresSpecialConfirmation: false,
      requiresDiffPreview: false,
    };
  }

  if (!batchPolicy) {
    return {
      ...base,
      ok: false,
      reason: 'batch_policy_missing',
      requiresSpecialConfirmation: true,
      requiresDiffPreview: true,
    };
  }

  const requiredTypedConfirmationText = renderTypedConfirmationText(batchPolicy, itemCount);
  const requiresSpecialConfirmation = itemCount > batchPolicy.maxItemsWithoutSpecialConfirmation;

  if (itemCount > batchPolicy.maxItemsAbsolute) {
    return {
      ...withPolicy(base, batchPolicy),
      ok: false,
      reason: 'too_large_batch',
      requiresSpecialConfirmation,
      requiresDiffPreview: batchPolicy.requiresDiffPreview,
      requiredTypedConfirmationText,
    };
  }

  if (
    input.stage !== 'proposal'
    && batchPolicy.requiresDiffPreview
    && (input.diffPreviewItemCount ?? 0) < itemCount
  ) {
    return {
      ...withPolicy(base, batchPolicy),
      ok: false,
      reason: 'diff_preview_required',
      requiresSpecialConfirmation,
      requiresDiffPreview: true,
      requiredTypedConfirmationText,
    };
  }

  if (
    input.stage === 'confirmation'
    && requiresSpecialConfirmation
    && requiredTypedConfirmationText
    && normalizeConfirmation(input.typedConfirmationText) !== normalizeConfirmation(requiredTypedConfirmationText)
  ) {
    return {
      ...withPolicy(base, batchPolicy),
      ok: false,
      reason: 'typed_confirmation_required',
      requiresSpecialConfirmation: true,
      requiresDiffPreview: batchPolicy.requiresDiffPreview,
      requiredTypedConfirmationText,
    };
  }

  return {
    ...withPolicy(base, batchPolicy),
    ok: true,
    reason: 'batch_allowed',
    requiresSpecialConfirmation,
    requiresDiffPreview: batchPolicy.requiresDiffPreview,
    requiredTypedConfirmationText: requiresSpecialConfirmation ? requiredTypedConfirmationText : undefined,
  };
}

function withPolicy(
  base: Pick<ChatCoreV2BatchPolicyVerdict, 'policyVersion' | 'capabilityId' | 'itemCount' | 'stage'>,
  batchPolicy: BatchPolicy,
) {
  return {
    ...base,
    maxItemsAbsolute: batchPolicy.maxItemsAbsolute,
    maxItemsWithoutSpecialConfirmation: batchPolicy.maxItemsWithoutSpecialConfirmation,
  };
}

function renderTypedConfirmationText(batchPolicy: BatchPolicy, itemCount: number): string | undefined {
  return batchPolicy.requiresTypedConfirmationText?.replace(/\{count\}/g, String(itemCount));
}

function normalizeConfirmation(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}
