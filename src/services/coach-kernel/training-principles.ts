// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Training principles — slice A1a of the Week-Level Adaptability +
 * Periodization plan (v2.1).
 *
 * Typed accessor over `training-principles.json`, which has been
 * loaded into `knowledge.principles` (Record<string, unknown>) since
 * migration 023 but never read by any production module. This module
 * activates that dormant content: every accessor takes the loose
 * principles map and returns a typed shape so engines, guardrails,
 * and recovery variation can make rule-driven decisions.
 *
 * Design principles for this accessor:
 *
 *   - Defensive parsing. The JSON could be partial (e.g., a future
 *     edit accidentally drops `byPhase.peak`); every accessor returns
 *     `undefined` rather than throwing when the key is missing. The
 *     engines then fall back to their pre-A1a behavior so the system
 *     fails open, not closed.
 *
 *   - Read-only. This module never mutates the `principles` argument
 *     or any cached state. The knowledge base is loaded once at
 *     boot and treated as immutable thereafter.
 *
 *   - Pure utilities. `applyVolumeGrowthCap` and similar helpers are
 *     pure functions so they can be unit-tested without a database
 *     or full coach kernel.
 *
 * The shape definitions below match the live
 * `knowledge/entities/training-principles.json` as of slice A1a.
 * Later slices (A1b in particular) will extend this with
 * periodization-policy data (mesocycle templates, intensity-
 * distribution models, taper coefficients, etc.). When A1b lands,
 * extend the interfaces here and add new accessors — do NOT inline
 * the new JSON shape into engines.
 */

import { createHash } from 'crypto';

import type { CoachKnowledgeBase } from './types';

// ---------- Shape definitions ----------

export type EndurancePhase =
  | 'base'
  | 'build'
  | 'peak'
  | 'taper'
  | 'race'
  | 'deload'
  | 'maintenance';

export type ExperienceLevel = 'novice' | 'intermediate' | 'advanced';

export type EquipmentBucket =
  | 'bodyweight_only'
  | 'bodyweight_plus_bar'
  | 'dumbbells_only'
  | 'full_gym';

export type FatigueLevel = 'high' | 'very_high';

export type NoveltyTolerance = 'high' | 'moderate' | 'low' | 'none';

export interface PhaseRules {
  compoundEmphasisPct?: number;
  isolationShareMaxPct?: number;
  noveltyTolerance?: NoveltyTolerance;
  intensityPriority?: string;
  intentNote?: string;
}

export interface ExperienceRules {
  complexityMax?: string;
  spinalLoadingMax?: string;
  sessionPatternCountMax?: number;
  tempoProgressionAllowed?: boolean;
  minimumWarmupMinutes?: number;
  intentNote?: string;
}

export interface EquipmentRules {
  preferredFamilies?: readonly string[];
  primaryProgressionVector?: string;
  secondaryProgressionVector?: string;
  tertiaryProgressionVector?: string;
  intentNote?: string;
}

export interface FatigueRules {
  maxBackToBackHardDays?: number;
  minimumRecoveryDayAfter?: number;
  spinalLoadingHighMaxPerWeek?: number;
}

export interface InterferenceRules {
  minutesBetweenStrengthAndKeyEndurance?: number;
  avoidSameDayKeyEnduranceWithMaxStrength?: boolean;
  intentNote?: string;
}

export interface ProgressionRule {
  id: string;
  trigger?: Record<string, unknown>;
  action?: Record<string, unknown>;
  rationale?: string;
}

// ---------- Internal helpers ----------

export type Principles = CoachKnowledgeBase['principles'];

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((v) => typeof v === 'string')) return undefined;
  return value as readonly string[];
}

// ---------- Accessors ----------

/**
 * Weekly volume growth cap (as a percentage of the previous week) for
 * a given sport. Per Bompa 2018 and the volume-progression literature,
 * a sustainable per-week increase is in the 5–15% range depending on
 * sport — exceeding the cap is a soft injury-risk indicator.
 *
 * Returns `undefined` when the sport is missing from the JSON, in
 * which case the caller should fall back to its pre-A1a behavior
 * (typically: no cap).
 */
export function getVolumeGrowthCap(
  principles: Principles,
  sport: 'running' | 'cycling' | 'swimming' | 'strength',
): number | undefined {
  const capsRaw = principles['volumeGrowthCapsPct'];
  const caps = asObject(capsRaw);
  if (!caps) return undefined;
  return asNumber(caps[sport]);
}

