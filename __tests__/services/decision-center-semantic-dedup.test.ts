import { describe, expect, it } from 'vitest';
import {
  buildDecisionDedupKey,
  classifyDecisionDedup,
  type DecisionDedupKey,
} from '../../src/services/decision-center-semantic-dedup';
import { isDecisionSemanticDedupEnabled } from '../../src/services/runtime-flags';

// Concise key builder for the classifier tests (defaults to a same-day, single-entity training decision).
const key = (over: Partial<DecisionDedupKey> & Pick<DecisionDedupKey, 'sourceSkill'>): DecisionDedupKey => ({
  sourceSkill: over.sourceSkill,
  decisionRecipe: over.decisionRecipe ?? `${over.sourceSkill}:decision_required`,
  targetEntityIds: over.targetEntityIds ?? ['e1'],
  timeWindow: over.timeWindow ?? '2026-05-10',
  normalizedIntent: over.normalizedIntent ?? `${over.sourceSkill}:decision_required`,
});

describe('classifyDecisionDedup (B3)', () => {
  it('returns independent_show_separately when there are no existing decisions', () => {
    expect(classifyDecisionDedup(key({ sourceSkill: 'training' }), []).verdict).toBe('independent_show_separately');
  });

  it('returns same_recommendation_update_existing for an identical fingerprint', () => {
    const k = key({ sourceSkill: 'training', decisionRecipe: 'training:plan' });
    const res = classifyDecisionDedup(k, [{ ...k }]);
    expect(res.verdict).toBe('same_recommendation_update_existing');
    expect(res.matchedKey).not.toBeNull();
  });

  it('returns newer_recommendation_supersedes_old when recipe+targets match but intent differs (same skill)', () => {
    const candidate = key({ sourceSkill: 'training', decisionRecipe: 'training:plan', normalizedIntent: 'training:decision_required' });
    const existing = { ...candidate, normalizedIntent: 'training:reflow_suggestion' };
    expect(classifyDecisionDedup(candidate, [existing]).verdict).toBe('newer_recommendation_supersedes_old');
  });

  it('NEVER collapses across skills — cross-skill pairs cannot be same_recommendation or supersedes', () => {
    const candidate = key({ sourceSkill: 'training', decisionRecipe: 'x:y' });
    const existing = key({ sourceSkill: 'secretary', decisionRecipe: 'x:y' });
    const verdict = classifyDecisionDedup(candidate, [existing]).verdict;
    expect(['same_recommendation_update_existing', 'newer_recommendation_supersedes_old']).not.toContain(verdict);
  });

  it('links a cross-skill conflict on the same entity+window (training decision_required + secretary conflict_detected)', () => {
    const candidate = key({ sourceSkill: 'training', normalizedIntent: 'training:decision_required', targetEntityIds: ['slot1'] });
    const existing = key({ sourceSkill: 'secretary', normalizedIntent: 'secretary:conflict_detected', targetEntityIds: ['slot1'] });
    expect(classifyDecisionDedup(candidate, [existing]).verdict).toBe('conflicting_recommendation_link');
  });

  it('returns independent_show_separately when target entities do not overlap', () => {
    const candidate = key({ sourceSkill: 'training', targetEntityIds: ['a'] });
    const existing = key({ sourceSkill: 'training', targetEntityIds: ['b'] });
    expect(classifyDecisionDedup(candidate, [existing]).verdict).toBe('independent_show_separately');
  });

  it('fails open to independent_show_separately for an ambiguous cross-skill same-entity case (different window, no conflict signal)', () => {
    const candidate = key({ sourceSkill: 'training', normalizedIntent: 'training:reminder', targetEntityIds: ['e1'], timeWindow: '2026-05-10' });
    const existing = key({ sourceSkill: 'cooking', normalizedIntent: 'cooking:reminder', targetEntityIds: ['e1'], timeWindow: '2026-05-11' });
    expect(classifyDecisionDedup(candidate, [existing]).verdict).toBe('independent_show_separately');
  });

  it('surfaces the strongest match even amid unrelated existing decisions', () => {
    const candidate = key({ sourceSkill: 'training', decisionRecipe: 'training:plan' });
    const unrelated = key({ sourceSkill: 'finance', targetEntityIds: ['zzz'], decisionRecipe: 'finance:risk' });
    const duplicate = { ...candidate };
    const res = classifyDecisionDedup(candidate, [unrelated, duplicate]);
    expect(res.verdict).toBe('same_recommendation_update_existing'); // not buried under the unrelated finance item
    expect(res.matchedKey?.decisionRecipe).toBe('training:plan');
  });

  it('returns the STRONGEST verdict across multiple matching existing decisions, order-independently', () => {
    const candidate = key({ sourceSkill: 'training', decisionRecipe: 'training:plan', normalizedIntent: 'training:decision_required' });
    const supersedesMatch = { ...candidate, normalizedIntent: 'training:reflow_suggestion' }; // would be supersedes (idx 1)
    const exactMatch = { ...candidate };                                                       // is same_recommendation (idx 0)
    expect(classifyDecisionDedup(candidate, [supersedesMatch, exactMatch]).verdict).toBe('same_recommendation_update_existing');
    expect(classifyDecisionDedup(candidate, [exactMatch, supersedesMatch]).verdict).toBe('same_recommendation_update_existing');
  });

  it('groups a cross-skill, non-conflicting decision on the same entity+window as same_issue_cluster', () => {
    const candidate = key({ sourceSkill: 'training', normalizedIntent: 'training:reminder', targetEntityIds: ['e1'] });
    const existing = key({ sourceSkill: 'cooking', normalizedIntent: 'cooking:reminder', targetEntityIds: ['e1'] });
    expect(classifyDecisionDedup(candidate, [existing]).verdict).toBe('same_issue_cluster');
  });

  it('does NOT supersede across different windows — fails open to independent (supersedes requires the same window)', () => {
    const candidate = key({ sourceSkill: 'training', decisionRecipe: 'training:plan', normalizedIntent: 'training:conflict_detected', timeWindow: '2026-05-30' });
    const existing = { ...candidate, normalizedIntent: 'training:decision_required', timeWindow: '2026-04-01' };
    expect(classifyDecisionDedup(candidate, [existing]).verdict).toBe('independent_show_separately');
  });
});

