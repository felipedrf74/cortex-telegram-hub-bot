/**
 * Tests for src/services/plan-generator.ts
 *
 * Tests prompt building (pure function) and response parsing.
 * AI generation is mocked since we don't call real APIs in tests.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/services/database', () => ({ getDb: vi.fn() }));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/config', () => ({
  config: { anthropic: { apiKey: 'test', model: 'test' }, financeEncryption: { enabled: false, masterKey: '' } },
}));
vi.mock('../../src/services/anthropic', () => ({
  callDomain: vi.fn(),
}));

import { buildPlanPrompt, parsePlanResponse } from '../../src/services/plan-generator';
import type { PlanGenerationInput } from '../../src/services/plan-generator';

const baseInput: PlanGenerationInput = {
  userId: 1,
  goal: 'hypertrophy',
  trainingDays: [0, 1, 3, 4], // Mon, Tue, Thu, Fri
  sessionDuration: 60,
  equipment: 'full_gym',
  injuries: [],
  preferredTime: '06:00',
  currentPhase: 'build',
  weekNumber: 2,
};

// ── Prompt Builder Tests ──

describe('plan-generator — buildPlanPrompt', () => {
  it('includes goal, training days, equipment, injuries', () => {
    const prompt = buildPlanPrompt({ ...baseInput, injuries: ['left_knee'] });
    expect(prompt).toContain('hypertrophy');
    expect(prompt).toContain('Mon, Tue, Thu, Fri');
    expect(prompt).toContain('full_gym');
    expect(prompt).toContain('left_knee');
  });

  it('includes last week adherence and RPE when available', () => {
    const prompt = buildPlanPrompt({ ...baseInput, lastWeekAdherence: 85, lastWeekAvgRpe: 7.5 });
    expect(prompt).toContain('Adherence: 85%');
    expect(prompt).toContain('Average RPE: 7.5/10');
  });

  it('includes readiness score when available', () => {
    const prompt = buildPlanPrompt({ ...baseInput, readinessScore: 72 });
    expect(prompt).toContain('readiness: 72/100');
  });

  it('specifies deload rules on deload phase', () => {
    const prompt = buildPlanPrompt({ ...baseInput, currentPhase: 'deload', weekNumber: 4 });
    expect(prompt).toContain('DELOAD WEEK');
    expect(prompt).toContain('Reduce volume by 40-50%');
  });

  it('does not include deload rules on non-deload phases', () => {
    const prompt = buildPlanPrompt(baseInput);
    expect(prompt).not.toContain('DELOAD WEEK');
  });

  it('shows "none" when no injuries', () => {
    const prompt = buildPlanPrompt(baseInput);
    expect(prompt).toContain('Injuries to avoid: none');
  });
});

// ── Response Parser Tests ──

describe('plan-generator — parsePlanResponse', () => {
  const validResponse = JSON.stringify({
    sessions: [
      {
        dayOfWeek: 0,
        title: 'Upper Body Push',
        type: 'strength',
        duration: 60,
        intensity: 'RPE 7-8',
        exercises: [
          { name: 'Bench Press', sets: 4, reps: '6-8', weight: 'RPE 7', restSeconds: 120, muscleGroup: 'chest', equipment: 'barbell' },
        ],
      },
      {
        dayOfWeek: 1,
        title: 'Lower Body',
        type: 'strength',
        duration: 60,
        intensity: 'RPE 7',
        exercises: [
          { name: 'Squat', sets: 4, reps: '8-10', weight: 'RPE 7', restSeconds: 150, muscleGroup: 'quads', equipment: 'barbell' },
        ],
      },
    ],
    weekFocus: 'Hypertrophy — Upper/Lower',
    notes: 'Progressive overload week 2',
  });

  it('parses valid JSON response', () => {
    const result = parsePlanResponse(validResponse);
    expect(result.sessions).toHaveLength(2);
    expect(result.weekFocus).toBe('Hypertrophy — Upper/Lower');
  });

  it('strips markdown code fences', () => {
    const wrapped = '```json\n' + validResponse + '\n```';
    const result = parsePlanResponse(wrapped);
    expect(result.sessions).toHaveLength(2);
  });

  it('extracts JSON from surrounding text', () => {
    const withText = 'Here is the plan:\n\n' + validResponse + '\n\nLet me know!';
    const result = parsePlanResponse(withText);
    expect(result.sessions).toHaveLength(2);
  });

  it('throws on missing sessions array', () => {
    expect(() => parsePlanResponse('{"weekFocus": "test"}')).toThrow('missing sessions array');
  });

  it('throws on invalid session structure', () => {
    const invalid = JSON.stringify({ sessions: [{ title: 'Test' }] }); // missing dayOfWeek, exercises
    expect(() => parsePlanResponse(invalid)).toThrow('Invalid session structure');
  });

  it('returns valid structure with all required exercise fields', () => {
    const result = parsePlanResponse(validResponse);
    const exercise = result.sessions[0].exercises[0];
    expect(exercise.name).toBe('Bench Press');
    expect(exercise.sets).toBe(4);
    expect(exercise.reps).toBe('6-8');
    expect(exercise.weight).toBe('RPE 7');
    expect(exercise.restSeconds).toBe(120);
    expect(exercise.muscleGroup).toBe('chest');
    expect(exercise.equipment).toBe('barbell');
  });
});
