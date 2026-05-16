// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Training-skill helpers: slot extraction, validation, and step construction
// for `training_plan_create`. Extracted from chat-action-planner.ts on
// 2026-05-15 (planner-split, audit implementation plan Phase 0).
//
// These helpers are used by both the per-skill training parser AND by the
// planner's pending-action continuation flow + action_run execution path.
// They live in their own module so all callers (planner + per-skill parser)
// import from the same source of truth.

import { DateTime } from 'luxon';

import { foldCalendarText } from '../../calendar-natural-language-parser';
import { makeSlotProvenance, type ChatSlotProvenance } from '../../chat-action-state';
import { makeStep, type StepKeyInputs } from '../step-builder';
import type { ChatPlanStep } from '../../chat-action-planner';

export const TRAINING_PLAN_REQUIRED_SLOTS = ['sport', 'goal', 'durationWeeks', 'startDate', 'weeklyVolumeKm'] as const;

export interface TrainingPlanStepInput extends StepKeyInputs {
  text: string;
  messageId: string;
  nowIso?: string;
  timezone: string;
}

export function makeTrainingPlanStep(
  input: StepKeyInputs,
  slots: Record<string, unknown>,
  missing: string[],
  slotProvenance: Record<string, ChatSlotProvenance>,
): ChatPlanStep {
  return makeStep(input, {
    skill: 'training',
    action: 'training_plan_create',
    risk: 'safe_write',
    provider: 'nexus',
    args: {
      sport: slots.sport ?? null,
      goal: slots.goal ?? null,
      durationWeeks: slots.durationWeeks ?? null,
      startDate: slots.startDate ?? null,
      weeklyVolumeKm: slots.weeklyVolumeKm ?? null,
      constraints: Array.isArray(slots.constraints) ? slots.constraints : [],
    },
    slotProvenance,
    requiredArgsPresent: missing.length === 0,
  });
}

export function extractTrainingPlanSlots(input: TrainingPlanStepInput): {
  slots: Record<string, unknown>;
  provenance: Record<string, ChatSlotProvenance>;
} {
  const text = input.text;
  const folded = foldCalendarText(text);
  const slots: Record<string, unknown> = {};
  const provenance: Record<string, ChatSlotProvenance> = {};
  const weeklyVolume = extractWeeklyVolumeKm(text);
  if (weeklyVolume != null) {
    slots.weeklyVolumeKm = weeklyVolume;
    provenance.weeklyVolumeKm = makeSlotProvenance({
      slot: 'weeklyVolumeKm',
      value: weeklyVolume,
      rawText: text,
      turnId: input.messageId,
      sourceType: 'user_message',
      normalizer: 'training_weekly_volume_v1',
      confidence: 0.96,
    });
  }

  const sportMatch = folded.match(/\b(running|run|corrida|cycling|ciclismo|bike|swim|swimming|natacao|natação|triathlon|triathlon|gym|ginasio|ginásio|strength|forca|força)\b/);
  if (sportMatch) {
    const sport = normalizeTrainingSport(sportMatch[1]);
    slots.sport = sport;
    provenance.sport = makeSlotProvenance({
      slot: 'sport',
      value: sport,
      rawText: sportMatch[0],
      turnId: input.messageId,
      spanStart: sportMatch.index ?? null,
      spanEnd: sportMatch.index != null ? sportMatch.index + sportMatch[0].length : null,
      sourceType: 'user_message',
      normalizer: 'training_sport_v1',
      confidence: 0.9,
    });
  }

  const durationMatch = text.match(/\b(\d{1,2})\s*(?:weeks?|semanas?)\b/i);
  if (durationMatch) {
    const weeks = Number(durationMatch[1]);
    if (Number.isInteger(weeks) && weeks > 0 && weeks <= 52) {
      slots.durationWeeks = weeks;
      provenance.durationWeeks = makeSlotProvenance({
        slot: 'durationWeeks',
        value: weeks,
        rawText: durationMatch[0],
        turnId: input.messageId,
        spanStart: durationMatch.index ?? null,
        spanEnd: durationMatch.index != null ? durationMatch.index + durationMatch[0].length : null,
        sourceType: 'user_message',
        normalizer: 'training_duration_weeks_v1',
        confidence: 0.95,
      });
    }
  }

  const start = extractTrainingStartDate(input);
  if (start) {
    slots.startDate = start.value;
    provenance.startDate = start.provenance;
  }

  const goalMatch = text.match(/\b(?:goal is|goal|objetivo(?:\s+é)?|para|to)\s+(.+?)(?=$|\.|,|\s+\b(?:in|em|for|por)\s+\d{1,2}\s*(?:weeks?|semanas?)\b)/i);
  const goal = cleanupTrainingGoal(goalMatch?.[1] ?? inferTrainingGoalFromText(text));
  if (goal) {
    slots.goal = goal;
    provenance.goal = makeSlotProvenance({
      slot: 'goal',
      value: goal,
      rawText: goalMatch?.[1] ?? goal,
      turnId: input.messageId,
      spanStart: goalMatch?.index ?? null,
      spanEnd: goalMatch?.index != null ? goalMatch.index + goalMatch[0].length : null,
      sourceType: 'user_message',
      normalizer: 'training_goal_v1',
      confidence: goalMatch ? 0.86 : 0.72,
    });
  }

  return { slots, provenance };
}

