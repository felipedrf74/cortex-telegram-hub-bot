import { describe, expect, it } from 'vitest';
import type { DecisionApiItem } from '../../src/services/decision-center';
import { DECISION_RANKING_VERSION } from '../../src/services/decision-center';
import {
  compareDecisionCursor,
  decodeDecisionCursor,
  encodeDecisionCursor,
  paginateDecisions,
  sortDecisionsForKeyset,
} from '../../src/api/decision-cursor';

const item = (id: string, ps: number, ca: string): DecisionApiItem =>
  ({ decisionId: id, priorityScore: ps, createdAt: ca }) as unknown as DecisionApiItem;
const k = (ps: number, ca: string, id: string) => ({ priorityScore: ps, createdAt: ca, decisionId: id });

describe('decision cursor keyset (API v2 pagination)', () => {
  it('compareDecisionCursor is a total order: score DESC, createdAt DESC, decisionId ASC', () => {
    expect(compareDecisionCursor(k(90, 'x', 'a'), k(80, 'x', 'b'))).toBeLessThan(0); // higher score first
    expect(compareDecisionCursor(k(80, '2026-05-02', 'a'), k(80, '2026-05-01', 'b'))).toBeLessThan(0); // newer first
    expect(compareDecisionCursor(k(80, 'x', 'a'), k(80, 'x', 'b'))).toBeLessThan(0); // id ASC tiebreak
    expect(compareDecisionCursor(k(80, 'x', 'a'), k(80, 'x', 'a'))).toBe(0);
    // antisymmetry
    expect(Math.sign(compareDecisionCursor(k(90, 'x', 'a'), k(80, 'y', 'b'))))
      .toBe(-Math.sign(compareDecisionCursor(k(80, 'y', 'b'), k(90, 'x', 'a'))));
  });

  it('encode/decode round-trips and rejects malformed input with a typed 400', () => {
    const dec = decodeDecisionCursor(encodeDecisionCursor(item('d1', 70, '2026-05-10T00:00:00.000Z')))!;
    expect(dec).toMatchObject({ priorityScore: 70, createdAt: '2026-05-10T00:00:00.000Z', decisionId: 'd1', rankingVersion: DECISION_RANKING_VERSION });
    for (const malformed of [
      '',
      'not-base64-$$$',
      Buffer.from('{"ps":"x"}').toString('base64url'),
      'a'.repeat(600),
      Buffer.from('not json').toString('base64url'),
    ]) {
      expect(() => decodeDecisionCursor(malformed)).toThrow(expect.objectContaining({
        code: 'DECISION_CURSOR_MALFORMED',
        status: 400,
      }));
    }
  });

  it('paginates the whole list with no overlap and no gap', () => {
    const items = Array.from({ length: 25 }, (_, i) => item(`d${i}`, 100 - i, '2026-05-10T00:00:00.000Z'));
    const sorted = sortDecisionsForKeyset(items);
    const seen: string[] = [];
    let cursor: ReturnType<typeof decodeDecisionCursor> | null = null;
    for (let guard = 0; guard < 100; guard += 1) {
      const { page, nextCursor } = paginateDecisions(sorted, cursor, 10);
      seen.push(...page.map((p) => p.decisionId));
      if (!nextCursor) break;
      cursor = decodeDecisionCursor(nextCursor);
    }
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25); // no duplicates
    expect(new Set(seen)).toEqual(new Set(items.map((i) => i.decisionId))); // covers the whole set
  });

  it('rejects a cursor minted under a different ranking version with a typed conflict', () => {
    const sorted = sortDecisionsForKeyset([item('a', 90, 'x'), item('b', 80, 'x')]);
    const stale = { priorityScore: 90, createdAt: 'x', decisionId: 'a', rankingVersion: DECISION_RANKING_VERSION + 99 };
    expect(() => paginateDecisions(sorted, stale, 10)).toThrow(expect.objectContaining({
      code: 'DECISION_CURSOR_STALE',
      status: 409,
    }));
  });

  it('clamps pageSize and handles the empty list', () => {
    expect(paginateDecisions([], null, 10)).toEqual({ page: [], nextCursor: null });
    const items = Array.from({ length: 5 }, (_, i) => item(`d${i}`, 100 - i, 'x'));
    expect(paginateDecisions(sortDecisionsForKeyset(items), null, 0).page).toHaveLength(1); // pageSize clamped to >=1
    expect(paginateDecisions(sortDecisionsForKeyset(items), null, 999).page).toHaveLength(5); // capped to list length
  });
});
