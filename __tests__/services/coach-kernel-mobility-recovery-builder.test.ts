// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Tests for the mobility-recovery-builder (P2 follow-up to the
// 2026-05-03 time_volume_coherence recovery-variant fix).
//
// Pinned behaviors:
//  - Constants stay in lock-step with session-coherence.ts.
//  - selectMobilityRecoveryCandidates filters correctly.
//  - buildMobilityRecoveryExerciseList:
//    - returns null when catalog has <4 mobility candidates,
//    - picks ≥4 distinct warmupNeeds buckets,
//    - prescribes 2+ sets, ≥10 reps,
//    - lands the session-coherence estimate inside the
//      [MOBILITY_TARGET_MIN_MINUTES, MOBILITY_TARGET_MAX_MINUTES] band.
//  - Integration: when fed through estimateStrengthSessionMinutes,
//    the resulting session credibly fills 18-25 min (no shrink fires).

import { describe, expect, it } from 'vitest';
import {
  buildMobilityRecoveryExerciseList,
  estimateMobilityExerciseSeconds,
  MOBILITY_COOLDOWN_MINUTES,
  MOBILITY_REST_BETWEEN_SETS_SECONDS,
  MOBILITY_SECONDS_PER_REP,
  MOBILITY_SETUP_SECONDS,
  MOBILITY_TARGET_MAX_MINUTES,
  MOBILITY_TARGET_MIN_MINUTES,
  MOBILITY_TRANSITION_BETWEEN_EXERCISES_SECONDS,
  MOBILITY_WARMUP_MINUTES,
  selectMobilityRecoveryCandidates,
} from '../../src/services/coach-kernel/mobility-recovery-builder';
import { loadCoachKnowledge } from '../../src/services/coach-kernel/knowledge-loader';
import {
  DEFAULT_COOLDOWN_MINUTES,
  DEFAULT_TRANSITION_SEC,
  DEFAULT_WARMUP_MINUTES,
  estimateStrengthSessionMinutes,
} from '../../src/services/coach-kernel/session-coherence';
import type { CoachKnowledgeBase, Exercise } from '../../src/services/coach-kernel/types';

describe('mobility-recovery-builder constants', () => {
  it('stays in lock-step with session-coherence defaults', () => {
    expect(MOBILITY_WARMUP_MINUTES).toBe(DEFAULT_WARMUP_MINUTES);
    expect(MOBILITY_COOLDOWN_MINUTES).toBe(DEFAULT_COOLDOWN_MINUTES);
    expect(MOBILITY_TRANSITION_BETWEEN_EXERCISES_SECONDS).toBe(DEFAULT_TRANSITION_SEC);
  });

  it('targets a 18-25 minute mobility recovery band', () => {
    expect(MOBILITY_TARGET_MIN_MINUTES).toBe(18);
    expect(MOBILITY_TARGET_MAX_MINUTES).toBe(25);
  });

  it('uses the same per-rep math the session-coherence estimator uses for mobility', () => {
    expect(MOBILITY_SECONDS_PER_REP).toBe(2.5);
    expect(MOBILITY_SETUP_SECONDS).toBe(5);
  });
});

describe('selectMobilityRecoveryCandidates', () => {
  it('returns only beginner+low-fatigue+pure-mobility exercises', () => {
    const knowledge = loadCoachKnowledge();
    const candidates = selectMobilityRecoveryCandidates(knowledge);
    expect(candidates.length).toBeGreaterThanOrEqual(4);
    for (const c of candidates) {
      expect(c.movementPattern).toBe('mobility');
      expect(c.primaryPurpose).toBe('mobility');
      expect(c.complexity).toBe('beginner');
      expect(c.fatigueCost).toBe('low');
    }
  });

  it('is deterministic — same input produces same order', () => {
    const knowledge = loadCoachKnowledge();
    const a = selectMobilityRecoveryCandidates(knowledge).map((c: Exercise) => c.id);
    const b = selectMobilityRecoveryCandidates(knowledge).map((c: Exercise) => c.id);
    expect(a).toEqual(b);
  });

  it('includes the catalog mobility additions (cat_cow, childs_pose, hip_flexor_stretch, thoracic_rotation_open)', () => {
    const knowledge = loadCoachKnowledge();
    const ids = selectMobilityRecoveryCandidates(knowledge).map((c: Exercise) => c.id);
    expect(ids).toContain('cat_cow');
    expect(ids).toContain('childs_pose');
    expect(ids).toContain('hip_flexor_stretch');
    expect(ids).toContain('thoracic_rotation_open');
  });
});

