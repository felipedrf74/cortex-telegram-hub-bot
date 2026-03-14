/**
 * Garmin Connect API client — wraps `garmin-connect` for auth,
 * extends with direct API calls for health/wellness endpoints.
 *
 * Uses token persistence (OAuth1 + OAuth2 files in data/garmin-tokens/)
 * so we only need to login with credentials once. Subsequent runs load
 * saved tokens and refresh as needed.
 */
import { GarminConnect } from 'garmin-connect';
import { config } from '../config';
import { logger } from '../utils/logger';
import { now } from '../utils/date-parser';
import * as fs from 'fs';

// ─── Garmin Connect API base URLs ────────────────────────────────────
const API = 'https://connectapi.garmin.com';

const URLS = {
  // Daily wellness summaries
  userSummary: (date: string) => `${API}/usersummary-service/usersummary/daily/${date}`,
  sleepData: (date: string) => `${API}/sleep-service/sleep/dailySleepData?date=${date}`,
  stressSummary: (date: string) => `${API}/wellness-service/wellness/dailyStress/${date}`,
  heartRateSummary: (date: string) => `${API}/wellness-service/wellness/dailyHeartRate?date=${date}`,
  hrvData: (date: string) => `${API}/hrv-service/hrv/${date}`,
  trainingReadiness: (date: string) => `${API}/metrics-service/metrics/trainingreadiness/daily/${date}`,
  trainingStatus: (date: string) => `${API}/metrics-service/metrics/trainingstatus/aggregated/${date}`,
  bodyBatteryEvents: (date: string) => `${API}/wellness-service/wellness/bodyBattery/events/${date}`,
  rhr: (date: string) => `${API}/wellness-service/wellness/dailyHeartRate?date=${date}`,

  // Activities
  activitiesByDate: (start: string, end: string) =>
    `${API}/activitylist-service/activities/search/activities?startDate=${start}&endDate=${end}&limit=20`,
  activityDetails: (id: number) => `${API}/activity-service/activity/${id}`,
  activitySplits: (id: number) => `${API}/activity-service/activity/${id}/splits`,
  activityExerciseSets: (id: number) => `${API}/activity-service/activity/${id}/exerciseSets`,
  trainingEffect: (id: number) => `${API}/activity-service/activity/${id}`,

  // Tomorrow's plan
  scheduledWorkouts: (start: string, end: string) =>
    `${API}/workout-service/schedule/${start}/${end}`,
  trainingPlanWorkouts: (date: string) =>
    `${API}/workout-service/api/trainingplan/scheduled/${date}`,
  workoutDetail: (id: number) => `${API}/workout-service/workout/${id}`,

  // Trends
  weeklyStress: (date: string, weeks: number) =>
    `${API}/wellness-service/wellness/weeklyStress/${date}?numOfWeeks=${weeks}`,
  weeklyIntensityMinutes: (date: string, weeks: number) =>
    `${API}/wellness-service/wellness/dailyIntensityMinutes?calendarDate=${date}&numOfWeeks=${weeks}`,
  racePredictions: () => `${API}/metrics-service/metrics/racePredictions`,
  goals: (type: string) => `${API}/goal-service/goal/${type}`,
} as const;

// ─── Types ────────────────────────────────────────────────────────────

/** Raw daily summary from Garmin */
export interface GarminDailySummary {
  totalSteps?: number;
  totalDistanceMeters?: number;
  activeKilocalories?: number;
  totalKilocalories?: number;
  restingHeartRate?: number;
  maxHeartRate?: number;
  averageStressLevel?: number;
  bodyBatteryChargedValue?: number;
  bodyBatteryDrainedValue?: number;
  bodyBatteryHighestValue?: number;
  bodyBatteryLowestValue?: number;
  averageHeartRate?: number;
  minHeartRate?: number;
  [key: string]: unknown;
}

