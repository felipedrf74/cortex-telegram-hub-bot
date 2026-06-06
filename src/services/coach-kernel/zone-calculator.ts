// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Zone calculator — slice A2 of the Week-Level Adaptability +
 * Periodization plan (v2.1).
 *
 * Pure function that maps an AthleteProfile's anchor measurements to
 * per-sport intensity zone tables. Activates the `ZoneSet` type
 * (types.ts:609-614), which was declared but unread since slice 4.x.
 *
 * Zone mappings (canonical, published-literature sources):
 *
 *   Running — Jack Daniels' VDOT pace zones, anchored on threshold
 *   pace (T-pace). The 6-zone IntensityZone enum maps onto Daniels'
 *   E (easy), M (marathon), T (threshold), I (interval), R (rep)
 *   tempos and the 5-zone HR-derived equivalents.
 *
 *   Cycling — Andy Coggan's 7-zone power model anchored on FTP. We
 *   collapse Coggan Z6 (anaerobic) + Z7 (neuromuscular) into our
 *   single neuromuscular zone, since at the periodization layer the
 *   distinction is uninteresting (both are very-short, very-high).
 *
 *   Swim — Critical Swim Speed (CSS) per Wakayoshi 1992. CSS itself
 *   is the threshold-zone pace; other zones are %CSS offsets.
 *
 *   Heart rate fallback — % of HRmax (Karvonen) or % of LTHR
 *   (lactate threshold HR). Preferred order: %LTHR (more accurate
 *   above tempo) → %HRmax → undefined.
 *
 * Design contracts:
 *
 *   - Pure. No DB reads, no module state, no caching. Engines should
 *     compute once per planning session and pass the result down.
 *
 *   - Defensive. When an anchor is missing for a sport, that sport's
 *     zone table is `undefined` rather than guessed. Engines that
 *     would read from an undefined table fall back to their pre-A2
 *     behavior (template-defined zones).
 *
 *   - Min/max semantics: For power and HR, min < max (lower number
 *     is easier). For pace (sec/km, sec/100m), smaller is FASTER,
 *     so we set `min` to the faster-end of the zone and `max` to
 *     the slower-end — `min` is still the lower number. Callers
 *     reading "am I inside zone X?" use `pace >= min && pace <= max`
 *     in pace units.
 */

import type { AthleteProfile, IntensityZone, ZoneSet } from './types';

// ---------- Coggan % FTP boundaries ----------

/**
 * % of FTP (anchored at 100%) defining each zone. Numbers are the
 * **upper** bound of each zone; the lower bound is the previous
 * upper. Recovery is bounded by 0 below. Neuromuscular is bounded
 * by 200% above (a defensive ceiling — sprint efforts go higher in
 * principle but the engine doesn't prescribe above 200%).
 *
 * Boundaries:
 *   recovery:      0-55%
 *   aerobic:       55-75%   (Coggan Z2)
 *   tempo:         75-90%   (Coggan Z3)
 *   threshold:     90-105%  (Coggan Z4; FTP itself = 100%)
 *   vo2:           105-120% (Coggan Z5)
 *   neuromuscular: 120-200% (Coggan Z6+Z7 collapsed)
 */
const BIKE_PCT_FTP_UPPER: Record<IntensityZone, number> = {
  recovery: 55,
  aerobic: 75,
  tempo: 90,
  threshold: 105,
  vo2: 120,
  neuromuscular: 200,
};

const BIKE_PCT_FTP_LOWER: Record<IntensityZone, number> = {
  recovery: 0,
  aerobic: 55,
  tempo: 75,
  threshold: 90,
  vo2: 105,
  neuromuscular: 120,
};

// ---------- Running % T-pace boundaries ----------

/**
 * % of threshold pace per zone, where 100% = T-pace. Because slower
 * pace is a larger seconds-per-km number, the "%" here means: if
 * T-pace is 240 sec/km, recovery pace is 240 × 1.40 = 336 sec/km
 * (much slower). So the "upper %" is the SLOW end of the zone and
 * the "lower %" is the FAST end.
 *
 * Boundaries (derived from Daniels' VDOT tables, simplified):
 *   recovery:      130-150% of T-pace (slowest; jog/walk)
 *   aerobic:       115-130% (easy; E pace)
 *   tempo:         105-115% (M pace / steady)
 *   threshold:     95-105%  (T pace itself)
 *   vo2:           88-95%   (I pace)
 *   neuromuscular: 75-88%   (R pace; sprint)
 */
