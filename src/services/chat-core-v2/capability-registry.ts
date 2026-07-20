// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type {
  ActionRisk,
  AuditSensitivity,
  BatchPolicy,
  CapabilityDefinition,
  CapabilityRolloutStage,
  CapabilitySupportLevel,
  ChatCoreV2Domain,
  ChatCoreV2RouteMethod,
  CommandExecutionMode,
  ConfirmationPolicy,
  ReasoningTier,
  UndoPolicy,
  VerificationMode,
} from './types';
import {
  isChatCoreV2RuntimeFlagEnabled,
  type RuntimeFlagScope,
} from '../runtime-flags';
import { CHAT_CORE_V2_FINANCE_ACTION_POLICY_VERSION } from './finance-action-policy';
import { CHAT_CORE_V2_TRAINING_SAFETY_POLICY_VERSION } from './training-safety-policy';

const SCHEMA_VERSION = 'chat_core_v2_capability@1.0.0';
const TOOL_SCHEMA_SET_VERSION = 'chat_core_v2_tools@1.0.0';
export const CHAT_CORE_V2_GLOBAL_FLAG = 'CHAT_CORE_V2_ENABLED';
export const CHAT_CORE_V2_READS_FLAG = 'CHAT_CORE_V2_READS_ENABLED';
export const CHAT_CORE_V2_WRITES_FLAG = 'CHAT_CORE_V2_WRITES_ENABLED';
export const CHAT_CORE_V2_PREVIEWS_FLAG = 'CHAT_CORE_V2_PREVIEWS_ENABLED';
export const CHAT_CORE_V2_CONFIRMATIONS_FLAG = 'CHAT_CORE_V2_CONFIRMATIONS_ENABLED';
export const CHAT_CORE_V2_RESTRICTED_POLICY_FLAG = 'CHAT_CORE_V2_RESTRICTED_POLICY_ENABLED';

const NO_UNDO: UndoPolicy = {
  supported: false,
  requiresConfirmation: false,
};

const LOW_RISK_BATCH_POLICY: BatchPolicy = {
  maxItemsWithoutSpecialConfirmation: 5,
  maxItemsAbsolute: 25,
  requiresDiffPreview: true,
  requiresTypedConfirmationText: 'Confirm {count} changes',
};

const MEDIUM_RISK_BATCH_POLICY: BatchPolicy = {
  maxItemsWithoutSpecialConfirmation: 1,
  maxItemsAbsolute: 5,
  requiresDiffPreview: true,
  requiresTypedConfirmationText: 'Confirm {count} changes',
};

const RESTRICTED_BATCH_POLICY: BatchPolicy = {
  maxItemsWithoutSpecialConfirmation: 0,
  maxItemsAbsolute: 0,
  requiresDiffPreview: true,
  requiresTypedConfirmationText: 'manual_review_required',
};

function undo(undoCommandType: string, undoWindowSeconds = 300): UndoPolicy {
  return {
    supported: true,
    undoCommandType,
    undoWindowSeconds,
    requiresConfirmation: false,
  };
}

function support(
  read: CapabilitySupportLevel,
  preview: CapabilitySupportLevel,
  execute: CapabilitySupportLevel,
  undoLevel: CapabilitySupportLevel,
): CapabilityDefinition['support'] {
  return { read, preview, execute, undo: undoLevel };
}

