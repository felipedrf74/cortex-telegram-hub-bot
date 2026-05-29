/**
 * C6 — typed dependency/relationship semantics (single source of truth).
 *
 * Extends the original `blocks | supersedes | caused_by | related` vocabulary with the richer set the
 * audit called for. The LOAD-BEARING rule: only `blocks` prevents action — every other relationship is
 * advisory (a conflict warning, a supersession, a duplicate-collapse, or pure context). Keeping that
 * decision in ONE place means the dependency-block filter, the API surfacing, and any future
 * cross-skill auto-detection cannot drift apart. The backing column is free-form TEXT (no CHECK), so
 * widening this vocabulary needs no migration.
 */

export type DecisionRelationshipType =
  | 'blocks'
  | 'blocked_by'
  | 'supersedes'
  | 'caused_by'
  | 'related'
  | 'conflicts_with'
  | 'duplicate_of'
  | 'related_to'
  | 'requires_same_slot'
  | 'affects_same_entity'
  | 'alternative_to';

/** How a relationship affects the dependent decision's handling. */
export type DecisionRelationshipKind =
  | 'prevents_action' // hard block — the ONLY action-preventing kind
  | 'inverse_blocked' // this decision is blocked BY another; action-prevention rides the forward `blocks` edge, not this one
  | 'warns' // surface a conflict warning, but never block
  | 'replaces' // the newer hides/replaces the older (distinct from the `supersedes` relationship TYPE name)
  | 'collapses' // duplicate — fold into the canonical decision
  | 'context'; // pure context / grouping, no handling impact

export interface DecisionRelationshipSemantics {
  type: DecisionRelationshipType;
  /** True ONLY for `blocks`. Drives the dependency-block filter; every other relationship is advisory. */
  blocksAction: boolean;
  kind: DecisionRelationshipKind;
  /** Short human-facing label. */
  label: string;
}

/** Canonical, ordered list of every recognized relationship type. */
export const DECISION_RELATIONSHIP_TYPES: readonly DecisionRelationshipType[] = [
  'blocks',
  'blocked_by',
  'supersedes',
  'caused_by',
  'related',
  'conflicts_with',
  'duplicate_of',
  'related_to',
  'requires_same_slot',
  'affects_same_entity',
  'alternative_to',
];

const RELATIONSHIP_META: Record<DecisionRelationshipType, { kind: DecisionRelationshipKind; label: string }> = {
  blocks: { kind: 'prevents_action', label: 'Blocks' },
  blocked_by: { kind: 'inverse_blocked', label: 'Blocked by' },
  supersedes: { kind: 'replaces', label: 'Supersedes' },
  caused_by: { kind: 'context', label: 'Caused by' },
  related: { kind: 'context', label: 'Related' },
  conflicts_with: { kind: 'warns', label: 'Conflicts with' },
  duplicate_of: { kind: 'collapses', label: 'Duplicate of' },
  related_to: { kind: 'context', label: 'Related to' },
  requires_same_slot: { kind: 'context', label: 'Needs the same time slot' },
  affects_same_entity: { kind: 'context', label: 'Affects the same item' },
  alternative_to: { kind: 'context', label: 'Alternative to' },
};

/**
 * Resolve a relationship type's semantics. Accepts any string (the column is free-form TEXT) and falls
 * back to a SAFE, non-blocking `context` classification for unrecognized values — so an unknown or
 * future relationship can never accidentally block a decision. `blocksAction` is true only for `blocks`.
 */
export function decisionRelationshipSemantics(type: string): DecisionRelationshipSemantics {
  const meta = RELATIONSHIP_META[type as DecisionRelationshipType];
  if (!meta) {
    return { type: type as DecisionRelationshipType, blocksAction: false, kind: 'context', label: type };
  }
  return { type: type as DecisionRelationshipType, blocksAction: type === 'blocks', kind: meta.kind, label: meta.label };
}
