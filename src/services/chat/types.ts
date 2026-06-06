// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { createEvent, getEventsForSources } from '../unified-calendar';
import type { isGoogleCalendarConfigured } from '../google-calendar';
import type { isOutlookCalendarConfigured } from '../outlook-calendar';
import type { ChatActionRunStatus } from '../chat-action-run-store';
import type {
  ChatActionRiskClass,
  ChatActionTelemetry,
  ChatSlotProvenance,
} from '../chat-action-state';
import type { ChatResponseBlock } from '../chat-response-blocks';
import type { ChatResponseCard } from '../chat-response-cards';
import type { getTaskProviderForUser } from '../task-store/task-router';
import type {
  ChatActionName,
  ChatActionRisk,
  ChatActionSkill,
  ChatProvider,
} from './registry/types';

export type ChatActionStatus = ChatActionRunStatus;

export type ChatPlanStepType = ChatActionName | 'answer' | 'clarification';

export type ChatClarificationReason = 'missing_required_fields' | 'ambiguous_intent' | 'low_confidence';

export interface ChatActionPlan {
  schemaVersion: 1;
  userId: string;
  tenantId: string;
  conversationId: string;
  messageId: string;
  locale: string;
  timezone: string;
  channel: 'ios' | 'telegram' | 'portal' | 'api';
  createdAt: string;
  planner: 'deterministic' | 'llm_structured' | 'mixed';
  steps: ChatPlanStep[];
  requiresConfirmation: boolean;
  clarificationQuestion?: string;
  clarificationReason?: ChatClarificationReason;
  intentClass?: string;
  confidence: number;
  effectiveConfidence?: number;
  telemetry?: ChatActionTelemetry;
  debug?: {
    routingSignals: string[];
    rejectedFastPaths: string[];
    parser: 'deterministic' | 'model_assisted' | 'mixed';
    modelProvider?: 'gemini' | 'anthropic' | 'openai';
  };
}

export interface ChatPlanStep {
  stepId: string;
  skill: ChatActionSkill;
  type: ChatPlanStepType;
  action: ChatActionName;
  risk: ChatActionRisk;
  riskClass?: ChatActionRiskClass;
  provider?: ChatProvider;
  args: Record<string, unknown>;
  slotProvenance?: Record<string, ChatSlotProvenance>;
  requiredArgsPresent: boolean;
  idempotencyKey: string;
  dependsOnStepIds?: string[];
  verification: {
    required: boolean;
    method: 'provider_read_back' | 'local_read_back' | 'none';
    expectedFields?: Record<string, unknown>;
  };
}

export interface ChatStepExecutionResult {
  step: ChatPlanStep;
  status: ChatActionRunStatus;
  result?: unknown;
  error?: string;
  runUpdateAccepted?: boolean;
}

export interface ChatPlannerInput {
  text: string;
  userId: number;
  tenantId: number;
  conversationId: string;
  messageId: string;
  channel: 'ios' | 'telegram' | 'portal' | 'api';
  locale?: string;
  timezone: string;
  nowIso?: string;
  persistRuns?: boolean;
  requireSafeWriteConfirmation?: boolean;
  routeStartedAtMs?: number;
}

export interface ChatActionRouteResponse {
  id: string;
  text: string;
  domain: 'secretary' | 'tasks' | 'training' | 'content' | 'cooking' | 'finance' | 'unknown';
  routeMethod: string;
  confidence: number;
  buttons: null;
  metadata: Record<string, unknown>;
  timestamp: string;
  responseBlocks?: ChatResponseBlock[];
  responseCards?: ChatResponseCard[];
}

export type CalendarProviderDeps = {
  createEvent: typeof createEvent;
  getEventsForSources: typeof getEventsForSources;
  hasGoogle: typeof isGoogleCalendarConfigured;
  hasOutlook: typeof isOutlookCalendarConfigured;
};

export interface ChatActionPlannerDeps {
  calendar?: CalendarProviderDeps;
  taskProviderForUser?: typeof getTaskProviderForUser;
}

export interface ChatActionExecutionOptions {
  confirmed?: boolean;
  confirmationSource?: 'explicit_current_turn' | 'pending_confirmation' | 'none';
}
