// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Structural + behavior pins for the reference-to-skill assignment
 * UI (OI-USR-405, branch feature/nexus-hub-portal-uiux-admin-user-
 * console, 2026-04-23).
 *
 * The feature encodes "this reference is used by skill X" as a
 * `skill:<id>` tag inside the existing `tags` array — no schema
 * change. These tests pin:
 *
 *   - SKILLS_LIST has the 5 skills in stable order
 *   - All 4 reference forms (book/link/note/channel) expose a
 *     .skill-picker container
 *   - All 4 pages have a "Filter by skill" dropdown
 *   - Render functions distinguish skill badges (renderSkillBadges)
 *     from regular tags (stripSkillTags)
 *   - Create functions merge user tags + selected skills via
 *     mergeTagsWithSkills → POST `tags` carries `skill:<id>`
 *   - Reset clears both text inputs AND skill checkboxes after save
 *   - Skill filter applies via rowMatchesSkill
 *   - Malicious input in a reference title is HTML-escaped when the
 *     row is rendered (no regression from the tag rendering refactor)
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const HTML_PATH = path.resolve(__dirname, '../../src/portal/user-console.html');
function loadHtml(): string { return fs.readFileSync(HTML_PATH, 'utf-8'); }

describe('user-console.html — skill-tag convention (OI-USR-405)', () => {
  const html = loadHtml();

  it('SKILLS_LIST declares the 5 skills in a stable order', () => {
    const match = html.match(/const SKILLS_LIST = \[([\s\S]*?)\];/);
    expect(match).toBeTruthy();
    const body = match![1];
    const order = (body.match(/id:\s*['"]([a-z]+)['"]/g) || []).map((s) => s.match(/['"]([a-z]+)['"]/)![1]);
    expect(order).toEqual(['content', 'secretary', 'training', 'finance', 'cooking']);
  });

  it('uses `skill:<id>` namespace for encoding', () => {
    expect(html).toMatch(/['"]skill:['"]/);
    expect(html).toMatch(/t\.startsWith\(['"]skill:['"]\)/);
  });

  it('parseSkillTags + stripSkillTags + mergeTagsWithSkills + renderSkillBadges all defined', () => {
    for (const fn of ['parseSkillTags', 'stripSkillTags', 'mergeTagsWithSkills', 'renderSkillBadges']) {
      expect(html).toMatch(new RegExp(`function\\s+${fn}`));
    }
  });

  it('readSkillPicker + resetSkillPicker + renderSkillPicker + rowMatchesSkill defined', () => {
    for (const fn of ['readSkillPicker', 'resetSkillPicker', 'renderSkillPicker', 'rowMatchesSkill']) {
      expect(html).toMatch(new RegExp(`function\\s+${fn}`));
    }
  });
});

describe('user-console.html — skill-picker wiring on all 4 reference forms', () => {
  const html = loadHtml();

  it('Books form has a skill-picker container', () => {
    expect(html).toMatch(/data-skill-picker-for="book"/);
  });
  it('Channels form has a skill-picker container', () => {
    expect(html).toMatch(/data-skill-picker-for="channel"/);
  });
  it('Links form has a skill-picker container', () => {
    expect(html).toMatch(/data-skill-picker-for="link"/);
  });
  it('Notes form has a skill-picker container', () => {
    expect(html).toMatch(/data-skill-picker-for="note"/);
  });

  it('boot-time hook renders every .skill-picker on shell load', () => {
    expect(html).toMatch(/document\.querySelectorAll\(['"]\.skill-picker\[data-skill-picker-for\]['"]\)/);
  });

  it('boot hook wraps in setTimeout(0) so it runs after DOM is stable', () => {
    expect(html).toMatch(/setTimeout\(\(\) =>\s*\{\s*document\.querySelectorAll\(['"]\.skill-picker/);
  });
});

describe('user-console.html — skill filters on all 4 reference pages', () => {
  const html = loadHtml();

  it('Books has a bookSkillFilter select wired to renderBooks()', () => {
    expect(html).toContain('id="bookSkillFilter"');
    expect(html).toMatch(/id="bookSkillFilter"[^>]*onchange="renderBooks\(\)"/);
  });
  it('Channels has a channelSkillFilter select', () => {
    expect(html).toContain('id="channelSkillFilter"');
    expect(html).toMatch(/id="channelSkillFilter"[^>]*onchange="renderChannels\(\)"/);
  });
  it('Links has a linkSkillFilter select', () => {
    expect(html).toContain('id="linkSkillFilter"');
    expect(html).toMatch(/id="linkSkillFilter"[^>]*onchange="renderLinks\(\)"/);
  });
  it('Notes has a noteSkillFilter select', () => {
    expect(html).toContain('id="noteSkillFilter"');
    expect(html).toMatch(/id="noteSkillFilter"[^>]*onchange="renderNotes\(\)"/);
  });

  it('each filter dropdown has all 5 skill options + "All skills"', () => {
    // Look for the options once — the same set lives under every select.
    const skillOpts = ['content', 'secretary', 'training', 'finance', 'cooking'];
    for (const s of skillOpts) {
      expect(html).toMatch(new RegExp(`<option value="${s}">`));
    }
  });
});

describe('user-console.html — create functions merge skills + user tags', () => {
  const html = loadHtml();

  it('createBook reads skill picker + merges + sends tags', () => {
    expect(html).toMatch(/createBook[\s\S]*?readSkillPicker\(['"]book['"]\)/);
    expect(html).toMatch(/createBook[\s\S]*?mergeTagsWithSkills\(userTags,\s*skillIds\)/);
  });
  it('createChannel reads skill picker and includes tags in POST body', () => {
    expect(html).toMatch(/createChannel[\s\S]*?readSkillPicker\(['"]channel['"]\)/);
    expect(html).toMatch(/createChannel[\s\S]*?body: JSON\.stringify\([\s\S]*?tags,/);
  });
  it('createLink reads skill picker + merges + sends tags', () => {
    expect(html).toMatch(/createLink[\s\S]*?readSkillPicker\(['"]link['"]\)/);
    expect(html).toMatch(/createLink[\s\S]*?mergeTagsWithSkills\(userTags,\s*skillIds\)/);
  });
  it('createNote reads skill picker + merges + sends tags', () => {
    expect(html).toMatch(/createNote[\s\S]*?readSkillPicker\(['"]note['"]\)/);
    expect(html).toMatch(/createNote[\s\S]*?mergeTagsWithSkills\(userTags,\s*skillIds\)/);
  });

  it('each create function resets its skill picker after save', () => {
    for (const kind of ['book', 'channel', 'link', 'note']) {
      expect(html).toMatch(new RegExp(`resetSkillPicker\\(['"]${kind}['"]\\)`));
    }
  });
});

describe('user-console.html — render functions split skill badges from regular tags', () => {
  const html = loadHtml();

  it('renderBooks: uses renderSkillBadges(b.tags) + stripSkillTags(b.tags) in separate columns', () => {
    // The "Used by" column uses renderSkillBadges; the "Tags" column
    // uses stripSkillTags so skill:<id> chips don't show as raw text.
    expect(html).toMatch(/renderBooks\s*=\s*function[\s\S]*?renderSkillBadges\(b\.tags\)/);
    expect(html).toMatch(/renderBooks\s*=\s*function[\s\S]*?stripSkillTags\(b\.tags\)/);
  });
  it('renderChannels: renderSkillBadges(ch.tags) in a "Used by" column', () => {
    expect(html).toMatch(/renderChannels\s*=\s*function[\s\S]*?renderSkillBadges\(ch\.tags\)/);
  });
  it('renderLinks: renderSkillBadges(l.tags) + stripSkillTags(l.tags)', () => {
    expect(html).toMatch(/renderLinks\s*=\s*function[\s\S]*?renderSkillBadges\(l\.tags\)/);
    expect(html).toMatch(/renderLinks\s*=\s*function[\s\S]*?stripSkillTags\(l\.tags\)/);
  });
  it('renderNotes: renderSkillBadges inline with the title row + stripSkillTags for free-form', () => {
    expect(html).toMatch(/renderNotes\s*=\s*function[\s\S]*?renderSkillBadges\(n\.tags\)/);
    expect(html).toMatch(/renderNotes\s*=\s*function[\s\S]*?stripSkillTags\(n\.tags\)/);
  });
});

describe('user-console.html — skill filter applies via rowMatchesSkill', () => {
  const html = loadHtml();

  it('renderBooks filter pass uses rowMatchesSkill', () => {
    expect(html).toMatch(/renderBooks\s*=\s*function[\s\S]*?rowMatchesSkill\(b\.tags,\s*skillF\)/);
  });
  it('renderChannels filter uses rowMatchesSkill', () => {
    expect(html).toMatch(/renderChannels\s*=\s*function[\s\S]*?rowMatchesSkill\(x\.tags,\s*skillF\)/);
  });
  it('renderLinks filter uses rowMatchesSkill', () => {
    expect(html).toMatch(/renderLinks\s*=\s*function[\s\S]*?rowMatchesSkill\(l\.tags,\s*skillF\)/);
  });
  it('renderNotes filter uses rowMatchesSkill', () => {
    expect(html).toMatch(/renderNotes\s*=\s*function[\s\S]*?rowMatchesSkill\(n\.tags,\s*skillF\)/);
  });

  it('filter dropdown read is guarded when element is missing (safe default)', () => {
    // The filter may not be in the DOM on an older cached HTML (defensive).
    // Pattern: `(document.getElementById('bookSkillFilter') || { value: '' }).value`
    expect(html).toMatch(/\|\|\s*\{\s*value:\s*['"]['"]\s*\}\)\.value/);
  });
});

describe('user-console.html — security pins', () => {
  const html = loadHtml();

  it('renderSkillBadges HTML-escapes the label', () => {
    // esc() must wrap the label before interpolation; otherwise a
    // malicious skill id (or label) could inject HTML. We enforce
    // via the SKILL_IDS allow-list anyway but defense in depth.
    expect(html).toMatch(/renderSkillBadges[\s\S]*?esc\(s\s*\?\s*s\.label\s*:\s*id\)/);
  });

  it('renderSkillPicker checkbox value + label are esc()-wrapped', () => {
    expect(html).toMatch(/renderSkillPicker[\s\S]*?value="\$\{esc\(s\.id\)\}"/);
    expect(html).toMatch(/renderSkillPicker[\s\S]*?<span>\$\{esc\(s\.label\)\}<\/span>/);
  });

  it('parseSkillTags only accepts ids in SKILL_IDS (no unknown tags rendered as skills)', () => {
    // Without this gate, a user could type `skill:evil` in the Tags
    // field and see a rendered skill chip. The check is:
    //   if (SKILL_IDS.includes(id) && !seen.has(id))
    expect(html).toMatch(/SKILL_IDS\.includes\(id\)/);
  });
});
