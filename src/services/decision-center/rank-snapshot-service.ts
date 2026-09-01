// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';
import type { DecisionApiItem, DecisionCardSummary, DecisionUrgency } from './types';
import { getDb } from '../database';
import { buildDecisionCardSummary, type DecisionCardSummaryV2Extras } from './card-projection';
import type { DecisionScope } from './contracts';
import {
  assertDecisionCursorBinding,
  decisionFilterFingerprint,
  decodeDecisionCursorToken,
  encodeDecisionSnapshotCursor,
  type DecisionLegacyCursor,
  type DecisionRankTuple,
} from './cursor';
import {
  DecisionRankSnapshotRepository,
  type DecisionRankSnapshot,
} from './rank-snapshot-repository';
import { DecisionCenterError } from './errors';

export const DECISION_RANK_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1_000;
export const DECISION_RANK_SNAPSHOT_UNIVERSE_FINGERPRINT = decisionFilterFingerprint({
  projection: 'decision-card.v2',
  scope: 'all-visible-statuses',
});

export interface DecisionSnapshotListFilters {
  readonly status?: string;
  readonly sourceSkill?: string;
  readonly type?: string;
  readonly urgency?: DecisionUrgency;
}

export type DecisionSnapshotCard = DecisionCardSummary & DecisionCardSummaryV2Extras;

export interface MaterializeDecisionRankSnapshotInput {
  readonly db: Database.Database;
  readonly scope: DecisionScope;
  readonly items: readonly DecisionApiItem[];
  readonly rankingVersion: number;
  readonly now?: Date;
  readonly ttlMs?: number;
}

export interface DecisionSnapshotPage {
  readonly kind: 'snapshot';
  readonly snapshotId: string;
  readonly rankingAsOf: string;
  readonly rankingVersion: number;
  readonly cards: readonly DecisionSnapshotCard[];
  readonly nextCursor: string | null;
}

export type DecisionSnapshotPageResolution =
  | DecisionSnapshotPage
  | { readonly kind: 'legacy'; readonly cursor: DecisionLegacyCursor }
  | { readonly kind: 'unavailable' };

/** Freeze one immutable, privacy-safe list universe. Safe to call in a surrounding transaction. */
export function materializeDecisionRankSnapshot(
  input: MaterializeDecisionRankSnapshotInput,
): DecisionRankSnapshot {
  const now = validDate(input.now ?? new Date(), 'now');
  const ttlMs = input.ttlMs ?? DECISION_RANK_SNAPSHOT_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 7 * 24 * 60 * 60 * 1_000) {
    throw new Error('Decision rank snapshot ttl must be between one minute and seven days.');
  }
  const ordered = input.items.slice().sort(compareSnapshotItems);
  const ranks = ordered.map(rankForItem);
  const projections = ordered.map((item) => buildDecisionCardSummary(item) as unknown as Readonly<Record<string, unknown>>);
  return new DecisionRankSnapshotRepository(input.db, { now: () => new Date(now) }).createSnapshot({
    scope: input.scope,
    rankingAsOf: now.toISOString(),
    rankingVersion: input.rankingVersion,
    filterFingerprint: DECISION_RANK_SNAPSHOT_UNIVERSE_FINGERPRINT,
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    ranks,
    projections,
  });
}

/**
 * Resolve an immutable v2 page. This path is strictly read-only: absent
 * snapshots return `unavailable` so callers can use the valid legacy cursor
 * compatibility path without manufacturing state from a GET.
 */
