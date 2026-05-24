// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  findChatActionDefinition,
  riskClassForRisk,
  type ChatProvider,
} from '../registry';
import type { ChatActionRiskClass } from '../../chat-action-state';
import type {
  ChatActionPlan,
  ChatPlanStep,
} from '../types';

export function normalizeProvider(value: unknown): ChatProvider | undefined {
  if (typeof value !== 'string') return undefined;
  if (value === 'google_calendar' || value === 'outlook_calendar' || value === 'gmail' || value === 'outlook_mail' || value === 'nexus' || value === 'stripe' || value === 'telegram' || value === 'none') {
    return value;
  }
  return undefined;
}

export function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.4;
  return Math.max(0, Math.min(1, value));
}

export function stepRequiresConfirmation(
  step: ChatPlanStep,
  opts: { requireSafeWrites?: boolean } = {},
): boolean {
  if (
    step.risk === 'ambiguous' &&
    step.requiredArgsPresent === false &&
    typeof step.args?.rejectionReason === 'string'
  ) {
    return false;
  }
  const definition = findChatActionDefinition(step.skill, step.action);
  if (opts.requireSafeWrites && step.risk === 'safe_write') return true;
  return ['external_side_effect', 'destructive', 'financial', 'admin_security'].includes(step.risk)
    || definition?.confirmationPolicy === 'confirm'
    || definition?.confirmationPolicy === 'strong_confirm';
}

export function intentClassForPlan(plan: ChatActionPlan): string {
  const action = plan.steps[0]?.action;
  switch (action) {
    case 'create_task':
    case 'create_task_with_subtasks':
      return 'task_create';
    case 'add_subtasks_to_task':
      return 'task_update';
    case 'delete_task':
      return 'task_delete';
    case 'complete_task':
      return 'task_complete';
    case 'update_task':
      return 'task_update';
    case 'schedule_event':
      return 'event_create';
    case 'move_event':
    case 'update_event':
      return 'event_move';
    case 'delete_event':
      return 'event_delete';
    case 'finance_payment_action':
      return 'financial_transfer';
    case 'finance_create_reminder':
    case 'finance_categorize_receipt':
      return 'finance_write';
    case 'send_email':
      return 'email_send';
    default:
      return action ? String(action).replace(/-/g, '_') : 'chat_action';
  }
}

export function confirmationVariant(plan: ChatActionPlan): 'default' | 'destructive' | 'financial' {
  if (plan.steps.some((step) => step.risk === 'financial')) return 'financial';
  if (plan.steps.some((step) => step.risk === 'destructive' || step.risk === 'admin_security')) return 'destructive';
  return 'default';
}

export function calibratePlanConfidence(steps: ChatPlanStep[], baseConfidence: number): number {
  let score = clampConfidence(baseConfidence);
  for (const step of steps) {
    const missingPenalty = step.requiredArgsPresent ? 0 : 0.28;
    const provenancePenalty = provenanceCoverage(step) >= 0.9 ? 0 : 0.08;
    const riskPenalty = step.riskClass === 'R4' ? 0.35 : 0;
    score = Math.min(score, clampConfidence(score - missingPenalty - provenancePenalty - riskPenalty));
  }
  return Number(score.toFixed(3));
}

export function thresholdForSteps(steps: ChatPlanStep[]): number {
  const riskiest = steps.reduce<ChatActionRiskClass>((current, step) => {
    const candidate = step.riskClass ?? riskClassForRisk(step.risk);
    return riskRank(candidate) > riskRank(current) ? candidate : current;
  }, 'R0');
  if (riskiest === 'R3') return 0.98;
  if (riskiest === 'R2') return 0.96;
  if (riskiest === 'R1') return 0.9;
  if (riskiest === 'R4') return 1;
  return 0.75;
}

function provenanceCoverage(step: ChatPlanStep): number {
  const definition = findChatActionDefinition(step.skill, step.action);
  const required = definition?.requiredFields ?? [];
  if (required.length === 0) return 1;
  const provenance = step.slotProvenance ?? {};
  const present = required.filter((field) => step.args[field] != null && step.args[field] !== '');
  if (present.length === 0) return 0;
  const withProvenance = present.filter((field) => provenance[field]?.validation === 'passed');
  return withProvenance.length / present.length;
}

function riskRank(risk: ChatActionRiskClass): number {
  return { R0: 0, R1: 1, R2: 2, R3: 3, R4: 4 }[risk];
}
