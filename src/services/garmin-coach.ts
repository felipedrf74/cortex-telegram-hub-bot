// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Garmin Daily Coach — collects health/training data, analyzes it with the
 * Training coaching persona, and formats a structured coach briefing message.
 *
 * v2: Includes structured recommendations (JSON) that the bot can use to
 *     offer inline buttons for applying coach suggestions to the calendar.
 */
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';
import { now, startOfDay, endOfDay } from '../utils/date-parser';
import { escapeHtml, splitMessage } from '../utils/telegram-formatter';
import { fetchDailyCoachData, isGarminConfigured, GarminCoachData, summarizeActivityDetails } from './garmin';
import {
  getEvents,
  hasConnectedCalendarForUser,
  isAnyCalendarConfigured,
  CalendarSource,
  updateEvent as updateCalendarEvent,
} from './unified-calendar';
import { syncSessionWithCoachRecommendation } from './training-plans';
import { getDomainSystemPrompt } from './anthropic';
import { trackedCreate } from '../portal/anthropic-hook';
import { completeOneShotWithFallback } from './gemini-provider';
import { getLastCoachState } from '../domains/domain-handler';
import { getUserTimezoneById, isOwnerUserRef } from './user-service';
import { getDb } from './database';
import { appleHealthJsonSelectColumns, parseAppleHealthDataJson } from './apple-health-encryption';
import { requireTenantIdParam } from './tenant-scope';

const client = new Anthropic({
  apiKey: config.anthropic.apiKey,
  maxRetries: 3,
});

type AppleHealthCoachRow = {
  data_type: string;
  data_json: string;
  encrypted_data_json?: string | null;
};

type TodayCalendarEvent = { summary: string; start: string; end: string };
type TomorrowCalendarEvent = TodayCalendarEvent & { id: string; source: CalendarSource };

export type CoachAnalysisMeteringActor = 'user' | 'system';

export interface CoachAnalysisMeteringScope {
  actor: CoachAnalysisMeteringActor;
  userId: number;
  tenantId: number;
}

export const COACH_ANALYSIS_SYSTEM_METERING_USER_ID = 0;
export const COACH_ANALYSIS_SYSTEM_METERING_TENANT_ID = 0;
const COACH_ANALYSIS_MAX_TOKENS = 1800;
const COACH_PAYLOAD_MAX_CHARS = 16000;
const MAX_ACTIVITY_SUMMARIES = 8;
const MAX_SCHEDULE_CONTEXT_EVENTS = 6;
const TRAINING_EVENT_PATTERN = /\b(gym|treino|training|workout|strength|run|running|corrida|bike|cycling|cycle|swim|yoga|walk|tempo|interval|long run|ride|lift|lower body|upper body|full body|mobility|pilates)\b/i;

export function resolveCoachAnalysisMeteringScope(userId?: number | null, tenantId?: number | null): CoachAnalysisMeteringScope {
  if (typeof userId === 'number' && Number.isSafeInteger(userId) && userId > 0) {
    return {
      actor: 'user',
      userId,
      tenantId: typeof tenantId === 'number' && Number.isSafeInteger(tenantId) && tenantId > 0 ? tenantId : userId,
    };
  }
  return {
    actor: 'system',
    userId: COACH_ANALYSIS_SYSTEM_METERING_USER_ID,
    tenantId: COACH_ANALYSIS_SYSTEM_METERING_TENANT_ID,
  };
}

// ─── Coaching analysis prompt ─────────────────────────────────────────

