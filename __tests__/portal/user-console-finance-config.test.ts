// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Structural pins for the Finance Configuration editor
 * (OI-DATA-003c, 2026-04-23). Mirrors Secretary / Training shape.
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const HTML_PATH = path.resolve(__dirname, '../../src/portal/user-console.html');
function loadHtml(): string { return fs.readFileSync(HTML_PATH, 'utf-8'); }

describe('user-console.html — Finance Configuration markup (OI-DATA-003c)', () => {
  const html = loadHtml();

  it('legacy empty-state is gone', () => {
    expect(html).not.toContain('Budget editor not yet wired');
  });

  it('all 6 input fields present with stable ids', () => {
    for (const id of [
      'finCfgBudget',
      'finCfgSavingGoals',
      'finCfgAffordabilityRules',
      'finCfgCurrency',
      'finCfgDecisionStyle',
      'finCfgExtraNotes',
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('Save + Revert + dirty-meta + admin-note containers present', () => {
    expect(html).toMatch(/id="financeCfgSaveBtn"[^>]*onclick="financeConfigSave\(\)"/);
    expect(html).toMatch(/id="financeCfgResetBtn"[^>]*onclick="financeConfigReset\(\)"/);
    expect(html).toContain('id="financeCfgDirtyMeta"');
    expect(html).toContain('id="financeCfgAdminNote"');
  });

  it('4 text fields all maxlength 2000', () => {
    for (const id of ['finCfgBudget', 'finCfgSavingGoals', 'finCfgAffordabilityRules', 'finCfgExtraNotes']) {
      expect(html).toMatch(new RegExp(`id="${id}"[^>]*maxlength="2000"`));
    }
  });

  it('primary_currency select has all 6 enum options', () => {
    for (const opt of ['USD', 'EUR', 'BRL', 'GBP', 'JPY', 'other']) {
      expect(html).toMatch(new RegExp(`value="${opt}"`));
    }
  });

  it('decision_style select has 3 enum options', () => {
    for (const opt of ['conservative', 'balanced', 'risk_tolerant']) {
      expect(html).toMatch(new RegExp(`value="${opt}"`));
    }
  });
});

describe('user-console.html — Finance Configuration behavior pins', () => {
  const html = loadHtml();

  it("paintSkill('finance') calls loadFinanceConfig()", () => {
    expect(html).toMatch(/skill === ['"]finance['"][\s\S]*?loadFinanceConfig\(\)/);
  });

  it('GET targets /workspace/skills/finance/config', () => {
    expect(html).toContain("'/workspace/skills/finance/config'");
  });

  it('PUT sends { config: patch } wrapper', () => {
    expect(html).toMatch(/financeConfigSave[\s\S]*?JSON\.stringify\(\{\s*config:\s*patch\s*\}\)/);
  });

  it('diff-only payload: only changed keys sent', () => {
    expect(html).toMatch(/financeConfigSave[\s\S]*?if \(curr\[key\] !== financeConfigBaseline\[key\]\)/);
  });

  it('post-save re-baselines via Object.assign', () => {
    expect(html).toMatch(/Object\.assign\(financeConfigBaseline,\s*curr\)/);
  });

  it('loadHome() fires after save so finance.budget.set dep refreshes', () => {
    expect(html).toMatch(/financeConfigSave[\s\S]*?loadHome\(\)/);
  });

  it('Revert restores from baseline, not page-load snapshot', () => {
    expect(html).toMatch(/financeConfigReset[\s\S]*?el\.value\s*=\s*financeConfigBaseline\[field\]/);
  });

  it('dirty-state disables Save + Revert when clean', () => {
    expect(html).toMatch(/financeConfigUpdateDirty[\s\S]*?save\.disabled\s*=\s*!dirty/);
    expect(html).toMatch(/financeConfigUpdateDirty[\s\S]*?reset\.disabled\s*=\s*!dirty/);
  });

  it('non-admin: fields disabled + Save/Revert hidden + admin note shown', () => {
    expect(html).toMatch(/loadFinanceConfig[\s\S]*?el\.disabled\s*=\s*!isAdmin/);
    expect(html).toMatch(/financeCfgSaveBtn'\)\.style\.display\s*=\s*isAdmin\s*\?\s*''\s*:/);
    expect(html).toMatch(/financeCfgAdminNote'\)\.style\.display\s*=\s*isAdmin\s*\?\s*'none'/);
  });

  it('input listener bound once (dataset.finCfgBound guard)', () => {
    expect(html).toMatch(/el\.dataset\.finCfgBound\s*=\s*'1'/);
  });

  it('enum defaults in baseline match service: USD + balanced', () => {
    expect(html).toMatch(/primary_currency:\s*'USD'/);
    expect(html).toMatch(/decision_style:\s*'balanced'/);
  });

  it('does NOT regress Content / Secretary / Training editor wiring', () => {
    expect(html).toMatch(/skill === ['"]content['"][\s\S]*?loadContentConfig\(\)/);
    expect(html).toMatch(/skill === ['"]secretary['"][\s\S]*?loadSecretaryConfig\(\)/);
    expect(html).toMatch(/skill === ['"]training['"][\s\S]*?loadTrainingConfig\(\)/);
    expect(html).toContain('id="cfgVoiceGuidelines"');
    expect(html).toContain('id="secCfgDailyRoutines"');
    expect(html).toContain('id="trnCfgGoals"');
  });
});