function capability(input: {
  capabilityId: string;
  domain: ChatCoreV2Domain;
  commandType?: string;
  routeMethods: ChatCoreV2RouteMethod[];
  support: CapabilityDefinition['support'];
  rolloutStage: CapabilityRolloutStage;
  risk?: ActionRisk;
  ownerService: string;
  requiredPermissions?: string[];
  previewCardType?: string;
  confirmationPolicy?: ConfirmationPolicy;
  undoPolicy?: UndoPolicy;
  verificationMode?: VerificationMode;
  executionMode?: CommandExecutionMode;
  modelVisible?: boolean;
  enabledFlags?: string[];
  sensitivity?: AuditSensitivity;
  fallbackAllowed?: boolean;
  promptFamily?: string;
  reasoningTier?: ReasoningTier;
  batchPolicy?: CapabilityDefinition['batchPolicy'];
  domainSafetyPolicyVersion?: string;
}): CapabilityDefinition {
  const risk = input.risk ?? 'low';
  const readOnly = input.support.execute === 'not_applicable' && input.support.preview === 'not_applicable';
  return {
    capabilityId: input.capabilityId,
    domain: input.domain,
    commandType: input.commandType,
    routeMethods: input.routeMethods,
    support: input.support,
    rolloutStage: input.rolloutStage,
    risk,
    ownerService: input.ownerService,
    requiredPermissions: input.requiredPermissions ?? [`${input.domain}:read`],
    schemaVersion: SCHEMA_VERSION,
    previewCardType: input.previewCardType,
    confirmationPolicy: input.confirmationPolicy ?? (readOnly ? 'never_execute' : 'always_confirm_v1'),
    undoPolicy: input.undoPolicy ?? NO_UNDO,
    verificationMode: input.verificationMode ?? (readOnly ? 'not_verifiable' : 'immediate_read_back'),
    executionMode: input.executionMode ?? 'sync',
    modelVisible: input.modelVisible ?? !readOnly,
    enabledFlags: input.enabledFlags ?? [CHAT_CORE_V2_GLOBAL_FLAG],
    sensitivity: input.sensitivity ?? 'personal',
    fallbackAllowed: input.fallbackAllowed ?? readOnly,
    promptFamily: input.promptFamily ?? `chat_v2_${input.domain}`,
    reasoningTier: input.reasoningTier ?? (readOnly ? 'none' : 'standard_command'),
    toolSchemaSetVersion: TOOL_SCHEMA_SET_VERSION,
    batchPolicy: input.batchPolicy ?? (readOnly ? undefined : defaultBatchPolicy(risk)),
    domainSafetyPolicyVersion: input.domainSafetyPolicyVersion,
  };
}

function defaultBatchPolicy(risk: ActionRisk): BatchPolicy {
  if (risk === 'restricted') return { ...RESTRICTED_BATCH_POLICY };
  if (risk === 'medium' || risk === 'high') return { ...MEDIUM_RISK_BATCH_POLICY };
  return { ...LOW_RISK_BATCH_POLICY };
}

