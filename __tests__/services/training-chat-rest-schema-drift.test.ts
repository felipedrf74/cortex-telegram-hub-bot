// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * F26 (Phase 3) — chat-builder vs REST creation-schema drift pin.
 *
 * The chat slot vocabulary and the REST /plan/generate schema share ONLY
 * `durationWeeks`. Converging them is a chat-behaviour change that must ship
 * as its own canary slice updating every mirror (registry requiredFields,
 * planner tiers, EN/PT clarification copy, response cards) in one change —
 * see docs/engineering/training-plan-request-semantics.md §3.
 *
 * This test PINS the current state of both sides so the drift cannot grow
 * silently: if either vocabulary changes, this fails and routes the editor
 * to the contract. Updating the pin without updating the contract (or vice
 * versa) is the defect this test exists to catch.
 */

import { describe, expect, it } from 'vitest';
import { TRAINING_PLAN_REQUIRED_SLOTS } from '../../src/services/skills/training/helpers';
import { findChatActionDefinition } from '../../src/services/chat/registry';

describe('training chat/REST creation-schema drift pin (F26)', () => {
  const PINNED_CHAT_SLOTS = ['sport', 'goal', 'durationWeeks', 'startDate', 'weeklyVolumeKm'];

  it('pins the chat slot vocabulary', () => {
    expect([...TRAINING_PLAN_REQUIRED_SLOTS]).toEqual(PINNED_CHAT_SLOTS);
  });

  it('pins the chat registry mirror to the same vocabulary', () => {
    const definition = findChatActionDefinition('training', 'training_plan_create');
    expect(definition?.requiredFields).toEqual(PINNED_CHAT_SLOTS);
  });

  it('documents the single shared field with the REST schema', () => {
    // REST /plan/generate's creation fields (objective, sessionsPerWeek,
    // startPolicy, modality dials, ...) share only durationWeeks with chat —
    // the REST request has NO startDate (startPolicy derives it). If this
    // overlap grows, the convergence slice has started: update the contract
    // doc and replace this pin with real shared-schema assertions.
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
    const overlap = PINNED_CHAT_SLOTS.filter((slot) => restCreationFields.includes(slot));
    expect(overlap).toEqual(['durationWeeks']);
  });
});
