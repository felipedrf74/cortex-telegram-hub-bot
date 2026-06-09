// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { TrainingDecisionReason } from './coach-kernel/types';
import { incrementTrainingGenerationCounter } from './training-generation-observability';

export type EquipmentItemCategory =
  | 'bodyweight'
  | 'free_weight'
  | 'barbell'
  | 'dumbbell'
  | 'kettlebell'
  | 'machine'
  | 'cable'
  | 'band'
  | 'cardio_machine'
  | 'pool'
  | 'bike'
  | 'space'
  | 'bench'
  | 'rack'
  | 'mobility'
  | 'other';

export interface EquipmentItem {
  id: string;
  canonicalName: string;
  aliases: string[];
  category: EquipmentItemCategory;
}

export interface ExerciseEquipmentRequirement {
  requiredAllOf?: string[];
  requiredAnyOf?: string[][];
  optional?: string[];
  forbidden?: string[];
}

export interface EquipmentProfile {
  profileId: string;
  items: string[];
  confidence: 'declared' | 'inferred' | 'unknown';
  source: 'user' | 'ios' | 'calendar_travel' | 'secretary' | 'default';
}

export type EquipmentCapabilityBucket =
  | 'full_gym'
  | 'garage_gym'
  | 'home_basic'
  | 'hotel_gym'
  | 'bands'
  | 'bodyweight';

export interface ResolvedEquipmentProfile extends EquipmentProfile {
  bucket: EquipmentCapabilityBucket;
  matchedAliases: string[];
  rawInput?: string;
  summary: string;
  decisionReasons: TrainingDecisionReason[];
}

export interface ResolveEquipmentProfileInput {
  fitnessProfile?: Record<string, any> | null;
  gymProfile?: Record<string, any> | null;
  source?: EquipmentProfile['source'];
  recordConservativeDefaultMetric?: boolean;
}

export const EQUIPMENT_VOCABULARY_VERSION = 'equipment-vocabulary-v1';

export const CANONICAL_EQUIPMENT_ITEMS: EquipmentItem[] = [
  {
    id: 'bodyweight',
    canonicalName: 'Bodyweight',
    aliases: ['bodyweight', 'body weight', 'peso corporal', 'sem equipamento', 'no equipment'],
    category: 'bodyweight',
  },
  {
    id: 'floor_space',
    canonicalName: 'Open floor space',
    aliases: ['space', 'floor space', 'mat area', 'home space'],
    category: 'space',
  },
  {
    id: 'mobility_mat',
    canonicalName: 'Mobility mat',
    aliases: ['mat', 'yoga mat', 'mobility mat'],
    category: 'mobility',
  },
  {
    id: 'resistance_band',
    canonicalName: 'Resistance band',
    aliases: ['band', 'bands', 'resistance band', 'elástico', 'elastico', 'faixa'],
    category: 'band',
  },
  {
    id: 'dumbbells',
    canonicalName: 'Dumbbells',
    aliases: ['dumbbell', 'dumbbells', 'db', 'halteres'],
    category: 'dumbbell',
  },
  {
    id: 'kettlebells',
    canonicalName: 'Kettlebell',
    aliases: ['kettlebell', 'kettlebells', 'kb'],
    category: 'kettlebell',
  },
  {
    id: 'barbell',
    canonicalName: 'Barbell',
    aliases: ['barbell', 'barra olimpica', 'barra olímpica'],
    category: 'barbell',
  },
  {
    id: 'rack',
    canonicalName: 'Rack',
    aliases: ['rack', 'squat rack', 'power rack'],
    category: 'rack',
  },
  {
    id: 'bench',
    canonicalName: 'Bench',
    aliases: ['bench', 'weight bench', 'banco'],
    category: 'bench',
  },
  {
    id: 'pullup_bar',
    canonicalName: 'Pull-up bar',
    aliases: ['pullup bar', 'pull-up bar', 'barra fixa'],
    category: 'other',
  },
  {
    id: 'lat_pulldown',
    canonicalName: 'Lat pulldown',
    aliases: ['lat pulldown', 'pulldown'],
    category: 'machine',
  },
  {
    id: 'cable_stack',
    canonicalName: 'Cable stack',
    aliases: ['cable', 'cables', 'cable stack', 'cable machine'],
    category: 'cable',
  },
  {
    id: 'leg_press',
    canonicalName: 'Leg press',
    aliases: ['leg press'],
    category: 'machine',
  },
  {
    id: 'chest_press_machine',
    canonicalName: 'Chest press machine',
    aliases: ['chest press machine', 'machine chest press'],
    category: 'machine',
  },
  {
    id: 'hack_squat_machine',
    canonicalName: 'Hack squat machine',
    aliases: ['hack squat', 'hack squat machine'],
    category: 'machine',
  },
  {
    id: 'ab_wheel',
    canonicalName: 'Ab wheel',
    aliases: ['ab wheel', 'ab roller'],
    category: 'mobility',
  },
  {
    id: 'battle_ropes',
    canonicalName: 'Battle ropes',
    aliases: ['battle ropes', 'ropes'],
    category: 'other',
  },
  {
    id: 'box',
    canonicalName: 'Plyo box',
    aliases: ['box', 'plyo box', 'step box'],
    category: 'other',
  },
  {
    id: 'med_ball',
    canonicalName: 'Medicine ball',
    aliases: ['medicine ball', 'med ball'],
    category: 'other',
  },
  {
    id: 'sled',
    canonicalName: 'Sled',
    aliases: ['sled', 'prowler'],
    category: 'other',
  },
  {
    id: 'cardio_machine',
    canonicalName: 'Cardio machine',
    aliases: ['treadmill', 'stationary bike', 'elliptical', 'cardio machine'],
    category: 'cardio_machine',
  },
  {
    id: 'bike_trainer',
    canonicalName: 'Bike trainer',
    aliases: ['bike trainer', 'smart trainer', 'turbo trainer'],
    category: 'bike',
  },
  {
    id: 'pool',
    canonicalName: 'Pool',
    aliases: ['pool', 'swimming pool', 'piscina'],
    category: 'pool',
  },
  {
    id: 'track',
    canonicalName: 'Track or outdoor run access',
    aliases: ['track', 'outdoor run', 'running outside', 'pista'],
    category: 'space',
  },
];