export const CHAT_CORE_V2_CAPABILITIES: CapabilityDefinition[] = [
  capability({
    capabilityId: 'secretary.agenda_summary',
    domain: 'secretary',
    commandType: 'secretary.agenda_summary',
    routeMethods: ['deterministic_read'],
    support: support('supported', 'not_applicable', 'not_applicable', 'not_applicable'),
    rolloutStage: 'mvp_read',
    ownerService: 'secretary-read-model',
    requiredPermissions: ['secretary:read'],
    sensitivity: 'personal',
    fallbackAllowed: true,
    enabledFlags: [CHAT_CORE_V2_GLOBAL_FLAG, CHAT_CORE_V2_READS_FLAG],
    promptFamily: 'chat_v2_secretary',
    reasoningTier: 'none',
  }),
  capability({
    capabilityId: 'tasks.today_summary',
    domain: 'tasks',
    commandType: 'tasks.today_summary',
    routeMethods: ['deterministic_read'],
    support: support('supported', 'not_applicable', 'not_applicable', 'not_applicable'),
    rolloutStage: 'mvp_read',
    ownerService: 'task-read-model',
    requiredPermissions: ['tasks:read'],
    sensitivity: 'personal',
    enabledFlags: [CHAT_CORE_V2_GLOBAL_FLAG, CHAT_CORE_V2_READS_FLAG],
    promptFamily: 'chat_v2_tasks',
  }),
  capability({
    capabilityId: 'training.session_explain',
    domain: 'training',
    commandType: 'training.session_explain',
    routeMethods: ['deterministic_read', 'llm_synthesis'],
    support: support('supported', 'not_applicable', 'not_applicable', 'not_applicable'),
    rolloutStage: 'mvp_read',
    ownerService: 'training-read-model',
    requiredPermissions: ['training:read'],
    sensitivity: 'health_adjacent',
    enabledFlags: [CHAT_CORE_V2_GLOBAL_FLAG, CHAT_CORE_V2_READS_FLAG],
    promptFamily: 'chat_v2_training',
    reasoningTier: 'synthesis',
    domainSafetyPolicyVersion: CHAT_CORE_V2_TRAINING_SAFETY_POLICY_VERSION,
  }),
  capability({
    capabilityId: 'content.pipeline_summary',
    domain: 'content',
    commandType: 'content.pipeline_summary',
    routeMethods: ['deterministic_read'],
    support: support('supported', 'not_applicable', 'not_applicable', 'not_applicable'),
    rolloutStage: 'mvp_read',
    ownerService: 'content-read-model',
    requiredPermissions: ['content:read'],
    enabledFlags: [CHAT_CORE_V2_GLOBAL_FLAG, CHAT_CORE_V2_READS_FLAG],
    promptFamily: 'chat_v2_content',
  }),
  capability({
    capabilityId: 'cooking.meal_plan_summary',
    domain: 'cooking',
    commandType: 'cooking.meal_plan_summary',
    routeMethods: ['deterministic_read'],
    support: support('supported', 'not_applicable', 'not_applicable', 'not_applicable'),
    rolloutStage: 'mvp_read',
    ownerService: 'cooking-read-model',
    requiredPermissions: ['cooking:read'],
    enabledFlags: [CHAT_CORE_V2_GLOBAL_FLAG, CHAT_CORE_V2_READS_FLAG],
    promptFamily: 'chat_v2_cooking',
  }),
  capability({
    capabilityId: 'finance.summary',
    domain: 'finance',
    commandType: 'finance.summary',
    routeMethods: ['deterministic_read'],
    support: support('supported', 'not_applicable', 'not_applicable', 'not_applicable'),
    rolloutStage: 'mvp_read',
    ownerService: 'finance-read-model',
    requiredPermissions: ['finance:read'],
    sensitivity: 'financial',
    enabledFlags: [CHAT_CORE_V2_GLOBAL_FLAG, CHAT_CORE_V2_READS_FLAG],
    promptFamily: 'chat_v2_finance',
    domainSafetyPolicyVersion: CHAT_CORE_V2_FINANCE_ACTION_POLICY_VERSION,
  }),
  capability({
    capabilityId: 'connections.status',
    domain: 'connections',
    commandType: 'connections.status',
    routeMethods: ['deterministic_read'],
    support: support('supported', 'not_applicable', 'not_applicable', 'not_applicable'),
    rolloutStage: 'mvp_read',
    ownerService: 'connections-read-model',
    requiredPermissions: ['connections:read'],
    sensitivity: 'credential_adjacent',
    enabledFlags: [CHAT_CORE_V2_GLOBAL_FLAG, CHAT_CORE_V2_READS_FLAG],
    promptFamily: 'chat_v2_connections',
  }),
  capability({
    capabilityId: 'notifications.summary',
    domain: 'notifications',
    commandType: 'notifications.summary',
    routeMethods: ['deterministic_read'],
    support: support('supported', 'not_applicable', 'not_applicable', 'not_applicable'),
    rolloutStage: 'mvp_read',
    ownerService: 'notification-read-model',
    requiredPermissions: ['notifications:read'],
    enabledFlags: [CHAT_CORE_V2_GLOBAL_FLAG, CHAT_CORE_V2_READS_FLAG],
    promptFamily: 'chat_v2_notifications',
  }),
  capability({
    capabilityId: 'decision_center.summary',
    domain: 'decision_center',
    commandType: 'decision_center.summary',
    routeMethods: ['deterministic_read'],
    support: support('supported', 'not_applicable', 'not_applicable', 'not_applicable'),
    rolloutStage: 'mvp_read',
    ownerService: 'decision-read-model',
    requiredPermissions: ['decision_center:read'],
    enabledFlags: [CHAT_CORE_V2_GLOBAL_FLAG, CHAT_CORE_V2_READS_FLAG],
    promptFamily: 'chat_v2_decision_center',
  }),

  capability({
    capabilityId: 'tasks.create',
    domain: 'tasks',
    commandType: 'tasks.create',
    routeMethods: ['llm_command_translation'],
    support: support('supported', 'supported', 'supported', 'supported'),
    rolloutStage: 'mvp_confirmed_write',
    risk: 'low',
    ownerService: 'task-command-service',
    requiredPermissions: ['tasks:read', 'tasks:write'],
    previewCardType: 'task_preview_card@1.0.0',
    enabledFlags: [CHAT_CORE_V2_GLOBAL_FLAG, CHAT_CORE_V2_WRITES_FLAG],
    undoPolicy: undo('tasks.delete_created'),
    verificationMode: 'immediate_read_back',
    promptFamily: 'chat_v2_tasks',
    reasoningTier: 'fast_extraction',
  }),
  capability({
    capabilityId: 'tasks.complete',
    domain: 'tasks',
    commandType: 'tasks.complete',
    routeMethods: ['llm_command_translation'],
    support: support('supported', 'supported', 'supported', 'supported'),
    rolloutStage: 'mvp_confirmed_write',
    risk: 'low',
    ownerService: 'task-command-service',
    requiredPermissions: ['tasks:read', 'tasks:write'],
    previewCardType: 'task_preview_card@1.0.0',
    enabledFlags: [CHAT_CORE_V2_GLOBAL_FLAG, CHAT_CORE_V2_WRITES_FLAG],
    undoPolicy: undo('tasks.reopen'),
    verificationMode: 'immediate_read_back',
    promptFamily: 'chat_v2_tasks',
    reasoningTier: 'standard_command',
  }),
  capability({
    capabilityId: 'notifications.snooze',
    domain: 'notifications',
    commandType: 'notifications.snooze',
    routeMethods: ['llm_command_translation'],
    support: support('supported', 'supported', 'supported', 'supported'),
    rolloutStage: 'mvp_confirmed_write',
    risk: 'low',
    ownerService: 'notification-command-service',
    requiredPermissions: ['notifications:read', 'notifications:write'],
    previewCardType: 'notification_preview_card@1.0.0',
    enabledFlags: [CHAT_CORE_V2_GLOBAL_FLAG, CHAT_CORE_V2_WRITES_FLAG],
    undoPolicy: undo('notifications.unsnooze'),
    verificationMode: 'immediate_read_back',
    promptFamily: 'chat_v2_notifications',
    reasoningTier: 'standard_command',
  }),
  capability({
    capabilityId: 'decision_center.dismiss',
    domain: 'decision_center',
    commandType: 'decision_center.dismiss',
    routeMethods: ['llm_command_translation'],
    support: support('supported', 'supported', 'supported', 'supported'),
    rolloutStage: 'mvp_confirmed_write',
    risk: 'low',
    ownerService: 'decision-command-service',
    requiredPermissions: ['decision_center:read', 'decision_center:write'],
    previewCardType: 'decision_preview_card@1.0.0',
    enabledFlags: [CHAT_CORE_V2_GLOBAL_FLAG, CHAT_CORE_V2_WRITES_FLAG],
    undoPolicy: undo('decision_center.restore'),
    verificationMode: 'immediate_read_back',
    promptFamily: 'chat_v2_decision_center',
    reasoningTier: 'standard_command',
  }),
  capability({
    capabilityId: 'decision_center.snooze',
    domain: 'decision_center',
    commandType: 'decision_center.snooze',
    routeMethods: ['llm_command_translation'],
    support: support('supported', 'supported', 'supported', 'supported'),
    rolloutStage: 'mvp_confirmed_write',
    risk: 'low',
    ownerService: 'decision-command-service',
    requiredPermissions: ['decision_center:read', 'decision_center:write'],
    previewCardType: 'decision_preview_card@1.0.0',
    enabledFlags: [CHAT_CORE_V2_GLOBAL_FLAG, CHAT_CORE_V2_WRITES_FLAG],
    undoPolicy: undo('decision_center.unsnooze'),
    verificationMode: 'immediate_read_back',
    promptFamily: 'chat_v2_decision_center',
    reasoningTier: 'standard_command',
  }),
  capability({
    capabilityId: 'decision_center.accept_chat_action_fix',
    domain: 'decision_center',
    commandType: 'decision_center.accept_chat_action_fix',
    routeMethods: ['llm_command_translation'],
    support: support('supported', 'supported', 'supported', 'not_applicable'),
    rolloutStage: 'mvp_confirmed_write',
    risk: 'low',
    ownerService: 'chat-action-fixer',
    requiredPermissions: ['decision_center:read', 'decision_center:write'],
    previewCardType: 'decision_preview_card@1.0.0',
    enabledFlags: [CHAT_CORE_V2_GLOBAL_FLAG, CHAT_CORE_V2_WRITES_FLAG],
    verificationMode: 'immediate_read_back',
    modelVisible: false,
    promptFamily: 'chat_v2_decision_center',
    reasoningTier: 'none',
  }),
  capability({
    capabilityId: 'content.approve_script',
    domain: 'content',
    commandType: 'content.approve_script',
    routeMethods: ['llm_command_translation'],
    support: support('supported', 'supported', 'supported', 'not_applicable'),
    rolloutStage: 'mvp_confirmed_write',
    risk: 'medium',
    ownerService: 'content-workspace-decision-adapter',
    requiredPermissions: ['decision_center:read', 'decision_center:write', 'content:read', 'content:write'],
    previewCardType: 'content_brief_preview_card@1.0.0',
    enabledFlags: [CHAT_CORE_V2_GLOBAL_FLAG, CHAT_CORE_V2_WRITES_FLAG],
    verificationMode: 'immediate_read_back',
    modelVisible: false,
    promptFamily: 'chat_v2_content',
    reasoningTier: 'none',
  }),
  capability({
    capabilityId: 'content.request_rewrite',
    domain: 'content',
    commandType: 'content.request_rewrite',
    routeMethods: ['llm_command_translation'],
    support: support('supported', 'supported', 'supported', 'not_applicable'),
    rolloutStage: 'mvp_confirmed_write',
    risk: 'medium',
    ownerService: 'content-workspace-decision-adapter',
    requiredPermissions: ['decision_center:read', 'decision_center:write', 'content:read', 'content:write'],
    previewCardType: 'content_brief_preview_card@1.0.0',
    enabledFlags: [CHAT_CORE_V2_GLOBAL_FLAG, CHAT_CORE_V2_WRITES_FLAG],
    verificationMode: 'immediate_read_back',
    modelVisible: false,
    promptFamily: 'chat_v2_content',
    reasoningTier: 'none',
  }),

  capability({
    capabilityId: 'secretary.schedule_event_preview',
    domain: 'secretary',
    commandType: 'secretary.schedule_event',
    routeMethods: ['llm_command_translation'],
    support: support('supported', 'supported', 'preview_only', 'not_applicable'),
    rolloutStage: 'preview_only',
    risk: 'medium',
    ownerService: 'secretary-command-service',
    requiredPermissions: ['secretary:read'],
    previewCardType: 'calendar_change_preview_card@1.0.0',
    enabledFlags: [CHAT_CORE_V2_GLOBAL_FLAG, CHAT_CORE_V2_PREVIEWS_FLAG],
    verificationMode: 'not_verifiable',
    promptFamily: 'chat_v2_secretary',
    reasoningTier: 'standard_command',
  }),
  capability({
    capabilityId: 'training.modify_session_preview',
    domain: 'training',
    commandType: 'training.modify_session',
    routeMethods: ['llm_command_translation'],
    support: support('supported', 'supported', 'preview_only', 'not_applicable'),
    rolloutStage: 'preview_only',
    risk: 'medium',
    ownerService: 'training-command-service',
    requiredPermissions: ['training:read'],
    previewCardType: 'training_change_preview_card@1.0.0',
    enabledFlags: [CHAT_CORE_V2_GLOBAL_FLAG, CHAT_CORE_V2_PREVIEWS_FLAG],
    verificationMode: 'not_verifiable',
    promptFamily: 'chat_v2_training',
    reasoningTier: 'standard_command',
    sensitivity: 'health_adjacent',
    domainSafetyPolicyVersion: CHAT_CORE_V2_TRAINING_SAFETY_POLICY_VERSION,
  }),
  capability({
    capabilityId: 'cooking.grocery_item_preview',
    domain: 'cooking',
    commandType: 'cooking.grocery_item',
    routeMethods: ['llm_command_translation'],
    support: support('supported', 'supported', 'preview_only', 'not_applicable'),
    rolloutStage: 'preview_only',
    risk: 'low',
    ownerService: 'cooking-command-service',
    requiredPermissions: ['cooking:read'],
    previewCardType: 'grocery_preview_card@1.0.0',
    enabledFlags: [CHAT_CORE_V2_GLOBAL_FLAG, CHAT_CORE_V2_PREVIEWS_FLAG],
    verificationMode: 'not_verifiable',
    promptFamily: 'chat_v2_cooking',
    reasoningTier: 'fast_extraction',
  }),
  capability({
    capabilityId: 'content.brief_draft_preview',
    domain: 'content',
    commandType: 'content.brief_draft',
    routeMethods: ['llm_command_translation', 'llm_synthesis'],
    support: support('supported', 'supported', 'preview_only', 'not_applicable'),
    rolloutStage: 'preview_only',
    risk: 'low',
    ownerService: 'content-command-service',
    requiredPermissions: ['content:read'],
    previewCardType: 'content_brief_preview_card@1.0.0',
    enabledFlags: [CHAT_CORE_V2_GLOBAL_FLAG, CHAT_CORE_V2_PREVIEWS_FLAG],
    verificationMode: 'not_verifiable',
    promptFamily: 'chat_v2_content',
    reasoningTier: 'synthesis',
  }),
  capability({
    capabilityId: 'finance.payment_or_tax_action_blocked',
    domain: 'finance',
    commandType: 'finance.execute_restricted',
    routeMethods: ['blocked'],
    support: support('supported', 'blocked', 'blocked', 'blocked'),
    rolloutStage: 'future_restricted',
    risk: 'restricted',
    ownerService: 'finance-policy-service',
    requiredPermissions: ['finance:read'],
    confirmationPolicy: 'never_execute',
    verificationMode: 'manual_review',
    executionMode: 'manual_review',
    modelVisible: false,
    enabledFlags: [CHAT_CORE_V2_GLOBAL_FLAG, CHAT_CORE_V2_RESTRICTED_POLICY_FLAG],
    sensitivity: 'financial',
    fallbackAllowed: false,
    promptFamily: 'chat_v2_finance',
    reasoningTier: 'none',
    domainSafetyPolicyVersion: CHAT_CORE_V2_FINANCE_ACTION_POLICY_VERSION,
  }),
];

