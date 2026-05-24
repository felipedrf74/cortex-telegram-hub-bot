// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getChatCoreV2Capability } from './capability-registry';
import { getChatCoreV2ReasoningPolicy } from './reasoning-policies';
import type {
  ActionRisk,
  CapabilityDefinition,
  ChatCoreV2Domain,
  ChatCoreV2RouteMethod,
  ReasoningTier,
  UnsupportedReason,
} from './types';

export const CHAT_CORE_V2_ROUTE_DECISION_VERSION = 'chat_core_v2_route_decision@1.0.0';

export type ChatCoreV2Intent =
  | 'general_question'
  | 'app_question'
  | 'create_action'
  | 'modify_action'
  | 'planning'
  | 'ambiguous'
  | 'unsafe_or_disallowed';

export type ChatCoreV2RouteReasonCode =
  | 'low_confidence'
  | 'no_domain'
  | 'unknown_capability'
  | 'multi_domain_context'
  | 'restricted_capability'
  | 'blocked_capability'
  | 'unsupported_capability'
  | 'deterministic_read_available'
  | 'llm_required'
  | 'planner_required'
  | 'background_required';

export interface BuildRouteDecisionInput {
  intent: ChatCoreV2Intent;
  confidence: number;
  domains?: ChatCoreV2Domain[];
  capabilityIds?: string[];
  requestedRouteMethod?: ChatCoreV2RouteMethod;
  unsupportedReason?: UnsupportedReason;
  minConfidence?: number;
}

export interface ChatCoreV2RouteDecision {
  routeDecisionVersion: string;
  primaryDomain?: ChatCoreV2Domain;
  secondaryDomains: ChatCoreV2Domain[];
  selectedCapabilityIds: string[];
  intent: ChatCoreV2Intent;
  routeMethod: ChatCoreV2RouteMethod;
  confidence: number;
  riskEstimate: ActionRisk;
  reasoningTier: ReasoningTier;
  requiresLLM: boolean;
  unsupportedReason?: UnsupportedReason;
  reasonCodes: ChatCoreV2RouteReasonCode[];
}

const DEFAULT_MIN_CONFIDENCE = 0.68;
const RISK_ORDER: ActionRisk[] = ['low', 'medium', 'high', 'restricted'];
const REASONING_ORDER: ReasoningTier[] = [
  'none',
  'fast_extraction',
  'standard_command',
  'synthesis',
  'planner',
  'deep_planner',
  'background_planner',
];

export function buildChatCoreV2RouteDecision(input: BuildRouteDecisionInput): ChatCoreV2RouteDecision {
  const confidence = normalizeConfidence(input.confidence);
  const domains = unique(input.domains ?? []);
  const capabilities = resolveCapabilities(input.capabilityIds ?? []);
  const knownCapabilities = capabilities.filter((entry): entry is CapabilityDefinition => Boolean(entry));
  const capabilityDomains = knownCapabilities.map((capability) => capability.domain);
  const allDomains = unique([...domains, ...capabilityDomains]);
  const primaryDomain = allDomains[0];
  const secondaryDomains = allDomains.slice(1);
  const reasonCodes: ChatCoreV2RouteReasonCode[] = [];

  if (capabilities.some((capability) => !capability)) reasonCodes.push('unknown_capability');
  if (!primaryDomain) reasonCodes.push('no_domain');
  if (secondaryDomains.length > 0) reasonCodes.push('multi_domain_context');

  const minConfidence = input.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  if (input.intent === 'ambiguous' || confidence < minConfidence) {
    reasonCodes.push('low_confidence');
    return decision({
      input,
      primaryDomain,
      secondaryDomains,
      selectedCapabilityIds: knownCapabilities.map((capability) => capability.capabilityId),
      routeMethod: 'needs_clarification',
      riskEstimate: estimateRisk(knownCapabilities),
      reasoningTier: 'none',
      requiresLLM: false,
      reasonCodes,
    });
  }

  if (input.unsupportedReason === 'ambiguous_scope') {
    reasonCodes.push('unsupported_capability');
    return decision({
      input,
      primaryDomain,
      secondaryDomains,
      selectedCapabilityIds: knownCapabilities.map((capability) => capability.capabilityId),
      routeMethod: 'needs_clarification',
      riskEstimate: estimateRisk(knownCapabilities),
      reasoningTier: 'none',
      requiresLLM: false,
      unsupportedReason: input.unsupportedReason,
      reasonCodes,
    });
  }

  if (input.unsupportedReason || input.intent === 'unsafe_or_disallowed') {
    reasonCodes.push('unsupported_capability');
    return decision({
      input,
      primaryDomain,
      secondaryDomains,
      selectedCapabilityIds: knownCapabilities.map((capability) => capability.capabilityId),
      routeMethod: 'unsupported',
      riskEstimate: estimateRisk(knownCapabilities),
      reasoningTier: 'none',
      requiresLLM: false,
      unsupportedReason: input.unsupportedReason ?? 'unsafe_action',
      reasonCodes,
    });
  }

  if (knownCapabilities.some((capability) => capability.risk === 'restricted')) {
    reasonCodes.push('restricted_capability');
  }

  if (knownCapabilities.some((capability) => capability.support.execute === 'blocked' || capability.routeMethods.includes('blocked'))) {
    reasonCodes.push('blocked_capability');
    return decision({
      input,
      primaryDomain,
      secondaryDomains,
      selectedCapabilityIds: knownCapabilities.map((capability) => capability.capabilityId),
      routeMethod: 'blocked',
      riskEstimate: estimateRisk(knownCapabilities),
      reasoningTier: estimateReasoningTier(knownCapabilities),
      requiresLLM: false,
      unsupportedReason: input.unsupportedReason ?? 'restricted_domain',
      reasonCodes,
    });
  }

  const routeMethod = input.requestedRouteMethod ?? inferRouteMethod(input.intent, knownCapabilities);
  if (routeMethod === 'deterministic_read') reasonCodes.push('deterministic_read_available');
  if (routeMethod === 'llm_command_translation' || routeMethod === 'llm_synthesis') reasonCodes.push('llm_required');
  if (routeMethod === 'planner') reasonCodes.push('planner_required');
  if (routeMethod === 'background_planner') reasonCodes.push('background_required');

  const reasoningTier = estimateReasoningTier(knownCapabilities, routeMethod);
  return decision({
    input,
    primaryDomain,
    secondaryDomains,
    selectedCapabilityIds: knownCapabilities.map((capability) => capability.capabilityId),
    routeMethod,
    riskEstimate: estimateRisk(knownCapabilities),
    reasoningTier,
    requiresLLM: getChatCoreV2ReasoningPolicy(reasoningTier).budget.maxModelCalls > 0,
    reasonCodes,
  });
}

