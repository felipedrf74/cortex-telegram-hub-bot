// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';

export const DECISION_ACTION_SCHEMA_VERSION = 'decision_action.v1' as const;

export type DecisionActionRisk = 'low' | 'medium' | 'high' | 'critical';
export type DecisionActionReversibility = 'reversible' | 'compensatable' | 'irreversible';

export interface DecisionActionEntityRef {
  type: string;
  id: string;
  version?: string;
}

export interface DecisionActionResourceRef {
  type: string;
  id: string;
}

export interface DecisionActionTimeWindow {
  start: string;
  end: string;
  timezone: string;
}

export interface DecisionActionPrecondition {
  type: string;
  ref: string;
  expectedVersion?: string;
  required: boolean;
}

export interface DecisionActionEffect {
  type: string;
  targetRef: string;
  value?: string;
}

export interface NormalizedDecisionAction {
  schemaVersion: typeof DECISION_ACTION_SCHEMA_VERSION;
  intent: string;
  targetEntities: DecisionActionEntityRef[];
  affectedResources: DecisionActionResourceRef[];
  requestedWindow?: DecisionActionTimeWindow;
  preconditions: DecisionActionPrecondition[];
  expectedEffects: DecisionActionEffect[];
  prohibitedEffects: DecisionActionEffect[];
  dependencies: string[];
  exclusivityKeys: string[];
  candidateFingerprint: string;
  logicalActionHash: string;
  authorizationScope: string[];
  risk: DecisionActionRisk;
  reversibility: DecisionActionReversibility;
  contextVersion: string;
}

export interface BuildNormalizedDecisionActionInput extends Omit<
  NormalizedDecisionAction,
  'schemaVersion' | 'candidateFingerprint' | 'logicalActionHash'
> {}

const MAX_COLLECTION_ITEMS = 24;
const MAX_TOKEN_LENGTH = 240;

/**
 * Deterministically normalizes a proposed action and computes two different identities:
 * - candidateFingerprint: similarity/cooldown identity, deliberately independent of context version.
 * - logicalActionHash: exact side-effect identity, including context/entity versions.
 *
 * The contract accepts opaque identifiers and fixed-vocabulary effect codes only. Callers must not
 * place user copy, calendar titles, mail content, finance values, or provider payloads in these fields.
 */
export function buildNormalizedDecisionAction(input: BuildNormalizedDecisionActionInput): NormalizedDecisionAction {
  const normalized = normalizeDecisionAction({
    ...input,
    schemaVersion: DECISION_ACTION_SCHEMA_VERSION,
    candidateFingerprint: 'pending',
    logicalActionHash: 'pending',
  });
  if (!normalized) throw new Error('INVALID_NORMALIZED_DECISION_ACTION');

  return normalized;
}

export function decisionActionTimeBucket(window?: DecisionActionTimeWindow): string | null {
  if (!window) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: window.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(window.start));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    if (values.year && values.month && values.day) return `${values.year}-${values.month}-${values.day}:${window.timezone}`;
  } catch {
    // Invalid/unsupported zones should already have been rejected by their domain
    // adapter. Falling back to UTC keeps hashing deterministic and fail-safe.
  }
  return `${window.start.slice(0, 10)}:UTC`;
}

/** Validate and canonicalize an action restored from JSON. Invalid payloads fail closed to null. */
export function normalizeDecisionAction(value: unknown): NormalizedDecisionAction | null {
  if (!isRecord(value) || value.schemaVersion !== DECISION_ACTION_SCHEMA_VERSION) return null;
  const intent = token(value.intent);
  const contextVersion = token(value.contextVersion);
  if (!intent || !contextVersion) return null;

  if ([
    value.targetEntities,
    value.affectedResources,
    value.preconditions,
    value.expectedEffects,
    value.prohibitedEffects,
    value.dependencies,
    value.exclusivityKeys,
    value.authorizationScope,
  ].some(collectionExceedsLimit)) return null;

  const targetEntities = entityRefs(value.targetEntities);
  const affectedResources = resourceRefs(value.affectedResources);
  const preconditions = preconditionRefs(value.preconditions);
  const expectedEffects = effectRefs(value.expectedEffects);
  const prohibitedEffects = effectRefs(value.prohibitedEffects);
  const dependencies = tokenList(value.dependencies);
  const exclusivityKeys = tokenList(value.exclusivityKeys);
  const authorizationScope = tokenList(value.authorizationScope);
  const risk = value.risk;
  const reversibility = value.reversibility;
  const requestedWindow = timeWindow(value.requestedWindow);

  if (!isRisk(risk) || !isReversibility(reversibility)) return null;
  if (!targetEntities.length || !affectedResources.length || !exclusivityKeys.length) return null;
  if (value.requestedWindow != null && !requestedWindow) return null;

  const normalizedBase: NormalizedDecisionAction = {
    schemaVersion: DECISION_ACTION_SCHEMA_VERSION,
    intent,
    targetEntities,
    affectedResources,
    ...(requestedWindow ? { requestedWindow } : {}),
    preconditions,
    expectedEffects,
    prohibitedEffects,
    dependencies,
    exclusivityKeys,
    candidateFingerprint: 'pending',
    logicalActionHash: 'pending',
    authorizationScope,
    risk,
    reversibility,
    contextVersion,
  };
  const computed = computeActionIdentities(normalizedBase);
  const suppliedCandidateFingerprint = token(value.candidateFingerprint);
  const suppliedLogicalActionHash = token(value.logicalActionHash);
  if (suppliedCandidateFingerprint && suppliedCandidateFingerprint !== 'pending'
      && suppliedCandidateFingerprint !== computed.candidateFingerprint) return null;
  if (suppliedLogicalActionHash && suppliedLogicalActionHash !== 'pending'
      && suppliedLogicalActionHash !== computed.logicalActionHash) return null;
  return computed;
}

