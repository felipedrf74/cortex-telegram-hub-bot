// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Structural + behavior pins for reference-to-skill EDIT mode
 * (OI-USR-405a, 2026-04-23).
 *
 * The feature adds an editable chip widget on every existing
 * reference row so a user can add or remove a `skill:<id>` tag
 * without re-opening the row. The read-side of OI-USR-405 already
 * handles display; this PR makes the chips clickable and adds a
 * "+ Skill" affordance for unassigned skills.
 *
 * What these tests pin:
 *
 *   - SKILL_EDIT_KINDS lookup has an entry per ref type
 *   - setSkillTagOnRef reads current tags, strips + re-merges skill
 *     portion, PATCHes, reloads home + owning tab
 *   - renderSkillBadgesEditable emits a chip button per assigned
 *     skill + a popover with unassigned skills
 *   - The helper is wired to Books / Links / Channels / Notes rows
 *   - CSS classes exist: .skill-chip-editable, .skill-chip-x,
 *     .skill-chip-add, .skill-add-popover, .skill-add-menu
 *   - window.setSkillTagOnRef is exposed for inline onclick handlers
 *   - Escape gating on label/id interpolation (defense in depth —
 *     SKILL_IDS is allow-list already, but XSS-on-reload is the
 *     worst-case regression so we pin esc() at the edge too)
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const HTML_PATH = path.resolve(__dirname, '../../src/portal/user-console.html');
function loadHtml(): string { return fs.readFileSync(HTML_PATH, 'utf-8'); }

describe('user-console.html — edit-mode lookup (OI-USR-405a)', () => {
  const html = loadHtml();

  it('SKILL_EDIT_KINDS exists with entries for all 4 reference kinds', () => {
    expect(html).toMatch(/const SKILL_EDIT_KINDS\s*=/);
    for (const kind of ['book', 'link', 'note', 'channel']) {
      // Each entry should have a path: '/workspace/.../' plus a
      // findById + reload closure.
      expect(html).toMatch(new RegExp(`${kind}:\\s*\\{[\\s\\S]*?path:\\s*['"]/workspace/`));
    }
  });

  it('each kind reloads home after mutation (for dep refresh)', () => {
    // loadHome() must run so that e.g. removing a skill from the
    // last reference using it could flip a dep badge (if we ever
    // add "at least one tagged reference" deps). Even today it's
    // a defensive refresh. Pin it to catch accidental removal.
    for (const fn of ['loadBooks', 'loadLinks', 'loadNotes', 'loadChannels']) {
      expect(html).toMatch(new RegExp(`${fn}\\(\\);\\s*loadHome\\(\\);`));
    }
  });
});