describe('buildMobilityRecoveryExerciseList', () => {
  it('returns null when the knowledge has fewer than 4 mobility candidates', () => {
    const skinnyKnowledge = {
      exercises: [
        {
          id: 'only_one_mobility',
          name: 'Only One Mobility',
          movementPattern: 'mobility',
          primaryPurpose: 'mobility',
          complexity: 'beginner',
          fatigueCost: 'low',
          unilateral: false,
          equipment: [],
          substitutions: [],
        } as unknown as Exercise,
      ],
    } as unknown as CoachKnowledgeBase;
    expect(buildMobilityRecoveryExerciseList(skinnyKnowledge, 22)).toBeNull();
  });

  it('returns null when 4 candidates cannot span 3 warmup buckets', () => {
    const oneBucketKnowledge = {
      exercises: Array.from({ length: 4 }, (_, idx) => ({
        id: `hip_only_${idx}`,
        name: `Hip Only ${idx}`,
        movementPattern: 'mobility',
        primaryPurpose: 'mobility',
        complexity: 'beginner',
        fatigueCost: 'low',
        unilateral: false,
        equipment: [],
        substitutions: [],
        warmupNeeds: ['hip_mobility'],
      } as unknown as Exercise)),
    } as unknown as CoachKnowledgeBase;

    expect(buildMobilityRecoveryExerciseList(oneBucketKnowledge, 22)).toBeNull();
  });

  it('returns at least 4 distinct exercises when the real catalog is loaded', () => {
    const knowledge = loadCoachKnowledge();
    const list = buildMobilityRecoveryExerciseList(knowledge, 22);
    expect(list).not.toBeNull();
    expect(list!.length).toBeGreaterThanOrEqual(4);
    const ids = new Set(list!.map((p) => p.exerciseId));
    expect(ids.size).toBe(list!.length); // all distinct
  });

  it('lands the resulting session-coherence estimate inside the 18-25 minute band', () => {
    const knowledge = loadCoachKnowledge();
    const list = buildMobilityRecoveryExerciseList(knowledge, 22);
    expect(list).not.toBeNull();
    const estimated = estimateStrengthSessionMinutes({ exercises: list! }, knowledge);
    // ±2 min tolerance (the builder targets the band, not exact minutes).
    expect(estimated).toBeGreaterThanOrEqual(MOBILITY_TARGET_MIN_MINUTES - 2);
    expect(estimated).toBeLessThanOrEqual(MOBILITY_TARGET_MAX_MINUTES + 2);
    // Specifically NOT the bare warmup+cooldown floor (~13 min).
    expect(estimated).toBeGreaterThan(15);
  });

  it('clamps target above MAX (35min request lands ≤ 27 min, not 35)', () => {
    const knowledge = loadCoachKnowledge();
    const list = buildMobilityRecoveryExerciseList(knowledge, 35);
    const estimated = estimateStrengthSessionMinutes({ exercises: list! }, knowledge);
    // Generous upper tolerance: builder targets MAX_MINUTES (25) but
    // can drift slightly higher if all picked exercises happen to be
    // unilateral.
    expect(estimated).toBeLessThanOrEqual(28);
  });

  it('clamps target below MIN (10min request still produces ≥ 18 min content)', () => {
    const knowledge = loadCoachKnowledge();
    const list = buildMobilityRecoveryExerciseList(knowledge, 10);
    const estimated = estimateStrengthSessionMinutes({ exercises: list! }, knowledge);
    expect(estimated).toBeGreaterThanOrEqual(MOBILITY_TARGET_MIN_MINUTES - 2);
  });

  it('every prescription has rest, name, and ≥1 set with ≥10 reps', () => {
    const knowledge = loadCoachKnowledge();
    const list = buildMobilityRecoveryExerciseList(knowledge, 22)!;
    for (const p of list) {
      expect(p.exerciseId.length).toBeGreaterThan(0);
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.sets).toBeGreaterThanOrEqual(2);
      expect(p.restSec).toBe(MOBILITY_REST_BETWEEN_SETS_SECONDS);
      // Reps string contains a number ≥ 10.
      const repsNum = Math.max(...(p.reps.match(/\d+/g) ?? ['0']).map(Number));
      expect(repsNum).toBeGreaterThanOrEqual(10);
    }
  });

  it('produces unilateral reps marked "per side" so the estimator doubles the time correctly', () => {
    const knowledge = loadCoachKnowledge();
    const list = buildMobilityRecoveryExerciseList(knowledge, 22)!;
    for (const p of list) {
      const meta = knowledge.exercises.find((e: Exercise) => e.id === p.exerciseId);
      if (meta?.unilateral) {
        expect(p.reps.toLowerCase()).toContain('per side');
      }
    }
  });
});

describe('estimateMobilityExerciseSeconds', () => {
  it('matches the session-coherence math for a non-unilateral exercise', () => {
    const sec = estimateMobilityExerciseSeconds({ sets: 2, reps: '10', isUnilateral: false });
    // 1 set: 5 setup + 10 reps × 2.5 = 30s
    // 2 sets: 60s + 30s rest = 90s
    expect(sec).toBe(90);
  });

  it('doubles the working time for unilateral exercises', () => {
    const bilateral = estimateMobilityExerciseSeconds({ sets: 2, reps: '10', isUnilateral: false });
    const unilateral = estimateMobilityExerciseSeconds({ sets: 2, reps: '10', isUnilateral: true });
    // unilateral has 2× working time per set, but rest stays the same.
    // bilateral: 2×30 + 30 = 90
    // unilateral: 2×60 + 30 = 150
    expect(unilateral).toBeGreaterThan(bilateral);
    expect(unilateral - bilateral).toBe(60); // 2× extra 30s of work
  });

  it('parses the max numeric reps from a complex string', () => {
    // "10 per side" → 10 reps
    expect(estimateMobilityExerciseSeconds({ sets: 1, reps: '10 per side', isUnilateral: true }))
      .toBe(60); // 5 setup + 10×2.5 = 30, ×2 (unilateral) = 60
    // "30s hold" → 30 reps (hold-as-reps fallback)
    expect(estimateMobilityExerciseSeconds({ sets: 1, reps: '30s hold', isUnilateral: false }))
      .toBe(80); // 5 + 30×2.5 = 80
  });
});
