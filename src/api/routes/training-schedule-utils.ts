// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export type BusyWindow = {
  startMs: number;
  endMs: number;
  title: string;
};

export function normalizePreferredTime(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  return /^\d{2}:\d{2}$/.test(trimmed) ? trimmed : fallback;
}

export function canonicalTrainingDay(value: string): string {
  const normalized = value.trim().toLowerCase();
  const mapping: Record<string, string> = {
    monday: 'Monday',
    tuesday: 'Tuesday',
    wednesday: 'Wednesday',
    thursday: 'Thursday',
    friday: 'Friday',
    saturday: 'Saturday',
    sunday: 'Sunday',
  };
  return mapping[normalized] ?? value.trim();
}

export function buildBusyWindows(events: any[]): BusyWindow[] {
  return (events || []).flatMap((event: any) => {
    const startRaw = event.start?.dateTime || event.startDateTime || event.start;
    const endRaw = event.end?.dateTime || event.endDateTime || event.end;
    const start = new Date(startRaw || '');
    const end = new Date(endRaw || '');
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return [];
    return [{
      startMs: start.getTime(),
      endMs: end.getTime(),
      title: event.subject || event.summary || event.title || '',
    }];
  }).sort((a, b) => a.startMs - b.startMs);
}

export function preferredTimeForSessionType(
  sessionType: string,
  fallbackPreferredTime: string,
  preferredCardioTime: string,
  preferredStrengthTime: string,
): string {
  switch ((sessionType || '').toLowerCase()) {
    case 'gym':
      return preferredStrengthTime;
    case 'run':
    case 'ride':
    case 'swim':
      return preferredCardioTime;
    default:
      return fallbackPreferredTime;
  }
}

export function minutesFromTimeString(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return Math.max(0, Math.min(23 * 60 + 59, (hours || 0) * 60 + (minutes || 0)));
}

export function timeStringFromMinutes(totalMinutes: number): string {
  const clamped = Math.max(5 * 60, Math.min(21 * 60, totalMinutes));
  const hours = Math.floor(clamped / 60);
  const minutes = clamped % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export function candidateTimesForPreferredTime(preferredTime: string): string[] {
  const baseMinutes = minutesFromTimeString(preferredTime);
  const offsets = [0, -60, 60, -90, 90, 120, -120, 150, -150];
  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const offset of offsets) {
    const candidate = timeStringFromMinutes(baseMinutes + offset);
    if (!seen.has(candidate)) {
      seen.add(candidate);
      candidates.push(candidate);
    }
  }

  return candidates;
}

function overlapsRange(startMs: number, endMs: number, windows: BusyWindow[]): boolean {
  return windows.some((window) => startMs < window.endMs && endMs > window.startMs);
}

export function scheduleSessionWindow(
  sessionDate: Date,
  durationMinutes: number,
  preferredTime: string,
  busyWindows: BusyWindow[],
  scheduledWindows: BusyWindow[],
): { start: Date; end: Date } {
  const candidates = candidateTimesForPreferredTime(preferredTime);

  for (const candidate of candidates) {
    const [hours, minutes] = candidate.split(':').map(Number);
    const start = new Date(sessionDate);
    start.setHours(hours, minutes, 0, 0);
    const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
    if (!overlapsRange(start.getTime(), end.getTime(), busyWindows) && !overlapsRange(start.getTime(), end.getTime(), scheduledWindows)) {
      return { start, end };
    }
  }

  const [fallbackHours, fallbackMinutes] = preferredTime.split(':').map(Number);
  const fallbackStart = new Date(sessionDate);
  fallbackStart.setHours(fallbackHours || 12, fallbackMinutes || 0, 0, 0);
  return {
    start: fallbackStart,
    end: new Date(fallbackStart.getTime() + durationMinutes * 60 * 1000),
  };
}
