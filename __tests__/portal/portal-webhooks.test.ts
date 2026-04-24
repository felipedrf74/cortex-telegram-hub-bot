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
    expect(extractIdempotencyKey('outlook_calendar', {}, { subscriptionId: 'sub-1' })).toBe('sub-1');
    expect(extractIdempotencyKey('github', { 'x-github-delivery': 'delivery-1' }, {})).toBe('delivery-1');
    expect(extractIdempotencyKey('strava', {}, { event_time: 123 })).toBe('123');
    expect(extractIdempotencyKey('unknown_provider', {}, { id: 456 })).toBe('456');
    expect(extractIdempotencyKey('unknown_provider', {}, {})).toBeUndefined();
  });

  it('flattens single and repeated headers for persistence', () => {
    expect(flattenHeaders({
      'x-one': 'a',
      'x-many': ['b', 'c'],
      'x-empty': undefined,
    })).toEqual({
      'x-one': 'a',
      'x-many': 'b, c',
    });
  });
});
