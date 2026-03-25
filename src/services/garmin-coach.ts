/**
 * Garmin Daily Coach — collects Garmin data, analyzes with Claude using
 * the Triatlon coaching persona, and formats a Telegram briefing message.
 *
 * v2: Includes structured recommendations (JSON) that the bot can use to
 *     offer inline buttons for applying coach suggestions to the calendar.
 */
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { logger } from '../utils/logger';
import { now, startOfDay, endOfDay } from '../utils/date-parser';
import { escapeHtml, splitMessage } from '../utils/telegram-formatter';
import { fetchDailyCoachData, isGarminConfigured, GarminCoachData, summarizeActivityDetails } from './garmin';
import { getEvents, isAnyCalendarConfigured, CalendarSource } from './unified-calendar';
import { getDomainSystemPrompt } from './anthropic';
import { trackedCreate } from '../portal/anthropic-hook';

const client = new Anthropic({
  apiKey: config.anthropic.apiKey,
  maxRetries: 3,
});

// ─── Coaching analysis prompt ─────────────────────────────────────────

const COACH_ANALYSIS_PROMPT = `You are analyzing daily health and training data for your athlete. Respond ONLY with the structured Telegram briefing — no preamble, no explanations outside the template.

RULES:
- Be direct, data-driven, no fluff — talk like a coach who knows this athlete
- Every recommendation MUST cite specific data points
- Carnivore diet framework: never suggest plant-based nutrition
- Use ONLY Telegram HTML tags: <b>bold</b>, <i>italic</i>, <code>monospace</code>
- NEVER use markdown syntax: no triple-backtick code fences, no | tables |, no --- dividers, no # headers, no ** bold **, no * italic *
- For tables/structured data, use aligned plain text with spaces or bullet points instead
- For code/exercise blocks, use <code> tags or plain indented text, NOT triple backticks
- Keep the HUMAN-READABLE part under 3800 characters (Telegram limit is 4096)
- All times in Europe/Lisbon timezone

DATA INTERPRETATION:
- <b>bodyBatterySummary</b>: pre-extracted body battery values (current, highest, lowest, charged, drained). ALWAYS use these in the snapshot section, even if the raw bodyBattery events data seems complex.
- <b>activities</b>: today's recorded Garmin activities. Check activityDetails for training effect. For strength_training, look for exerciseSets.
- <b>tomorrowCalendar</b>: the athlete's CALENDAR events for tomorrow, each with an "id" and "source" field. This is the PRIMARY source for tomorrow's training plan — training sessions are scheduled on the calendar (not in Garmin's workout planner). Look for events whose summary contains training-related keywords (gym, treino, corrida, bike, swim, yoga, strength, run, cycling, etc.).
- <b>tomorrowScheduledWorkouts</b> and <b>tomorrowTrainingPlan</b>: Garmin's own workout scheduler (often empty — the athlete uses calendar instead).

OUTPUT FORMAT (follow exactly):

🏋️ <b>CORTEX — DAILY COACH BRIEFING</b>
📅 {date} — 21:00

━━━ <b>TODAY'S SNAPSHOT</b> ━━━
🛌 Sleep: {hours}h ({quality})
💓 RHR: {bpm} | HRV: {ms}
🔋 Body Battery: {current}/{highest recharged} (lowest: {lowest})
😰 Stress: {avg} ({low/medium/high})
🏃 Training Readiness: {score}/100

━━━ <b>TODAY'S TRAINING</b> ━━━
{For each activity in activities array:}
• <b>{activityName or activity_type}</b>: {duration}, {distance if applicable}
  Training Effect: {aerobic}/{anaerobic}
  {Key metrics: calories, avg HR, max HR, sets/reps for strength}

{If activities array is empty: "Rest day — no recorded activities."}

━━━ <b>ANALYSIS</b> ━━━
{2-4 sentences: direct coaching assessment}
{Flag concerns: overtraining, undereating, poor sleep, elevated RHR}

━━━ <b>TOMORROW'S PLAN</b> ━━━
{Check BOTH tomorrowCalendar AND tomorrowScheduledWorkouts/tomorrowTrainingPlan.}
{Calendar events with training keywords ARE planned sessions.}
{For each planned session:}
{✅/⚠️/🔄/❌} <b>{session_name}</b>
  ⏰ {start_time} – {end_time}
  Recommendation: {KEEP/MODIFY details/SWAP details/REST}
  Why: {1-2 sentence data-driven explanation}

{Non-training calendar events → list briefly as schedule context:}
⏰ <b>Schedule:</b> {event1 time, event2 time, ...}

{If NO training found in calendar AND no Garmin workouts: "No training planned for tomorrow. Consider: {suggestion based on recovery data}."}

━━━ 💡 <b>TIP OF THE DAY</b> ━━━
{One actionable tip: recovery, nutrition, electrolytes, mobility, mindset}

RECOMMENDATION KEY:
- ✅ KEEP = Recovery supports planned session, execute as planned
- ⚠️ MODIFY = Partial recovery, reduce intensity/volume (specify exact changes)
- 🔄 SWAP = Wrong session type for current state, suggest alternative
- ❌ REST = Insufficient recovery, injury risk, explain why

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
- Include ONLY training events from tomorrowCalendar (skip non-training events)
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
}

export interface CoachBriefingResult {
  message: string;
  recommendations: CoachRecommendation[];
  errors: string[];
  dataCollectionMs: number;
  analysisMs: number;
}

// ─── Main coach function ──────────────────────────────────────────────

export async function generateCoachBriefing(): Promise<CoachBriefingResult> {
  if (!isGarminConfigured()) {
    throw new Error('Garmin not configured. Set GARMIN_EMAIL and GARMIN_PASSWORD.');
  }

  const errors: string[] = [];

  // Phase 1: Collect Garmin data
  const collectStart = Date.now();
  let garminData: GarminCoachData;
  try {
    garminData = await fetchDailyCoachData();
    errors.push(...garminData.errors);
  } catch (err) {
    logger.error({ err }, 'Garmin data collection failed completely');
    return {
      message: '⚠️ <b>Coach briefing failed</b>\n\nGarmin data unavailable tonight. Try /coach later or check connection.',
      recommendations: [],
      errors: [(err as Error).message],
      dataCollectionMs: Date.now() - collectStart,
      analysisMs: 0,
    };
  }
  const dataCollectionMs = Date.now() - collectStart;

  // Phase 2: Fetch today + tomorrow calendar (if configured)
  // Include id + source so Claude can reference them in structured recommendations
  let todayCalendarEvents: { summary: string; start: string; end: string }[] = [];
  let tomorrowCalendarEvents: { id: string; source: CalendarSource; summary: string; start: string; end: string }[] = [];
  if (isAnyCalendarConfigured()) {
    try {
      const today = now();
      const tomorrow = today.plus({ days: 1 });
      const [todayEvents, tomorrowEvents] = await Promise.all([
        getEvents(today.startOf('day').toISO()!, today.endOf('day').toISO()!),
        getEvents(tomorrow.startOf('day').toISO()!, tomorrow.endOf('day').toISO()!),
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
      .filter((e) => /gym|treino|corrida|bike|swim|yoga|strength|run|cycling|walk|easy|tempo|interval/i.test(e.summary))
      .map((e) => e.summary),
    activitiesCount: garminData.activities.length,
    activitiesNames: garminData.activities.map((a) => a.activityName),
  }, 'Coach: data collection summary');

  // Phase 3: Prepare data payload for Claude
  // Summarize activity details (~24KB raw → ~1KB) to prevent payload bloat
  const activityDetailsObj = summarizeActivityDetails(garminData.activityDetails);

  // Build payload ordered by priority for the coach analysis:
  //   1. Date + recovery metrics (critical for recommendations)
  //   2. Tomorrow's calendar (PRIMARY training plan source)
  //   3. Today's activities + details (training load context)
  //   4. Health summaries + trends (supplementary)
  const dataPayload = {
    // ── Core context ──
    date: garminData.date,
    bodyBatterySummary: garminData.bodyBatterySummary,
    sleepSummary: garminData.sleepSummary,
    stressSummary: garminData.stressSummary,
    heartRateSummary: garminData.heartRateSummary,
    hrvSummary: garminData.hrvSummary,
    trainingReadiness: garminData.trainingReadiness,
    // ── Tomorrow's plan (calendar events = training schedule) ──
    tomorrowCalendar: tomorrowCalendarEvents,
    tomorrowScheduledWorkouts: garminData.tomorrowWorkouts,
    tomorrowTrainingPlan: garminData.tomorrowTrainingPlan,
    // ── Today's training ──
    activities: garminData.activities,
    activityDetails: activityDetailsObj,
    todayCalendar: todayCalendarEvents,
    // ── Extended context ──
    trainingStatus: garminData.trainingStatus,
    dailySummary: garminData.summary,
    weeklyStress: garminData.weeklyStress,
    weeklyIntensityMinutes: garminData.weeklyIntensityMinutes,
    dataGaps: garminData.errors,
  };

  // Truncate payload — Claude handles 200K context, but we keep it reasonable
  // to avoid wasting tokens on raw data. 40K chars ≈ ~12K tokens.
  const rawPayload = JSON.stringify(dataPayload, null, 2);
  const payloadStr = truncatePayload(rawPayload, 40000);
  logger.info({
    rawPayloadLength: rawPayload.length,
    truncated: rawPayload.length > 40000,
    tomorrowCalInPayload: dataPayload.tomorrowCalendar.length,
  }, 'Coach: payload stats');

  // Phase 4: Claude analysis
  const analysisStart = Date.now();
  try {
    const today = now().toFormat('cccc, LLLL dd yyyy');
    const response = await trackedCreate(client, {
      model: config.anthropic.model,
      max_tokens: 2500,
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
      messages: [
        {
          role: 'user',
          content: `DAILY COACHING ANALYSIS — ${today}

