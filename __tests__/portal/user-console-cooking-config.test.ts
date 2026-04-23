// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Structural pins for the Cooking Configuration editor
 * (OI-DATA-003d, 2026-04-23). Last of the per-skill editors.
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const HTML_PATH = path.resolve(__dirname, '../../src/portal/user-console.html');
function loadHtml(): string { return fs.readFileSync(HTML_PATH, 'utf-8'); }

describe('user-console.html — Cooking Configuration markup (OI-DATA-003d)', () => {
  const html = loadHtml();

  it('legacy empty-state is gone', () => {
    expect(html).not.toContain('Cooking profile editor not yet wired');
  });

  it('all 6 input fields present with stable ids', () => {
    for (const id of [
      'cokCfgRestrictions',
      'cokCfgPreferences',
      'cokCfgKitchenInventory',
      'cokCfgServingSize',
      'cokCfgMealCost',
      'cokCfgExtraNotes',
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('Save + Revert + dirty-meta + admin-note containers present', () => {
    expect(html).toMatch(/id="cookingCfgSaveBtn"[^>]*onclick="cookingConfigSave\(\)"/);
    expect(html).toMatch(/id="cookingCfgResetBtn"[^>]*onclick="cookingConfigReset\(\)"/);
    expect(html).toContain('id="cookingCfgDirtyMeta"');
    expect(html).toContain('id="cookingCfgAdminNote"');
  });

  it('4 text fields all maxlength 2000', () => {
    for (const id of ['cokCfgRestrictions', 'cokCfgPreferences', 'cokCfgKitchenInventory', 'cokCfgExtraNotes']) {
      expect(html).toMatch(new RegExp(`id="${id}"[^>]*maxlength="2000"`));
    }
  });

  it('serving_size select has all 5 enum options', () => {
    for (const opt of ['1', '2', '3', '4', '5_plus']) {
      expect(html).toMatch(new RegExp(`value="${opt}"`));
    }
  });

  it('meal_cost_ceiling select has 4 enum options', () => {
    for (const opt of ['budget', 'moderate', 'premium', 'no_limit']) {
      expect(html).toMatch(new RegExp(`value="${opt}"`));
    }
  });

  it('restrictions label is clearly marked as HARD constraints (safety cue)', () => {
    // The label should include "hard constraints" language so users
    // distinguish allergies from preferences.
    expect(html).toMatch(/Dietary restrictions[\s\S]*?hard constraints/i);
  });
});

describe('user-console.html — Cooking Configuration behavior pins', () => {
  const html = loadHtml();

  it("paintSkill('cooking') calls loadCookingConfig()", () => {
    expect(html).toMatch(/skill === ['"]cooking['"][\s\S]*?loadCookingConfig\(\)/);
  });

  it('GET targets /workspace/skills/cooking/config', () => {
    expect(html).toContain("'/workspace/skills/cooking/config'");
  });

  it('PUT sends { config: patch } wrapper', () => {
    expect(html).toMatch(/cookingConfigSave[\s\S]*?JSON\.stringify\(\{\s*config:\s*patch\s*\}\)/);
  });

  it('diff-only payload: only changed keys sent', () => {
    expect(html).toMatch(/cookingConfigSave[\s\S]*?if \(curr\[key\] !== cookingConfigBaseline\[key\]\)/);
  });

  it('post-save re-baselines via Object.assign', () => {
    expect(html).toMatch(/Object\.assign\(cookingConfigBaseline,\s*curr\)/);
  });

  it('loadHome() fires after save so cooking.restrictions.set dep refreshes', () => {
    expect(html).toMatch(/cookingConfigSave[\s\S]*?loadHome\(\)/);
  });

  it('Revert restores from baseline, not page-load snapshot', () => {
    expect(html).toMatch(/cookingConfigReset[\s\S]*?el\.value\s*=\s*cookingConfigBaseline\[field\]/);
  });

  it('dirty-state disables Save + Revert when clean', () => {
    expect(html).toMatch(/cookingConfigUpdateDirty[\s\S]*?save\.disabled\s*=\s*!dirty/);
    expect(html).toMatch(/cookingConfigUpdateDirty[\s\S]*?reset\.disabled\s*=\s*!dirty/);
  });

  it('non-admin: fields disabled + Save/Revert hidden + admin note shown', () => {
    expect(html).toMatch(/loadCookingConfig[\s\S]*?el\.disabled\s*=\s*!isAdmin/);
    expect(html).toMatch(/cookingCfgSaveBtn'\)\.style\.display\s*=\s*isAdmin\s*\?\s*''\s*:/);
    expect(html).toMatch(/cookingCfgAdminNote'\)\.style\.display\s*=\s*isAdmin\s*\?\s*'none'/);
  });

  it('input listener bound once (dataset.cokCfgBound guard)', () => {
    expect(html).toMatch(/el\.dataset\.cokCfgBound\s*=\s*'1'/);
  });

  it('enum defaults in baseline match service: serving_size 2 + meal_cost_ceiling moderate', () => {
    expect(html).toMatch(/serving_size:\s*'2'/);
    expect(html).toMatch(/meal_cost_ceiling:\s*'moderate'/);
  });

  it('does NOT regress any earlier skill editor wiring (5-editor canary)', () => {
    // If any later edit breaks one of the 5 editors, this pin catches it.
    expect(html).toMatch(/skill === ['"]content['"][\s\S]*?loadContentConfig\(\)/);
    expect(html).toMatch(/skill === ['"]secretary['"][\s\S]*?loadSecretaryConfig\(\)/);
    expect(html).toMatch(/skill === ['"]training['"][\s\S]*?loadTrainingConfig\(\)/);
    expect(html).toMatch(/skill === ['"]finance['"][\s\S]*?loadFinanceConfig\(\)/);
    for (const id of ['cfgVoiceGuidelines', 'secCfgDailyRoutines', 'trnCfgGoals', 'finCfgBudget']) {
      expect(html).toContain(`id="${id}"`);
    }
  });
});