const BASE_SAFE_ITEMS = ['bodyweight', 'floor_space', 'mobility_mat'];

const FULL_GYM_ITEMS = [
  ...BASE_SAFE_ITEMS,
  'resistance_band',
  'dumbbells',
  'kettlebells',
  'barbell',
  'rack',
  'bench',
  'pullup_bar',
  'lat_pulldown',
  'cable_stack',
  'leg_press',
  'chest_press_machine',
  'hack_squat_machine',
  'cardio_machine',
  'track',
];

const GARAGE_GYM_ITEMS = [
  ...BASE_SAFE_ITEMS,
  'resistance_band',
  'dumbbells',
  'kettlebells',
  'barbell',
  'rack',
  'bench',
  'pullup_bar',
  'track',
];

const HOME_BASIC_ITEMS = [
  ...BASE_SAFE_ITEMS,
  'resistance_band',
  'dumbbells',
  'kettlebells',
  'bench',
  'track',
];

const HOTEL_GYM_ITEMS = [
  ...BASE_SAFE_ITEMS,
  'dumbbells',
  'bench',
  'cardio_machine',
  'track',
];

const BANDS_ITEMS = [
  ...BASE_SAFE_ITEMS,
  'resistance_band',
  'track',
];

const BUCKET_DEFINITIONS: Record<EquipmentCapabilityBucket, {
  aliases: RegExp[];
  matchedAlias: string;
  items: string[];
  summary: string;
}> = {
  full_gym: {
    aliases: [
      /\bfull\s*gym\b/i,
      /\bfull\s*commercial\b/i,
      /\bcommercial\s*gym\b/i,
      /\bfitness\s*(center|centre|club)\b/i,
      /\bfully[-\s]*equipped\b/i,
      /\bwell[-\s]*equipped\b/i,
      /\bcomplete\s*gym\b/i,
      /\bcross[-\s]*fit\b/i,
      /\bgym\s+(membership|member|access|subscription)\b/i,
      /\bacademia\b/i,
      /\bgin[áa]sio\b/i,
    ],
    matchedAlias: 'full_gym',
    items: FULL_GYM_ITEMS,
    summary: 'Full gym',
  },
  garage_gym: {
    aliases: [/\bgarage\b/i],
    matchedAlias: 'garage_gym',
    items: GARAGE_GYM_ITEMS,
    summary: 'Garage gym (barbell + rack)',
  },
  hotel_gym: {
    aliases: [/\bhotel\s*gym\b/i, /\bhotel\s*fitness\b/i, /\btravel\s*gym\b/i],
    matchedAlias: 'hotel_gym',
    items: HOTEL_GYM_ITEMS,
    summary: 'Hotel gym (limited)',
  },
  home_basic: {
    aliases: [/\bhome\s*gym\b/i, /\bhome[_-]?gym\b/i, /\bbasic\s*equipment\b/i, /\bdumbbells?\s*only\b/i],
    matchedAlias: 'home_basic',
    items: HOME_BASIC_ITEMS,
    summary: 'Home gym (basic)',
  },
  bands: {
    aliases: [/\bresistance\s*bands?\b/i, /\bbands?\b/i, /\bel[áa]stico\b/i, /\bfaixa\b/i],
    matchedAlias: 'bands',
    items: BANDS_ITEMS,
    summary: 'Resistance bands',
  },
  bodyweight: {
    aliases: [
      /\bbody\s*weight\b/i,
      /\bbodyweight\b/i,
      /\bno[-\s]*equipment\b/i,
      /\bwithout\s*equipment\b/i,
      /\bsem\s*equipamento\b/i,
      /\bpeso\s*corporal\b/i,
      /\bnone\b/i,
    ],
    matchedAlias: 'bodyweight',
    items: BASE_SAFE_ITEMS,
    summary: 'Bodyweight only',
  },
};