export function getChatCoreV2Capabilities(): CapabilityDefinition[] {
  return CHAT_CORE_V2_CAPABILITIES.map((capability) => ({
    ...capability,
    support: { ...capability.support },
    undoPolicy: { ...capability.undoPolicy },
    requiredPermissions: [...capability.requiredPermissions],
    routeMethods: [...capability.routeMethods],
    enabledFlags: [...capability.enabledFlags],
    batchPolicy: capability.batchPolicy ? { ...capability.batchPolicy } : undefined,
    domainSafetyPolicyVersion: capability.domainSafetyPolicyVersion,
  }));
}

export function getChatCoreV2Capability(capabilityId: string): CapabilityDefinition | undefined {
  return getChatCoreV2Capabilities().find((capability) => capability.capabilityId === capabilityId);
}

export function listChatCoreV2CapabilitiesByDomain(domain: ChatCoreV2Domain): CapabilityDefinition[] {
  return getChatCoreV2Capabilities().filter((capability) => capability.domain === domain);
}

export function listChatCoreV2ExecutableCapabilities(): CapabilityDefinition[] {
  return getChatCoreV2Capabilities().filter((capability) => capability.support.execute === 'supported');
}

export function listChatCoreV2ModelVisibleCapabilities(): CapabilityDefinition[] {
  return getChatCoreV2Capabilities().filter((capability) => capability.modelVisible);
}

export function isChatCoreV2CapabilityEnabled(
  capabilityId: string,
  input: {
    env?: NodeJS.ProcessEnv;
    scope?: RuntimeFlagScope;
  } = {},
): boolean {
  const capability = getChatCoreV2Capability(capabilityId);
  if (!capability) return false;
  return capability.enabledFlags.every((flag) =>
    isChatCoreV2RuntimeFlagEnabled(flag, input.env ?? process.env, input.scope));
}

export function listEnabledChatCoreV2Capabilities(input: {
  env?: NodeJS.ProcessEnv;
  scope?: RuntimeFlagScope;
} = {}): CapabilityDefinition[] {
  return getChatCoreV2Capabilities().filter((capability) =>
    isChatCoreV2CapabilityEnabled(capability.capabilityId, input));
}
