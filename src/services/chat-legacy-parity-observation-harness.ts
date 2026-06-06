// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';

import {
  CHAT_V2_LEGACY_PARITY_OBSERVATION_VERSION,
  normalizeChatV2LegacyParityOwnerLabel,
  type ChatV2LegacyParityEvaluator,
  type ChatV2LegacyParityObservation,
} from './chat-legacy-parity-labels';
import type { ChatV2LegacyRetirementEvidenceSource } from './chat-legacy-retirement-evidence';
import { isResearchProviderRefusal } from './chat-research-refusal-policy';
import { isChatResearchAnswerIncomplete } from './chat-research-answer-quality';

export const CHAT_V2_LEGACY_PARITY_PROJECTION_VERSION = 'chat_v2_legacy_parity_projection.v1';
export const CHAT_V2_LEGACY_PARITY_COMPARATOR_VERSION = 'chat_v2_legacy_parity_comparator.v4';

export type ChatV2ParityActionability =
  | 'answer_only'
  | 'read'
  | 'write_preview'
  | 'write_execute'
  | 'clarify'
  | 'unsupported'
  | 'degraded'
  | 'unknown';

export type ChatV2ParityCardKind =
  | 'message'
  | 'read_result'
  | 'action_preview'
  | 'action_result'
  | 'clarification'
  | 'unsupported'
  | 'degraded'
  | 'unknown';

export interface ChatV2LegacyParityProjection {
  schemaVersion: typeof CHAT_V2_LEGACY_PARITY_PROJECTION_VERSION;
  routeId: string;
  owner: string;
  routeMethod: string;
  capabilityFamily: string;
  actionability: ChatV2ParityActionability;
  verificationStatus: string;
  cardKind: ChatV2ParityCardKind;
  requiresConfirmation: boolean;
  hasVisibleDiff: boolean;
  hasCommandEnvelope: boolean;
  responseQuality: 'usable' | 'provider_refusal' | 'incomplete_answer' | 'unknown';
  observedRouteIds: string[];
}

export interface ChatV2LegacyParityComparison {
  matched: boolean;
  reasonCodes: string[];
}

export interface BuildChatV2LegacyParityObservationInput {
  routeId: string;
  sampleKey: string;
  oldOwner: string;
  replacement: string;
  evaluator: ChatV2LegacyParityEvaluator;
  evidenceSource: ChatV2LegacyRetirementEvidenceSource;
  legacyProjection: ChatV2LegacyParityProjection;
  chatV2Projection: ChatV2LegacyParityProjection | null;
  hmacSecret: string;
}

type AnyRecord = Record<string, unknown>;

const SAFE_REASON_FALLBACK = 'parity_mismatch';
const WRITE_FIREWALL_BUNDLE_ROUTE_IDS = new Set([
  'general_action_planner',
  'chat_reasoning_engine_v1',
  'decision_confirmation_shortcut',
  'destructive_confirmation_hold',
]);

