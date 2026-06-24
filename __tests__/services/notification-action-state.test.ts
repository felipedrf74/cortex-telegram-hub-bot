import { describe, expect, it } from 'vitest';

import { computeSharedNotificationActionEffectiveStatus } from '../../src/services/notification-action-state';

describe('shared notification action state', () => {
  it.each([
    {
      name: 'unsupported contract wins first',
      input: { actionId: 'mark_paid', status: 'unread', supported: false, safeForFrontendAction: false },
      expected: 'disabled_unsupported',
    },
    {
      name: 'missing frontend details win before not implemented',
      input: { actionId: 'choose_priority', status: 'unread', safeForFrontendAction: false },
      expected: 'disabled_missing_details',
    },
    {
      name: 'reconnect affordance replaces not implemented retry',
      input: { actionId: 'retry', status: 'unread', reconnectRequired: true },
      expected: 'disabled_requires_reconnect',
    },
    {
      name: 'not implemented follows safe details',
      input: { actionId: 'choose_priority', status: 'unread', safeForFrontendAction: true },
      expected: 'disabled_not_implemented',
    },
    {
      name: 'expired disables implemented actions',
      input: { actionId: 'mark_paid', status: 'unread', expiresAt: '2020-01-01T00:00:00.000Z', nowMs: Date.parse('2026-01-01T00:00:00.000Z') },
      expected: 'disabled_expired',
    },
    {
      name: 'superseded disables implemented actions',
      input: { actionId: 'mark_paid', status: 'superseded' },
      expected: 'disabled_superseded',
    },
    {
      name: 'actioned disables implemented actions',
      input: { actionId: 'mark_paid', status: 'actioned' },
      expected: 'disabled_already_actioned',
    },
    {
      name: 'dependency blocks otherwise enabled actions',
      input: { actionId: 'mark_paid', status: 'unread', blockedByDependency: true },
      expected: 'disabled_blocked_by_dependency',
    },
    {
      name: 'implemented safe action is enabled',
      input: { actionId: 'mark_paid', status: 'unread', safeForFrontendAction: true },
      expected: 'enabled',
    },
  ])('$name', ({ input, expected }) => {
    expect(computeSharedNotificationActionEffectiveStatus(input).effective).toBe(expected);
  });
});