export function readDecisionRankSnapshotPage(input: {
  readonly db: Database.Database;
  readonly scope: DecisionScope;
  readonly rankingVersion: number;
  readonly filters: DecisionSnapshotListFilters;
  readonly cursorRaw?: string;
  readonly pageSize: number;
  readonly now?: Date;
}): DecisionSnapshotPageResolution {
  const now = validDate(input.now ?? new Date(), 'now');
  if (!Number.isSafeInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 100) {
    throw new DecisionCenterError(
      'DECISION_CURSOR_MALFORMED',
      'Decision page size must be an integer from 1 through 100.',
      400,
      { reason: 'page_size' },
    );
  }
  const repository = new DecisionRankSnapshotRepository(input.db, { now: () => new Date(now) });
  const filterFingerprint = decisionFilterFingerprint(normalizedFilters(input.filters));
  const decoded = input.cursorRaw === undefined ? null : decodeDecisionCursorToken(input.cursorRaw);
  if (decoded?.kind === 'legacy') return Object.freeze({ kind: 'legacy', cursor: decoded });

  let snapshot: DecisionRankSnapshot | null;
  try {
    snapshot = decoded
      ? repository.readSnapshot(input.scope, decoded.snapshotId)
      : repository.findLatestSnapshot({
          scope: input.scope,
          rankingVersion: input.rankingVersion,
          filterFingerprint: DECISION_RANK_SNAPSHOT_UNIVERSE_FINGERPRINT,
        });
  } catch (error) {
    if (decoded && error instanceof DecisionCenterError
        && error.code === 'DECISION_CURSOR_STALE'
        && ['snapshot_missing', 'snapshot_expired'].includes(String(error.details?.reason ?? ''))) {
      throw new DecisionCenterError(
        'DECISION_CURSOR_STALE',
        'Decision cursor snapshot is missing or expired.',
        409,
        { reason: 'snapshot_missing_or_expired' },
      );
    }
    throw error;
  }
  if (!snapshot) {
    if (decoded) {
      throw new DecisionCenterError(
        'DECISION_CURSOR_STALE',
        'Decision cursor snapshot is missing or expired.',
        409,
        { reason: 'snapshot_missing_or_expired' },
      );
    }
    return Object.freeze({ kind: 'unavailable' });
  }
  if (snapshot.binding.rankingVersion !== input.rankingVersion) {
    throw new DecisionCenterError(
      'DECISION_CURSOR_STALE',
      'Decision cursor ranking policy is stale.',
      409,
      { reason: 'ranking_version' },
    );
  }
  if (snapshot.binding.filterFingerprint !== DECISION_RANK_SNAPSHOT_UNIVERSE_FINGERPRINT) {
    throw new DecisionCenterError(
      'DECISION_CURSOR_STALE',
      'Decision snapshot no longer matches the list projection.',
      409,
      { reason: 'snapshot_projection' },
    );
  }

  const requestBinding = {
    snapshotId: snapshot.binding.snapshotId,
    rankingAsOf: snapshot.binding.rankingAsOf,
    rankingVersion: snapshot.binding.rankingVersion,
    filterFingerprint,
  };
  if (decoded) assertDecisionCursorBinding(decoded, requestBinding);
  const frozen = repository.readProjectionEntries({
    scope: input.scope,
    binding: snapshot.binding,
    after: decoded?.rank ?? null,
  });
  const matching = frozen.entries.filter((entry) => cardMatchesFilters(entry.projection, input.filters));
  const pageEntries = matching.slice(0, input.pageSize);
  const hasMore = matching.length > input.pageSize;
  const nextRank = hasMore && pageEntries.length > 0 ? pageEntries[pageEntries.length - 1].rank : null;
  const cards = pageEntries.map((entry) => validatedSnapshotCard(entry.projection, entry.rank));
  return Object.freeze({
    kind: 'snapshot',
    snapshotId: snapshot.binding.snapshotId,
    rankingAsOf: snapshot.binding.rankingAsOf,
    rankingVersion: snapshot.binding.rankingVersion,
    cards: Object.freeze(cards),
    nextCursor: nextRank ? encodeDecisionSnapshotCursor({ ...requestBinding, rank: nextRank }) : null,
  });
}

export function readDecisionRankSnapshotPageFromCurrentDatabase(
  input: Omit<Parameters<typeof readDecisionRankSnapshotPage>[0], 'db'>,
): DecisionSnapshotPageResolution {
  return readDecisionRankSnapshotPage({ ...input, db: getDb() });
}

function normalizedFilters(filters: DecisionSnapshotListFilters): Readonly<Record<string, unknown>> {
  return Object.freeze({
    status: filters.status ?? null,
    sourceSkill: filters.sourceSkill ?? null,
    type: filters.type ?? null,
    urgency: filters.urgency ?? null,
  });
}

function cardMatchesFilters(
  projection: Readonly<Record<string, unknown>>,
  filters: DecisionSnapshotListFilters,
): boolean {
  const status = typeof projection.status === 'string' ? projection.status : '';
  if (filters.status && filters.status !== 'all' && status !== filters.status) return false;
  if (!filters.status && !['unread', 'read', 'failed', 'snoozed'].includes(status)) return false;
  if (filters.sourceSkill && projection.sourceSkill !== filters.sourceSkill) return false;
  if (filters.type && projection.type !== filters.type) return false;
  if (filters.urgency && projection.urgency !== filters.urgency) return false;
  return true;
}

function validatedSnapshotCard(
  projection: Readonly<Record<string, unknown>>,
  rank: DecisionRankTuple,
): DecisionSnapshotCard {
  if (projection.schemaVersion !== 'decision-center.v2'
      || projection.decisionId !== rank.decisionId
      || typeof projection.sourceSkill !== 'string'
      || typeof projection.type !== 'string'
      || typeof projection.status !== 'string'
      || typeof projection.safePreviewTitle !== 'string'
      || typeof projection.safePreviewBody !== 'string') {
    throw new DecisionCenterError(
      'DECISION_CURSOR_STALE',
      'Decision snapshot card projection is invalid.',
      409,
      { reason: 'projection_invalid' },
    );
  }
  return Object.freeze({ ...projection }) as unknown as DecisionSnapshotCard;
}

function rankForItem(item: DecisionApiItem): DecisionRankTuple {
  return Object.freeze({
    priorityTier: item.prioritySnapshot?.priorityTier ?? tierForScore(item.priorityScore),
    priorityScore: item.priorityScore,
    createdAt: item.createdAt,
    decisionId: item.decisionId,
  });
}

function tierForScore(score: number): DecisionRankTuple['priorityTier'] {
  return score >= 80 ? 'critical' : score >= 60 ? 'high' : score >= 35 ? 'normal' : 'low';
}

function compareSnapshotItems(left: DecisionApiItem, right: DecisionApiItem): number {
  if (left.priorityScore !== right.priorityScore) return right.priorityScore - left.priorityScore;
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1;
  return left.decisionId < right.decisionId ? -1 : left.decisionId > right.decisionId ? 1 : 0;
}

function validDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error(`Decision rank snapshot ${field} is invalid.`);
  return value;
}