## RAW GARMIN DATA
${payloadStr}

## INSTRUCTIONS
1. Analyze my recovery status and today's training load
2. For each scheduled workout tomorrow, recommend: KEEP / MODIFY / SWAP / REST
3. Every recommendation must reference specific data points
4. Flag nutrition concerns (carnivore diet, high training volume)
5. Include one actionable tip
6. Be direct, no fluff — talk to me like a coach who knows me
7. Use HTML tags for Telegram formatting (<b>, <i>)
8. Keep the human-readable briefing under 3800 characters
9. At the END, include the structured COACH_RECS JSON block for calendar actions`,
        },
      ],
    }, 'coach_analysis');

    const analysisMs = Date.now() - analysisStart;
    const rawText = response.content
      .filter((c): c is Anthropic.TextBlock => c.type === 'text')
      .map((c) => c.text)
      .join('');

    if (!rawText.trim()) {
      return {
        message: '⚠️ <b>Coach analysis returned empty.</b>\n\nTry /coach again.',
        recommendations: [],
        errors: [...errors, 'Claude returned empty response'],
        dataCollectionMs,
        analysisMs,
      };
    }

    // Extract structured recommendations JSON from the response
    const { humanMessage, recommendations } = extractRecommendations(rawText);

    // Sanitize any markdown that Claude may have output despite HTML instructions
    const cleanMessage = sanitizeMarkdownForTelegram(humanMessage);

    // Append data collection info as a footer
    const footer = `\n\n<i>📊 Data: ${(dataCollectionMs / 1000).toFixed(1)}s | Analysis: ${(analysisMs / 1000).toFixed(1)}s${errors.length > 0 ? ` | ⚠️ ${errors.length} data gap(s)` : ''}</i>`;

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
      message: '⚠️ <b>Coach analysis failed</b>\n\nClaude API error. Try /coach later.',
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
    return { humanMessage: text.trim(), recommendations: [] };
  }

  // Split human message from JSON block
  const humanMessage = text.substring(0, startIdx).trim();
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
      }));

    logger.info({ count: recommendations.length }, 'Coach: parsed structured recommendations');
    return { humanMessage, recommendations };
  } catch (err) {
    logger.warn({ err, jsonStr: jsonStr.substring(0, 200) }, 'Coach: failed to parse COACH_RECS JSON');
    return { humanMessage, recommendations: [] };
  }
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
