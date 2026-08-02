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
  | 'portal_operator';

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

/**
 * Actions safe to expose on a lock screen: they navigate or change local
 * notification lifecycle only, never domain state. `reconnect` qualifies
 * because it opens connection settings — the provider re-auth itself still
 * happens in the app, behind normal authentication.
 */
export const SAFE_GENERIC_NOTIFICATION_ACTIONS = ['open_detail', 'dismiss', 'snooze', 'reconnect'] as const;

const DEFAULT_APNS_CATEGORY_ACTIONS: Record<string, readonly string[]> = {
  decision_required: ['open_detail', 'dismiss'],
  reminder: ['open_detail', 'snooze', 'dismiss'],
  approval_required: ['open_detail', 'dismiss'],
  risk_warning: ['open_detail', 'dismiss'],
  DECISION_SCHEDULE_CONFLICT: ['snooze', 'open_detail'],
  DECISION_APPROVAL: ['open_detail'],
  DECISION_SYNC_ISSUE: ['open_detail'],
  DECISION_RECONNECT: ['reconnect', 'open_detail'],
  FINANCE_PAYMENT: ['open_detail', 'dismiss'],
  DECISION_CLARIFICATION: ['open_detail', 'dismiss'],
};

let apnsCategoryActionOverridesForTests: Record<string, readonly string[]> | null = null;

const MUTATING_NOTIFICATION_ACTIONS = new Set([
  'approve_script',
  'request_rewrite',
  'accept_reflow',
  'choose_another_time',
  'retry',
  'option_a',
  'option_b',
  'mark_paid',
  'add_meal',
  'undo_reflow',
  'accept_chat_action_fix',
  'activate_training_plan_revision',
  'approve_product_learning_case',
]);

const BASE_ACTIONS_BY_TYPE: Record<NotificationIntentType, string[]> = {
  decision_required: ['open_detail', 'dismiss'],
  conflict_detected: ['accept_reflow', 'choose_another_time', 'open_detail', 'snooze'],
  schedule_changed: ['open_detail'],
  reminder: ['open_detail', 'snooze', 'dismiss'],
  missed_item: ['open_detail', 'dismiss'],
  reflow_suggestion: ['accept_reflow', 'choose_another_time', 'open_detail', 'dismiss'],
  approval_required: ['open_detail'],
  risk_warning: ['open_detail', 'dismiss'],
  daily_digest: ['open_detail'],
  weekly_review: ['open_detail'],
  security_account: ['open_detail'],
  // `retry` was advertised here for every broken connection but its executor is
  // implemented:false, so the primary CTA rendered permanently greyed — and
  // because sync_failure is floored to `high`, those dead cards were pinned to
  // the top of the Decision Center and exempt from the fatigue cap.
  // `reconnect` is navigation, not a provider mutation, so it needs no
  // executor and is honest about what tapping it does.
  sync_failure: ['reconnect', 'open_detail'],
  insight: ['open_detail'],
};

export function resolveNotificationContract(input: {
  sourceSkill: NotificationSourceSkill;
  type: NotificationIntentType;
  entityType?: string | null;
  entityId?: string | number | null;
  recipe?: string | null;
  actionId?: string | null;
  deeplink?: string | null;
}): NotificationContract {
  const supportedActions = supportedActionsFor(input.sourceSkill, input.type);
  const actionId = input.actionId && supportedActions.includes(input.actionId) ? input.actionId : null;
  const recipe = normalizeRecipe(input.recipe);
  const entityType = normalizeEntity(input.entityType);
  const crossSkillImpact = recipe === 'cross_skill_impact'
    || entityType === 'cross_skill_impact'
    || entityType === 'cross_skill_coordination';
  const apnsCategory = apnsCategoryFor(input.type, input.sourceSkill, actionId, input.deeplink);

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
  if (sourceSkill === 'secretary' && type === 'decision_required') {
    return ['choose_priority', 'open_detail', 'dismiss'];
  }
  if (sourceSkill === 'finance' && type === 'decision_required') {
    return ['mark_paid', 'open_detail', 'dismiss'];
  }
  if (sourceSkill === 'cooking' && type === 'decision_required') {
    return ['add_meal', 'open_detail', 'dismiss'];
  }
  if (sourceSkill === 'content' && type === 'approval_required') {
    return ['approve_script', 'request_rewrite', 'open_detail'];
  }
  if (sourceSkill === 'training' && type === 'approval_required') {
    return ['activate_training_plan_revision', 'approve_product_learning_case', 'open_detail'];
  }
  if (sourceSkill === 'chat' && type === 'decision_required') {
    return ['option_a', 'option_b', 'accept_chat_action_fix', 'open_detail', 'dismiss'];
  }
  if (type === 'sync_failure') {
    return ['reconnect', 'open_detail'];
  }
  return BASE_ACTIONS_BY_TYPE[type] ?? ['open_detail'];
}

