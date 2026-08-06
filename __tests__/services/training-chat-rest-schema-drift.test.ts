// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * F26 (Phase 3 canary) — chat-builder/REST creation-schema convergence.
 *
 * The chat handoff intentionally collects the smallest complete REST request
 * core. Every field below is accepted by compatibility `/plan/generate`; the
 * richer modality/race fields remain optional builder refinements. Keep this
 * pin synchronized with the registry, bilingual clarification copy, planner
 * examples, response card, staging smoke, and the canonical semantics doc.
 */

import { describe, expect, it } from 'vitest';
import {
  buildTrainingPlanRequiredSlots,
  TRAINING_PLAN_REQUIRED_SLOTS,
} from '../../src/services/skills/training/helpers';
import { findChatActionDefinition } from '../../src/services/chat/registry';
import { openSurfacePayloadForStep } from '../../src/services/chat/executor/response-cards';

describe('training chat/REST creation-schema drift pin (F26)', () => {
  const CANONICAL_CHAT_CREATION_SLOTS = [
    'objective',
    'durationWeeks',
    'sessionsPerWeek',
    'startPolicy',
  ];

  it('pins the chat slot vocabulary', () => {
    // Stronger guarantee: chat no longer collects aliases or inputs that the
    // generation request silently drops (`weeklyVolumeKm` was the defect).
    expect([...buildTrainingPlanRequiredSlots()]).toEqual(CANONICAL_CHAT_CREATION_SLOTS);
    expect([...TRAINING_PLAN_REQUIRED_SLOTS]).toEqual(CANONICAL_CHAT_CREATION_SLOTS);
  });

  it('pins the chat registry mirror to the same vocabulary', () => {
    const definition = findChatActionDefinition('training', 'training_plan_create');
    expect(definition?.requiredFields).toEqual(CANONICAL_CHAT_CREATION_SLOTS);
  });

  it('requires only fields accepted by the REST creation contract', () => {
    const restCreationFields = [
      'objective',
      'durationWeeks',
      'sessionsPerWeek',
      'runSessionsPerWeek',
      'bikeSessionsPerWeek',
      'swimSessionsPerWeek',
      'strengthSessionsPerWeek',
      'startPolicy',
      'longWorkoutDay',
      'goalMode',
      'raceDate',
      'twoADayPreference',
    ];
    expect(CANONICAL_CHAT_CREATION_SLOTS.every((slot) => restCreationFields.includes(slot))).toBe(true);
    expect(CANONICAL_CHAT_CREATION_SLOTS).not.toContain('weeklyVolumeKm');
  });

  it('hands the same canonical fields to the Training Plan Builder card', () => {
    const payload = openSurfacePayloadForStep({
      action: 'training_plan_create',
      args: {
        objective: '10K',
        durationWeeks: 12,
        sessionsPerWeek: 4,
        startPolicy: 'next_full_week',
      },
    } as any, { pendingActionId: 'pending-1' }, {
      userId: 42,
      tenantId: 42,
    } as any);

    expect(payload).toEqual({
      surface: 'training_plan_builder',
      pendingActionId: 'pending-1',
      prefill: {
        objective: '10K',
        durationWeeks: 12,
        sessionsPerWeek: 4,
        startPolicy: 'next_full_week',
      },
    });
  });
});
