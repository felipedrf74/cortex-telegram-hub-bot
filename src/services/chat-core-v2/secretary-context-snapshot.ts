// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';

import {
  buildChatPromptContext,
  type BuildChatPromptContextInput,
  type ChatContextItem,
  type ChatContextSource,
  type ChatContextSourceDiagnostic,
  type ChatPromptContext,
} from '../chat-context-engine';
import type { AuditSensitivity } from './types';
import { collectSecretaryOperationalContext } from './secretary-operational-context';

export const SECRETARY_CONTEXT_SNAPSHOT_SCHEMA_VERSION = 'secretary_context.v1' as const;

export type SecretaryFactCategory =
  | 'verified_fact'
  | 'explicit_user_instruction'
  | 'existing_commitment'
  | 'preference'
  | 'inferred_intent'
  | 'assumption'
  | 'unresolved_question';

export type SecretaryContextReliability = 'authoritative' | 'verified' | 'advisory' | 'inferred';
export type SecretaryContextSourceStatus = 'available' | 'empty' | 'unknown' | 'stale' | 'failed' | 'permission_denied';

export interface SecretaryContextFact {
  evidenceId: string;
  category: SecretaryFactCategory;
  tenantId: number;
  userId: number;
  ownerUserId: number;
  visibilityScope: ChatContextItem['scope'];
  source: ChatContextSource;
  sourceRef?: string;
  observedAt: string;
  freshness: ChatContextItem['freshness'];
  reliability: SecretaryContextReliability;
  confidence: number;
  critical: boolean;
  provenanceReason: string;
  permissionRequirements: string[];
  entityVersion: string;
  expiresAt?: string | null;
  sensitivity: AuditSensitivity;
  /** In-memory prompt evidence only. Persist hashes/ids, never this value. */
  value: string;
}

export interface SecretaryContextSourceHealth {
  source: ChatContextSource;
  status: SecretaryContextSourceStatus;
  observedAt: string;
  staleAfter?: string | null;
  reasonCode?: string;
}

export interface SecretaryUnresolvedQuestion {
  code: string;
  question: string;
}

export interface SecretaryContextSnapshot {
  schemaVersion: typeof SECRETARY_CONTEXT_SNAPSHOT_SCHEMA_VERSION;
  snapshotId: string;
  contextHash: string;
  contextVersion: string;
  tenantId: number;
  userId: number;
  observedAt: string;
  expiresAt: string;
  facts: SecretaryContextFact[];
  sourceHealth: SecretaryContextSourceHealth[];
  unresolvedQuestions: SecretaryUnresolvedQuestion[];
  entityVersions: Record<string, string>;
  permissionSnapshotVersion: string;
}

export interface SecretarySourceDiagnostic {
  source: ChatContextSource;
  status: Extract<SecretaryContextSourceStatus, 'failed' | 'permission_denied' | 'stale'>;
  reasonCode: string;
  observedAt?: string;
  staleAfter?: string | null;
}

export async function buildSecretaryContextSnapshot(
  input: BuildChatPromptContextInput & { userId: number; tenantId: number },
  options: { now?: Date; sourceDiagnostics?: SecretarySourceDiagnostic[] } = {},
): Promise<SecretaryContextSnapshot> {
  const promptContext = await buildChatPromptContext(input);
  const operational = await collectSecretaryOperationalContext({
    message: input.message,
    userId: input.userId,
    tenantId: input.tenantId,
    planning: promptContext.intent.planning,
    now: options.now,
  });
  return buildSecretaryContextSnapshotFromPromptContext({
    ...promptContext,
    items: [...promptContext.items, ...operational.items],
    sourceDiagnostics: [...(promptContext.sourceDiagnostics ?? []), ...operational.diagnostics],
  }, options);
}