export function projectLegacyChatResponseForParity(input: {
  routeId: string;
  body: unknown;
  status?: number;
}): ChatV2LegacyParityProjection {
  if (isNonComparableHttpStatus(input.status)) {
    return buildNonComparableHttpProjection(input.routeId, input.status);
  }
  const body = asRecord(input.body);
  const metadata = asRecord(body?.metadata);
  const contract = asRecord(metadata?.chatReasoning);
  const chatCoreV2Metadata = asRecord(metadata?.chatCoreV2);
  const chatCoreV2Response = asRecord(chatCoreV2Metadata?.response);
  const chatCoreV2Command = asRecord(chatCoreV2Metadata?.command);
  const finalComposition = asRecord(metadata?.finalAnswerComposition);
  const actionConfirmation = asRecord(metadata?.actionConfirmation)
    ?? asRecord(metadata?.pendingConfirmation);
  const responseKind = stringOrNull(body?.kind)
    ?? stringOrNull(metadata?.responseKind)
    ?? stringOrNull(chatCoreV2Response?.kind)
    ?? stringOrNull(contract?.routeKind);
  const routeMethod = stringOrNull(body?.routeMethod)
    ?? stringOrNull(contract?.routeMethod)
    ?? 'unknown';
  const owner = stringOrNull(contract?.ownerSkill)
    ?? stringOrNull(body?.domain)
    ?? stringOrNull(metadata?.domain)
    ?? 'unknown';
  const capability = stringOrNull(metadata?.capabilityId)
    ?? stringOrNull(metadata?.finalCapabilityId)
    ?? stringOrNull(chatCoreV2Metadata?.capabilityId)
    ?? stringOrNull(contract?.intent)
    ?? owner
    ?? 'unknown';
  const actionability = normalizeActionability(
    stringOrNull(contract?.actionability)
      ?? stringOrNull(metadata?.actionability)
      ?? routeMethod
      ?? responseKind,
    {
      status: input.status,
      routeMethod,
      hasConfirmation: actionConfirmation != null,
      metadata,
    },
  );
  const cardKind = normalizeCardKind({
    actionability,
    responseKind,
    routeMethod,
    metadata,
    hasConfirmation: actionConfirmation != null,
  });
  const requiresConfirmation = actionConfirmation != null
    || actionability === 'write_preview'
    || routeMethod.includes('confirmation');
  const observedRouteIds = routeIdsForLegacyParityResponse({
    owner,
    routeMethod,
    capability,
    actionability,
    cardKind,
    requiresConfirmation,
    metadata,
  });
  const responseQuality = inferResponseQuality(input.routeId, body);

  return {
    schemaVersion: CHAT_V2_LEGACY_PARITY_PROJECTION_VERSION,
    routeId: input.routeId,
    owner: normalizeSafeToken(owner),
    routeMethod: normalizeSafeToken(routeMethod),
    capabilityFamily: normalizeCapabilityFamily(capability),
    actionability,
    verificationStatus: normalizeSafeToken(
      stringOrNull(contract?.verificationStatus)
        ?? stringOrNull(metadata?.verificationStatus)
        ?? (actionability === 'answer_only' || actionability === 'read' ? 'not_required' : 'unknown'),
    ),
    cardKind,
    requiresConfirmation,
    hasVisibleDiff: hasVisibleDiff(metadata),
    hasCommandEnvelope: Boolean(
      metadata?.command
        || metadata?.commandEnvelope
        || metadata?.actionCommand
        || metadata?.actionConfirmation
        || metadata?.pendingConfirmation
      || chatCoreV2Command,
    ),
    responseQuality,
    observedRouteIds,
  };
}

export function projectChatCoreV2CandidateForParity(input: {
  routeId: string;
  body: unknown;
  status?: number;
}): ChatV2LegacyParityProjection | null {
  if (isNonComparableHttpStatus(input.status)) {
    return projectLegacyChatResponseForParity(input);
  }
  const body = asRecord(input.body);
  const metadata = asRecord(body?.metadata);
  const routeMethod = stringOrNull(body?.routeMethod) ?? stringOrNull(asRecord(metadata?.chatReasoning)?.routeMethod);
  const metadataType = stringOrNull(metadata?.type);
  const hasChatV2Signal = Boolean(
    routeMethod?.includes('chat-core-v2')
      || metadataType?.startsWith('chat_core_v2')
      || asRecord(metadata?.chatCoreV2),
  );
  if (!hasChatV2Signal) return null;
  return projectLegacyChatResponseForParity(input);
}

function isNonComparableHttpStatus(status: number | undefined): status is number {
  return status === 401
    || status === 402
    || status === 403
    || status === 408
    || status === 409
    || status === 429
    || (typeof status === 'number' && status >= 500);
}

function buildNonComparableHttpProjection(routeId: string, status: number): ChatV2LegacyParityProjection {
  const statusToken = normalizeSafeToken(`http_status_${status}`);
  return {
    schemaVersion: CHAT_V2_LEGACY_PARITY_PROJECTION_VERSION,
    routeId,
    owner: 'transport',
    routeMethod: statusToken,
    capabilityFamily: 'transport',
    actionability: 'degraded',
    verificationStatus: statusToken,
    cardKind: 'degraded',
    requiresConfirmation: false,
    hasVisibleDiff: false,
    hasCommandEnvelope: false,
    responseQuality: 'unknown',
    observedRouteIds: [routeId],
  };
}