const COACH_ANALYSIS_PROMPT = `You are analyzing daily health and training data for this athlete. Respond ONLY with the structured coach briefing — no preamble, no explanations outside the template.

RULES:
- Be direct, data-driven, no fluff — talk like a coach who uses this athlete's actual profile
- Every recommendation MUST cite specific available data points. If recovery data is missing, say that once and base advice on training/rest/calendar context without inventing metrics.
- Respect stored diet preferences and constraints when present. If none are present, give neutral recovery/fueling guidance.
- Use plain text only. Do not use HTML tags, markdown tables, code fences, dividers, or markdown headings.
- For tables/structured data, use aligned plain text with spaces or bullet points instead
- For exercise blocks, use short indented plain text, NOT triple backticks
- Keep the HUMAN-READABLE part under 2200 characters
- Use event timestamps exactly as provided in the payload. Do not assume timezone or delivery time.
- Do NOT echo raw payload JSON, provider traces, internal ids except event ids inside COACH_RECS, or a full non-training calendar dump.
- For visible event times, use the provided displayTime field only. Never print full ISO timestamps in the human-readable briefing.

DATA INTERPRETATION:
- recovery: compact, present-only recovery signals. If recovery.available is false, do not print per-field "No data"; write "Recovery data unavailable today" once.
- today.training: today's recorded activities, already summarized to key load metrics and activityDetails.
- tomorrow.trainingEvents: the athlete's calendar training sessions for tomorrow, each with id/source/title/time. This is the PRIMARY source for recommendations and COACH_RECS.
- tomorrow.scheduleContext: bounded non-training calendar context. Use it only to mention conflicts, tight windows, or recovery constraints; do not list every non-training event.
- tomorrow.garminWorkouts/tomorrow.garminTrainingPlan: Garmin's own scheduler, often empty. Use only as supplemental evidence.

OUTPUT FORMAT (follow exactly):

🏋️ NEXUS HUB — DAILY COACH BRIEFING
📅 {date}

TODAY'S SNAPSHOT
{2-5 compact lines with available recovery signals only. If none: "Recovery data unavailable today."}

TODAY'S TRAINING
{If today.training is empty: "Rest day — no recorded activities." Otherwise list each activity in one line with only key load metrics.}

ANALYSIS
{2-4 concise sentences: direct coaching assessment, flags only when supported by available data.}

TOMORROW'S PLAN
{For each tomorrow.trainingEvents item:}
{✅/⚠️/🔄/❌} {session_name}
  ⏰ {displayTime}
  Recommendation: {KEEP/MODIFY details/SWAP details/REST}
  Why: {1 concise data-driven explanation}

{If scheduleContext creates a real constraint, add ONE line: "Schedule context: ...". Do not list every non-training event.}

{If NO training found: "No training planned for tomorrow. Consider: {suggestion based on recovery/rest context}."}

TIP OF THE DAY
{One actionable tip: recovery, nutrition, electrolytes, mobility, or mindset.}

STRUCTURED RECOMMENDATIONS (REQUIRED):
After the human-readable briefing, output a JSON block wrapped in markers. This block is machine-parsed — the bot uses it to offer the athlete buttons to apply your recommendations to the calendar.

Format:
<!-- COACH_RECS_START -->
[
  {
    "eventId": "{id from tomorrowCalendar}",
    "source": "{source from tomorrowCalendar — 'outlook' or 'google'}",
    "action": "KEEP" | "MODIFY" | "SWAP" | "REST",
    "originalTitle": "{current event summary}",
    "newTitle": "{changed title if MODIFY/SWAP, else same as original}",
    "newStart": "{ISO time if rescheduling, else null}",
    "newEnd": "{ISO time if rescheduling, else null}",
    "summary": "{1-line description of the change for the button label}"
  }
]
<!-- COACH_RECS_END -->

RULES for the JSON block:
- Include ONLY events from tomorrow.trainingEvents (skip scheduleContext and non-training events)
- For KEEP: summary should be "Manter como planeado"
- For MODIFY: newTitle = modified name (e.g. "Corrida leve 30min" instead of "Corrida 10km"), summary = what changes
- For SWAP: newTitle = the replacement activity, summary = what and why
- For REST: summary = "Cancelar — descanso necessário", newTitle = "❌ CANCELLED — Coach rest day"
- Always output valid JSON — no trailing commas, no comments
- If there are NO training events tomorrow, output an empty array: []`;

// ─── Types ───────────────────────────────────────────────────────────

/** A structured recommendation for a single calendar event */
export interface CoachRecommendation {
  eventId: string;
  source: CalendarSource;
  action: 'KEEP' | 'MODIFY' | 'SWAP' | 'REST';
  originalTitle: string;
  newTitle: string | null;
  newStart: string | null;
  newEnd: string | null;
  summary: string;
  reason: string;
}

export interface CoachBriefingResult {
  message: string;
  recommendations: CoachRecommendation[];
  errors: string[];
  dataCollectionMs: number;
  analysisMs: number;
}

export interface CoachApplyResult {
  count: number;
  appliedRecommendations: CoachRecommendation[];
}

export interface CoachBriefingOptions {
  /**
   * Cron/report contexts must not trigger a fresh Garmin SSO login because
   * Garmin sends a security passcode email for each credentials login. Manual
   * Telegram `/coach` may leave this false so the interactive MFA flow works.
   */
  garminSilent?: boolean;
  /** Active tenant/data-owner scope. Required for production training reads/writes. */
  tenantId?: number;
  /** Authenticated actor to charge when generating for an active tenant. */
  meteringUserId?: number;
}

export interface CoachRecommendationApplyScope {
  userId?: number | null;
  tenantId?: number | null;
}

/**
 * Apply a single coach recommendation to the calendar.
 * REST recommendations intentionally keep the slot visible on the calendar
 * instead of deleting it outright so the athlete still sees the cancelled plan.
 */
