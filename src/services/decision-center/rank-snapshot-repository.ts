// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { DecisionScope } from './contracts';
import type { DecisionCursorBinding, DecisionRankTuple } from './cursor';
import { DecisionCenterError } from './errors';

export const DECISION_RANK_SNAPSHOT_REPOSITORY_VERSION = 'decision_rank_snapshot_repository@1.1.0' as const;

const SNAPSHOT_TABLE = 'decision_center_rank_snapshots';
const ENTRY_TABLE = 'decision_center_rank_snapshot_entries';
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const MAX_PAGE_SIZE = 200;
const MAX_SNAPSHOT_ENTRIES = 50_000;

export interface DecisionRankSnapshot {
  readonly repositoryVersion: typeof DECISION_RANK_SNAPSHOT_REPOSITORY_VERSION;
  readonly binding: DecisionCursorBinding;
  readonly scope: DecisionScope;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly totalCount: number;
}

export interface CreateDecisionRankSnapshotInput {
  readonly scope: DecisionScope;
  readonly rankingAsOf: string;
  readonly rankingVersion: number;
  readonly filterFingerprint: string;
  readonly expiresAt: string;
  /** The caller supplies the already-ranked order; the repository freezes it as ordinals. */
  readonly ranks: readonly DecisionRankTuple[];
  /** Optional privacy-safe card projection parallel to `ranks`. */
  readonly projections?: readonly (Readonly<Record<string, unknown>> | null)[];
}

export interface ReadDecisionRankSnapshotPageInput {
  readonly scope: DecisionScope;
  readonly binding: DecisionCursorBinding;
  readonly after?: DecisionRankTuple | null;
  readonly limit: number;
}

export interface DecisionRankSnapshotPage {
  readonly snapshot: DecisionRankSnapshot;
  readonly ranks: readonly DecisionRankTuple[];
  readonly hasMore: boolean;
  /** Rank tuple to encode in the next cursor, or null when this is the final page. */
  readonly nextCursorRank: DecisionRankTuple | null;
}

export interface DecisionRankSnapshotProjectionEntry {
  readonly rank: DecisionRankTuple;
  readonly projection: Readonly<Record<string, unknown>>;
}

export interface ReadDecisionRankSnapshotProjectionEntriesInput {
  readonly scope: DecisionScope;
  readonly binding: DecisionCursorBinding;
  readonly after?: DecisionRankTuple | null;
}

export interface DecisionRankSnapshotProjectionEntries {
  readonly snapshot: DecisionRankSnapshot;
  readonly entries: readonly DecisionRankSnapshotProjectionEntry[];
}

export interface DecisionRankSnapshotRepositoryOptions {
  readonly now?: () => Date;
  readonly createSnapshotId?: () => string;
}

interface SnapshotRow {
  snapshot_id: string;
  user_id: number;
  tenant_id: number;
  ranking_as_of: string;
  ranking_version: number;
  filter_fingerprint: string;
  created_at: string;
  expires_at: string;
  entry_count: number;
}

interface EntryRow {
  ordinal: number;
  decision_id: string;
  priority_tier: DecisionRankTuple['priorityTier'];
  priority_score: number;
  decision_created_at: string;
  projection_json?: string | null;
}

/**
 * Persistence boundary for immutable ranked decision pages.
 *
 * Schema ownership deliberately lives in migrations. This repository never
 * executes DDL and therefore cannot mutate schema from a request path.
 */
export class DecisionRankSnapshotRepository {
  private readonly now: () => Date;
  private readonly createSnapshotId: () => string;

  constructor(
    private readonly db: Database.Database,
    options: DecisionRankSnapshotRepositoryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createSnapshotId = options.createSnapshotId ?? (() => `dcrs_${randomUUID()}`);
  }