export function buildSecretaryContextSnapshotFromPromptContext(
  context: ChatPromptContext,
  options: { now?: Date; sourceDiagnostics?: SecretarySourceDiagnostic[] } = {},
): SecretaryContextSnapshot {
  if (context.userId == null || context.tenantId == null) {
    throw new Error('SECRETARY_CONTEXT_SCOPE_REQUIRED');
  }
  const now = options.now ?? new Date();
  const observedAt = now.toISOString();
  const diagnostics = new Map<ChatContextSource, ChatContextSourceDiagnostic | SecretarySourceDiagnostic>();
  for (const item of context.sourceDiagnostics ?? []) diagnostics.set(item.source, item);
  for (const item of options.sourceDiagnostics ?? []) diagnostics.set(item.source, item);
  const facts = context.items.map((item) => factFromContextItem(item, observedAt));
  const expectedSources = [...new Set([
    ...expectedContextSources(context),
    ...diagnostics.keys(),
  ])].sort();
  const sourceHealth = expectedSources.map((source): SecretaryContextSourceHealth => {
    const diagnostic = diagnostics.get(source);
    if (diagnostic) {
      return {
        source,
        status: diagnostic.status,
        observedAt: diagnostic.observedAt ?? observedAt,
        staleAfter: diagnostic.staleAfter ?? null,
        ...(diagnostic.reasonCode ? { reasonCode: safeReasonCode(diagnostic.reasonCode) } : {}),
      };
    }
    const items = context.items.filter((item) => item.source === source);
    if (items.length === 0) return { source, status: 'empty', observedAt };
    const allStale = items.every((item) => item.freshness === 'stale');
    return {
      source,
      status: allStale ? 'stale' : 'available',
      observedAt,
      staleAfter: earliestDate(items.map((item) => item.staleAfter ?? null)),
      ...(allStale ? { reasonCode: 'source_items_stale' } : {}),
    };
  });
  // Optional evidence that is already stale must not expire an otherwise
  // usable snapshot globally. Candidate policy evaluates the freshness of the
  // evidence it actually cites; the snapshot TTL is the earliest future
  // expiry among currently usable items, with a short bounded default.
  const expiresAt = earliestFutureDate(
    context.items
      .filter((item) => item.freshness !== 'stale' && item.confidence > 0)
      .map((item) => item.staleAfter ?? item.expiresAt ?? null),
    now,
  )
    ?? new Date(now.getTime() + 5 * 60_000).toISOString();
  const unresolvedQuestions = context.weakSignals.map((signal) => ({
    code: signal.code,
    question: signal.suggestedQuestion,
  }));
  const entityVersions = Object.fromEntries(facts
    .map((fact) => [fact.sourceRef || fact.evidenceId, fact.entityVersion] as const)
    .sort(([left], [right]) => left.localeCompare(right)));
  const permissionSnapshotVersion = `perm_${sha256(stableJson(facts.map((fact) => ({
    evidenceId: fact.evidenceId,
    tenantId: fact.tenantId,
    userId: fact.userId,
    ownerUserId: fact.ownerUserId,
    visibilityScope: fact.visibilityScope,
    permissionRequirements: fact.permissionRequirements,
  })))).slice(0, 24)}`;
  const contextVersionShape = {
    schemaVersion: SECRETARY_CONTEXT_SNAPSHOT_SCHEMA_VERSION,
    tenantId: context.tenantId,
    userId: context.userId,
    facts: facts.map((fact) => ({
      evidenceId: fact.evidenceId,
      category: fact.category,
      tenantId: fact.tenantId,
      userId: fact.userId,
      ownerUserId: fact.ownerUserId,
      visibilityScope: fact.visibilityScope,
      source: fact.source,
      sourceRef: fact.sourceRef,
      freshness: fact.freshness,
      reliability: fact.reliability,
      confidence: fact.confidence,
      critical: fact.critical,
      permissionRequirements: fact.permissionRequirements,
      entityVersion: fact.entityVersion,
      value: sha256(fact.value),
    })),
    sourceHealth: sourceHealth.map(({ source, status, reasonCode, staleAfter }) => ({ source, status, reasonCode, staleAfter })),
    unresolvedQuestions,
    entityVersions,
    permissionSnapshotVersion,
  };
  const contextHash = sha256(stableJson(contextVersionShape));
  const contextVersion = `ctx_${contextHash.slice(0, 32)}`;
  const snapshotId = `secretary_snapshot_${sha256(`${contextVersion}:${observedAt}`).slice(0, 24)}`;
  return {
    schemaVersion: SECRETARY_CONTEXT_SNAPSHOT_SCHEMA_VERSION,
    snapshotId,
    contextHash,
    contextVersion,
    tenantId: context.tenantId,
    userId: context.userId,
    observedAt,
    expiresAt,
    facts,
    sourceHealth,
    unresolvedQuestions,
    entityVersions,
    permissionSnapshotVersion,
  };
}

function factFromContextItem(item: ChatContextItem, observedAt: string): SecretaryContextFact {
  const entityVersion = item.entityVersion || `evidence_${sha256(stableJson({
    source: item.source,
    sourceRef: item.sourceRef,
    content: item.content,
    freshness: item.freshness,
    expiresAt: item.expiresAt,
    staleAfter: item.staleAfter,
  })).slice(0, 24)}`;
  return {
    evidenceId: item.id,
    category: categoryFor(item),
    tenantId: item.tenantId,
    userId: item.userId,
    ownerUserId: item.ownerUserId,
    visibilityScope: item.scope,
    source: item.source,
    ...(item.sourceRef ? { sourceRef: item.sourceRef } : {}),
    observedAt: item.observedAt ?? observedAt,
    freshness: item.freshness,
    reliability: reliabilityFor(item),
    confidence: clampConfidence(item.confidence),
    critical: item.critical === true,
    provenanceReason: item.reason,
    permissionRequirements: [...new Set(item.permissionRequirements)].sort(),
    entityVersion,
    ...(item.expiresAt !== undefined ? { expiresAt: item.expiresAt } : {}),
    sensitivity: sensitivityFor(item),
    value: item.content,
  };
}

