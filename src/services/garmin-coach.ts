/**
 * Garmin Daily Coach — collects Garmin data, analyzes with Claude using
 * the Triatlon coaching persona, and formats a Telegram briefing message.
 */
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { logger } from '../utils/logger';
import { now, startOfDay, endOfDay } from '../utils/date-parser';
import { escapeHtml, splitMessage } from '../utils/telegram-formatter';
import { fetchDailyCoachData, isGarminConfigured, GarminCoachData } from './garmin';
import { getEvents, isAnyCalendarConfigured } from './unified-calendar';
import { DOMAIN_SYSTEM_PROMPTS } from './anthropic';

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
- Use HTML formatting for Telegram (bold: <b>, italic: <i>, code: <code>)
- Keep total response under 3800 characters (Telegram limit is 4096)
- All times in Europe/Lisbon timezone

OUTPUT FORMAT (follow exactly):

🏋️ <b>CORTEX — DAILY COACH BRIEFING</b>
📅 {date} — 21:00

━━━ <b>TODAY'S SNAPSHOT</b> ━━━
🛌 Sleep: {hours}h ({quality})
💓 RHR: {bpm} | HRV: {ms}
🔋 Body Battery: {current}/{max recharged}
😰 Stress: {avg} ({low/medium/high})
🏃 Training Readiness: {score}/100

━━━ <b>TODAY'S TRAINING</b> ━━━
{For each activity:}
• <b>{activity_type}</b>: {duration}, {distance if applicable}
  Training Effect: {aerobic}/{anaerobic}
  {Key metrics}

{If no activities: "Rest day — no recorded activities."}

━━━ <b>ANALYSIS</b> ━━━
{2-4 sentences: direct coaching assessment}
{Flag concerns: overtraining, undereating, poor sleep, elevated RHR}

━━━ <b>TOMORROW'S PLAN</b> ━━━
{For each scheduled session:}
{✅/⚠️/🔄/❌} <b>{session_name}</b>
  Planned: {description}
  Recommendation: {KEEP/MODIFY details/SWAP details/REST}
  Why: {1-2 sentence data-driven explanation}

{If no sessions scheduled: "No workouts scheduled for tomorrow."}

{If calendar conflicts:}
⏰ <b>Schedule Note:</b> {conflict + suggestion}

━━━ 💡 <b>TIP OF THE DAY</b> ━━━
{One actionable tip: recovery, nutrition, electrolytes, mobility, mindset}

RECOMMENDATION KEY:
- ✅ KEEP = Recovery supports planned session, execute as planned
- ⚠️ MODIFY = Partial recovery, reduce intensity/volume (specify exact changes)
- 🔄 SWAP = Wrong session type for current state, suggest alternative
- ❌ REST = Insufficient recovery, injury risk, explain why`;

// ─── Main coach function ──────────────────────────────────────────────

export interface CoachBriefingResult {
  message: string;
  errors: string[];
  dataCollectionMs: number;
  analysisMs: number;
}

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
      errors: [(err as Error).message],
      dataCollectionMs: Date.now() - collectStart,
      analysisMs: 0,
    };
  }
  const dataCollectionMs = Date.now() - collectStart;

  // Phase 2: Fetch tomorrow's calendar (if configured)
  let calendarEvents: { summary: string; start: string; end: string }[] = [];
  if (isAnyCalendarConfigured()) {
    try {
      const tomorrow = now().plus({ days: 1 });
      const events = await getEvents(
        tomorrow.startOf('day').toISO()!,
        tomorrow.endOf('day').toISO()!
      );
      calendarEvents = events.map((e) => ({
        summary: e.summary,
        start: e.start,
        end: e.end,
      }));
    } catch (err) {
      errors.push(`calendar: ${(err as Error).message}`);
    }
  }

  // Phase 3: Prepare data payload for Claude (strip Map to plain object)
  const activityDetailsObj: Record<number, unknown> = {};
  for (const [id, detail] of garminData.activityDetails) {
    activityDetailsObj[id] = detail;
  }

  const dataPayload = {
    date: garminData.date,
    dailySummary: garminData.summary,
    sleep: garminData.sleep,
    stress: garminData.stress,
    heartRate: garminData.heartRate,
    hrv: garminData.hrv,
    trainingReadiness: garminData.trainingReadiness,
    trainingStatus: garminData.trainingStatus,
    bodyBattery: garminData.bodyBattery,
    restingHeartRate: garminData.rhr,
    activities: garminData.activities,
    activityDetails: activityDetailsObj,
    tomorrowScheduledWorkouts: garminData.tomorrowWorkouts,
    tomorrowTrainingPlan: garminData.tomorrowTrainingPlan,
    weeklyStress: garminData.weeklyStress,
    weeklyIntensityMinutes: garminData.weeklyIntensityMinutes,
    tomorrowCalendar: calendarEvents,
    dataGaps: garminData.errors,
  };

  // Truncate the payload to stay within reasonable token limits
  const payloadStr = truncatePayload(JSON.stringify(dataPayload, null, 2), 12000);

  // Phase 4: Claude analysis
  const analysisStart = Date.now();
  try {
    const today = now().toFormat('cccc, LLLL dd yyyy');
    const response = await client.messages.create({
      model: config.anthropic.model,
      max_tokens: 2048,
      system: [
        {
          type: 'text',
          text: DOMAIN_SYSTEM_PROMPTS.triathlon,
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
8. Keep total output under 3800 characters`,
        },
      ],
    });

    const analysisMs = Date.now() - analysisStart;
    const text = response.content
      .filter((c): c is Anthropic.TextBlock => c.type === 'text')
      .map((c) => c.text)
      .join('');

    if (!text.trim()) {
      return {
        message: '⚠️ <b>Coach analysis returned empty.</b>\n\nTry /coach again.',
        errors: [...errors, 'Claude returned empty response'],
        dataCollectionMs,
        analysisMs,
      };
    }

    // Append data collection info as a footer
    const footer = `\n\n<i>📊 Data: ${(dataCollectionMs / 1000).toFixed(1)}s | Analysis: ${(analysisMs / 1000).toFixed(1)}s${errors.length > 0 ? ` | ⚠️ ${errors.length} data gap(s)` : ''}</i>`;

    return {
      message: text + footer,
      errors,
      dataCollectionMs,
      analysisMs,
    };
  } catch (err) {
    logger.error({ err }, 'Coach analysis failed');
    return {
      message: '⚠️ <b>Coach analysis failed</b>\n\nClaude API error. Try /coach later.',
      errors: [...errors, (err as Error).message],
      dataCollectionMs,
      analysisMs: Date.now() - analysisStart,
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Truncate a JSON payload to maxChars while keeping valid structure.
 * Cuts from the end and adds an ellipsis marker.
 */
function truncatePayload(payload: string, maxChars: number): string {
  if (payload.length <= maxChars) return payload;
  return payload.substring(0, maxChars) + '\n\n... [DATA TRUNCATED — remaining data omitted to fit context window]';
}
