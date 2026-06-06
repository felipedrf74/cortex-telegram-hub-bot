import { describe, expect, it } from 'vitest';

import {
  resolveMaxSessionsPerDay,
  resolveWeeklyTargets,
} from '../../src/services/training-coach-kernel-plan-generator';
import type { Goals } from '../../src/services/coach-kernel/types';

/**
 * Slice 2.B (coach-engine refactor 2026-04-27) — explicit two-a-day
 * preference routing. Pinning the rule so future regressions trip a
 * test instead of leaking into production plans.
 */

function targets(overrides: Partial<Goals['weeklySessionsTarget']> = {}): Goals['weeklySessionsTarget'] {
  return {
    running: 0,
    cycling: 0,
    swimming: 0,
    strength: 0,
    ...overrides,
  };
}

describe('resolveMaxSessionsPerDay', () => {
  describe("preference: 'preferred'", () => {
    it('always returns 2 regardless of weekly volume', () => {
      // Even with a low-volume week (3 sessions, no strength), the
      // explicit "I prefer two-a-days" preference unlocks 2/day.
      expect(resolveMaxSessionsPerDay('preferred', targets({ running: 3 }))).toBe(2);
      expect(resolveMaxSessionsPerDay('preferred', targets({ running: 4, strength: 2 }))).toBe(2);
      expect(resolveMaxSessionsPerDay('preferred', targets())).toBe(2);
    });
  });

  describe("preference: 'never'", () => {
    it('returns 1 regardless of weekly volume', () => {
      expect(resolveMaxSessionsPerDay('never', targets({ running: 5, strength: 2 }))).toBe(1);
      expect(resolveMaxSessionsPerDay('never', targets({ running: 3 }))).toBe(1);
      expect(resolveMaxSessionsPerDay('never', targets())).toBe(1);
    });
  });

  describe("preference: 'optional' / null / undefined (legacy default)", () => {
    it('returns 2 only when strength sessions exist AND total volume >= 5', () => {
      // High volume + strength → 2/day (legacy inference)
      expect(resolveMaxSessionsPerDay('optional', targets({ running: 4, strength: 2 }))).toBe(2);
      expect(resolveMaxSessionsPerDay('optional', targets({ running: 3, strength: 2 }))).toBe(2);
    });

    it('returns 1 when volume is too low even with strength present', () => {
      expect(resolveMaxSessionsPerDay('optional', targets({ running: 2, strength: 2 }))).toBe(1);
    });

    it('returns 1 when no strength sessions are scheduled', () => {
      expect(resolveMaxSessionsPerDay('optional', targets({ running: 5 }))).toBe(1);
      expect(resolveMaxSessionsPerDay('optional', targets({ running: 6 }))).toBe(1);
    });

    it("treats null and undefined the same as 'optional'", () => {
      // Backward compat: callers that don't pass the field hit the
      // legacy volume-based inference, NOT the explicit branch.
      const high = targets({ running: 4, strength: 2 });
      expect(resolveMaxSessionsPerDay(null, high)).toBe(2);
      expect(resolveMaxSessionsPerDay(undefined, high)).toBe(2);
      const low = targets({ running: 2 });
      expect(resolveMaxSessionsPerDay(null, low)).toBe(1);
      expect(resolveMaxSessionsPerDay(undefined, low)).toBe(1);
    });
  });

  describe('determinism', () => {
    it('is a pure function — repeated calls return the same value', () => {
      const t = targets({ running: 4, strength: 2 });
      expect(resolveMaxSessionsPerDay('preferred', t)).toBe(2);
      expect(resolveMaxSessionsPerDay('preferred', t)).toBe(2);
      expect(resolveMaxSessionsPerDay('preferred', t)).toBe(2);
    });
  });

  // 2026-05-25 Bug #2 coverage — iOS sends literal 'auto' on the
  // "Auto" chip. Pre-fix the value was silently dropped at the
  // route validator (only never/optional/preferred were accepted),
  // so the planner never saw an explicit auto signal. Now the
  // value flows through and resolves to the volume-based heuristic
  // explicitly (so analytics + decision-reason logging can
  // distinguish "user-asked-auto" from "client-sent-nothing").
  describe("R-2026-05-25 Bug #2 — preference: 'auto'", () => {
    it("returns 2 when strength is in the mix AND total >= 5 (parity with 'optional' heuristic)", () => {
      expect(resolveMaxSessionsPerDay('auto', targets({ running: 4, strength: 2 }))).toBe(2);
      expect(resolveMaxSessionsPerDay('auto', targets({ running: 5, strength: 5 }))).toBe(2);
      expect(resolveMaxSessionsPerDay('auto', targets({ running: 3, strength: 2 }))).toBe(2);
    });

    it('returns 1 when volume < 5 even with strength present', () => {
      expect(resolveMaxSessionsPerDay('auto', targets({ running: 2, strength: 2 }))).toBe(1);
    });

    it('returns 1 when no strength sessions exist (volume alone is not enough)', () => {
      expect(resolveMaxSessionsPerDay('auto', targets({ running: 6 }))).toBe(1);
    });
  });
});

