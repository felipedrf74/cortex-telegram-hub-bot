import { describe, expect, it } from 'vitest';
import {
  appendTrainingIdentityMarker,
  buildTrainingSessionIdentityKey,
  computeTrainingSessionShapeHash,
  parseTrainingIdentityMarker,
} from '../../src/services/training-session-identity';

describe('training-session-identity', () => {
  it('builds a stable logical key without plan_version or shape', () => {
    expect(buildTrainingSessionIdentityKey({
      planId: 7,
      weekNumber: 2,
      dayOfWeek: 'Wednesday',
      sessionType: 'Gym',
      ordinal: 1,
    })).toBe('plan:7|week:2|day:wednesday|type:gym|slot:1');
  });

  it('keeps cosmetic text changes out of the shape hash but changes on material structure', () => {
    const base = computeTrainingSessionShapeHash({
      sessionType: 'gym',
      title: 'Wednesday Strength Session (48min)',
      durationMinutes: 48,
      intensityText: 'RPE 72%',
      exercises: [{ name: 'Goblet Squat', sets: 3, reps: 10, restSec: 90 }],
    });
    const cosmetic = computeTrainingSessionShapeHash({
      sessionType: 'gym',
      title: 'Strength session',
      durationMinutes: 48,
      intensityText: 'RPE 72%',
      exercises: [{ name: 'Goblet Squat', sets: 3, reps: 10, restSec: 90 }],
    });
    const material = computeTrainingSessionShapeHash({
      sessionType: 'gym',
      title: 'Strength session',
      durationMinutes: 48,
      intensityText: 'RPE 72%',
      exercises: [{ name: 'Back Squat', sets: 5, reps: 5, restSec: 180 }],
    });

    expect(cosmetic).toBe(base);
    expect(material).not.toBe(base);
  });

  it('round-trips the calendar identity marker', () => {
    const description = appendTrainingIdentityMarker('Main work', {
      planId: 11,
      planVersion: 3,
      sessionId: 22,
      sessionIdentityKey: 'plan:11|week:1|day:monday|type:gym|slot:1',
      sessionShapeHash: 'abc123',
    });

    expect(parseTrainingIdentityMarker(description)).toEqual({
      planId: 11,
      planVersion: 3,
      sessionId: 22,
      sessionIdentityKey: 'plan:11|week:1|day:monday|type:gym|slot:1',
      sessionShapeHash: 'abc123',
    });
  });
});