export function compareLegacyParityProjection(
  legacyProjection: ChatV2LegacyParityProjection,
  chatV2Projection: ChatV2LegacyParityProjection | null,
): ChatV2LegacyParityComparison {
  const reasonCodes: string[] = [];
  if (!chatV2Projection) {
    return { matched: false, reasonCodes: ['missing_chatv2_projection'] };
  }
  if (isDegradedProjection(legacyProjection) || isDegradedProjection(chatV2Projection)) {
    reasonCodes.push('degraded_not_comparable');
  }
  if (
    legacyProjection.responseQuality === 'provider_refusal'
    || chatV2Projection.responseQuality === 'provider_refusal'
  ) {
    reasonCodes.push(
      chatV2Projection.responseQuality === 'provider_refusal'
        ? 'chatv2_provider_refusal'
        : 'legacy_provider_refusal',
    );
  }
  if (
    legacyProjection.responseQuality === 'incomplete_answer'
    || chatV2Projection.responseQuality === 'incomplete_answer'
  ) {
    reasonCodes.push(
      chatV2Projection.responseQuality === 'incomplete_answer'
        ? 'chatv2_incomplete_answer'
        : 'legacy_incomplete_answer',
    );
  }
  if (
    !legacyProjection.observedRouteIds.includes(legacyProjection.routeId)
    && !isSafeWriteFirewallBundleRouteCoupling(legacyProjection, chatV2Projection)
  ) {
    reasonCodes.push('legacy_route_not_observed');
  }
  if (
    !chatV2Projection.observedRouteIds.includes(legacyProjection.routeId)
    && !isSafeChatV2ReplacementForLegacyRoute(legacyProjection, chatV2Projection)
    && !isSafeChatV2AnswerOwnerReplacement(legacyProjection, chatV2Projection)
  ) {
    reasonCodes.push('chatv2_route_not_observed');
  }
  if (
    legacyProjection.actionability !== chatV2Projection.actionability
    && !isSafeChatV2AnswerOwnerReplacement(legacyProjection, chatV2Projection)
  ) {
    reasonCodes.push('actionability_mismatch');
  }
  if (
    legacyProjection.capabilityFamily !== chatV2Projection.capabilityFamily
    && !isSafeChatV2ReplacementForLegacyRoute(legacyProjection, chatV2Projection)
    && !isSafeChatV2AnswerOwnerReplacement(legacyProjection, chatV2Projection)
  ) {
    reasonCodes.push('capability_family_mismatch');
  }
  if (
    legacyProjection.cardKind !== chatV2Projection.cardKind
    && !isSafeChatV2AnswerOwnerReplacement(legacyProjection, chatV2Projection)
  ) {
    reasonCodes.push('card_kind_mismatch');
  }
  if (
    legacyProjection.requiresConfirmation !== chatV2Projection.requiresConfirmation
  ) {
    reasonCodes.push('confirmation_policy_mismatch');
  }
  if (legacyProjection.hasCommandEnvelope !== chatV2Projection.hasCommandEnvelope
    && !isSafeChatV2CommandEnvelopeUpgrade(legacyProjection, chatV2Projection)) {
    reasonCodes.push('command_envelope_mismatch');
  }
  if (legacyProjection.hasVisibleDiff && !chatV2Projection.hasVisibleDiff) {
    reasonCodes.push('visible_diff_mismatch');
  }
  if (isUnsafeVerificationMismatch(legacyProjection, chatV2Projection)) {
    reasonCodes.push('verification_safety_mismatch');
  }
  return { matched: reasonCodes.length === 0, reasonCodes };
}

function inferResponseQuality(routeId: string, body: AnyRecord | null): ChatV2LegacyParityProjection['responseQuality'] {
  const text = [
    stringOrNull(body?.text),
    stringOrNull(asRecord(body?.data)?.text),
  ].find((value) => value?.trim());
  if (!text) return 'unknown';
  if (isResearchProviderRefusal(text)) return 'provider_refusal';
  if (routeId === 'selective_internet_research' && isChatResearchAnswerIncomplete(text)) {
    return 'incomplete_answer';
  }
  return 'usable';
}

