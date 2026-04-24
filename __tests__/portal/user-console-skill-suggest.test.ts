// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Structural pins for the ✨ Suggest skill chip (OI-USR-405b,
 * 2026-04-24). The chip extends `renderSkillBadgesEditable` from
 * OI-USR-405a with a second popover that fires
 * POST /workspace/skills/suggest-tags on first open.
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const HTML_PATH = path.resolve(__dirname, '../../src/portal/user-console.html');
const loadHtml = (): string => fs.readFileSync(HTML_PATH, 'utf-8');

describe('user-console.html — ✨ Suggest chip markup (OI-USR-405b)', () => {
  const html = loadHtml();

  it('renderSkillBadgesEditable adds a second <details> popover for suggestions', () => {
    // Must coexist with the existing "+ Skill" popover from
    // OI-USR-405a — both use the skill-add-popover class family.
    expect(html).toMatch(
      /renderSkillBadgesEditable[\s\S]*?<details class="skill-add-popover skill-suggest-popover"/,
    );
  });

  it('suggest popover triggers loadSuggestionsInto on open (ontoggle hook)', () => {
    // ontoggle fires for both open-and-close. The if (this.open) guard
    // ensures we only call when the user EXPANDED the popover, not
    // when it collapsed.
    expect(html).toMatch(
      /ontoggle="if \(this\.open\) loadSuggestionsInto\(this,\s*'\$\{esc\(kind\)\}',\s*\$\{id\}\)"/,
    );
  });

  it('summary chip shows ✨ glyph + skill-chip-suggest class', () => {
    expect(html).toMatch(/<summary class="skill-chip skill-chip-suggest"[^>]*>✨<\/summary>/);
  });

  it('empty `available` array hides BOTH the + Skill chip AND the ✨ chip', () => {
    // Rendering ✨ when there are no unassigned skills would be
    // useless — no suggestion could actually be applied.
    expect(html).toMatch(
      /const suggestPopover = available\.length === 0\s*\?\s*['"]['"]\s*:/,
    );
  });
});

describe('user-console.html — loadSuggestionsInto behavior', () => {
  const html = loadHtml();

  it('defined as async function exposed on window', () => {
    expect(html).toMatch(/async function loadSuggestionsInto\(detailsEl,\s*kind,\s*id\)/);
    expect(html).toMatch(/window\.loadSuggestionsInto\s*=\s*loadSuggestionsInto/);
  });

  it('idempotent via dataset.suggestLoaded guard (no double-fire on fast toggles)', () => {
    expect(html).toMatch(/loadSuggestionsInto[\s\S]*?detailsEl\.dataset\.suggestLoaded === ['"]1['"]/);
    expect(html).toMatch(/loadSuggestionsInto[\s\S]*?detailsEl\.dataset\.suggestLoaded\s*=\s*['"]1['"]/);
  });

  it('resets the loaded flag on error so retry actually fires a new request', () => {
    // Otherwise a transient 500 leaves the popover stuck on the
    // error message forever.
    expect(html).toMatch(/loadSuggestionsInto[\s\S]*?detailsEl\.dataset\.suggestLoaded\s*=\s*['"]['"]\s*;[\s\S]*?Suggest failed/);
  });

  it('fires POST to /workspace/skills/suggest-tags with { kind, id }', () => {
    // Multi-line chained call — use \s+ liberally to survive formatter passes.
    expect(html).toMatch(/fetchJson\(\s*['"]\/workspace\/skills\/suggest-tags['"]/);
    expect(html).toMatch(/loadSuggestionsInto[\s\S]*?method:\s*['"]POST['"]/);
    expect(html).toMatch(/loadSuggestionsInto[\s\S]*?JSON\.stringify\(\s*\{\s*kind,\s*id\s*\}\s*\)/);
  });

  it('renders cold-start message when data.coldStart === true', () => {
    expect(html).toMatch(
      /if \(coldStart\)\s*\{[\s\S]*?Tag a few references first to unlock suggestions/,
    );
  });

  it('renders empty-result message when suggestions array is empty', () => {
    expect(html).toMatch(/suggestions\.length === 0[\s\S]*?No strong skill matches from your tags yet/);
  });

  it('each rendered suggestion reuses setSkillTagOnRef(kind, id, skillId, true) for apply', () => {
    expect(html).toMatch(
      /setSkillTagOnRef\(['"]\$\{esc\(kind\)\}['"],\s*\$\{id\},\s*['"]\$\{esc\(s\.skillId\)\}['"],\s*true\)/,
    );
  });

  it('rendered suggestion shows confidence as an integer percentage', () => {
    expect(html).toMatch(/Math\.round\(\(Number\(s\.confidence\)\s*\|\|\s*0\)\s*\*\s*100\)/);
    expect(html).toMatch(/<span class="muted small">\$\{pct\}%<\/span>/);
  });

  it('suggestion label falls back to skillId when SKILLS_LIST lacks the id', () => {
    expect(html).toMatch(/SKILLS_LIST\.find\(\(x\)\s*=>\s*x\.id === s\.skillId\)\s*\|\|\s*\{\s*label:\s*s\.skillId\s*\}/);
  });

  it('esc()-wraps every user-controlled interpolation (XSS defense)', () => {
    // kind + skillId + label + error message all go through esc() before innerHTML.
    expect(html).toMatch(/loadSuggestionsInto[\s\S]*?esc\(kind\)/);
    expect(html).toMatch(/loadSuggestionsInto[\s\S]*?esc\(s\.skillId\)/);
    expect(html).toMatch(/loadSuggestionsInto[\s\S]*?esc\(skillMeta\.label\)/);
    expect(html).toMatch(/loadSuggestionsInto[\s\S]*?esc\(\(e && e\.message\)\s*\|\|\s*['"]unknown error['"]\)/);
  });
});

describe('user-console.html — CSS for the ✨ chip', () => {
  const html = loadHtml();

  it('.skill-chip-suggest has dashed border to distinguish from applied chips', () => {
    expect(html).toMatch(/\.skill-chip-suggest\s*\{[\s\S]*?border:\s*1px dashed/);
  });

  it('.skill-chip-suggest strips the native <summary> ▸ marker', () => {
    expect(html).toMatch(/\.skill-chip-suggest\s*\{[\s\S]*?list-style:\s*none/);
    expect(html).toMatch(/\.skill-chip-suggest::-webkit-details-marker\s*\{\s*display:\s*none/);
  });

  it('.skill-add-item-loading + .skill-add-item-empty styled as muted italic', () => {
    expect(html).toMatch(/\.skill-add-item-loading,\s*\.skill-add-item-empty\s*\{[\s\S]*?font-style:\s*italic/);
  });
});
