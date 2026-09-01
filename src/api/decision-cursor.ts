// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Decision Center keyset cursor pagination (API v2). Pure — no DB/env.
 *
 * Compatibility cursor for pre-snapshot API v2 clients. The sort key is a
 * total order: priorityScore DESC, then createdAt DESC, then decisionId ASC (decisionId is the unique PK, so
 * ties are impossible). We key on item.priorityScore (the field projected onto DecisionCardSummary) — NOT
 * prioritySnapshot.priorityScore — so the client can reason about ordering from the card; do not "fix" this
 * to the snapshot score without also changing the card, or cursor/card ordering will disagree.
 *
 * A malformed or stale cursor is a typed client error. Silently restarting at
 * page one duplicates already-seen decisions and is never safe recovery.
 */

import type { DecisionApiItem } from '../services/decision-center';
import { DECISION_RANKING_VERSION } from '../services/decision-center';
import { decodeDecisionCursorToken } from '../services/decision-center/cursor';
import { DecisionCenterError } from '../services/decision-center/errors';

export interface DecisionCursorKey {
  priorityScore: number;
  createdAt: string;
  decisionId: string;
  rankingVersion: number;
}

type CursorTuple = Pick<DecisionCursorKey, 'priorityScore' | 'createdAt' | 'decisionId'>;

const keyOf = (item: DecisionApiItem): CursorTuple => ({
  priorityScore: item.priorityScore,
  createdAt: item.createdAt,
  decisionId: item.decisionId,
});

/** Total order: priorityScore DESC, createdAt DESC, decisionId ASC. Negative => a sorts before b. */
export function compareDecisionCursor(a: CursorTuple, b: CursorTuple): number {
  if (a.priorityScore !== b.priorityScore) return b.priorityScore - a.priorityScore;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1; // newer (greater ISO) first
  return a.decisionId < b.decisionId ? -1 : a.decisionId > b.decisionId ? 1 : 0;
}

/** Stable keyset sort (copy; never mutates the input). */
export function sortDecisionsForKeyset(items: DecisionApiItem[]): DecisionApiItem[] {
  return items.slice().sort((a, b) => compareDecisionCursor(keyOf(a), keyOf(b)));
}

/** Opaque base64url cursor pointing AT an item (the page's last). */
export function encodeDecisionCursor(item: DecisionApiItem): string {
  const payload = { ps: item.priorityScore, ca: item.createdAt, id: item.decisionId, rv: DECISION_RANKING_VERSION };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** Decode an opaque legacy or snapshot tuple without silent fallback. */
export function decodeDecisionCursor(raw: string): DecisionCursorKey {
  const decoded = decodeDecisionCursorToken(raw);
  return decoded.kind === 'legacy'
    ? {
        priorityScore: decoded.priorityScore,
        createdAt: decoded.createdAt,
        decisionId: decoded.decisionId,
        rankingVersion: decoded.rankingVersion,
      }
    : {
        priorityScore: decoded.rank.priorityScore,
        createdAt: decoded.rank.createdAt,
        decisionId: decoded.rank.decisionId,
        rankingVersion: decoded.rankingVersion,
      };
}

/**
 * Page a keyset-sorted list. Strictly-after semantics: with a cursor, drop every item <= the cursor tuple.
 * A ranking-version mismatch returns a typed conflict. nextCursor is omitted (null) when there
 * is no further page. pageSize is clamped to [1, 100].
 */
export function paginateDecisions(
  sorted: DecisionApiItem[],
  cursor: DecisionCursorKey | null,
  pageSize: number,
): { page: DecisionApiItem[]; nextCursor: string | null } {
  const size = Math.max(1, Math.min(Math.floor(pageSize) || 1, 100));
  if (cursor && cursor.rankingVersion !== DECISION_RANKING_VERSION) {
    throw new DecisionCenterError(
      'DECISION_CURSOR_STALE',
      'Decision cursor ranking policy is stale.',
      409,
      { reason: 'ranking_version' },
    );
  }
  const effectiveCursor = cursor;
  let start = 0;
  if (effectiveCursor) {
    const idx = sorted.findIndex((item) => compareDecisionCursor(keyOf(item), effectiveCursor) > 0);
    start = idx < 0 ? sorted.length : idx;
  }
  const page = sorted.slice(start, start + size);
  const hasMore = start + size < sorted.length;
  const nextCursor = page.length === size && hasMore ? encodeDecisionCursor(page[page.length - 1]) : null;
  return { page, nextCursor };
}