// 2026-05-25 Bug #2 coverage — hybrid focus must NOT silently
// rewrite the user's explicit per-sport asks. Pre-fix, an input
// of `(sessionsPerWeek=6, runSessionsPerWeek=5, strengthSessionsPerWeek=5)`
// was reshaped to `(running=2, strength=4)` because the hybrid branch
// inferred a volume-split from `sessionsPerWeek` only. That made
// "5 gym + 5 running" impossible to schedule and was the dominant
// blocker for two-a-day generation.
describe('R-2026-05-25 Bug #2 — resolveWeeklyTargets hybrid focus respects explicit per-sport ask', () => {
  function input(overrides: Partial<Parameters<typeof resolveWeeklyTargets>[1]> = {}) {
    return {
      sessionsPerWeek: 6,
      runSessionsPerWeek: 5,
      strengthSessionsPerWeek: 5,
      bikeSessionsPerWeek: 0,
      swimSessionsPerWeek: 0,
      sport: 'hybrid' as any,
      goals: {} as any,
      runProfile: undefined,
      ...overrides,
    } as Parameters<typeof resolveWeeklyTargets>[1];
  }

  it('respects 5 run + 5 strength when both are explicit', () => {
    const result = resolveWeeklyTargets('hybrid', input());
    expect(result.running).toBe(5);
    expect(result.strength).toBe(5);
  });

  it('caps explicit strength at STRENGTH_CAP=6', () => {
    const result = resolveWeeklyTargets('hybrid', input({ strengthSessionsPerWeek: 10 }));
    expect(result.strength).toBeLessThanOrEqual(6);
  });

  it('caps explicit running at 7', () => {
    const result = resolveWeeklyTargets('hybrid', input({ runSessionsPerWeek: 12, strengthSessionsPerWeek: 3 }));
    expect(result.running).toBeLessThanOrEqual(7);
    expect(result.strength).toBe(3);
  });

  it('falls back to inferred split when runSessionsPerWeek is missing (legacy client)', () => {
    // Without an explicit run request, the inferred volume-split
    // takes over (the legacy behavior). `sessionsPerWeek=6,
    // strengthSessionsPerWeek=4` should produce the old shape.
    const result = resolveWeeklyTargets('hybrid', input({
      runSessionsPerWeek: undefined as any,
      strengthSessionsPerWeek: 4,
    }));
    // Inferred: strengthTarget = max(1, min(4, 6-2)) = 4; running = clamp(6-4, 2, 5) = 2
    expect(result.strength).toBe(4);
    expect(result.running).toBe(2);
  });

  it('falls back to inferred split when strengthSessionsPerWeek is 0 (no explicit strength)', () => {
    // strength=0 is treated as "no explicit strength" — falls
    // through to the inferred path which uses the `||2` default.
    const result = resolveWeeklyTargets('hybrid', input({
      runSessionsPerWeek: 5,
      strengthSessionsPerWeek: 0,
    }));
    // Inferred: strengthTarget = max(1, min(0||2, 6-2)) = max(1, 2) = 2; running = clamp(6-2, 2, 5) = 4
    expect(result.strength).toBe(2);
    expect(result.running).toBe(4);
  });
});