export interface GarminActivity {
  activityId: number;
  activityName: string;
  activityType: { typeKey: string; parentTypeId?: number };
  startTimeLocal: string;
  duration: number;        // seconds
  distance?: number;       // meters
  averageHR?: number;
  maxHR?: number;
  calories?: number;
  averageRunningCadenceInStepsPerMinute?: number;
  averageSpeed?: number;   // m/s
  elevationGain?: number;
  [key: string]: unknown;
}

/** Pre-extracted body battery summary (derived from events endpoint) */
export interface BodyBatterySummary {
  current: number | null;
  highest: number | null;
  lowest: number | null;
  charged: number | null;   // from dailySummary if available
  drained: number | null;   // from dailySummary if available
}

export interface GarminCoachData {
  date: string;
  summary: GarminDailySummary | null;
  sleepSummary: Record<string, unknown> | null;
  stressSummary: Record<string, unknown> | null;
  heartRateSummary: Record<string, unknown> | null;
  hrvSummary: Record<string, unknown> | null;
  trainingReadiness: unknown;
  trainingStatus: unknown;
  bodyBatterySummary: BodyBatterySummary;
  activities: GarminActivity[];
  activityDetails: Map<number, unknown>;
  tomorrowWorkouts: unknown[];
  tomorrowTrainingPlan: unknown;
  weeklyStress: unknown;
  weeklyIntensityMinutes: unknown;
  errors: string[];
}

// ─── Client singleton ─────────────────────────────────────────────────

let _client: InstanceType<typeof GarminConnect> | null = null;
let _authenticated = false;

export function isGarminConfigured(): boolean {
  return !!(config.garmin.email && config.garmin.password);
}

/**
 * Get an authenticated Garmin Connect client.
 * First tries to load persisted tokens; if expired or missing, does a fresh login.
 */
async function getClient(): Promise<InstanceType<typeof GarminConnect>> {
  if (_client && _authenticated) return _client;

  _client = new GarminConnect({
    username: config.garmin.email,
    password: config.garmin.password,
  });

  const tokenDir = config.garmin.tokenPath;

  // Try loading persisted tokens first
  try {
    if (fs.existsSync(`${tokenDir}/oauth1_token.json`) && fs.existsSync(`${tokenDir}/oauth2_token.json`)) {
      _client.loadTokenByFile(tokenDir);
      // Validate by making a lightweight call
      await _client.getUserSettings();
      _authenticated = true;
      logger.info('Garmin: loaded saved tokens');
      return _client;
    }
  } catch (err) {
    logger.warn({ err }, 'Garmin: saved tokens expired or invalid, re-authenticating');
  }

  // Fresh login
  try {
    await _client.login();
    // Ensure token directory exists
    if (!fs.existsSync(tokenDir)) {
      fs.mkdirSync(tokenDir, { recursive: true });
    }
    _client.exportTokenToFile(tokenDir);
    _authenticated = true;
    logger.info('Garmin: fresh login successful, tokens saved');
    return _client;
  } catch (err) {
    _authenticated = false;
    throw new Error(`Garmin login failed: ${(err as Error).message}`);
  }
}

/**
 * Save current tokens to disk (call after successful API calls to persist
 * any tokens that the garmin-connect interceptor may have refreshed).
 */
function persistTokens(): void {
  try {
    if (_client) {
      const tokenDir = config.garmin.tokenPath;
      if (!fs.existsSync(tokenDir)) fs.mkdirSync(tokenDir, { recursive: true });
      _client.exportTokenToFile(tokenDir);
    }
  } catch (err) {
    logger.warn({ err }, 'Garmin: failed to persist refreshed tokens');
  }
}

/**
 * Proactively refresh the OAuth2 token using the OAuth1 token.
 * Called on a schedule to prevent token expiry.
 */
async function refreshOAuth2(): Promise<boolean> {
  try {
    const client = await getClient();
    // Access the underlying HttpClient to call refreshOauth2Token directly
    await (client.client as any).refreshOauth2Token();
    persistTokens();
    logger.info('Garmin: proactive OAuth2 token refresh successful');
    return true;
  } catch (err) {
    logger.warn({ err }, 'Garmin: proactive OAuth2 refresh failed');
    return false;
  }
}

