// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'crypto';

import { evaluateChatCoreV2Fallback, type FallbackPolicyVerdict } from './fallback-policy';
import { getChatCoreV2ReasoningPolicy } from './reasoning-policies';
import {
  buildChatCoreV2RouteDecision,
  type BuildRouteDecisionInput,
  type ChatCoreV2Intent,
  type ChatCoreV2RouteDecision,
} from './route-decision';
import {
  checkRuntimeBudget,
  makeRuntimeBudgetUsage,
  type RuntimeBudgetUsage,
  type RuntimeBudgetVerdict,
} from './runtime-budget';
import {
  selectChatCoreV2ToolSchemas,
  type ChatCoreV2ToolSchemaSet,
} from './tool-selection';
import type {
  AuditSensitivity,
  ChatCoreV2Domain,
  ChatCoreV2RouteMethod,
  ChatV2TraceSpan,
  FallbackReason,
  ReasoningPolicy,
  UnsupportedReason,
} from './types';

export const CHAT_CORE_V2_SHADOW_ORCHESTRATOR_VERSION = 'chat_core_v2_shadow_orchestrator@1.0.0';

export interface ChatCoreV2ShadowTurnInput {
  turnId: string;
  tenantId: string;
  userId: string;
  intent: ChatCoreV2Intent;
  confidence: number;
  domains?: ChatCoreV2Domain[];
  capabilityIds?: string[];
  requestedRouteMethod?: ChatCoreV2RouteMethod;
  unsupportedReason?: UnsupportedReason;
  minConfidence?: number;
  runtimeUsage?: Partial<RuntimeBudgetUsage>;
  maxToolSchemas?: number;
  oldPathHasEquivalentSafety?: boolean;
  fallbackReason?: FallbackReason;
  sensitivity?: AuditSensitivity;
  now?: Date;
}

export interface ChatCoreV2ShadowTurnResult {
  orchestratorVersion: string;
  mode: 'shadow';
  turnId: string;
  routeDecision: ChatCoreV2RouteDecision;
  reasoningPolicy: ReasoningPolicy;
  runtimeUsage: RuntimeBudgetUsage;
  budgetVerdict: RuntimeBudgetVerdict;
  toolSchemaSet: ChatCoreV2ToolSchemaSet;
  fallbackVerdict: FallbackPolicyVerdict;
  traceSpans: ChatV2TraceSpan[];
  wouldCallModel: boolean;
  wouldExecute: false;
}

export function planChatCoreV2ShadowTurn(input: ChatCoreV2ShadowTurnInput): ChatCoreV2ShadowTurnResult {
  const routeDecision = buildChatCoreV2RouteDecision(buildRouteInput(input));
  const reasoningPolicy = getChatCoreV2ReasoningPolicy(routeDecision.reasoningTier);
  const runtimeUsage = makeRuntimeBudgetUsage(input.runtimeUsage);
  const budgetVerdict = checkRuntimeBudget(reasoningPolicy, runtimeUsage);
  const toolSchemaSet = selectChatCoreV2ToolSchemas(routeDecision, {
    maxToolSchemas: input.maxToolSchemas,
  });
  const fallbackVerdict = evaluateChatCoreV2Fallback({
    reason: input.fallbackReason ?? 'v2_execution_disabled',
    routeMethod: routeDecision.routeMethod,
    hasWriteIntent: hasWriteIntent(input.intent, routeDecision.routeMethod),
    oldPathHasEquivalentSafety: input.oldPathHasEquivalentSafety,
  });
  const traceSpans = buildShadowTraceSpans({
    input,
    routeDecision,
    budgetVerdict,
    toolSchemaSet,
    fallbackVerdict,
  });

  return {
    orchestratorVersion: CHAT_CORE_V2_SHADOW_ORCHESTRATOR_VERSION,
    mode: 'shadow',
    turnId: input.turnId,
    routeDecision,
    reasoningPolicy,
    runtimeUsage,
    budgetVerdict,
    toolSchemaSet,
    fallbackVerdict,
    traceSpans,
    wouldCallModel: routeDecision.requiresLLM && budgetVerdict.ok,
    wouldExecute: false,
  };
}

