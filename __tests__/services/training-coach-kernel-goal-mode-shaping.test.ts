// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// TR-EC-QA-O1 + TR-EC-QA-O2 (2026-05-03 hostile QA closeout):
// Pin tests for goal-mode volume shaping and decisionReason emission.
// Before this pass goalMode was accept-and-echo on the response: the
// kernel set strengthGoal='maintenance' and prepended 'maintenance' to
// priorityOrder, but `resolveWeeklyTargets` ignored the field. A user
// declaring "Maintenance" + 7/5 sessions still got 7/5. The shaping
// pass enforces a deterministic 60% scale capped at 4 total for
// maintenance and 50%/3 for return_to_training, AND emits a structured
// `maintenance_volume_capped` / `return_to_training_volume_capped`
// decisionReason with before/after evidence so iOS can render an
// honest banner.
//
// continuous_plan_no_taper and event_based_missing_race_date are the
// other two goal-mode signals — both surfaced regardless of volume.

import { describe, expect, it } from 'vitest';
import {
  applyGoalModeVolumeShaping,
  buildCoachKernelTrainingPlan,
} from '../../src/services/training-coach-kernel-plan-generator';

const BASE_INPUT = {
  userId: 7,
  objective: 'General fitness',
  durationWeeks: 4,
  startDate: '2026-05-04',
  sessionsPerWeek: 7,
  strengthSessionsPerWeek: 5,
  preferredTime: '07:00',
  preferredCardioTime: '07:00',
  preferredStrengthTime: '12:00',
  longWorkoutDay: 'Saturday',
  notes: null,
  fitnessProfile: { experience_level: 'intermediate', available_equipment: 'Full gym' },
  gymProfile: { equipment_access: 'Full gym' },
  runProfile: { weekly_mileage_km: '40' },
};

