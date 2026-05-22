import { describe, expect, it } from 'vitest';

import {
  GoogleCalendarApiError,
  sanitizeGoogleCalendarErrorForLog,
  toGoogleCalendarApiError,
} from '../../src/services/google-calendar';
import { isProviderEventNotFoundError } from '../../src/services/training-calendar-errors';

describe('google calendar error sanitization', () => {
  it('wraps Google SDK response objects without retaining redaction-hostile body fields', () => {
    const err = new Error('Google calendar request failed') as Error & {
      code?: number;
      response?: {
        status: number;
        statusText: string;
        body: unknown;
        data: {
          error: {
            code: number;
            message: string;
            errors: Array<{ reason: string; message: string }>;
          };
        };
      };
    };
    err.code = 403;
    err.response = {
      status: 403,
      statusText: 'Forbidden',
      body: Object.defineProperty({}, 'data', {
        get: () => ({ secret: 'not copied' }),
      }),
      data: {
        error: {
          code: 403,
          message: 'Calendar usage limits exceeded.',
          errors: [{ reason: 'userRateLimitExceeded', message: 'Rate Limit Exceeded' }],
        },
      },
    };

    const safe = sanitizeGoogleCalendarErrorForLog(err);
    const wrapped = toGoogleCalendarApiError(err);

    expect(safe).toMatchObject({
      message: expect.stringContaining('Calendar usage limits exceeded'),
      status: 403,
      reason: 'userRateLimitExceeded',
      responseStatus: 403,
    });
    expect(JSON.stringify(safe)).not.toContain('not copied');
    expect(wrapped).toBeInstanceOf(GoogleCalendarApiError);
    expect((wrapped as any).response).toBeUndefined();
    expect(wrapped.status).toBe(403);
    expect(wrapped.reason).toBe('userRateLimitExceeded');
  });

  it('preserves not-found signals for cancellation and reconciliation logic', () => {
    const wrapped = toGoogleCalendarApiError({
      code: 404,
      message: 'Not Found',
      response: {
        status: 404,
        data: {
          error: {
            code: 404,
            message: 'Event not found',
            errors: [{ reason: 'notFound', message: 'Event not found' }],
          },
        },
      },
    });

    expect(isProviderEventNotFoundError(wrapped)).toBe(true);
  });

  it('also sanitizes top-level Google error envelopes without response.data.error', () => {
    const safe = sanitizeGoogleCalendarErrorForLog({
      message: 'Request failed',
      error: {
        code: 403,
        message: 'Calendar usage limits exceeded.',
        errors: [{ reason: 'rateLimitExceeded', message: 'Rate Limit Exceeded' }],
      },
    });

    expect(safe).toMatchObject({
      status: 403,
      statusCode: 403,
      reason: 'rateLimitExceeded',
      errors: [{ reason: 'rateLimitExceeded', message: 'Rate Limit Exceeded' }],
    });
  });
});
