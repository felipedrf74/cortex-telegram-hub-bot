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

import { foldCalendarText } from '../../calendar-natural-language-parser';
import { makeSlotProvenance, type ChatSlotProvenance } from '../../chat-action-state';
import { makeStep, type StepKeyInputs } from '../step-builder';
import type { ChatPlanStep } from '../../chat/types';
import {
  classifyTrainingPrescriptionIntent,
  type TrainingPrescriptionModality,
} from './intent-detectors';

export function buildTrainingPlanRequiredSlots() {
  return [
    'objective',
    'durationWeeks',
    'sessionsPerWeek',
    'startPolicy',
  ] as const;
}

export const TRAINING_PLAN_REQUIRED_SLOTS = buildTrainingPlanRequiredSlots();

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
      objective: slots.objective ?? null,
      durationWeeks: slots.durationWeeks ?? null,
      sessionsPerWeek: slots.sessionsPerWeek ?? null,
      startPolicy: slots.startPolicy ?? null,
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

  const sportMatch = folded.match(/\b(running|run|corrida|correr|corre|cycling|ciclismo|bike|swim|swimming|natacao|natação|triathlon|gym|ginasio|ginásio|strength|forca|força)\b/);
  const classification = classifyTrainingPrescriptionIntent(text);
  const sport = sportMatch
    ? normalizeTrainingSport(sportMatch[1])
    : normalizeTrainingSportFromClassifier(classification.modality);

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

  const sessionsPerWeek = extractTrainingSessionsPerWeek(text);
  if (sessionsPerWeek != null) {
    slots.sessionsPerWeek = sessionsPerWeek;
    provenance.sessionsPerWeek = makeSlotProvenance({
      slot: 'sessionsPerWeek',
      value: sessionsPerWeek,
      rawText: text,
      turnId: input.messageId,
      sourceType: 'user_message',
      normalizer: 'training_sessions_per_week_v1',
      confidence: 0.96,
    });
  }

  const startPolicy = extractTrainingStartPolicy(input);
  if (startPolicy) {
    slots.startPolicy = startPolicy.value;
    provenance.startPolicy = startPolicy.provenance;
  }

  const goalMatch = text.match(/\b(?:goal is|goal|objetivo(?:\s+é)?|para|pra|to)\s+(.+?)(?=$|\.|,|\s+\b(?:in|em|en|for|por)\s+\d{1,2}\s*(?:weeks?|semanas?)\b)/i);
  const goal = cleanupTrainingGoal(goalMatch?.[1] ?? inferTrainingGoalFromText(text));
  const objective = goal ?? (sport ? `${sport} training` : null);
  if (objective) {
    slots.objective = objective;
    provenance.objective = makeSlotProvenance({
      slot: 'objective',
      value: objective,
      rawText: goalMatch?.[1] ?? goal,
      turnId: input.messageId,
      spanStart: goalMatch?.index ?? null,
      spanEnd: goalMatch?.index != null ? goalMatch.index + goalMatch[0].length : null,
      sourceType: 'user_message',
      normalizer: goal ? 'training_objective_v1' : 'training_objective_modality_v1',
      confidence: goalMatch ? 0.86 : Math.min(0.86, Math.max(0.7, classification.confidence)),
    });
  }

  return { slots, provenance };
}

export function missingTrainingPlanSlots(slots: Record<string, unknown>): string[] {
  return TRAINING_PLAN_REQUIRED_SLOTS.filter((slot) => slots[slot] == null || slots[slot] === '');
}

export function extractTrainingSessionsPerWeek(text: string): number | null {
  const match = text.match(/\b(\d+)\s*(?:training\s+)?(?:sessions?|workouts?|days?|times|treinos?|sess(?:ion|ions|ões|oes)|sesiones?|vezes)\s*(?:a|per|por|\/)\s*(?:week|semana)\b/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) && value >= 3 && value <= 7 ? value : null;
}

export function extractTrainingStartPolicy(input: TrainingPlanStepInput): { value: 'today' | 'next_full_week'; provenance: ChatSlotProvenance } | null {
  const match = input.text.match(/\b(?:start(?:ing)?|começar|comecar|começando|comecando|inicio|início|comienza(?:ndo)?|empezar)\s+(?:el\s+|na\s+|no\s+)?(today|hoje|next(?:\s+full)?\s+week|pr[oó]xima semana|monday|segunda(?:-feira)?|lunes)\b/i);
  if (!match) return null;
  const folded = foldCalendarText(match[1]);
  const value = folded === 'today' || folded === 'hoje' ? 'today' : 'next_full_week';
  return {
    value,
    provenance: makeSlotProvenance({
      slot: 'startPolicy',
      value,
      rawText: match[0],
      turnId: input.messageId,
      spanStart: match.index ?? null,
      spanEnd: match.index != null ? match.index + match[0].length : null,
      sourceType: 'user_message',
      normalizer: 'training_start_policy_v1',
      confidence: 0.9,
    }),
  };
}

export function normalizeTrainingSport(raw: string): string {
  const folded = foldCalendarText(raw);
  if (/\b(run|running|corrida|correr|corre)\b/.test(folded)) return 'running';
  if (/\b(cycling|ciclismo|bike)\b/.test(folded)) return 'cycling';
  if (/\b(swim|swimming|natacao)\b/.test(folded)) return 'swimming';
  if (/\b(triathlon)\b/.test(folded)) return 'triathlon';
  if (/\b(gym|ginasio|strength|forca)\b/.test(folded)) return 'strength';
  return folded;
}

function normalizeTrainingSportFromClassifier(modality: TrainingPrescriptionModality): string | null {
  if (modality === 'running') return 'running';
  if (modality === 'cycling') return 'cycling';
  if (modality === 'swimming') return 'swimming';
  if (modality === 'triathlon') return 'triathlon';
  if (modality === 'strength') return 'strength';
  return null;
}

export function inferTrainingGoalFromText(text: string): string | null {
  const match = text.match(/\b(sub[-\s]?\d+\s*(?:minute|min)?\s*5k|5\s*km|10\s*km|5k|10k|marathon|meia maratona|half marathon|triathlon|ironman|build general fitness|general fitness)\b/i);
  return match?.[0] ?? null;
}

export function cleanupTrainingGoal(goal: string | null | undefined): string | null {
  if (!goal) return null;
  const cleaned = goal.replace(/[.?!]+$/g, '').trim();
  return cleaned.length >= 2 ? cleaned : null;
}
