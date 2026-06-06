// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Mesocycle resolver — slice B3 of the Week-Level Adaptability +
 * Periodization plan (v2.1).
 *
 * Composes B2's `resolveWeekIntent` (per-week resolution) into a
 * full-plan WeekIntent[]. Reads the block templates and per-level
 * cadence from A1b's `training-principles.json` and merges with the
 * race calendar (B2a) to insert taper + post-race blocks
 * automatically.
 *
 * Algorithm:
 *   1. Determine mesocycle length from athlete level (A1b).
 *   2. Pick the block template (default 'accumulation_4wk' / etc).
 *   3. For each week 0..totalWeeks-1:
 *        - Compute weekStartDate from plan startDate.
 *        - Call resolveWeekIntent(weekStartDate, mesocycleTemplate, raceCalendar, principles).
 *        - Race-window overrides win over mesocycle position.
 *   4. Return WeekIntent[].
 *
 * Engines (B2/B3 consumers) read `result[weekIndex]` to dispatch.
 */

import type {
  CoachPlanPolicy,
  RaceEvent,
  WeekIntent,
  WeekIntentKindEnum,
} from './types';
import {
  getBlockTemplate,
  getMesocycleLength,
  type Principles,
} from './training-principles';
import { resolveWeekIntent } from './week-intent';

export interface ResolveMesocyclePlanInput {
  /** ISO date for the plan start (Monday recommended). */
  startDate: string;
  totalWeeks: number;
  level: 'novice' | 'intermediate' | 'advanced';
  raceCalendar?: readonly RaceEvent[];
  policy?: CoachPlanPolicy;
  principles: Principles;
  /**
   * Override the block template name. Default picks based on level:
   *   - novice → 'accumulation_5wk_novice'
   *   - intermediate → 'accumulation_4wk'
   *   - advanced → 'accumulation_3wk_advanced'
   */
  blockTemplateName?: string;
}

export interface ResolvedMesocyclePlan {
  blockTemplateName: string;
  blockTemplate: WeekIntentKindEnum[];
  mesocycleLength: number;
  weeks: WeekIntent[];
}

/**
 * Resolve a complete plan's WeekIntent[]. Each week's intent is
 * race-calendar-aware, so a 12-week plan with an A-priority race in
 * week 11 will automatically have week 11 marked 'race', weeks 9-10
 * marked 'taper', and so on.
 */
export function resolveMesocyclePlan(
  input: ResolveMesocyclePlanInput,
): ResolvedMesocyclePlan {
  const blockName = input.blockTemplateName ?? defaultBlockNameFor(input.level);
  const configuredTemplate = getBlockTemplate(input.principles, blockName);
  const blockTemplate = configuredTemplate && configuredTemplate.length > 0
    ? configuredTemplate
    : defaultBlockFallback(input.level);
  const configuredMesocycleLength = getMesocycleLength(input.principles, input.level);
  const mesocycleLength = blockTemplate.length || configuredMesocycleLength;

  const start = Date.parse(input.startDate);
  if (!Number.isFinite(start)) {
    throw new Error(`resolveMesocyclePlan: invalid startDate ${input.startDate}`);
  }

  const weeks: WeekIntent[] = [];
  for (let i = 0; i < input.totalWeeks; i++) {
    const weekStart = new Date(start + i * 7 * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);
    const weekInBlock = i % mesocycleLength;
    const intent = resolveWeekIntent({
      weekStartISODate: weekStart,
      mesocycle: blockTemplate,
      weekInBlock,
      raceCalendar: input.raceCalendar,
      principles: input.principles,
    });
    weeks.push(intent);
  }

  return {
    blockTemplateName: blockName,
    blockTemplate,
    mesocycleLength,
    weeks,
  };
}

function defaultBlockNameFor(level: 'novice' | 'intermediate' | 'advanced'): string {
  switch (level) {
    case 'novice': return 'accumulation_5wk_novice';
    case 'advanced': return 'accumulation_3wk_advanced';
    case 'intermediate':
    default: return 'accumulation_4wk';
  }
}

function defaultBlockFallback(level: 'novice' | 'intermediate' | 'advanced'): WeekIntentKindEnum[] {
  switch (level) {
    case 'novice':
      return ['accumulation', 'accumulation', 'accumulation', 'accumulation', 'deload'];
    case 'advanced':
      return ['accumulation', 'accumulation', 'deload'];
    case 'intermediate':
    default:
      return ['accumulation', 'accumulation', 'accumulation', 'deload'];
  }
}