function buildRouteInput(input: ChatCoreV2ShadowTurnInput): BuildRouteDecisionInput {
  return {
    intent: input.intent,
    confidence: input.confidence,
    domains: input.domains,
    capabilityIds: input.capabilityIds,
    requestedRouteMethod: input.requestedRouteMethod,
    unsupportedReason: input.unsupportedReason,
    minConfidence: input.minConfidence,
  };
}

function hasWriteIntent(intent: ChatCoreV2Intent, routeMethod: ChatCoreV2RouteMethod): boolean {
  if (routeMethod === 'llm_command_translation' || routeMethod === 'planner' || routeMethod === 'background_planner') {
    return true;
  }
  return intent === 'create_action'
    || intent === 'modify_action'
    || intent === 'planning'
    || intent === 'unsafe_or_disallowed';
}

function buildShadowTraceSpans(input: {
  input: ChatCoreV2ShadowTurnInput;
  routeDecision: ChatCoreV2RouteDecision;
  budgetVerdict: RuntimeBudgetVerdict;
  toolSchemaSet: ChatCoreV2ToolSchemaSet;
  fallbackVerdict: FallbackPolicyVerdict;
}): ChatV2TraceSpan[] {
  const now = (input.input.now ?? new Date()).toISOString();
  const sensitivity = input.input.sensitivity ?? 'personal';
  return [
    buildSpan(input.input, 'router', 'route_decision', 'success', sensitivity, now, {
      routeMethod: input.routeDecision.routeMethod,
      reasoningTier: input.routeDecision.reasoningTier,
      selectedCapabilityIds: input.routeDecision.selectedCapabilityIds,
      reasonCodes: input.routeDecision.reasonCodes,
    }),
    buildSpan(input.input, 'budget', 'runtime_budget', input.budgetVerdict.ok ? 'success' : 'blocked', sensitivity, now, {
      ok: input.budgetVerdict.ok,
      limit: input.budgetVerdict.limit,
      used: input.budgetVerdict.used,
      max: input.budgetVerdict.max,
    }),
    buildSpan(input.input, 'tool_selection', 'tool_schema_selection', 'success', sensitivity, now, {
      toolSchemaSetVersion: input.toolSchemaSet.toolSchemaSetVersion,
      toolCount: input.toolSchemaSet.tools.length,
      omittedCapabilities: input.toolSchemaSet.omittedCapabilities,
    }),
    buildSpan(input.input, 'fallback', 'shadow_fallback_policy', input.fallbackVerdict.allowed ? 'success' : 'blocked', sensitivity, now, {
      allowed: input.fallbackVerdict.allowed,
      reason: input.fallbackVerdict.reason,
      blockedBecause: input.fallbackVerdict.blockedBecause,
    }),
  ];
}

function buildSpan(
  input: ChatCoreV2ShadowTurnInput,
  kind: ChatV2TraceSpan['kind'],
  name: string,
  status: ChatV2TraceSpan['status'],
  sensitivity: AuditSensitivity,
  timestamp: string,
  attributes: Record<string, unknown>,
): ChatV2TraceSpan {
  return {
    traceSpanId: `chatv2-shadow:${hashId(input.turnId, name)}`,
    turnId: input.turnId,
    tenantId: input.tenantId,
    userId: input.userId,
    kind,
    name,
    status,
    sensitivity,
    retentionPolicy: sensitivity === 'financial' ? '30d' : '90d',
    redactedSummary: `${name}:${status}`,
    attributes: {
      orchestratorVersion: CHAT_CORE_V2_SHADOW_ORCHESTRATOR_VERSION,
      ...attributes,
    },
    startedAt: timestamp,
    endedAt: timestamp,
    durationMs: 0,
  };
}

function hashId(turnId: string, name: string): string {
  return createHash('sha256')
    .update(`${turnId}:${name}`)
    .digest('hex')
    .slice(0, 16);
}