const RUN_PCT_TPACE_SLOW: Record<IntensityZone, number> = {
  recovery: 150,
  aerobic: 130,
  tempo: 115,
  threshold: 105,
  vo2: 95,
  neuromuscular: 88,
};

const RUN_PCT_TPACE_FAST: Record<IntensityZone, number> = {
  recovery: 130,
  aerobic: 115,
  tempo: 105,
  threshold: 95,
  vo2: 88,
  neuromuscular: 75,
};

// ---------- Swim % CSS boundaries ----------

/**
 * % of CSS pace per zone, where 100% = CSS (critical swim speed,
 * threshold). Same slower-pace-is-larger-number convention as
 * running, so "slow %" is the slower end, "fast %" is the faster.
 *
 * Boundaries:
 *   recovery:      125-140% (warmup / drill pace)
 *   aerobic:       115-125% (steady aerobic)
 *   tempo:         105-115% (just slower than threshold)
 *   threshold:     95-105%  (CSS itself)
 *   vo2:           88-95%   (faster than CSS; short VO2 sets)
 *   neuromuscular: 80-88%   (sprint; short max-effort)
 */
const SWIM_PCT_CSS_SLOW: Record<IntensityZone, number> = {
  recovery: 140,
  aerobic: 125,
  tempo: 115,
  threshold: 105,
  vo2: 95,
  neuromuscular: 88,
};

const SWIM_PCT_CSS_FAST: Record<IntensityZone, number> = {
  recovery: 125,
  aerobic: 115,
  tempo: 105,
  threshold: 95,
  vo2: 88,
  neuromuscular: 80,
};

// ---------- Heart rate % LTHR boundaries ----------

/**
 * % of LTHR (lactate threshold HR) per zone, where 100% = LTHR.
 *
 * Boundaries (consistent with Friel cycling/running HR zones):
 *   recovery:      <80%
 *   aerobic:       80-89%
 *   tempo:         89-94%
 *   threshold:     94-100%
 *   vo2:           100-106%
 *   neuromuscular: >106%
 */
const HR_PCT_LTHR_UPPER: Record<IntensityZone, number> = {
  recovery: 80,
  aerobic: 89,
  tempo: 94,
  threshold: 100,
  vo2: 106,
  neuromuscular: 130,
};

const HR_PCT_LTHR_LOWER: Record<IntensityZone, number> = {
  recovery: 0,
  aerobic: 80,
  tempo: 89,
  threshold: 94,
  vo2: 100,
  neuromuscular: 106,
};

// ---------- Heart rate % HRmax fallback ----------

/**
 * % of HRmax per zone, used when LTHR is missing but HRmax is
 * available. Less accurate above tempo (the Karvonen model
 * compresses high-end zones), so engines should prefer LTHR when
 * present.
 *
 * Boundaries:
 *   recovery:      <70%
 *   aerobic:       70-80%
 *   tempo:         80-87%
 *   threshold:     87-93%
 *   vo2:           93-98%
 *   neuromuscular: >98%
 */
const HR_PCT_HRMAX_UPPER: Record<IntensityZone, number> = {
  recovery: 70,
  aerobic: 80,
  tempo: 87,
  threshold: 93,
  vo2: 98,
  neuromuscular: 100,
};

const HR_PCT_HRMAX_LOWER: Record<IntensityZone, number> = {
  recovery: 0,
  aerobic: 70,
  tempo: 80,
  threshold: 87,
  vo2: 93,
  neuromuscular: 98,
};

// ---------- Computation helpers ----------

const ZONES: readonly IntensityZone[] = [
  'recovery',
  'aerobic',
  'tempo',
  'threshold',
  'vo2',
  'neuromuscular',
];

/**
 * Build a `Record<IntensityZone, {min, max}>` from a watts anchor
 * (FTP). For power, min = lower bound (easier), max = upper bound.
 */
export function computeBikePowerZones(
  ftpWatts: number,
): Record<IntensityZone, { min: number; max: number }> {
  if (!Number.isFinite(ftpWatts) || ftpWatts <= 0) {
    throw new Error('computeBikePowerZones: ftpWatts must be a positive finite number');
  }
  const zones: Partial<Record<IntensityZone, { min: number; max: number }>> = {};
  for (const z of ZONES) {
    const lower = Math.round((BIKE_PCT_FTP_LOWER[z] / 100) * ftpWatts);
    const upper = Math.round((BIKE_PCT_FTP_UPPER[z] / 100) * ftpWatts);
    zones[z] = { min: lower, max: upper };
  }
  return zones as Record<IntensityZone, { min: number; max: number }>;
}

