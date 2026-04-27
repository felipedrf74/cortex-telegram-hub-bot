import { describe, expect, it } from 'vitest';

import {
  adaptSessionForReadiness,
  type AdaptationContext,
} from '../../src/services/coach-kernel/adaptation-engine';
import type { ReadinessSnapshot, Session } from '../../src/services/coach-kernel/types';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    sport: 'running',
    sessionType: 'threshold_run',
    title: 'Tempo Run',
    description: '',
    dayOfWeek: 'tuesday',
    durationMinutes: 60,
    intensityZone: 'threshold',
    fatigueCost: 'high',
    keySession: true,
    plannedLoad: 80,
    tags: [],
    ...overrides,
  };
}

function readiness(level: ReadinessSnapshot['level'], score: number): ReadinessSnapshot {
  return {
    capturedAt: '2026-04-27T08:00:00.000Z',
    level,
    score,
    painFlags: [],
  };
}

describe('coach-kernel/adaptation-engine', () => {
  describe('green / yellow readiness', () => {
    it('passes through unchanged for green', () => {
      const ctx: AdaptationContext = { readiness: readiness('green', 88) };
      const adapted = adaptSessionForReadiness(makeSession(), ctx);

      expect(adapted.sessionType).toBe('threshold_run');
      expect(adapted.originalSessionType).toBeUndefined();
      expect(adapted.intensityDownshiftPct).toBeUndefined();
      expect(adapted.adaptationReason).toBe('no_change');
      expect(adapted.adaptationExplanation).toBe('Plan stays as written.');
    });

    it('passes through unchanged for yellow', () => {
      const ctx: AdaptationContext = { readiness: readiness('yellow', 70) };
      const adapted = adaptSessionForReadiness(makeSession(), ctx);

      expect(adapted.sessionType).toBe('threshold_run');
      expect(adapted.adaptationReason).toBe('no_change');
    });
  });

  describe('orange readiness', () => {
    it('caps intensity at 80% of plan but keeps the same session type', () => {
      const ctx: AdaptationContext = { readiness: readiness('orange', 50) };
      const adapted = adaptSessionForReadiness(makeSession(), ctx);

      expect(adapted.sessionType).toBe('threshold_run');
      expect(adapted.intensityDownshiftPct).toBe(0.8);
      expect(adapted.adaptationReason).toBe('orange_readiness');
      expect(adapted.adaptationExplanation).toContain('80%');
      // Original session type NOT set because we only downshifted.
      expect(adapted.originalSessionType).toBeUndefined();
    });

    it('passes already-gentle sessions through (no double-softening)', () => {
      const recoverySession = makeSession({ sessionType: 'recovery_run', title: 'Easy Recovery' });
      const ctx: AdaptationContext = { readiness: readiness('orange', 45) };
      const adapted = adaptSessionForReadiness(recoverySession, ctx);

      expect(adapted.sessionType).toBe('recovery_run');
      expect(adapted.intensityDownshiftPct).toBeUndefined();
      expect(adapted.adaptationReason).toBe('no_change');
    });
  });

  describe('red readiness', () => {
    it('swaps a running session to recovery_run with 60% cap', () => {
      const ctx: AdaptationContext = { readiness: readiness('red', 30) };
      const adapted = adaptSessionForReadiness(makeSession({ sessionType: 'threshold_run' }), ctx);

      expect(adapted.sessionType).toBe('recovery_run');
      expect(adapted.originalSessionType).toBe('threshold_run');
      expect(adapted.intensityDownshiftPct).toBe(0.6);
      expect(adapted.adaptationReason).toBe('red_readiness');
      expect(adapted.adaptationExplanation).toContain('threshold_run');
      expect(adapted.adaptationExplanation).toContain('recovery_run');
    });

    it('swaps a cycling session to recovery_ride', () => {
      const ride = makeSession({ sport: 'cycling', sessionType: 'tempo_ride' });
      const ctx: AdaptationContext = { readiness: readiness('red', 28) };
      const adapted = adaptSessionForReadiness(ride, ctx);

      expect(adapted.sessionType).toBe('recovery_ride');
      expect(adapted.intensityDownshiftPct).toBe(0.6);
    });

    it('swaps a swimming session to recovery_swim', () => {
      const swim = makeSession({ sport: 'swimming', sessionType: 'threshold_swim' });
      const ctx: AdaptationContext = { readiness: readiness('red', 25) };
      const adapted = adaptSessionForReadiness(swim, ctx);

      expect(adapted.sessionType).toBe('recovery_swim');
    });

    it('swaps a strength session to mobility (no recovery_strength session type exists)', () => {
      const strength = makeSession({ sport: 'strength', sessionType: 'strength_max' });
      const ctx: AdaptationContext = { readiness: readiness('red', 30) };
      const adapted = adaptSessionForReadiness(strength, ctx);

      expect(adapted.sessionType).toBe('mobility');
      expect(adapted.originalSessionType).toBe('strength_max');
    });

    it('passes already-gentle sessions through (no double-softening)', () => {
      const recovery = makeSession({ sessionType: 'recovery_run' });
      const ctx: AdaptationContext = { readiness: readiness('red', 30) };
      const adapted = adaptSessionForReadiness(recovery, ctx);

      expect(adapted.sessionType).toBe('recovery_run');
      expect(adapted.adaptationReason).toBe('no_change');
    });
  });

  describe('injury short-circuit', () => {
    it('forces mobility swap when injury affects the session sport, regardless of readiness', () => {
      const ctx: AdaptationContext = {
        readiness: readiness('green', 90),
        injuryAffectsSession: true,
      };
      const adapted = adaptSessionForReadiness(makeSession({ sessionType: 'interval_run' }), ctx);

      expect(adapted.sessionType).toBe('mobility');
      expect(adapted.originalSessionType).toBe('interval_run');
      expect(adapted.adaptationReason).toBe('injury_safe_swap');
      expect(adapted.intensityDownshiftPct).toBe(0.5);
    });

    it('does not double-swap an already-gentle session even with injury flag', () => {
      const recovery = makeSession({ sessionType: 'mobility' });
      const ctx: AdaptationContext = {
        readiness: readiness('orange', 45),
        injuryAffectsSession: true,
      };
      const adapted = adaptSessionForReadiness(recovery, ctx);

      expect(adapted.sessionType).toBe('mobility');
      expect(adapted.adaptationReason).toBe('no_change');
    });
  });

  describe('determinism', () => {
    it('produces identical output for identical inputs (pure function)', () => {
      const session = makeSession();
      const ctx: AdaptationContext = { readiness: readiness('orange', 50) };

      const a = adaptSessionForReadiness(session, ctx);
      const b = adaptSessionForReadiness(session, ctx);

      expect(a).toEqual(b);
    });

    it('preserves original session metadata that is not adaptation-related', () => {
      const session = makeSession({
        title: 'My Custom Tempo',
        description: 'Hand-written notes',
        durationMinutes: 75,
        plannedLoad: 95,
        tags: ['marathon', 'block-3'],
      });
      const ctx: AdaptationContext = { readiness: readiness('orange', 50) };
      const adapted = adaptSessionForReadiness(session, ctx);

      expect(adapted.title).toBe('My Custom Tempo');
      expect(adapted.description).toBe('Hand-written notes');
      expect(adapted.durationMinutes).toBe(75);
      expect(adapted.plannedLoad).toBe(95);
      expect(adapted.tags).toEqual(['marathon', 'block-3']);
    });
  });
});