function computeActionIdentities(action: NormalizedDecisionAction): NormalizedDecisionAction {
  const candidateShape = {
    schemaVersion: action.schemaVersion,
    intent: action.intent,
    targetEntities: action.targetEntities.map(({ type, id }) => ({ type, id })),
    affectedResources: action.affectedResources,
    // Similarity deliberately uses a local-day bucket. Exact timestamps and
    // versions remain part of the logical action identity below.
    requestedWindowBucket: decisionActionTimeBucket(action.requestedWindow),
    expectedEffects: action.expectedEffects,
    prohibitedEffects: action.prohibitedEffects,
    exclusivityKeys: action.exclusivityKeys,
    risk: action.risk,
    reversibility: action.reversibility,
  };
  const logicalShape = {
    ...candidateShape,
    requestedWindow: action.requestedWindow,
    targetEntities: action.targetEntities,
    preconditions: action.preconditions,
    dependencies: action.dependencies,
    authorizationScope: action.authorizationScope,
    contextVersion: action.contextVersion,
  };
  return {
    ...action,
    candidateFingerprint: stableHash(candidateShape),
    logicalActionHash: stableHash(logicalShape),
  };
}

/**
 * Derive one privacy-safe identity for a concrete action attempt. The payload
 * participates in the hash but is never returned or persisted by this helper.
 */
export function logicalActionAttemptHash(
  baseLogicalActionHash: string,
  actionId: string,
  payload: Record<string, unknown>,
): string {
  return stableHash({ baseLogicalActionHash, actionId, payload });
}

function entityRefs(value: unknown): DecisionActionEntityRef[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: DecisionActionEntityRef[] = [];
  for (const item of value.slice(0, MAX_COLLECTION_ITEMS)) {
    if (!isRecord(item)) continue;
    const type = token(item.type);
    const id = token(item.id);
    const version = token(item.version);
    if (!type || !id) continue;
    const key = `${type}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ type, id, ...(version ? { version } : {}) });
  }
  return result.sort(compareTypeAndId);
}

function resourceRefs(value: unknown): DecisionActionResourceRef[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: DecisionActionResourceRef[] = [];
  for (const item of value.slice(0, MAX_COLLECTION_ITEMS)) {
    if (!isRecord(item)) continue;
    const type = token(item.type);
    const id = token(item.id);
    if (!type || !id) continue;
    const key = `${type}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ type, id });
  }
  return result.sort(compareTypeAndId);
}

function preconditionRefs(value: unknown): DecisionActionPrecondition[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_COLLECTION_ITEMS).flatMap((item) => {
    if (!isRecord(item)) return [];
    const type = token(item.type);
    const ref = token(item.ref);
    const expectedVersion = token(item.expectedVersion);
    if (!type || !ref || typeof item.required !== 'boolean') return [];
    return [{ type, ref, ...(expectedVersion ? { expectedVersion } : {}), required: item.required }];
  }).sort((a, b) => compareCodeUnits(`${a.type}:${a.ref}`, `${b.type}:${b.ref}`));
}

function effectRefs(value: unknown): DecisionActionEffect[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_COLLECTION_ITEMS).flatMap((item) => {
    if (!isRecord(item)) return [];
    const type = token(item.type);
    const targetRef = token(item.targetRef);
    const effectValue = token(item.value);
    if (!type || !targetRef) return [];
    return [{ type, targetRef, ...(effectValue ? { value: effectValue } : {}) }];
  }).sort((a, b) => compareCodeUnits(
    `${a.type}:${a.targetRef}:${a.value ?? ''}`,
    `${b.type}:${b.targetRef}:${b.value ?? ''}`,
  ));
}

function timeWindow(value: unknown): DecisionActionTimeWindow | null {
  if (value == null) return null;
  if (!isRecord(value)) return null;
  const start = token(value.start);
  const end = token(value.end);
  const timezone = token(value.timezone);
  if (!start || !end || !timezone) return null;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) return null;
  return { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), timezone };
}

function tokenList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.slice(0, MAX_COLLECTION_ITEMS).map(token).filter((item): item is string => !!item))]
    .sort(compareCodeUnits);
}

function token(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_TOKEN_LENGTH || /[\r\n\u0000-\u001f]/.test(trimmed)) return null;
  return trimmed;
}

function isRisk(value: unknown): value is DecisionActionRisk {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'critical';
}

function isReversibility(value: unknown): value is DecisionActionReversibility {
  return value === 'reversible' || value === 'compensatable' || value === 'irreversible';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function compareTypeAndId(a: { type: string; id: string }, b: { type: string; id: string }): number {
  return compareCodeUnits(`${a.type}:${a.id}`, `${b.type}:${b.id}`);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function collectionExceedsLimit(value: unknown): boolean {
  return Array.isArray(value) && value.length > MAX_COLLECTION_ITEMS;
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort(compareCodeUnits).map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
