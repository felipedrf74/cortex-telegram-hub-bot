// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import http from 'node:http';
import express, { Router } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
  review: vi.fn(),
  select: vi.fn(),
  get: vi.fn(),
}));

vi.mock('../../src/services/training-adaptation-proposals', () => ({
  previewTrainingAdaptation: mocks.preview,
  requestTrainingAdaptationReview: mocks.review,
  selectTrainingAdaptationOption: mocks.select,
  getTrainingAdaptationOptionEnvelope: mocks.get,
}));

import { registerTrainingAdaptationRoutes } from '../../src/api/routes/training-adaptation-routes';

describe('Training adaptation iOS wire contract', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    mocks.preview.mockReset().mockReturnValue({
      schemaVersion: 'training_adaptation_api.v1', mode: 'active',
      preview: {
        proposalSetId: 'adaptation-1', eventId: 'event-1', trigger: 'BUSY_DAY',
        currentRevision: { revisionId: 'revision-1' }, target: { workoutKey: 'week-1-monday' },
        options: [], suppressedOptions: [], createdAt: '2026-07-13T00:00:00.000Z',
        expiresAt: '2026-07-13T00:30:00.000Z',
      },
    });
    mocks.review.mockReset().mockResolvedValue({
      schemaVersion: 'training_adaptation_api.v1', adaptationId: 'adaptation-1',
      optionId: 'option-1', decisionId: 'decision-1', status: 'PENDING_REVIEW',
    });
    mocks.select.mockReset().mockReturnValue({
      schemaVersion: 'training_adaptation_api.v1', adaptationId: 'adaptation-1',
      optionId: 'keep-option', decisionId: null, status: 'KEPT_ORIGINAL',
    });
    mocks.get.mockReset().mockReturnValue({
      schemaVersion: 'training_adaptation_api.v1', mode: 'active', option: { optionId: 'option-1' },
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).userId = 7;
      (req as any).tenantId = 7;
      next();
    });
    const router = Router();
    registerTrainingAdaptationRoutes(router);
    app.use('/api/v1/training', router);
    server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server unavailable');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it('accepts the exact iOS preview fields and binds the Idempotency-Key to the event', async () => {
    const response = await fetch(`${baseUrl}/api/v1/training/adaptations/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'training-adaptation:event-1' },
      body: JSON.stringify({
        schemaVersion: 'training-adaptation-preview.v1', eventId: 'event-1',
        currentRevisionId: 'revision-1', expectedContentHash: 'a'.repeat(64),
        contextVersion: 'context-1', trigger: 'BUSY_DAY', requestedScope: 'SESSION',
        target: { workoutKey: 'week-1-monday', sessionId: 'session-1' },
        input: { availableMinutes: 20 },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      data: { schemaVersion: 'training_adaptation_api.v1', mode: 'active', preview: { eventId: 'event-1' } },
    });
    expect(mocks.preview).toHaveBeenCalledWith(expect.objectContaining({
      scope: { userId: 7, tenantId: 7 }, eventId: 'event-1',
      idempotencyKey: 'training-adaptation:event-1', adaptationScope: 'SESSION',
      target: { workoutKey: 'week-1-monday', sessionId: 'session-1' },
      explicitInput: { kind: 'BUSY_DAY', availableMinutes: 20 },
    }));
  });

  it('maps iOS tired and substitution values without accepting body-supplied identity', async () => {
    await fetch(`${baseUrl}/api/v1/training/adaptations/preview`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'training-adaptation:tired-1' },
      body: JSON.stringify({
        eventId: 'tired-1', currentRevisionId: 'revision-1', expectedContentHash: 'a'.repeat(64),
        contextVersion: 'context-1', trigger: 'TIRED_DAY', requestedScope: 'SESSION',
        target: { workoutKey: 'w1' }, input: {
          tirednessLevel: 'VERY_TIRED', availableEquipmentIds: ['bodyweight'],
          exclusions: ['back_squat'], rescheduleDay: 'friday', authoritativeScheduleVersion: 'schedule-v2',
        },
        userId: 999, tenantId: 999,
      }),
    });
    expect(mocks.preview).toHaveBeenLastCalledWith(expect.objectContaining({
      scope: { userId: 7, tenantId: 7 },
      explicitInput: {
        kind: 'TIRED_DAY', selfReport: 'MORE_TIRED_THAN_EXPECTED', reportedLevel: 'VERY_TIRED',
        availableEquipmentIds: ['bodyweight'], exclusions: ['back_squat'],
        rescheduleDay: 'friday', authoritativeScheduleVersion: 'schedule-v2',
      },
    }));

    await fetch(`${baseUrl}/api/v1/training/adaptations/preview`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'training-adaptation:sub-1' },
      body: JSON.stringify({
        eventId: 'sub-1', currentRevisionId: 'revision-1', expectedContentHash: 'a'.repeat(64),
        contextVersion: 'context-1', trigger: 'EXERCISE_SUBSTITUTION', requestedScope: 'SESSION',
        target: { workoutKey: 'w1', blockId: 'primary', exerciseId: 'dumbbell_floor_press' },
        input: {
          originalExerciseId: 'dumbbell_floor_press', substitutionReason: 'EQUIPMENT_UNAVAILABLE',
          unavailableEquipmentIds: ['dumbbells'], exclusionIds: [],
        },
      }),
    });
    expect(mocks.preview).toHaveBeenLastCalledWith(expect.objectContaining({
      explicitInput: {
        kind: 'SUBSTITUTION', reason: 'EQUIPMENT', originalExerciseId: 'dumbbell_floor_press',
        unavailableEquipmentIds: ['dumbbells'], exclusions: [], proposedExerciseId: undefined,
      },
    }));
  });

  it('passes optional busy window fields through and rejects malformed optional input', async () => {
    const valid = await fetch(`${baseUrl}/api/v1/training/adaptations/preview`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'training-adaptation:busy-optional' },
      body: JSON.stringify({
        eventId: 'busy-optional', currentRevisionId: 'revision-1', expectedContentHash: 'a'.repeat(64),
        contextVersion: 'context-1', trigger: 'BUSY_DAY', requestedScope: 'SESSION',
        target: { workoutKey: 'w1' }, input: {
          availableMinutes: 20, secondWindowMinutes: 15, secondWindowGapMinutes: 90,
          rescheduleDay: 'saturday', authoritativeScheduleVersion: 'schedule-v3',
        },
      }),
    });
    expect(valid.status).toBe(200);
    expect(mocks.preview).toHaveBeenLastCalledWith(expect.objectContaining({
      explicitInput: {
        kind: 'BUSY_DAY', availableMinutes: 20, secondWindowMinutes: 15,
        secondWindowGapMinutes: 90, rescheduleDay: 'saturday', authoritativeScheduleVersion: 'schedule-v3',
      },
    }));

    const malformed = await fetch(`${baseUrl}/api/v1/training/adaptations/preview`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'training-adaptation:bad-optional' },
      body: JSON.stringify({
        eventId: 'bad-optional', currentRevisionId: 'revision-1', expectedContentHash: 'a'.repeat(64),
        contextVersion: 'context-1', trigger: 'TIRED_DAY', requestedScope: 'SESSION',
        target: { workoutKey: 'w1' }, input: { tirednessLevel: 'SLIGHTLY', exclusions: 'not-an-array' },
      }),
    });
    expect(malformed.status).toBe(400);
    expect(mocks.preview).not.toHaveBeenCalledWith(expect.objectContaining({ eventId: 'bad-optional' }));
  });

  it('uses the focused review endpoint/key and returns only the selected Decision binding', async () => {
    const response = await fetch(`${baseUrl}/api/v1/training/adaptations/adaptation-1/request-review`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'training-adaptation-review:event-1:option-1',
      },
      body: JSON.stringify({
        optionId: 'option-1', expectedCurrentRevisionId: 'revision-1',
        expectedContextVersion: 'context-1',
      }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      data: {
        schemaVersion: 'training_adaptation_api.v1', adaptationId: 'adaptation-1',
        optionId: 'option-1', decisionId: 'decision-1', status: 'PENDING_REVIEW',
      },
    });
    expect(mocks.review).toHaveBeenCalledWith({
      scope: { userId: 7, tenantId: 7 }, adaptationId: 'adaptation-1', optionId: 'option-1',
      expectedCurrentRevisionId: 'revision-1', expectedContextVersion: 'context-1',
      idempotencyKey: 'training-adaptation-review:event-1:option-1',
    });
  });

  it('records keep-original through the no-change selection endpoint without a Decision', async () => {
    const response = await fetch(`${baseUrl}/api/v1/training/adaptations/adaptation-1/select-option`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'training-adaptation-selection:event-1:keep-option',
      },
      body: JSON.stringify({
        optionId: 'keep-option', expectedCurrentRevisionId: 'revision-1', expectedContextVersion: 'context-1',
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { adaptationId: 'adaptation-1', optionId: 'keep-option', decisionId: null, status: 'KEPT_ORIGINAL' },
    });
    expect(mocks.select).toHaveBeenCalledWith({
      scope: { userId: 7, tenantId: 7 }, adaptationId: 'adaptation-1', optionId: 'keep-option',
      expectedCurrentRevisionId: 'revision-1', expectedContextVersion: 'context-1',
      idempotencyKey: 'training-adaptation-selection:event-1:keep-option',
    });
  });

  it('returns the iOS adaptation envelope for a scoped GET', async () => {
    const response = await fetch(`${baseUrl}/api/v1/training/adaptations/adaptation-1`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { schemaVersion: 'training_adaptation_api.v1', mode: 'active', option: { optionId: 'option-1' } },
    });
    expect(mocks.get).toHaveBeenCalledWith({ userId: 7, tenantId: 7 }, 'adaptation-1');
  });
});
