// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';
import { DecisionCenterError } from './errors';

export const DECISION_CURSOR_SCHEMA_VERSION = 2 as const;
const CURSOR_MAX_LENGTH = 2_048;

export type DecisionRankTier = 'critical' | 'high' | 'normal' | 'low';

export interface DecisionRankTuple {
  readonly priorityTier: DecisionRankTier;
  readonly priorityScore: number;
  readonly createdAt: string;
  readonly decisionId: string;
}

export interface DecisionSnapshotCursor {
  readonly kind: 'snapshot';
  readonly version: typeof DECISION_CURSOR_SCHEMA_VERSION;
  readonly snapshotId: string;
  readonly rankingAsOf: string;
  readonly rankingVersion: number;
  readonly filterFingerprint: string;
  readonly rank: DecisionRankTuple;
}

/** Shape issued by the pre-snapshot API v2 cursor implementation. */
export interface DecisionLegacyCursor {
  readonly kind: 'legacy';
  readonly priorityScore: number;
  readonly createdAt: string;
  readonly decisionId: string;
  readonly rankingVersion: number;
}

export type DecodedDecisionCursor = DecisionSnapshotCursor | DecisionLegacyCursor;

export interface DecisionCursorBinding {
  readonly snapshotId: string;
  readonly rankingAsOf: string;
  readonly rankingVersion: number;
  readonly filterFingerprint: string;
}

export function decisionFilterFingerprint(filters: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(stableJson(filters)).digest('hex');
}

export function encodeDecisionSnapshotCursor(cursor: Omit<DecisionSnapshotCursor, 'kind' | 'version'>): string {
  assertSnapshotCursor({ kind: 'snapshot', version: DECISION_CURSOR_SCHEMA_VERSION, ...cursor });
  const payload = {
    v: DECISION_CURSOR_SCHEMA_VERSION,
    sid: cursor.snapshotId,
    ra: cursor.rankingAsOf,
    rv: cursor.rankingVersion,
    ff: cursor.filterFingerprint,
    rank: {
      pt: cursor.rank.priorityTier,
      ps: cursor.rank.priorityScore,
      ca: cursor.rank.createdAt,
      id: cursor.rank.decisionId,
    },
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** Decode v2 snapshot cursors and the exact legacy tuple without silent fallback. */
export function decodeDecisionCursorToken(raw: string): DecodedDecisionCursor {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > CURSOR_MAX_LENGTH
    || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw malformedCursor('encoding');
  }

  let decoded: unknown;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    if (Buffer.from(json, 'utf8').toString('base64url') !== raw) throw new Error('non-canonical');
    decoded = JSON.parse(json);
  } catch {
    throw malformedCursor('payload');
  }

  if (!isRecord(decoded)) throw malformedCursor('shape');
  if (decoded.v === DECISION_CURSOR_SCHEMA_VERSION) return decodeSnapshotCursor(decoded);
  if (decoded.v === undefined) return decodeLegacyCursor(decoded);
  throw malformedCursor('version');
}

/**
 * Bind a decoded cursor to the exact snapshot, filters, and ranking policy.
 * Legacy cursors remain accepted when their ranking version is current.
 */
export function assertDecisionCursorBinding(
  cursor: DecodedDecisionCursor,
  binding: DecisionCursorBinding,
): void {
  if (!Number.isSafeInteger(binding.rankingVersion) || binding.rankingVersion < 1) {
    throw new DecisionCenterError(
      'DECISION_CURSOR_STALE',
      'Decision cursor ranking policy is unavailable.',
      409,
      { reason: 'ranking_version' },
    );
  }
  if (cursor.rankingVersion !== binding.rankingVersion) {
    throw staleCursor('ranking_version');
  }
  if (cursor.kind === 'legacy') return;
  if (cursor.snapshotId !== binding.snapshotId) throw staleCursor('snapshot');
  if (cursor.rankingAsOf !== binding.rankingAsOf) throw staleCursor('ranking_as_of');
  if (cursor.filterFingerprint !== binding.filterFingerprint) throw staleCursor('filters');
}

