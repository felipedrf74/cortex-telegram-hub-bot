// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHmac } from 'crypto';
import Database from 'better-sqlite3';

import { logger } from '../../utils/logger';
import { isChatCoreV2ShadowRouteHookEnabled, type RuntimeFlagScope } from '../runtime-flags';
import {
  planChatCoreV2ShadowTurn,
  type ChatCoreV2ShadowTurnResult,
} from './shadow-orchestrator';
import {
  recordChatCoreV2ShadowReplay,
  type ChatCoreV2ShadowReplayResponse,
} from './shadow-replay';
import { classifyShadowRoute, type ChatCoreV2ShadowRouteGuess } from './shadow-route-classifier';

export const CHAT_CORE_V2_SHADOW_ROUTE_HOOK_VERSION = 'chat_core_v2_shadow_route_hook@1.0.0';
const CHAT_CORE_V2_SHADOW_ROUTE_HASH_VERSION = 'hmac_sha256@1';

export interface RunChatCoreV2ShadowRouteHookInput {
  normalizedText: string;
  userId: number;
  tenantId: number;
  chatRequestId: string;
  userMessageId: string;
  clientMessageId?: string | null;
  attachmentsCount?: number;
  locale?: string | null;
  timezone?: string | null;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  db?: Database.Database;
}

export interface ChatCoreV2ShadowRouteHookResult {
  enabled: boolean;
  recorded: boolean;
  result?: ChatCoreV2ShadowTurnResult;
  replayBundleId?: string;
  errorCode?: 'shadow_route_hook_failed' | 'shadow_route_hook_missing_hmac_secret';
}

export function runChatCoreV2ShadowRouteHook(
  input: RunChatCoreV2ShadowRouteHookInput,
): ChatCoreV2ShadowRouteHookResult {
  const scope: RuntimeFlagScope = { userId: input.userId, tenantId: input.tenantId };
  if (!isChatCoreV2ShadowRouteHookEnabled(input.env ?? process.env, scope)) {
    return { enabled: false, recorded: false };
  }

  try {
    const hmacSecret = resolveShadowRouteHmacSecret(input.env ?? process.env);
    if (!hmacSecret) {
      logger.warn(
        {
          chatRequestId: input.chatRequestId,
          tenantId: input.tenantId,
          userId: input.userId,
          shadowRouteHookVersion: CHAT_CORE_V2_SHADOW_ROUTE_HOOK_VERSION,
        },
        'Chat Core v2 shadow route hook skipped because no HMAC secret is configured',
      );
      return { enabled: true, recorded: false, errorCode: 'shadow_route_hook_missing_hmac_secret' };
    }

    const guess = classifyShadowRoute(input.normalizedText);
    const result = planChatCoreV2ShadowTurn({
      turnId: input.chatRequestId,
      tenantId: String(input.tenantId),
      userId: String(input.userId),
      intent: guess.intent,
      confidence: guess.confidence,
      domains: guess.domains,
      capabilityIds: guess.capabilityIds,
      unsupportedReason: guess.unsupportedReason,
      now: input.now,
    });
    const replayInput = {
      result,
      contextPack: buildShadowRouteContextPack(input, guess, hmacSecret),
      response: buildShadowRouteResponse(result),
      createdAt: input.now?.toISOString(),
    };
    const replay = input.db
      ? recordChatCoreV2ShadowReplay(replayInput, input.db)
      : recordChatCoreV2ShadowReplay(replayInput);

    return {
      enabled: true,
      recorded: true,
      result,
      replayBundleId: replay.replayBundle.replayBundleId,
    };
  } catch (err) {
    logger.warn(
      {
        err,
        chatRequestId: input.chatRequestId,
        tenantId: input.tenantId,
        userId: input.userId,
        shadowRouteHookVersion: CHAT_CORE_V2_SHADOW_ROUTE_HOOK_VERSION,
      },
      'Chat Core v2 shadow route hook failed without affecting live chat',
    );
    return { enabled: true, recorded: false, errorCode: 'shadow_route_hook_failed' };
  }
}

function buildShadowRouteContextPack(
  input: RunChatCoreV2ShadowRouteHookInput,
  guess: ChatCoreV2ShadowRouteGuess,
  hmacSecret: string,
): Record<string, unknown> {
  return {
    shadowRouteHookVersion: CHAT_CORE_V2_SHADOW_ROUTE_HOOK_VERSION,
    hashVersion: CHAT_CORE_V2_SHADOW_ROUTE_HASH_VERSION,
    messageHash: hmacShadowRouteValue(input, hmacSecret, 'message', input.normalizedText),
    messageLength: input.normalizedText.length,
    attachmentsCount: input.attachmentsCount ?? 0,
    clientMessageHash: input.clientMessageId
      ? hmacShadowRouteValue(input, hmacSecret, 'client_message_id', input.clientMessageId)
      : undefined,
    userMessageHash: hmacShadowRouteValue(input, hmacSecret, 'user_message_id', input.userMessageId),
    locale: input.locale ?? undefined,
    timezone: input.timezone ?? undefined,
    guessedIntent: guess.intent,
    guessedDomains: guess.domains,
    guessedCapabilities: guess.capabilityIds,
  };
}

function buildShadowRouteResponse(result: ChatCoreV2ShadowTurnResult): ChatCoreV2ShadowReplayResponse & {
  routeHookVersion: string;
  liveBehavior: 'legacy_path_unchanged';
} {
  return {
    type: 'chat_core_v2_shadow_plan',
    shadowReplayVersion: 'chat_core_v2_shadow_replay@1.0.0',
    routeHookVersion: CHAT_CORE_V2_SHADOW_ROUTE_HOOK_VERSION,
    orchestratorVersion: result.orchestratorVersion,
    mode: 'shadow',
    liveBehavior: 'legacy_path_unchanged',
    routeMethod: result.routeDecision.routeMethod,
    reasoningTier: result.routeDecision.reasoningTier,
    selectedCapabilityIds: result.routeDecision.selectedCapabilityIds,
    toolSchemaSetVersion: result.toolSchemaSet.toolSchemaSetVersion,
    toolCount: result.toolSchemaSet.tools.length,
    budgetOk: result.budgetVerdict.ok,
    fallbackAllowed: result.fallbackVerdict.allowed,
    wouldCallModel: result.wouldCallModel,
    wouldExecute: false,
  };
}

function resolveShadowRouteHmacSecret(env: NodeJS.ProcessEnv): string | null {
  const secret = env.CHAT_CORE_V2_SHADOW_ROUTE_HMAC_SECRET
    ?? env.CHAT_CORE_V2_WRITE_INTENT_HASH_SECRET
    ?? env.CLASSIFY_SHADOW_HASH_SECRET;
  const trimmed = secret?.trim();
  return trimmed ? trimmed : null;
}

function hmacShadowRouteValue(
  input: Pick<RunChatCoreV2ShadowRouteHookInput, 'tenantId' | 'userId'>,
  hmacSecret: string,
  kind: 'message' | 'client_message_id' | 'user_message_id',
  value: string,
): string {
  return createHmac('sha256', hmacSecret)
    .update(`${input.tenantId}:${input.userId}:${kind}:${value}`)
    .digest('hex');
}