/**
 * Build a pace-zone table from a threshold pace anchor (sec/km).
 * Slower pace = larger number, so min = fast end (smaller sec/km),
 * max = slow end (larger sec/km).
 */
export function computeRunningPaceZones(
  thresholdPaceSecondsPerKm: number,
): Record<IntensityZone, { min: number; max: number }> {
  if (!Number.isFinite(thresholdPaceSecondsPerKm) || thresholdPaceSecondsPerKm <= 0) {
    throw new Error('computeRunningPaceZones: thresholdPaceSecondsPerKm must be a positive finite number');
  }
  const zones: Partial<Record<IntensityZone, { min: number; max: number }>> = {};
  for (const z of ZONES) {
    // pace × (slow% / 100) = slower end (larger sec/km)
    // pace × (fast% / 100) = faster end (smaller sec/km)
    const slow = Math.round((RUN_PCT_TPACE_SLOW[z] / 100) * thresholdPaceSecondsPerKm);
    const fast = Math.round((RUN_PCT_TPACE_FAST[z] / 100) * thresholdPaceSecondsPerKm);
    zones[z] = { min: fast, max: slow };
  }
  return zones as Record<IntensityZone, { min: number; max: number }>;
}

/**
 * Build a pace-zone table from a CSS anchor (sec/100m). Same
 * pace-direction convention as running.
 */
export function computeSwimPaceZones(
  cssSecondsPer100m: number,
): Record<IntensityZone, { min: number; max: number }> {
  if (!Number.isFinite(cssSecondsPer100m) || cssSecondsPer100m <= 0) {
    throw new Error('computeSwimPaceZones: cssSecondsPer100m must be a positive finite number');
  }
  const zones: Partial<Record<IntensityZone, { min: number; max: number }>> = {};
  for (const z of ZONES) {
    const slow = Math.round((SWIM_PCT_CSS_SLOW[z] / 100) * cssSecondsPer100m);
    const fast = Math.round((SWIM_PCT_CSS_FAST[z] / 100) * cssSecondsPer100m);
    zones[z] = { min: fast, max: slow };
  }
  return zones as Record<IntensityZone, { min: number; max: number }>;
}

/**
 * Build an HR-zone table. Prefers LTHR anchor when available
 * (more accurate above tempo), falls back to HRmax. Returns
 * undefined when neither anchor is set.
 */
export function computeHeartRateZones(
  profile: Pick<AthleteProfile, 'maxHeartRate' | 'thresholdHeartRate'>,
): Record<IntensityZone, { min: number; max: number }> | undefined {
  const lthr = profile.thresholdHeartRate;
  if (typeof lthr === 'number' && Number.isFinite(lthr) && lthr > 0) {
    const zones: Partial<Record<IntensityZone, { min: number; max: number }>> = {};
    for (const z of ZONES) {
      const lower = Math.round((HR_PCT_LTHR_LOWER[z] / 100) * lthr);
      const upper = Math.round((HR_PCT_LTHR_UPPER[z] / 100) * lthr);
      zones[z] = { min: lower, max: upper };
    }
    return zones as Record<IntensityZone, { min: number; max: number }>;
  }
  const hrmax = profile.maxHeartRate;
  if (typeof hrmax === 'number' && Number.isFinite(hrmax) && hrmax > 0) {
    const zones: Partial<Record<IntensityZone, { min: number; max: number }>> = {};
    for (const z of ZONES) {
      const lower = Math.round((HR_PCT_HRMAX_LOWER[z] / 100) * hrmax);
      const upper = Math.round((HR_PCT_HRMAX_UPPER[z] / 100) * hrmax);
      zones[z] = { min: lower, max: upper };
    }
    return zones as Record<IntensityZone, { min: number; max: number }>;
  }
  return undefined;
}

/**
 * Compute the full ZoneSet from an AthleteProfile. Each sport-specific
 * table is undefined when its anchor is missing — engines reading
 * the result should fall back to template-defined zones.
 */
export function computeZoneSet(
  profile: Pick<
    AthleteProfile,
    | 'thresholdPaceSecondsPerKm'
    | 'cyclingFtpWatts'
    | 'swimCssSecondsPer100m'
    | 'maxHeartRate'
    | 'thresholdHeartRate'
  >,
): ZoneSet {
  return {
    runningPaceSecondsPerKm: profile.thresholdPaceSecondsPerKm
      ? computeRunningPaceZones(profile.thresholdPaceSecondsPerKm)
      : undefined,
    bikePowerWatts: profile.cyclingFtpWatts
      ? computeBikePowerZones(profile.cyclingFtpWatts)
      : undefined,
    swimPaceSecondsPer100m: profile.swimCssSecondsPer100m
      ? computeSwimPaceZones(profile.swimCssSecondsPer100m)
      : undefined,
    heartRateBpm: computeHeartRateZones(profile),
  };
}