/**
 * Maximum number of hard sessions per week for a given endurance
 * sport. The hard-session count is the foundation of the polarized /
 * pyramidal / threshold-focused distribution models (slice B4); A1a
 * activates the raw cap so engines can refuse to schedule more hard
 * sessions than the principles allow.
 */
export function getMaxHardSessionsPerWeek(
  principles: Principles,
  sport: 'running' | 'cycling' | 'swimming',
): number | undefined {
  const raw = asObject(principles['maxHardSessionsPerWeek']);
  if (!raw) return undefined;
  return asNumber(raw[sport]);
}

/**
 * Per-phase rules: compound emphasis, novelty tolerance, intensity
 * priority. Strength-engine consults these when deciding whether to
 * vary exercises week-to-week — peak/taper/race have
 * `noveltyTolerance: 'none'`, meaning the same exercises must run
 * throughout, with progression on load/reps/tempo only.
 */
export function getPhaseRules(
  principles: Principles,
  phase: EndurancePhase,
): PhaseRules | undefined {
  const selection = asObject(principles['exerciseSelection']);
  if (!selection) return undefined;
  const byPhase = asObject(selection['byPhase']);
  if (!byPhase) return undefined;
  const phaseObj = asObject(byPhase[phase]);
  if (!phaseObj) return undefined;
  return {
    compoundEmphasisPct: asNumber(phaseObj['compoundEmphasisPct']),
    isolationShareMaxPct: asNumber(phaseObj['isolationShareMaxPct']),
    noveltyTolerance: asString(phaseObj['noveltyTolerance']) as NoveltyTolerance | undefined,
    intensityPriority: asString(phaseObj['intensityPriority']),
    intentNote: asString(phaseObj['intentNote']),
  };
}

/**
 * Per-experience rules: complexity ceiling, pattern count cap, tempo
 * progression permission. Strength-engine uses these to filter
 * exercises beyond the athlete's experience level (e.g., novices
 * never see expert-tier lifts).
 */
export function getExperienceRules(
  principles: Principles,
  level: ExperienceLevel,
): ExperienceRules | undefined {
  const selection = asObject(principles['exerciseSelection']);
  if (!selection) return undefined;
  const byExp = asObject(selection['byExperience']);
  if (!byExp) return undefined;
  const expObj = asObject(byExp[level]);
  if (!expObj) return undefined;
  return {
    complexityMax: asString(expObj['complexityMax']),
    spinalLoadingMax: asString(expObj['spinalLoadingMax']),
    sessionPatternCountMax: asNumber(expObj['sessionPatternCountMax']),
    tempoProgressionAllowed: asBoolean(expObj['tempoProgressionAllowed']),
    minimumWarmupMinutes: asNumber(expObj['minimumWarmupMinutes']),
    intentNote: asString(expObj['intentNote']),
  };
}

/**
 * Per-equipment rules: preferred exercise families, progression
 * vector ordering. Bodyweight athletes progress on tempo + leverage;
 * full-gym athletes progress on load + volume.
 */
export function getEquipmentRules(
  principles: Principles,
  equipment: EquipmentBucket,
): EquipmentRules | undefined {
  const selection = asObject(principles['exerciseSelection']);
  if (!selection) return undefined;
  const byEq = asObject(selection['byEquipment']);
  if (!byEq) return undefined;
  const eqObj = asObject(byEq[equipment]);
  if (!eqObj) return undefined;
  return {
    preferredFamilies: asStringArray(eqObj['preferredFamilies']),
    primaryProgressionVector: asString(eqObj['primaryProgressionVector']),
    secondaryProgressionVector: asString(eqObj['secondaryProgressionVector']),
    tertiaryProgressionVector: asString(eqObj['tertiaryProgressionVector']),
    intentNote: asString(eqObj['intentNote']),
  };
}

/**
 * Fatigue-level-specific rules: back-to-back hard-day caps, recovery
 * day requirements. Activates `fatigueModulation.{highFatigueRules,
 * veryHighFatigueRules}` from the JSON.
 */
export function getFatigueRules(
  principles: Principles,
  level: FatigueLevel,
): FatigueRules | undefined {
  const fatigue = asObject(principles['fatigueModulation']);
  if (!fatigue) return undefined;
  const key = level === 'very_high' ? 'veryHighFatigueRules' : 'highFatigueRules';
  const rules = asObject(fatigue[key]);
  if (!rules) return undefined;
  return {
    maxBackToBackHardDays: asNumber(rules['maxBackToBackHardDays']),
    minimumRecoveryDayAfter: asNumber(rules['minimumRecoveryDayAfter']),
    spinalLoadingHighMaxPerWeek: asNumber(rules['spinalLoadingHighMaxPerWeek']),
  };
}

