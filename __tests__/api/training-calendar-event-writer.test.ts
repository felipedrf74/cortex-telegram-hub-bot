import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createEvent: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock('../../src/services/unified-calendar', () => ({
  createEvent: mocks.createEvent,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    warn: mocks.loggerWarn,
  },
  LOGGER_REDACTION_PATHS: [],
}));

import { createTrainingCalendarEvent } from '../../src/api/routes/training-calendar-event-writer';
import { TrainingOperationDisabledError } from '../../src/services/training-operational-switches';

function resetTrainingOperationalEnvForTests(): void {
  delete process.env.TRAINING_ENGINE_ENABLED;
  delete process.env.TRAINING_ENGINE_DISABLED;
  delete process.env.TRAINING_CALENDAR_WRITES_ENABLED;
  delete process.env.TRAINING_CALENDAR_WRITES_DISABLED;
  delete process.env.TRAINING_CALENDAR_SYNC_ENABLED;
  delete process.env.TRAINING_CALENDAR_SYNC_DISABLED;
  delete process.env.TRAINING_CALENDAR_OUTLOOK_ENABLED;
  delete process.env.TRAINING_CALENDAR_OUTLOOK_DISABLED;
}

describe('training-calendar-event-writer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTrainingOperationalEnvForTests();
    mocks.createEvent.mockResolvedValue({ id: 'evt-1', source: 'google' });
  });

  it('creates events when calendar writes are enabled', async () => {
    const event = await createTrainingCalendarEvent(
      {
        title: 'Training',
        start: '2026-04-28T07:00:00.000Z',
        end: '2026-04-28T07:45:00.000Z',
      },
      'google',
      42,
      { userId: 42, tenantId: 42, sessionId: 7, title: 'Training' },
    );

    expect(event).toEqual({ id: 'evt-1', source: 'google' });
    expect(mocks.createEvent).toHaveBeenCalledTimes(1);
  });

  it('blocks provider writes when the calendar write kill switch is disabled', async () => {
    process.env.TRAINING_CALENDAR_WRITES_ENABLED = 'false';

    await expect(createTrainingCalendarEvent(
      {
        title: 'Training',
        start: '2026-04-28T07:00:00.000Z',
        end: '2026-04-28T07:45:00.000Z',
      },
      'google',
      42,
      { userId: 42, tenantId: 42, sessionId: 7, title: 'Training' },
    )).rejects.toBeInstanceOf(TrainingOperationDisabledError);

    expect(mocks.createEvent).not.toHaveBeenCalled();
  });

  // 2026-05-25 fix — Outlook is now ON by default. Pre-fix Outlook was
  // gated behind TRAINING_CALENDAR_OUTLOOK_ENABLED=true. The kill switch
  // TRAINING_CALENDAR_OUTLOOK_DISABLED=1 still works for emergency
  // rollback.

  it('R-2026-05-25 — allows Outlook provider writes by default (no env opt-in needed)', async () => {
    const event = await createTrainingCalendarEvent(
      {
        title: 'Training',
        start: '2026-04-28T12:00:00.000Z',
        end: '2026-04-28T12:45:00.000Z',
      },
      'outlook',
      42,
      { userId: 42, tenantId: 42, sessionId: 8, title: 'Training' },
    );

    expect(event).toEqual({ id: 'evt-1', source: 'google' });
    expect(mocks.createEvent).toHaveBeenCalledWith(
      expect.any(Object),
      'outlook',
      42,
      expect.objectContaining({ tenantId: 42 }),
    );
  });

  it('R-2026-05-25 — blocks Outlook provider writes when the kill switch is set', async () => {
    process.env.TRAINING_CALENDAR_OUTLOOK_DISABLED = '1';
    await expect(createTrainingCalendarEvent(
      {
        title: 'Training',
        start: '2026-04-28T12:00:00.000Z',
        end: '2026-04-28T12:45:00.000Z',
      },
      'outlook',
      42,
      { userId: 42, tenantId: 42, sessionId: 8, title: 'Training' },
    )).rejects.toBeInstanceOf(TrainingOperationDisabledError);

    expect(mocks.createEvent).not.toHaveBeenCalled();
  });

  it('R-2026-05-25 — auto-target Training writes pass through `undefined` provider (lets unified-calendar pick) when Outlook is enabled', async () => {
    // Pre-fix: with Outlook gated, the writer FORCED google as the
    // effective target. With Outlook default-on, auto means auto — the
    // resolver leaves the choice to unified-calendar.createEvent's
    // own provider selection. The mock returns google as the actual
    // resolution, mirroring real behavior when only google is
    // configured for the user.
    const event = await createTrainingCalendarEvent(
      {
        title: 'Training',
        start: '2026-04-28T07:00:00.000Z',
        end: '2026-04-28T07:45:00.000Z',
      },
      undefined,
      42,
      { userId: 42, tenantId: 42, sessionId: 7, title: 'Training' },
    );

    expect(event).toEqual({ id: 'evt-1', source: 'google' });
    expect(mocks.createEvent).toHaveBeenCalledWith(
      expect.any(Object),
      undefined,
      42,
      expect.objectContaining({ tenantId: 42 }),
    );
  });

  it('R-2026-05-25 — auto-target falls back to forced Google when Outlook kill switch is set', async () => {
    process.env.TRAINING_CALENDAR_OUTLOOK_DISABLED = '1';
    const event = await createTrainingCalendarEvent(
      {
        title: 'Training',
        start: '2026-04-28T07:00:00.000Z',
        end: '2026-04-28T07:45:00.000Z',
      },
      undefined,
      42,
      { userId: 42, tenantId: 42, sessionId: 7, title: 'Training' },
    );

    expect(event).toEqual({ id: 'evt-1', source: 'google' });
    expect(mocks.createEvent).toHaveBeenCalledWith(
      expect.any(Object),
      'google',
      42,
      expect.objectContaining({ tenantId: 42 }),
    );
  });

  it('retries sanitized Google rate-limit errors before returning the event', async () => {
    const rateLimitError = Object.assign(new Error('Calendar write throttled'), {
      name: 'GoogleCalendarApiError',
      status: 403,
      code: 403,
      reason: 'userRateLimitExceeded',
      errors: [{ reason: 'userRateLimitExceeded', message: 'Rate Limit Exceeded' }],
    });
    mocks.createEvent
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce({ id: 'evt-after-retry', source: 'google' });

    const event = await createTrainingCalendarEvent(
      {
        title: 'Training',
        start: '2026-04-28T07:00:00.000Z',
        end: '2026-04-28T07:45:00.000Z',
      },
      'google',
      42,
      { userId: 42, tenantId: 42, sessionId: 7, title: 'Training' },
    );

    expect(event).toEqual({ id: 'evt-after-retry', source: 'google' });
    expect(mocks.createEvent).toHaveBeenCalledTimes(2);
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1, sessionId: 7 }),
      'Training calendar write rate-limited - retrying',
    );
  });

  it('retries Microsoft Graph TooManyRequests shapes even when numeric status is absent', async () => {
    process.env.TRAINING_CALENDAR_OUTLOOK_ENABLED = 'true';
    const graphThrottle = Object.assign(new Error('Graph calendar throttled'), {
      code: 'TooManyRequests',
      headers: { 'Retry-After': '1' },
    });
    mocks.createEvent
      .mockRejectedValueOnce(graphThrottle)
      .mockResolvedValueOnce({ id: 'evt-after-graph-retry', source: 'outlook' });

    const event = await createTrainingCalendarEvent(
      {
        title: 'Training',
        start: '2026-04-28T12:00:00.000Z',
        end: '2026-04-28T12:45:00.000Z',
      },
      'outlook',
      42,
      { userId: 42, tenantId: 42, sessionId: 8, title: 'Training' },
    );

    expect(event).toEqual({ id: 'evt-after-graph-retry', source: 'outlook' });
    expect(mocks.createEvent).toHaveBeenCalledTimes(2);
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1, sessionId: 8 }),
      'Training calendar write rate-limited - retrying',
    );
  });
});