export async function applyCoachRecommendation(
  rec: CoachRecommendation,
  scope: CoachRecommendationApplyScope = {},
): Promise<void> {
  if (rec.action === 'KEEP') return;
  const userId = requireTenantIdParam(scope.userId, 'applyCoachRecommendation.userId');
  const tenantId = requireTenantIdParam(scope.tenantId, 'applyCoachRecommendation');
  const scopedRec = {
    ...rec,
    userId,
    tenantId,
    timezone: getUserTimezoneById(userId),
  };

  if (rec.action === 'REST') {
    await updateCalendarEvent(
      {
        event_id: rec.eventId,
        new_title: rec.newTitle || `❌ CANCELLED — ${rec.originalTitle}`,
      },
      rec.source,
    );
    try {
      syncSessionWithCoachRecommendation(scopedRec);
    } catch (err) {
      logger.warn({ err, eventId: rec.eventId }, 'Coach apply updated the calendar but failed to sync the training session state');
    }
    return;
  }

  const updateData: { event_id: string; new_title?: string; new_start?: string; new_end?: string } = {
    event_id: rec.eventId,
  };

  if (rec.newTitle && rec.newTitle !== rec.originalTitle) {
    updateData.new_title = rec.newTitle;
  }
  if (rec.newStart) updateData.new_start = rec.newStart;
  if (rec.newEnd) updateData.new_end = rec.newEnd;

  await updateCalendarEvent(updateData, rec.source);

  try {
    syncSessionWithCoachRecommendation(scopedRec);
  } catch (err) {
    logger.warn({ err, eventId: rec.eventId }, 'Coach apply updated the calendar but failed to sync the training session state');
  }
}

/**
 * Apply coach recommendations from the latest stored briefing state.
 * The iOS route passes recommendation event ids, which we resolve against the
 * last fresh coach briefing for that user.
 */
export async function applyCoachRecommendations(
  userId: number | undefined,
  tenantId: number | undefined,
  recommendationIds?: string[] | null,
): Promise<CoachApplyResult> {
  if (!userId) {
    throw new Error('Missing user id for coach recommendation apply');
  }
  const scopedTenantId = requireTenantIdParam(tenantId, 'applyCoachRecommendations');

  const coachState = getLastCoachState(userId);
  if (!coachState || coachState.recommendations.length === 0) {
    throw new Error('No active coach recommendations found. Run /coach again first.');
  }

  const actionable = coachState.recommendations.filter((rec) => rec.action !== 'KEEP');
  if (actionable.length === 0) {
    return { count: 0, appliedRecommendations: [] };
  }

  const selected = recommendationIds?.length
    ? actionable.filter((rec) => recommendationIds.includes(rec.eventId))
    : actionable;

  if (selected.length === 0) {
    throw new Error('The selected coach recommendations expired or no longer match the latest briefing.');
  }

  for (const rec of selected) {
    await applyCoachRecommendation(rec, { userId, tenantId: scopedTenantId });
  }

  return {
    count: selected.length,
    appliedRecommendations: selected,
  };
}

// ─── Apple Health fallback for coach briefing ────────────────────────

/**
 * Build a GarminCoachData-compatible structure from Apple Health data
 * stored in the apple_health_data table. Returns null if no data exists.
 */
async function tryAppleHealthFallback(userId: number | undefined, errors: string[]): Promise<GarminCoachData | null> {
  if (!userId) return null;

  try {
    const db = getDb();
    const today = new Date().toISOString().slice(0, 10);
    const healthJsonColumns = appleHealthJsonSelectColumns(db);

    const rows = db.prepare(
      `SELECT data_type, ${healthJsonColumns} FROM apple_health_data WHERE user_id = ? AND date = ?`
    ).all(userId, today) as AppleHealthCoachRow[];

    if (rows.length === 0) return null;

    const dataMap: Record<string, any> = {};
    for (const row of rows) {
      try { dataMap[row.data_type] = parseAppleHealthDataJson(row, userId); } catch {}
    }

    // Build a partial GarminCoachData from Apple Health signals
    const sleepData = dataMap.sleep;
    const sleepObj = sleepData ? {
      sleepScoreQualifier: sleepData.totalMinutes >= 420 ? 'GOOD' : sleepData.totalMinutes >= 360 ? 'FAIR' : 'POOR',
      sleepDurationHours: (sleepData.totalMinutes || 0) / 60,
      deepSleepMinutes: sleepData.deepMinutes || 0,
      remSleepMinutes: sleepData.remMinutes || 0,
      overallScore: Math.round((sleepData.totalMinutes || 0) / 480 * 100),
    } : null;

    const result: any = {
      sleep: sleepObj,
      restingHeartRate: dataMap.resting_hr?.bpm ?? null,
      hrvMs: dataMap.hrv?.sdnn_ms ?? null,
      bodyBattery: null,
      stress: null,
      activities: dataMap.workouts || [],
      readiness: null,
      steps: dataMap.steps?.count ?? 0,
      errors: [],
      source: 'apple_health',
    };
    return result;
  } catch (err) {
    errors.push(`Apple Health fallback failed: ${(err as Error).message}`);
    return null;
  }
}

function isTrainingCalendarEvent(event: Pick<TomorrowCalendarEvent, 'summary'>): boolean {
  return TRAINING_EVENT_PATTERN.test(event.summary);
}

function isMissingString(value: string): boolean {
  return /^(no data|n\/a|null|undefined|unknown)$/i.test(value.trim());
}

