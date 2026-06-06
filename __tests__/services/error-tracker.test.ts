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

vi.mock('../../src/utils/logger', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/logger')>('../../src/utils/logger');
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
    LOGGER_REDACTION_PATHS: [],
  };
});

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

    it('redacts sensitive extra context before forwarding to Sentry scope', async () => {
      const SentryMock = await import('@sentry/node');
      errorTracker.init({ dsn: 'https://abc@sentry.io/123', environment: 'test' });

      errorTracker.captureException(new Error('boom'), {
        extra: {
          request: {
            headers: {
              authorization: 'Bearer super-secret-token',
              cookie: 'session=private-cookie',
            },
            data: {
              prompt: 'private prompt',
              safe: 'ok',
            },
          },
        },
      });

      const scope = (SentryMock.withScope as any).mock.results[0].value;
      const [extraKey, extraPayload] = (scope.setExtra as any).mock.calls[0];
      expect(extraKey).toBe('request');
      expect(JSON.stringify(extraPayload)).not.toContain('super-secret-token');
      expect(JSON.stringify(extraPayload)).not.toContain('private-cookie');
      expect(JSON.stringify(extraPayload)).not.toContain('private prompt');
      expect(extraPayload.headers.authorization).toBe('[Redacted]');
      expect(extraPayload.headers.cookie).toBe('[Redacted]');
      expect(extraPayload.data.prompt).toBe('[Redacted]');
      expect(extraPayload.data.safe).toBe('ok');
    });
  });

  describe('sanitizeSentryEvent()', () => {
    it('redacts request headers, body, contexts, extra, and user ip from Sentry events', async () => {
      const event = errorTracker.sanitizeSentryEvent({
        user: { id: 'user-1', ip_address: '203.0.113.10' },
        request: {
          headers: {
            Authorization: 'Bearer event-secret-token',
            'X-API-Key': 'sk-proj-private',
          },
          data: {
            refreshToken: 'refresh-private',
            field: 'safe',
          },
        },
        contexts: {
          auth: { cookie: 'session=private' },
        },
        extra: {
          providerResponse: 'raw-provider-body',
          retryAttempt: 1,
        },
      } as any);

      const payload = JSON.stringify(event);
      expect(payload).not.toContain('203.0.113.10');
      expect(payload).not.toContain('event-secret-token');
      expect(payload).not.toContain('sk-proj-private');
      expect(payload).not.toContain('refresh-private');
      expect(payload).not.toContain('session=private');
      expect(payload).not.toContain('raw-provider-body');
      expect((event.user as any).ip_address).toBeUndefined();
      expect((event.request as any).headers.Authorization).toBe('[Redacted]');
      expect((event.request as any).data.refreshToken).toBe('[Redacted]');
      expect((event.extra as any).retryAttempt).toBe(1);
    });

    it('redacts privacy-sensitive app domains before Sentry export', async () => {
      const event = errorTracker.sanitizeSentryEvent({
        request: {
          data: {
            email: 'felipe@example.com',
            eventTitle: 'Private medical appointment',
            health: { hrv: 42, sleep: '4h 20m' },
            finance: { amount: 1234, merchant: 'Private Vendor' },
            providerError: 'Google API 503 contained raw calendar text',
            safeStatus: 'degraded',
          },
        },
        extra: {
          calendarText: 'Focus block with private invitee',
          bodyBattery: 12,
          retryable: true,
        },
      } as any);

      const payload = JSON.stringify(event);
      for (const leaked of [
        'felipe@example.com',
        'Private medical appointment',
        '4h 20m',
        'Private Vendor',
        'Google API 503',
        'Focus block with private invitee',
      ]) {
        expect(payload).not.toContain(leaked);
      }
      expect((event.request as any).data.email).toBe('[Redacted]');
      expect((event.request as any).data.eventTitle).toBe('[Redacted]');
      expect((event.request as any).data.health).toBe('[Redacted]');
      expect((event.request as any).data.finance).toBe('[Redacted]');
      expect((event.extra as any).calendarText).toBe('[Redacted]');
      expect((event.extra as any).retryable).toBe(true);
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
