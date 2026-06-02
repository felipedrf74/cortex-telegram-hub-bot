// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  isChatCoreV2LegacyFallbackDisabledForTenant,
  isChatCoreV2MasterKillSwitchOff,
  resolveChatCoreV2ActivationConfig,
} from './activation-flags';
import {
  buildChatCoreV2UnsupportedResolution,
} from './unsupported-policy';
import {
  classifyShadowRoute,
  type ChatCoreV2ShadowRouteGuess,
} from './shadow-route-classifier';
import type { ChatCoreV2Response } from './response-contracts';
import type { ChatCoreV2Domain } from './types';

export const CHAT_CORE_V2_UNSUPPORTED_FALLBACK_RESPONSE_VERSION =
  'chat_core_v2_unsupported_fallback_response@1.0.0';

/**
 * WP-20 (§5.H). Named retirement threshold. Tuning this requires a code change,
 * not an env-only rollback, by design.
 */
export const CHAT_CORE_V2_UNSUPPORTED_FALLBACK_MIN_CONFIDENCE = 0.85;

export type ChatCoreV2UnsupportedFallbackDecisionReason =
  | 'legacy_fallback_disabled'
  | 'high_confidence_v2_unsupported';

type EnvLike = Record<string, string | undefined>;

export interface BuildChatCoreV2UnsupportedFallbackResponseInput {
  locale?: string | null;
  routeGuess: ChatCoreV2ShadowRouteGuess;
  decisionReason: ChatCoreV2UnsupportedFallbackDecisionReason;
}

export interface EvaluateChatCoreV2UnsupportedFallbackInput {
  normalizedText: string;
  locale?: string | null;
  tenantId: string | number;
  env?: EnvLike;
}

export interface ChatCoreV2UnsupportedFallbackEvaluation {
  response: ChatCoreV2Response | null;
  routeGuess: ChatCoreV2ShadowRouteGuess;
  decisionReason: ChatCoreV2UnsupportedFallbackDecisionReason | null;
  legacyFallbackDisabled: boolean;
  readIntentLeakedToLegacy: boolean;
}

export function evaluateChatCoreV2UnsupportedFallback(
  input: EvaluateChatCoreV2UnsupportedFallbackInput,
): ChatCoreV2UnsupportedFallbackEvaluation {
  const env = input.env ?? process.env;
  const routeGuess = classifyShadowRoute(input.normalizedText);
  const inactive = !isUnsupportedFallbackRetirementModeActive(env, input.tenantId);
  const readIntentLeakedToLegacy = !inactive && isMultiDomainAppQuestion(routeGuess);

  if (inactive) {
    return {
      response: null,
      routeGuess,
      decisionReason: null,
      legacyFallbackDisabled: false,
      readIntentLeakedToLegacy: false,
    };
  }

  const legacyFallbackDisabled = isChatCoreV2LegacyFallbackDisabledForTenant(env, input.tenantId);
  const decisionReason = legacyFallbackDisabled
    ? 'legacy_fallback_disabled'
    : routeGuess.confidence >= CHAT_CORE_V2_UNSUPPORTED_FALLBACK_MIN_CONFIDENCE
      ? 'high_confidence_v2_unsupported'
      : null;

  return {
    response: decisionReason
      ? buildChatCoreV2UnsupportedFallbackResponse({
        locale: input.locale,
        routeGuess,
        decisionReason,
      })
      : null,
    routeGuess,
    decisionReason,
    legacyFallbackDisabled,
    readIntentLeakedToLegacy,
  };
}

export function buildChatCoreV2UnsupportedFallbackResponse(
  input: BuildChatCoreV2UnsupportedFallbackResponseInput,
): ChatCoreV2Response {
  const unsupportedReason = input.routeGuess.unsupportedReason ?? 'not_built';
  const resolution = buildChatCoreV2UnsupportedResolution({
    reason: unsupportedReason,
    locale: input.locale,
    domain: firstDomain(input.routeGuess),
    capabilityId: input.routeGuess.capabilityIds[0],
  });

  return {
    ...resolution.response,
    reasonCodes: [
      input.decisionReason,
      unsupportedReason,
      CHAT_CORE_V2_UNSUPPORTED_FALLBACK_RESPONSE_VERSION,
      ...resolution.response.reasonCodes,
    ].filter((reason, index, reasons) => reasons.indexOf(reason) === index),
  };
}

function isUnsupportedFallbackRetirementModeActive(env: EnvLike, tenantId: string | number): boolean {
  const config = resolveChatCoreV2ActivationConfig(env);
  if (config.mode !== 'canary' && config.mode !== 'on') return false;
  return !isChatCoreV2MasterKillSwitchOff(env, String(tenantId));
}

function isMultiDomainAppQuestion(routeGuess: ChatCoreV2ShadowRouteGuess): boolean {
  return routeGuess.intent === 'app_question' && routeGuess.domains.length > 1;
}

function firstDomain(routeGuess: ChatCoreV2ShadowRouteGuess): ChatCoreV2Domain | undefined {
  return routeGuess.domains[0];
}