describe('coach-kernel goal-mode volume shaping', () => {
  describe('applyGoalModeVolumeShaping', () => {
    it('passes targets through unchanged when goalMode is null/undefined', () => {
      const result = applyGoalModeVolumeShaping(
        { running: 5, strength: 3 },
        { ...BASE_INPUT, goalMode: null },
        [],
      );
      expect(result.targets).toEqual({ running: 5, strength: 3 });
      expect(result.decisionReasons).toEqual([]);
    });

    it('passes targets through unchanged for event_based and continuous (no volume effect)', () => {
      for (const goalMode of ['event_based', 'continuous'] as const) {
        const result = applyGoalModeVolumeShaping(
          { running: 5, strength: 3 },
          { ...BASE_INPUT, goalMode },
          [],
        );
        expect(result.targets).toEqual({ running: 5, strength: 3 });
        expect(result.decisionReasons).toEqual([]);
      }
    });

    it('caps maintenance at 4 total and emits maintenance_volume_capped reason', () => {
      const result = applyGoalModeVolumeShaping(
        { running: 6, strength: 4 }, // 10 total
        { ...BASE_INPUT, goalMode: 'maintenance' },
        [],
      );
      const total = (result.targets.running ?? 0) + (result.targets.strength ?? 0)
        + (result.targets.cycling ?? 0) + (result.targets.swimming ?? 0);
      expect(total).toBeLessThanOrEqual(4);
      expect(result.decisionReasons).toHaveLength(1);
      expect(result.decisionReasons[0].code).toBe('maintenance_volume_capped');
      expect(result.decisionReasons[0].severity).toBe('notice');
      expect(result.decisionReasons[0].text).toMatch(/Maintenance/);
      expect(result.decisionReasons[0].before).toMatchObject({ totalSessions: 10 });
      expect(result.decisionReasons[0].after).toMatchObject({ cap: 4 });
    });

    it('caps return_to_training at 3 total and emits return_to_training_volume_capped reason', () => {
      const result = applyGoalModeVolumeShaping(
        { running: 4, strength: 2 }, // 6 total
        { ...BASE_INPUT, goalMode: 'return_to_training' },
        [],
      );
      const total = (result.targets.running ?? 0) + (result.targets.strength ?? 0)
        + (result.targets.cycling ?? 0) + (result.targets.swimming ?? 0);
      expect(total).toBeLessThanOrEqual(3);
      expect(result.decisionReasons[0].code).toBe('return_to_training_volume_capped');
      expect(result.decisionReasons[0].text).toMatch(/Return to training/i);
      expect(result.decisionReasons[0].after).toMatchObject({ cap: 3 });
    });

    it('preserves at least 1 strength session when strength was originally requested in maintenance mode', () => {
      const result = applyGoalModeVolumeShaping(
        { running: 5, strength: 2 },
        { ...BASE_INPUT, goalMode: 'maintenance' },
        [],
      );
      expect(result.targets.strength).toBeGreaterThanOrEqual(1);
    });

    it('passes through when raw total is already at or below the cap', () => {
      const result = applyGoalModeVolumeShaping(
        { running: 2, strength: 1 }, // 3 total (under maintenance cap of 4)
        { ...BASE_INPUT, goalMode: 'maintenance' },
        [],
      );
      expect(result.targets).toEqual({ running: 2, strength: 1 });
      expect(result.decisionReasons).toEqual([]);
    });

    it('logs raceDate evidence on the reason when a race calendar is present', () => {
      const result = applyGoalModeVolumeShaping(
        { running: 6, strength: 3 },
        { ...BASE_INPUT, goalMode: 'maintenance' },
        [
          {
            id: 'goal-race',
            sport: 'running',
            subtype: 'half_marathon',
            date: '2026-09-15',
            priority: 'a',
          },
        ],
      );
      expect(result.decisionReasons[0].evidence?.some((e) => e.includes('raceDate=2026-09-15'))).toBe(true);
    });

    it('is idempotent: running the shaper on already-shaped output produces the same result', () => {
      const first = applyGoalModeVolumeShaping(
        { running: 6, strength: 4 },
        { ...BASE_INPUT, goalMode: 'maintenance' },
        [],
      );
      const second = applyGoalModeVolumeShaping(
        first.targets,
        { ...BASE_INPUT, goalMode: 'maintenance' },
        [],
      );
      // Already capped, so second pass returns unchanged + empty reasons.
      expect(second.targets).toEqual(first.targets);
      expect(second.decisionReasons).toEqual([]);
    });
  });

  describe('buildCoachKernelTrainingPlan — goalMode decisionReasons surface', () => {
    it('emits maintenance_volume_capped on the plan response when user requests 7/5 with goalMode=maintenance', () => {
      const plan = buildCoachKernelTrainingPlan({
        ...BASE_INPUT,
        sessionsPerWeek: 7,
        strengthSessionsPerWeek: 5,
        goalMode: 'maintenance',
      });
      const codes = (plan.decisionReasons ?? []).map((r) => r.code);
      expect(codes).toContain('maintenance_volume_capped');
    });

    it('emits return_to_training_volume_capped when user requests 4 sessions with goalMode=return_to_training', () => {
      const plan = buildCoachKernelTrainingPlan({
        ...BASE_INPUT,
        sessionsPerWeek: 4,
        strengthSessionsPerWeek: 2,
        goalMode: 'return_to_training',
      });
      const codes = (plan.decisionReasons ?? []).map((r) => r.code);
      expect(codes).toContain('return_to_training_volume_capped');
    });

    it('emits continuous_plan_no_taper when goalMode=continuous', () => {
      const plan = buildCoachKernelTrainingPlan({
        ...BASE_INPUT,
        goalMode: 'continuous',
      });
      const codes = (plan.decisionReasons ?? []).map((r) => r.code);
      expect(codes).toContain('continuous_plan_no_taper');
    });

    it('does NOT emit continuous_plan_no_taper when goalMode is null', () => {
      const plan = buildCoachKernelTrainingPlan({
        ...BASE_INPUT,
        goalMode: null,
      });
      const codes = (plan.decisionReasons ?? []).map((r) => r.code);
      expect(codes).not.toContain('continuous_plan_no_taper');
    });

    it('emits event_based_missing_race_date when goalMode=event_based and no race date provided', () => {
      const plan = buildCoachKernelTrainingPlan({
        ...BASE_INPUT,
        objective: 'Build base',
        goalMode: 'event_based',
        raceDate: null,
        runProfile: { weekly_mileage_km: '40' },
      });
      const codes = (plan.decisionReasons ?? []).map((r) => r.code);
      expect(codes).toContain('event_based_missing_race_date');
    });

    it('does NOT emit event_based_missing_race_date when goalMode=event_based and a race date IS provided', () => {
      const plan = buildCoachKernelTrainingPlan({
        ...BASE_INPUT,
        objective: 'Lisbon Marathon',
        goalMode: 'event_based',
        raceDate: '2026-10-18',
      });
      const codes = (plan.decisionReasons ?? []).map((r) => r.code);
      expect(codes).not.toContain('event_based_missing_race_date');
    });

    it('does not regress: maintenance reason persists into the response decisionReasons after dedupe', () => {
      const plan = buildCoachKernelTrainingPlan({
        ...BASE_INPUT,
        sessionsPerWeek: 7,
        strengthSessionsPerWeek: 5,
        goalMode: 'maintenance',
      });
      const maintenanceReasons = (plan.decisionReasons ?? []).filter(
        (r) => r.code === 'maintenance_volume_capped',
      );
      // Dedupe collapses duplicates to one.
      expect(maintenanceReasons.length).toBe(1);
      expect(maintenanceReasons[0].severity).toBe('notice');
      expect(maintenanceReasons[0].sourceConstraint?.type).toBe('volume');
    });
  });
});
