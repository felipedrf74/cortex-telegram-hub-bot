/**
 * Error Tracker (Sentry integration) Tests
 *
 * Tests init, captureException, captureMessage, flush, and isEnabled.
 * Sentry SDK is fully mocked — no real API calls.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock @sentry/node before importing the module under test
vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  withScope: vi.fn((cb: (scope: any) => void) => {
    const scope = {
      setLevel: vi.fn(),
      setTag: vi.fn(),
      setExtra: vi.fn(),
    };
    cb(scope);
    return scope;
  }),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  flush: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));

import * as Sentry from '@sentry/node';

// We need to re-import the module fresh for each test suite
// because _initialized is module-level state
let errorTracker: typeof import('../../src/services/error-tracker');

describe('Error Tracker', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset module to clear _initialized state
    vi.resetModules();
    // Re-mock after reset
    vi.doMock('@sentry/node', () => ({
      init: vi.fn(),
      withScope: vi.fn((cb: (scope: any) => void) => {
        const scope = {
          setLevel: vi.fn(),
          setTag: vi.fn(),
          setExtra: vi.fn(),
        };
        cb(scope);
        return scope;
      }),
      captureException: vi.fn(),
      captureMessage: vi.fn(),
      flush: vi.fn().mockResolvedValue(true),
    }));
    vi.doMock('../../src/utils/logger', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
    }));
    errorTracker = await import('../../src/services/error-tracker');
  });

  describe('init()', () => {
    it('initializes Sentry when DSN is provided', async () => {
      const SentryMock = await import('@sentry/node');
      errorTracker.init({
        dsn: 'https://abc@sentry.io/123',
        environment: 'test',
      });

      expect(SentryMock.init).toHaveBeenCalledWith(
        expect.objectContaining({
          dsn: 'https://abc@sentry.io/123',
          environment: 'test',
          attachStacktrace: true,
          maxBreadcrumbs: 30,
        }),
      );
      expect(errorTracker.isEnabled()).toBe(true);
    });

    it('does not initialize when DSN is empty', () => {
      errorTracker.init({
        dsn: '',
        environment: 'test',
      });

      expect(errorTracker.isEnabled()).toBe(false);
    });

    it('is idempotent — second call is a no-op', async () => {
      const SentryMock = await import('@sentry/node');
      errorTracker.init({ dsn: 'https://abc@sentry.io/123', environment: 'test' });
      errorTracker.init({ dsn: 'https://def@sentry.io/456', environment: 'prod' });

      expect(SentryMock.init).toHaveBeenCalledTimes(1);
    });

    it('passes release and tracesSampleRate when provided', async () => {
      const SentryMock = await import('@sentry/node');
      errorTracker.init({
        dsn: 'https://abc@sentry.io/123',
        environment: 'production',
        release: '1.5.0',
        tracesSampleRate: 0.1,
      });

      expect(SentryMock.init).toHaveBeenCalledWith(
        expect.objectContaining({
          release: '1.5.0',
          tracesSampleRate: 0.1,
        }),
      );
    });

    it('defaults tracesSampleRate to 0 when not provided', async () => {
      const SentryMock = await import('@sentry/node');
      errorTracker.init({
        dsn: 'https://abc@sentry.io/123',
        environment: 'test',
      });

      expect(SentryMock.init).toHaveBeenCalledWith(
        expect.objectContaining({
          tracesSampleRate: 0,
        }),
      );
    });
  });

  describe('captureException()', () => {
    it('forwards Error to Sentry with context', async () => {
      const SentryMock = await import('@sentry/node');
      errorTracker.init({ dsn: 'https://abc@sentry.io/123', environment: 'test' });

      const err = new Error('Test failure');
      errorTracker.captureException(err, {
        level: 'error',
        source: 'bot',
        extra: { userId: 42 },
        tags: { domain: 'secretary' },
      });

      expect(SentryMock.withScope).toHaveBeenCalled();
      expect(SentryMock.captureException).toHaveBeenCalledWith(err);
    });

    it('converts string to Error', async () => {
      const SentryMock = await import('@sentry/node');
      errorTracker.init({ dsn: 'https://abc@sentry.io/123', environment: 'test' });

      errorTracker.captureException('string error');

      expect(SentryMock.captureException).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'string error' }),
      );
    });

    it('no-ops when Sentry is not initialized', async () => {
      const SentryMock = await import('@sentry/node');
      // Don't call init()
      errorTracker.captureException(new Error('ignored'));

      expect(SentryMock.withScope).not.toHaveBeenCalled();
    });
  });

  describe('captureMessage()', () => {
    it('sends message with level', async () => {
      const SentryMock = await import('@sentry/node');
      errorTracker.init({ dsn: 'https://abc@sentry.io/123', environment: 'test' });

      errorTracker.captureMessage('Deployment complete', 'info');

      expect(SentryMock.withScope).toHaveBeenCalled();
      expect(SentryMock.captureMessage).toHaveBeenCalledWith('Deployment complete');
    });

    it('no-ops when Sentry is not initialized', async () => {
      const SentryMock = await import('@sentry/node');
      errorTracker.captureMessage('ignored');

      expect(SentryMock.withScope).not.toHaveBeenCalled();
    });
  });

  describe('flush()', () => {
    it('calls Sentry.flush with timeout', async () => {
      const SentryMock = await import('@sentry/node');
      errorTracker.init({ dsn: 'https://abc@sentry.io/123', environment: 'test' });

      await errorTracker.flush(3000);

      expect(SentryMock.flush).toHaveBeenCalledWith(3000);
    });

    it('no-ops when Sentry is not initialized', async () => {
      const SentryMock = await import('@sentry/node');
      await errorTracker.flush();

      expect(SentryMock.flush).not.toHaveBeenCalled();
    });
  });

  describe('isEnabled()', () => {
    it('returns false before init', () => {
      expect(errorTracker.isEnabled()).toBe(false);
    });

    it('returns true after init with valid DSN', () => {
      errorTracker.init({ dsn: 'https://abc@sentry.io/123', environment: 'test' });
      expect(errorTracker.isEnabled()).toBe(true);
    });

    it('returns false after init with empty DSN', () => {
      errorTracker.init({ dsn: '', environment: 'test' });
      expect(errorTracker.isEnabled()).toBe(false);
    });
  });
});
