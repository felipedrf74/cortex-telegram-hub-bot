// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type {
  NotificationPriority,
  NotificationSourceSkill,
} from './notification-orchestrator';

export interface DecisionActionTruthTableEntry {
  actionType: string;
  expectedMutation: string;
  executor: string;
  verifier: string | null;
  successUi: string;
  partialFailureUi: string;
  failureUi: string;
  retryAvailable: boolean;
  rollbackAvailable: boolean;
  apnsActionAllowed: boolean;
  highRiskConfirmationRequired: boolean;
  analyticsEvent: string;
}

interface DecisionActionTruthTemplate {
  executor: string;
  verifier: string | null;
  implemented: boolean;
  mutating: boolean;
  expectedMutation: string;
  successUi: string;
  retryAvailable: boolean;
  apnsActionAllowed: boolean;
  highRiskConfirmationRequired: boolean;
}

const ACTION_TRUTH_TABLE: Record<string, DecisionActionTruthTemplate> = {
  open_detail: {
    executor: 'decision-center',
    verifier: null,
    implemented: true,
    mutating: false,
    expectedMutation: 'Open detail only; no backend mutation.',
    successUi: 'Decision details opened.',
    retryAvailable: false,
    apnsActionAllowed: true,
    highRiskConfirmationRequired: false,
  },
  dismiss: {
    executor: 'decision-center',
    verifier: 'notification_center_items.status',
    implemented: true,
    mutating: true,
    expectedMutation: 'Dismiss the decision and keep the decision log.',
    successUi: 'Decision dismissed.',
    retryAvailable: false,
    apnsActionAllowed: false,
    highRiskConfirmationRequired: false,
  },
  reject_reflow: {
    executor: 'decision-center',
    verifier: 'notification_center_items.status',
    implemented: true,
    mutating: true,
    expectedMutation: 'Decline the recommendation and dismiss the decision.',
    successUi: 'Recommendation declined.',
    retryAvailable: false,
    apnsActionAllowed: false,
    highRiskConfirmationRequired: true,
  },
  not_now: {
    executor: 'decision-center',
    verifier: 'notification_center_items.status',
    implemented: true,
    mutating: true,
    expectedMutation: 'Dismiss the decision for now.',
    successUi: 'Decision dismissed for now.',
    retryAvailable: false,
    apnsActionAllowed: false,
    highRiskConfirmationRequired: false,
  },
  snooze: {
    executor: 'decision-center',
    verifier: 'notification_center_items.status',
    implemented: true,
    mutating: true,
    expectedMutation: 'Snooze the decision until a later window.',
    successUi: 'Decision snoozed.',
    retryAvailable: false,
    apnsActionAllowed: false,
    highRiskConfirmationRequired: false,
  },
  approve_script: {
    executor: 'content',
    verifier: 'content_workflow_object_approval_state',
    implemented: true,
    mutating: true,
    expectedMutation: 'Update the content workflow object approval state.',
    successUi: 'Content workflow updated.',
    retryAvailable: true,
    apnsActionAllowed: false,
    highRiskConfirmationRequired: true,
  },
  request_rewrite: {
    executor: 'content',
    verifier: 'content_workflow_object_approval_state',
    implemented: true,
    mutating: true,
    expectedMutation: 'Update the content workflow object rewrite state.',
    successUi: 'Rewrite requested.',
    retryAvailable: true,
    apnsActionAllowed: false,
    highRiskConfirmationRequired: true,
  },
  accept_reflow: {
    executor: 'secretary',
    verifier: 'secretary_agenda_item_state',
    implemented: true,
    mutating: true,
    expectedMutation: 'Apply the Secretary agenda reflow and verify the persisted agenda item.',
    successUi: 'Schedule reflow applied.',
    retryAvailable: true,
    apnsActionAllowed: false,
    highRiskConfirmationRequired: true,
  },
  choose_another_time: {
    executor: 'secretary',
    verifier: 'secretary_agenda_item_state',
    implemented: true,
    mutating: true,
    expectedMutation: 'Apply the selected alternate Secretary agenda window.',
    successUi: 'Alternate time applied.',
    retryAvailable: true,
    apnsActionAllowed: false,
    highRiskConfirmationRequired: true,
  },
  undo_reflow: {
    executor: 'secretary',
    verifier: 'secretary_agenda_item_state',
    implemented: true,
    mutating: true,
    expectedMutation: 'Rollback a previously verified Secretary reflow.',
    successUi: 'Schedule rollback applied.',
    retryAvailable: true,
    apnsActionAllowed: false,
    highRiskConfirmationRequired: true,
  },
  mark_paid: {
    executor: 'finance',
    verifier: 'finance_state',
    implemented: true,
    mutating: true,
    expectedMutation: 'Mark the scoped finance item paid or complete.',
    successUi: 'Finance state updated.',
    retryAvailable: true,
    apnsActionAllowed: false,
    highRiskConfirmationRequired: true,
  },
  add_meal: {
    executor: 'cooking',
    verifier: 'meal_plan_state',
    implemented: true,
    mutating: true,
    expectedMutation: 'Add or update the scoped meal plan slot.',
    successUi: 'Meal plan updated.',
    retryAvailable: true,
    apnsActionAllowed: false,
    highRiskConfirmationRequired: false,
  },
  option_a: {
    executor: 'chat',
    verifier: 'chat_pending_confirmation_store',
    implemented: true,
    mutating: true,
    expectedMutation: 'Resolve the scoped pending chat confirmation with option A.',
    successUi: 'Chat choice saved.',
    retryAvailable: true,
    apnsActionAllowed: false,
    highRiskConfirmationRequired: false,
  },
  option_b: {
    executor: 'chat',
    verifier: 'chat_pending_confirmation_store',
    implemented: true,
    mutating: true,
    expectedMutation: 'Resolve the scoped pending chat confirmation with option B.',
    successUi: 'Chat choice saved.',
    retryAvailable: true,
    apnsActionAllowed: false,
    highRiskConfirmationRequired: false,
  },
  accept_chat_action_fix: {
    executor: 'chat-action-fixer',
    verifier: 'notification_center_items.status',
    implemented: true,
    mutating: true,
    expectedMutation: 'Record user acceptance of a proposed chat-action correction; no provider action is executed.',
    successUi: 'Correction accepted for a fresh chat retry.',
    retryAvailable: false,
    apnsActionAllowed: false,
    highRiskConfirmationRequired: false,
  },
  retry: {
    executor: 'provider-sync',
    verifier: 'provider_sync_state',
    implemented: false,
    mutating: true,
    expectedMutation: 'Retry the provider sync after a deterministic provider executor is wired.',
    successUi: 'Sync retry completed.',
    retryAvailable: false,
    apnsActionAllowed: false,
    highRiskConfirmationRequired: false,
  },
  choose_priority: {
    executor: 'secretary',
    verifier: 'secretary_agenda_item_state',
    implemented: false,
    mutating: true,
    expectedMutation: 'Persist an overcapacity priority choice after a deterministic Secretary executor is wired.',
    successUi: 'Priority choice saved.',
    retryAvailable: false,
    apnsActionAllowed: false,
    highRiskConfirmationRequired: true,
  },
};