export function buildChatV2LegacyParityObservation(
  input: BuildChatV2LegacyParityObservationInput,
): ChatV2LegacyParityObservation {
  const comparison = compareLegacyParityProjection(input.legacyProjection, input.chatV2Projection);
  return {
    schemaVersion: CHAT_V2_LEGACY_PARITY_OBSERVATION_VERSION,
    routeId: input.routeId,
    sampleHmac: buildLegacyParitySampleHmac({
      hmacSecret: input.hmacSecret,
      routeId: input.routeId,
      sampleKey: input.sampleKey,
      evidenceSource: input.evidenceSource,
    }),
    matched: comparison.matched,
    tested: true,
    oldOwner: normalizeOwnerLabel(input.oldOwner),
    replacement: normalizeOwnerLabel(input.replacement),
    evaluator: input.evaluator,
    evidenceSource: input.evidenceSource,
    reasonCode: comparison.matched ? 'matched' : safeReasonCode(comparison.reasonCodes[0]),
  };
}

export function buildLegacyParitySampleHmac(input: {
  hmacSecret: string;
  routeId: string;
  sampleKey: string;
  evidenceSource: ChatV2LegacyRetirementEvidenceSource;
}): string {
  const routeId = normalizeRouteId(input.routeId);
  const stableKey = `${input.evidenceSource}:${routeId}:${input.sampleKey}`;
  return `hmac:legacy-parity:${crypto.createHmac('sha256', input.hmacSecret).update(stableKey).digest('hex')}`;
}

export function routeIdsForLegacyParityResponse(input: {
  owner: string;
  routeMethod: string;
  capability: string;
  actionability: ChatV2ParityActionability;
  cardKind: ChatV2ParityCardKind;
  requiresConfirmation?: boolean;
  metadata?: AnyRecord | null;
}): string[] {
  const routeIds = new Set<string>();
  const owner = input.owner.toLowerCase();
  const routeMethod = input.routeMethod.toLowerCase();
  const capability = input.capability.toLowerCase();
  const metadataType = stringOrNull(input.metadata?.type)?.toLowerCase() ?? '';
  const primaryIntent = stringOrNull(asRecord(input.metadata?.actionFrame)?.primaryIntent)?.toLowerCase() ?? '';
  const pendingConfirmation = asRecord(input.metadata?.pendingConfirmation);
  const actionConfirmation = asRecord(input.metadata?.actionConfirmation);
  const hasDecisionReference = Boolean(
    input.metadata?.decisionId
      || pendingConfirmation?.decisionId
      || actionConfirmation?.decisionId
      || asRecord(input.metadata?.confirmationDecision)?.decisionId,
  );

  if (routeMethod.includes('chat-reasoning-engine')) routeIds.add('chat_reasoning_engine_v1');
  if (routeMethod.includes('classifier') || routeMethod.includes('keyword')) {
    routeIds.add('classifier_route_skill_orchestration');
  }
  const explicitTokenZero = Boolean(
    input.metadata?.tokenZeroSurface
      || input.metadata?.tokenZeroPreserved
      || metadataType.includes('token_zero'),
  );
  if (explicitTokenZero) {
    routeIds.add('token_zero_message_shortcuts');
  } else if (routeMethod.includes('fast-path') || routeMethod.includes('deterministic-read') || routeMethod.includes('shortcut')) {
    routeIds.add('chat_message_shortcut_after_route');
  }
  if (routeMethod.includes('confirmation') || input.requiresConfirmation === true || input.cardKind === 'clarification') {
    routeIds.add('destructive_confirmation_hold');
  }
  if (routeMethod.includes('decision') || capability.includes('decision') || metadataType.includes('decision') || hasDecisionReference) {
    routeIds.add('decision_confirmation_shortcut');
  }
  if (routeMethod.includes('research') || capability.includes('research') || capability.includes('internet')) {
    routeIds.add('selective_internet_research');
  }
  if (owner === 'training' || capability.includes('training')) {
    routeIds.add('training_plan_shortcut');
  }
  if (input.actionability === 'write_preview' || input.actionability === 'write_execute' || primaryIntent) {
    routeIds.add('general_action_planner');
  }
  if (owner && !['chat', 'general', 'unknown'].includes(owner)) {
    routeIds.add('domain_handler_execution');
  }
  return [...routeIds].sort();
}

export function normalizeRouteId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
}