describe('buildDecisionDedupKey (B3)', () => {
  it('derives decisionRecipe from the dedupeKey prefix (first two colon segments)', () => {
    const k = buildDecisionDedupKey({ sourceSkill: 'training', type: 'decision_required', relatedEntityId: null, dedupeKey: 'training:missing-race-date:1:demo', createdAt: '2026-05-10T10:00:00.000Z' });
    expect(k.decisionRecipe).toBe('training:missing-race-date');
  });

  it('falls back to sourceSkill:type as decisionRecipe when dedupeKey is null', () => {
    const k = buildDecisionDedupKey({ sourceSkill: 'finance', type: 'risk_warning', relatedEntityId: null, dedupeKey: null, createdAt: '2026-05-10T10:00:00.000Z' });
    expect(k.decisionRecipe).toBe('finance:risk_warning');
    expect(k.normalizedIntent).toBe('finance:risk_warning');
  });

  it('falls back to sourceSkill:type when dedupeKey has a single segment (no colon)', () => {
    const k = buildDecisionDedupKey({ sourceSkill: 'training', type: 'reminder', relatedEntityId: null, dedupeKey: 'training', createdAt: '2026-05-10T10:00:00.000Z' });
    expect(k.decisionRecipe).toBe('training:reminder');
  });

  it('sets targetEntityIds from relatedEntityId and truncates timeWindow to the day', () => {
    const none = buildDecisionDedupKey({ sourceSkill: 'cooking', type: 'reminder', relatedEntityId: null, dedupeKey: null, createdAt: '2026-05-10T23:59:59.000Z' });
    expect(none.targetEntityIds).toEqual([]);
    const some = buildDecisionDedupKey({ sourceSkill: 'cooking', type: 'reminder', relatedEntityId: 'e9', dedupeKey: null, createdAt: '2026-05-10 23:59:59' });
    expect(some.targetEntityIds).toEqual(['e9']);
    expect(some.timeWindow).toBe('2026-05-10'); // works for SQLite space-separated format too
  });
});

describe('isDecisionSemanticDedupEnabled flag (B3)', () => {
  it('is OFF by default and opt-in only', () => {
    expect(isDecisionSemanticDedupEnabled({})).toBe(false);
    expect(isDecisionSemanticDedupEnabled({ DECISION_SEMANTIC_DEDUP_ENABLED: 'true' })).toBe(true);
    expect(isDecisionSemanticDedupEnabled({ DECISION_SEMANTIC_DEDUP_ENABLED: 'on' })).toBe(true);
    expect(isDecisionSemanticDedupEnabled({ DECISION_SEMANTIC_DEDUP_ENABLED: '1' })).toBe(true);
    expect(isDecisionSemanticDedupEnabled({ DECISION_SEMANTIC_DEDUP_ENABLED: 'enabled' })).toBe(true);
    expect(isDecisionSemanticDedupEnabled({ DECISION_SEMANTIC_DEDUP_ENABLED: 'yes' })).toBe(false);
  });

  it('supports scoped per-user opt-in isolation', () => {
    expect(isDecisionSemanticDedupEnabled({ DECISION_SEMANTIC_DEDUP_ENABLED_USER_1: 'true' }, { userId: 1, tenantId: 1 })).toBe(true);
    expect(isDecisionSemanticDedupEnabled({ DECISION_SEMANTIC_DEDUP_ENABLED_USER_1: 'true' }, { userId: 2, tenantId: 2 })).toBe(false);
  });
});
