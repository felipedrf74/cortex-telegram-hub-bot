// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';
import { claimChatActionRunForExecution, updateChatActionRun, type ChatActionRunStatus } from '../../chat-action-run-store';
import type { ChatActionPlan, ChatPlannerInput, ChatPlanStep } from '../../chat/types';
import { addTopic, getTopicById } from '../../content-scheduler';
import { buildContentAgencyPackage, getContentAgencyProject, handoffContentAgencyPackageToPipeline, persistContentAgencyArtifact } from '../../content-agency';
import { claimActionRunForStepExecution, reconciliationPendingResult, updateClaimedActionRun } from '../../chat/executor/helpers';

export function executeContentAgencyStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  persistRuns: boolean,
): { step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string } {
  const args = step.args as any;
  const claim = persistRuns ? claimChatActionRunForExecution({
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    normalizedActionHash: step.idempotencyKey,
    provider: 'nexus',
    actionType: step.action,
    risk: step.risk,
    request: step.args,
    nowIso: plan.createdAt,
  }) : null;
  if (claim && !claim.acquired && claim.row.status === 'verified_success') {
    return { step, status: 'verified_success', result: claim.row.result_json ? JSON.parse(claim.row.result_json) : { replayed: true } };
  }
  try {
    const pkg = buildContentAgencyPackage({
      userId: input.userId,
      tenantId: input.tenantId,
      brief: {
        userId: input.userId,
        tenantId: input.tenantId,
        goal: String(args.goal || args.objective || args.topic || 'Create content from chat request'),
        objective: String(args.objective || args.topic || input.text),
        audience: typeof args.audience === 'string' ? args.audience : null,
        platform: typeof args.platform === 'string' ? args.platform : 'generic',
        format: typeof args.format === 'string' ? args.format : null,
        notes: input.text,
      },
    });
    persistContentAgencyArtifact('package', pkg);
    const readBack = getContentAgencyProject({ userId: input.userId, tenantId: input.tenantId, id: pkg.id });
    const verified = readBack?.kind === 'package' && readBack.artifact?.id === pkg.id;
    const result = {
      packageId: pkg.id,
      brief: pkg.brief,
      firstScript: pkg.scriptVariants[0] ?? null,
      quality: pkg.quality,
      verified,
    };
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    if (!updateClaimedActionRun(claim, status, {
      result,
      providerObjectId: pkg.id,
      verification: { verified, expected: { packageId: pkg.id } },
    })) return reconciliationPendingResult(step, status);
    return { step, status, result };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err instanceof Error ? err.message : String(err) } });
    return { step, status: 'failed', error: 'content_agency_package_failed' };
  }
}

export function executeContentScheduleWorkStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  persistRuns: boolean,
): { step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string } {
  const args = step.args as any;
  const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : null;
  const dateTime = typeof args.dateTime === 'string' && args.dateTime.trim() ? DateTime.fromISO(args.dateTime, { zone: input.timezone }) : null;
  if (!title || !dateTime?.isValid) return { step, status: 'blocked', error: 'content_schedule_requires_title_and_datetime' };
  const claim = claimActionRunForStepExecution(step, plan, input, persistRuns);
  if (claim && !claim.acquired && claim.row.status === 'verified_success') {
    return { step, status: 'verified_success', result: claim.row.result_json ? JSON.parse(claim.row.result_json) : { replayed: true } };
  }
  try {
    const topic = addTopic(input.userId, title, {
      notes: typeof args.notes === 'string' ? args.notes : 'Created from Chat action.',
      scheduledDate: dateTime.toISODate(),
      scheduledAt: dateTime.toISO(),
      status: 'planned',
    });
    const readBack = getTopicById(input.userId, topic.id);
    const verified = Boolean(readBack && readBack.title === title && readBack.scheduled_date === dateTime.toISODate());
    const result = { topic: readBack ?? topic, verified };
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    if (!updateClaimedActionRun(claim, status, {
      result,
      providerObjectId: String(topic.id),
      verification: { verified, expected: { title, date: dateTime.toISODate() } },
    })) return reconciliationPendingResult(step, status);
    return { step, status, result, error: verified ? undefined : 'local_read_back_mismatch' };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err instanceof Error ? err.message : String(err) } });
    return { step, status: 'failed', error: 'content_schedule_failed' };
  }
}

export function executeContentPipelineHandoffStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  persistRuns: boolean,
): { step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string } {
  const packageId = typeof (step.args as any).packageId === 'string' ? String((step.args as any).packageId).trim() : '';
  if (!packageId) return { step, status: 'blocked', error: 'content_pipeline_package_id_required' };
  const claim = claimActionRunForStepExecution(step, plan, input, persistRuns);
  if (claim && !claim.acquired && claim.row.status === 'verified_success') {
    return { step, status: 'verified_success', result: claim.row.result_json ? JSON.parse(claim.row.result_json) : { replayed: true } };
  }
  try {
    const handoff = handoffContentAgencyPackageToPipeline({
      userId: input.userId,
      tenantId: input.tenantId,
      packageId,
    });
    const verified = handoff.status === 'created' || handoff.status === 'already_exists';
    const status: ChatActionRunStatus = verified ? 'verified_success' : handoff.status === 'blocked' ? 'blocked' : 'failed';
    if (!updateClaimedActionRun(claim, status, {
      result: handoff,
      providerObjectId: handoff.pipelineId != null ? String(handoff.pipelineId) : packageId,
      verification: { verified, expected: { packageId }, actual: { status: handoff.status, pipelineId: handoff.pipelineId } },
      error: verified ? undefined : { reason: handoff.blockers[0] ?? handoff.status },
    })) return reconciliationPendingResult(step, status);
    return { step, status, result: handoff, error: verified ? undefined : handoff.blockers[0] ?? 'content_pipeline_handoff_failed' };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err instanceof Error ? err.message : String(err) } });
    return { step, status: 'failed', error: 'content_pipeline_handoff_failed' };
  }
}