function compactCoachValue(value: unknown, depth = 0): unknown | undefined {
  if (value == null || depth > 6) return undefined;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || isMissingString(trimmed)) return undefined;
    return trimmed.length > 320 ? `${trimmed.slice(0, 317)}...` : trimmed;
  }

  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value;

  if (Array.isArray(value)) {
    const items = value
      .slice(0, 12)
      .map((item) => compactCoachValue(item, depth + 1))
      .filter((item) => item !== undefined);
    return items.length > 0 ? items : undefined;
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>).slice(0, 28)) {
      const compacted = compactCoachValue(raw, depth + 1);
      if (compacted !== undefined) out[key] = compacted;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  return undefined;
}

function pickCompactFields(source: unknown, keys: string[]): Record<string, unknown> | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const src = source as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(src, key)) picked[key] = src[key];
  }
  return compactCoachValue(picked) as Record<string, unknown> | undefined;
}

function hasBodyBatterySignal(summary?: GarminCoachData['bodyBatterySummary'] | null): boolean {
  if (!summary) return false;
  return Object.values(summary).some((value) => typeof value === 'number' && Number.isFinite(value));
}

function buildRecoveryPayload(garminData: GarminCoachData): Record<string, unknown> {
  const fallbackData = garminData as unknown as Record<string, unknown>;
  const fallbackHeartRate = compactCoachValue({
    restingHeartRate: fallbackData.restingHeartRate,
  });
  const fallbackHrv = compactCoachValue({
    hrvMs: fallbackData.hrvMs,
  });

  const signals = compactCoachValue({
    sleep: garminData.sleepSummary ?? fallbackData.sleep,
    heartRate: garminData.heartRateSummary ?? fallbackHeartRate,
    hrv: garminData.hrvSummary ?? fallbackHrv,
    bodyBattery: hasBodyBatterySignal(garminData.bodyBatterySummary) ? garminData.bodyBatterySummary : fallbackData.bodyBattery,
    stress: garminData.stressSummary ?? fallbackData.stress,
    trainingReadiness: garminData.trainingReadiness ?? fallbackData.readiness,
    trainingStatus: garminData.trainingStatus,
  }) as Record<string, unknown> | undefined;

  return signals
    ? { available: true, signals }
    : { available: false, note: 'Recovery data unavailable today' };
}

function extractClockMinutes(value: string): { label: string; minutes: number } | null {
  const match = value.match(/T(\d{2}):(\d{2})/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  return {
    label: `${match[1]}:${match[2]}`,
    minutes: hours * 60 + minutes,
  };
}

function formatCoachDisplayTime(start: string, end: string): string {
  const startClock = extractClockMinutes(start);
  const endClock = extractClockMinutes(end);
  if (!startClock || !endClock) {
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
    return dateOnly.test(start) && dateOnly.test(end) ? 'All day' : 'Time unavailable';
  }

  let durationMin = endClock.minutes - startClock.minutes;
  if (durationMin < 0) durationMin += 24 * 60;
  const duration = durationMin > 0 ? ` (${durationMin} min)` : '';
  return `${startClock.label}-${endClock.label}${duration}`;
}

function normalizeCoachVisibleTimestamps(text: string): string {
  const iso = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2})?(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})?';
  const pair = new RegExp(`(${iso})\\s*(?:–|—|-|to)\\s*(${iso})`, 'gi');
  const single = new RegExp(iso, 'gi');
  return text
    .replace(pair, (_match, start: string, end: string) => formatCoachDisplayTime(start, end))
    .replace(single, (value) => extractClockMinutes(value)?.label ?? 'Time unavailable');
}

function summarizeActivitiesForCoach(
  activities: GarminCoachData['activities'],
  activityDetails: Record<number, unknown>,
): Record<string, unknown>[] {
  return activities.slice(0, MAX_ACTIVITY_SUMMARIES).map((activity) => {
    const distanceKm = typeof activity.distance === 'number'
      ? Number((activity.distance / 1000).toFixed(2))
      : undefined;
    return compactCoachValue({
      id: activity.activityId,
      name: activity.activityName,
      type: activity.activityType?.typeKey,
      start: activity.startTimeLocal,
      durationMin: Math.round((activity.duration || 0) / 60),
      distanceKm,
      avgHr: activity.averageHR,
      maxHr: activity.maxHR,
      calories: activity.calories,
      cadence: activity.averageRunningCadenceInStepsPerMinute,
      avgSpeed: activity.averageSpeed,
      elevationGain: activity.elevationGain,
      details: activityDetails[activity.activityId],
    }) as Record<string, unknown>;
  }).filter((activity) => Object.keys(activity).length > 0);
}

function toCoachCalendarEvent(event: TomorrowCalendarEvent): Record<string, unknown> {
  return compactCoachValue({
    id: event.id,
    source: event.source,
    title: event.summary,
    start: event.start,
    end: event.end,
    displayTime: formatCoachDisplayTime(event.start, event.end),
  }) as Record<string, unknown>;
}

function toScheduleContextEvent(event: TodayCalendarEvent): Record<string, unknown> {
  return compactCoachValue({
    title: event.summary,
    start: event.start,
    end: event.end,
    displayTime: formatCoachDisplayTime(event.start, event.end),
  }) as Record<string, unknown>;
}