function normalizeActionability(
  raw: string | null,
  input: { status?: number; routeMethod: string; hasConfirmation: boolean; metadata: AnyRecord | null },
): ChatV2ParityActionability {
  const value = String(raw ?? '').toLowerCase();
  if (value.includes('clarif')) return 'clarify';
  if (value.includes('unsupported')) return 'unsupported';
  if (value.includes('degraded')) return 'degraded';
  if (
    value.includes('write_execute')
    || value.includes('action_result')
    || value === 'execute'
    || value === 'executed'
    || value.includes('_execute')
    || value.includes('execute_')
  ) return 'write_execute';
  if (value.includes('write_preview') || value.includes('preview')) return 'write_preview';
  if (value.includes('read') || value.includes('local_read')) return 'read';
  if (value.includes('answer_only') || value.includes('answer')) return 'answer_only';
  if (input.hasConfirmation || input.status === 202) return 'write_preview';
  if (input.routeMethod.includes('read') || input.routeMethod.includes('fast-path')) return 'read';
  if (input.routeMethod.includes('chat-reasoning-engine')) return 'write_preview';
  return 'unknown';
}

function normalizeCardKind(input: {
  actionability: ChatV2ParityActionability;
  responseKind: string | null;
  routeMethod: string;
  metadata: AnyRecord | null;
  hasConfirmation: boolean;
}): ChatV2ParityCardKind {
  const value = String(input.responseKind ?? '').toLowerCase();
  if (value.includes('clarif')) return 'clarification';
  if (value.includes('unsupported')) return 'unsupported';
  if (value.includes('degraded')) return 'degraded';
  if (value.includes('action_result')) return 'action_result';
  if (value.includes('action_preview')) return 'action_preview';
  if (input.hasConfirmation) return 'action_preview';
  if (input.actionability === 'write_preview') return 'action_preview';
  if (input.actionability === 'write_execute') return 'action_result';
  if (input.actionability === 'read') return 'read_result';
  if (input.actionability === 'answer_only') return 'message';
  return 'unknown';
}

function hasVisibleDiff(metadata: AnyRecord | null): boolean {
  if (!metadata) return false;
  if (metadata.actionConfirmation || metadata.pendingConfirmation) return true;
  if (Array.isArray(metadata.visibleDiff) && metadata.visibleDiff.length > 0) return true;
  if (metadata.diffRequired === false) return true;
  if (typeof metadata.title === 'string') return true;
  if (Array.isArray(metadata.subtasks) && metadata.subtasks.length > 0) return true;
  const directResponse = asRecord(metadata.response);
  if (cardsHaveVisibleDiff(directResponse?.cards)) return true;
  const chatCoreV2 = asRecord(metadata.chatCoreV2);
  const chatCoreV2Response = asRecord(chatCoreV2?.response);
  if (cardsHaveVisibleDiff(chatCoreV2Response?.cards)) return true;
  const actionFrame = asRecord(metadata.actionFrame);
  return Boolean(actionFrame?.primaryIntent);
}

function normalizeCapabilityFamily(value: string | null): string {
  const token = normalizeSafeToken(value ?? 'unknown');
  if (token.includes('.')) return token.split('.')[0] || 'unknown';
  if (token.includes('_')) return token.split('_')[0] || 'unknown';
  return token || 'unknown';
}

function normalizeSafeToken(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
  return normalized || 'unknown';
}

function normalizeOwnerLabel(value: string): string {
  return normalizeChatV2LegacyParityOwnerLabel(value);
}

function isUnsafeVerificationMismatch(
  legacyProjection: ChatV2LegacyParityProjection,
  chatV2Projection: ChatV2LegacyParityProjection,
): boolean {
  if (legacyProjection.actionability !== 'write_execute' && chatV2Projection.actionability !== 'write_execute') {
    return false;
  }
  const legacyVerified = ['verified', 'not_required'].includes(legacyProjection.verificationStatus);
  const chatV2Verified = ['verified', 'not_required'].includes(chatV2Projection.verificationStatus);
  return legacyVerified !== chatV2Verified;
}

function isDegradedProjection(projection: ChatV2LegacyParityProjection): boolean {
  return projection.actionability === 'degraded'
    || projection.cardKind === 'degraded'
    || projection.routeMethod.includes('degraded')
    || projection.routeMethod.includes('unavailable')
    || projection.verificationStatus.includes('degraded');
}