export function resolveCanonicalEquipmentProfile(
  input: ResolveEquipmentProfileInput,
): ResolvedEquipmentProfile {
  const source = input.source ?? 'user';
  const rawCandidates = [
    pickEquipmentString(input.gymProfile?.equipment_access),
    pickEquipmentString(input.fitnessProfile?.available_equipment),
    pickEquipmentString(input.fitnessProfile?.equipment),
  ].filter((value): value is string => value !== null);

  for (const raw of rawCandidates) {
    const normalized = normalizeEquipmentText(raw);
    for (const [bucket, definition] of Object.entries(BUCKET_DEFINITIONS) as Array<[EquipmentCapabilityBucket, typeof BUCKET_DEFINITIONS[EquipmentCapabilityBucket]]>) {
      if (definition.aliases.some((pattern) => pattern.test(normalized))) {
        return {
          profileId: `${EQUIPMENT_VOCABULARY_VERSION}:${bucket}`,
          bucket,
          items: unique(definition.items),
          confidence: 'declared',
          source,
          matchedAliases: [definition.matchedAlias],
          rawInput: raw,
          summary: definition.summary,
          decisionReasons: [],
        };
      }
    }
  }

  const reasonText = rawCandidates.length > 0
    ? 'I used bodyweight-safe options because your equipment description is not recognized yet.'
    : 'I used bodyweight-safe options because your available equipment is unknown.';
  if (input.recordConservativeDefaultMetric !== false) {
    incrementTrainingGenerationCounter('equipment_default_conservative_total');
  }
  return {
    profileId: `${EQUIPMENT_VOCABULARY_VERSION}:unknown_conservative`,
    bucket: 'bodyweight',
    items: BASE_SAFE_ITEMS,
    confidence: 'unknown',
    source: 'default',
    matchedAliases: [],
    rawInput: rawCandidates.join(' | ') || undefined,
    summary: 'Bodyweight-safe default',
    decisionReasons: [{
      code: 'equipment_conservative_default',
      text: reasonText,
      severity: 'notice',
      affectedEntity: { type: 'week' },
      sourceConstraint: {
        type: 'equipment',
        label: 'unknown equipment',
      },
      evidence: rawCandidates.length > 0 ? [`raw_equipment=${rawCandidates.join(' | ')}`] : ['equipment_missing'],
    }],
  };
}

export function equipmentItemsForBucket(bucket: EquipmentCapabilityBucket): string[] {
  return unique(BUCKET_DEFINITIONS[bucket].items);
}

export function pickEquipmentString(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function normalizeEquipmentText(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
