// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// training-expert-coach-knowledge-engine (2026-05-03):
// Pin tests for session-load metadata derivation. These power the
// plan-linter's heavy-lower-vs-long-run rule + future spacing-aware
// scheduling. Goals:
//   • a long run is `critical` priority with high leg/tendon load
//   • a heavy lower-body day is `critical` priority and IS NOT a
//     compatible neighbor for a critical long run
//   • upper-body strength IS a compatible neighbor for a long run
//   • recovery + mobility are `optional` priority with low load
//   • cycling is more leg-intensive but less tendon-intensive than
//     equivalent running
//   • signature is deterministic for the same shape

import { describe, expect, it } from 'vitest';
import {
  deriveSessionLoadMetadata,
  deriveSessionLoadMetadataFromShape,
  isSpacingCompatible,
} from '../../src/services/coach-kernel/session-load-metadata';
import type { Session } from '../../src/services/coach-kernel/types';

function session(overrides: Partial<Session>): Session {
  return {
    id: 's1',
    sport: 'running',
    sessionType: 'easy_run',
    title: 'Easy Run',
    description: '',
    dayOfWeek: 'monday',
    durationMinutes: 45,
    intensityZone: 'aerobic',
    fatigueCost: 'medium',
    keySession: false,
    plannedLoad: 50,
    tags: [],
    ...overrides,
  };
}

