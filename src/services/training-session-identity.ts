// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'crypto';

const IDENTITY_MARKER_PREFIX = 'NEXUS_TRAINING_IDENTITY';
const IDENTITY_MARKER_RE = /\n?\s*\[NEXUS_TRAINING_IDENTITY\s+([^\]]+)\]\s*$/i;

export interface TrainingSessionShapeInput {
  sessionType?: unknown;
  title?: unknown;
  durationMinutes?: unknown;
  intensityText?: unknown;
  exercises?: unknown;
  descriptionSections?: unknown;
}

export interface TrainingSessionIdentityKeyInput {
  planId: number;
  weekNumber: number;
  dayOfWeek?: unknown;
  sessionType?: unknown;
  ordinal?: number;
}

export interface TrainingCalendarIdentityMarker {
  planId: number | null;
  planVersion: number | null;
  sessionId: number | null;
  sessionIdentityKey: string | null;
  sessionShapeHash: string | null;
}

export function computeTrainingSessionShapeHash(input: TrainingSessionShapeInput): string {
  const payload = {
    sessionType: normalizeToken(input.sessionType),
    role: normalizeRole(input.title, input.sessionType),
    durationMinutes: normalizeDuration(input.durationMinutes),
    intensity: normalizeToken(input.intensityText),
    exercises: normalizeExercises(input.exercises),
    descriptionShape: normalizeDescriptionShape(input.descriptionSections),
  };
  return createHash('sha256')
    .update(stableStringify(payload))
    .digest('hex')
    .slice(0, 20);
}

export function buildTrainingSessionIdentityKey(input: TrainingSessionIdentityKeyInput): string {
  const planId = Number.isFinite(input.planId) && input.planId > 0 ? Math.floor(input.planId) : 0;
  const weekNumber = Number.isFinite(input.weekNumber) && input.weekNumber > 0 ? Math.floor(input.weekNumber) : 1;
  const day = normalizeToken(input.dayOfWeek) || 'unspecified-day';
  const type = normalizeToken(input.sessionType) || 'training';
  const ordinal = Number.isFinite(input.ordinal) && Number(input.ordinal) > 0 ? Math.floor(Number(input.ordinal)) : 1;
  return [`plan:${planId}`, `week:${weekNumber}`, `day:${day}`, `type:${type}`, `slot:${ordinal}`].join('|');
}

export function appendTrainingIdentityMarker(
  description: string | null | undefined,
  marker: Required<TrainingCalendarIdentityMarker>,
): string {
  const cleanDescription = stripTrainingIdentityMarker(description);
  const encoded = [
    ['plan', marker.planId],
    ['version', marker.planVersion],
    ['session', marker.sessionId],
    ['key', marker.sessionIdentityKey],
    ['shape', marker.sessionShapeHash],
  ]
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value ?? ''))}`)
    .join(';');
  return `${cleanDescription}${cleanDescription ? '\n\n' : ''}[${IDENTITY_MARKER_PREFIX} ${encoded}]`;
}

export function stripTrainingIdentityMarker(description: string | null | undefined): string {
  return String(description || '').replace(IDENTITY_MARKER_RE, '').trimEnd();
}

export function parseTrainingIdentityMarker(
  description: string | null | undefined,
): TrainingCalendarIdentityMarker | null {
  const match = String(description || '').match(IDENTITY_MARKER_RE);
  if (!match) return null;
  const values = new Map<string, string>();
  for (const part of match[1].split(';')) {
    const [rawKey, ...rawValueParts] = part.split('=');
    const key = rawKey?.trim();
    if (!key) continue;
    const rawValue = rawValueParts.join('=');
    try {
      values.set(key, decodeURIComponent(rawValue || ''));
    } catch {
      values.set(key, rawValue || '');
    }
  }
  return {
    planId: parsePositiveInt(values.get('plan')),
    planVersion: parsePositiveInt(values.get('version')),
    sessionId: parsePositiveInt(values.get('session')),
    sessionIdentityKey: nonEmpty(values.get('key')),
    sessionShapeHash: nonEmpty(values.get('shape')),
  };
}

function parsePositiveInt(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = String(value || '').trim();
  return trimmed || null;
}

function normalizeDuration(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

function normalizeRole(title: unknown, sessionType: unknown): string {
  const fromTitle = normalizeToken(title)
    .replace(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/g, '')
    .replace(/\b(session|workout|training|treino)\b/g, '')
    .replace(/\b\d+\s*min\b/g, '')
    .replace(/\b\d+min\b/g, '')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
  return fromTitle || normalizeToken(sessionType) || 'training';
}

function normalizeToken(value: unknown): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function normalizeExercises(value: unknown): unknown {
  const parsed = parseJsonIfString(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((entry) => normalizeExercise(entry)).filter(Boolean);
}

function normalizeExercise(entry: unknown): Record<string, unknown> | null {
  if (!entry || typeof entry !== 'object') return null;
  const source = entry as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const key of [
    'id',
    'name',
    'movementPattern',
    'movement_pattern',
    'sets',
    'reps',
    'duration',
    'durationMinutes',
    'distance',
    'distanceKm',
    'targetPace',
    'intensity',
    'rpe',
    'rir',
    'restSec',
    'restSeconds',
    'zone',
  ]) {
    const value = source[key];
    if (value === undefined || value === null || value === '') continue;
    normalized[key] = typeof value === 'string' ? normalizeStringValue(value) : value;
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeDescriptionShape(value: unknown): unknown {
  const parsed = parseJsonIfString(value);
  if (!parsed) return null;
  if (Array.isArray(parsed)) {
    return parsed.map((entry) => normalizeDescriptionEntry(entry)).filter(Boolean);
  }
  if (typeof parsed === 'object') {
    return normalizeDescriptionEntry(parsed);
  }
  return null;
}

function normalizeDescriptionEntry(entry: unknown): Record<string, unknown> | null {
  if (!entry || typeof entry !== 'object') return null;
  const source = entry as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const key of ['type', 'kind', 'title', 'label', 'durationMinutes', 'totalMinutes', 'items']) {
    const value = source[key];
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      normalized[key] = value.map((item) =>
        typeof item === 'string' ? normalizeStringValue(item) : normalizeDescriptionEntry(item) ?? item,
      );
    } else {
      normalized[key] = typeof value === 'string' ? normalizeStringValue(value) : value;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeStringValue(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function parseJsonIfString(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
