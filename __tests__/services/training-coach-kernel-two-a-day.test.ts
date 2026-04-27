import { describe, expect, it } from 'vitest';

import { resolveMaxSessionsPerDay } from '../../src/services/training-coach-kernel-plan-generator';
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
});
