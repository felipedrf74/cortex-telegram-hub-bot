// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'crypto';
import Database from 'better-sqlite3';

import { logger } from '../../utils/logger';
import { isChatCoreV2ShadowRouteHookEnabled, type RuntimeFlagScope } from '../runtime-flags';
import {
  planChatCoreV2ShadowTurn,
  type ChatCoreV2ShadowTurnInput,
  type ChatCoreV2ShadowTurnResult,
} from './shadow-orchestrator';
import {
  recordChatCoreV2ShadowReplay,
  type ChatCoreV2ShadowReplayResponse,
} from './shadow-replay';
import type {
  ChatCoreV2Domain,
  UnsupportedReason,
} from './types';

export const CHAT_CORE_V2_SHADOW_ROUTE_HOOK_VERSION = 'chat_core_v2_shadow_route_hook@1.0.0';

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
  errorCode?: 'shadow_route_hook_failed';
}

interface MessageRouteGuess {
  intent: ChatCoreV2ShadowTurnInput['intent'];
  confidence: number;
  domains: ChatCoreV2Domain[];
  capabilityIds: string[];
  unsupportedReason?: UnsupportedReason;
}

export function runChatCoreV2ShadowRouteHook(
  input: RunChatCoreV2ShadowRouteHookInput,
): ChatCoreV2ShadowRouteHookResult {
  const scope: RuntimeFlagScope = { userId: input.userId, tenantId: input.tenantId };
  if (!isChatCoreV2ShadowRouteHookEnabled(input.env ?? process.env, scope)) {
    return { enabled: false, recorded: false };
  }

  try {
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
      contextPack: buildShadowRouteContextPack(input, guess),
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

export function classifyShadowRoute(text: string): MessageRouteGuess {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return {
      intent: 'ambiguous',
      confidence: 0.4,
      domains: [],
      capabilityIds: [],
    };
  }

  if (/\b(ignore|bypass)\s+(?:all\s+)?(?:access|permission|skill)|enable\s+every\s+skill|delete\s+all|wipe\s+all\b/i.test(normalized)) {
    return {
      intent: 'unsafe_or_disallowed',
      confidence: 0.96,
      domains: [],
      capabilityIds: [],
      unsupportedReason: 'unsafe_action',
    };
  }

  if (/\b(plan|organize|optimise|optimize|schedule)\b.*\b(week|day|training|task|meeting|meal)\b/i.test(normalized)) {
    const domains = guessDomains(normalized);
    return {
      intent: 'planning',
      confidence: 0.78,
      domains: domains.length > 0 ? domains : ['tasks'],
      capabilityIds: capabilityIdsForDomains(domains.length > 0 ? domains : ['tasks'], 'read'),
    };
  }

  if (/\b(create|add|new)\b.*\b(task|todo|to-do)\b|\b(task|todo|to-do)\b.*\b(tomorrow|today|later)\b/i.test(normalized)) {
    return { intent: 'create_action', confidence: 0.88, domains: ['tasks'], capabilityIds: ['tasks.create'] };
  }
  if (/\b(complete|done|finish|mark)\b.*\b(task|todo|to-do)\b/i.test(normalized)) {
    return { intent: 'modify_action', confidence: 0.84, domains: ['tasks'], capabilityIds: ['tasks.complete'] };
  }
  if (/\b(snooze|pause)\b.*\b(notification|alert|reminder)\b/i.test(normalized)) {
    return { intent: 'modify_action', confidence: 0.83, domains: ['notifications'], capabilityIds: ['notifications.snooze'] };
  }
  if (/\b(dismiss|close)\b.*\b(decision|choice)\b/i.test(normalized)) {
    return { intent: 'modify_action', confidence: 0.82, domains: ['decision_center'], capabilityIds: ['decision_center.dismiss'] };
  }
  if (/\b(move|reschedule|change|lighter|reduce)\b.*\b(workout|training|session)\b/i.test(normalized)) {
    return { intent: 'modify_action', confidence: 0.83, domains: ['training'], capabilityIds: ['training.modify_session_preview'] };
  }
  if (/\b(add|buy|create)\b.*\b(grocery|groceries|ingredient|shopping)\b/i.test(normalized)) {
    return { intent: 'create_action', confidence: 0.8, domains: ['cooking'], capabilityIds: ['cooking.grocery_item_preview'] };
  }
  if (/\b(create|draft|write)\b.*\b(content|brief|script|post)\b/i.test(normalized)) {
    return { intent: 'create_action', confidence: 0.8, domains: ['content'], capabilityIds: ['content.brief_draft_preview'] };
  }
  if (/\b(pay|payment|tax|send money|transfer)\b/i.test(normalized)) {
    return {
      intent: 'unsafe_or_disallowed',
      confidence: 0.9,
      domains: ['finance'],
      capabilityIds: ['finance.payment_or_tax_action_blocked'],
      unsupportedReason: 'restricted_domain',
    };
  }

  const domains = guessDomains(normalized);
  if (domains.length > 0) {
    return {
      intent: 'app_question',
      confidence: 0.82,
      domains,
      capabilityIds: capabilityIdsForDomains(domains, 'read'),
    };
  }

  return {
    intent: 'general_question',
    confidence: 0.62,
    domains: [],
    capabilityIds: [],
    unsupportedReason: 'not_built',
  };
}

function guessDomains(text: string): ChatCoreV2Domain[] {
  const domains: ChatCoreV2Domain[] = [];
  if (/\b(agenda|calendar|meeting|schedule|secretary)\b/i.test(text)) domains.push('secretary');
  if (/\b(task|tasks|todo|to-do)\b/i.test(text)) domains.push('tasks');
  if (/\b(training|workout|run|session)\b/i.test(text)) domains.push('training');
  if (/\b(content|script|post|pipeline)\b/i.test(text)) domains.push('content');
  if (/\b(cooking|meal|grocery|groceries|ingredient)\b/i.test(text)) domains.push('cooking');
  if (/\b(finance|invoice|receipt|budget|tax|payment)\b/i.test(text)) domains.push('finance');
  if (/\b(connection|connect|integration|provider)\b/i.test(text)) domains.push('connections');
  if (/\b(notification|alert|reminder)\b/i.test(text)) domains.push('notifications');
  if (/\b(decision|choice|decision center)\b/i.test(text)) domains.push('decision_center');
  return [...new Set(domains)];
}

function capabilityIdsForDomains(domains: ChatCoreV2Domain[], mode: 'read'): string[] {
  void mode;
  const capabilityByDomain: Record<ChatCoreV2Domain, string> = {
    secretary: 'secretary.agenda_summary',
    tasks: 'tasks.today_summary',
    training: 'training.session_explain',
    content: 'content.pipeline_summary',
    cooking: 'cooking.meal_plan_summary',
    finance: 'finance.summary',
    connections: 'connections.status',
    notifications: 'notifications.summary',
    decision_center: 'decision_center.summary',
  };
  return domains.map((domain) => capabilityByDomain[domain]);
}

function buildShadowRouteContextPack(
  input: RunChatCoreV2ShadowRouteHookInput,
  guess: MessageRouteGuess,
): Record<string, unknown> {
  return {
    shadowRouteHookVersion: CHAT_CORE_V2_SHADOW_ROUTE_HOOK_VERSION,
    messageHash: hashText(input.normalizedText),
    messageLength: input.normalizedText.length,
    attachmentsCount: input.attachmentsCount ?? 0,
    clientMessageHash: input.clientMessageId ? hashText(input.clientMessageId) : undefined,
    userMessageId: input.userMessageId,
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

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}
