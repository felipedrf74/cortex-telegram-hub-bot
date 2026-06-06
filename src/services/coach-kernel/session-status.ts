// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * R4 P2 fix — shared session-status allowlist.
 *
 * Codex caught (R4 P2 #6) that the rule "completed / skipped / moved
 * sessions are athlete history and must NEVER be rewritten by an
 * adaptive reflow" was repeated as a free-standing literal tuple in
 * five different places (four SQL `NOT IN (...)` clauses inside
 * coach-action-executor + one in-memory check + two upstream filters
 * in training-coach-v2 + missed-session-sweep). If any caller adds
 * a new terminal status (say, `cancelled`) and forgets to update
 * even one of those tuples, the reflow can silently mutate history.
 *
 * The fix: define the allowlist + its complement here, expose both
 * type-safe TS predicates AND a helper that builds the SQL literal,
 * and route every call site through one of them. Adding a new
 * terminal status becomes a single-line change.
 *
 * Pure data + helpers. No I/O. Type-narrowing predicates.
 */

/**
 * Sessions in these statuses are athlete history. Adaptive reflows,
 * scenario classifiers, and any other engine that mutates session
 * state MUST exclude these rows. The list is intentionally
 * non-exhaustive at the type level — engines should treat *any*
 * status outside `ACTIONABLE_SESSION_STATUSES` as "not safe to
 * rewrite without explicit user action" — but the canonical set
 * here drives the SQL gates.
 */
export const TERMINAL_SESSION_STATUSES = [
  'completed',
  'skipped',
  'moved',
] as const;

export type TerminalSessionStatus = (typeof TERMINAL_SESSION_STATUSES)[number];

/**
 * Sessions in these statuses are candidates for classifier-driven
 * mutation (volume scale, day move, intensity downgrade, drop).
 *
 * R6 P2 fix — Codex caught that the original tuple `['pending',
 * 'scheduled']` blocked legitimate active states the persistence
 * layer treats as mutable: `reflowed`, `compressed`, `capped` are
 * all in `ACTIVE_SCHEDULE_STATES` at
 * `src/api/routes/training-plan-persistence.ts:82`. Excluding them
 * meant a session that had been *previously* reflowed could not be
 * reflowed again — a real workflow break (e.g. user reflows for
 * travel, then their travel plans change and they need a second
 * reflow). The actionable set now matches the persistence-layer
 * `ACTIVE_SCHEDULE_STATES` + 'pending' (the planner-default initial
 * state for newly-created sessions).
 *
 * Any status outside this set + outside the terminal set (e.g.
 * 'rest', 'unscheduled', 'deferred', 'dropped', 'cancelled',
 * 'superseded') is intentionally treated as non-actionable: better
 * to no-op than to mutate a row whose lifecycle phase doesn't
 * support classifier intervention.
 */
export const ACTIONABLE_SESSION_STATUSES = [
  'pending',
  'scheduled',
  'reflowed',
  'compressed',
  'capped',
] as const;

export type ActionableSessionStatus = (typeof ACTIONABLE_SESSION_STATUSES)[number];

/** Type-narrowing predicate for "do not rewrite this row." */
export function isTerminalSessionStatus(
  status: unknown,
): status is TerminalSessionStatus {
  return (
    typeof status === 'string' &&
    (TERMINAL_SESSION_STATUSES as readonly string[]).includes(status)
  );
}

/** Type-narrowing predicate for "safe to mutate via classifier." */
export function isActionableSessionStatus(
  status: unknown,
): status is ActionableSessionStatus {
  return (
    typeof status === 'string' &&
    (ACTIONABLE_SESSION_STATUSES as readonly string[]).includes(status)
  );
}

/**
 * SQL literal for use in a `status NOT IN (...)` clause. The list is
 * built from the canonical TS tuple so adding a new terminal status
 * propagates automatically. Returns the inner literal (no parens)
 * so the SQL caller can choose the surrounding form.
 *
 * Example:
 *   `WHERE status NOT IN (${terminalStatusesSqlList()})`
 *
 * Single-quoted literals are safe here because the contents are a
 * compile-time tuple of identifiers, not user input.
 */
export function terminalStatusesSqlList(): string {
  return TERMINAL_SESSION_STATUSES.map((s) => `'${s}'`).join(', ');
}

/** SQL literal for `status IN (...)`. Same shape as above. */
export function actionableStatusesSqlList(): string {
  return ACTIONABLE_SESSION_STATUSES.map((s) => `'${s}'`).join(', ');
}