export function isNotificationActionMutating(actionId: string): boolean {
  return MUTATING_NOTIFICATION_ACTIONS.has(actionId);
}

export function isSafeGenericNotificationAction(actionId: string): boolean {
  return (SAFE_GENERIC_NOTIFICATION_ACTIONS as readonly string[]).includes(actionId);
}

export function listNotificationApnsActionExposures(): Array<{ apnsCategory: string; actionId: string }> {
  const categories = apnsCategoryActionOverridesForTests ?? DEFAULT_APNS_CATEGORY_ACTIONS;
  return Object.entries(categories).flatMap(([apnsCategory, actions]) => actions.map((actionId) => ({ apnsCategory, actionId })));
}

export function __setNotificationApnsCategoryActionOverridesForTests(overrides: Record<string, readonly string[]> | null): void {
  apnsCategoryActionOverridesForTests = overrides;
}

export function deliveryPolicyForNotificationContract(contract: NotificationContract): NotificationDeliveryPolicy {
  if (contract.defaultDelivery.includes('portal_operator')) return 'portal_only';
  if (contract.defaultDelivery.includes('digest') && !contract.defaultDelivery.includes('push')) return 'digest_only';
  // `insight` is the one type that must never interrupt. Its contract already
  // says so — defaultDeliveryFor returns ['in_app','inbox_history'] with no
  // push — but the resolver fell through to 'auto', so active-priority
  // insights pushed anyway and silently overrode their own contract. That leak
  // is why background jobs announcing their own success ("N invoices filed",
  // "N channels analysed", "coach report deferred") reached the lock screen.
  //
  // Scoped to `insight` deliberately: other types also omit `push` from
  // defaultDelivery (reminder, schedule_changed, missed_item) but legitimately
  // push under 'auto'. For those, defaultDelivery lists guaranteed channels
  // rather than the full permitted set.
  if (contract.type === 'insight') return 'digest_only';
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

function apnsCategoryFor(
  type: NotificationIntentType,
  sourceSkill: NotificationSourceSkill,
  actionId: string | null,
  deeplink: string | null | undefined,
): string {
  if (sourceSkill === 'finance' && type === 'decision_required') return 'FINANCE_PAYMENT';
  if (type === 'approval_required' && sourceSkill !== 'content') return 'DECISION_CLARIFICATION';
  // `sync_failure` is broader than a broken provider connection (invoice and
  // content jobs use it too). A reconnect button is therefore valid only when
  // the persisted action and its foreground route both say "connections".
  if (type === 'sync_failure' && actionId === 'reconnect' && isConnectionsDeeplink(deeplink)) {
    return 'DECISION_RECONNECT';
  }
  if (DECISION_TYPES.has(type)) return DECISION_APNS_CATEGORIES[type] ?? 'DECISION_CLARIFICATION';
  return type;
}

function isConnectionsDeeplink(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol.toLowerCase() === 'nexus:' && url.hostname.toLowerCase() === 'connections';
  } catch {
    return false;
  }
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