/**
 * Attempt a full re-login (credentials-based).
 * This works when MFA is not enabled or when Garmin doesn't prompt for it.
 */
async function attemptReLogin(): Promise<boolean> {
  try {
    if (!_client) {
      _client = new GarminConnect({
        username: config.garmin.email,
        password: config.garmin.password,
      });
    }
    _authenticated = false;
    await _client.login();
    const tokenDir = config.garmin.tokenPath;
    if (!fs.existsSync(tokenDir)) fs.mkdirSync(tokenDir, { recursive: true });
    _client.exportTokenToFile(tokenDir);
    _authenticated = true;
    logger.info('Garmin: re-login successful, tokens saved');
    return true;
  } catch (err) {
    logger.error({ err }, 'Garmin: re-login failed (may require MFA or manual intervention)');
    _authenticated = false;
    return false;
  }
}

/**
 * Keep-alive: refresh tokens proactively. Exported for use by the scheduler.
 * Strategy: try OAuth2 refresh first, then full re-login as fallback.
 */
export async function keepAlive(): Promise<boolean> {
  if (!isGarminConfigured()) return false;

  // Step 1: Try proactive OAuth2 refresh
  if (await refreshOAuth2()) {
    // Validate with a lightweight call
    try {
      const client = await getClient();
      await client.getUserSettings();
      return true;
    } catch {
      logger.warn('Garmin: OAuth2 refresh succeeded but validation failed, trying re-login');
    }
  }

  // Step 2: Try full re-login
  return attemptReLogin();
}

/**
 * Extract HTTP status from garmin-connect errors.
 * The library throws plain Errors with messages like "ERROR: (403), Forbidden, {...}"
 * instead of attaching a .response property, so we parse the message string.
 */
function extractErrorStatus(err: unknown): number | null {
  // Try standard axios-style first
  const axiosStatus = (err as { response?: { status?: number } })?.response?.status;
  if (axiosStatus) return axiosStatus;
  // Parse garmin-connect formatted error: "ERROR: (403), Forbidden, ..."
  const msg = (err as Error)?.message ?? '';
  const match = msg.match(/\((\d{3})\)/);
  return match ? parseInt(match[1], 10) : null;
}

async function safeGet<T = unknown>(url: string): Promise<T> {
  const client = await getClient();
  try {
    const result = await client.get(url) as T;
    persistTokens();
    return result;
  } catch (err: unknown) {
    const status = extractErrorStatus(err);
    if (status === 401 || status === 403) {
      logger.warn({ status, url: url.split('?')[0] }, 'Garmin: auth error, attempting OAuth2 refresh');

      // Step 1: Try refreshing OAuth2 token directly (handles 403 that the library misses)
      try {
        await (client.client as any).refreshOauth2Token();
        persistTokens();
        const result = await client.get(url) as T;
        persistTokens();
        logger.info('Garmin: recovered via OAuth2 refresh');
        return result;
      } catch (refreshErr) {
        logger.warn({ err: refreshErr }, 'Garmin: OAuth2 refresh failed, trying token reload');
      }

      // Step 2: Reload tokens from disk (another concurrent call may have refreshed them)
      const tokenDir = config.garmin.tokenPath;
      if (fs.existsSync(`${tokenDir}/oauth1_token.json`) && fs.existsSync(`${tokenDir}/oauth2_token.json`)) {
        client.loadTokenByFile(tokenDir);
        try {
          const result = await client.get(url) as T;
          persistTokens();
          return result;
        } catch (reloadErr) {
          logger.warn({ err: reloadErr }, 'Garmin: token reload failed, trying re-login');
        }
      }

      // Step 3: Last resort — full re-login
      if (await attemptReLogin()) {
        try {
          const freshClient = await getClient();
          const result = await freshClient.get(url) as T;
          persistTokens();
          logger.info('Garmin: recovered via re-login');
          return result;
        } catch (loginErr) {
          logger.error({ err: loginErr }, 'Garmin: re-login succeeded but API call still failed');
          throw loginErr;
        }
      }

      throw err; // all recovery attempts exhausted
    }
    throw err;
  }
}