describe('coach-kernel/session-load-metadata', () => {
  describe('long-run derivation', () => {
    it('classifies a long run as critical with high leg + tendon load', () => {
      const md = deriveSessionLoadMetadata(
        session({
          sessionType: 'long_run',
          keySession: true,
          fatigueCost: 'high',
          durationMinutes: 120,
        }),
      );
      expect(md.keySessionPriority).toBe('critical');
      expect(md.legLoadScore).toBe(9);
      expect(md.tendonLoadScore).toBe(10); // running tendon load = legLoad+1
      expect(md.minimumRecoveryHours).toBeGreaterThanOrEqual(24);
      // Compatible neighbors are restricted (recovery / mobility / rest only).
      expect([...md.compatibleNeighbors]).toEqual(
        expect.arrayContaining(['recovery_run', 'recovery_ride', 'mobility', 'rest']),
      );
      expect(md.compatibleNeighbors.has('strength_upper')).toBe(false);
    });

    it('classifies a recovery run as low-load + optional neighbor set', () => {
      const md = deriveSessionLoadMetadata(
        session({ sessionType: 'recovery_run', fatigueCost: 'low' }),
      );
      expect(md.keySessionPriority).toBe('normal');
      expect(md.legLoadScore).toBe(3);
      // Recovery run carries a soft 8h floor that an `easy_run` after it can satisfy.
      expect(md.minimumRecoveryHours).toBeLessThanOrEqual(16);
    });
  });

  describe('strength derivation', () => {
    it('classifies a heavy lower-body lift as critical with leg-load 9', () => {
      const md = deriveSessionLoadMetadata(
        session({
          sport: 'strength',
          sessionType: 'strength_max',
          tags: ['lower_body'],
          keySession: true,
          fatigueCost: 'very_high',
        }),
      );
      expect(md.keySessionPriority).toBe('critical');
      expect(md.legLoadScore).toBe(9);
      expect(md.upperBodyLoadScore).toBe(1);
      expect(md.minimumRecoveryHours).toBeGreaterThanOrEqual(24);
    });

    it('classifies an upper-body strength day as low leg-load + high upper-load', () => {
      const md = deriveSessionLoadMetadata(
        session({
          sport: 'strength',
          sessionType: 'strength_hypertrophy',
          tags: ['upper_body'],
          fatigueCost: 'medium',
        }),
      );
      expect(md.legLoadScore).toBe(1);
      expect(md.upperBodyLoadScore).toBe(7);
    });

    it('classifies a maintenance day as low load + normal priority', () => {
      const md = deriveSessionLoadMetadata(
        session({
          sport: 'strength',
          sessionType: 'strength_maintenance',
          tags: ['lower_body'],
          fatigueCost: 'low',
        }),
      );
      expect(md.legLoadScore).toBe(4);
      expect(md.keySessionPriority).toBe('normal');
    });
  });

  describe('cycling vs running tendon load comparison', () => {
    it('cycling tendon load is lower than running tendon load at similar leg load', () => {
      const ride = deriveSessionLoadMetadata(
        session({ sport: 'cycling', sessionType: 'threshold_ride', keySession: true }),
      );
      const run = deriveSessionLoadMetadata(
        session({ sport: 'running', sessionType: 'threshold_run', keySession: true }),
      );
      expect(ride.tendonLoadScore).toBeLessThan(run.tendonLoadScore);
    });
  });

  describe('isSpacingCompatible', () => {
    it('rejects a long run after a heavy lower-body lift the day before (and vice versa)', () => {
      const longRun = session({
        sessionType: 'long_run',
        keySession: true,
        fatigueCost: 'high',
      });
      const heavySquat = session({
        sport: 'strength',
        sessionType: 'strength_max',
        tags: ['lower_body'],
        keySession: true,
        fatigueCost: 'very_high',
      });
      expect(isSpacingCompatible(longRun, heavySquat)).toBe(false);
      expect(isSpacingCompatible(heavySquat, longRun)).toBe(false);
    });

    it('allows an easy run before a long run', () => {
      const longRun = session({
        sessionType: 'long_run',
        keySession: true,
        fatigueCost: 'high',
      });
      const easyRun = session({ sessionType: 'easy_run' });
      expect(isSpacingCompatible(easyRun, longRun)).toBe(true);
    });

    it('allows recovery + mobility next to any critical session', () => {
      const longRun = session({
        sessionType: 'long_run',
        keySession: true,
        fatigueCost: 'high',
      });
      const mobility = session({ sessionType: 'mobility', fatigueCost: 'low' });
      const rest = session({ sessionType: 'rest', fatigueCost: 'low', durationMinutes: 0 });
      expect(isSpacingCompatible(longRun, mobility)).toBe(true);
      expect(isSpacingCompatible(longRun, rest)).toBe(true);
    });

    it('non-critical sessions can sit next to anything', () => {
      const easyA = session({ sessionType: 'easy_run' });
      const easyB = session({ sessionType: 'easy_run' });
      expect(isSpacingCompatible(easyA, easyB)).toBe(true);
    });
  });

  describe('shape derivation', () => {
    it('produces the same metadata from the synthetic-shape entry point', () => {
      const fromSession = deriveSessionLoadMetadata(
        session({
          sport: 'strength',
          sessionType: 'strength_max',
          tags: ['lower_body'],
          keySession: true,
          fatigueCost: 'very_high',
        }),
      );
      const fromShape = deriveSessionLoadMetadataFromShape({
        sport: 'strength',
        sessionType: 'strength_max',
        keySession: true,
        fatigueCost: 'very_high',
        tags: ['lower_body'],
      });
      expect(fromShape).toMatchObject({
        legLoadScore: fromSession.legLoadScore,
        keySessionPriority: fromSession.keySessionPriority,
        minimumRecoveryHours: fromSession.minimumRecoveryHours,
        signature: fromSession.signature,
      });
    });
  });

  describe('signature determinism', () => {
    it('produces stable signatures for the same shape', () => {
      const a = deriveSessionLoadMetadata(
        session({ sessionType: 'long_run', keySession: true, fatigueCost: 'high' }),
      );
      const b = deriveSessionLoadMetadata(
        session({ sessionType: 'long_run', keySession: true, fatigueCost: 'high' }),
      );
      expect(a.signature).toBe(b.signature);
      expect(a.signature).toContain('running/long_run');
    });
  });
});
