// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * AI-powered weekly training plan generator.
 *
 * Uses callDomain('triathlon') to generate structured exercise plans
 * based on the user's fitness profile, readiness, and previous performance.
 */

import { callDomain } from './anthropic';
import { logger } from '../utils/logger';
import { withAiBudgetReservation } from './cost-guardrail';

// ── Types ───────────────────────────────────────────────────────────

export interface PlanGenerationInput {
  userId: number;
  goal: string;
  trainingDays: number[];
  sessionDuration: number;
  equipment: string;
  injuries: string[];
  preferredTime: string;
  currentPhase: 'base' | 'build' | 'peak' | 'deload';
  weekNumber: number;
  lastWeekAdherence?: number;
  lastWeekAvgRpe?: number;
  readinessScore?: number;
}

export interface GeneratedExercise {
  name: string;
  sets: number;
  reps: string;
  weight: string;
  restSeconds: number;
  muscleGroup: string;
  equipment: string;
}

export interface GeneratedSession {
  dayOfWeek: number;
  title: string;
  type: string;
  duration: number;
  intensity: string;
  exercises: GeneratedExercise[];
}

export interface GeneratedPlan {
  sessions: GeneratedSession[];
  weekFocus: string;
  notes: string;
}

// ── Prompt Builder ──────────────────────────────────────────────────

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function buildPlanPrompt(input: PlanGenerationInput): string {
  const dayList = input.trainingDays.map(d => DAY_NAMES[d]).join(', ');

  let prompt = `Generate a structured weekly training plan as JSON.

## Athlete Profile
- Goal: ${input.goal}
- Training days: ${dayList}
- Session duration: ${input.sessionDuration} minutes
- Equipment: ${input.equipment}
- Injuries to avoid: ${input.injuries.length > 0 ? input.injuries.join(', ') : 'none'}

## Current Phase
- Mesocycle phase: ${input.currentPhase}
- Week ${input.weekNumber} of 4
${input.currentPhase === 'deload' ? '- DELOAD WEEK: Reduce volume by 40-50%, keep same exercises at lighter weights' : ''}

## Last Week Performance`;

  if (input.lastWeekAdherence != null) prompt += `\n- Adherence: ${input.lastWeekAdherence}%`;
  if (input.lastWeekAvgRpe != null) prompt += `\n- Average RPE: ${input.lastWeekAvgRpe}/10`;
  if (input.readinessScore != null) prompt += `\n- Today's readiness: ${input.readinessScore}/100`;

  prompt += `

## Rules
- Each session must have specific exercises with sets, reps, weight prescription (RPE or % 1RM)
- Include warm-up and cool-down in duration but not in exercise list
- Rest days are NOT listed as sessions
- Progressive overload: increase weight/reps by 2-5% from last week if adherence > 80% and RPE < 8
- If injuries listed, exclude ALL exercises that load that body part
- Equipment constraint is strict — only use exercises possible with listed equipment

## Response Format
Respond ONLY with a JSON object (no markdown, no explanation):
{
  "sessions": [
    {
      "dayOfWeek": 0,
      "title": "Upper Body Push",
      "type": "strength",
      "duration": 60,
      "intensity": "RPE 7-8",
      "exercises": [
        {"name": "Barbell Bench Press", "sets": 4, "reps": "6-8", "weight": "RPE 7", "restSeconds": 120, "muscleGroup": "chest", "equipment": "barbell"}
      ]
    }
  ],
  "weekFocus": "Hypertrophy — Upper/Lower split",
  "notes": "Week 2 progression: +2.5kg on compounds from last week"
}`;

  return prompt;
}

// ── Response Parser ─────────────────────────────────────────────────

export function parsePlanResponse(text: string): GeneratedPlan {
  // Strip markdown fences if present
  let cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  // Try to extract JSON object if there's surrounding text
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) cleaned = jsonMatch[0];

  const parsed = JSON.parse(cleaned);

  // Validate structure
  if (!Array.isArray(parsed.sessions)) {
    throw new Error('AI response missing sessions array');
  }

  for (const session of parsed.sessions) {
    if (typeof session.dayOfWeek !== 'number' || !session.title || !Array.isArray(session.exercises)) {
      throw new Error(`Invalid session structure: ${JSON.stringify(session).slice(0, 100)}`);
    }
  }

  return {
    sessions: parsed.sessions,
    weekFocus: parsed.weekFocus || '',
    notes: parsed.notes || '',
  };
}

// ── Plan Generation ─────────────────────────────────────────────────

export async function generateWeeklyPlan(input: PlanGenerationInput): Promise<GeneratedPlan> {
  const prompt = buildPlanPrompt(input);

  const result = await withAiBudgetReservation({
    userId: input.userId,
    requestSource: 'interactive',
    baseCategory: 'weekly_training_plan_generation',
  }, () => callDomain(
    'triathlon',
    [],
    prompt,
    '',
    4096,
    input.userId,
  ));

  try {
    return parsePlanResponse(result.text);
  } catch (err) {
    logger.error({ err, responseChars: result.text.length }, 'Failed to parse AI-generated plan');
    throw new Error('AI returned an invalid plan structure. Try again or adjust parameters.');
  }
}
