import { describe, expect, it } from 'vitest';

import {
  deriveIntradayEnergyReserve,
  extractGarminBodyBatterySnapshot,
  resolveFallbackEnergyReserve,
} from '../../src/services/wearable/energy-reserve';

describe('energy-reserve helpers', () => {
  it('extracts the current Garmin body battery from nested values arrays', () => {
    const snapshot = extractGarminBodyBatterySnapshot([
      {
        bodyBatteryValuesArray: [
          [1713232800000, 'stable', 92],
          [1713236400000, 'stable', 84],
          [1713240000000, 'draining', 71],
        ],
      },
    ], {
      bodyBatteryHighestValue: 95,
      bodyBatteryLowestValue: 40,
    });

    expect(snapshot.current).toBe(71);
    expect(snapshot.morningPeak).toBe(95);
    expect(snapshot.lowest).toBe(40);
  });

  it('derives a lower current reserve as the day load increases', () => {
    const current = deriveIntradayEnergyReserve({
      morningPeak: 86,
      activeCalories: 540,
      exerciseMinutes: 48,
      steps: 9800,
      now: new Date('2026-04-16T16:30:00.000Z'),
    });

    expect(current).toBeLessThan(86);
    expect(current).toBeGreaterThan(20);
  });

  it('falls back to recovery/readiness scores when no explicit battery exists', () => {
    expect(resolveFallbackEnergyReserve(null, 78, 74)).toBe(78);
    expect(resolveFallbackEnergyReserve(null, null, 63)).toBe(63);
  });
});
