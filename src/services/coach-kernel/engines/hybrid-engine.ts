// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { AthleteState, BlockPhase } from '../types';

export interface HybridResolution {
  adjustedRunSessions: number;
  adjustedStrengthSessions: number;
  notes: string[];
}

export function resolveHybridPriority(athlete: AthleteState, phase: BlockPhase): HybridResolution {
  const requestedRun = athlete.goals.weeklySessionsTarget.running ?? 4;
  const requestedStrength = athlete.goals.weeklySessionsTarget.strength ?? 2;
  const notes: string[] = [];
  const raceSoon = athlete.goals.raceCalendar.some((race) => {
    const raceMs = Date.parse(race.date);
    return Number.isFinite(raceMs) && raceMs - Date.now() <= 56 * 24 * 60 * 60 * 1000;
  });
  const endurancePriority = athlete.goals.priorityOrder[0] === 'running'
    || athlete.goals.primaryFocus === 'marathon'
    || athlete.goals.primaryFocus === 'triathlon';

  if (endurancePriority || raceSoon || phase === 'peak' || phase === 'taper') {
    notes.push('Endurance priority is active, so strength drops to minimum effective dose.');
    return {
      adjustedRunSessions: requestedRun,
      adjustedStrengthSessions: Math.min(requestedStrength, 2),
      notes,
    };
  }

  if (athlete.goals.secondaryFocus === 'strength' || athlete.goals.strengthGoal === 'hypertrophy') {
    notes.push('Strength priority is active, so endurance is held to maintenance frequency.');
    return {
      adjustedRunSessions: Math.min(requestedRun, 3),
      adjustedStrengthSessions: requestedStrength,
      notes,
    };
  }

  notes.push('Hybrid balance stays neutral this week.');
  return {
    adjustedRunSessions: requestedRun,
    adjustedStrengthSessions: requestedStrength,
    notes,
  };
}