/**
 * Concurrent-training interference rules. The JSON specifies 360
 * minutes (6 hours) between heavy strength and key endurance per
 * Wilson 2012 / Berryman 2018 — same-day pairing degrades the
 * higher-priority discipline unless properly spaced.
 *
 * Slice A1a activates this for the within-day scheduler in
 * biomechanics-and-ordering (when implemented in a future slice).
 */
export function getInterferenceRules(
  principles: Principles,
): InterferenceRules | undefined {
  const fatigue = asObject(principles['fatigueModulation']);
  if (!fatigue) return undefined;
  const interf = asObject(fatigue['interferenceRules']);
  if (!interf) return undefined;
  return {
    minutesBetweenStrengthAndKeyEndurance: asNumber(interf['minutesBetweenStrengthAndKeyEndurance']),
    avoidSameDayKeyEnduranceWithMaxStrength: asBoolean(interf['avoidSameDayKeyEnduranceWithMaxStrength']),
    intentNote: asString(interf['intentNote']),
  };
}

/**
 * The progression-rules array. Each entry has a trigger + action +
 * rationale. Slice A1a exposes the array shape; the consumer
 * (slice B6, strength progression) interprets each rule's trigger
 * against athlete state and applies the action.
 *
 * Returns an empty array (not undefined) when the JSON is missing,
 * so callers can iterate without a null check.
 */
export function getProgressionRules(
  principles: Principles,
): readonly ProgressionRule[] {
  const raw = principles['progressionRules'];
  if (!Array.isArray(raw)) return [];
  const rules: ProgressionRule[] = [];
  for (const entry of raw) {
    const obj = asObject(entry);
    if (!obj) continue;
    const id = asString(obj['id']);
    if (!id) continue;
    const rule: ProgressionRule = { id };
    const trigger = asObject(obj['trigger']);
    if (trigger) rule.trigger = trigger;
    const action = asObject(obj['action']);
    if (action) rule.action = action;
    const rationale = asString(obj['rationale']);
    if (rationale) rule.rationale = rationale;
    rules.push(rule);
  }
  return rules;
}

// ---------- Pure utilities ----------

/**
 * Apply the weekly-volume growth cap to a planned target. Returns
 * the smaller of the planned target and `previousMinutes × (1 + capPct/100)`.
 *
 * Pure function — engines call this with their already-computed
 * `phaseMultiplier * previousMinutes` to enforce a defensive ceiling.
 * The cap CAN reduce planned volume but never increases it.
 *
 * When `previousMinutes` is 0 (cold-start athlete with no history),
 * the cap is meaningless — we return the planned target unchanged.
 *
 * Edge cases:
 *   - Negative cap → treated as 0 (no growth allowed; effectively a
 *     hard ceiling at previousMinutes).
 *   - Negative previousMinutes → treated as 0 (defensive).
 *   - capPct = 0 → equivalent to "this week ≤ last week".
 *   - planned < previous (e.g., taper) → cap doesn't apply; return planned.
 */
export function applyVolumeGrowthCap(
  previousMinutes: number,
  plannedMinutes: number,
  capPct: number,
): number {
  const prev = Math.max(0, previousMinutes);
  if (prev === 0) return Math.max(0, plannedMinutes);
  const safeCap = Math.max(0, capPct);
  const ceiling = Math.round(prev * (1 + safeCap / 100));
  if (plannedMinutes <= prev) return plannedMinutes; // taper/deload — no cap needed.
  return Math.min(plannedMinutes, ceiling);
}

/**
 * Apply both the per-sport volume growth cap from the JSON principles
 * AND a defensive fallback when the sport is missing from the JSON.
 *
 * Convenience wrapper used by the running / cycling / swimming engines
 * so each call site reads as a single line.
 */
// ---------- A1b accessors ----------

export type WeekIntentKind =
  | 'accumulation'
  | 'intensification'
  | 'realization'
  | 'deload'
  | 'recovery'
  | 'taper'
  | 'race'
  | 'post_race_recovery';

export type IntensityDistributionModelName = 'polarized' | 'pyramidal' | 'thresholdFocused';

