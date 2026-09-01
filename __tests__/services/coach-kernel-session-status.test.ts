/**
 * R4 P2 — session-status shared allowlist tests.
 *
 * Codex caught (R4 P2 #6) that the "do not rewrite this row" rule was
 * encoded as a hand-rolled tuple in five different places. Adding a
 * new terminal status (e.g. `cancelled`) and forgetting to update
 * one of them would silently let the reflow mutate athlete history.
 *
 * These tests pin the canonical allowlist + its consumers:
 *
 *   - The TS predicates are total + type-narrow correctly.
 *   - The SQL-literal helpers match the canonical TS tuple
 *     (single-quoted, comma-separated identifiers).
 *   - The coach-action executor + missed-session sweep + v2 route
 *     all import and route through this module (regression-by-search).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  TERMINAL_SESSION_STATUSES,
  ACTIONABLE_SESSION_STATUSES,
  isTerminalSessionStatus,
  isActionableSessionStatus,
  terminalStatusesSqlList,
  actionableStatusesSqlList,
} from '../../src/services/coach-kernel/session-status';

describe('R4 P2 — TERMINAL_SESSION_STATUSES tuple is the source of truth', () => {
  it('contains exactly the three statuses that mean "athlete history"', () => {
    expect(new Set(TERMINAL_SESSION_STATUSES)).toEqual(
      new Set(['completed', 'skipped', 'moved']),
    );
  });

  it('is disjoint from ACTIONABLE_SESSION_STATUSES (terminal vs candidates for mutation)', () => {
    const terminal = new Set<string>(TERMINAL_SESSION_STATUSES);
    for (const s of ACTIONABLE_SESSION_STATUSES) {
      expect(terminal.has(s)).toBe(false);
    }
  });
});

describe('R6 P2 — ACTIONABLE_SESSION_STATUSES covers the persistence-layer ACTIVE_SCHEDULE_STATES', () => {
  it('contains every state the persistence layer treats as active + mutable', () => {
    // Codex caught that the original tuple `['pending','scheduled']`
    // blocked legitimate active states (`reflowed`, `compressed`,
    // `capped`) that the planner produces via reflow. These tests
    // pin the contract so a future refactor can't silently shrink
    // the allowlist back.
    expect(new Set(ACTIONABLE_SESSION_STATUSES)).toEqual(
      new Set(['pending', 'scheduled', 'reflowed', 'compressed', 'capped']),
    );
  });

  it('a previously-reflowed session can be reflowed again (predicate accepts "reflowed")', () => {
    expect(isActionableSessionStatus('reflowed')).toBe(true);
  });

  it('compressed + capped sessions are mutable (planner can downgrade further)', () => {
    expect(isActionableSessionStatus('compressed')).toBe(true);
    expect(isActionableSessionStatus('capped')).toBe(true);
  });

  it('persistence-layer INACTIVE states stay non-actionable', () => {
    // Reflects training-plan-persistence.ts ACTIVE_SCHEDULE_STATES vs
    // INACTIVE_SCHEDULE_STATES split.
    for (const s of ['unscheduled', 'deferred', 'dropped', 'rest', 'cancelled', 'superseded']) {
      expect(isActionableSessionStatus(s)).toBe(false);
    }
  });
});

describe('R4 P2 — predicates type-narrow correctly', () => {
  it('isTerminalSessionStatus accepts every terminal status', () => {
    for (const s of TERMINAL_SESSION_STATUSES) {
      expect(isTerminalSessionStatus(s)).toBe(true);
    }
  });

  it('isTerminalSessionStatus rejects every actionable status', () => {
    for (const s of ACTIONABLE_SESSION_STATUSES) {
      expect(isTerminalSessionStatus(s)).toBe(false);
    }
  });

  it('isTerminalSessionStatus rejects unknown/garbage strings + non-string', () => {
    expect(isTerminalSessionStatus('paused')).toBe(false);
    expect(isTerminalSessionStatus('')).toBe(false);
    expect(isTerminalSessionStatus(null)).toBe(false);
    expect(isTerminalSessionStatus(undefined)).toBe(false);
    expect(isTerminalSessionStatus(42)).toBe(false);
  });

  it('isActionableSessionStatus accepts every actionable status', () => {
    for (const s of ACTIONABLE_SESSION_STATUSES) {
      expect(isActionableSessionStatus(s)).toBe(true);
    }
  });

  it('isActionableSessionStatus rejects every terminal status (parity with the SQL gate)', () => {
    for (const s of TERMINAL_SESSION_STATUSES) {
      expect(isActionableSessionStatus(s)).toBe(false);
    }
  });

  it('isActionableSessionStatus rejects unknown statuses (safer to no-op than to mutate)', () => {
    expect(isActionableSessionStatus('paused')).toBe(false);
    expect(isActionableSessionStatus('archived')).toBe(false);
  });
});

describe('R4 P2 — SQL-literal helpers match the canonical TS tuple', () => {
  it('terminalStatusesSqlList renders quoted identifiers in tuple order', () => {
    expect(terminalStatusesSqlList()).toBe("'completed', 'skipped', 'moved'");
  });

  it('actionableStatusesSqlList renders quoted identifiers in tuple order', () => {
    // R6 P2 expansion — actionable allowlist now mirrors the
    // persistence-layer ACTIVE_SCHEDULE_STATES + 'pending'.
    expect(actionableStatusesSqlList()).toBe("'pending', 'scheduled', 'reflowed', 'compressed', 'capped'");
  });

  it('both SQL lists are safe to interpolate (only contain identifier chars + quotes + commas + spaces)', () => {
    expect(terminalStatusesSqlList()).toMatch(/^[a-z_', ]+$/);
    expect(actionableStatusesSqlList()).toMatch(/^[a-z_', ]+$/);
  });
});

describe('R4 P2 — consumers route through session-status (no hand-rolled tuples)', () => {
  const REPO_ROOT = resolve(__dirname, '../..');

  function read(rel: string): string {
    return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
  }

  it('coach-action-executor.ts no longer contains the literal terminal tuple in SQL', () => {
    const src = read('src/services/coach-kernel/coach-action-executor.ts');
    // Strip the comments so the source-grep only inspects actual code.
    // R4/R5 commentary documents the *prior* literal form for
    // historical context; the production SQL must not still embed it.
    const noLineComments = src.replace(/\/\/.*$/gm, '');
    const noBlockComments = noLineComments.replace(/\/\*[\s\S]*?\*\//g, '');
    const code = noBlockComments;
    expect(code).not.toMatch(/NOT IN \('completed',\s*'skipped',\s*'moved'\)/);
    // R5 P2 upgrade — executor SQL now uses the actionable allowlist
    // (`IN (${ACTIONABLE_SQL_LIST})`) rather than the terminal
    // denylist. The shared module is the only source of truth.
    expect(code).toMatch(/actionableStatusesSqlList|ACTIONABLE_SQL_LIST/);
  });

  it('coach-action-executor.ts no longer contains the triple-OR in-memory check', () => {
    const src = read('src/services/coach-kernel/coach-action-executor.ts');
    expect(src).not.toMatch(
      /row\.status === 'completed' \|\| row\.status === 'skipped' \|\| row\.status === 'moved'/,
    );
    // R5 P2 upgrade — in-memory check uses the actionable predicate.
    expect(src).toMatch(/isActionableSessionStatus/);
  });

  it('missed-session-sweep.ts no longer hardcodes the actionable tuple as a SQL filter', () => {
    const src = read('src/services/missed-session-sweep.ts');
    // The fix uses `s.status IN (${ACTIONABLE_SQL_LIST})` — assert
    // the literal-only form is gone from the SQL clause and the
    // template-interpolated form replaced it.
    expect(src).toMatch(/s\.status IN \(\$\{ACTIONABLE_SQL_LIST\}\)/);
    expect(src).not.toMatch(/s\.status IN \('pending',\s*'scheduled'\)/);
    expect(src).toMatch(/actionableStatusesSqlList|ACTIONABLE_SQL_LIST/);
  });

  it('training-coach-v2.ts no longer hardcodes the actionable filter', () => {
    const src = read('src/api/routes/training-coach-v2.ts');
    expect(src).not.toMatch(
      /s\.status === 'pending' \|\| s\.status === 'scheduled'/,
    );
    expect(src).toMatch(/isActionableSessionStatus/);
  });

  it('Training E2E selects strength candidates from the complete actionable status set', () => {
    const src = read('scripts/training-e2e-flow.mjs');
    expect(src).toContain(`AND s.status IN (${actionableStatusesSqlList()})`);
  });
});
