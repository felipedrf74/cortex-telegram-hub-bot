import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deleteEvent: vi.fn(),
  loggerDebug: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock('../../src/services/unified-calendar', () => ({
  deleteEvent: mocks.deleteEvent,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    debug: mocks.loggerDebug,
    warn: mocks.loggerWarn,
  },
  LOGGER_REDACTION_PATHS: [],
}));

import { deleteTrainingCalendarEventWithRetry } from '../../src/services/training-calendar-provider-retry';

describe('training-calendar-provider-retry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteEvent.mockResolvedValue(undefined);
  });

  it('treats provider 410 deleted as an idempotent delete success', async () => {
    mocks.deleteEvent.mockRejectedValueOnce(Object.assign(new Error('Resource has been deleted'), {
      status: 410,
      reason: 'deleted',
      errors: [{ reason: 'deleted', message: 'Resource has been deleted' }],
    }));

    await expect(deleteTrainingCalendarEventWithRetry(
      'evt-already-deleted',
      'google',
      42,
      { userId: 42, tenantId: 42, planId: 7, sessionId: 9 },
    )).resolves.toEqual({ deleted: false, alreadyGone: true });

    expect(mocks.deleteEvent).toHaveBeenCalledTimes(1);
    expect(mocks.loggerDebug).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'evt-already-deleted',
        source: 'google',
        planId: 7,
        sessionId: 9,
      }),
      'Training calendar delete skipped because provider event was already gone',
    );
    expect(mocks.loggerWarn).not.toHaveBeenCalled();
  });

  it('reports provider delete success separately from already-gone replay', async () => {
    await expect(deleteTrainingCalendarEventWithRetry(
      'evt-deleted',
      'outlook',
      42,
      { userId: 42, tenantId: 42, planId: 7, sessionId: 9 },
    )).resolves.toEqual({ deleted: true, alreadyGone: false });
  });
});
