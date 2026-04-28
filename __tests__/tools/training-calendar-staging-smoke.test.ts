// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it, vi } from 'vitest';
import type { CalendarSource, UnifiedCalendarEvent } from '../../src/services/unified-calendar';
import {
  buildSmokeEventPayload,
  evaluateStagingSmokePrerequisites,
  eventBelongsToSmokeRun,
  parseProviders,
  renderSmokeReportMarkdown,
  runTrainingCalendarStagingSmoke,
  type SmokeCalendarClient,
} from '../../src/tools/training-calendar-staging-smoke';

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    STAGING: 'true',
    TRAINING_CALENDAR_STAGING_SMOKE: '1',
    TRAINING_CALENDAR_STAGING_ALLOW_LIVE_WRITES: '1',
    TRAINING_CALENDAR_STAGING_USER_ID: '42',
    OAUTH_ENCRYPTION_KEY: 'test-oauth-key',
    DATABASE_PATH: '/tmp/nexus-staging.db',
    GOOGLE_CLIENT_ID: 'google-client',
    GOOGLE_CLIENT_SECRET: 'google-secret',
    OUTLOOK_CLIENT_ID: 'outlook-client',
    OUTLOOK_CLIENT_SECRET: 'outlook-secret',
    ...overrides,
  };
}

function fakeClient(): SmokeCalendarClient & {
  events: UnifiedCalendarEvent[];
  createCalls: Array<{ target: CalendarSource; title: string }>;
  deleteCalls: Array<{ source: CalendarSource; eventId: string }>;
} {
  const events: UnifiedCalendarEvent[] = [];
  const createCalls: Array<{ target: CalendarSource; title: string }> = [];
  const deleteCalls: Array<{ source: CalendarSource; eventId: string }> = [];
  let seq = 1;
  return {
    events,
    createCalls,
    deleteCalls,
    isConnected: vi.fn(() => true),
    async createEvent(data, target) {
      createCalls.push({ target, title: data.title });
      const event: UnifiedCalendarEvent = {
        id: `${target}-evt-${seq++}`,
        source: target,
        summary: data.title,
        start: data.start,
        end: data.end,
        description: data.description,
      };
      events.push(event);
      return event;
    },
    async updateEvent(data, source) {
      const event = events.find((candidate) => candidate.source === source && candidate.id === data.event_id);
      if (!event) throw new Error(`missing ${source}:${data.event_id}`);
      if (data.new_title) event.summary = data.new_title;
      if (data.new_start) event.start = data.new_start;
      if (data.new_end) event.end = data.new_end;
      return event;
    },
    async deleteEvent(eventId, source) {
      deleteCalls.push({ source, eventId });
      const index = events.findIndex((candidate) => candidate.source === source && candidate.id === eventId);
      if (index >= 0) events.splice(index, 1);
    },
    async getEvents() {
      return [...events];
    },
  };
}

describe('training calendar staging smoke harness', () => {
  it('blocks real writes unless explicit staging guardrails are present', () => {
    const report = evaluateStagingSmokePrerequisites({}, ['google', 'outlook']);

    expect(report.ok).toBe(false);
    expect(report.missing).toContain('STAGING=true or NODE_ENV=staging');
    expect(report.missing).toContain('TRAINING_CALENDAR_STAGING_ALLOW_LIVE_WRITES=1');
    expect(report.missing).toContain('TRAINING_CALENDAR_STAGING_USER_ID=<staging user id>');
  });

  it('parses provider lists defensively', () => {
    expect(parseProviders('google,outlook,google,bogus')).toEqual(['google', 'outlook']);
    expect(parseProviders('bogus')).toEqual(['google', 'outlook']);
  });

  it('marks payloads with run id and Training identity metadata', () => {
    const payload = buildSmokeEventPayload({
      provider: 'google',
      runId: 'run-123',
      planId: 900001,
      planVersion: 2,
      sessionId: 9000012,
      sessionIdentityKey: 'plan:900001|week:1|day:monday|type:gym|slot:1',
      sessionShapeHash: 'shape-a',
      label: 'create v1',
      start: new Date('2026-05-12T09:00:00.000Z'),
      durationMinutes: 35,
    });

    expect(payload.title).toContain('[NEXUS TRAINING STAGING] run-123');
    expect(payload.description).toContain('Run ID: run-123');
    expect(payload.description).toContain('[NEXUS_TRAINING_IDENTITY');
    expect(payload.description).toContain('shape=shape-a');
  });

  it('detects smoke-owned events by title or description', () => {
    expect(eventBelongsToSmokeRun({
      id: 'evt-1',
      source: 'google',
      summary: '[NEXUS TRAINING STAGING] run-abc create',
      start: '2026-05-12T09:00:00.000Z',
      end: '2026-05-12T09:30:00.000Z',
    }, 'run-abc')).toBe(true);
    expect(eventBelongsToSmokeRun({
      id: 'evt-2',
      source: 'outlook',
      summary: 'Different title',
      description: 'Run ID: run-abc',
      start: '2026-05-12T09:00:00.000Z',
      end: '2026-05-12T09:30:00.000Z',
    }, 'run-abc')).toBe(true);
  });

  it('does not fake provider lifecycle success in dry-run mode', async () => {
    const report = await runTrainingCalendarStagingSmoke({
      userId: 42,
      providers: ['google', 'outlook'],
      runId: 'run-dry',
      dryRun: true,
      now: new Date('2026-05-01T08:00:00.000Z'),
      env: env(),
    }, fakeClient());

    expect(report.operations).toEqual([
      expect.objectContaining({ provider: 'google', operation: 'dry_run', status: 'blocked' }),
      expect.objectContaining({ provider: 'outlook', operation: 'dry_run', status: 'blocked' }),
    ]);

    const markdown = renderSmokeReportMarkdown(report);
    expect(markdown).toContain('this was a dry run');
    expect(markdown).not.toContain('All requested provider lifecycle operations passed');
  });

  it('runs lifecycle operations and cleans only exact created event IDs', async () => {
    const client = fakeClient();
    const report = await runTrainingCalendarStagingSmoke({
      userId: 42,
      providers: ['google'],
      runId: 'run-lifecycle',
      dryRun: false,
      now: new Date('2026-05-01T08:00:00.000Z'),
      env: env(),
    }, client);

    expect(report.prerequisites.ok).toBe(true);
    expect(report.providersRun).toEqual(['google']);
    expect(report.operations.filter((operation) => operation.status === 'fail')).toEqual([]);
    expect(report.cleanupFailures).toEqual([]);
    expect(client.events).toEqual([]);
    expect(client.createCalls).toHaveLength(3);
    expect(client.deleteCalls.map((call) => call.eventId)).toEqual([
      'google-evt-1',
      'google-evt-2',
      'google-evt-3',
    ]);
  });

  it('does not fake success when provider OAuth is missing', async () => {
    const client = fakeClient();
    vi.mocked(client.isConnected).mockReturnValue(false);

    const report = await runTrainingCalendarStagingSmoke({
      userId: 42,
      providers: ['outlook'],
      runId: 'run-missing-oauth',
      dryRun: false,
      now: new Date('2026-05-01T08:00:00.000Z'),
      env: env(),
    }, client);

    expect(report.providersRun).toEqual([]);
    expect(report.operations).toContainEqual(expect.objectContaining({
      provider: 'outlook',
      operation: 'provider_connection',
      status: 'blocked',
    }));
    expect(client.createCalls).toHaveLength(0);
  });
});
