// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Unit tests for skill-inference.ts (OI-USR-405b, 2026-04-24).
 *
 * Focuses on the PURE SCORING core — jaccard + scoreSkillCandidates.
 * The DB-backed wrapper (suggestTagsForRef) is exercised in
 * the route tests (portal-workspace-suggest-tags-routes.test.ts).
 */

import { describe, expect, it } from 'vitest';
import {
  jaccard,
  extractSkillIds,
  extractNonSkillTags,
  scoreSkillCandidates,
  COLD_START_REF_THRESHOLD,
  MAX_SUGGESTIONS,
  MAX_SUPPORTING_REFS,
  type TaggedRefForScoring,
} from '../../src/services/skill-inference';

describe('jaccard', () => {
  it('returns 0 when either side is empty', () => {
    expect(jaccard([], [])).toBe(0);
    expect(jaccard([], ['a'])).toBe(0);
    expect(jaccard(['a'], [])).toBe(0);
  });

  it('full overlap returns 1', () => {
    expect(jaccard(['a', 'b'], ['a', 'b'])).toBe(1);
    expect(jaccard(['a'], ['a'])).toBe(1);
  });

  it('partial overlap returns inter/union', () => {
    // ['a','b','c'] ∩ ['b','c','d'] = {b,c} (2). Union = {a,b,c,d} (4). 2/4 = 0.5.
    expect(jaccard(['a', 'b', 'c'], ['b', 'c', 'd'])).toBe(0.5);
    // ['a','b'] ∩ ['b','c'] = {b} (1). Union = {a,b,c} (3). 1/3 ≈ 0.333.
    expect(jaccard(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3, 5);
  });

  it('no overlap returns 0', () => {
    expect(jaccard(['a', 'b'], ['c', 'd'])).toBe(0);
  });

  it('deduplicates inputs — sets not bags', () => {
    // ['a','a','a'] is really just {a}. Same for ['a','a'].
    expect(jaccard(['a', 'a', 'a'], ['a'])).toBe(1);
    expect(jaccard(['a', 'a', 'b'], ['a', 'b', 'b'])).toBe(1);
  });
});

describe('extractSkillIds + extractNonSkillTags', () => {
  it('extractSkillIds pulls skill:<X> entries and strips the prefix', () => {
    expect(extractSkillIds(['skill:training', 'fiction', 'skill:content'])).toEqual([
      'training',
      'content',
    ]);
  });

  it('extractSkillIds survives non-string entries safely', () => {
    const mixed = ['skill:content', 42, null, undefined, 'skill:finance'] as unknown as string[];
    expect(extractSkillIds(mixed)).toEqual(['content', 'finance']);
  });

  it('extractNonSkillTags preserves user vocabulary + drops empty strings', () => {
    expect(extractNonSkillTags(['skill:training', 'fiction', '', 'habit', 'skill:content'])).toEqual([
      'fiction',
      'habit',
    ]);
  });
});

describe('scoreSkillCandidates — base cases', () => {
  it('returns empty when target has no non-skill tags (nothing to compare)', () => {
    const refs: TaggedRefForScoring[] = [
      { kind: 'book', id: 1, tags: ['skill:content', 'reading'] },
    ];
    expect(scoreSkillCandidates([], refs)).toEqual([]);
  });

  it('returns empty when there are no tagged refs at all', () => {
    expect(scoreSkillCandidates(['fiction'], [])).toEqual([]);
  });

  it('ignores refs that carry NO skill tag — they contribute no signal', () => {
    const refs: TaggedRefForScoring[] = [
      { kind: 'book', id: 1, tags: ['fiction', 'reading'] }, // no skill -> ignored
      { kind: 'book', id: 2, tags: ['fiction'] },            // no skill -> ignored
    ];
    expect(scoreSkillCandidates(['fiction'], refs)).toEqual([]);
  });

  it('returns empty when no ref has any tag overlap with target', () => {
    const refs: TaggedRefForScoring[] = [
      { kind: 'book', id: 1, tags: ['skill:content', 'apple', 'orange'] },
      { kind: 'link', id: 2, tags: ['skill:training', 'gym'] },
    ];
    expect(scoreSkillCandidates(['xyz', 'abc'], refs)).toEqual([]);
  });
});

describe('scoreSkillCandidates — ranking + supporters', () => {
  it('suggests the skill whose tagged refs share most tags with target', () => {
    const refs: TaggedRefForScoring[] = [
      { kind: 'book', id: 10, tags: ['skill:content', 'fiction', 'narrative'] },
      { kind: 'book', id: 11, tags: ['skill:training', 'gym', 'strength'] },
    ];
    const result = scoreSkillCandidates(['fiction', 'narrative'], refs);
    expect(result.length).toBe(1);
    expect(result[0].skillId).toBe('content');
    // ['fiction','narrative'] ∩ ['fiction','narrative'] = 2. Union = 2. 2/2 = 1.
    expect(result[0].confidence).toBe(1);
    expect(result[0].supportingRefs).toEqual([{ kind: 'book', id: 10 }]);
  });

  it('ranks multiple skills by confidence DESC', () => {
    const refs: TaggedRefForScoring[] = [
      // 'content' side: exact match with target -> Jaccard = 1
      { kind: 'book', id: 1, tags: ['skill:content', 'fiction'] },
      // 'training' side: partial overlap -> Jaccard = 1/3 (one shared, three total)
      { kind: 'book', id: 2, tags: ['skill:training', 'fiction', 'gym'] },
    ];
    const result = scoreSkillCandidates(['fiction'], refs);
    expect(result.map((s) => s.skillId)).toEqual(['content', 'training']);
    expect(result[0].confidence).toBe(1);
    expect(result[1].confidence).toBeCloseTo(1 / 2, 5); // ['fiction'] ∩ ['fiction','gym'] = 1; union = 2
  });

  it('uses MAX (not mean) across refs carrying the same skill', () => {
    const refs: TaggedRefForScoring[] = [
      // 10 low-overlap refs (Jaccard = 0.2 each) would drag MEAN down
      ...Array.from({ length: 10 }, (_, i) => ({
        kind: 'book' as const,
        id: 100 + i,
        tags: ['skill:training', 'gym', 'unrelated-' + i],
      })),
      // One perfect match (Jaccard = 1)
      { kind: 'book', id: 200, tags: ['skill:training', 'deadlift'] },
    ];
    const result = scoreSkillCandidates(['deadlift'], refs);
    expect(result.length).toBe(1);
    expect(result[0].skillId).toBe('training');
    expect(result[0].confidence).toBe(1); // MAX wins, not mean
  });

  it('supportingRefs are ranked by per-ref score DESC and capped at MAX_SUPPORTING_REFS', () => {
    const refs: TaggedRefForScoring[] = [
      { kind: 'book', id: 1, tags: ['skill:content', 'fiction'] },                    // Jaccard 1
      { kind: 'book', id: 2, tags: ['skill:content', 'fiction', 'plus'] },             // Jaccard 0.5
      { kind: 'book', id: 3, tags: ['skill:content', 'fiction', 'a', 'b'] },           // Jaccard 1/4
      { kind: 'book', id: 4, tags: ['skill:content', 'fiction', 'a', 'b', 'c'] },      // Jaccard 1/5
      { kind: 'book', id: 5, tags: ['skill:content', 'fiction', 'a', 'b', 'c', 'd'] }, // Jaccard 1/6
    ];
    const result = scoreSkillCandidates(['fiction'], refs);
    expect(result[0].supportingRefs.length).toBe(MAX_SUPPORTING_REFS);
    expect(result[0].supportingRefs.map((r) => r.id)).toEqual([1, 2, 3]); // top 3 by score
  });

  it('supportingRefs carry kind to disambiguate global-id collisions', () => {
    const refs: TaggedRefForScoring[] = [
      { kind: 'book', id: 5, tags: ['skill:content', 'fiction'] },
      { kind: 'link', id: 5, tags: ['skill:content', 'fiction'] }, // same id, different kind
    ];
    const result = scoreSkillCandidates(['fiction'], refs);
    expect(result[0].supportingRefs).toEqual(
      expect.arrayContaining([
        { kind: 'book', id: 5 },
        { kind: 'link', id: 5 },
      ]),
    );
  });

  it('caps the result at MAX_SUGGESTIONS', () => {
    // Construct 5 skills with all positive scores (one ref each).
    const refs: TaggedRefForScoring[] = [
      { kind: 'book', id: 1, tags: ['skill:content', 'shared'] },
      { kind: 'book', id: 2, tags: ['skill:secretary', 'shared'] },
      { kind: 'book', id: 3, tags: ['skill:training', 'shared'] },
      { kind: 'book', id: 4, tags: ['skill:finance', 'shared'] },
      { kind: 'book', id: 5, tags: ['skill:cooking', 'shared'] },
    ];
    const result = scoreSkillCandidates(['shared'], refs);
    expect(result.length).toBe(MAX_SUGGESTIONS);
  });
});

describe('scoreSkillCandidates — safety + invariants', () => {
  it('ignores unknown skill ids even when refs carry them', () => {
    const refs: TaggedRefForScoring[] = [
      { kind: 'book', id: 1, tags: ['skill:evil', 'fiction'] },     // 'evil' not in CANDIDATE_SKILL_IDS
      { kind: 'book', id: 2, tags: ['skill:content', 'fiction'] },  // valid
    ];
    const result = scoreSkillCandidates(['fiction'], refs);
    expect(result.map((s) => s.skillId)).toEqual(['content']);
  });

  it('handles refs with multiple skill tags (each skill gets credit)', () => {
    const refs: TaggedRefForScoring[] = [
      { kind: 'book', id: 1, tags: ['skill:content', 'skill:training', 'fiction'] },
    ];
    const result = scoreSkillCandidates(['fiction'], refs);
    expect(result.length).toBe(2);
    expect(result.map((s) => s.skillId).sort()).toEqual(['content', 'training']);
    // Both should have the same confidence since they share the same ref.
    expect(result[0].confidence).toBe(result[1].confidence);
  });

  it('accepts a custom candidateSkillIds list to narrow scoring', () => {
    const refs: TaggedRefForScoring[] = [
      { kind: 'book', id: 1, tags: ['skill:content', 'fiction'] },
      { kind: 'book', id: 2, tags: ['skill:training', 'fiction'] },
    ];
    // Caller wants ONLY 'content' evaluated — training must not appear.
    const result = scoreSkillCandidates(['fiction'], refs, ['content']);
    expect(result.map((s) => s.skillId)).toEqual(['content']);
  });
});

describe('constants', () => {
  it('COLD_START_REF_THRESHOLD is 3 (cold-start until ≥ 4 skill-tagged refs)', () => {
    // The threshold is pinned at 3 — if tuning this, make sure the
    // route tests + UI "cold start" copy still align.
    expect(COLD_START_REF_THRESHOLD).toBe(3);
  });

  it('MAX_SUGGESTIONS is 3 (UI is sized for 3 chips)', () => {
    expect(MAX_SUGGESTIONS).toBe(3);
  });

  it('MAX_SUPPORTING_REFS is 3 (enough to explain "why" without clutter)', () => {
    expect(MAX_SUPPORTING_REFS).toBe(3);
  });
});
