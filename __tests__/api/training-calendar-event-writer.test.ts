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
      { userId: 42, sessionId: 7, title: 'Training' },
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
      { userId: 42, sessionId: 7, title: 'Training' },
    )).rejects.toBeInstanceOf(TrainingOperationDisabledError);

    expect(mocks.createEvent).not.toHaveBeenCalled();
  });
});
