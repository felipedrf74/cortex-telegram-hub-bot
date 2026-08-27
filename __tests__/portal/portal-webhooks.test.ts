import { describe, expect, it } from 'vitest';
import {
  extractEventType,
  extractIdempotencyKey,
  flattenHeaders,
} from '../../src/portal/webhooks';

describe('portal webhook helpers', () => {
  it('extracts provider-specific event types', () => {
    expect(extractEventType('google_gmail', { 'x-goog-resource-state': 'exists' }, {})).toBe('exists');
    expect(extractEventType('outlook_mail', {}, { changeType: 'created' })).toBe('created');
    expect(extractEventType('garmin', {}, { activityType: 'running' })).toBe('running');
    expect(extractEventType('strava', {}, { aspect_type: 'update', object_type: 'activity' })).toBe('update');
    expect(extractEventType('github', { 'x-github-event': 'pull_request' }, {})).toBe('pull_request');
    expect(extractEventType('unknown_provider', {}, { type: 'custom' })).toBe('custom');
    expect(extractEventType('unknown_provider', {}, {})).toBe('unknown');
  });

  it('extracts provider-specific idempotency keys', () => {
    expect(extractIdempotencyKey('google_calendar', { 'x-goog-message-number': '42' }, {})).toBe('42');
    const outlookKey = extractIdempotencyKey('outlook_calendar', {}, {
      subscriptionId: 'sub-1', resource: '/events/one', changeType: 'updated',
    });
    expect(outlookKey).toMatch(/^outlook:[a-f0-9]{64}$/u);
    expect(extractIdempotencyKey('outlook_calendar', {}, {
      changeType: 'updated', resource: '/events/one', subscriptionId: 'sub-1',
    })).toBe(outlookKey);
    expect(extractIdempotencyKey('github', { 'x-github-delivery': 'delivery-1' }, {})).toBe('delivery-1');
    const stravaKey = extractIdempotencyKey('strava', {}, { event_time: 123, object_id: 1 });
    expect(stravaKey).toMatch(/^strava:[a-f0-9]{64}$/u);
    expect(extractIdempotencyKey('strava', {}, { event_time: 123, object_id: 2 }))
      .not.toBe(stravaKey);
    expect(extractIdempotencyKey('unknown_provider', {}, { id: 456 })).toBe('456');
    expect(extractIdempotencyKey('unknown_provider', {}, {})).toBeUndefined();
  });

  it('flattens single and repeated headers for persistence', () => {
    expect(flattenHeaders({
      'x-github-event': 'push',
      'x-github-delivery': ['delivery-a', 'delivery-b'],
      'x-empty': undefined,
      'x-private-provider-header': 'must-not-persist',
      authorization: 'Bearer must-not-persist',
      'x-goog-channel-token': 'must-not-persist',
      'x-hub-signature-256': 'must-not-persist',
      'x-api-key': 'must-not-persist',
      'x-custom-session-secret': 'must-not-persist',
    })).toEqual({
      'x-github-event': 'push',
      'x-github-delivery': 'delivery-a, delivery-b',
    });
  });
});