function isSafeChatV2ReplacementForLegacyRoute(
  legacyProjection: ChatV2LegacyParityProjection,
  chatV2Projection: ChatV2LegacyParityProjection,
): boolean {
  if (legacyProjection.routeId === 'decision_confirmation_shortcut') {
    return legacyProjection.actionability === 'write_preview'
      && chatV2Projection.actionability === 'write_preview'
      && chatV2Projection.routeMethod.includes('chat-core-v2-command-preview')
      && chatV2Projection.capabilityFamily === 'decision_center'
      && chatV2Projection.requiresConfirmation
      && chatV2Projection.hasCommandEnvelope
      && chatV2Projection.hasVisibleDiff;
  }
  if (!['chat_reasoning_engine_v1', 'general_action_planner'].includes(legacyProjection.routeId)) return false;
  return legacyProjection.actionability === 'write_preview'
    && chatV2Projection.actionability === 'write_preview'
    && chatV2Projection.routeMethod.includes('chat-core-v2-command-preview')
    && legacyProjection.capabilityFamily === chatV2Projection.capabilityFamily
    && chatV2Projection.requiresConfirmation
    && chatV2Projection.hasCommandEnvelope
    && chatV2Projection.hasVisibleDiff;
}

function isSafeWriteFirewallBundleRouteCoupling(
  legacyProjection: ChatV2LegacyParityProjection,
  chatV2Projection: ChatV2LegacyParityProjection,
): boolean {
  if (!WRITE_FIREWALL_BUNDLE_ROUTE_IDS.has(legacyProjection.routeId)) return false;
  const observedWriteBundleRoute = legacyProjection.observedRouteIds.some((routeId) =>
    WRITE_FIREWALL_BUNDLE_ROUTE_IDS.has(routeId),
  );
  if (!observedWriteBundleRoute) return false;
  return isSafeWritePreviewContract(legacyProjection)
    && isSafeWritePreviewContract(chatV2Projection);
}

function isSafeWritePreviewContract(projection: ChatV2LegacyParityProjection): boolean {
  return projection.actionability === 'write_preview'
    && projection.requiresConfirmation
    && projection.hasCommandEnvelope
    && projection.hasVisibleDiff
    && (projection.cardKind === 'action_preview' || projection.cardKind === 'clarification');
}

function isSafeChatV2AnswerOwnerReplacement(
  legacyProjection: ChatV2LegacyParityProjection,
  chatV2Projection: ChatV2LegacyParityProjection,
): boolean {
  if (!['classifier_route_skill_orchestration', 'domain_handler_execution'].includes(legacyProjection.routeId)) {
    return false;
  }
  if (
    !chatV2Projection.routeMethod.includes('chat-core-v2-local-llm')
    && !chatV2Projection.routeMethod.includes('chat-core-v2-deterministic-read')
  ) return false;
  return (legacyProjection.actionability === 'answer_only' || legacyProjection.actionability === 'read')
    && (chatV2Projection.actionability === 'answer_only' || chatV2Projection.actionability === 'read')
    && (chatV2Projection.cardKind === 'message' || chatV2Projection.cardKind === 'read_result');
}

function isSafeChatV2CommandEnvelopeUpgrade(
  legacyProjection: ChatV2LegacyParityProjection,
  chatV2Projection: ChatV2LegacyParityProjection,
): boolean {
  return legacyProjection.hasCommandEnvelope === false
    && chatV2Projection.hasCommandEnvelope === true
    && legacyProjection.actionability === 'write_preview'
    && chatV2Projection.actionability === 'write_preview';
}

function safeReasonCode(value: string | undefined): string {
  const normalized = String(value ?? SAFE_REASON_FALLBACK)
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
  return normalized || SAFE_REASON_FALLBACK;
}

function asRecord(value: unknown): AnyRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AnyRecord : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function cardsHaveVisibleDiff(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((card) => {
    const record = asRecord(card);
    if (!record) return false;
    if (Array.isArray(record.diff) && record.diff.length > 0) return true;
    if (Array.isArray(record.visibleDiff) && record.visibleDiff.length > 0) return true;
    if (typeof record.summary === 'string' && record.summary.trim()) return true;
    if (typeof record.title === 'string' && record.title.trim()) return true;
    return false;
  });
}
