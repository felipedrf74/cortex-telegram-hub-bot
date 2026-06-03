// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { NotificationSourceSkill, NotificationIntentType } from './notification-orchestrator';

/**
 * B3 — semantic dedup/supersession classifier (PURE, classify-only).
 *
 * Extends the existing EXACT-match dedup (dedupeKey UNIQUE) + source-state supersession with a
 * SEMANTIC layer: given a candidate decision and the decisions already on screen, decide whether the
 * candidate is a duplicate, a fresher version, a related/conflicting decision, or genuinely separate.
 *
 * SAFETY (load-bearing): this layer must never HIDE a genuinely-different decision.
 *  - It NEVER dedupes across skills: a training-move, a meeting-move, and a meal-timing change on the
 *    same conflict are RELATED or CONFLICTING, never "the same recommendation". The collapsing
 *    verdicts are same-skill only.
 *  - It FAILS OPEN: anything ambiguous resolves to `independent_show_separately` (show both).
 *  - It is classify-ONLY — it writes nothing, supersedes nothing, hides nothing. Acting on a verdict
 *    (update/supersede/link) is a later, separately-gated slice. So this module cannot, by
 *    construction, hide a decision regardless of how it classifies.
 */

/** The semantic relationship between a candidate decision and an existing one. */
export type DecisionDedupVerdict =
  | 'same_recommendation_update_existing'
  | 'newer_recommendation_supersedes_old'
  | 'same_issue_cluster'
  | 'conflicting_recommendation_link'
  | 'independent_show_separately';

/** Normalized fingerprint of a decision, used to compare a candidate against existing decisions. */
export interface DecisionDedupKey {
  sourceSkill: NotificationSourceSkill;
  /** Coarse "what kind of recommendation": the dedupeKey's skill:recipe prefix, or skill:type fallback. */
  decisionRecipe: string;
  /** Entities the decision is about (today 0 or 1 — relatedEntityId; modelled as an array for future fan-out). */
  targetEntityIds: string[];
  /** Day-granularity window (YYYY-MM-DD) the decision was raised in. */
  timeWindow: string;
  /** `${sourceSkill}:${type}` — the precise intent. */
  normalizedIntent: string;
}

export interface ClassifyDecisionDedupResult {
  verdict: DecisionDedupVerdict;
  /** The existing key that produced the (strongest) verdict, or null when independent / no existing. */
  matchedKey: DecisionDedupKey | null;
  reason: string;
}

/** Intent types that signal an unresolved ask/conflict on an entity — the basis for conflict linking. */
const CONFLICT_SIGNAL_TYPES: ReadonlySet<string> = new Set<string>(['decision_required', 'conflict_detected']);

/** Strongest (most-collapsing) → weakest. The aggregate verdict is the lowest-index match found. */
const VERDICT_PRECEDENCE: readonly DecisionDedupVerdict[] = [
  'same_recommendation_update_existing',
  'newer_recommendation_supersedes_old',
  'conflicting_recommendation_link',
  'same_issue_cluster',
  'independent_show_separately',
];

/**
 * Build a DecisionDedupKey from real record fields. Pure + deterministic.
 * - decisionRecipe: the first two colon-segments of dedupeKey (e.g. 'training:missing-race-date:1:demo'
 *   => 'training:missing-race-date'); falls back to `${sourceSkill}:${type}` when dedupeKey is null or
 *   has fewer than two colon-separated segments.
 * - normalizedIntent: `${sourceSkill}:${type}`.
 * - targetEntityIds: [relatedEntityId] when present, else [].
 * - timeWindow: createdAt truncated to its day (YYYY-MM-DD) — works for both ISO-T and SQLite-space formats.
 */
export function buildDecisionDedupKey(input: {
  sourceSkill: NotificationSourceSkill;
  type: NotificationIntentType;
  relatedEntityId: string | null;
  dedupeKey: string | null;
  createdAt: string;
}): DecisionDedupKey {
  const normalizedIntent = `${input.sourceSkill}:${input.type}`;
  const segments = (input.dedupeKey ?? '').split(':');
  const decisionRecipe = segments.length >= 2 && segments[0] && segments[1] ? `${segments[0]}:${segments[1]}` : normalizedIntent;
  const targetEntityIds = input.relatedEntityId ? [String(input.relatedEntityId)] : [];
  const timeWindow = input.createdAt.slice(0, 10);
  return { sourceSkill: input.sourceSkill, decisionRecipe, targetEntityIds, timeWindow, normalizedIntent };
}