function buildScheduleContext(events: TodayCalendarEvent[]): Record<string, unknown> | undefined {
  if (events.length === 0) return undefined;
  return compactCoachValue({
    count: events.length,
    events: events.slice(0, MAX_SCHEDULE_CONTEXT_EVENTS).map(toScheduleContextEvent),
    omittedCount: Math.max(0, events.length - MAX_SCHEDULE_CONTEXT_EVENTS) || undefined,
  }) as Record<string, unknown> | undefined;
}

function buildCoachAnalysisPayload(
  garminData: GarminCoachData,
  todayCalendarEvents: TodayCalendarEvent[],
  tomorrowCalendarEvents: TomorrowCalendarEvent[],
  activityDetails: Record<number, unknown>,
): Record<string, unknown> {
  const fallbackData = garminData as unknown as Record<string, unknown>;
  const tomorrowTrainingEvents = tomorrowCalendarEvents.filter(isTrainingCalendarEvent);
  const tomorrowScheduleEvents = tomorrowCalendarEvents.filter((event) => !isTrainingCalendarEvent(event));
  const dailySummary = compactCoachValue({
    ...pickCompactFields(garminData.summary, [
    'totalSteps',
    'steps',
    'activeKilocalories',
    'bmrKilocalories',
    'consumedKilocalories',
    'moderateIntensityMinutes',
    'vigorousIntensityMinutes',
    'intensityMinutesGoal',
    'restingHeartRate',
    'bodyBatteryMostRecentValue',
    'bodyBatteryHighestValue',
    'bodyBatteryLowestValue',
    'bodyBatteryChargedValue',
    'bodyBatteryDrainedValue',
    ]),
    steps: fallbackData.steps,
    source: fallbackData.source,
  }) as Record<string, unknown> | undefined;

  return compactCoachValue({
    date: garminData.date,
    recovery: buildRecoveryPayload(garminData),
    today: {
      training: summarizeActivitiesForCoach(garminData.activities, activityDetails),
      activityCount: garminData.activities.length,
      omittedActivityCount: Math.max(0, garminData.activities.length - MAX_ACTIVITY_SUMMARIES) || undefined,
      dailySummary,
      calendarContext: buildScheduleContext(todayCalendarEvents),
    },
    tomorrow: {
      trainingEvents: tomorrowTrainingEvents.map(toCoachCalendarEvent),
      scheduleContext: buildScheduleContext(tomorrowScheduleEvents),
      garminWorkouts: compactCoachValue(garminData.tomorrowWorkouts),
      garminTrainingPlan: compactCoachValue(garminData.tomorrowTrainingPlan),
    },
    trends: compactCoachValue({
      weeklyStress: garminData.weeklyStress,
      weeklyIntensityMinutes: garminData.weeklyIntensityMinutes,
    }),
    dataGaps: compactCoachValue(garminData.errors),
  }) as Record<string, unknown>;
}

// ─── Main coach function ──────────────────────────────────────────────