// ─── Public API methods ───────────────────────────────────────────────

export async function getDailySummary(date: string): Promise<GarminDailySummary | null> {
  try { return await safeGet<GarminDailySummary>(URLS.userSummary(date)); }
  catch { return null; }
}

export async function getSleepData(date: string): Promise<unknown> {
  try { return await safeGet(URLS.sleepData(date)); }
  catch { return null; }
}

export async function getStressSummary(date: string): Promise<unknown> {
  try { return await safeGet(URLS.stressSummary(date)); }
  catch { return null; }
}

export async function getHeartRateSummary(date: string): Promise<unknown> {
  try { return await safeGet(URLS.heartRateSummary(date)); }
  catch { return null; }
}

export async function getHrvData(date: string): Promise<unknown> {
  try { return await safeGet(URLS.hrvData(date)); }
  catch { return null; }
}

export async function getTrainingReadiness(date: string): Promise<unknown> {
  try { return await safeGet(URLS.trainingReadiness(date)); }
  catch { return null; }
}

export async function getTrainingStatus(date: string): Promise<unknown> {
  try { return await safeGet(URLS.trainingStatus(date)); }
  catch { return null; }
}

export async function getBodyBatteryEvents(date: string): Promise<unknown> {
  try { return await safeGet(URLS.bodyBatteryEvents(date)); }
  catch { return null; }
}

export async function getRhr(date: string): Promise<unknown> {
  try { return await safeGet(URLS.rhr(date)); }
  catch { return null; }
}

export async function getActivitiesByDate(startDate: string, endDate: string): Promise<GarminActivity[]> {
  try {
    const result = await safeGet<GarminActivity[]>(URLS.activitiesByDate(startDate, endDate));
    return Array.isArray(result) ? result : [];
  } catch { return []; }
}

export async function getActivityDetails(activityId: number): Promise<unknown> {
  try { return await safeGet(URLS.activityDetails(activityId)); }
  catch { return null; }
}

export async function getActivitySplits(activityId: number): Promise<unknown> {
  try { return await safeGet(URLS.activitySplits(activityId)); }
  catch { return null; }
}

export async function getActivityExerciseSets(activityId: number): Promise<unknown> {
  try { return await safeGet(URLS.activityExerciseSets(activityId)); }
  catch { return null; }
}

export async function getTrainingEffect(activityId: number): Promise<unknown> {
  try {
    const details = await safeGet<Record<string, unknown>>(URLS.trainingEffect(activityId));
    return details?.summaryDTO ?? details;
  } catch { return null; }
}

export async function getScheduledWorkouts(startDate: string, endDate: string): Promise<unknown[]> {
  try {
    const result = await safeGet<unknown[]>(URLS.scheduledWorkouts(startDate, endDate));
    return Array.isArray(result) ? result : [];
  } catch { return []; }
}

export async function getTrainingPlanWorkouts(date: string): Promise<unknown> {
  try { return await safeGet(URLS.trainingPlanWorkouts(date)); }
  catch { return null; }
}

export async function getWorkoutDetail(workoutId: number): Promise<unknown> {
  try { return await safeGet(URLS.workoutDetail(workoutId)); }
  catch { return null; }
}

export async function getWeeklyStress(date: string, weeks = 1): Promise<unknown> {
  try { return await safeGet(URLS.weeklyStress(date, weeks)); }
  catch { return null; }
}

export async function getWeeklyIntensityMinutes(date: string, weeks = 1): Promise<unknown> {
  try { return await safeGet(URLS.weeklyIntensityMinutes(date, weeks)); }
  catch { return null; }
}

export async function getRacePredictions(): Promise<unknown> {
  try { return await safeGet(URLS.racePredictions()); }
  catch { return null; }
}

export async function getActiveGoals(): Promise<unknown> {
  try { return await safeGet(URLS.goals('active')); }
  catch { return null; }
}

