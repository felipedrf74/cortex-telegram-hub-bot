// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export type ChatCoreV2Domain =
  | 'secretary'
  | 'tasks'
  | 'training'
  | 'content'
  | 'cooking'
  | 'finance'
  | 'connections'
  | 'notifications'
  | 'decision_center';

export type ChatCoreV2RouteMethod =
  | 'deterministic_read'
  | 'llm_synthesis'
  | 'llm_command_translation'
  | 'planner'
  | 'background_planner'
  | 'unsupported'
  | 'blocked';

export type ReasoningTier =
  | 'none'
  | 'fast_extraction'
  | 'standard_command'
  | 'synthesis'
  | 'planner'
  | 'deep_planner'
  | 'background_planner';

export type ActionRisk = 'low' | 'medium' | 'high' | 'restricted';

export type ConfirmationPolicy =
  | 'always_confirm_v1'
  | 'confirm_by_risk'
  | 'execute_with_undo'
  | 'never_execute';

export type VerificationMode =
  | 'immediate_read_back'
  | 'eventual_read_back'
  | 'external_system_ack'
  | 'manual_review'
  | 'not_verifiable';

export type CommandExecutionMode = 'sync' | 'async' | 'manual_review';

export type CapabilitySupportLevel = 'supported' | 'preview_only' | 'blocked' | 'not_applicable';

export type CapabilityRolloutStage =
  | 'mvp_read'
  | 'mvp_confirmed_write'
  | 'preview_only'
  | 'future_medium_risk'
  | 'future_restricted';

export type AuditSensitivity =
  | 'normal'
  | 'personal'
  | 'financial'
  | 'health_adjacent'
  | 'credential_adjacent';

export type AuditRetentionPolicy = '30d' | '90d' | '1y' | 'legal_required';

export type CommandStatus =
  | 'proposed'
  | 'previewed'
  | 'confirmation_required'
  | 'confirmed'
  | 'queued'
  | 'executing'
  | 'retrying'
  | 'executed'
  | 'verification_pending'
  | 'verified'
  | 'verification_failed'
  | 'partially_failed'
  | 'failed'
  | 'timed_out'
  | 'stale'
  | 'expired'
  | 'cancelled'
  | 'undone'
  | 'undo_failed'
  | 'rejected_by_policy'
  | 'approval_denied'
  | 'awaiting_human_review';

export type WorkflowStatus =
  | 'draft'
  | 'previewed'
  | 'awaiting_user_confirmation'
  | 'awaiting_human_review'
  | 'queued'
  | 'running'
  | 'waiting_external_provider'
  | 'verification_pending'
  | 'completed'
  | 'partially_completed'
  | 'failed'
  | 'cancelled'
  | 'expired';

export type FallbackReason =
  | 'v2_unsupported'
  | 'v2_schema_failure'
  | 'v2_context_failure'
  | 'v2_llm_failure'
  | 'v2_execution_disabled'
  | 'v2_timeout'
  | 'tenant_flag_disabled';

export type UnsupportedReason =
  | 'not_built'
  | 'restricted_domain'
  | 'requires_external_auth'
  | 'unsafe_action'
  | 'ambiguous_scope'
  | 'too_large_batch'
  | 'manual_only';

export type CommandOrigin = 'chat' | 'decision_center' | 'notification' | 'automation' | 'manual_user';

export type MemoryItemType =
  | 'conversation_summary'
  | 'user_preference'
  | 'domain_preference'
  | 'decision_rationale'
  | 'recurring_pattern'
  | 'user_correction'
  | 'ignored_suggestion'
  | 'safety_constraint';

export type MemoryStatus = 'active' | 'superseded' | 'deleted' | 'needs_confirmation';

export type ChatCoreV2EntityType =
  | 'task'
  | 'training_session'
  | 'event'
  | 'notification'
  | 'decision'
  | 'content_item'
  | 'meal_plan_item'
  | 'finance_item'
  | 'connection';

export type EntityResolutionStatus = 'resolved' | 'ambiguous' | 'not_found';

export interface RuntimeBudget {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCachedInputTokens?: number;
  maxModelCalls: number;
  maxToolCalls: number;
  maxWallClockMs: number;
  maxCostUsd: number;
  maxContextItems: number;
}

export interface ReasoningPolicy {
  policyVersion: string;
  tier: ReasoningTier;
  budget: RuntimeBudget;
  allowBackground: boolean;
  allowWriteProposal: boolean;
  allowMultiStepPlan: boolean;
  requiresHumanReview: boolean;
}

export interface LLMProviderCapabilities {
  provider: 'openai' | 'anthropic' | 'google' | 'local' | 'other';
  supportsStrictStructuredOutputs: boolean;
  supportsFunctionCalling: boolean;
  supportsParallelToolCalls: boolean;
  supportsPromptCaching: boolean;
  supportsStreaming: boolean;
  supportsTokenUsageBreakdown: boolean;
  supportsReasoningEffort: boolean;
  supportsProviderStateOptOut: boolean;
}