function categoryFor(item: ChatContextItem): SecretaryFactCategory {
  switch (item.source) {
    case 'current_turn':
      if (isInterrogativeCurrentTurn(item.content)) return 'inferred_intent';
      if (/\b(prefer|preference|usually|normalmente|prefiro|prefer[eê]ncia)\b/i.test(item.content)) return 'preference';
      return /\b(action|move|cancel|delete|reschedule|remember|prefer|change|mover|cancel(?:a|e|ar|em)?|apag(?:a|ue|ar|uem)?|remarc(?:a|ar|a-me|a-o)?|prefiro)\b/i.test(item.content)
        ? 'explicit_user_instruction'
        : 'inferred_intent';
    case 'authenticated_profile': return 'verified_fact';
    case 'shared_memory': return 'preference';
    case 'shared_decision_context': return 'existing_commitment';
    case 'daily_context': return 'assumption';
    case 'tasks': return 'verified_fact';
    case 'calendar': return 'verified_fact';
    case 'training': return 'verified_fact';
    case 'readiness': return 'verified_fact';
    case 'content': return 'verified_fact';
    case 'mail': return 'verified_fact';
    case 'reminders': return 'verified_fact';
    case 'garmin': return 'verified_fact';
    case 'conversation_history': return 'assumption';
    case 'weak_context_guardrail': return 'unresolved_question';
  }
}

function isInterrogativeCurrentTurn(content: string): boolean {
  const normalized = extractCurrentUserRequest(content);
  return normalized.includes('?')
    || /^(should|can|could|would|do|does|did|is|are|what|when|where|why|how|devo|posso|podes|poderia|ser[aá]|o\s+que|qual|quando|onde|por\s+qu[eê]|como)\b/i.test(normalized)
    || /\b(whether\s+(?:i|we)\s+should|se\s+devo|ach[ao]\s+que\s+devo)\b/i.test(normalized);
}

/**
 * `chat-context-engine` deliberately wraps the current turn in a bounded,
 * canonical evidence record. Classification must inspect the actual request,
 * not the wrapper label, otherwise a production-shaped question such as
 * `Current user request: "Can you cancel this"` falls through to the action
 * verb matcher and is incorrectly promoted to an explicit instruction.
 */
function extractCurrentUserRequest(content: string): string {
  const trimmed = content.trim();
  const firstLine = trimmed.match(/^Current user request:\s*(.+?)(?:\r?\n|$)/i)?.[1]?.trim();
  if (!firstLine) return trimmed;
  if (firstLine.startsWith('"') && firstLine.endsWith('"')) {
    try {
      const decoded = JSON.parse(firstLine);
      if (typeof decoded === 'string') return decoded.trim();
    } catch {
      // Fall through to the bounded quote trim for older/non-JSON wrappers.
    }
    return firstLine.slice(1, -1).trim();
  }
  return firstLine;
}

function reliabilityFor(item: ChatContextItem): SecretaryContextReliability {
  if (item.confidence <= 0 || item.freshness === 'stale') return 'inferred';
  if (item.source === 'current_turn' || item.source === 'authenticated_profile') return 'authoritative';
  if (
    item.source === 'tasks'
    || item.source === 'calendar'
    || item.source === 'training'
    || item.source === 'readiness'
    || item.source === 'content'
    || item.source === 'mail'
    || item.source === 'reminders'
    || item.source === 'garmin'
    || item.source === 'shared_decision_context'
  ) return 'verified';
  if (item.source === 'daily_context') return 'advisory';
  if (item.source === 'shared_memory') return 'advisory';
  return 'inferred';
}

function sensitivityFor(item: ChatContextItem): AuditSensitivity {
  if (item.source === 'readiness' || item.source === 'garmin') return 'health_adjacent';
  if (
    item.source === 'current_turn'
    || item.source === 'authenticated_profile'
    || item.source === 'shared_memory'
    || item.source === 'conversation_history'
    || item.source === 'tasks'
    || item.source === 'calendar'
    || item.source === 'mail'
    || item.source === 'reminders'
  ) {
    return 'personal';
  }
  return 'normal';
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function expectedContextSources(context: ChatPromptContext): ChatContextSource[] {
  const sources = new Set<ChatContextSource>(['current_turn', 'authenticated_profile']);
  if (context.intent.planning || context.domain === 'secretary') {
    sources.add('daily_context');
    sources.add('shared_decision_context');
    sources.add('shared_memory');
  }
  if (context.intent.ambiguousFollowUp || context.intent.actionReference || context.intent.asksWhy) {
    sources.add('conversation_history');
  }
  return [...sources].sort();
}

function earliestDate(values: Array<string | null>): string | null {
  const times = values
    .filter((value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)))
    .map((value) => Date.parse(value));
  return times.length > 0 ? new Date(Math.min(...times)).toISOString() : null;
}

function earliestFutureDate(values: Array<string | null>, now: Date): string | null {
  const nowMs = now.getTime();
  const times = values
    .filter((value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)))
    .map((value) => Date.parse(value))
    .filter((value) => value > nowMs);
  return times.length > 0 ? new Date(Math.min(...times)).toISOString() : null;
}

function safeReasonCode(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_:-]+/g, '_').slice(0, 120);
  return normalized || 'unspecified_source_failure';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
