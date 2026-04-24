import { describe, expect, it } from 'vitest';
import { humanDelta, humanUptime } from '../../src/portal/formatters';

describe('portal formatters', () => {
  it('formats uptime with days, hours, and always minutes', () => {
    expect(humanUptime(0)).toBe('0m');
    expect(humanUptime(59)).toBe('0m');
    expect(humanUptime(61)).toBe('1m');
    expect(humanUptime(3_600 + 120)).toBe('1h 2m');
    expect(humanUptime(86_400 + 3_600)).toBe('1d 1h 0m');
  });

  it('formats future deltas for portal job summaries', () => {
    expect(humanDelta(0)).toBe('in <1m');
    expect(humanDelta(59)).toBe('in <1m');
    expect(humanDelta(60)).toBe('in 1m');
    expect(humanDelta(3_600 + 60)).toBe('in 1h 1m');
    expect(humanDelta(86_400 + 3_600)).toBe('in 1d 1h');
  });
});
