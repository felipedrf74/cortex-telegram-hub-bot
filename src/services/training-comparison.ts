// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Planned vs Actual Training Comparison — matches training plan sessions
 * against Garmin-recorded activities by day + type to show discrepancies.
 */

import { logger } from '../utils/logger';
import { getActivePlan, getCurrentWeek, getSessionsForWeek, type TrainingSession } from './training-plans';
import { getActivitiesByDate, type GarminActivity } from './garmin';

// ── Types ───────────────────────────────────────────────────────────

export interface SessionComparison {
  session: TrainingSession | null;
  garminActivity: GarminActivity | null;
  match: 'exact' | 'partial' | 'missed' | 'extra';
  discrepancies: string[];
}

export interface ComparisonResult {
  weekOf: string;
  comparisons: SessionComparison[];
  summary: { planned: number; completed: number; missed: number; extra: number };
}

// ── Helpers ─────────────────────────────────────────────────────────

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** Get Monday of the current ISO week */
export function getWeekMonday(): string {
  const d = new Date();
  const day = d.getDay(); // 0=Sun, 1=Mon, ...
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function sessionDayToDate(dayOfWeek: string, weekMonday: string): string {
  const idx = DAY_NAMES.indexOf(dayOfWeek);
  return idx >= 0 ? addDays(weekMonday, idx) : weekMonday;
}

// ── Comparison Engine ───────────────────────────────────────────────

/**
 * Compare this week's planned sessions against Garmin activities.
 * Matches by: same calendar day + fuzzy activity type.
 */
export async function comparePlannedVsActual(userId: number, tenantId: number = userId): Promise<ComparisonResult> {
  const plan = getActivePlan(userId, tenantId);
  if (!plan) throw new Error('No active plan');

  const currentWeek = getCurrentWeek(plan.id);
  if (!currentWeek) throw new Error('No current week');

  const sessions = getSessionsForWeek(currentWeek.id);
  const weekMonday = getWeekMonday();
  const weekSunday = addDays(weekMonday, 6);

  // Fetch Garmin activities for the week
  let activities: GarminActivity[] = [];
  try {
    activities = await getActivitiesByDate(weekMonday, weekSunday) ?? [];
  } catch (err) {
    logger.warn({ err }, 'Failed to fetch Garmin activities for comparison');
  }

  const comparisons: SessionComparison[] = [];
  const matchedActivityIds = new Set<number>();

  // Match each planned session to a Garmin activity
  for (const session of sessions) {
    const sessionDate = sessionDayToDate(session.day_of_week, weekMonday);

    // Find Garmin activity on the same day
    const matchingActivity = activities.find(a => {
      if (matchedActivityIds.has(a.activityId)) return false;
      const activityDate = (a.startTimeLocal || '').slice(0, 10);
      if (activityDate !== sessionDate) return false;
      return true;
    });

    if (!matchingActivity) {
      comparisons.push({
        session,
        garminActivity: null,
        match: 'missed',
        discrepancies: [`Planned: ${session.title} — No matching activity recorded`],
      });
      continue;
    }

    matchedActivityIds.add(matchingActivity.activityId);
    const discrepancies: string[] = [];

    // Duration check (tolerance: 10 minutes)
    const plannedMin = session.duration_minutes || 60;
    const actualMin = Math.round((matchingActivity.duration || 0) / 60);
    if (Math.abs(actualMin - plannedMin) > 10) {
      discrepancies.push(`Duration: planned ${plannedMin}min, actual ${actualMin}min`);
    }

    // Type check (fuzzy match)
    const activityType = (matchingActivity.activityType?.typeKey || '').toLowerCase();
    const sessionType = (session.session_type || '').toLowerCase();
    if (sessionType && activityType && !activityType.includes(sessionType) && !sessionType.includes(activityType)) {
      discrepancies.push(`Type: planned ${session.session_type}, actual ${activityType}`);
    }

    comparisons.push({
      session,
      garminActivity: matchingActivity,
      match: discrepancies.length === 0 ? 'exact' : 'partial',
      discrepancies,
    });
  }

  // Extra activities not matched to any planned session
  for (const activity of activities) {
    if (matchedActivityIds.has(activity.activityId)) continue;

    const typeKey = activity.activityType?.typeKey || 'unknown';
    const duration = Math.round((activity.duration || 0) / 60);

    comparisons.push({
      session: null,
      garminActivity: activity,
      match: 'extra',
      discrepancies: [`Unplanned activity: ${typeKey} (${duration}min)`],
    });
  }

  return {
    weekOf: weekMonday,
    comparisons,
    summary: {
      planned: sessions.length,
      completed: comparisons.filter(c => c.match === 'exact' || c.match === 'partial').length,
      missed: comparisons.filter(c => c.match === 'missed').length,
      extra: comparisons.filter(c => c.match === 'extra').length,
    },
  };
}

/**
 * Format comparison result as an HTML Telegram message.
 */
export function formatComparison(result: ComparisonResult): string {
  let msg = `📊 <b>Planned vs Actual — Week of ${result.weekOf}</b>\n\n`;

  for (const comp of result.comparisons) {
    switch (comp.match) {
      case 'exact':
        msg += `✅ <b>${comp.session!.day_of_week}</b> — ${comp.session!.title}: Matched`;
        if (comp.garminActivity) {
          msg += ` (${Math.round((comp.garminActivity.duration || 0) / 60)}min)`;
        }
        msg += '\n';
        break;
      case 'partial':
        msg += `⚠️ <b>${comp.session!.day_of_week}</b> — ${comp.session!.title}: Partial\n`;
        for (const d of comp.discrepancies) msg += `   ${d}\n`;
        break;
      case 'missed':
        msg += `❌ <b>${comp.session!.day_of_week}</b> — ${comp.session!.title}: Missed\n`;
        break;
      case 'extra': {
        const typeKey = comp.garminActivity?.activityType?.typeKey || 'unknown';
        const dur = Math.round((comp.garminActivity?.duration || 0) / 60);
        msg += `🆕 <b>Unplanned</b>: ${typeKey} (${dur}min)\n`;
        break;
      }
    }
  }

  const s = result.summary;
  msg += `\n<b>Summary:</b> ${s.completed}/${s.planned} matched, ${s.missed} missed, ${s.extra} extra`;

  return msg;
}