export function missingTrainingPlanSlots(slots: Record<string, unknown>): string[] {
  return TRAINING_PLAN_REQUIRED_SLOTS.filter((slot) => slots[slot] == null || slots[slot] === '');
}

export function extractWeeklyVolumeKm(text: string): number | null {
  const match = text.match(/\b(\d+(?:[.,]\d+)?)\s*(?:km|kilometers?|quil[oó]metros?)\b(?:\s*(?:a|per|por)\s*(?:week|semana))?/i);
  if (!match || !/\b(week|semana)\b/i.test(text)) return null;
  const value = Number(match[1].replace(',', '.'));
  return Number.isFinite(value) && value >= 0 && value <= 500 ? value : null;
}

export function extractTrainingStartDate(input: TrainingPlanStepInput): { value: string; provenance: ChatSlotProvenance } | null {
  const now = DateTime.fromISO(input.nowIso ?? new Date().toISOString()).setZone(input.timezone);
  const match = input.text.match(/\b(?:start(?:ing)?|começar|inicio|início)\s+(today|tomorrow|hoje|amanh[ãa]|next week|pr[oó]xima semana)\b/i);
  if (!match) return null;
  const folded = foldCalendarText(match[1]);
  const date = folded === 'tomorrow' || folded === 'amanha'
    ? now.plus({ days: 1 })
    : folded.includes('next week') || folded.includes('proxima semana')
      ? now.plus({ weeks: 1 }).startOf('week')
      : now;
  const value = date.toISODate();
  if (!value) return null;
  return {
    value,
    provenance: makeSlotProvenance({
      slot: 'startDate',
      value,
      rawText: match[0],
      turnId: input.messageId,
      spanStart: match.index ?? null,
      spanEnd: match.index != null ? match.index + match[0].length : null,
      sourceType: 'user_message',
      normalizer: 'training_start_date_v1',
      confidence: 0.9,
    }),
  };
}

export function normalizeTrainingSport(raw: string): string {
  const folded = foldCalendarText(raw);
  if (/\b(run|running|corrida)\b/.test(folded)) return 'running';
  if (/\b(cycling|ciclismo|bike)\b/.test(folded)) return 'cycling';
  if (/\b(swim|swimming|natacao)\b/.test(folded)) return 'swimming';
  if (/\b(triathlon)\b/.test(folded)) return 'triathlon';
  if (/\b(gym|ginasio|strength|forca)\b/.test(folded)) return 'strength';
  return folded;
}

export function inferTrainingGoalFromText(text: string): string | null {
  const match = text.match(/\b(sub[-\s]?\d+\s*(?:minute|min)?\s*5k|5k|10k|marathon|meia maratona|half marathon|triathlon|ironman|build general fitness|general fitness)\b/i);
  return match?.[0] ?? null;
}

export function cleanupTrainingGoal(goal: string | null | undefined): string | null {
  if (!goal) return null;
  const cleaned = goal.replace(/[.?!]+$/g, '').trim();
  return cleaned.length >= 2 ? cleaned : null;
}