export type ReturnProtocol =
  | 'vacation_or_life_gap'
  | 'minor_illness_resolved'
  | 'febrile_or_systemic_illness'
  | 'injury_localized'
  | 'post_exertional_symptom_risk'
  | 'unknown_conservative';

export type RacePriority = 'A' | 'B' | 'C';

export interface WeekIntentDefaults {
  volumeMultiplier: number;
  intensityFloor: string;
  intensityCeiling: string;
  primaryQuality: string;
  sorenessSensitive?: boolean;
}

export interface IntensityDistribution {
  low: number;
  moderate: number;
  high: number;
  evidence?: string;
}

export interface TaperPriorityCoefficients {
  durationDays: number;
  volumeDropPct: number;
  intensityPreservedPct: number;
  strengthCutoffDaysBeforeRace: number;
  minimumVolumePct?: number;
  maximumVolumePct?: number;
}

export interface ReturnFromGapRamp {
  weekOnePct: number;
  weeklyIncreasePct: number;
  weeksToFullLoad: number;
  intensityCapZone: string;
  additionalNote?: string;
}

export interface AcwrThresholds {
  lowRisk: { min: number; max: number };
  moderateRisk: { min: number; max: number };
  highRisk: { min: number; max: number };
  underTraining: { min: number; max: number };
}

export interface RiskScoreWeights {
  acwrElevated: number;
  hrvDropPersisted: number;
  sleepDeficit: number;
  painElevated: number;
  adherenceCollapse: number;
  rapidLoadRamp: number;
  recentGapOrIllness: number;
}

/**
 * Read the science-policy version. Returns '0.0.0' when missing
 * (only happens in tests with synthetic principles maps).
 */
export function getSciencePolicyVersion(principles: Principles): string {
  return asString(principles['sciencePolicyVersion']) ?? '0.0.0';
}

/**
 * Compute the content hash of the principles JSON, EXCLUDING the
 * sciencePolicyVersion field itself. Used by the CI check to detect
 * content changes without a version bump.
 *
 * The exclusion matters: hashing the whole object would mean every
 * version bump itself changes the hash, defeating the check.
 */
export function computeSciencePolicyContentHash(principles: Principles): string {
  const { sciencePolicyVersion: _omit, ...rest } = principles as Record<string, unknown>;
  // Recursively sort keys so the serialization is stable regardless
  // of source ordering. JSON.stringify's array-replacer arg is the
  // WRONG tool here — it filters nested values too. We canonicalize
  // by structure instead.
  const stable = JSON.stringify(canonicalize(rest));
  return createHash('sha256').update(stable).digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    out[k] = canonicalize(obj[k]);
  }
  return out;
}

/**
 * Get the mesocycle length for an athlete experience level. Falls
 * back to default (4) when level missing.
 */
export function getMesocycleLength(
  principles: Principles,
  level: 'novice' | 'intermediate' | 'advanced',
): number {
  const meso = asObject(principles['mesocycleLengths']);
  if (!meso) return 4;
  return asNumber(meso[level]) ?? asNumber(meso['default']) ?? 4;
}

/**
 * Get a named block template (e.g., "accumulation_4wk" → 4 WeekIntents).
 * Returns undefined when not found.
 */
export function getBlockTemplate(
  principles: Principles,
  name: string,
): WeekIntentKind[] | undefined {
  const blocks = asObject(principles['blockTemplates']);
  if (!blocks) return undefined;
  const arr = blocks[name];
  if (!Array.isArray(arr)) return undefined;
  return arr.filter((v): v is WeekIntentKind => typeof v === 'string') as WeekIntentKind[];
}

/**
 * Get the defaults for a given week intent (volume multiplier,
 * intensity floor/ceiling, primary quality).
 */
export function getWeekIntentDefaults(
  principles: Principles,
  kind: WeekIntentKind,
): WeekIntentDefaults | undefined {
  const defaults = asObject(principles['weekIntentDefaults']);
  if (!defaults) return undefined;
  const kindObj = asObject(defaults[kind]);
  if (!kindObj) return undefined;
  const volume = asNumber(kindObj['volumeMultiplier']);
  const floor = asString(kindObj['intensityFloor']);
  const ceiling = asString(kindObj['intensityCeiling']);
  const quality = asString(kindObj['primaryQuality']);
  if (volume === undefined || !floor || !ceiling || !quality) return undefined;
  return {
    volumeMultiplier: volume,
    intensityFloor: floor,
    intensityCeiling: ceiling,
    primaryQuality: quality,
    sorenessSensitive: asBoolean(kindObj['sorenessSensitive']) ?? false,
  };
}

