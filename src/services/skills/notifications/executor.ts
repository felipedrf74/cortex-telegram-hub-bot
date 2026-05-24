// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { updateChatActionRun, type ChatActionRunStatus } from '../../chat-action-run-store';
import type { ChatActionPlan, ChatPlannerInput, ChatPlanStep } from '../../chat/types';
import { createNotificationIntent, getOrCreateNotificationProfile, updateNotificationProfile } from '../../notification-orchestrator';
import { claimActionRunForStepExecution, reconciliationPendingResult, updateClaimedActionRun, withProviderWriteTimeout } from '../../chat/executor/helpers';

export function executeNotificationExplainStep(
  step: ChatPlanStep,
  input: ChatPlannerInput,
): { step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string } {
  try {
    const profile = getOrCreateNotificationProfile(input.userId, input.tenantId);
    return { step, status: 'verified_success', result: { profile, topic: (step.args as any).topic ?? null } };
  } catch {
    return { step, status: 'failed', error: 'notification_profile_failed' };
  }
}

export async function executeNotificationMutationStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  persistRuns: boolean,
): Promise<{ step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string }> {
  const args = step.args as any;
  const claim = claimActionRunForStepExecution(step, plan, input, persistRuns);
  if (claim && !claim.acquired && claim.row.status === 'verified_success') {
    return { step, status: 'verified_success', result: claim.row.result_json ? JSON.parse(claim.row.result_json) : { replayed: true } };
  }
  try {
    if (step.action === 'notification_update_preference') {
      const patch = typeof args.preference === 'object' && args.preference ? args.preference as Record<string, unknown> : {};
      if (Object.keys(patch).length === 0) return { step, status: 'blocked', error: 'notification_preference_patch_required' };
      const profile = updateNotificationProfile(input.userId, input.tenantId, patch as any);
      const readBack = getOrCreateNotificationProfile(input.userId, input.tenantId);
      const verified = JSON.stringify(profile) === JSON.stringify(readBack);
      const result = { profile: readBack, verified };
      const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
      if (!updateClaimedActionRun(claim, status, { result, verification: { verified } })) return reconciliationPendingResult(step, status);
      return { step, status, result, error: verified ? undefined : 'local_read_back_mismatch' };
    }
    const created = await withProviderWriteTimeout(() => createNotificationIntent({
      userId: input.userId,
      tenantId: input.tenantId,
      sourceSkill: 'chat',
      type: 'reminder',
      priority: 'active',
      title: String(args.title || 'Nexus reminder'),
      body: String(args.body || args.title || 'Nexus reminder'),
      deeplink: null,
      dedupeKey: step.idempotencyKey,
      deliveryPolicy: 'in_app_only',
      privacyPolicy: 'standard',
      requiresUserAction: false,
    }));
    const verified = created.intent?.intentId != null;
    const result = { intentId: created.intent.intentId, notificationId: created.item?.itemId ?? null, verified };
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    if (!updateClaimedActionRun(claim, status, { result, providerObjectId: created.intent.intentId, verification: { verified } })) {
      return reconciliationPendingResult(step, status);
    }
    return { step, status, result, error: verified ? undefined : 'local_read_back_mismatch' };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err instanceof Error ? err.message : String(err) } });
    return { step, status: 'failed', error: 'notification_action_failed' };
  }
}
