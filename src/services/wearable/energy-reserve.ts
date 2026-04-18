// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Energy reserve helpers — normalize provider-specific recovery/energy signals
 * into a current 0-100 "battery" style metric that can move during the day.
 */

export interface GarminBodyBatterySnapshot {
  current: number | null;
  morningPeak: number | null;
  highest: number | null;
  lowest: number | null;
}

interface IntradayEnergyReserveInput {
  morningPeak: number | null;
  activeCalories?: number | null;
  exerciseMinutes?: number | null;
  steps?: number | null;
  strain?: number | null;
  now?: Date;
}

export function normalizeEnergyReserve(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return clamp(Math.round(value), 0, 100);
}

export function extractGarminBodyBatterySnapshot(
  eventsData: unknown,
  summary?: Record<string, unknown> | null,
): GarminBodyBatterySnapshot {
  const values = extractGarminBodyBatteryValues(eventsData);
  const highest = normalizeEnergyReserve(summary?.bodyBatteryHighestValue)
    ?? (values.length > 0 ? Math.max(...values) : null);
  const lowest = normalizeEnergyReserve(summary?.bodyBatteryLowestValue)
    ?? (values.length > 0 ? Math.min(...values) : null);
  const current = normalizeEnergyReserve(summary?.bodyBatteryMostRecentValue)
    ?? (values.length > 0 ? values[values.length - 1] : null);
  const morningPeak = highest
    ?? (values.length > 0 ? Math.max(...values.slice(0, Math.max(1, Math.ceil(values.length / 3)))) : null);

  return {
    current,
    morningPeak,
    highest,
    lowest,
  };
}

export function deriveIntradayEnergyReserve(input: IntradayEnergyReserveInput): number | null {
  const morningPeak = normalizeEnergyReserve(input.morningPeak);
  if (morningPeak == null) return null;

  const activeCalories = Math.max(0, input.activeCalories ?? 0);
  const exerciseMinutes = Math.max(0, input.exerciseMinutes ?? 0);
  const steps = Math.max(0, input.steps ?? 0);
  const strain = Math.max(0, input.strain ?? 0);

  const now = input.now ?? new Date();
  const hour = now.getHours() + (now.getMinutes() / 60);
  const circadianProgress = hour <= 6 ? 0 : hour >= 22 ? 1 : (hour - 6) / 16;
  const circadianDrain = circadianProgress * 8;

  // Calories do most of the visible intraday work. Exercise minutes, steps,
  // and strain smooth the curve when calorie sync is sparse or delayed.
  const activityDrain =
    (activeCalories / 32) +
    (exerciseMinutes / 20) +
    (Math.max(0, steps - 1500) / 3000) +
    (strain * 1.5);

  return clamp(Math.round(morningPeak - circadianDrain - activityDrain), 5, 100);
}

export function resolveFallbackEnergyReserve(
  bodyBattery: number | null | undefined,
  recoveryScore: number | null | undefined,
  readinessScore: number | null | undefined,
): number | null {
  return normalizeEnergyReserve(bodyBattery)
    ?? normalizeEnergyReserve(recoveryScore)
    ?? normalizeEnergyReserve(readinessScore);
}

function extractGarminBodyBatteryValues(eventsData: unknown): number[] {
  const values: number[] = [];
  const queue = collectGarminEventContainers(eventsData);

  for (const event of queue) {
    if (!event || typeof event !== 'object') continue;
    const record = event as Record<string, unknown>;

    pushNumeric(values, record.bodyBatteryLevel);
    pushNumeric(values, record.value);
    pushNumeric(values, record.bodyBatteryMostRecentValue);

    const bodyBatteryValuesArray = record.bodyBatteryValuesArray;
    if (Array.isArray(bodyBatteryValuesArray)) {
      for (const entry of bodyBatteryValuesArray) {
        if (Array.isArray(entry) && entry.length > 2) {
          pushNumeric(values, entry[2]);
        }
      }
    }
  }

  return values;
}

function collectGarminEventContainers(eventsData: unknown): unknown[] {
  if (!eventsData) return [];
  if (Array.isArray(eventsData)) return eventsData;
  if (typeof eventsData !== 'object') return [];

  const record = eventsData as Record<string, unknown>;
  if (Array.isArray(record.bodyBatteryEvents)) return record.bodyBatteryEvents;
  if (Array.isArray(record.events)) return record.events;
  if (Array.isArray(record.bodyBatteryValuesArray)) return [record];
  return [record];
}

function pushNumeric(target: number[], value: unknown): void {
  const normalized = normalizeEnergyReserve(value);
  if (normalized != null) {
    target.push(normalized);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