// ─── Composite: Fetch all daily coach data in parallel ────────────────

export async function fetchDailyCoachData(): Promise<GarminCoachData> {
  const today = now().toFormat('yyyy-MM-dd');
  const tomorrow = now().plus({ days: 1 }).toFormat('yyyy-MM-dd');
  const errors: string[] = [];

  // Phase 1: Parallel fetch of all daily data + activities
  const [
    summary, sleep, stress, heartRate, hrv,
    trainingReadiness, trainingStatus, bodyBattery, rhr,
    activities,
  ] = await Promise.allSettled([
    getDailySummary(today),
    getSleepData(today),
    getStressSummary(today),
    getHeartRateSummary(today),
    getHrvData(today),
    getTrainingReadiness(today),
    getTrainingStatus(today),
    getBodyBatteryEvents(today),
    getRhr(today),
    getActivitiesByDate(today, today),
  ]).then(results => results.map((r, i) => {
    if (r.status === 'rejected') {
      const names = ['summary', 'sleep', 'stress', 'heartRate', 'hrv', 'trainingReadiness', 'trainingStatus', 'bodyBattery', 'rhr', 'activities'];
      errors.push(`${names[i]}: ${r.reason?.message ?? 'unknown error'}`);
      return null;
    }
    return r.value;
  }));

  const activityList = (activities as GarminActivity[] | null) ?? [];

  // Phase 2: Activity-specific enrichment (parallel)
  const activityDetails = new Map<number, unknown>();
  if (activityList.length > 0) {
    const detailPromises = activityList.map(async (a) => {
      try {
        const [effect, details] = await Promise.all([
          getTrainingEffect(a.activityId),
          isStrength(a)
            ? getActivityExerciseSets(a.activityId)
            : isRunning(a)
              ? getActivityDetails(a.activityId) // includes running dynamics
              : getActivitySplits(a.activityId),
        ]);
        activityDetails.set(a.activityId, { trainingEffect: effect, extra: details });
      } catch (err) {
        errors.push(`activity ${a.activityId}: ${(err as Error).message}`);
      }
    });
    await Promise.all(detailPromises);
  }

  // Phase 3: Tomorrow's scheduled workouts + training plan (parallel)
  const [tomorrowWorkouts, tomorrowTrainingPlan, weeklyStress, weeklyIntensityMinutes] = await Promise.allSettled([
    getScheduledWorkouts(tomorrow, tomorrow),
    getTrainingPlanWorkouts(tomorrow),
    getWeeklyStress(today),
    getWeeklyIntensityMinutes(today),
  ]).then(results => results.map((r, i) => {
    if (r.status === 'rejected') {
      const names = ['scheduledWorkouts', 'trainingPlan', 'weeklyStress', 'weeklyIntensity'];
      errors.push(`${names[i]}: ${r.reason?.message ?? 'unknown error'}`);
      return null;
    }
    return r.value;
  }));

  // Pre-extract / summarize data (raw blobs are 200KB+ and blow the payload budget)
  const bodyBatterySummaryData = extractBodyBatterySummary(
    bodyBattery,
    summary as GarminDailySummary | null,
  );

  return {
    date: today,
    summary: summary as GarminDailySummary | null,
    sleepSummary: summarizeSleep(sleep),
    stressSummary: summarizeStress(stress),
    heartRateSummary: summarizeHeartRate(heartRate),
    hrvSummary: summarizeHrv(hrv),
    trainingReadiness,
    trainingStatus,
    bodyBatterySummary: bodyBatterySummaryData,
    activities: activityList,
    activityDetails,
    tomorrowWorkouts: (tomorrowWorkouts as unknown[]) ?? [],
    tomorrowTrainingPlan,
    weeklyStress,
    weeklyIntensityMinutes,
    errors,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────

function isStrength(activity: GarminActivity): boolean {
  const key = activity.activityType?.typeKey?.toLowerCase() ?? '';
  return key.includes('strength') || key.includes('gym') || key.includes('weight');
}

function isRunning(activity: GarminActivity): boolean {
  const key = activity.activityType?.typeKey?.toLowerCase() ?? '';
  return key.includes('running') || key.includes('trail') || key.includes('treadmill');
}

// ─── Data summarization (reduce 200KB+ blobs to ~500 bytes) ──────────

/**
 * Summarize sleep data to key metrics only (raw is ~200KB of interval data).
 */
function summarizeSleep(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  // dailySleepDTO has the summary; sleepLevels/wellnessEpochSPO2DataDTOList are the big arrays
  const dto = (s.dailySleepDTO ?? s) as Record<string, unknown>;
  return {
    sleepTimeSeconds: dto.sleepTimeSeconds,
    deepSleepSeconds: dto.deepSleepSeconds,
    lightSleepSeconds: dto.lightSleepSeconds,
    remSleepSeconds: dto.remSleepSeconds,
    awakeSleepSeconds: dto.awakeSleepSeconds,
    sleepScores: dto.sleepScores,
    sleepQualityTypePK: dto.sleepQualityTypePK,
    averageSpO2Value: dto.averageSpO2Value,
    lowestSpO2Value: dto.lowestSpO2Value,
    averageRespirationValue: dto.averageRespirationValue,
    averageStress: dto.averageStress,
    bodyBatteryChange: dto.bodyBatteryChange,
    restlessMomentsCount: dto.restlessMomentsCount,
    sleepStartTimestampLocal: dto.sleepStartTimestampLocal,
    sleepEndTimestampLocal: dto.sleepEndTimestampLocal,
  };
}

/**
 * Summarize stress data (raw is ~23KB of interval values).
 */
function summarizeStress(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  return {
    overallStressLevel: s.overallStressLevel,
    restStressDuration: s.restStressDuration,
    activityStressDuration: s.activityStressDuration,
    lowStressDuration: s.lowStressDuration,
    mediumStressDuration: s.mediumStressDuration,
    highStressDuration: s.highStressDuration,
    stressQualifier: s.stressQualifier,
    maxStressLevel: s.maxStressLevel,
    averageStressLevel: s.averageStressLevel,
  };
}

/**
 * Summarize heart rate data (raw is ~11KB of interval values).
 */
function summarizeHeartRate(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  return {
    restingHeartRate: s.restingHeartRate,
    maxHeartRate: s.maxHeartRate,
    minHeartRate: s.minHeartRate,
    lastSevenDaysAvgRestingHeartRate: s.lastSevenDaysAvgRestingHeartRate,
    // heartRateValues is the big array — skip it
  };
}

/**
 * Summarize HRV data (raw is ~12KB).
 */
function summarizeHrv(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  // The summary is typically in hrvSummary or at top level
  const summary = (s.hrvSummary ?? s) as Record<string, unknown>;
  return {
    weeklyAvg: summary.weeklyAvg,
    lastNight: summary.lastNight,
    lastNightAvg: summary.lastNightAvg,
    lastNight5MinHigh: summary.lastNight5MinHigh,
    baseline: summary.baseline,
    status: summary.status,
    startTimestampLocal: summary.startTimestampLocal,
  };
}

/**
 * Extract a simple body battery summary from the events endpoint data.
 * The bodyBatteryValuesArray entries are: [timestamp, status, bbValue, ...]
 * Also merges values from dailySummary if available.
 */
function extractBodyBatterySummary(
  eventsData: unknown,
  summary: GarminDailySummary | null,
): BodyBatterySummary {
  const result: BodyBatterySummary = {
    current: null,
    highest: null,
    lowest: null,
    charged: summary?.bodyBatteryChargedValue ?? null,
    drained: summary?.bodyBatteryDrainedValue ?? null,
  };

  // Try to get values from dailySummary first (most reliable when available)
  if (summary) {
    result.highest = summary.bodyBatteryHighestValue ?? null;
    result.lowest = summary.bodyBatteryLowestValue ?? null;
    // Some summaries have a "most recent" field
    const mostRecent = (summary as Record<string, unknown>).bodyBatteryMostRecentValue;
    if (typeof mostRecent === 'number') result.current = mostRecent;
  }

  // Extract from events data (fallback or supplement)
  if (Array.isArray(eventsData)) {
    const allValues: number[] = [];
    for (const event of eventsData) {
      const bbArray = (event as Record<string, unknown>)?.bodyBatteryValuesArray;
      if (Array.isArray(bbArray)) {
        for (const entry of bbArray) {
          if (Array.isArray(entry) && typeof entry[2] === 'number') {
            allValues.push(entry[2]);
          }
        }
      }
    }
    if (allValues.length > 0) {
      result.current = result.current ?? allValues[allValues.length - 1];
      result.highest = result.highest ?? Math.max(...allValues);
      result.lowest = result.lowest ?? Math.min(...allValues);
    }
  }

  return result;
}

/**
 * Summarize activity details to essential coaching metrics only.
 * Raw activityDetails can be 20–30KB per activity (exercise sets, split intervals, etc.).
 * We extract just what the coach needs: training effect, key stats, and set summaries.
 */
export function summarizeActivityDetails(
  detailsMap: Map<number, unknown>,
): Record<number, unknown> {
  const result: Record<number, unknown> = {};
  for (const [id, raw] of detailsMap) {
    if (!raw || typeof raw !== 'object') {
      result[id] = null;
      continue;
    }
    const detail = raw as Record<string, unknown>;

    // Always keep training effect (small object)
    const trainingEffect = detail.trainingEffect;

    // Summarize the "extra" (exercise sets, splits, or running dynamics)
    const extra = detail.extra;
    let extraSummary: unknown = null;

    if (extra && typeof extra === 'object') {
      const e = extra as Record<string, unknown>;

      // Strength training: exerciseSets — just count sets/reps/exercises
      if (Array.isArray(e.exerciseSets)) {
        const sets = e.exerciseSets as Record<string, unknown>[];
        const exercises = new Map<string, { sets: number; totalReps: number; maxWeight: number }>();
        for (const set of sets) {
          const name = String(set.exerciseName ?? set.category ?? 'unknown');
          const reps = Number(set.repetitionCount ?? set.reps ?? 0);
          const weight = Number(set.weight ?? 0);
          const existing = exercises.get(name) ?? { sets: 0, totalReps: 0, maxWeight: 0 };
          existing.sets++;
          existing.totalReps += reps;
          existing.maxWeight = Math.max(existing.maxWeight, weight);
          exercises.set(name, existing);
        }
        extraSummary = {
          type: 'strength',
          totalSets: sets.length,
          totalReps: sets.reduce((sum, s) => sum + Number((s as Record<string, unknown>).repetitionCount ?? 0), 0),
          exercises: Object.fromEntries(exercises),
        };
      }
      // Running: summarize splits/dynamics
      else if (Array.isArray(e.lapDTOs) || e.summaryDTO) {
        const summary = e.summaryDTO as Record<string, unknown> | undefined;
        extraSummary = {
          type: 'running',
          avgPace: summary?.averageSpeed,
          maxPace: summary?.maxSpeed,
          avgCadence: summary?.averageRunCadence,
          avgHeartRate: summary?.averageHR,
          maxHeartRate: summary?.maxHR,
          totalAscent: summary?.elevationGain,
          groundContactTime: summary?.avgGroundContactTime,
          verticalOscillation: summary?.avgVerticalOscillation,
          lapCount: Array.isArray(e.lapDTOs) ? (e.lapDTOs as unknown[]).length : undefined,
        };
      }
      // Splits (cycling, etc.): summarize lap count
      else if (Array.isArray(e.lapDTOs || e.splitSummaries)) {
        const laps = (e.lapDTOs ?? e.splitSummaries) as unknown[];
        extraSummary = {
          type: 'splits',
          lapCount: laps.length,
        };
      }
    }

    result[id] = { trainingEffect, extra: extraSummary };
  }
  return result;
}