export async function generateCoachBriefing(
  userId?: number,
  opts: CoachBriefingOptions = {},
): Promise<CoachBriefingResult> {
  const briefingTenantId = requireTenantIdParam(opts.tenantId, 'generateCoachBriefing');
  const errors: string[] = [];
  const collectStart = Date.now();
  let garminData: GarminCoachData | null = null;
  const canUseScopedGarmin = isGarminConfigured() && (userId == null || isOwnerUserRef(userId));

  // ── Data source resolution ─────────────────────────────────
  // Priority: Garmin (richer data) → Apple Health (HealthKit sync)
  // Apple Health users sync via POST /health-data/sync from iOS;
  // data lives in apple_health_data table.
  if (canUseScopedGarmin) {
    try {
      garminData = await fetchDailyCoachData({ silent: opts.garminSilent });
      errors.push(...garminData.errors);
    } catch (err) {
      logger.error({ err }, 'Garmin data collection failed completely');
      // Try Apple Health fallback before giving up
      garminData = await tryAppleHealthFallback(userId, errors);
      if (!garminData) {
        return {
          message: '⚠️ Coach briefing failed\n\nHealth data unavailable. Connect Garmin or sync Apple Health.',
          recommendations: [],
          errors: [(err as Error).message],
          dataCollectionMs: Date.now() - collectStart,
          analysisMs: 0,
        };
      }
    }
  } else {
    // No Garmin — try Apple Health
    garminData = await tryAppleHealthFallback(userId, errors);
    if (!garminData) {
      throw new Error('No health data source configured. Connect Garmin or sync Apple Health from your iPhone.');
    }
  }
  const dataCollectionMs = Date.now() - collectStart;

  // Phase 2: Fetch today + tomorrow calendar (if configured)
  // Include id + source so Claude can reference them in structured recommendations
  let todayCalendarEvents: TodayCalendarEvent[] = [];
  let tomorrowCalendarEvents: TomorrowCalendarEvent[] = [];
  const hasCalendar = userId != null ? hasConnectedCalendarForUser(userId) : isAnyCalendarConfigured();
  if (hasCalendar) {
    try {
      const today = now();
      const tomorrow = today.plus({ days: 1 });
      const [todayEvents, tomorrowEvents] = await Promise.all([
        getEvents(today.startOf('day').toISO()!, today.endOf('day').toISO()!, userId),
        getEvents(tomorrow.startOf('day').toISO()!, tomorrow.endOf('day').toISO()!, userId),
      ]);
      todayCalendarEvents = todayEvents.map((e) => ({
        summary: e.summary,
        start: e.start,
        end: e.end,
      }));
      tomorrowCalendarEvents = tomorrowEvents.map((e) => ({
        id: e.id,
        source: e.source,
        summary: e.summary,
        start: e.start,
        end: e.end,
      }));
    } catch (err) {
      errors.push(`calendar: ${(err as Error).message}`);
    }
  }

  // Log calendar fetch results for debugging
  logger.info({
    todayCalendarCount: todayCalendarEvents.length,
    tomorrowCalendarCount: tomorrowCalendarEvents.length,
    tomorrowTraining: tomorrowCalendarEvents
      .filter(isTrainingCalendarEvent)
      .map((e) => e.summary),
    activitiesCount: garminData.activities.length,
    activitiesNames: garminData.activities.map((a) => a.activityName),
  }, 'Coach: data collection summary');

  // Phase 3: Prepare data payload for Claude
  // Summarize activity details (~24KB raw → ~1KB) to prevent payload bloat
  const activityDetailsObj = summarizeActivityDetails(garminData.activityDetails);

  const dataPayload = buildCoachAnalysisPayload(
    garminData,
    todayCalendarEvents,
    tomorrowCalendarEvents,
    activityDetailsObj,
  );

  // Compact JSON keeps the prompt focused on coaching signal instead of
  // whitespace, repeated nulls, and full non-training calendar dumps.
  const rawPayload = JSON.stringify(dataPayload);
  const payloadStr = truncatePayload(rawPayload, COACH_PAYLOAD_MAX_CHARS);
  logger.info({
    rawPayloadLength: rawPayload.length,
    truncated: rawPayload.length > COACH_PAYLOAD_MAX_CHARS,
    tomorrowTrainingInPayload: (dataPayload.tomorrow as any)?.trainingEvents?.length ?? 0,
    tomorrowScheduleContextCount: (dataPayload.tomorrow as any)?.scheduleContext?.count ?? 0,
  }, 'Coach: payload stats');

  // Phase 4: AI analysis (Gemini primary, Anthropic fallback)
  const analysisStart = Date.now();
  try {
    const today = now().toFormat('cccc, LLLL dd yyyy');
    const systemPrompt = `${getDomainSystemPrompt('triathlon')}\n\n${COACH_ANALYSIS_PROMPT}`;
    const userPrompt = `DAILY COACHING ANALYSIS — ${today}

## COMPACT COACH INPUT
${payloadStr}

## INSTRUCTIONS
1. Analyze my recovery status and today's training load
2. For each scheduled workout tomorrow, recommend: KEEP / MODIFY / SWAP / REST
3. Every recommendation must reference specific available data points. If recovery.available=false, say recovery data is unavailable once and do not print per-field "No data" lines.
4. Flag recovery, fueling, or schedule concerns only when supported by payload or profile data
5. Include one actionable tip
6. Be direct, no fluff — talk like a coach using this athlete's actual profile
7. Use plain text only; no HTML tags
8. Keep the human-readable briefing under 2200 characters
9. Use displayTime for visible event times; do not print full ISO timestamps in TOMORROW'S PLAN
10. At the END, include the structured COACH_RECS JSON block for calendar actions`;

    // Gemini-first routing for cost reduction. coach_analysis is the single
    // largest cost line in the system (~$1.62/wk on Sonnet 4.6 at 1 user).
    // gemini-2.5-flash is ~9.5× cheaper for the same input/output volume and
    // matches Sonnet quality for analytical prompts of this shape.
    // Falls back to Anthropic if Gemini is not configured or fails. See
    // audit P0-8.
    const meteringScope = resolveCoachAnalysisMeteringScope(
      opts.meteringUserId ?? userId,
      briefingTenantId,
    );
    const meteringScopePayload = { userId: meteringScope.userId, tenantId: meteringScope.tenantId };
    const meteringUserId = meteringScopePayload.userId;
    const meteringTenantId = meteringScopePayload.tenantId;
    const coachAnalysisMeteringOptions = { maxTokens: COACH_ANALYSIS_MAX_TOKENS, userId: meteringUserId, tenantId: meteringTenantId };
    const coachAnalysisScopeBoundary = { maxTokens: COACH_ANALYSIS_MAX_TOKENS, userId: meteringScope.userId, tenantId: meteringScope.tenantId };
    if (
      coachAnalysisMeteringOptions.userId !== coachAnalysisScopeBoundary.userId ||
      coachAnalysisMeteringOptions.tenantId !== coachAnalysisScopeBoundary.tenantId
    ) {
      throw new Error('Coach analysis metering scope mismatch');
    }
    // Local-LLM pilot (2026-07-04): optionally capture the exact prompt
    // payload for offline side-by-side eval (scripts/coach-local-eval.mjs).
    // Default off; never throws; no behavior change otherwise.
    if (process.env.GARMIN_COACH_CAPTURE_PROMPT === 'true') {
      try {
        const captureDir = path.resolve(process.cwd(), '.local', 'coach-payloads');
        fs.mkdirSync(captureDir, { recursive: true });
        const capturePath = path.join(captureDir, `coach-${Date.now()}-u${meteringScope.userId}.json`);
        fs.writeFileSync(capturePath, JSON.stringify({
          capturedAt: new Date().toISOString(),
          userId: meteringScope.userId,
          systemPrompt,
          userPrompt,
          maxTokens: COACH_ANALYSIS_MAX_TOKENS,
        }, null, 2));
        logger.debug({ capturePath }, 'Coach: prompt payload captured for offline eval');
      } catch (captureErr) {
        logger.debug({ err: captureErr }, 'Coach: prompt payload capture failed (non-critical)');
      }
    }
    const { text: rawText, provider: analysisProvider } = await completeOneShotWithFallback(
      systemPrompt,
      userPrompt,
      'coach_analysis',
      async () => {
        const response = await trackedCreate(client, {
          model: config.anthropic.model,
          max_tokens: COACH_ANALYSIS_MAX_TOKENS,
          system: [
            {
              type: 'text',
              text: getDomainSystemPrompt('triathlon'),
              cache_control: { type: 'ephemeral' },
            },
            {
              type: 'text',
              text: COACH_ANALYSIS_PROMPT,
            },
          ],
          messages: [{ role: 'user', content: userPrompt }],
        }, 'coach_analysis', { userId: meteringUserId, tenantId: meteringTenantId });
        return response.content
          .filter((c): c is Anthropic.TextBlock => c.type === 'text')
          .map((c) => c.text)
          .join('');
      },
      { maxTokens: COACH_ANALYSIS_MAX_TOKENS, userId: meteringUserId, tenantId: meteringTenantId },
    );

    const analysisMs = Date.now() - analysisStart;
    logger.info(
      { provider: analysisProvider, analysisMs, meteringActor: meteringScope.actor },
      `Coach analysis completed via ${analysisProvider}`,
    );

    if (!rawText.trim()) {
      return {
        message: '⚠️ Coach analysis returned empty.\n\nTry /coach again.',
        recommendations: [],
        errors: [...errors, `${analysisProvider} returned empty response`],
        dataCollectionMs,
        analysisMs,
      };
    }

    // Extract structured recommendations JSON from the response
    const { humanMessage, recommendations } = extractRecommendations(rawText);

    // Sanitize any markdown/unsafe fragments that the model may have output
    const cleanMessage = sanitizeMarkdownForTelegram(normalizeCoachVisibleTimestamps(humanMessage));

    // Append data collection info as a footer
    const footer = `\n\n📊 Data: ${(dataCollectionMs / 1000).toFixed(1)}s | Analysis: ${(analysisMs / 1000).toFixed(1)}s${errors.length > 0 ? ` | ⚠️ ${errors.length} data gap(s)` : ''}`;

    return {
      message: cleanMessage + footer,
      recommendations,
      errors,
      dataCollectionMs,
      analysisMs,
    };
  } catch (err) {
    logger.error({ err }, 'Coach analysis failed');
    return {
      message: '⚠️ Coach analysis failed\n\nAI provider error. Try /coach later.',
      recommendations: [],
      errors: [...errors, (err as Error).message],
      dataCollectionMs,
      analysisMs: Date.now() - analysisStart,
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Extract the COACH_RECS JSON block from Claude's response.
 * Returns the human-readable message (without the JSON block) and parsed recommendations.
 */
function extractRecommendations(text: string): {
  humanMessage: string;
  recommendations: CoachRecommendation[];
} {
  const startMarker = '<!-- COACH_RECS_START -->';
  const endMarker = '<!-- COACH_RECS_END -->';

  const startIdx = text.indexOf(startMarker);
  const endIdx = text.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    // No structured block found — return the whole text as the message
    logger.warn('Coach: no COACH_RECS block found in response');
    return { humanMessage: stripCoachRecommendationArtifacts(text).trim(), recommendations: [] };
  }

  // Split human message from JSON block
  const humanMessage = stripCoachRecommendationArtifacts(text.substring(0, startIdx)).trim();
  const jsonStr = text.substring(startIdx + startMarker.length, endIdx).trim();

  try {
    const raw = JSON.parse(jsonStr);
    if (!Array.isArray(raw)) {
      logger.warn({ raw }, 'Coach: COACH_RECS is not an array');
      return { humanMessage, recommendations: [] };
    }

    const recommendations: CoachRecommendation[] = raw
      .filter((r: any) => r.eventId && r.action)
      .map((r: any) => ({
        eventId: String(r.eventId),
        source: (r.source === 'google' ? 'google' : 'outlook') as CalendarSource,
        action: (['KEEP', 'MODIFY', 'SWAP', 'REST'].includes(r.action) ? r.action : 'KEEP') as CoachRecommendation['action'],
        originalTitle: String(r.originalTitle ?? ''),
        newTitle: r.newTitle ?? null,
        newStart: r.newStart ?? null,
        newEnd: r.newEnd ?? null,
        summary: String(r.summary ?? ''),
        reason: String(r.reason ?? r.summary ?? ''),
      }));

    logger.info({ count: recommendations.length }, 'Coach: parsed structured recommendations');
    return { humanMessage, recommendations };
  } catch (err) {
    logger.warn({ err, jsonStr: jsonStr.substring(0, 200) }, 'Coach: failed to parse COACH_RECS JSON');
    return { humanMessage, recommendations: [] };
  }
}

function stripCoachRecommendationArtifacts(text: string): string {
  const withoutMarkers = text
    .replace(/<!--\s*COACH_RECS_START\s*-->[\s\S]*?(?:<!--\s*COACH_RECS_END\s*-->|$)/gi, '')
    .replace(/<!--\s*COACH_RECS_END\s*-->/gi, '')
    .replace(/\bCOACH_RECS_START\b[\s\S]*?(?:\bCOACH_RECS_END\b|$)/gi, '')
    .replace(/\bCOACH_RECS_END\b/gi, '');
  return stripTrailingCoachRecommendationJson(withoutMarkers);
}

function stripTrailingCoachRecommendationJson(text: string): string {
  const arrayStart = text.lastIndexOf('[');
  if (arrayStart === -1) return text;

  const rawCandidate = text.slice(arrayStart).trim().replace(/```\s*$/i, '').trim();
  let looksLikeRecommendationJson = /["']?(?:eventId|source|action)["']?\s*:/.test(rawCandidate);
  try {
    const parsed = JSON.parse(rawCandidate);
    looksLikeRecommendationJson = Array.isArray(parsed) && (
      parsed.length === 0
      || parsed.every((item) => item && typeof item === 'object' && ('eventId' in item || 'action' in item))
    );
  } catch {
    // A malformed recommendation tail is still internal output when it
    // contains the machine-only action fields above.
  }
  if (!looksLikeRecommendationJson) return text;

  const fenceStart = text.lastIndexOf('```', arrayStart);
  const cutAt = fenceStart !== -1 && /^```(?:json)?\s*$/i.test(text.slice(fenceStart, arrayStart).trim())
    ? fenceStart
    : arrayStart;
  return text.slice(0, cutAt).trimEnd();
}

/**
 * Convert markdown artifacts to Telegram-safe HTML/plain text.
 * Claude sometimes outputs markdown despite HTML instructions.
 */
function sanitizeMarkdownForTelegram(text: string): string {
  let s = text;
  // Remove code fences (```lang ... ```)  →  keep inner content
  s = s.replace(/```[\w]*\n?([\s\S]*?)```/g, '$1');
  // Convert markdown bold **text** → <b>text</b>  (avoid double-wrapping if already HTML)
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  // Convert markdown italic *text* → <i>text</i>  (single asterisk, not inside bold)
  s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<i>$1</i>');
  // Convert markdown headers ### Text → <b>Text</b>
  s = s.replace(/^#{1,4}\s+(.+)$/gm, '<b>$1</b>');
  // Remove horizontal rules ---  or ___
  s = s.replace(/^[-_]{3,}\s*$/gm, '');
  // Convert markdown tables: | col | col | → space-aligned plain text
  // Remove header separator rows like |---|---|
  s = s.replace(/^\|[-\s|:]+\|\s*$/gm, '');
  // Convert table rows | a | b | c | → "a  •  b  •  c"
  s = s.replace(/^\|(.+)\|\s*$/gm, (_match, inner: string) => {
    return inner.split('|').map((c: string) => c.trim()).filter(Boolean).join('  •  ');
  });
  // Escape stray '<' that aren't valid HTML tags (e.g. "<5h58m", "<100 bpm")
  // Valid Telegram HTML tags: b, i, u, s, a, code, pre, em, strong, del, ins, span, tg-spoiler, tg-emoji, blockquote
  s = s.replace(/<(?!\/?(?:b|i|u|s|a|code|pre|em|strong|del|ins|span|tg-spoiler|tg-emoji|blockquote)[\s>\/])/gi, '&lt;');
  // Collapse triple+ newlines to double
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/**
 * Truncate a JSON payload to maxChars while keeping valid structure.
 * Cuts from the end and adds an ellipsis marker.
 */
function truncatePayload(payload: string, maxChars: number): string {
  if (payload.length <= maxChars) return payload;
  return payload.substring(0, maxChars) + '\n\n... [DATA TRUNCATED — remaining data omitted to fit context window]';
}
