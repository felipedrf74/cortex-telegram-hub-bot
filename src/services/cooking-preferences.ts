// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  applySkillMemoryCorrection,
  buildSkillMemorySummary,
  getSkillMemories,
  setSkillMemory,
  type SkillMemoryRecord,
} from './skill-memory';
import type { CookingPreferenceProfile } from './cooking-intelligence';
import { buildCookingPreferenceMemorySummary } from './cooking-intelligence';

export const COOKING_MEMORY_SCHEMA_VERSION = 'cooking-memory-v1';
const COOKING_SKILL_VERSION = '1.1.0-rc.1';

export type CookingPreferenceKind =
  | 'allergy'
  | 'dietary_restriction'
  | 'disliked_ingredient'
  | 'preferred_ingredient'
  | 'equipment'
  | 'weekday_max_prep_minutes'
  | 'budget_limit'
  | 'budget_currency'
  | 'batch_cooking_preferred'
  | 'training_day_preference'
  | 'cooking_skill_level'
  | 'grocery_preference';

export interface CookingPreferenceWriteInput {
  kind: CookingPreferenceKind;
  value: string | number | boolean;
  source?: string | null;
  correction?: boolean | null;
  confidence?: number | null;
  expiresAt?: string | null;
}

export interface CookingPreferenceReadModel {
  profile: CookingPreferenceProfile;
  memories: SkillMemoryRecord[];
  summary: string;
  skillMemorySummary: string;
}

const LIST_KINDS = new Set<CookingPreferenceKind>([
  'allergy',
  'dietary_restriction',
  'disliked_ingredient',
  'preferred_ingredient',
  'equipment',
]);

const VALID_KINDS = new Set<CookingPreferenceKind>([
  'allergy',
  'dietary_restriction',
  'disliked_ingredient',
  'preferred_ingredient',
  'equipment',
  'weekday_max_prep_minutes',
  'budget_limit',
  'budget_currency',
  'batch_cooking_preferred',
  'training_day_preference',
  'cooking_skill_level',
  'grocery_preference',
]);

export function isCookingPreferenceKind(value: unknown): value is CookingPreferenceKind {
  return typeof value === 'string' && VALID_KINDS.has(value as CookingPreferenceKind);
}

export function setCookingPreferenceMemory(
  userId: number,
  input: CookingPreferenceWriteInput,
  tenantId?: number | null,
): SkillMemoryRecord {
  if (!isCookingPreferenceKind(input.kind)) {
    throw new Error('COOKING_PREFERENCE_INVALID: unsupported preference kind');
  }
  const normalized = normalizeCookingPreferenceValue(input.kind, input.value);
  const memoryKey = cookingPreferenceMemoryKey(input.kind, normalized);
  const base = {
    tenantId: normalizedTenantId(tenantId),
    userId,
    skillId: 'cooking',
    memoryType: 'cooking_preference' as const,
    scope: 'user_private' as const,
    memoryKey,
    source: normalizeSource(input.source),
    confidence: normalizeConfidence(input.confidence),
    schemaVersion: COOKING_MEMORY_SCHEMA_VERSION,
    relatedSkillVersion: COOKING_SKILL_VERSION,
    auditMetadata: {
      preferenceKind: input.kind,
      normalizedValue: normalized,
      correction: Boolean(input.correction),
    },
  };

  if (input.correction) {
    return applySkillMemoryCorrection({
      ...base,
      correctedValue: normalized,
    });
  }

  return setSkillMemory({
    ...base,
    memoryValue: normalized,
    expiresAt: normalizeNullableText(input.expiresAt),
  });
}

export function getCookingPreferenceMemories(
  userId: number,
  tenantId?: number | null,
  opts?: { includeStale?: boolean },
): SkillMemoryRecord[] {
  return getSkillMemories({
    tenantId: normalizedTenantId(tenantId),
    userId,
    skillId: 'cooking',
    memoryTypes: ['cooking_preference'],
    includeStale: opts?.includeStale,
  });
}

export function buildCookingPreferenceReadModel(
  userId: number,
  tenantId?: number | null,
): CookingPreferenceReadModel {
  const memories = getCookingPreferenceMemories(userId, tenantId);
  const profile = buildCookingPreferenceProfileFromMemories(memories);
  const summary = buildCookingPreferenceMemorySummary(profile);
  const skillMemorySummary = buildSkillMemorySummary({
    tenantId: normalizedTenantId(tenantId),
    userId,
    skillId: 'cooking',
    memoryTypes: ['cooking_preference'],
  });

  return { profile, memories, summary, skillMemorySummary };
}

