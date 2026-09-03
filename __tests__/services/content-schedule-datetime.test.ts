import { describe, expect, it } from 'vitest';

import { extractContentScheduleDateTime } from '../../src/services/skills/content/datetime';

describe('content schedule datetime extraction', () => {
  it('interprets offset-less ISO input as wall-clock time in the user timezone', () => {
    expect(extractContentScheduleDateTime(
      'Schedule filming for 2026-05-18T09:00',
      { timezone: 'America/New_York' },
    )).toBe('2026-05-18T09:00:00.000-04:00');
  });

  it('converts explicit offsets into the user timezone without changing the instant', () => {
    expect(extractContentScheduleDateTime(
      'Schedule filming for 2026-05-18T09:00Z',
      { timezone: 'America/New_York' },
    )).toBe('2026-05-18T05:00:00.000-04:00');
  });
});
