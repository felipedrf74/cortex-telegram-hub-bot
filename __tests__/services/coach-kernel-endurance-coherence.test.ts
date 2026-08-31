// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../../src/config';
import { buildSessionIntensityProfile } from '../../src/services/coach-kernel/intensity-profile';
import { validateEnduranceCoherence } from '../../src/services/coach-kernel/endurance-coherence';
import type { Session, WorkoutTemplate } from '../../src/services/coach-kernel/types';

const previousEnabled = config.coaching.trainingEnduranceCoherenceV2Enabled;

afterEach(() => {
  config.coaching.trainingEnduranceCoherenceV2Enabled = previousEnabled;
});

function thresholdSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'threshold-1',
    sport: 'running',
    sessionType: 'threshold_run',
    title: 'Threshold Run',
    description: 'Controlled threshold repetitions',
    dayOfWeek: 'tuesday',
    durationMinutes: 60,
    intensityZone: 'threshold',
    fatigueCost: 'high',
    keySession: true,
    plannedLoad: 80,
    tags: [],
    sessionRole: 'threshold',
    ...overrides,
  };
}

describe('endurance coherence guard', () => {
  it('warns when interval segments do not close to the planned duration', () => {
    config.coaching.trainingEnduranceCoherenceV2Enabled = true;
    const validation = validateEnduranceCoherence([thresholdSession({
      intensityProfile: {
        primaryZone: 'threshold',
        segments: [
          { role: 'warmup', modality: 'running', durationSec: 600, targetZone: 'aerobic' },
          { role: 'interval', modality: 'running', durationSec: 480, reps: 3, targetZone: 'threshold' },
          { role: 'recovery', modality: 'running', durationSec: 180, reps: 3, targetZone: 'recovery' },
          { role: 'cooldown', modality: 'running', durationSec: 300, targetZone: 'recovery' },
        ],
        intensityDistribution: {},
      },
    })]);

    expect(validation.guardrailResults.some((result) =>
      result.ruleId.startsWith('endurance_interval_duration_mismatch_')
    )).toBe(true);
  });

  it('accepts the duration-closed default interval profile', () => {
    config.coaching.trainingEnduranceCoherenceV2Enabled = true;
    const template: WorkoutTemplate = {
      id: 'threshold-template',
      sport: 'running',
      sessionType: 'threshold_run',
      title: 'Threshold Run',
      phaseTags: ['build'],
      goalTags: [],
      durationOptionsMinutes: [60],
      primaryZone: 'threshold',
      fatigueCost: 'high',
      keySession: true,
      instructions: [],
      constraints: [],
    };
    const validation = validateEnduranceCoherence([thresholdSession({
      intensityProfile: buildSessionIntensityProfile(
        template,
        60,
        { thresholdPaceSecondsPerKm: 240 },
      ),
    })]);

    expect(validation.guardrailResults.some((result) =>
      result.ruleId.startsWith('endurance_interval_duration_mismatch_')
    )).toBe(false);
  });

  it('ships enabled by default with explicit off and malformed fail-closed semantics', () => {
    const source = readFileSync('src/config.ts', 'utf8');

    expect(source).toContain("TRAINING_ENDURANCE_COHERENCE_V2_ENABLED");
    expect(source).toContain("trainingEnduranceCoherenceV2Enabled: TRAINING_ENDURANCE_COHERENCE_V2_ENABLED");
    expect(source).toContain("=== 'on'");
    expect(source).toContain("=== undefined");
    expect(source).not.toContain("trainingEnduranceCoherenceV2Raw === ''");
  });
});