/**
 * Half-open membership helper for zone tables. Lower bounds are
 * inclusive; an upper bound that is also another zone's lower bound
 * is exclusive so a boundary value belongs to exactly one zone.
 */
export function isValueInZoneRange(
  value: number,
  zone: IntensityZone,
  zoneTable: Record<IntensityZone, { min: number; max: number }>,
): boolean {
  if (!Number.isFinite(value)) return false;
  const range = zoneTable[zone];
  if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max)) return false;
  if (value < range.min || value > range.max) return false;
  const upperIsAdjacentLower = ZONES.some((other) => other !== zone && zoneTable[other]?.min === range.max);
  return value < range.max || !upperIsAdjacentLower;
}

/**
 * Compute the **intensity factor (IF)** for a target zone in a
 * specific sport, given the athlete's anchors. IF is the ratio of
 * the zone's representative intensity to the threshold anchor (FTP
 * for power, T-pace for running, CSS for swim) — used by B1 to
 * compute TSS via Coggan's formula `TSS = duration_hours × IF² × 100`.
 *
 * Returns undefined when the relevant anchor is missing OR when the
 * zone doesn't have a sport-specific calculation (e.g., neuromuscular
 * efforts are too short for steady-state IF to be meaningful).
 *
 * For each sport we use the **midpoint** of the zone as its
 * representative intensity. This is the standard approximation used
 * in TrainingPeaks' published TSS calculations.
 */
export function computeIntensityFactorForZone(
  zone: IntensityZone,
  sport: 'running' | 'cycling' | 'swimming',
  profile: Pick<AthleteProfile, 'thresholdPaceSecondsPerKm' | 'cyclingFtpWatts' | 'swimCssSecondsPer100m'>,
): number | undefined {
  if (zone === 'neuromuscular') return undefined;
  if (sport === 'cycling') {
    if (!profile.cyclingFtpWatts) return undefined;
    // Midpoint % FTP for the zone.
    const pctMid = (BIKE_PCT_FTP_LOWER[zone] + BIKE_PCT_FTP_UPPER[zone]) / 2;
    const zones = computeBikePowerZones(profile.cyclingFtpWatts);
    const representativeWatts = (pctMid / 100) * profile.cyclingFtpWatts;
    if (!isValueInZoneRange(representativeWatts, zone, zones)) return undefined;
    return pctMid / 100;
  }
  if (sport === 'running') {
    if (!profile.thresholdPaceSecondsPerKm) return undefined;
    const zones = computeRunningPaceZones(profile.thresholdPaceSecondsPerKm);
    if (zone === 'threshold') {
      return isValueInZoneRange(profile.thresholdPaceSecondsPerKm, zone, zones) ? 1 : undefined;
    }
    // For pace, IF = (T-pace seconds) / (zone seconds). Faster pace
    // (smaller sec/km) means higher IF. Average speed, not seconds,
    // so wide slow zones are not biased toward the slow endpoint.
    const slowSec = (RUN_PCT_TPACE_SLOW[zone] / 100) * profile.thresholdPaceSecondsPerKm;
    const fastSec = (RUN_PCT_TPACE_FAST[zone] / 100) * profile.thresholdPaceSecondsPerKm;
    const meanSpeed = ((1 / slowSec) + (1 / fastSec)) / 2;
    const representativeSec = 1 / meanSpeed;
    if (!isValueInZoneRange(representativeSec, zone, zones)) return undefined;
    return profile.thresholdPaceSecondsPerKm / representativeSec;
  }
  if (sport === 'swimming') {
    if (!profile.swimCssSecondsPer100m) return undefined;
    const zones = computeSwimPaceZones(profile.swimCssSecondsPer100m);
    if (zone === 'threshold') {
      return isValueInZoneRange(profile.swimCssSecondsPer100m, zone, zones) ? 1 : undefined;
    }
    const slowSec = (SWIM_PCT_CSS_SLOW[zone] / 100) * profile.swimCssSecondsPer100m;
    const fastSec = (SWIM_PCT_CSS_FAST[zone] / 100) * profile.swimCssSecondsPer100m;
    const meanSpeed = ((1 / slowSec) + (1 / fastSec)) / 2;
    const representativeSec = 1 / meanSpeed;
    if (!isValueInZoneRange(representativeSec, zone, zones)) return undefined;
    return profile.swimCssSecondsPer100m / representativeSec;
  }
  return undefined;
}