function intentTypeOf(key: DecisionDedupKey): string {
  const idx = key.normalizedIntent.indexOf(':');
  return idx >= 0 ? key.normalizedIntent.slice(idx + 1) : key.normalizedIntent;
}

function targetsOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const set = new Set(a);
  return b.some((id) => set.has(id));
}

/**
 * Classify ONE candidate-vs-one-existing pair. Conservative + FAIL-OPEN. The collapsing verdicts
 * (same_recommendation / supersedes) require a SAME-SKILL match on recipe + overlapping targets AND
 * the SAME day-window; a cross-skill pair, or a pair in different windows, can therefore only ever be
 * same_issue_cluster / conflicting_recommendation_link / independent_show_separately. The same-window
 * guard on supersedes is deliberate and symmetric with same_recommendation: across windows we are less
 * certain two decisions are the same evolving recommendation, so we fail open (show both) rather than
 * auto-supersede across cycles. Anything that doesn't match a rule defaults to independent.
 */
function classifyPair(candidate: DecisionDedupKey, existing: DecisionDedupKey): DecisionDedupVerdict {
  const sameSkill = candidate.sourceSkill === existing.sourceSkill;
  const recipeMatch = candidate.decisionRecipe === existing.decisionRecipe;
  const overlap = targetsOverlap(candidate.targetEntityIds, existing.targetEntityIds);
  const intentMatch = candidate.normalizedIntent === existing.normalizedIntent;
  const windowMatch = candidate.timeWindow === existing.timeWindow;
  const bothConflictSignals = CONFLICT_SIGNAL_TYPES.has(intentTypeOf(candidate)) && CONFLICT_SIGNAL_TYPES.has(intentTypeOf(existing));

  // Collapsing verdicts are SAME-SKILL + SAME-WINDOW ONLY — cross-skill or cross-window can never reach these.
  if (sameSkill && recipeMatch && overlap && intentMatch && windowMatch) return 'same_recommendation_update_existing';
  if (sameSkill && recipeMatch && overlap && windowMatch && !intentMatch) return 'newer_recommendation_supersedes_old';
  // Conflict link: the same entity in the same window where both decisions are unresolved asks (any skills).
  if (overlap && windowMatch && bothConflictSignals) return 'conflicting_recommendation_link';
  // Cross-skill issue cluster: the same entity + window, different skills, non-conflicting => show together.
  if (!sameSkill && overlap && windowMatch) return 'same_issue_cluster';
  return 'independent_show_separately';
}

/**
 * Classify a candidate against the set of existing decisions. Returns the STRONGEST (most-collapsing)
 * verdict found against any existing key, with that key as matchedKey — so a true duplicate of one
 * decision is surfaced even amid unrelated ones. Each pair is classified conservatively + fail-open,
 * so the aggregate can never invent a cross-skill collapse. Empty existing => independent. Pure; no
 * DB/env access. Classify-ONLY: the caller decides whether to act; this hides nothing.
 *
 * Single-verdict contract (deliberate, with a known limitation): only the one strongest verdict +
 * its key are returned. If the candidate both supersedes existing[A] AND conflicts with existing[B],
 * the weaker conflict link is NOT surfaced here. A consumer that needs the full relationship map
 * (e.g. the future acting slice, to both supersede A and link-conflict B) must classify per-pair
 * itself; this aggregate intentionally answers only "what is the single dominant thing to do".
 */
export function classifyDecisionDedup(
  candidate: DecisionDedupKey,
  existing: ReadonlyArray<DecisionDedupKey>,
): ClassifyDecisionDedupResult {
  let bestVerdict: DecisionDedupVerdict = 'independent_show_separately';
  let bestKey: DecisionDedupKey | null = null;
  for (const key of existing) {
    const verdict = classifyPair(candidate, key);
    if (VERDICT_PRECEDENCE.indexOf(verdict) < VERDICT_PRECEDENCE.indexOf(bestVerdict)) {
      bestVerdict = verdict;
      bestKey = key;
    }
  }
  if (bestVerdict === 'independent_show_separately') {
    return { verdict: bestVerdict, matchedKey: null, reason: 'no semantically-equivalent or conflicting existing decision' };
  }
  return { verdict: bestVerdict, matchedKey: bestKey, reason: `matched existing ${bestKey?.normalizedIntent ?? '?'} on recipe ${bestKey?.decisionRecipe ?? '?'}` };
}
