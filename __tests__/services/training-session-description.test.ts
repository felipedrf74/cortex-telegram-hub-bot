import { describe, expect, it } from 'vitest';

import {
  buildRichSessionDescription,
  renderSectionsAsText,
  type SessionDescriptionInput,
} from '../../src/services/training-session-description';

const baseInput: SessionDescriptionInput = {
  planName: 'Lisbon Marathon Plan',
  objective: 'Lisbon Marathon',
  totalWeeks: 6,
  startDate: '2026-03-09',
  sport: 'running',
  periodization: 'block',
  weekNumber: 1,
  weekFocus: 'base',
  weekIntensityPct: 70,
  allWeeks: [
    { weekNumber: 1, focus: 'base', sessions: [{ sessionType: 'easy_run', durationMinutes: 25 }] },
    { weekNumber: 2, focus: 'base', sessions: [{ sessionType: 'easy_run', durationMinutes: 30 }] },
    { weekNumber: 3, focus: 'base', sessions: [{ sessionType: 'easy_run', durationMinutes: 30 }] },
    { weekNumber: 4, focus: 'deload', sessions: [{ sessionType: 'easy_run', durationMinutes: 25 }] },
    { weekNumber: 5, focus: 'build', sessions: [{ sessionType: 'easy_run', durationMinutes: 35 }] },
    { weekNumber: 6, focus: 'taper', sessions: [{ sessionType: 'easy_run', durationMinutes: 30 }] },
  ],
  session: {
    sessionType: 'easy_run',
    title: 'Easy Run',
    durationMinutes: 30,
    dayOfWeek: 'Monday',
  },
  profiles: {
    runProfile: { threshold_pace: '5:00' },
    fitnessProfile: { max_heart_rate: 180, threshold_heart_rate: 165 },
  },
};

describe('training-session-description', () => {
  describe('running easy run', () => {
    it('emits header, badge, execution, cooldown mobility and warmup without macro-plan clutter', () => {
      const { sections } = buildRichSessionDescription(baseInput);

      expect(sections.header.planName).toBe('Lisbon Marathon Plan');
      expect(sections.header.phase).toBeUndefined();
      expect(sections.badge.emoji).toBe('🏃');
      expect(sections.badge.eyebrow).toBe('MONDAY EASY RUN');
      expect(sections.badge.title).toBe('Easy Run');
      expect(sections.weeklyProgression).toBeUndefined();
      expect(sections.execution).toBeDefined();
      expect(sections.execution?.find((i) => i.label === 'Pace')?.value).toMatch(/\/km$/);
      expect(sections.execution?.find((i) => i.label === 'HR')?.value).toContain('bpm');
      expect(sections.execution?.find((i) => i.label === 'RPE')?.value).toBe('4-5/10');
      expect(sections.warmup?.headline).toBe('WARM-UP');
      expect(sections.cooldown?.items[0]).toMatch(/walk/i);
      expect(sections.cooldown?.items[0]).toMatch(/mobility/i);
      expect(sections.totalMinutesText).toMatch(/30 min total/);
    });

    it('renders the same content as readable plain text', () => {
      const { text } = buildRichSessionDescription(baseInput);

      expect(text).toContain('Lisbon Marathon Plan');
      expect(text).toContain('🏃 MONDAY EASY RUN');
      expect(text).not.toContain('WEEKLY PROGRESSION:');
      expect(text).not.toContain('Phase 1: Base');
      expect(text).toContain('EXECUTION:');
      expect(text).toContain('• Pace:');
      expect(text).toContain('• RPE: 4-5/10');
      expect(text).toContain('WARM-UP:');
      expect(text).toContain('COOL-DOWN:');
      expect(text).toContain('TIME: ~30 min total');
    });

    it('renders the walk-break rule for very-easy runs only', () => {
      const { sections } = buildRichSessionDescription(baseInput);
      expect(sections.execution?.some((i) => i.label === 'Walk breaks')).toBe(true);
    });
  });

  describe('running tempo run', () => {
    it('skips the walk-break rule and emits a tempo pace target', () => {
      const { sections } = buildRichSessionDescription({
        ...baseInput,
        session: { ...baseInput.session, sessionType: 'tempo_run', title: 'Tempo Run' },
      });
      expect(sections.execution?.some((i) => i.label === 'Walk breaks')).toBe(false);
      expect(sections.execution?.find((i) => i.label === 'Pace')?.note).toMatch(/comfortably hard/i);
    });
  });

  describe('strength session', () => {
    it('emits the EXERCISES section with sets/reps/RPE/rest from input', () => {
      const { sections, text } = buildRichSessionDescription({
        ...baseInput,
        sport: 'strength',
        session: {
          sessionType: 'strength_max',
          title: 'Lower Body A',
          durationMinutes: 65,
          dayOfWeek: 'Tuesday',
          exercises: [
            { name: 'Back Squat', sets: 4, reps: '6', rpe: '7-8', rest_sec: 120 },
            { name: 'Romanian Deadlift', sets: 3, reps: '10', rpe: 7, rest_sec: 90 },
            { name: 'Standing Calf Raises', sets: 3, reps: '20', rest_sec: 60, note: 'achilles health!' },
          ],
        },
      });

      expect(sections.exercises).toHaveLength(3);
      expect(sections.exercises?.[0].detail).toContain('4×6');
      expect(sections.exercises?.[0].detail).toContain('@ RPE 7-8');
      expect(sections.exercises?.[0].detail).toContain('| 2 min rest');
      expect(sections.exercises?.[2].note).toBe('achilles health!');
      expect(sections.execution).toBeUndefined();
      expect(sections.warmup?.headline).toBe('WARM-UP (10 min)');
      expect(sections.warmup?.items.some((s) => /squat sets at 50% and 70%/i.test(s))).toBe(true);
      expect(sections.important?.some((s) => /heaviest lower body/i.test(s))).toBe(true);
      expect(text).toContain('EXERCISES:');
      expect(text).toContain('1. Back Squat — 4×6 @ RPE 7-8 | 2 min rest');
      expect(text).toContain('TIME: ~60-65 min total');
    });
  });

  describe('deload week IMPORTANT block', () => {
    it('warns the user to drop volume and not chase intensity', () => {
      const { sections } = buildRichSessionDescription({
        ...baseInput,
        weekNumber: 4,
        weekFocus: 'deload',
        session: { ...baseInput.session, durationMinutes: 25 },
      });
      expect(sections.important?.some((s) => /deload/i.test(s))).toBe(true);
    });
  });

  describe('missing athlete profile', () => {
    it('omits zone-derived pace/HR but still reports an effort cue', () => {
      const { sections } = buildRichSessionDescription({
        ...baseInput,
        profiles: undefined,
      });
      expect(sections.execution?.find((i) => i.label === 'Pace')).toBeUndefined();
      expect(sections.execution?.some((i) => i.label === 'Effort')).toBe(true);
      expect(sections.execution?.find((i) => i.label === 'HR')).toBeUndefined();
      expect(sections.execution?.find((i) => i.label === 'RPE')).toBeDefined();
    });
  });

  describe('plain-text serializer', () => {
    it('uses the same single source for both the email body and the iOS view', () => {
      const { sections, text } = buildRichSessionDescription(baseInput);
      const independentRender = renderSectionsAsText(sections);
      expect(independentRender).toBe(text);
    });
  });
});
