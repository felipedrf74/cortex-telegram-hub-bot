// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { updateChatActionRun, type ChatActionRunStatus } from '../../chat-action-run-store';
import { upsertPendingChatAction } from '../../chat-action-state';
import type { ChatActionPlan, ChatPlannerInput, ChatPlanStep } from '../../chat/types';
import { calendarSourceFromProvider, claimActionRunForStepExecution, reconciliationPendingResult, updateClaimedActionRun, withProviderWriteTimeout } from '../../chat/executor/helpers';
import { getActivePlanSummary, getPlanById, getSessionById } from '../../training-plans';
import { missingTrainingPlanSlots } from './helpers';
import { confirmTrainingSessionReflow, previewTrainingSessionReflow } from '../../../api/routes/training-plan-calendar-sync';

function validTenantId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function trainingTenantIdForInput(input: ChatPlannerInput): number | null {
  return validTenantId(input.tenantId) ? input.tenantId : null;
}

export function executeTrainingCoachReportStep(
  step: ChatPlanStep,
  input: ChatPlannerInput,
): { step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string } {
  const tenantId = trainingTenantIdForInput(input);
  if (!tenantId) {
    return { step, status: 'blocked', error: 'training_tenant_scope_required' };
  }
  try {
    const summary = getActivePlanSummary(input.userId, tenantId);
    return { step, status: 'verified_success', result: { summary: summary || 'No active training plan found.' } };
  } catch {
    return { step, status: 'failed', error: 'training_summary_failed' };
  }
}

export function executeTrainingExplainSessionStep(
  step: ChatPlanStep,
  input: ChatPlannerInput,
): { step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string } {
  const tenantId = trainingTenantIdForInput(input);
  if (!tenantId) {
    return { step, status: 'blocked', error: 'training_tenant_scope_required' };
  }
  const sessionId = Number((step.args as any).sessionId);
  if (!Number.isInteger(sessionId) || sessionId <= 0) return { step, status: 'blocked', error: 'training_session_id_required' };
  try {
    const session = getSessionById(sessionId);
    if (!session) return { step, status: 'blocked', error: 'training_session_not_found' };
    const plan = getPlanById(session.plan_id);
    const planTenantId = typeof plan?.tenant_id === 'number' && plan.tenant_id > 0 ? plan.tenant_id : plan?.user_id;
    if (!plan || plan.user_id !== input.userId || planTenantId !== tenantId) {
      return { step, status: 'blocked', error: 'training_session_not_found_or_unauthorized' };
    }
    return {
      step,
      status: 'verified_success',
      result: {
        sessionId,
        title: session.title,
        sessionType: session.session_type,
        durationMinutes: session.duration_minutes,
        intensity: session.intensity_text,
        status: session.status,
      },
    };
  } catch {
    return { step, status: 'failed', error: 'training_session_read_failed' };
  }
}

export function executeTrainingPlanCreateStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  persistRuns: boolean,
): { step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string } {
  const args = step.args as Record<string, unknown>;
  const missing = missingTrainingPlanSlots(args);
  if (!persistRuns) {
    return {
      step,
      status: 'verified_pending',
      result: {
        pendingActionId: null,
        missingSlots: missing,
        collectedSlots: args,
        openSurface: 'training_plan_builder',
        verified: false,
      },
    };
  }
  const pending = upsertPendingChatAction({
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    skill: 'training',
    action: 'training_plan_create',
    collectedSlots: args,
    missingSlots: missing,
    riskClass: 'R1',
    locale: input.locale || 'pt-BR',
    timezone: input.timezone,
    originatingSurface: input.channel,
    nowIso: plan.createdAt,
  });
  const claim = claimActionRunForStepExecution(step, plan, input, persistRuns);
  if (!updateClaimedActionRun(claim, 'verified_pending', {
    result: {
      pendingActionId: pending.id,
      missingSlots: missing,
      collectedSlots: args,
      openSurface: 'training_plan_builder',
    },
    providerObjectId: pending.id,
    verification: { verified: false, reason: 'ui_handoff_required', pendingActionId: pending.id },
  })) return reconciliationPendingResult(step, 'verified_pending');
  return {
    step,
    status: 'verified_pending',
    result: {
      pendingActionId: pending.id,
      missingSlots: missing,
      collectedSlots: args,
      openSurface: 'training_plan_builder',
      verified: false,
    },
  };
}

export async function executeTrainingReflowStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  persistRuns: boolean,
  confirmed: boolean,
): Promise<{ step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string }> {
  const args = step.args as any;
  const sessionId = Number(args.sessionId);
  if (!Number.isInteger(sessionId) || sessionId <= 0) return { step, status: 'blocked', error: 'training_session_id_required' };
  const source = calendarSourceFromProvider(args.provider ?? step.provider);
  const claim = claimActionRunForStepExecution(step, plan, input, persistRuns);
  if (claim && !claim.acquired && claim.row.status === 'verified_success') {
    return { step, status: 'verified_success', result: claim.row.result_json ? JSON.parse(claim.row.result_json) : { replayed: true } };
  }
  try {
    if (step.action === 'training_reflow_preview') {
      const preview = await withProviderWriteTimeout(() => previewTrainingSessionReflow(input.userId, sessionId, source, input.tenantId));
      const verified = preview.status === 'preview';
      const status: ChatActionRunStatus = verified ? 'verified_success' : preview.status === 'blocked' || preview.status === 'forbidden' || preview.status === 'not_found' || preview.status === 'no_calendar' ? 'blocked' : 'failed';
      if (!updateClaimedActionRun(claim, status, {
        result: preview,
        providerObjectId: String(sessionId),
        verification: { verified, expected: { sessionId } },
      })) return reconciliationPendingResult(step, status);
      return { step, status, result: preview, error: verified ? undefined : preview.data.reason ?? preview.status };
    }
    if (!confirmed) {
      return { step, status: 'needs_confirmation', error: 'confirmation_required' };
    }
    const confirmedReflow = await withProviderWriteTimeout((signal) => confirmTrainingSessionReflow({
      userId: input.userId,
      tenantId: input.tenantId,
      sessionId,
      proposedStartAt: typeof args.proposedStartAt === 'string' ? args.proposedStartAt : typeof args.startDateTime === 'string' ? args.startDateTime : null,
      proposedEndAt: typeof args.proposedEndAt === 'string' ? args.proposedEndAt : typeof args.endDateTime === 'string' ? args.endDateTime : null,
      requestedCalendarSource: source,
      signal,
    }));
    const verified = confirmedReflow.status === 'confirmed' && confirmedReflow.data.verified === true;
    const status: ChatActionRunStatus = verified ? 'verified_success' : confirmedReflow.status === 'partial_failure' ? 'partial_success' : 'blocked';
    if (!updateClaimedActionRun(claim, status, {
      result: confirmedReflow,
      providerObjectId: 'data' in confirmedReflow && 'eventId' in confirmedReflow.data ? confirmedReflow.data.eventId ?? String(sessionId) : String(sessionId),
      verification: { verified, expected: { sessionId } },
    })) return reconciliationPendingResult(step, status);
    return { step, status, result: confirmedReflow, error: verified ? undefined : (confirmedReflow.data as any).reason ?? confirmedReflow.status };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err instanceof Error ? err.message : String(err) } });
    return { step, status: 'failed', error: 'training_reflow_failed' };
  }
}
