/**
 * Codex P2 — A1b runtime schema validation tests.
 *
 * Pins:
 *   - findMissingPrinciplesKeys returns missing required keys
 *   - Empty principles → all 17 required keys missing
 *   - Complete principles → no missing keys
 *   - Real live JSON passes (regression — current
 *     training-principles.json must satisfy the schema)
 *   - TrainingPrinciplesSchemaError message lists the missing keys
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  TrainingKnowledgeFormatError,
  TrainingPrinciplesSchemaError,
  findMalformedPrinciplesSections,
  findMissingPrinciplesKeys,
  loadCoachKnowledge,
  readJsonCompatibleYaml,
} from '../../src/services/coach-kernel/knowledge-loader';

describe('findMissingPrinciplesKeys', () => {
  it('empty object → all required keys missing', () => {
    const missing = findMissingPrinciplesKeys({});
    expect(missing).toContain('sciencePolicyVersion');
    expect(missing).toContain('mesocycleLengths');
    expect(missing).toContain('blockTemplates');
    expect(missing).toContain('weekIntentDefaults');
    expect(missing).toContain('intensityDistributionModels');
    expect(missing).toContain('taperCoefficients');
    expect(missing).toContain('acwrThresholds');
    expect(missing).toContain('riskScoreWeights');
    expect(missing).toContain('deloadCadenceRules');
    expect(missing).toContain('returnFromGapRamps');
    expect(missing).toContain('missedSessionPolicyDefaults');
    expect(missing).toContain('minimumViableWeekTemplates');
  });

  it('object with required key but null value → still missing (defensive)', () => {
    const missing = findMissingPrinciplesKeys({
      sciencePolicyVersion: '1.0.0',
      mesocycleLengths: null,
    });
    expect(missing).toContain('mesocycleLengths');
    expect(missing).not.toContain('sciencePolicyVersion');
  });

  it('live training-principles.json passes the schema check', () => {
    // This test pins that the CURRENT JSON satisfies the schema —
    // protects against accidentally removing required keys on edits.
    const knowledge = loadCoachKnowledge();
    const missing = findMissingPrinciplesKeys(knowledge.principles);
    expect(missing).toEqual([]);
  });
});

describe('TrainingPrinciplesSchemaError', () => {
  it('exposes missingKeys via the error instance', () => {
    const err = new TrainingPrinciplesSchemaError(['mesocycleLengths', 'taperCoefficients']);
    expect(err.missingKeys).toEqual(['mesocycleLengths', 'taperCoefficients']);
    expect(err.message).toContain('mesocycleLengths');
    expect(err.message).toContain('taperCoefficients');
    expect(err.name).toBe('TrainingPrinciplesSchemaError');
  });
});

describe('Codex R2 P3 — findMalformedPrinciplesSections (nested validation)', () => {
  it('live training-principles.json has NO malformed sections', () => {
    const knowledge = loadCoachKnowledge();
    const issues = findMalformedPrinciplesSections(knowledge.principles);
    expect(issues).toEqual([]);
  });

  it('flags empty mesocycleLengths object as missing required default', () => {
    const issues = findMalformedPrinciplesSections({ mesocycleLengths: {} });
    expect(issues.some((i) => /mesocycleLengths\.default/.test(i))).toBe(true);
  });

  it('flags non-numeric mesocycleLengths.novice override', () => {
    const issues = findMalformedPrinciplesSections({
      mesocycleLengths: { default: 4, novice: 'five' },
    });
    expect(issues.some((i) => /mesocycleLengths\.novice/.test(i))).toBe(true);
  });

  it('flags missing weekIntentDefaults.taper entry', () => {
    const issues = findMalformedPrinciplesSections({
      weekIntentDefaults: { accumulation: { volumeMultiplier: 1, intensityFloor: 'aerobic', intensityCeiling: 'threshold', primaryQuality: 'volume' } },
    });
    expect(issues.some((i) => /weekIntentDefaults\.taper/.test(i))).toBe(true);
  });

  it('flags malformed acwrThresholds.lowRisk missing max', () => {
    const issues = findMalformedPrinciplesSections({
      acwrThresholds: { lowRisk: { min: 0.8 }, moderateRisk: { min: 1.3, max: 1.5 }, highRisk: { min: 1.5, max: 100 }, underTraining: { min: 0, max: 0.8 } },
    });
    expect(issues.some((i) => /acwrThresholds\.lowRisk\.max/.test(i))).toBe(true);
  });

  it('flags missing taperCoefficients.byPriority.A', () => {
    const issues = findMalformedPrinciplesSections({
      taperCoefficients: { byPriority: { B: { durationDays: 7, volumeDropPct: 45, intensityPreservedPct: 100, strengthCutoffDaysBeforeRace: 3 } } },
    });
    expect(issues.some((i) => /taperCoefficients\.byPriority\.A/.test(i))).toBe(true);
  });

  it('flags empty blockTemplates as no-templates', () => {
    const issues = findMalformedPrinciplesSections({ blockTemplates: {} });
    expect(issues.some((i) => /blockTemplates: must have ≥1 template/.test(i))).toBe(true);
  });

  it('flags missing returnFromGapRamps.febrile_or_systemic_illness', () => {
    const issues = findMalformedPrinciplesSections({
      returnFromGapRamps: { vacation_or_life_gap: { weekOnePct: 60, weeklyIncreasePct: 15, weeksToFullLoad: 3, intensityCapZone: 'tempo' } },
    });
    expect(issues.some((i) => /febrile_or_systemic_illness/.test(i))).toBe(true);
  });

  it('flags missing sciencePolicyVersion', () => {
    const issues = findMalformedPrinciplesSections({});
    expect(issues.some((i) => /sciencePolicyVersion/.test(i))).toBe(true);
  });

  it('flags invalid exerciseSelection experience ceilings', () => {
    const issues = findMalformedPrinciplesSections({
      exerciseSelection: {
        byPhase: {
          base: { intentNote: 'ok' },
        },
        byExperience: {
          novice: {
            complexityMax: 'elite',
            spinalLoadingMax: 'axial',
          },
        },
      },
    });
    expect(issues.some((i) => /complexityMax/.test(i))).toBe(true);
    expect(issues.some((i) => /spinalLoadingMax/.test(i))).toBe(true);
  });
});

describe('readJsonCompatibleYaml format guard', () => {
  it('accepts the repository JSON-compatible template shape', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'training-knowledge-'));
    const file = path.join(dir, 'template.yaml');
    fs.writeFileSync(file, '[{"id":"x"}]', 'utf8');

    expect(readJsonCompatibleYaml<Array<{ id: string }>>(file)).toEqual([{ id: 'x' }]);
  });

  it('rejects true YAML before JSON.parse ambiguity', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'training-knowledge-'));
    const file = path.join(dir, 'template.yaml');
    fs.writeFileSync(file, '- id: x\n', 'utf8');

    expect(() => readJsonCompatibleYaml(file)).toThrow(TrainingKnowledgeFormatError);
    expect(() => readJsonCompatibleYaml(file)).toThrow(/JSON-compatible YAML/);
  });
});

// ─── R4 P2 — required top-level sections rejected when wrong-typed ───
//
// Codex caught (R4 P2 #4) that the prior validator used the pattern
// `if (isObj(principles.X)) { ... }`, which silently dropped the entire
// inner check when X arrived as a string, a number, or an array. So
// a typo like `taperCoefficients: "TODO"` loaded cleanly and then
// blew up at engine consumption time. The fix uses `requireObject`
// to push an explicit `<key>: must be an object` issue when the
// shape is wrong.

describe('R4 P2 — required sections rejected when present-but-wrong-type', () => {
  it('mesocycleLengths as a string surfaces a malformed-section issue', () => {
    const issues = findMalformedPrinciplesSections({
      mesocycleLengths: 'todo' as any,
    });
    expect(issues.some((i) => /mesocycleLengths: must be an object/.test(i))).toBe(true);
  });

  it('blockTemplates as an array surfaces a malformed-section issue', () => {
    const issues = findMalformedPrinciplesSections({
      blockTemplates: ['accumulationBlock'] as any,
    });
    expect(issues.some((i) => /blockTemplates: must be an object/.test(i))).toBe(true);
  });

  it('weekIntentDefaults as a number surfaces a malformed-section issue', () => {
    const issues = findMalformedPrinciplesSections({
      weekIntentDefaults: 42 as any,
    });
    expect(issues.some((i) => /weekIntentDefaults: must be an object/.test(i))).toBe(true);
  });

  it('intensityDistributionModels as a string surfaces a malformed-section issue', () => {
    const issues = findMalformedPrinciplesSections({
      intensityDistributionModels: 'polarized' as any,
    });
    expect(issues.some((i) => /intensityDistributionModels: must be an object/.test(i))).toBe(true);
  });

  it('taperCoefficients as a string is the canonical regression target', () => {
    const issues = findMalformedPrinciplesSections({
      taperCoefficients: 'TODO' as any,
    });
    expect(issues.some((i) => /taperCoefficients: must be an object/.test(i))).toBe(true);
    // The describeValue helper attaches the type so the failure
    // message is debuggable on the very first run.
    expect(issues.some((i) => /string\(length=4\)/.test(i))).toBe(true);
  });

  it('acwrThresholds as an array surfaces a malformed-section issue', () => {
    const issues = findMalformedPrinciplesSections({
      acwrThresholds: [1, 2, 3] as any,
    });
    expect(issues.some((i) => /acwrThresholds: must be an object/.test(i))).toBe(true);
    expect(issues.some((i) => /array\(length=3\)/.test(i))).toBe(true);
  });

  it('riskScoreWeights as a number surfaces a malformed-section issue', () => {
    const issues = findMalformedPrinciplesSections({
      riskScoreWeights: 7 as any,
    });
    expect(issues.some((i) => /riskScoreWeights: must be an object/.test(i))).toBe(true);
  });

  it('returnFromGapRamps as a string surfaces a malformed-section issue', () => {
    const issues = findMalformedPrinciplesSections({
      returnFromGapRamps: '' as any,
    });
    expect(issues.some((i) => /returnFromGapRamps: must be an object/.test(i))).toBe(true);
  });

  it('exerciseSelection as an array surfaces a malformed-section issue', () => {
    const issues = findMalformedPrinciplesSections({
      exerciseSelection: [] as any,
    });
    expect(issues.some((i) => /exerciseSelection: must be an object/.test(i))).toBe(true);
  });

  it('fatigueModulation as a string surfaces a malformed-section issue', () => {
    const issues = findMalformedPrinciplesSections({
      fatigueModulation: 'high' as any,
    });
    expect(issues.some((i) => /fatigueModulation: must be an object/.test(i))).toBe(true);
  });

  it('deloadCadenceRules as a number surfaces a malformed-section issue', () => {
    const issues = findMalformedPrinciplesSections({
      deloadCadenceRules: 4 as any,
    });
    expect(issues.some((i) => /deloadCadenceRules: must be an object/.test(i))).toBe(true);
  });

  it('missedSessionPolicyDefaults as an array surfaces a malformed-section issue', () => {
    const issues = findMalformedPrinciplesSections({
      missedSessionPolicyDefaults: ['drop'] as any,
    });
    expect(issues.some((i) => /missedSessionPolicyDefaults: must be an object/.test(i))).toBe(true);
  });

  it('minimumViableWeekTemplates as a string surfaces a malformed-section issue', () => {
    const issues = findMalformedPrinciplesSections({
      minimumViableWeekTemplates: 'minimum' as any,
    });
    expect(issues.some((i) => /minimumViableWeekTemplates: must be an object/.test(i))).toBe(true);
  });

  it('wrong-typed top-level sections do NOT crash the validator (it keeps walking other sections)', () => {
    // Inject multiple wrong types at once — the validator must still
    // return a complete issues list, not throw partway.
    const issues = findMalformedPrinciplesSections({
      mesocycleLengths: 'todo' as any,
      blockTemplates: 42 as any,
      taperCoefficients: null as any,           // null short-circuits → missing-key check picks it up
      acwrThresholds: ['x'] as any,
    });
    expect(issues.some((i) => /mesocycleLengths: must be an object/.test(i))).toBe(true);
    expect(issues.some((i) => /blockTemplates: must be an object/.test(i))).toBe(true);
    expect(issues.some((i) => /acwrThresholds: must be an object/.test(i))).toBe(true);
    // null is left to the missing-keys check so we don't double-report it here.
    expect(issues.some((i) => /^taperCoefficients: must be an object/.test(i))).toBe(false);
  });
});