describe('user-console.html — setSkillTagOnRef helper', () => {
  const html = loadHtml();

  it('defined as an async function and exposed on window', () => {
    expect(html).toMatch(/async function setSkillTagOnRef\s*\(kind,\s*id,\s*skillId,\s*add\)/);
    expect(html).toMatch(/window\.setSkillTagOnRef\s*=\s*setSkillTagOnRef/);
  });

  it('reads current skill set from parseSkillTags(row.tags)', () => {
    expect(html).toMatch(/setSkillTagOnRef[\s\S]*?parseSkillTags\(row\.tags\)/);
  });

  it('add=true path preserves existing set (no dup) + append', () => {
    expect(html).toMatch(
      /setSkillTagOnRef[\s\S]*?currentSkills\.includes\(skillId\)\s*\?\s*currentSkills\s*:\s*\[\.\.\.currentSkills,\s*skillId\]/,
    );
  });

  it('add=false path filters the skillId out', () => {
    expect(html).toMatch(
      /setSkillTagOnRef[\s\S]*?currentSkills\.filter\(\(s\)\s*=>\s*s\s*!==\s*skillId\)/,
    );
  });

  it('non-skill tags preserved via stripSkillTags + mergeTagsWithSkills', () => {
    expect(html).toMatch(/setSkillTagOnRef[\s\S]*?stripSkillTags\(row\.tags\)/);
    expect(html).toMatch(/setSkillTagOnRef[\s\S]*?mergeTagsWithSkills\(nonSkill,\s*nextSkills\)/);
  });

  it('sends PATCH with { tags: newTags } (tenant route shape)', () => {
    expect(html).toMatch(
      /setSkillTagOnRef[\s\S]*?method:\s*['"]PATCH['"][\s\S]*?JSON\.stringify\(\{\s*tags:\s*newTags\s*\}\)/,
    );
  });

  it('error path surfaces via toast (not silent-fail)', () => {
    expect(html).toMatch(/setSkillTagOnRef[\s\S]*?toast\(e\.message\s*\|\|\s*['"]Update failed['"],\s*['"]error['"]\)/);
  });
});

describe('user-console.html — renderSkillBadgesEditable renderer', () => {
  const html = loadHtml();

  it('defined + produces a .skill-chip-group wrapper', () => {
    expect(html).toMatch(/function renderSkillBadgesEditable\(tags,\s*kind,\s*id\)/);
    expect(html).toMatch(/renderSkillBadgesEditable[\s\S]*?<span class="skill-chip-group">/);
  });

  it('each assigned chip is a button with onclick → setSkillTagOnRef(..., false)', () => {
    expect(html).toMatch(
      /renderSkillBadgesEditable[\s\S]*?<button type="button"\s+class="skill-chip skill-chip-editable"/,
    );
    expect(html).toMatch(
      /renderSkillBadgesEditable[\s\S]*?setSkillTagOnRef\(['"]\$\{esc\(kind\)\}['"],\s*\$\{id\},\s*['"]\$\{esc\(s\.id\)\}['"],\s*false\)/,
    );
  });

  it('each assigned chip shows a "×" glyph inside .skill-chip-x', () => {
    expect(html).toMatch(
      /renderSkillBadgesEditable[\s\S]*?<span class="skill-chip-x">×<\/span>/,
    );
  });

  it('popover uses <details><summary> so click-outside is free (native browser)', () => {
    expect(html).toMatch(/renderSkillBadgesEditable[\s\S]*?<details class="skill-add-popover">/);
    expect(html).toMatch(/renderSkillBadgesEditable[\s\S]*?<summary class="skill-chip skill-chip-add"/);
  });

  it('popover lists only UNASSIGNED skills (symmetric diff of SKILLS_LIST vs current)', () => {
    expect(html).toMatch(
      /renderSkillBadgesEditable[\s\S]*?SKILLS_LIST\.filter\(\(s\)\s*=>\s*!current\.includes\(s\.id\)\)/,
    );
  });

  it('no popover rendered when every skill is already assigned', () => {
    // Empty string when available.length === 0 — keeps the row tidy.
    expect(html).toMatch(/renderSkillBadgesEditable[\s\S]*?available\.length === 0\s*\?\s*['"]['"]/);
  });

  it('popover auto-closes after pick (details.open = false)', () => {
    expect(html).toMatch(
      /renderSkillBadgesEditable[\s\S]*?this\.closest\(['"]details['"]\)\.open\s*=\s*false/,
    );
  });

  it('kind + skill id + label all escaped for defense in depth', () => {
    // SKILL_IDS is allow-list, but the renderer still escapes in
    // case a future caller passes an unchecked kind.
    expect(html).toMatch(/renderSkillBadgesEditable[\s\S]*?esc\(kind\)/);
    expect(html).toMatch(/renderSkillBadgesEditable[\s\S]*?esc\(s\.id\)/);
    expect(html).toMatch(/renderSkillBadgesEditable[\s\S]*?esc\(s\.label\)/);
  });
});

describe('user-console.html — wired to all 4 reference row renderers', () => {
  const html = loadHtml();

  it('renderBooks row uses renderSkillBadgesEditable(b.tags, "book", b.id)', () => {
    expect(html).toMatch(/renderSkillBadgesEditable\(b\.tags,\s*['"]book['"],\s*b\.id\)/);
  });
  it('renderLinks row uses renderSkillBadgesEditable(l.tags, "link", l.id)', () => {
    expect(html).toMatch(/renderSkillBadgesEditable\(l\.tags,\s*['"]link['"],\s*l\.id\)/);
  });
  it('renderChannels row uses renderSkillBadgesEditable(ch.tags, "channel", ch.id)', () => {
    expect(html).toMatch(/renderSkillBadgesEditable\(ch\.tags,\s*['"]channel['"],\s*ch\.id\)/);
  });
  it('renderNotes row uses renderSkillBadgesEditable(n.tags, "note", n.id)', () => {
    expect(html).toMatch(/renderSkillBadgesEditable\(n\.tags,\s*['"]note['"],\s*n\.id\)/);
  });
});

describe('user-console.html — CSS for edit-mode chips', () => {
  const html = loadHtml();

  it('`.skill-chip-editable` styled with cursor:pointer (clickable to remove)', () => {
    expect(html).toMatch(/\.skill-chip-editable\s*\{[\s\S]*?cursor:\s*pointer/);
  });

  it('`.skill-chip-editable:hover` tints red/danger so users can predict removal', () => {
    // Anchors on danger variable OR the literal #dc3545 fallback,
    // so the test survives a theme rename.
    expect(html).toMatch(/\.skill-chip-editable:hover\s*\{[\s\S]*?(--danger|#dc3545)/);
  });

  it('`.skill-chip-x` opacity fades + brightens on hover (progressive disclosure)', () => {
    expect(html).toMatch(/\.skill-chip-x\s*\{[\s\S]*?opacity:\s*0\.6/);
    expect(html).toMatch(/\.skill-chip-editable:hover\s\.skill-chip-x\s*\{\s*opacity:\s*1/);
  });

  it('`.skill-chip-add` has dashed border (affordance vs state)', () => {
    expect(html).toMatch(/\.skill-chip-add\s*\{[\s\S]*?border:\s*1px dashed/);
  });

  it('`.skill-chip-add` strips native <summary> marker (no ▸ triangle)', () => {
    expect(html).toMatch(/\.skill-chip-add\s*\{[\s\S]*?list-style:\s*none/);
    expect(html).toMatch(/\.skill-chip-add::-webkit-details-marker\s*\{\s*display:\s*none/);
  });

  it('`.skill-add-menu` is absolutely positioned so it floats over the row', () => {
    expect(html).toMatch(/\.skill-add-menu\s*\{[\s\S]*?position:\s*absolute/);
    expect(html).toMatch(/\.skill-add-menu\s*\{[\s\S]*?z-index:\s*20/);
  });

  it('`.skill-add-popover` is position:relative to anchor the absolute menu', () => {
    expect(html).toMatch(/\.skill-add-popover\s*\{[\s\S]*?position:\s*relative/);
  });
});

describe('user-console.html — regression: edit mode does not break existing callers', () => {
  const html = loadHtml();

  it('read-only renderSkillBadges is still defined (still used in Insights/detail views)', () => {
    // If we ever delete renderSkillBadges we need to consciously
    // replace its callers — this test fires the warning shot.
    expect(html).toMatch(/function renderSkillBadges\(tags\)/);
  });

  it('parseSkillTags + stripSkillTags + mergeTagsWithSkills still exported (helper invariants)', () => {
    for (const fn of ['parseSkillTags', 'stripSkillTags', 'mergeTagsWithSkills']) {
      expect(html).toMatch(new RegExp(`function\\s+${fn}`));
    }
  });
});
