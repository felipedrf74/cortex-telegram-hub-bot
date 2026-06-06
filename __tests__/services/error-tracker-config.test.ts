// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  withScope: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  flush: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  },
}));

describe('error-tracker production config posture', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('keeps Sentry disabled and emits an operator-visible warning when DSN is empty', async () => {
    const Sentry = await import('@sentry/node');
    const { logger } = await import('../../src/utils/logger');
    const tracker = await import('../../src/services/error-tracker');

    tracker.init({ dsn: '', environment: 'production' });

    expect(Sentry.init).not.toHaveBeenCalled();
    expect(tracker.isEnabled()).toBe(false);
    expect(tracker.getStatus('production')).toEqual({
      enabled: false,
      environment: 'production',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      { environment: 'production' },
      'Sentry: no DSN configured — error tracking disabled',
    );
  });
});