/**
 * Get a named intensity distribution model. Returns undefined when
 * the model isn't defined.
 */
export function getIntensityDistribution(
  principles: Principles,
  name: IntensityDistributionModelName,
): IntensityDistribution | undefined {
  const models = asObject(principles['intensityDistributionModels']);
  if (!models) return undefined;
  const obj = asObject(models[name]);
  if (!obj) return undefined;
  const low = asNumber(obj['low']);
  const mod = asNumber(obj['moderate']);
  const high = asNumber(obj['high']);
  if (low === undefined || mod === undefined || high === undefined) return undefined;
  return { low, moderate: mod, high, evidence: asString(obj['evidence']) };
}

/**
 * Pick the default intensity distribution model for an athlete based
 * on sport and experience level. Falls back through:
 *   1. CoachPlanPolicy.intensityDistributionPreference (caller's responsibility)
 *   2. defaultBySport[sport]
 *   3. defaultByLevel[level]
 *   4. 'polarized'
 */
export function pickDefaultIntensityDistribution(
  principles: Principles,
  sport: string,
  level: 'novice' | 'intermediate' | 'advanced',
): IntensityDistributionModelName {
  const models = asObject(principles['intensityDistributionModels']);
  if (!models) return 'polarized';
  const bySport = asObject(models['defaultBySport']);
  const bySportPick = bySport ? asString(bySport[sport]) : undefined;
  if (bySportPick) return bySportPick as IntensityDistributionModelName;
  const byLevel = asObject(models['defaultByLevel']);
  const byLevelPick = byLevel ? asString(byLevel[level]) : undefined;
  if (byLevelPick) return byLevelPick as IntensityDistributionModelName;
  return 'polarized';
}

/**
 * Get taper coefficients for a race priority (A/B/C).
 */
export function getTaperCoefficients(
  principles: Principles,
  priority: RacePriority,
): TaperPriorityCoefficients | undefined {
  const taper = asObject(principles['taperCoefficients']);
  if (!taper) return undefined;
  const byPriority = asObject(taper['byPriority']);
  if (!byPriority) return undefined;
  const minimumVolumePct = asNumber(taper['minimumVolumePct']);
  const maximumVolumePct = asNumber(taper['maximumVolumePct']);
  const obj = asObject(byPriority[priority]);
  if (!obj) return undefined;
  const durationDays = asNumber(obj['durationDays']);
  const volumeDropPct = asNumber(obj['volumeDropPct']);
  const intensityPreservedPct = asNumber(obj['intensityPreservedPct']);
  const strengthCutoff = asNumber(obj['strengthCutoffDaysBeforeRace']);
  if (
    durationDays === undefined ||
    volumeDropPct === undefined ||
    intensityPreservedPct === undefined ||
    strengthCutoff === undefined
  ) return undefined;
  return {
    durationDays,
    volumeDropPct,
    intensityPreservedPct,
    strengthCutoffDaysBeforeRace: strengthCutoff,
    ...(minimumVolumePct !== undefined ? { minimumVolumePct } : {}),
    ...(maximumVolumePct !== undefined ? { maximumVolumePct } : {}),
  };
}

/**
 * Get ACWR risk-band thresholds.
 */
export function getAcwrThresholds(principles: Principles): AcwrThresholds | undefined {
  const raw = asObject(principles['acwrThresholds']);
  if (!raw) return undefined;
  const band = (key: string): { min: number; max: number } | undefined => {
    const obj = asObject(raw[key]);
    if (!obj) return undefined;
    const min = asNumber(obj['min']);
    const max = asNumber(obj['max']);
    if (min === undefined || max === undefined) return undefined;
    return { min, max };
  };
  const lowRisk = band('lowRisk');
  const moderateRisk = band('moderateRisk');
  const highRisk = band('highRisk');
  const underTraining = band('underTraining');
  if (!lowRisk || !moderateRisk || !highRisk || !underTraining) return undefined;
  return { lowRisk, moderateRisk, highRisk, underTraining };
}

/**
 * Get risk-score weights for the deload composite signal (B5).
 */
