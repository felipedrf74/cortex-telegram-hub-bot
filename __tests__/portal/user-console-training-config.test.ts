// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Structural pins for the Training Configuration editor (OI-DATA-003b,
 * 2026-04-23). Mirrors the Secretary / Content test shape.
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const HTML_PATH = path.resolve(__dirname, '../../src/portal/user-console.html');
function loadHtml(): string { return fs.readFileSync(HTML_PATH, 'utf-8'); }

describe('user-console.html — Training Configuration markup (OI-DATA-003b)', () => {
  const html = loadHtml();

  it('legacy empty-state is gone', () => {
    expect(html).not.toContain('Training profile editor not yet wired');
  });

  it('all 6 input fields present with stable ids', () => {
    for (const id of [
      'trnCfgGoals',
      'trnCfgEquipment',
      'trnCfgConstraints',
      'trnCfgDaysPolicy',
      'trnCfgRecoveryPriority',
      'trnCfgExtraNotes',
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('Save + Revert + dirty-meta + admin-note containers present', () => {
    expect(html).toMatch(/id="trainingCfgSaveBtn"[^>]*onclick="trainingConfigSave\(\)"/);
    expect(html).toMatch(/id="trainingCfgResetBtn"[^>]*onclick="trainingConfigReset\(\)"/);
    expect(html).toContain('id="trainingCfgDirtyMeta"');
    expect(html).toContain('id="trainingCfgAdminNote"');
  });

  it('goals / equipment / constraints / extra_notes all maxlength 2000', () => {
    for (const id of ['trnCfgGoals', 'trnCfgEquipment', 'trnCfgConstraints', 'trnCfgExtraNotes']) {
      expect(html).toMatch(new RegExp(`id="${id}"[^>]*maxlength="2000"`));
    }
  });

  it('preferred_training_days select has all 5 enum options', () => {
    for (const opt of ['daily', 'six_days', 'five_days', 'four_days', 'three_days']) {
      expect(html).toMatch(new RegExp(`value="${opt}"`));
    }
  });

  it('recovery_priority select has 3 enum options', () => {
    for (const opt of ['maximum', 'balanced', 'push_hard']) {
      expect(html).toMatch(new RegExp(`value="${opt}"`));
    }
  });
});

describe('user-console.html — Training Configuration behavior pins', () => {
  const html = loadHtml();

  it("paintSkill('training') calls loadTrainingConfig()", () => {
    expect(html).toMatch(/skill === ['"]training['"][\s\S]*?loadTrainingConfig\(\)/);
  });

  it('GET targets /workspace/skills/training/config', () => {
    expect(html).toContain("'/workspace/skills/training/config'");
  });

  it('PUT sends { config: patch } wrapper', () => {
    expect(html).toMatch(/trainingConfigSave[\s\S]*?JSON\.stringify\(\{\s*config:\s*patch\s*\}\)/);
  });

  it('diff-only payload: only changed keys sent', () => {
    expect(html).toMatch(/trainingConfigSave[\s\S]*?if \(curr\[key\] !== trainingConfigBaseline\[key\]\)/);
  });

  it('post-save re-baselines via Object.assign', () => {
    expect(html).toMatch(/Object\.assign\(trainingConfigBaseline,\s*curr\)/);
  });

  it('loadHome() fires after save so training.goals.set dep refreshes', () => {
    expect(html).toMatch(/trainingConfigSave[\s\S]*?loadHome\(\)/);
  });

  it('Revert restores from baseline, not page-load snapshot', () => {
    expect(html).toMatch(/trainingConfigReset[\s\S]*?el\.value\s*=\s*trainingConfigBaseline\[field\]/);
  });

  it('dirty-state disables Save + Revert when clean', () => {
    expect(html).toMatch(/trainingConfigUpdateDirty[\s\S]*?save\.disabled\s*=\s*!dirty/);
    expect(html).toMatch(/trainingConfigUpdateDirty[\s\S]*?reset\.disabled\s*=\s*!dirty/);
  });

  it('non-admin: fields disabled + Save/Revert hidden + admin note shown', () => {
    expect(html).toMatch(/loadTrainingConfig[\s\S]*?el\.disabled\s*=\s*!isAdmin/);
    expect(html).toMatch(/trainingCfgSaveBtn'\)\.style\.display\s*=\s*isAdmin\s*\?\s*''\s*:/);
    expect(html).toMatch(/trainingCfgAdminNote'\)\.style\.display\s*=\s*isAdmin\s*\?\s*'none'/);
  });

  it('input listener bound once (dataset.trnCfgBound guard)', () => {
    expect(html).toMatch(/el\.dataset\.trnCfgBound\s*=\s*'1'/);
  });

  it('enum defaults in baseline match service: four_days + balanced', () => {
    // preferred_training_days default = 'four_days'; recovery_priority = 'balanced'
    expect(html).toMatch(/preferred_training_days:\s*'four_days'/);
    expect(html).toMatch(/recovery_priority:\s*'balanced'/);
  });

  it('does NOT regress Content or Secretary editor wiring', () => {
    expect(html).toMatch(/skill === ['"]content['"][\s\S]*?loadContentConfig\(\)/);
    expect(html).toMatch(/skill === ['"]secretary['"][\s\S]*?loadSecretaryConfig\(\)/);
    expect(html).toContain('id="cfgVoiceGuidelines"');
    expect(html).toContain('id="secCfgDailyRoutines"');
  });
});