  createSnapshot(input: CreateDecisionRankSnapshotInput): DecisionRankSnapshot {
    assertScope(input.scope);
    const createdAt = asClockInstant(this.now(), 'clock');
    const rankingAsOf = asIsoInstant(input.rankingAsOf, 'rankingAsOf');
    const expiresAt = asIsoInstant(input.expiresAt, 'expiresAt');
    const rankingVersion = asPositiveInteger(input.rankingVersion, 'rankingVersion');
    const filterFingerprint = asFilterFingerprint(input.filterFingerprint);
    const ranks = validateRanks(input.ranks);
    const projections = validateProjections(input.projections, ranks.length);

    if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
      throw invalidSnapshot('expiresAt', 'Snapshot expiration must be later than its creation time.');
    }

    const snapshotId = asIdentifier(this.createSnapshotId(), 'snapshotId', 200);
    const write = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO ${SNAPSHOT_TABLE} (
          snapshot_id, user_id, tenant_id, ranking_as_of, ranking_version,
          filter_fingerprint, created_at, expires_at, entry_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        snapshotId,
        input.scope.userId,
        input.scope.tenantId,
        rankingAsOf,
        rankingVersion,
        filterFingerprint,
        createdAt,
        expiresAt,
        ranks.length,
      );

      const insertEntry = this.db.prepare(`
        INSERT INTO ${ENTRY_TABLE} (
          snapshot_id, user_id, tenant_id, ordinal, decision_id,
          priority_tier, priority_score, decision_created_at, projection_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const [ordinal, rank] of ranks.entries()) {
        insertEntry.run(
          snapshotId,
          input.scope.userId,
          input.scope.tenantId,
          ordinal,
          rank.decisionId,
          rank.priorityTier,
          rank.priorityScore,
          rank.createdAt,
          projections[ordinal] == null ? null : JSON.stringify(projections[ordinal]),
        );
      }
    });
    write();

    return freezeSnapshot({
      repositoryVersion: DECISION_RANK_SNAPSHOT_REPOSITORY_VERSION,
      binding: {
        snapshotId,
        rankingAsOf,
        rankingVersion,
        filterFingerprint,
      },
      scope: input.scope,
      createdAt,
      expiresAt,
      totalCount: ranks.length,
    });
  }

  readPage(input: ReadDecisionRankSnapshotPageInput): DecisionRankSnapshotPage {
    assertScope(input.scope);
    assertPageLimit(input.limit);
    assertBinding(input.binding);

    const row = this.requireSnapshotRow(input.scope, input.binding);

    const afterOrdinal = input.after ? this.resolveAfterOrdinal(row, input.scope, input.after) : -1;
    const rows = this.db.prepare(`
      SELECT ordinal, decision_id, priority_tier, priority_score, decision_created_at
        FROM ${ENTRY_TABLE}
       WHERE snapshot_id = ?
         AND user_id = ?
         AND tenant_id = ?
         AND ordinal > ?
       ORDER BY ordinal ASC
       LIMIT ?
    `).all(
      row.snapshot_id,
      input.scope.userId,
      input.scope.tenantId,
      afterOrdinal,
      input.limit + 1,
    ) as EntryRow[];

    const hasMore = rows.length > input.limit;
    const ranks = rows.slice(0, input.limit).map(entryRowToRank);
    const snapshot = snapshotFromRow(row);
    return Object.freeze({
      snapshot,
      ranks: Object.freeze(ranks),
      hasMore,
      nextCursorRank: hasMore && ranks.length > 0 ? ranks[ranks.length - 1] : null,
    });
  }

  /** Latest unexpired immutable universe for a scope. No rows are created here. */
  findLatestSnapshot(input: {
    readonly scope: DecisionScope;
    readonly rankingVersion: number;
    readonly filterFingerprint: string;
  }): DecisionRankSnapshot | null {
    assertScope(input.scope);
    const rankingVersion = asPositiveInteger(input.rankingVersion, 'rankingVersion');
    const filterFingerprint = asFilterFingerprint(input.filterFingerprint);
    const row = this.db.prepare(`
      SELECT snapshot_id, user_id, tenant_id, ranking_as_of, ranking_version,
             filter_fingerprint, created_at, expires_at, entry_count
        FROM ${SNAPSHOT_TABLE}
       WHERE user_id = ? AND tenant_id = ?
         AND ranking_version = ? AND filter_fingerprint = ?
         AND datetime(expires_at) > datetime(?)
       ORDER BY ranking_as_of DESC, created_at DESC, rowid DESC
       LIMIT 1
    `).get(
      input.scope.userId,
      input.scope.tenantId,
      rankingVersion,
      filterFingerprint,
      asClockInstant(this.now(), 'clock'),
    ) as SnapshotRow | undefined;
    return row ? snapshotFromRow(row) : null;
  }

  /** Read one exact snapshot metadata row with strict scope and expiry checks. */
  readSnapshot(scope: DecisionScope, snapshotId: string): DecisionRankSnapshot {
    assertScope(scope);
    const id = asIdentifier(snapshotId, 'snapshotId', 200);
    const row = this.readSnapshotRow(id);
    if (!row) throw staleSnapshot('snapshot_missing');
    this.assertSnapshotScopeAndExpiry(row, scope);
    return snapshotFromRow(row);
  }

  /**
   * Read immutable privacy-safe cards in frozen ordinal order. This is used by
   * the v2 list route so pagination never recomputes cards or writes on GET.
   */
  readProjectionEntries(
    input: ReadDecisionRankSnapshotProjectionEntriesInput,
  ): DecisionRankSnapshotProjectionEntries {
    assertScope(input.scope);
    assertBinding(input.binding);
    const snapshotRow = this.requireSnapshotRow(input.scope, input.binding);
    const afterOrdinal = input.after ? this.resolveAfterOrdinal(snapshotRow, input.scope, input.after) : -1;
    const rows = this.db.prepare(`
      SELECT ordinal, decision_id, priority_tier, priority_score,
             decision_created_at, projection_json
        FROM ${ENTRY_TABLE}
       WHERE snapshot_id = ? AND user_id = ? AND tenant_id = ? AND ordinal > ?
       ORDER BY ordinal ASC
       LIMIT ?
    `).all(
      snapshotRow.snapshot_id,
      input.scope.userId,
      input.scope.tenantId,
      afterOrdinal,
      MAX_SNAPSHOT_ENTRIES,
    ) as EntryRow[];
    const entries = rows.map((row) => Object.freeze({
      rank: entryRowToRank(row),
      projection: parseProjection(row),
    }));
    return Object.freeze({
      snapshot: snapshotFromRow(snapshotRow),
      entries: Object.freeze(entries),
    });
  }

  private requireSnapshotRow(scope: DecisionScope, binding: DecisionCursorBinding): SnapshotRow {
    const row = this.readSnapshotRow(binding.snapshotId);
    if (!row) throw staleSnapshot('snapshot_missing');
    this.assertSnapshotScopeAndExpiry(row, scope);
    if (row.ranking_version !== binding.rankingVersion) throw staleSnapshot('ranking_version');
    if (row.ranking_as_of !== binding.rankingAsOf) throw staleSnapshot('ranking_as_of');
    if (row.filter_fingerprint !== binding.filterFingerprint) throw staleSnapshot('filters');
    return row;
  }

  private readSnapshotRow(snapshotId: string): SnapshotRow | undefined {
    return this.db.prepare(`
      SELECT snapshot_id, user_id, tenant_id, ranking_as_of, ranking_version,
             filter_fingerprint, created_at, expires_at, entry_count
        FROM ${SNAPSHOT_TABLE}
       WHERE snapshot_id = ?
       LIMIT 1
    `).get(snapshotId) as SnapshotRow | undefined;
  }

  private assertSnapshotScopeAndExpiry(row: SnapshotRow, scope: DecisionScope): void {
    if (row.user_id !== scope.userId || row.tenant_id !== scope.tenantId) {
      throw new DecisionCenterError(
        'DECISION_SCOPE_INVALID',
        'Decision snapshot does not belong to the requested scope.',
        403,
        { reason: 'snapshot_scope' },
      );
    }
    if (Date.parse(row.expires_at) <= this.now().getTime()) throw staleSnapshot('snapshot_expired');
  }

  private resolveAfterOrdinal(
    snapshot: SnapshotRow,
    scope: DecisionScope,
    after: DecisionRankTuple,
  ): number {
    const validated = validateRank(after, 'after');
    const row = this.db.prepare(`
      SELECT ordinal, decision_id, priority_tier, priority_score, decision_created_at
        FROM ${ENTRY_TABLE}
       WHERE snapshot_id = ?
         AND user_id = ?
         AND tenant_id = ?
         AND decision_id = ?
    `).get(snapshot.snapshot_id, scope.userId, scope.tenantId, validated.decisionId) as EntryRow | undefined;

    if (!row || !sameRankTuple(entryRowToRank(row), validated)) throw staleSnapshot('rank_tuple');
    return row.ordinal;
  }
}

function snapshotFromRow(row: SnapshotRow): DecisionRankSnapshot {
  return freezeSnapshot({
    repositoryVersion: DECISION_RANK_SNAPSHOT_REPOSITORY_VERSION,
    binding: {
      snapshotId: row.snapshot_id,
      rankingAsOf: row.ranking_as_of,
      rankingVersion: row.ranking_version,
      filterFingerprint: row.filter_fingerprint,
    },
    scope: { userId: row.user_id, tenantId: row.tenant_id },
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    totalCount: row.entry_count,
  });
}

function freezeSnapshot(snapshot: DecisionRankSnapshot): DecisionRankSnapshot {
  return Object.freeze({
    ...snapshot,
    binding: Object.freeze({ ...snapshot.binding }),
    scope: Object.freeze({ ...snapshot.scope }),
  });
}

function entryRowToRank(row: EntryRow): DecisionRankTuple {
  return Object.freeze({
    priorityTier: row.priority_tier,
    priorityScore: row.priority_score,
    createdAt: row.decision_created_at,
    decisionId: row.decision_id,
  });
}

function parseProjection(row: EntryRow): Readonly<Record<string, unknown>> {
  if (typeof row.projection_json !== 'string' || row.projection_json.length === 0) {
    throw staleSnapshot('projection_missing');
  }
  try {
    const parsed = JSON.parse(row.projection_json) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('projection shape');
    return Object.freeze({ ...(parsed as Record<string, unknown>) });
  } catch {
    throw staleSnapshot('projection_invalid');
  }
}

function validateRanks(input: readonly DecisionRankTuple[]): readonly DecisionRankTuple[] {
  if (!Array.isArray(input) || input.length > MAX_SNAPSHOT_ENTRIES) {
    throw invalidSnapshot('ranks', `Snapshot ranks must contain at most ${MAX_SNAPSHOT_ENTRIES} entries.`);
  }
  const decisionIds = new Set<string>();
  const ranks = input.map((rank, index) => {
    const validated = validateRank(rank, `ranks[${index}]`);
    if (decisionIds.has(validated.decisionId)) {
      throw invalidSnapshot('ranks', 'Snapshot ranks must contain unique decision identifiers.');
    }
    decisionIds.add(validated.decisionId);
    return validated;
  });
  return Object.freeze(ranks);
}

function validateProjections(
  input: readonly (Readonly<Record<string, unknown>> | null)[] | undefined,
  expectedLength: number,
): readonly (Readonly<Record<string, unknown>> | null)[] {
  if (input === undefined) return Object.freeze(Array.from({ length: expectedLength }, () => null));
  if (!Array.isArray(input) || input.length !== expectedLength) {
    throw invalidSnapshot('projections', 'Snapshot projections must be parallel to rank tuples.');
  }
  return Object.freeze(input.map((projection, index) => {
    if (projection === null) return null;
    if (!projection || typeof projection !== 'object' || Array.isArray(projection)) {
      throw invalidSnapshot(`projections[${index}]`, 'Snapshot projection must be an object or null.');
    }
    return Object.freeze({ ...projection });
  }));
}

function validateRank(rank: DecisionRankTuple, field: string): DecisionRankTuple {
  if (!rank || typeof rank !== 'object') throw invalidSnapshot(field, 'Rank tuple is required.');
  if (rank.priorityTier !== 'critical' && rank.priorityTier !== 'high'
    && rank.priorityTier !== 'normal' && rank.priorityTier !== 'low') {
    throw invalidSnapshot(`${field}.priorityTier`, 'Rank priority tier is invalid.');
  }
  if (typeof rank.priorityScore !== 'number' || !Number.isFinite(rank.priorityScore)) {
    throw invalidSnapshot(`${field}.priorityScore`, 'Rank priority score must be finite.');
  }
  return Object.freeze({
    priorityTier: rank.priorityTier,
    priorityScore: rank.priorityScore,
    createdAt: asIsoInstant(rank.createdAt, `${field}.createdAt`),
    decisionId: asIdentifier(rank.decisionId, `${field}.decisionId`, 255),
  });
}

function sameRankTuple(left: DecisionRankTuple, right: DecisionRankTuple): boolean {
  return left.priorityTier === right.priorityTier
    && left.priorityScore === right.priorityScore
    && left.createdAt === right.createdAt
    && left.decisionId === right.decisionId;
}

function assertScope(scope: DecisionScope): void {
  if (!scope || !Number.isSafeInteger(scope.userId) || scope.userId < 1
    || !Number.isSafeInteger(scope.tenantId) || scope.tenantId < 1) {
    throw new DecisionCenterError(
      'DECISION_SCOPE_INVALID',
      'Decision snapshots require positive integer user and tenant identifiers.',
      400,
    );
  }
}

function assertBinding(binding: DecisionCursorBinding): void {
  asIdentifier(binding.snapshotId, 'binding.snapshotId', 200);
  asIsoInstant(binding.rankingAsOf, 'binding.rankingAsOf');
  asPositiveInteger(binding.rankingVersion, 'binding.rankingVersion');
  asFilterFingerprint(binding.filterFingerprint);
}

function assertPageLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw invalidSnapshot('limit', `Page limit must be an integer from 1 through ${MAX_PAGE_SIZE}.`);
  }
}

function asClockInstant(value: Date, field: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw invalidSnapshot(field, 'Snapshot clock returned an invalid instant.');
  }
  return value.toISOString();
}

function asIsoInstant(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    throw invalidSnapshot(field, `${field} must be a valid ISO-8601 timestamp.`);
  }
  return value;
}

function asPositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalidSnapshot(field, `${field} must be a positive integer.`);
  }
  return value;
}

function asFilterFingerprint(value: string): string {
  if (typeof value !== 'string' || !FINGERPRINT_PATTERN.test(value)) {
    throw invalidSnapshot('filterFingerprint', 'Filter fingerprint must be a SHA-256 hex digest.');
  }
  return value;
}

function asIdentifier(value: string, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw invalidSnapshot(field, `${field} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value;
}

function invalidSnapshot(field: string, message: string): DecisionCenterError<'DECISION_MUTATION_INVALID'> {
  return new DecisionCenterError('DECISION_MUTATION_INVALID', message, 400, { field });
}

function staleSnapshot(reason: string): DecisionCenterError<'DECISION_CURSOR_STALE'> {
  return new DecisionCenterError(
    'DECISION_CURSOR_STALE',
    'Decision snapshot is no longer available for this cursor.',
    409,
    { reason },
  );
}
