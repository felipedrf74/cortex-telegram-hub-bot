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

    it('marks warm-up and cooldown text as non-catalog only in active identity mode', () => {
      const off = buildRichSessionDescription(baseInput).sections;
      const active = buildRichSessionDescription({
        ...baseInput,
        exerciseIdentityMode: 'active',
      }).sections;
      const shadow = buildRichSessionDescription({
        ...baseInput,
        exerciseIdentityMode: 'shadow',
      }).sections;

      expect(shadow).toEqual(off);
      expect(off.warmup).not.toHaveProperty('newlyPrescribable');
      expect(off.warmup).not.toHaveProperty('mediaEligible');
      expect(off.cooldown).not.toHaveProperty('newlyPrescribable');
      expect(off.cooldown).not.toHaveProperty('mediaEligible');
      expect(active.warmup).toMatchObject({ newlyPrescribable: false, mediaEligible: false });
      expect(active.cooldown).toMatchObject({ newlyPrescribable: false, mediaEligible: false });
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

    it('uses strength prescription when a mislabeled session carries strength evidence', () => {
      const { sections, text } = buildRichSessionDescription({
        ...baseInput,
        sport: 'running',
        session: {
          sessionType: 'easy_run',
          title: 'Upper Hypertrophy',
          durationMinutes: 50,
          dayOfWeek: 'Thursday',
          description: [
            'Strict Zone 2 with walk breaks if HR drifts.',
            'session_prescription · mp3',
            'Keep elbows stacked and stop each set with 2 reps in reserve.',
          ].join('\n'),
          exercises: [
            { name: 'Dumbbell Bench Press', sets: 4, reps: '8-10', rpe: '7', rest_sec: 90 },
            { name: 'Seated Row', sets: 3, reps: '10-12', rpe: '7', rest_sec: 75 },
          ],
        },
      });

      expect(sections.execution).toBeUndefined();
      expect(sections.exercises).toHaveLength(2);
      expect(sections.warmup?.items.some((item) => /main lift/i.test(item))).toBe(true);
      expect(text).toContain('EXERCISES:');
      expect(text).not.toMatch(/Zone 2|walk breaks|HR drifts|session_prescription|mp3/i);
      expect(text).toContain('Keep elbows stacked');
    });

    it('does not treat standalone "press" in an endurance title as strength evidence', () => {
      const { sections, text } = buildRichSessionDescription({
        ...baseInput,
        sport: 'running',
        session: {
          sessionType: 'easy_run',
          title: 'Press deeper into Zone 2',
          durationMinutes: 35,
          dayOfWeek: 'Friday',
          description: 'Stay relaxed and keep the rhythm smooth.',
        },
      });

      expect(sections.execution?.some((item) => item.label === 'RPE')).toBe(true);
      expect(sections.exercises).toBeUndefined();
      expect(text).toContain('EXECUTION:');
      expect(text).not.toContain('EXERCISES:');
    });
  });

  describe('free-text modality linter', () => {
    it('removes strength execution language from running notes before iOS renders them', () => {
      const { sections, text } = buildRichSessionDescription({
        ...baseInput,
        session: {
          ...baseInput.session,
          sessionType: 'tempo_run',
          title: 'Tempo Run',
          description: 'Run controlled.\nKeep 2 reps in reserve on the main set.\ncalendar_busy_blocks · mp1',
        },
      });

      expect(sections.execution?.some((item) => item.label === 'Pace')).toBe(true);
      expect(sections.notes).toBe('Run controlled.');
      expect(text).not.toMatch(/reps in reserve|calendar_busy_blocks|mp1/i);
    });

    it('removes plural strength and cycling cues from swimming notes', () => {
      const { sections, text } = buildRichSessionDescription({
        ...baseInput,
        sport: 'swimming',
        session: {
          sessionType: 'threshold_swim',
          title: 'Threshold Swim',
          durationMinutes: 45,
          dayOfWeek: 'Wednesday',
          description: [
            'Hold a smooth catch and controlled breathing.',
            'Skip squats and deadlifts after the pool.',
            'Use high cadence like a bike interval.',
          ].join('\n'),
        },
      });

      expect(sections.execution?.some((item) => item.label === 'Effort' || item.label === 'RPE')).toBe(true);
      expect(sections.notes).toBe('Hold a smooth catch and controlled breathing.');
      expect(text).not.toMatch(/squats|deadlifts|cadence/i);
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

    it('emits compact user-facing coach insights from decisions and progression metadata', () => {
      const { sections, text } = buildRichSessionDescription({
        ...baseInput,
        sport: 'strength',
        session: {
          sessionType: 'strength_max',
          title: 'Lower Body A',
          durationMinutes: 60,
          dayOfWeek: 'Tuesday',
          sessionRole: 'strength_maintenance',
          sessionRoleLabel: 'Strength maintenance',
          sessionRoleSummary: 'Keeps strength touchpoints without competing with key endurance work.',
          intensitySummary: {
            targetSummaryText: 'Keep this controlled around the key long run.',
          },
          decisionReasons: [
            {
              code: 'equipment_conservative_default',
              severity: 'warning',
              text: 'I used bodyweight-safe options because your available equipment is unknown.',
            },
          ],
          exercises: [
            {
              name: 'Goblet Squat',
              sets: 3,
              reps: '8',
              tempo: '3-1-1',
              selectionReason: {
                pickedBecause: ['Matches your dumbbell equipment.'],
              },
              progressionState: 'hold',
              progressionSummary: 'Held load this week because last session was marked too hard.',
            },
          ],
        },
      });

      expect(sections.coachInsights?.some((item) => item.label === 'Training role')).toBe(true);
      expect(sections.coachInsights?.some((item) => item.reasonCode === 'equipment_conservative_default')).toBe(true);
      expect(sections.coachInsights?.some((item) => item.label === 'Goblet Squat progression')).toBe(true);
      expect(text).toContain('COACH INSIGHTS:');
      expect(text).toContain('I used bodyweight-safe options');
      expect(text).not.toContain('candidate');
      expect(text).not.toContain('selector trace');
    });

    it('renders the provider email body in useful training-content order', () => {
      const text = renderSectionsAsText({
        header: { planName: 'Example Plan' },
        badge: { emoji: '🏃', eyebrow: 'MONDAY EASY RUN', title: 'Easy Run' },
        weeklyProgression: [
          { weekNumber: 1, weekStart: 'Mar 9', summary: '30 min easy' },
        ],
        warmup: {
          headline: 'WARM-UP',
          items: ['5 min walk', '3 min mobility'],
        },
        execution: [
          { label: 'Pace', value: '6:00/km' },
          { label: 'RPE', value: '4-5/10' },
        ],
        cooldown: {
          headline: 'COOL-DOWN',
          items: ['5 min walk'],
        },
        important: ['Keep it conversational.'],
        notes: 'Bring water.',
        totalMinutesText: '~30 min total',
      } as any);

      expect(text.startsWith('Example Plan')).toBe(true);
      expect(text.startsWith('NEXUS_')).toBe(false);
      expect(text.indexOf('WARM-UP')).toBeLessThan(text.indexOf('MAIN WORKOUT'));
      expect(text.indexOf('MAIN WORKOUT')).toBeLessThan(text.indexOf('COOL-DOWN'));
      expect(text.indexOf('COOL-DOWN')).toBeLessThan(text.indexOf('TIPS / RECOMMENDATIONS'));
      expect(text).not.toContain('⚠️ IMPORTANT:');
    });

    it('keeps split diagnostics below the workout and avoids duplicate section dumps', () => {
      const text = renderSectionsAsText({
        header: { planName: 'Muscle Building Plan' },
        badge: { emoji: '💪', eyebrow: 'FRIDAY GYM', title: 'Lower Posterior Chain D' },
        blocks: [
          {
            id: 'split-ABCDE-D',
            type: 'why_this_session',
            title: 'WHY THIS SESSION',
            subtitle: 'ABCDE slot D',
            summary: 'Hamstrings and glutes',
            items: ['Primary muscles: hamstrings, glutes'],
            metrics: [{ label: 'Split', value: 'ABCDE D' }],
          },
          {
            id: 'structured-prescription',
            type: 'session_prescription',
            title: 'SESSION STRUCTURE',
            summary: 'Warm-up, main work, accessories, core, and cooldown are preserved as explicit sections.',
            items: ['MAIN LIFT: Romanian Deadlift · 3×6-12 · RIR 2 · 120s rest'],
            metrics: [],
            warnings: [],
          },
        ],
        warmup: { headline: 'WARM-UP (8 min)', items: ['5 min walk/bike'] },
        exercises: [
          { index: 1, name: 'Romanian Deadlift', detail: '3×6-12 @ RPE 7-8 | 2 min rest' },
          { index: 2, name: 'Hip Thrust', detail: '3×6-12 @ RPE 7-8 | 2 min rest' },
        ],
        cooldown: { headline: 'COOL-DOWN', items: ['5 min mobility'] },
        totalMinutesText: '~45 min total',
      } as any);

      expect(text.indexOf('MAIN WORKOUT — EXERCISES:')).toBeLessThan(text.indexOf('WHY THIS SESSION:'));
      expect(text.indexOf('WHY THIS SESSION:')).toBeLessThan(text.indexOf('SESSION STRUCTURE:'));
      expect(text).not.toContain('• MAIN LIFT: Romanian Deadlift');
    });

    it('uses one clean main-workout label instead of stacked headings', () => {
      const { text: runningText } = buildRichSessionDescription(baseInput);
      expect(runningText).toContain('MAIN WORKOUT — EXECUTION:');
      expect(runningText).not.toContain('MAIN WORKOUT:\nEXECUTION:');

      const { text: strengthText } = buildRichSessionDescription({
        ...baseInput,
        sport: 'strength',
        session: {
          sessionType: 'strength_max',
          title: 'Lower Body A',
          durationMinutes: 65,
          dayOfWeek: 'Tuesday',
          exercises: [
            { name: 'Back Squat', sets: 4, reps: '6', rpe: '7-8', rest_sec: 120 },
          ],
        },
      });
      expect(strengthText).toContain('MAIN WORKOUT — EXERCISES:');
      expect(strengthText).not.toContain('MAIN WORKOUT:\nEXERCISES:');
    });
  });
});
