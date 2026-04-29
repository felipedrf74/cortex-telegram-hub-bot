// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  submitSecretarySchedulingIntent,
  type SecretarySchedulingDecision,
  type SecretarySchedulingIntent,
  type SecretaryTimeWindow,
} from './secretary-scheduling-arbitrator';

export type FinanceSecretaryIntentKind =
  | 'bill_reminder'
  | 'budget_review'
  | 'subscription_review'
  | 'purchase_decision_review'
  | 'finance_admin_block';

export interface FinanceSecretarySchedulingInput {
  userId: number;
  tenantId?: number;
  kind: FinanceSecretaryIntentKind;
  entityId: string | number;
  title: string;
  preferredWindows: SecretaryTimeWindow[];
  durationMinutes?: number;
  deadline?: string | null;
  priority?: 'normal' | 'high' | 'urgent';
  context?: string | null;
}

export function submitFinanceSchedulingIntent(
  input: FinanceSecretarySchedulingInput,
): SecretarySchedulingDecision {
  return submitSecretarySchedulingIntent(buildFinanceSchedulingIntent(input));
}

export function buildFinanceSchedulingIntent(
  input: FinanceSecretarySchedulingInput,
): SecretarySchedulingIntent {
  const tenantId = input.tenantId ?? input.userId;
  const action = input.kind === 'bill_reminder' || input.kind === 'subscription_review'
    ? 'create_reminder'
    : 'schedule_this';
  return {
    intentId: `finance:${tenantId}:${input.kind}:${input.entityId}`,
    action,
    sourceSkill: 'finance',
    sourceAction: input.kind,
    sourceEntityId: input.entityId,
    sourceEntityType: input.kind,
    ownerUserId: input.userId,
    tenantId,
    title: input.title,
    requestedDurationMinutes: input.durationMinutes ?? (action === 'create_reminder' ? 15 : 45),
    minimumDurationMinutes: action === 'create_reminder' ? 10 : 30,
    preferredWindows: input.preferredWindows,
    deadline: input.deadline ?? null,
    priority: input.priority ?? (input.deadline ? 'high' : 'normal'),
    flexibility: action === 'create_reminder' ? 'fixed' : 'flexible',
    reason: 'Finance requested Secretary-owned agenda placement.',
    context: input.context ?? null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

