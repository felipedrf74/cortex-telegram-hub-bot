// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Structural pins for the Content skill Configuration editor
 * (OI-DATA-003, branch feature/nexus-hub-portal-uiux-admin-user-
 * console, 2026-04-22).
 *
 * Pure HTML/JS introspection — no browser. Asserts:
 *   - legacy "Configuration editor lands next" empty-state is GONE
 *   - 6 input fields wired with stable ids
 *   - Save + Revert buttons present; dirty-meta label; view-only note
 *   - load triggered on paintSkill('content') switch
 *   - GET/PUT targets /workspace/skills/content/config
 *   - Diff-only payload on save (only changed keys sent)
 *   - Post-save re-baseline so Revert = "undo unsaved"
 *   - loadHome() fires after save so the voice-guidelines dep
 *     flips to ready in the sidebar
 *   - Non-admin mode: fields disabled + Save/Revert hidden
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const HTML_PATH = path.resolve(__dirname, '../../src/portal/user-console.html');
function loadHtml(): string { return fs.readFileSync(HTML_PATH, 'utf-8'); }

describe('user-console.html — Content skill Configuration markup (OI-DATA-003)', () => {
  const html = loadHtml();

  it('legacy empty-state is gone', () => {
    expect(html).not.toContain('Configuration editor lands next');
  });

  it('all 6 input fields present with stable ids', () => {
    for (const id of [
      'cfgVoiceGuidelines',
      'cfgDefaultPlatform',
      'cfgOutputLength',
      'cfgReferencePolicy',
      'cfgAutoPublish',
      'cfgExtraNotes',
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('Save + Revert buttons with dirty-meta label present', () => {
    expect(html).toMatch(/id="contentCfgSaveBtn"[^>]*onclick="contentConfigSave\(\)"/);
    expect(html).toMatch(/id="contentCfgResetBtn"[^>]*onclick="contentConfigReset\(\)"/);
    expect(html).toContain('id="contentCfgDirtyMeta"');
  });

  it('view-only note for non-admins present (hidden by default)', () => {
    expect(html).toContain('id="contentCfgAdminNote"');
    expect(html).toMatch(/contentCfgAdminNote[\s\S]*?display:\s*none/);
  });

  it('voice_guidelines maxlength 4000 + extra_notes maxlength 2000 match service caps', () => {
    expect(html).toMatch(/id="cfgVoiceGuidelines"[^>]*maxlength="4000"/);
    expect(html).toMatch(/id="cfgExtraNotes"[^>]*maxlength="2000"/);
  });

  it('default_platform select has all 6 allowed enum options', () => {
    for (const opt of ['general', 'blog', 'twitter', 'linkedin', 'youtube', 'newsletter']) {
      expect(html).toMatch(new RegExp(`value="${opt}"`));
    }
  });

  it('output_length select has 3 enum options', () => {
    for (const opt of ['concise', 'balanced', 'detailed']) {
      expect(html).toMatch(new RegExp(`value="${opt}"`));
    }
  });

  it('include_references_policy select has 3 enum options', () => {
    for (const opt of ['always', 'when_relevant', 'never']) {
      expect(html).toMatch(new RegExp(`value="${opt}"`));
    }
  });
});

describe('user-console.html — Content Configuration behavior pins', () => {
  const html = loadHtml();

  it("paintSkill('content') loads the config", () => {
    // loadContentConfig is called inside the skill === 'content' branch.
    expect(html).toMatch(/skill === ['"]content['"][\s\S]*?loadContentConfig\(\)/);
  });

  it('GET targets /workspace/skills/content/config', () => {
    expect(html).toContain("'/workspace/skills/content/config'");
  });

  it('PUT sends { config: patch } wrapper (clean API shape)', () => {
    expect(html).toMatch(/JSON\.stringify\(\{\s*config:\s*patch\s*\}\)/);
  });

  it('diff-only PUT: only keys where current !== baseline are sent', () => {
    expect(html).toMatch(/if \(curr\[key\] !== contentConfigBaseline\[key\]\)/);
  });

  it('post-save re-baselines (Object.assign(contentConfigBaseline, curr))', () => {
    expect(html).toMatch(/Object\.assign\(contentConfigBaseline,\s*curr\)/);
  });

  it('loadHome() fires after save so the voice-guidelines dep refreshes', () => {
    // Without this, the Home sidebar badge would stay red until
    // a full reload.
    expect(html).toMatch(/contentConfigSave[\s\S]*?loadHome\(\)/);
  });

  it('auto_publish uses checkbox state (el.checked), not el.value', () => {
    expect(html).toMatch(/field === ['"]auto_publish['"]\s*\?\s*!!el\.checked/);
  });

  it('Revert restores from baseline (not page-load snapshot)', () => {
    expect(html).toMatch(/contentConfigReset[\s\S]*?el\.checked\s*=\s*!!contentConfigBaseline\[field\]/);
    expect(html).toMatch(/contentConfigReset[\s\S]*?el\.value\s*=\s*contentConfigBaseline\[field\]/);
  });

  it('dirty-state disables Save + Revert when clean', () => {
    expect(html).toMatch(/save\.disabled\s*=\s*!dirty/);
    expect(html).toMatch(/reset\.disabled\s*=\s*!dirty/);
  });

  it('non-admin: fields disabled + Save/Revert hidden + admin note shown', () => {
    expect(html).toMatch(/el\.disabled\s*=\s*!isAdmin/);
    expect(html).toMatch(/contentCfgSaveBtn'\)\.style\.display\s*=\s*isAdmin\s*\?\s*''\s*:/);
    expect(html).toMatch(/contentCfgAdminNote'\)\.style\.display\s*=\s*isAdmin\s*\?\s*'none'/);
  });

  it('input listener bound once (dataset.cfgBound guard)', () => {
    expect(html).toMatch(/el\.dataset\.cfgBound\s*=\s*'1'/);
    // Binds 'change' on the checkbox, 'input' on the rest.
    expect(html).toMatch(/field === ['"]auto_publish['"]\s*\?\s*['"]change['"]\s*:\s*['"]input['"]/);
  });

  it('empty-string voice_guidelines gets sent as-is (service converts to null)', () => {
    // The UI sends what's in the input; server-side empty→null
    // mapping lives in stringField.parse. No special client casing.
    expect(html).toMatch(/contentConfigCurrent/);
  });
});