export function buildCookingPreferenceProfileFromMemories(
  memories: SkillMemoryRecord[],
): CookingPreferenceProfile {
  const profile: CookingPreferenceProfile = {};
  for (const memory of memories) {
    if (memory.status !== 'active') continue;
    const kind = cookingPreferenceKindFromMemoryKey(memory.memoryKey);
    if (!kind) continue;
    const value = memory.memoryValue.trim();
    if (!value) continue;

    switch (kind) {
      case 'allergy':
        profile.allergies = appendUnique(profile.allergies, value);
        break;
      case 'dietary_restriction':
        profile.dietaryRestrictions = appendUnique(profile.dietaryRestrictions, value);
        break;
      case 'disliked_ingredient':
        profile.dislikedIngredients = appendUnique(profile.dislikedIngredients, value);
        break;
      case 'preferred_ingredient':
        profile.preferredIngredients = appendUnique(profile.preferredIngredients, value);
        break;
      case 'weekday_max_prep_minutes': {
        const minutes = parsePositiveInt(value);
        if (minutes != null) profile.weekdayMaxPrepMinutes = minutes;
        break;
      }
      case 'budget_limit': {
        const limit = Number(value);
        if (Number.isFinite(limit) && limit >= 0) profile.budgetLimit = limit;
        break;
      }
      case 'budget_currency':
        profile.budgetCurrency = value.toUpperCase();
        break;
      case 'batch_cooking_preferred':
        profile.batchCookingPreferred = parseBoolean(value);
        break;
      case 'training_day_preference':
        profile.trainingDayPreference = value;
        break;
      default:
        break;
    }
  }
  return profile;
}

function cookingPreferenceMemoryKey(kind: CookingPreferenceKind, normalizedValue: string): string {
  if (!LIST_KINDS.has(kind)) return kind;
  return `${kind}.${slugifyPreferenceValue(normalizedValue)}`;
}

function cookingPreferenceKindFromMemoryKey(memoryKey: string): CookingPreferenceKind | null {
  const root = memoryKey.split('.')[0] as CookingPreferenceKind;
  return isCookingPreferenceKind(root) ? root : null;
}

function normalizeCookingPreferenceValue(kind: CookingPreferenceKind, value: string | number | boolean): string {
  if (kind === 'weekday_max_prep_minutes') {
    const minutes = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 480) {
      throw new Error('COOKING_PREFERENCE_INVALID: weekday_max_prep_minutes must be 1-480');
    }
    return String(minutes);
  }

  if (kind === 'budget_limit') {
    const limit = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isFinite(limit) || limit < 0 || limit > 1000000) {
      throw new Error('COOKING_PREFERENCE_INVALID: budget_limit must be a non-negative finite number');
    }
    return String(limit);
  }

  if (kind === 'batch_cooking_preferred') {
    if (typeof value === 'boolean') return String(value);
    const normalized = String(value).trim().toLowerCase();
    if (!['true', 'false', 'yes', 'no'].includes(normalized)) {
      throw new Error('COOKING_PREFERENCE_INVALID: batch_cooking_preferred must be boolean-like');
    }
    return ['true', 'yes'].includes(normalized) ? 'true' : 'false';
  }

  if (kind === 'budget_currency') {
    const currency = String(value).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new Error('COOKING_PREFERENCE_INVALID: budget_currency must be a three-letter code');
    }
    return currency;
  }

  const text = String(value).trim().replace(/\s+/g, ' ');
  if (text.length === 0 || text.length > 240) {
    throw new Error('COOKING_PREFERENCE_INVALID: preference value must be 1-240 characters');
  }
  return text;
}

function slugifyPreferenceValue(value: string): string {
  let slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
  // Avoid an anchored alternation with a trailing quantified branch: CodeQL
  // correctly treats that form as polynomial on attacker-controlled input.
  // The replacement above collapses each invalid run to one dash, so two
  // constant-time boundary checks preserve the existing slug contract.
  if (slug.startsWith('-')) slug = slug.slice(1);
  if (slug.endsWith('-')) slug = slug.slice(0, -1);
  slug = slug.slice(0, 80);
  if (!slug) throw new Error('COOKING_PREFERENCE_INVALID: preference value is not keyable');
  return slug;
}

function normalizedTenantId(tenantId?: number | null): number {
  const candidate = Number(tenantId);
  if (!Number.isInteger(candidate) || candidate <= 0) {
    throw new Error('COOKING_PREFERENCE_SCOPE: tenantId is required');
  }
  return candidate;
}

function normalizeSource(source: string | null | undefined): string {
  const value = source?.trim();
  return value || 'cooking_preference_writer';
}

function normalizeNullableText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeConfidence(confidence: number | null | undefined): number {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return 0.85;
  return Math.max(0, Math.min(1, confidence));
}

function parsePositiveInt(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseBoolean(value: string): boolean {
  return ['true', 'yes', '1'].includes(value.trim().toLowerCase());
}

function appendUnique(values: string[] | undefined, value: string): string[] {
  const current = values ?? [];
  if (current.some((item) => item.toLowerCase() === value.toLowerCase())) return current;
  return [...current, value];
}
