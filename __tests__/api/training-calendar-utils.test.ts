// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import {
  estimateCalendarDurationMinutes,
  humanizeSessionType,
  inferCalendarSessionType,
  looksLikeTrainingCalendarEvent,
  normalizeTrainingStatus,
  parseExercises,
} from '../../src/api/routes/training-calendar-utils';

describe('training calendar route utilities', () => {
  it('normalizes training statuses to stable route contract values', () => {
    expect(normalizeTrainingStatus('COMPLETED')).toBe('completed');
    expect(normalizeTrainingStatus('partial')).toBe('partial');
    expect(normalizeTrainingStatus('skipped')).toBe('skipped');
    expect(normalizeTrainingStatus('rest')).toBe('rest');
    expect(normalizeTrainingStatus('unknown')).toBe('planned');
    expect(normalizeTrainingStatus(null)).toBe('planned');
  });

  it('parses exercise JSON only when it is an array', () => {
    expect(parseExercises('[{"name":"Squat"}]')).toEqual([{ name: 'Squat' }]);
    expect(parseExercises('{"name":"Squat"}')).toBeNull();
    expect(parseExercises('not json')).toBeNull();
    expect(parseExercises(null)).toBeNull();
  });

  it('humanizes known session types and falls back to Workout', () => {
    expect(humanizeSessionType('gym')).toBe('Gym');
    expect(humanizeSessionType('RUN')).toBe('Run');
    expect(humanizeSessionType('ride')).toBe('Ride');
    expect(humanizeSessionType('swim')).toBe('Swim');
    expect(humanizeSessionType('rest')).toBe('Rest');
    expect(humanizeSessionType('other')).toBe('Workout');
  });

  it('infers calendar session types from multilingual titles', () => {
    expect(inferCalendarSessionType('Tempo Run')).toBe('run');
    expect(inferCalendarSessionType('Natação técnica')).toBe('swim');
    expect(inferCalendarSessionType('Bike Z2')).toBe('ride');
    expect(inferCalendarSessionType('Upper Body Strength')).toBe('gym');
    expect(inferCalendarSessionType('Rest day')).toBe('rest');
    expect(inferCalendarSessionType('Movement')).toBe('workout');
  });

  it('recognizes training events without classifying routine or work events as workouts', () => {
    expect(looksLikeTrainingCalendarEvent('Tempo Run')).toBe(true);
    expect(looksLikeTrainingCalendarEvent('Strength Session')).toBe(true);
    expect(looksLikeTrainingCalendarEvent('Caminhada rápida zona 2')).toBe(true);
    expect(looksLikeTrainingCalendarEvent('Wake up / Prepare for walk')).toBe(false);
    expect(looksLikeTrainingCalendarEvent('Team meeting')).toBe(false);
    expect(looksLikeTrainingCalendarEvent('Atomic Habits - Daily Reading')).toBe(false);
  });

  it('estimates positive calendar durations only', () => {
    expect(estimateCalendarDurationMinutes('2026-04-20T10:00:00Z', '2026-04-20T11:15:00Z')).toBe(75);
    expect(estimateCalendarDurationMinutes('2026-04-20T11:00:00Z', '2026-04-20T10:00:00Z')).toBeNull();
    expect(estimateCalendarDurationMinutes('bad', '2026-04-20T10:00:00Z')).toBeNull();
    expect(estimateCalendarDurationMinutes(null, '2026-04-20T10:00:00Z')).toBeNull();
  });
});