export function getRiskScoreWeights(principles: Principles): RiskScoreWeights | undefined {
  const raw = asObject(principles['riskScoreWeights']);
  if (!raw) return undefined;
  const get = (k: string): number | undefined => asNumber(raw[k]);
  const acwrElevated = get('acwrElevated');
  const hrvDropPersisted = get('hrvDropPersisted');
  const sleepDeficit = get('sleepDeficit');
  const painElevated = get('painElevated');
  const adherenceCollapse = get('adherenceCollapse');
  const rapidLoadRamp = get('rapidLoadRamp');
  const recentGapOrIllness = get('recentGapOrIllness');
  if (
    acwrElevated === undefined ||
    hrvDropPersisted === undefined ||
    sleepDeficit === undefined ||
    painElevated === undefined ||
    adherenceCollapse === undefined ||
    rapidLoadRamp === undefined ||
    recentGapOrIllness === undefined
  ) return undefined;
  return {
    acwrElevated,
    hrvDropPersisted,
    sleepDeficit,
    painElevated,
    adherenceCollapse,
    rapidLoadRamp,
    recentGapOrIllness,
  };
}

/**
 * Get the scheduled deload cadence (weeks-between-deloads) for an
 * athlete level. Falls back to defaults.
 */
export function getScheduledDeloadCadence(
  principles: Principles,
  level: 'novice' | 'intermediate' | 'advanced',
): number {
  const raw = asObject(principles['deloadCadenceRules']);
  if (!raw) return 4;
  const byLevel = asObject(raw['scheduledCadenceByLevel']);
  if (!byLevel) return 4;
  return asNumber(byLevel[level]) ?? 4;
}

/**
 * Get the return-from-gap ramp for a specific protocol class.
 */
export function getReturnFromGapRamp(
  principles: Principles,
  protocol: ReturnProtocol,
): ReturnFromGapRamp | undefined {
  const raw = asObject(principles['returnFromGapRamps']);
  if (!raw) return undefined;
  const obj = asObject(raw[protocol]);
  if (!obj) return undefined;
  const weekOnePct = asNumber(obj['weekOnePct']);
  const weeklyIncreasePct = asNumber(obj['weeklyIncreasePct']);
  const weeksToFullLoad = asNumber(obj['weeksToFullLoad']);
  const intensityCapZone = asString(obj['intensityCapZone']);
  if (
    weekOnePct === undefined ||
    weeklyIncreasePct === undefined ||
    weeksToFullLoad === undefined ||
    !intensityCapZone
  ) return undefined;
  return {
    weekOnePct,
    weeklyIncreasePct,
    weeksToFullLoad,
    intensityCapZone,
    additionalNote: asString(obj['additionalNote']),
  };
}

/**
 * Get the default policy for a missed-session of a given role.
 * Roles: 'easy_aerobic' | 'strength_accessory' | 'key_interval_tempo'
 *      | 'long_run_ride' | 'taper_session'.
 */
export function getMissedSessionPolicy(
  principles: Principles,
  role: string,
): string | undefined {
  const raw = asObject(principles['missedSessionPolicyDefaults']);
  if (!raw) return undefined;
  return asString(raw[role]);
}

/**
 * Get the minimum-viable-week template for an athlete shape. Used by
 * C8's low-adherence policy.
 */
export function getMinimumViableWeekTemplate(
  principles: Principles,
  athleteShape: 'endurance_athlete' | 'strength_athlete' | 'hybrid_athlete',
): Array<{ role: string; sessionType: string; durationMinutes: number }> | undefined {
  const raw = asObject(principles['minimumViableWeekTemplates']);
  if (!raw) return undefined;
  const arr = raw[athleteShape];
  if (!Array.isArray(arr)) return undefined;
  const result: Array<{ role: string; sessionType: string; durationMinutes: number }> = [];
  for (const entry of arr) {
    const obj = asObject(entry);
    if (!obj) continue;
    const role = asString(obj['role']);
    const sessionType = asString(obj['sessionType']);
    const durationMinutes = asNumber(obj['durationMinutes']);
    if (!role || !sessionType || durationMinutes === undefined) continue;
    result.push({ role, sessionType, durationMinutes });
  }
  return result;
}

export function applyVolumeGrowthCapForSport(
  principles: Principles,
  sport: 'running' | 'cycling' | 'swimming' | 'strength',
  previousMinutes: number,
  plannedMinutes: number,
  /**
   * Fallback cap when the JSON is missing the sport entry. Default
   * `100` means "no cap" — the planned value passes through
   * unchanged, preserving pre-A1a behavior.
   */
  fallbackCapPct = 100,
): number {
  const cap = getVolumeGrowthCap(principles, sport) ?? fallbackCapPct;
  return applyVolumeGrowthCap(previousMinutes, plannedMinutes, cap);
}