function decodeSnapshotCursor(value: Readonly<Record<string, unknown>>): DecisionSnapshotCursor {
  if (!isRecord(value.rank)) throw malformedCursor('rank');
  const cursor: DecisionSnapshotCursor = {
    kind: 'snapshot',
    version: DECISION_CURSOR_SCHEMA_VERSION,
    snapshotId: asBoundedString(value.sid, 'snapshot_id', 200),
    rankingAsOf: asIsoInstant(value.ra, 'ranking_as_of'),
    rankingVersion: asPositiveInteger(value.rv, 'ranking_version'),
    filterFingerprint: asFingerprint(value.ff),
    rank: Object.freeze({
      priorityTier: asRankTier(value.rank.pt),
      priorityScore: asFiniteNumber(value.rank.ps, 'priority_score'),
      createdAt: asIsoInstant(value.rank.ca, 'created_at'),
      decisionId: asBoundedString(value.rank.id, 'decision_id', 255),
    }),
  };
  assertSnapshotCursor(cursor);
  return Object.freeze(cursor);
}

function decodeLegacyCursor(value: Readonly<Record<string, unknown>>): DecisionLegacyCursor {
  const cursor: DecisionLegacyCursor = {
    kind: 'legacy',
    priorityScore: asFiniteNumber(value.ps, 'priority_score'),
    createdAt: asIsoInstant(value.ca, 'created_at'),
    decisionId: asBoundedString(value.id, 'decision_id', 255),
    rankingVersion: asPositiveInteger(value.rv, 'ranking_version'),
  };
  return Object.freeze(cursor);
}

function assertSnapshotCursor(cursor: DecisionSnapshotCursor): void {
  asBoundedString(cursor.snapshotId, 'snapshot_id', 200);
  asIsoInstant(cursor.rankingAsOf, 'ranking_as_of');
  asPositiveInteger(cursor.rankingVersion, 'ranking_version');
  asFingerprint(cursor.filterFingerprint);
  asRankTier(cursor.rank.priorityTier);
  asFiniteNumber(cursor.rank.priorityScore, 'priority_score');
  asIsoInstant(cursor.rank.createdAt, 'created_at');
  asBoundedString(cursor.rank.decisionId, 'decision_id', 255);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new DecisionCenterError('DECISION_CURSOR_MALFORMED', 'Decision filters contain a non-finite number.', 400);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  throw new DecisionCenterError('DECISION_CURSOR_MALFORMED', 'Decision filters contain an unsupported value.', 400);
}

function asRankTier(value: unknown): DecisionRankTier {
  if (value === 'critical' || value === 'high' || value === 'normal' || value === 'low') return value;
  throw malformedCursor('priority_tier');
}

function asFingerprint(value: unknown): string {
  if (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) return value;
  throw malformedCursor('filter_fingerprint');
}

function asPositiveInteger(value: unknown, reason: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  throw malformedCursor(reason);
}

function asFiniteNumber(value: unknown, reason: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw malformedCursor(reason);
}

function asIsoInstant(value: unknown, reason: string): string {
  if (typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value))) return value;
  throw malformedCursor(reason);
}

function asBoundedString(value: unknown, reason: string, maxLength: number): string {
  if (typeof value === 'string' && value.length > 0 && value.length <= maxLength) return value;
  throw malformedCursor(reason);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function malformedCursor(reason: string): DecisionCenterError<'DECISION_CURSOR_MALFORMED'> {
  return new DecisionCenterError(
    'DECISION_CURSOR_MALFORMED',
    'Decision cursor is malformed.',
    400,
    { reason },
  );
}

function staleCursor(reason: string): DecisionCenterError<'DECISION_CURSOR_STALE'> {
  return new DecisionCenterError(
    'DECISION_CURSOR_STALE',
    'Decision cursor no longer matches the requested snapshot.',
    409,
    { reason },
  );
}
