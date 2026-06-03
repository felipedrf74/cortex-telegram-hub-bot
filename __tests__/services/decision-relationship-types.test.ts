import { describe, expect, it } from 'vitest';
import {
  DECISION_RELATIONSHIP_TYPES,
  decisionRelationshipSemantics,
  type DecisionRelationshipType,
} from '../../src/services/decision-relationship-types';

describe('decisionRelationshipSemantics (C6)', () => {
  it('classifies every canonical relationship type with a non-empty label', () => {
    for (const type of DECISION_RELATIONSHIP_TYPES) {
      const s = decisionRelationshipSemantics(type);
      expect(s.type).toBe(type);
      expect(s.label.length).toBeGreaterThan(0);
    }
  });

  it('LOAD-BEARING: only `blocks` prevents action — every other type is advisory', () => {
    for (const type of DECISION_RELATIONSHIP_TYPES) {
      expect(decisionRelationshipSemantics(type).blocksAction).toBe(type === 'blocks');
    }
  });

  it('maps each type to the documented kind', () => {
    const kindOf = (t: DecisionRelationshipType): string => decisionRelationshipSemantics(t).kind;
    expect(kindOf('blocks')).toBe('prevents_action');
    expect(kindOf('blocked_by')).toBe('inverse_blocked');
    expect(kindOf('conflicts_with')).toBe('warns');
    expect(kindOf('supersedes')).toBe('replaces'); // kind name distinct from the relationship-type name
    expect(kindOf('duplicate_of')).toBe('collapses');
    for (const ctx of ['caused_by', 'related', 'related_to', 'requires_same_slot', 'affects_same_entity', 'alternative_to'] as const) {
      expect(kindOf(ctx)).toBe('context');
    }
  });

  it('falls back to a safe, NON-blocking context classification for unknown relationship strings', () => {
    const s = decisionRelationshipSemantics('totally_unknown_future_type');
    expect(s.blocksAction).toBe(false); // an unknown/future type can never accidentally block a decision
    expect(s.kind).toBe('context');
    expect(s.label).toBe('totally_unknown_future_type');
  });
});