function decision(input: {
  input: BuildRouteDecisionInput;
  primaryDomain?: ChatCoreV2Domain;
  secondaryDomains: ChatCoreV2Domain[];
  selectedCapabilityIds: string[];
  routeMethod: ChatCoreV2RouteMethod;
  riskEstimate: ActionRisk;
  reasoningTier: ReasoningTier;
  requiresLLM: boolean;
  unsupportedReason?: UnsupportedReason;
  reasonCodes: ChatCoreV2RouteReasonCode[];
}): ChatCoreV2RouteDecision {
  return {
    routeDecisionVersion: CHAT_CORE_V2_ROUTE_DECISION_VERSION,
    primaryDomain: input.primaryDomain,
    secondaryDomains: input.secondaryDomains,
    selectedCapabilityIds: input.selectedCapabilityIds,
    intent: input.input.intent,
    routeMethod: input.routeMethod,
    confidence: normalizeConfidence(input.input.confidence),
    riskEstimate: input.riskEstimate,
    reasoningTier: input.reasoningTier,
    requiresLLM: input.requiresLLM,
    unsupportedReason: input.unsupportedReason,
    reasonCodes: unique(input.reasonCodes),
  };
}

function resolveCapabilities(capabilityIds: string[]): Array<CapabilityDefinition | undefined> {
  return capabilityIds.map((capabilityId) => getChatCoreV2Capability(capabilityId));
}

function inferRouteMethod(
  intent: ChatCoreV2Intent,
  capabilities: CapabilityDefinition[],
): ChatCoreV2RouteMethod {
  if (intent === 'planning' && capabilities.length > 1) return 'planner';
  if (capabilities.length === 0) return 'unsupported';
  if (capabilities.every((capability) => capability.routeMethods.includes('deterministic_read'))) {
    return 'deterministic_read';
  }
  if (capabilities.some((capability) => capability.routeMethods.includes('llm_command_translation'))) {
    return 'llm_command_translation';
  }
  if (capabilities.some((capability) => capability.routeMethods.includes('llm_synthesis'))) {
    return 'llm_synthesis';
  }
  return capabilities[0].routeMethods[0] ?? 'unsupported';
}

function estimateRisk(capabilities: CapabilityDefinition[]): ActionRisk {
  return capabilities.reduce<ActionRisk>((current, capability) => {
    return RISK_ORDER.indexOf(capability.risk) > RISK_ORDER.indexOf(current) ? capability.risk : current;
  }, 'low');
}

function estimateReasoningTier(
  capabilities: CapabilityDefinition[],
  routeMethod?: ChatCoreV2RouteMethod,
): ReasoningTier {
  if (routeMethod === 'deterministic_read' || routeMethod === 'needs_clarification' || routeMethod === 'blocked') {
    return 'none';
  }
  if (routeMethod === 'planner') return 'planner';
  if (routeMethod === 'background_planner') return 'background_planner';

  return capabilities.reduce<ReasoningTier>((current, capability) => {
    return REASONING_ORDER.indexOf(capability.reasoningTier) > REASONING_ORDER.indexOf(current)
      ? capability.reasoningTier
      : current;
  }, 'none');
}

function normalizeConfidence(confidence: number): number {
  if (!Number.isFinite(confidence)) return 0;
  return Math.min(1, Math.max(0, confidence));
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
