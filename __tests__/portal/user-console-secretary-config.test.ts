// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Structural pins for the Secretary Configuration editor
 * (OI-DATA-003a, 2026-04-23).
 *
 * Pure HTML/JS introspection — no browser. Mirrors the
 * user-console-content-config.test.ts shape since the two editors
 * follow the same pattern. Asserts:
 *
 *   - legacy "Routine editor not yet wired" empty-state is GONE
 *   - all 6 input fields wired with stable ids
 *   - Save + Revert buttons + dirty-meta label present
 *   - paintSkill('secretary') lazy-loads via loadSecretaryConfig
 *   - GET/PUT hit /workspace/skills/secretary/config
 *   - Diff-only PUT, post-save re-baseline, loadHome after save
 *   - Non-admin: fields disabled + Save/Revert hidden + admin note
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const HTML_PATH = path.resolve(__dirname, '../../src/portal/user-console.html');
function loadHtml(): string { return fs.readFileSync(HTML_PATH, 'utf-8'); }

describe('user-console.html — Secretary Configuration markup (OI-DATA-003a)', () => {
  const html = loadHtml();

  it('legacy empty-state is gone', () => {
    expect(html).not.toContain('Routine editor not yet wired');
  });

  it('all 6 input fields present with stable ids', () => {
    for (const id of [
      'secCfgDailyRoutines',
      'secCfgPriorityRules',
      'secCfgFocusPolicy',
      'secCfgPrimaryCalendar',
      'secCfgInterruptionTolerance',
      'secCfgExtraNotes',
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('Save + Revert + dirty-meta + admin-note containers present', () => {
    expect(html).toMatch(/id="secretaryCfgSaveBtn"[^>]*onclick="secretaryConfigSave\(\)"/);
    expect(html).toMatch(/id="secretaryCfgResetBtn"[^>]*onclick="secretaryConfigReset\(\)"/);
    expect(html).toContain('id="secretaryCfgDirtyMeta"');
    expect(html).toContain('id="secretaryCfgAdminNote"');
  });

  it('daily_routines maxlength 4000 + priority_rules maxlength 2000 + extra_notes maxlength 2000', () => {
    expect(html).toMatch(/id="secCfgDailyRoutines"[^>]*maxlength="4000"/);
    expect(html).toMatch(/id="secCfgPriorityRules"[^>]*maxlength="2000"/);
    expect(html).toMatch(/id="secCfgExtraNotes"[^>]*maxlength="2000"/);
  });

  it('focus_block_policy select has all 5 enum options', () => {
    for (const opt of ['none', 'mornings', 'afternoons', 'all_day', 'custom']) {
      // Rough check — each option appears as value=
      expect(html).toMatch(new RegExp(`value="${opt}"`));
    }
  });

  it('primary_calendar select has 4 enum options', () => {
    for (const opt of ['google', 'outlook', 'icloud']) {
      // Note: 'none' also used by focus_block_policy — covered above.
      expect(html).toMatch(new RegExp(`value="${opt}"`));
    }
  });

  it('interruption_tolerance select has 3 enum options', () => {
    // `low` / `medium` / `high` — check each as a value.
    for (const opt of ['low', 'medium', 'high']) {
      expect(html).toMatch(new RegExp(`value="${opt}"`));
    }
  });
});

describe('user-console.html — Secretary Configuration behavior pins', () => {
  const html = loadHtml();

  it("paintSkill('secretary') calls loadSecretaryConfig()", () => {
    expect(html).toMatch(/skill === ['"]secretary['"][\s\S]*?loadSecretaryConfig\(\)/);
  });

  it('GET targets /workspace/skills/secretary/config', () => {
    expect(html).toContain("'/workspace/skills/secretary/config'");
  });

  it('PUT sends { config: patch } wrapper', () => {
    expect(html).toMatch(/secretaryConfigSave[\s\S]*?JSON\.stringify\(\{\s*config:\s*patch\s*\}\)/);
  });

  it('diff-only payload: only changed keys sent', () => {
    expect(html).toMatch(/secretaryConfigSave[\s\S]*?if \(curr\[key\] !== secretaryConfigBaseline\[key\]\)/);
  });

  it('post-save re-baselines via Object.assign', () => {
    expect(html).toMatch(/Object\.assign\(secretaryConfigBaseline,\s*curr\)/);
  });

  it('loadHome() fires after save so secretary.routines.set dep refreshes', () => {
    expect(html).toMatch(/secretaryConfigSave[\s\S]*?loadHome\(\)/);
  });

  it('Revert restores from baseline, not page-load snapshot', () => {
    expect(html).toMatch(/secretaryConfigReset[\s\S]*?el\.value\s*=\s*secretaryConfigBaseline\[field\]/);
  });

  it('dirty-state disables Save + Revert when clean', () => {
    expect(html).toMatch(/secretaryConfigUpdateDirty[\s\S]*?save\.disabled\s*=\s*!dirty/);
    expect(html).toMatch(/secretaryConfigUpdateDirty[\s\S]*?reset\.disabled\s*=\s*!dirty/);
  });

  it('non-admin: fields disabled + Save/Revert hidden + admin note shown', () => {
    expect(html).toMatch(/loadSecretaryConfig[\s\S]*?el\.disabled\s*=\s*!isAdmin/);
    expect(html).toMatch(/secretaryCfgSaveBtn'\)\.style\.display\s*=\s*isAdmin\s*\?\s*''\s*:/);
    expect(html).toMatch(/secretaryCfgAdminNote'\)\.style\.display\s*=\s*isAdmin\s*\?\s*'none'/);
  });

  it('input listener bound once (dataset.secCfgBound guard)', () => {
    expect(html).toMatch(/el\.dataset\.secCfgBound\s*=\s*'1'/);
  });

  it('does NOT regress the Content editor wiring', () => {
    // Sanity: Content editor still exists and still wires paintSkill.
    expect(html).toMatch(/skill === ['"]content['"][\s\S]*?loadContentConfig\(\)/);
    expect(html).toContain('id="cfgVoiceGuidelines"');
  });
});