export function isDecisionActionExecutable(actionId: string): boolean {
  return ACTION_TRUTH_TABLE[actionId]?.implemented === true;
}

export function listDecisionActionTruthTable(): ReadonlyArray<DecisionActionTruthTemplate & { actionType: string }> {
  return Object.entries(ACTION_TRUTH_TABLE).map(([actionType, entry]) => ({ actionType, ...entry }));
}

export function buildDecisionActionTruthTableEntry(input: {
  actionId: string;
  sourceSkill: NotificationSourceSkill;
  expectedEffect: string;
  readBackVerifier: string | null;
  outcomeSummary: string | null;
  rollbackAvailable: boolean;
  notificationCanAct: boolean;
  riskIfIgnored: 'low' | 'medium' | 'high';
  priority: NotificationPriority;
}): DecisionActionTruthTableEntry {
  const template = ACTION_TRUTH_TABLE[input.actionId] ?? {
    executor: 'unsupported',
    verifier: null,
    implemented: false,
    mutating: true,
    expectedMutation: 'Unsupported decision action; no backend mutation is allowed.',
    successUi: 'Action unavailable.',
    retryAvailable: false,
    apnsActionAllowed: false,
    highRiskConfirmationRequired: true,
  };
  const mutating = template.mutating;
  const implemented = template.implemented;
  const verifier = mutating && implemented
    ? input.readBackVerifier ?? template.verifier
    : null;

  return {
    actionType: input.actionId,
    expectedMutation: mutating && implemented
      ? input.expectedEffect
      : template.expectedMutation,
    executor: template.executor,
    verifier,
    successUi: implemented
      ? input.outcomeSummary ?? template.successUi
      : 'Action unavailable until a deterministic executor is wired.',
    partialFailureUi: implemented
      ? 'Nexus will show what changed and what still needs retry.'
      : 'Not applicable; the action is disabled before execution.',
    failureUi: implemented
      ? 'Nexus keeps the decision visible with a retry option and the server error.'
      : 'Action disabled because Nexus cannot verify this mutation yet.',
    retryAvailable: implemented && template.retryAvailable,
    rollbackAvailable: implemented && input.rollbackAvailable,
    apnsActionAllowed: implemented && template.apnsActionAllowed && input.notificationCanAct && input.riskIfIgnored !== 'high',
    highRiskConfirmationRequired: template.highRiskConfirmationRequired || input.riskIfIgnored === 'high' || input.priority === 'critical' || input.priority === 'time_sensitive',
    analyticsEvent: `decision_action:${input.sourceSkill}:${input.actionId}`,
  };
}
