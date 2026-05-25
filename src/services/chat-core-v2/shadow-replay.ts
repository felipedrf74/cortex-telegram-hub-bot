// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'crypto';
import Database from 'better-sqlite3';

import {
  recordChatV2TraceReplay,
  type ChatV2TraceReplayRecord,
  type RecordChatV2TraceReplayInput,
} from './trace-recorder';
import type {
  AICommandEnvelope,
  AuditRetentionPolicy,
  AuditSensitivity,
  ChatV2CommandEvent,
  ChatV2ModelRun,
} from './types';
import type { ChatCoreV2ShadowTurnResult } from './shadow-orchestrator';

export const CHAT_CORE_V2_SHADOW_REPLAY_VERSION = 'chat_core_v2_shadow_replay@1.0.0';

export interface BuildChatCoreV2ShadowReplayInput {
  result: ChatCoreV2ShadowTurnResult;
  contextPack?: unknown;
  response?: unknown;
  modelRuns?: ChatV2ModelRun[];
  commandProposals?: AICommandEnvelope[];
  commandEvents?: ChatV2CommandEvent[];
  replayBundleId?: string;
  createdAt?: string;
  expiresAt?: string;
}

export interface ChatCoreV2ShadowReplayResponse {
  type: 'chat_core_v2_shadow_plan';
  shadowReplayVersion: string;
  orchestratorVersion: string;
  mode: 'shadow';
  routeMethod: string;
  reasoningTier: string;
  selectedCapabilityIds: string[];
  toolSchemaSetVersion: string;
  toolCount: number;
  budgetOk: boolean;
  fallbackAllowed: boolean;
  wouldCallModel: boolean;
  wouldExecute: false;
}

export function buildChatCoreV2ShadowReplayInput(
  input: BuildChatCoreV2ShadowReplayInput,
): RecordChatV2TraceReplayInput {
  const sensitivity = inferShadowReplaySensitivity(input.result);
  const createdAt = input.createdAt ?? input.result.traceSpans[0]?.startedAt ?? new Date().toISOString();

  return {
    replayBundleId: input.replayBundleId ?? buildShadowReplayBundleId(input.result),
    turnId: input.result.turnId,
    routeDecision: input.result.routeDecision,
    contextPack: input.contextPack ?? {
      mode: 'shadow',
      orchestratorVersion: input.result.orchestratorVersion,
    },
    modelRuns: input.modelRuns ?? [],
    toolSchemaSetVersion: input.result.toolSchemaSet.toolSchemaSetVersion,
    commandProposals: input.commandProposals ?? [],
    commandEvents: input.commandEvents ?? [],
    traceSpans: input.result.traceSpans,
    response: input.response ?? buildDefaultShadowReplayResponse(input.result),
    sensitivity,
    retentionPolicy: retentionPolicyForShadowSensitivity(sensitivity),
    createdAt,
    expiresAt: input.expiresAt,
  };
}

export function recordChatCoreV2ShadowReplay(
  input: BuildChatCoreV2ShadowReplayInput,
  db?: Database.Database,
): ChatV2TraceReplayRecord {
  const replayInput = buildChatCoreV2ShadowReplayInput(input);
  return db ? recordChatV2TraceReplay(replayInput, db) : recordChatV2TraceReplay(replayInput);
}

function buildDefaultShadowReplayResponse(result: ChatCoreV2ShadowTurnResult): ChatCoreV2ShadowReplayResponse {
  return {
    type: 'chat_core_v2_shadow_plan',
    shadowReplayVersion: CHAT_CORE_V2_SHADOW_REPLAY_VERSION,
    orchestratorVersion: result.orchestratorVersion,
    mode: result.mode,
    routeMethod: result.routeDecision.routeMethod,
    reasoningTier: result.routeDecision.reasoningTier,
    selectedCapabilityIds: result.routeDecision.selectedCapabilityIds,
    toolSchemaSetVersion: result.toolSchemaSet.toolSchemaSetVersion,
    toolCount: result.toolSchemaSet.tools.length,
    budgetOk: result.budgetVerdict.ok,
    fallbackAllowed: result.fallbackVerdict.allowed,
    wouldCallModel: result.wouldCallModel,
    wouldExecute: result.wouldExecute,
  };
}

function inferShadowReplaySensitivity(result: ChatCoreV2ShadowTurnResult): AuditSensitivity {
  if (result.traceSpans.some((span) => span.sensitivity === 'credential_adjacent')) return 'credential_adjacent';
  if (result.traceSpans.some((span) => span.sensitivity === 'financial')) return 'financial';
  if (result.traceSpans.some((span) => span.sensitivity === 'health_adjacent')) return 'health_adjacent';
  if (result.traceSpans.some((span) => span.sensitivity === 'personal')) return 'personal';
  return 'normal';
}

function retentionPolicyForShadowSensitivity(sensitivity: AuditSensitivity): AuditRetentionPolicy {
  return sensitivity === 'financial' || sensitivity === 'credential_adjacent' ? '30d' : '90d';
}

function buildShadowReplayBundleId(result: ChatCoreV2ShadowTurnResult): string {
  const hash = createHash('sha256')
    .update(`${result.turnId}:${result.orchestratorVersion}:${CHAT_CORE_V2_SHADOW_REPLAY_VERSION}`)
    .digest('hex')
    .slice(0, 16);
  return `chatv2-shadow-replay:${hash}`;
}
