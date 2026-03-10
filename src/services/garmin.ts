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

export interface GarminCoachData {
  date: string;
  summary: GarminDailySummary | null;
  sleep: unknown;
  stress: unknown;
  heartRate: unknown;
  hrv: unknown;
  trainingReadiness: unknown;
  trainingStatus: unknown;
  bodyBattery: unknown;
  rhr: unknown;
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

/** Force re-authentication (call when tokens expire mid-session) */
async function reauthenticate(): Promise<InstanceType<typeof GarminConnect>> {
  _authenticated = false;
  _client = null;
  return getClient();
}

/**
 * Safe GET — retries once with re-auth if the first attempt fails with 401/403.
 */
async function safeGet<T = unknown>(url: string): Promise<T> {
  const client = await getClient();
  try {
    return await client.get(url) as T;
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 401 || status === 403) {
      logger.warn('Garmin: auth expired mid-session, re-authenticating');
      const freshClient = await reauthenticate();
      return await freshClient.get(url) as T;
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

  return {
    date: today,
    summary: summary as GarminDailySummary | null,
    sleep,
    stress,
    heartRate,
    hrv,
    trainingReadiness,
    trainingStatus,
    bodyBattery,
    rhr,
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
