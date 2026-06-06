// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'fs';
import path from 'path';
import type { CoachKnowledgeBase, Exercise, WorkoutTemplate } from './types';

let cachedKnowledge: CoachKnowledgeBase | null = null;

function knowledgePath(...segments: string[]): string {
  return path.join(__dirname, 'knowledge', ...segments);
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

export class TrainingKnowledgeFormatError extends Error {
  constructor(public readonly filePath: string, message: string) {
    super(`${path.basename(filePath)}: ${message}`);
    this.name = 'TrainingKnowledgeFormatError';
  }
}

export function readJsonCompatibleYaml<T>(filePath: string): T {
  const raw = fs.readFileSync(filePath, 'utf8');
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) {
    throw new TrainingKnowledgeFormatError(
      filePath,
      'template files must be JSON-compatible YAML starting with "[" or "{".',
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TrainingKnowledgeFormatError(filePath, `invalid JSON-compatible YAML: ${message}`);
  }
}

function readMarkdown(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

/**
 * Required top-level keys on training-principles.json after slice A1b.
 * Codex P2 fix — the hash gate catches unversioned drift, but cannot
 * catch the case where the JSON is intentionally rewritten and the
 * version bumped, but a required key is missing. This list is the
 * runtime schema check.
 *
 * When a key is missing, we throw with a clear message so the
 * developer sees the failure on the FIRST plan generation, not
 * mysteriously at consumption time deep in an engine.
 */
const REQUIRED_A1B_PRINCIPLES_KEYS: ReadonlyArray<string> = [
  'sciencePolicyVersion',
  'volumeGrowthCapsPct',
  'maxHardSessionsPerWeek',
  'exerciseSelection',
  'progressionRules',
  'fatigueModulation',
  // Slice A1b — periodization policy keys.
  'mesocycleLengths',
  'blockTemplates',
  'weekIntentDefaults',
  'intensityDistributionModels',
  'taperCoefficients',
  'acwrThresholds',
  'riskScoreWeights',
  'deloadCadenceRules',
  'returnFromGapRamps',
  'missedSessionPolicyDefaults',
  'minimumViableWeekTemplates',
];

export class TrainingPrinciplesSchemaError extends Error {
  constructor(public readonly missingKeys: readonly string[]) {
    super(
      `training-principles.json is missing required top-level keys: ${missingKeys.join(', ')}. ` +
      'Slice A1b expects all periodization-policy keys present at load time.',
    );
    this.name = 'TrainingPrinciplesSchemaError';
  }
}

/**
 * Runtime check that every required key is present on the loaded JSON.
 * Pure: takes the parsed object, returns an array of missing keys.
 * Exported so tests can call directly.
 */
export function findMissingPrinciplesKeys(
  principles: Record<string, unknown>,
): string[] {
  const missing: string[] = [];
  for (const key of REQUIRED_A1B_PRINCIPLES_KEYS) {
    const v = principles[key];
    if (v === undefined || v === null) missing.push(key);
  }
  return missing;
}

/**
 * Codex R2 P3 fix — nested section-level validation. The top-level
 * key check catches "key entirely missing"; this check catches
 * "key present but inner shape wrong" (e.g., `weekIntentDefaults`
 * is `{}`, or `acwrThresholds.lowRisk` lost its `max` field).
 *
 * Returns an array of "<path>: <reason>" strings. Empty = valid.
 * Exported so the loader + tests can both invoke it.
 */
export function findMalformedPrinciplesSections(
  principles: Record<string, unknown>,
): string[] {
  const issues: string[] = [];
  const isObj = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v);
  const isNumber = (v: unknown): boolean =>
    typeof v === 'number' && Number.isFinite(v);
  const isArray = (v: unknown): boolean => Array.isArray(v);
  const validComplexity = new Set(['beginner', 'intermediate', 'advanced', 'expert']);
  const validSpinalLoading = new Set(['low', 'moderate', 'high']);

  // R4 P2 fix — required top-level sections must be the right shape,
  // not just "present." Codex caught (R4 P2 #4) that the prior
  // validator used `if (isObj(principles.X)) { ... }`, which silently
  // skipped the entire inner check if X arrived as a string, number,
  // or array. So `taperCoefficients: "TODO"` would load cleanly.
  //
  // `requireObject` pushes an explicit issue when the value exists but
  // is the wrong shape, AND returns null so the caller can short-circuit
  // the inner checks. The missing-key check (findMissingPrinciplesKeys)
  // handles undefined/null.
  const requireObject = (
    name: string,
    v: unknown,
  ): Record<string, unknown> | null => {
    if (v === undefined || v === null) return null; // handled by missing-keys check
    if (!isObj(v)) {
      issues.push(`${name}: must be an object (got ${describeValue(v)})`);
      return null;
    }
    return v;
  };

  // sciencePolicyVersion must be a non-empty string.
  if (typeof principles.sciencePolicyVersion !== 'string' || principles.sciencePolicyVersion.length === 0) {
    issues.push('sciencePolicyVersion: must be a non-empty string');
  }

  // mesocycleLengths: at minimum `default` must be a finite number;
  // per-level overrides (`novice`, `advanced`, `intermediate`) are
  // each optional but if present must be numbers. (`getMesocycleLength`
  // falls back to `default` for missing levels.)
  {
    const m = requireObject('mesocycleLengths', principles.mesocycleLengths);
    if (m) {
      if (!isNumber(m.default)) issues.push('mesocycleLengths.default: must be a finite number');
      for (const k of ['novice', 'intermediate', 'advanced']) {
        if (m[k] !== undefined && !isNumber(m[k])) {
          issues.push(`mesocycleLengths.${k}: present but not a finite number`);
        }
      }
    }
  }

  // blockTemplates: at least 1 entry; each entry is an array of strings.
  {
    const blockTemplates = requireObject('blockTemplates', principles.blockTemplates);
    if (blockTemplates) {
      const entries = Object.entries(blockTemplates);
      if (entries.length === 0) issues.push('blockTemplates: must have ≥1 template');
      for (const [name, value] of entries) {
        if (!isArray(value) || (value as unknown[]).some((s) => typeof s !== 'string')) {
          issues.push(`blockTemplates.${name}: must be a string[]`);
        }
      }
    }
  }

  // weekIntentDefaults: every required intent kind present with the right inner fields.
  {
    const intents = requireObject('weekIntentDefaults', principles.weekIntentDefaults);
    if (intents) {
      const requiredKinds = ['accumulation', 'intensification', 'realization', 'deload', 'recovery', 'taper', 'race', 'post_race_recovery'];
      for (const kind of requiredKinds) {
        if (!isObj(intents[kind])) {
          issues.push(`weekIntentDefaults.${kind}: missing or not an object`);
          continue;
        }
        const inner = intents[kind] as Record<string, unknown>;
        if (!isNumber(inner.volumeMultiplier)) issues.push(`weekIntentDefaults.${kind}.volumeMultiplier: must be a number`);
        if (typeof inner.intensityFloor !== 'string') issues.push(`weekIntentDefaults.${kind}.intensityFloor: must be a string`);
        if (typeof inner.intensityCeiling !== 'string') issues.push(`weekIntentDefaults.${kind}.intensityCeiling: must be a string`);
        if (typeof inner.primaryQuality !== 'string') issues.push(`weekIntentDefaults.${kind}.primaryQuality: must be a string`);
      }
    }
  }

  // intensityDistributionModels: polarized/pyramidal/thresholdFocused all have low/moderate/high.
  {
    const models = requireObject('intensityDistributionModels', principles.intensityDistributionModels);
    if (models) {
      for (const name of ['polarized', 'pyramidal', 'thresholdFocused']) {
        if (!isObj(models[name])) {
          issues.push(`intensityDistributionModels.${name}: missing or not an object`);
          continue;
        }
        const inner = models[name] as Record<string, unknown>;
        for (const dim of ['low', 'moderate', 'high']) {
          if (!isNumber(inner[dim])) issues.push(`intensityDistributionModels.${name}.${dim}: must be a number`);
        }
      }
    }
  }

  // taperCoefficients.byPriority: A/B/C with all four numeric fields each.
  {
    const t = requireObject('taperCoefficients', principles.taperCoefficients);
    if (t) {
      if (!isObj(t.byPriority)) {
        issues.push('taperCoefficients.byPriority: missing or not an object');
      } else {
        for (const prio of ['A', 'B', 'C']) {
          if (!isObj(t.byPriority[prio])) {
            issues.push(`taperCoefficients.byPriority.${prio}: missing or not an object`);
            continue;
          }
          const inner = t.byPriority[prio] as Record<string, unknown>;
          for (const k of ['durationDays', 'volumeDropPct', 'intensityPreservedPct', 'strengthCutoffDaysBeforeRace']) {
            if (!isNumber(inner[k])) issues.push(`taperCoefficients.byPriority.${prio}.${k}: must be a number`);
          }
        }
      }
    }
  }

  // acwrThresholds: four bands × {min,max} each.
  {
    const t = requireObject('acwrThresholds', principles.acwrThresholds);
    if (t) {
      for (const band of ['lowRisk', 'moderateRisk', 'highRisk', 'underTraining']) {
        if (!isObj(t[band])) {
          issues.push(`acwrThresholds.${band}: missing or not an object`);
          continue;
        }
        const inner = t[band] as Record<string, unknown>;
        if (!isNumber(inner.min)) issues.push(`acwrThresholds.${band}.min: must be a number`);
        if (!isNumber(inner.max)) issues.push(`acwrThresholds.${band}.max: must be a number`);
      }
    }
  }

  // riskScoreWeights: 7 numeric fields.
  {
    const w = requireObject('riskScoreWeights', principles.riskScoreWeights);
    if (w) {
      for (const k of ['acwrElevated', 'hrvDropPersisted', 'sleepDeficit', 'painElevated', 'adherenceCollapse', 'rapidLoadRamp', 'recentGapOrIllness']) {
        if (!isNumber(w[k])) issues.push(`riskScoreWeights.${k}: must be a number`);
      }
    }
  }

  // returnFromGapRamps: every protocol class has weekOnePct + weeklyIncreasePct + weeksToFullLoad + intensityCapZone.
  {
    const ramps = requireObject('returnFromGapRamps', principles.returnFromGapRamps);
    if (ramps) {
      const requiredProtocols = ['vacation_or_life_gap', 'minor_illness_resolved', 'febrile_or_systemic_illness', 'injury_localized', 'post_exertional_symptom_risk', 'unknown_conservative'];
      for (const proto of requiredProtocols) {
        if (!isObj(ramps[proto])) {
          issues.push(`returnFromGapRamps.${proto}: missing or not an object`);
          continue;
        }
        const inner = ramps[proto] as Record<string, unknown>;
        if (!isNumber(inner.weekOnePct)) issues.push(`returnFromGapRamps.${proto}.weekOnePct: must be a number`);
        if (!isNumber(inner.weeklyIncreasePct)) issues.push(`returnFromGapRamps.${proto}.weeklyIncreasePct: must be a number`);
        if (!isNumber(inner.weeksToFullLoad)) issues.push(`returnFromGapRamps.${proto}.weeksToFullLoad: must be a number`);
        if (typeof inner.intensityCapZone !== 'string') issues.push(`returnFromGapRamps.${proto}.intensityCapZone: must be a string`);
      }
    }
  }

  // R3 P2 fix — add validators for the 5 previously-skipped sections.

  // exerciseSelection: per-phase and per-experience objects with
  // structured inner shapes. Validators check the expected
  // sub-keys exist.
  {
    const exSel = requireObject('exerciseSelection', principles.exerciseSelection);
    if (exSel) {
      if (!isObj(exSel.byPhase)) {
        issues.push('exerciseSelection.byPhase: missing or not an object');
      } else {
        // At minimum each phase entry should expose noveltyTolerance + intentNote.
        const byPhase = exSel.byPhase as Record<string, unknown>;
        for (const [phase, value] of Object.entries(byPhase)) {
          if (!isObj(value)) {
            issues.push(`exerciseSelection.byPhase.${phase}: not an object`);
            continue;
          }
          const inner = value as Record<string, unknown>;
          if (typeof inner.intentNote !== 'string') {
            issues.push(`exerciseSelection.byPhase.${phase}.intentNote: must be a string`);
          }
        }
      }
      if (exSel.byExperience !== undefined && !isObj(exSel.byExperience)) {
        issues.push('exerciseSelection.byExperience: present but not an object');
      } else if (isObj(exSel.byExperience)) {
        for (const [level, value] of Object.entries(exSel.byExperience)) {
          if (!isObj(value)) {
            issues.push(`exerciseSelection.byExperience.${level}: not an object`);
            continue;
          }
          const inner = value as Record<string, unknown>;
          if (inner.complexityMax !== undefined && !validComplexity.has(String(inner.complexityMax))) {
            issues.push(`exerciseSelection.byExperience.${level}.complexityMax: must be one of beginner/intermediate/advanced/expert`);
          }
          if (inner.spinalLoadingMax !== undefined && !validSpinalLoading.has(String(inner.spinalLoadingMax))) {
            issues.push(`exerciseSelection.byExperience.${level}.spinalLoadingMax: must be one of low/moderate/high`);
          }
        }
      }
      if (exSel.byEquipment !== undefined && !isObj(exSel.byEquipment)) {
        issues.push('exerciseSelection.byEquipment: present but not an object');
      }
    }
  }

  // fatigueModulation: must expose veryHighFatigueRules / highFatigueRules /
  // interferenceRules with the correct inner numeric/boolean fields.
  {
    const fm = requireObject('fatigueModulation', principles.fatigueModulation);
    if (fm) {
      if (!isObj(fm.veryHighFatigueRules)) {
        issues.push('fatigueModulation.veryHighFatigueRules: missing or not an object');
      } else {
        const inner = fm.veryHighFatigueRules as Record<string, unknown>;
        if (!isNumber(inner.maxBackToBackHardDays)) {
          issues.push('fatigueModulation.veryHighFatigueRules.maxBackToBackHardDays: must be a number');
        }
      }
      if (!isObj(fm.highFatigueRules)) {
        issues.push('fatigueModulation.highFatigueRules: missing or not an object');
      } else {
        const inner = fm.highFatigueRules as Record<string, unknown>;
        if (!isNumber(inner.maxBackToBackHardDays)) {
          issues.push('fatigueModulation.highFatigueRules.maxBackToBackHardDays: must be a number');
        }
      }
      if (!isObj(fm.interferenceRules)) {
        issues.push('fatigueModulation.interferenceRules: missing or not an object');
      } else {
        const inner = fm.interferenceRules as Record<string, unknown>;
        if (!isNumber(inner.minutesBetweenStrengthAndKeyEndurance)) {
          issues.push('fatigueModulation.interferenceRules.minutesBetweenStrengthAndKeyEndurance: must be a number');
        }
      }
    }
  }

  // deloadCadenceRules: minWeeks/maxWeeks + scheduledCadenceByLevel +
  // dataInformedTriggerThresholdScore.
  {
    const dcr = requireObject('deloadCadenceRules', principles.deloadCadenceRules);
    if (dcr) {
      if (!isNumber(dcr.minWeeksBetweenDeloads)) {
        issues.push('deloadCadenceRules.minWeeksBetweenDeloads: must be a number');
      }
      if (!isNumber(dcr.maxWeeksBetweenDeloads)) {
        issues.push('deloadCadenceRules.maxWeeksBetweenDeloads: must be a number');
      }
      if (!isNumber(dcr.dataInformedTriggerThresholdScore)) {
        issues.push('deloadCadenceRules.dataInformedTriggerThresholdScore: must be a number');
      }
      if (!isObj(dcr.scheduledCadenceByLevel)) {
        issues.push('deloadCadenceRules.scheduledCadenceByLevel: missing or not an object');
      } else {
        const inner = dcr.scheduledCadenceByLevel as Record<string, unknown>;
        for (const level of ['novice', 'intermediate', 'advanced']) {
          if (!isNumber(inner[level])) {
            issues.push(`deloadCadenceRules.scheduledCadenceByLevel.${level}: must be a number`);
          }
        }
      }
    }
  }

  // missedSessionPolicyDefaults: every session-role key maps to a string policy verb.
  {
    const msp = requireObject('missedSessionPolicyDefaults', principles.missedSessionPolicyDefaults);
    if (msp) {
      const requiredRoles = ['easy_aerobic', 'strength_accessory', 'key_interval_tempo', 'long_run_ride', 'taper_session'];
      for (const role of requiredRoles) {
        if (typeof msp[role] !== 'string') {
          issues.push(`missedSessionPolicyDefaults.${role}: must be a string`);
        }
      }
    }
  }

  // minimumViableWeekTemplates: every athlete-shape key maps to an
  // array of {role, sessionType, durationMinutes} entries.
  {
    const mvw = requireObject('minimumViableWeekTemplates', principles.minimumViableWeekTemplates);
    if (mvw) {
      const requiredShapes = ['endurance_athlete', 'strength_athlete', 'hybrid_athlete'];
      for (const shape of requiredShapes) {
        const arr = mvw[shape];
        if (!isArray(arr)) {
          issues.push(`minimumViableWeekTemplates.${shape}: missing or not an array`);
          continue;
        }
        for (const [idx, entry] of (arr as unknown[]).entries()) {
          if (!isObj(entry)) {
            issues.push(`minimumViableWeekTemplates.${shape}[${idx}]: not an object`);
            continue;
          }
          const inner = entry as Record<string, unknown>;
          if (typeof inner.role !== 'string') {
            issues.push(`minimumViableWeekTemplates.${shape}[${idx}].role: must be a string`);
          }
          if (typeof inner.sessionType !== 'string') {
            issues.push(`minimumViableWeekTemplates.${shape}[${idx}].sessionType: must be a string`);
          }
          if (!isNumber(inner.durationMinutes)) {
            issues.push(`minimumViableWeekTemplates.${shape}[${idx}].durationMinutes: must be a number`);
          }
        }
      }
    }
  }

  return issues;
}

/**
 * Compact, log-safe description of an unexpected value for error
 * messages. Never quotes user-content strings in full so a malformed
 * JSON can't smuggle log-formatting noise.
 */
function describeValue(v: unknown): string {
  if (Array.isArray(v)) return `array(length=${v.length})`;
  if (v === null) return 'null';
  if (typeof v === 'object') return 'object'; // unreachable for misshape — defensive
  if (typeof v === 'string') return `string(length=${v.length})`;
  return typeof v;
}

export class TrainingPrinciplesMalformedSectionError extends Error {
  constructor(public readonly issues: readonly string[]) {
    super(
      `training-principles.json has malformed sections:\n  - ${issues.join('\n  - ')}`,
    );
    this.name = 'TrainingPrinciplesMalformedSectionError';
  }
}

export function loadCoachKnowledge(): CoachKnowledgeBase {
  if (cachedKnowledge) return cachedKnowledge;

  const exercises = readJsonFile<Exercise[]>(knowledgePath('entities', 'exercises.json'));
  const principles = readJsonFile<Record<string, unknown>>(knowledgePath('entities', 'training-principles.json'));
  // Codex P2 — schema-key validation at load time. The hash gate in
  // scripts/ci/science-policy-version-check.mjs catches unversioned
  // drift; this check catches versioned-but-incomplete edits.
  const missing = findMissingPrinciplesKeys(principles);
  if (missing.length > 0) {
    throw new TrainingPrinciplesSchemaError(missing);
  }
  // Codex R2 P3 — nested section-level validation. The top-level
  // key check passes when a section is present-but-empty; this
  // check ensures required inner fields exist with the right types.
  const malformed = findMalformedPrinciplesSections(principles);
  if (malformed.length > 0) {
    throw new TrainingPrinciplesMalformedSectionError(malformed);
  }
  const workoutTemplates = [
    ...readJsonCompatibleYaml<WorkoutTemplate[]>(knowledgePath('templates', 'run-workouts.yaml')),
    ...readJsonCompatibleYaml<WorkoutTemplate[]>(knowledgePath('templates', 'bike-workouts.yaml')),
    ...readJsonCompatibleYaml<WorkoutTemplate[]>(knowledgePath('templates', 'swim-workouts.yaml')),
    ...readJsonCompatibleYaml<WorkoutTemplate[]>(knowledgePath('templates', 'strength-blocks.yaml')),
  ];

  cachedKnowledge = {
    exercises,
    workoutTemplates,
    principles,
    docs: {
      hybridAthleteRules: readMarkdown(knowledgePath('docs', 'hybrid-athlete-rules.md')),
      marathonPeriodization: readMarkdown(knowledgePath('docs', 'marathon-periodization.md')),
      llmToolContract: readMarkdown(knowledgePath('docs', 'llm-tool-contract.md')),
    },
  };

  return cachedKnowledge;
}

export function resetCoachKnowledgeCache(): void {
  cachedKnowledge = null;
}