export interface ExecutionPreconditions {
  requiredEntityVersions: Record<string, string>;
  requiredPermissionsVersion?: string;
  requiredTenantPolicyVersion?: string;
  requiredIntegrationConnectionVersion?: string;
  requiredDecisionVersion?: string;
  invariants: Array<{
    type: string;
    description: string;
    check: string;
  }>;
}

export interface AIActionAuthorization {
  actorUserId: string;
  tenantId: string;
  actingSurface: 'ios_chat' | 'web_chat' | 'system_automation';
  delegatedScopes: string[];
  permissionSnapshotVersion: string;
  authTime: string;
}

export interface AICommandEnvelope<TPayload = unknown> {
  commandId: string;
  commandSchemaVersion: string;
  previewSchemaVersion: string;
  responseSchemaVersion: string;
  tenantId: string;
  userId: string;
  domain: ChatCoreV2Domain;
  commandType: string;
  origin: CommandOrigin;
  payload: TPayload;
  basedOn: {
    entityIds: string[];
    entityVersions: Record<string, string>;
    contextHash: string;
    createdAt: string;
  };
  preconditions: ExecutionPreconditions;
  authorization: AIActionAuthorization;
  expiresAt: string;
  idempotencyKey: string;
}

export interface UndoPolicy {
  supported: boolean;
  undoCommandType?: string;
  undoWindowSeconds?: number;
  requiresConfirmation: boolean;
}

export interface BatchPolicy {
  maxItemsWithoutSpecialConfirmation: number;
  maxItemsAbsolute: number;
  requiresDiffPreview: boolean;
  requiresTypedConfirmationText?: string;
}

export interface CapabilitySupportMatrix {
  read: CapabilitySupportLevel;
  preview: CapabilitySupportLevel;
  execute: CapabilitySupportLevel;
  undo: CapabilitySupportLevel;
}

export interface CapabilityDefinition {
  capabilityId: string;
  domain: ChatCoreV2Domain;
  commandType?: string;
  routeMethods: ChatCoreV2RouteMethod[];
  support: CapabilitySupportMatrix;
  rolloutStage: CapabilityRolloutStage;
  risk: ActionRisk;
  ownerService: string;
  requiredPermissions: string[];
  schemaVersion: string;
  previewCardType?: string;
  confirmationPolicy: ConfirmationPolicy;
  undoPolicy: UndoPolicy;
  verificationMode: VerificationMode;
  executionMode: CommandExecutionMode;
  modelVisible: boolean;
  enabledFlags: string[];
  sensitivity: AuditSensitivity;
  fallbackAllowed: boolean;
  promptFamily: string;
  reasoningTier: ReasoningTier;
  toolSchemaSetVersion?: string;
  batchPolicy?: BatchPolicy;
}

export interface MemoryItem {
  memoryId: string;
  userId: string;
  tenantId: string;
  type: MemoryItemType;
  domain?: ChatCoreV2Domain;
  value: string;
  sourceTurnId?: string;
  confidence: number;
  sensitivity: AuditSensitivity;
  status: MemoryStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

export interface EntityResolutionCandidate {
  id: string;
  label: string;
  confidence: number;
  reason: string;
  entityVersion?: string;
  domain?: ChatCoreV2Domain;
  metadata?: Record<string, unknown>;
}

export interface EntityReferenceResolution {
  entityType: ChatCoreV2EntityType;
  userPhrase: string;
  candidates: EntityResolutionCandidate[];
  status: EntityResolutionStatus;
  selectedId?: string;
  selectedCandidate?: EntityResolutionCandidate;
  reasonCodes: string[];
}

export interface ChatV2AuditPayload {
  redactedSummary: string;
  encryptedFullPayload?: string;
  sensitivity: AuditSensitivity;
  retentionPolicy: AuditRetentionPolicy;
}

export interface ChatV2ModelRun {
  modelRunId: string;
  turnId: string;
  provider: LLMProviderCapabilities['provider'];
  model: string;
  modelVersion?: string;
  modelSettingsHash: string;
  promptTemplateVersion: string;
  toolSchemaSetVersion: string;
  contextBuilderVersion: string;
  routerVersion: string;
  entityResolverVersion?: string;
  reasoningPolicyVersion: string;
  inputTokenCount: number;
  cachedInputTokenCount?: number;
  outputTokenCount: number;
  latencyMs: number;
  status: 'success' | 'schema_failed' | 'refused' | 'timeout' | 'error';
  createdAt: string;
}

export interface ChatReplayBundle {
  turnId: string;
  routeDecision: unknown;
  contextPack: unknown;
  modelRuns: ChatV2ModelRun[];
  toolSchemaSetVersion: string;
  commandProposals: AICommandEnvelope[];
  commandEvents: unknown[];
  response: unknown;
}
