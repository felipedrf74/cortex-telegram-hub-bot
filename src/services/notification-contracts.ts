// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type {
  NotificationDeliveryPolicy,
  NotificationIntentType,
  NotificationPrivacyPolicy,
  NotificationSourceSkill,
} from './notification-orchestrator';

export type NotificationDeliveryChannel =
  | 'in_app'
  | 'inbox_history'
  | 'push'
  | 'digest'
  | 'local'
  | 'portal_operator'
  | 'legacy_telegram';

export interface NotificationContract {
  topic: {
    sourceSkill: NotificationSourceSkill;
    entityType: string | null;
    entityId: string | null;
    recipe: string | null;
  };
  sourceSkill: NotificationSourceSkill;
  type: NotificationIntentType;
  actionId: string | null;
  apnsCategory: string;
  iosDestination: string;
  privacySafeCopyPolicy: NotificationPrivacyPolicy;
  defaultDelivery: NotificationDeliveryChannel[];
  contributesToBadge: boolean;
  supportedActions: string[];
}

const DECISION_APNS_CATEGORIES: Partial<Record<NotificationIntentType, string>> = {
  conflict_detected: 'DECISION_SCHEDULE_CONFLICT',
  reflow_suggestion: 'DECISION_SCHEDULE_CONFLICT',
  approval_required: 'DECISION_APPROVAL',
  sync_failure: 'DECISION_SYNC_ISSUE',
};

const DECISION_TYPES = new Set<NotificationIntentType>([
  'decision_required',
  'conflict_detected',
  'reflow_suggestion',
  'approval_required',
  'sync_failure',
  'security_account',
]);

export const NON_BADGE_NOTIFICATION_TYPES: readonly NotificationIntentType[] = [
  'daily_digest',
  'weekly_review',
  'insight',
];

const NON_BADGE_NOTIFICATION_TYPE_SET = new Set<NotificationIntentType>(NON_BADGE_NOTIFICATION_TYPES);

const BASE_ACTIONS_BY_TYPE: Record<NotificationIntentType, string[]> = {
  decision_required: ['open_detail', 'dismiss'],
  conflict_detected: ['accept_reflow', 'choose_another_time', 'open_detail', 'snooze'],
  schedule_changed: ['open_detail'],
  reminder: ['mark_done', 'snooze', 'open_detail', 'dismiss'],
  missed_item: ['open_detail', 'dismiss'],
  reflow_suggestion: ['accept_reflow', 'choose_another_time', 'open_detail', 'dismiss'],
  approval_required: ['open_detail'],
  risk_warning: ['open_detail', 'dismiss'],
  daily_digest: ['open_detail'],
  weekly_review: ['open_detail'],
  security_account: ['open_detail'],
  sync_failure: ['retry', 'open_detail'],
  insight: ['open_detail'],
};

export function resolveNotificationContract(input: {
  sourceSkill: NotificationSourceSkill;
  type: NotificationIntentType;
  entityType?: string | null;
  entityId?: string | number | null;
  recipe?: string | null;
  actionId?: string | null;
}): NotificationContract {
  const supportedActions = supportedActionsFor(input.sourceSkill, input.type);
  const actionId = input.actionId && supportedActions.includes(input.actionId) ? input.actionId : null;
  const recipe = normalizeRecipe(input.recipe);
  const entityType = normalizeEntity(input.entityType);
  const crossSkillImpact = recipe === 'cross_skill_impact'
    || entityType === 'cross_skill_impact'
    || entityType === 'cross_skill_coordination';
  const apnsCategory = apnsCategoryFor(input.type, input.sourceSkill);

  return {
    topic: {
      sourceSkill: input.sourceSkill,
      entityType,
      entityId: input.entityId == null ? null : String(input.entityId),
      recipe,
    },
    sourceSkill: input.sourceSkill,
    type: input.type,
    actionId,
    apnsCategory,
    iosDestination: iosDestinationFor(input.type, input.sourceSkill, crossSkillImpact),
    privacySafeCopyPolicy: privacySafeCopyPolicyFor(input.sourceSkill),
    defaultDelivery: defaultDeliveryFor(input.type, crossSkillImpact),
    contributesToBadge: contributesToBadge(input.type),
    supportedActions,
  };
}

function supportedActionsFor(sourceSkill: NotificationSourceSkill, type: NotificationIntentType): string[] {
  if (sourceSkill === 'finance' && type === 'reminder') {
    return ['mark_paid', 'open_detail', 'dismiss'];
  }
  if (sourceSkill === 'content' && type === 'approval_required') {
    return ['approve_script', 'request_rewrite', 'open_detail'];
  }
  if (type === 'sync_failure') {
    return ['retry', 'open_detail'];
  }
  return BASE_ACTIONS_BY_TYPE[type] ?? ['open_detail'];
}

export function deliveryPolicyForNotificationContract(contract: NotificationContract): NotificationDeliveryPolicy {
  if (contract.defaultDelivery.includes('portal_operator')) return 'portal_only';
  if (contract.defaultDelivery.includes('digest') && !contract.defaultDelivery.includes('push')) return 'digest_only';
  return 'auto';
}

function iosDestinationFor(type: NotificationIntentType, sourceSkill: NotificationSourceSkill, crossSkillImpact: boolean): string {
  if (crossSkillImpact) return 'coordinated_plan';
  if (DECISION_TYPES.has(type)) return 'decision_center';
  if (type === 'daily_digest' || type === 'weekly_review') return 'report_detail';
  if (sourceSkill === 'content') return 'content_home';
  if (sourceSkill === 'training') return 'training_home';
  if (sourceSkill === 'finance') return 'finance_home';
  return 'notification_detail';
}

function apnsCategoryFor(type: NotificationIntentType, sourceSkill: NotificationSourceSkill): string {
  if (sourceSkill === 'finance' && type === 'reminder') return 'FINANCE_PAYMENT';
  if (DECISION_TYPES.has(type)) return DECISION_APNS_CATEGORIES[type] ?? 'DECISION_CLARIFICATION';
  return type;
}

function privacySafeCopyPolicyFor(sourceSkill: NotificationSourceSkill): NotificationPrivacyPolicy {
  switch (sourceSkill) {
    case 'finance':
      return 'financial';
    case 'training':
      return 'health';
    case 'content':
      return 'private_content';
    case 'security':
      return 'sensitive';
    case 'system':
      return 'public';
    default:
      return 'standard';
  }
}

function defaultDeliveryFor(type: NotificationIntentType, crossSkillImpact: boolean): NotificationDeliveryChannel[] {
  if (crossSkillImpact) return ['in_app', 'inbox_history', 'digest'];
  if (type === 'daily_digest' || type === 'weekly_review') return ['in_app', 'inbox_history', 'digest'];
  if (type === 'insight') return ['in_app', 'inbox_history'];
  if (DECISION_TYPES.has(type)) return ['in_app', 'inbox_history', 'push'];
  return ['in_app', 'inbox_history'];
}

function contributesToBadge(type: NotificationIntentType): boolean {
  return !NON_BADGE_NOTIFICATION_TYPE_SET.has(type);
}

function normalizeRecipe(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed || null;
}

function normalizeEntity(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed || null;
}
