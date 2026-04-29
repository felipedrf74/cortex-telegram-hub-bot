// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export function normalizeTrainingStatus(status?: string | null): string {
  switch ((status || '').toLowerCase()) {
    case 'completed':
      return 'completed';
    case 'skipped':
      return 'skipped';
    case 'scheduled':
    case 'reflowed':
    case 'compressed':
    case 'capped':
    case 'pending':
    case 'moved':
      return 'planned';
    case 'rest':
      return 'rest';
    case 'unscheduled':
      return 'unscheduled';
    case 'deferred':
      return 'deferred';
    case 'dropped':
      return 'dropped';
    case 'cancelled':
      return 'cancelled';
    case 'superseded':
      return 'superseded';
    default:
      return 'planned';
  }
}

export function parseExercises(exercisesJson?: string | null): any[] | null {
  if (!exercisesJson) return null;
  try {
    const parsed = JSON.parse(exercisesJson);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function humanizeSessionType(sessionType?: string | null): string {
  switch ((sessionType || '').toLowerCase()) {
    case 'gym':
      return 'Gym';
    case 'run':
      return 'Run';
    case 'ride':
      return 'Ride';
    case 'swim':
      return 'Swim';
    case 'rest':
      return 'Rest';
    default:
      return 'Workout';
  }
}

export function inferCalendarSessionType(title: string): string {
  const lower = title.toLowerCase();
  if (lower.includes('run') || lower.includes('corrida')) return 'run';
  if (lower.includes('swim') || lower.includes('nata')) return 'swim';
  if (lower.includes('bike') || lower.includes('ride') || lower.includes('cicl')) return 'ride';
  if (lower.includes('gym') || lower.includes('strength') || lower.includes('upper body') || lower.includes('lower body')) return 'gym';
  if (lower.includes('rest')) return 'rest';
  return 'workout';
}

export function looksLikeTrainingCalendarEvent(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  if (!normalized) return false;

  const excludedPatterns = [
    /\bwake\s*up\b/i,
    /\bprepare\b/i,
    /\breading\b/i,
    /\batomic\s+habits\b/i,
    /\bmorning\s+routine\b/i,
    /\brotina\b/i,
    /\bschool\b/i,
    /\bescola\b/i,
    /\bmeeting\b/i,
    /\breuni[aã]o\b/i,
  ];
  if (excludedPatterns.some((pattern) => pattern.test(normalized))) {
    return false;
  }

  const explicitTrainingPatterns = [
    /\b(?:tempo|interval|long)\s+(?:run|ride)\b/i,
    /\b(?:run|running|corrida|ride|riding|bike|cycling|cycle|swim|swimming|nata[cç][aã]o|gym|academia|strength|for[çc]a|workout|training|treino|muscula[çc][aã]o|hiit|hyrox|pilates|yoga|mobility|ftp|zone\s*2|z2)\b/i,
    /\b(?:brisk|power|recovery)\s+walk\b/i,
    /\bcaminhada\s+(?:r[aá]pida|zona\s*2|recupera[çc][aã]o)\b/i,
  ];

  return explicitTrainingPatterns.some((pattern) => pattern.test(normalized));
}

export function estimateCalendarDurationMinutes(startRaw?: string | null, endRaw?: string | null): number | null {
  if (!startRaw || !endRaw) return null;
  try {
    const start = new Date(startRaw);
    const end = new Date(endRaw);
    const minutes = Math.round((end.getTime() - start.getTime()) / 60000);
    return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
  } catch {
    return null;
  }
}
