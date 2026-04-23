// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Structural + behavior pins for tag autocomplete on reference
 * Add forms (OI-UX-102, 2026-04-23).
 *
 * What this feature does: when a user types into the Books/Links/
 * Notes Add-form tag inputs, a popover shows existing tags (ranked
 * by usage) they can click to insert, so tag vocabulary stays
 * consistent over time (no "reading" vs "reading-list" typo
 * drift).
 *
 * What these pins lock in:
 *
 *   - collectTagPool walks the 4 state arrays + excludes skill:*
 *   - splitTagInput handles the comma-separated editing model
 *   - rankTagSuggestions: prefix > substring, count DESC tiebreak,
 *     already-used filter, max 8
 *   - initTagAutocomplete idempotent via dataset.tagAcBound guard
 *   - initAllTagAutocomplete covers the 3 inputs with free-form tag
 *     fields (Books / Links / Notes). Channels has none today.
 *   - Popover uses mousedown-before-blur to win the focus race
 *   - CSS: .tag-ac-popover is position:fixed + z-index above modals
 *   - esc() wraps every user-controlled string written to innerHTML
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const HTML_PATH = path.resolve(__dirname, '../../src/portal/user-console.html');
function loadHtml(): string { return fs.readFileSync(HTML_PATH, 'utf-8'); }

describe('user-console.html — tag pool collection (OI-UX-102)', () => {
  const html = loadHtml();

  it('collectTagPool defined and walks all 4 reference state arrays', () => {
    expect(html).toMatch(/function collectTagPool\(\)/);
    expect(html).toMatch(
      /collectTagPool[\s\S]*?\[\s*state\.books,\s*state\.links,\s*state\.notes,\s*state\.channels\s*\]/,
    );
  });

  it('excludes skill:* namespace from the pool (owned by skill-picker)', () => {
    expect(html).toMatch(/collectTagPool[\s\S]*?!t\.startsWith\(['"]skill:['"]\)/);
  });

  it('guards against undefined tags arrays + non-string entries', () => {
    // Arrays.isArray + typeof t === 'string' — defense in depth
    // against server payload shapes that might include nulls.
    expect(html).toMatch(/collectTagPool[\s\S]*?Array\.isArray\(src\)/);
    expect(html).toMatch(/collectTagPool[\s\S]*?Array\.isArray\(row\.tags\)/);
    expect(html).toMatch(/collectTagPool[\s\S]*?typeof t === ['"]string['"]/);
  });

  it('uses Map + count increment (bump fn) — ranking needs counts', () => {
    expect(html).toMatch(/const pool = new Map\(\)/);
    expect(html).toMatch(/pool\.set\(t,\s*\(pool\.get\(t\)\s*\|\|\s*0\)\s*\+\s*1\)/);
  });
});

describe('user-console.html — splitTagInput (comma-separated editing)', () => {
  const html = loadHtml();

  it('defined — returns { previous, current }', () => {
    expect(html).toMatch(/function splitTagInput\(raw\)/);
    expect(html).toMatch(/splitTagInput[\s\S]*?return\s*\{\s*previous:\s*['"]['"],\s*current:\s*raw\.trimStart\(\)\s*\}/);
    expect(html).toMatch(
      /splitTagInput[\s\S]*?return\s*\{\s*previous:\s*raw\.slice\(0,\s*idx\s*\+\s*1\),\s*current:\s*raw\.slice\(idx\s*\+\s*1\)\.trimStart\(\)\s*\}/,
    );
  });

  it('splits on the LAST comma (lastIndexOf)', () => {
    // Using indexOf instead would break "a, b, c" — it would keep
    // current="b, c" instead of current="c". Pin the right choice.
    expect(html).toMatch(/splitTagInput[\s\S]*?raw\.lastIndexOf\(['"],['"]\)/);
  });
});

describe('user-console.html — rankTagSuggestions', () => {
  const html = loadHtml();

  it('defined with (pool, prefix, previous) signature', () => {
    expect(html).toMatch(/function rankTagSuggestions\(pool,\s*prefix,\s*previous\)/);
  });

  it('filters out tags already listed in previous', () => {
    expect(html).toMatch(
      /rankTagSuggestions[\s\S]*?const alreadyUsed = new Set\(\s*previous\.split\(['"],['"]\)/,
    );
    expect(html).toMatch(/rankTagSuggestions[\s\S]*?if \(alreadyUsed\.has\(tag\)\) continue/);
  });

  it('prefix matches rank above substring matches', () => {
    // Order of the buckets in the return statement is load-bearing.
    expect(html).toMatch(
      /rankTagSuggestions[\s\S]*?return\s*\[\s*\.\.\.prefixMatch\.sort\(byCountDesc\),\s*\.\.\.substrMatch\.sort\(byCountDesc\)\s*\]/,
    );
  });

  it('empty prefix returns top tags by usage (show-all path)', () => {
    // Focus-before-typing should surface the user's most-used tags.
    expect(html).toMatch(/rankTagSuggestions[\s\S]*?if \(p === ['"]['"]\) prefixMatch\.push/);
  });

  it('tiebreak is count DESC then alphabetical', () => {
    expect(html).toMatch(
      /const byCountDesc\s*=\s*\(a,\s*b\)\s*=>\s*b\.count\s*-\s*a\.count\s*\|\|\s*a\.tag\.localeCompare\(b\.tag\)/,
    );
  });

  it('max 8 suggestions (UI tidy)', () => {
    expect(html).toMatch(/rankTagSuggestions[\s\S]*?\.slice\(0,\s*8\)/);
  });

  it('case-insensitive matching (prefix lowercased)', () => {
    expect(html).toMatch(/rankTagSuggestions[\s\S]*?prefix\s*\|\|\s*['"]['"]\)\.toLowerCase\(\)/);
    expect(html).toMatch(/rankTagSuggestions[\s\S]*?tag\.toLowerCase\(\)/);
  });
});

describe('user-console.html — initTagAutocomplete wiring', () => {
  const html = loadHtml();

  it('defined + idempotent via dataset.tagAcBound guard', () => {
    expect(html).toMatch(/function initTagAutocomplete\(inputId\)/);
    expect(html).toMatch(/initTagAutocomplete[\s\S]*?input\.dataset\.tagAcBound === ['"]1['"]/);
    expect(html).toMatch(/initTagAutocomplete[\s\S]*?input\.dataset\.tagAcBound\s*=\s*['"]1['"]/);
  });

  it('popover appended to document.body (avoids wrapping flex children)', () => {
    // Wrapping the input would break the noteTags `class="grow"`
    // flex-grow hint, so we position:fixed from <body> instead.
    expect(html).toMatch(/initTagAutocomplete[\s\S]*?document\.body\.appendChild\(popover\)/);
  });

  it('popover positioned with getBoundingClientRect (fixed positioning)', () => {
    expect(html).toMatch(/initTagAutocomplete[\s\S]*?input\.getBoundingClientRect\(\)/);
    expect(html).toMatch(/initTagAutocomplete[\s\S]*?popover\.style\.top\s*=\s*\(rect\.bottom\s*\+\s*2\)/);
  });

  it('binds input + focus + blur + keydown(Escape)', () => {
    expect(html).toMatch(/initTagAutocomplete[\s\S]*?addEventListener\(['"]input['"],\s*render\)/);
    expect(html).toMatch(/initTagAutocomplete[\s\S]*?addEventListener\(['"]focus['"],\s*render\)/);
    expect(html).toMatch(/initTagAutocomplete[\s\S]*?addEventListener\(['"]blur['"],/);
    expect(html).toMatch(/initTagAutocomplete[\s\S]*?e\.key === ['"]Escape['"]/);
  });

  it('blur hides with a 150ms delay (so click can fire first)', () => {
    expect(html).toMatch(/initTagAutocomplete[\s\S]*?setTimeout\(hide,\s*150\)/);
  });

  it('popover uses MOUSEDOWN (not click) to win the blur race', () => {
    // If we used click, blur→setTimeout(hide,150)→popover gone
    // before click fires on a slow machine. mousedown fires FIRST
    // and preventDefault stops blur from stealing focus.
    expect(html).toMatch(/popover\.addEventListener\(['"]mousedown['"]/);
    expect(html).toMatch(/initTagAutocomplete[\s\S]*?e\.preventDefault\(\)/);
  });

  it('selection appends tag + comma + space so user can keep typing', () => {
    expect(html).toMatch(/initTagAutocomplete[\s\S]*?input\.value\s*=\s*lead\s*\+\s*tag\s*\+\s*['"],\s*['"]/);
  });

  it('esc() wraps tag text written to innerHTML (XSS defense)', () => {
    // Pool tags are user-controlled strings — we must esc() before
    // interpolating into HTML. Tag attribute value also esc()-wrapped.
    expect(html).toMatch(/initTagAutocomplete[\s\S]*?data-tag="\$\{esc\(s\.tag\)\}"/);
    expect(html).toMatch(/initTagAutocomplete[\s\S]*?<span>\$\{esc\(s\.tag\)\}<\/span>/);
  });
});

describe('user-console.html — initAllTagAutocomplete + boot hook', () => {
  const html = loadHtml();

  it('initAllTagAutocomplete binds all 3 free-form tag inputs', () => {
    expect(html).toMatch(/function initAllTagAutocomplete\(\)/);
    // The implementation is a for-of over a string-array literal,
    // so pin the array + the iteration calling initTagAutocomplete.
    expect(html).toMatch(
      /initAllTagAutocomplete[\s\S]*?for \(const id of \[['"]bookTags['"],\s*['"]linkTags['"],\s*['"]noteTags['"]\]\)\s*\{\s*initTagAutocomplete\(id\)/,
    );
  });

  it('does NOT bind Channels tags input (no such field today)', () => {
    // If channels grows one, we add the id here on purpose.
    expect(html).not.toMatch(/initTagAutocomplete\(['"]channelTags['"]\)/);
  });

  it('invoked from the shared boot-time setTimeout (same one as skill-picker init)', () => {
    // A single setTimeout is cleaner than two — guarantees both
    // inits run in the same microtask batch.
    expect(html).toMatch(
      /setTimeout\(\(\)\s*=>\s*\{[\s\S]*?querySelectorAll\(['"]\.skill-picker\[data-skill-picker-for\]['"]\)[\s\S]*?initAllTagAutocomplete\(\)[\s\S]*?\},\s*0\)/,
    );
  });
});

describe('user-console.html — CSS for autocomplete popover', () => {
  const html = loadHtml();

  it('.tag-ac-popover position:fixed + z-index:30 (above modals at 25)', () => {
    expect(html).toMatch(/\.tag-ac-popover\s*\{[\s\S]*?position:\s*fixed/);
    expect(html).toMatch(/\.tag-ac-popover\s*\{[\s\S]*?z-index:\s*30/);
  });

  it('.tag-ac-popover has scrollable max-height so 8 items always fit', () => {
    expect(html).toMatch(/\.tag-ac-popover\s*\{[\s\S]*?max-height:\s*200px/);
    expect(html).toMatch(/\.tag-ac-popover\s*\{[\s\S]*?overflow-y:\s*auto/);
  });

  it('.tag-ac-item hover tint matches accent (consistent with skill-add-item)', () => {
    expect(html).toMatch(/\.tag-ac-item:hover\s*\{\s*background:\s*var\(--accent-subtle\)/);
  });

  it('.tag-ac-item uses flex-between so count aligns right', () => {
    expect(html).toMatch(/\.tag-ac-item\s*\{[\s\S]*?justify-content:\s*space-between/);
  });
});

describe('user-console.html — regression: autocomplete must not break existing forms', () => {
  const html = loadHtml();

  it('the 3 tag inputs still exist with their ids', () => {
    for (const id of ['bookTags', 'linkTags', 'noteTags']) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('noteTags still carries class="grow" (flex-grow layout intact)', () => {
    expect(html).toMatch(/id="noteTags"[^>]*class="grow"/);
  });

  it('createBook / createLink / createNote still read their tags field verbatim', () => {
    // Autocomplete is pure DOM affordance — create-paths untouched.
    for (const fn of ['createBook', 'createLink', 'createNote']) {
      expect(html).toMatch(new RegExp(`window\\.${fn}\\s*=\\s*async function`));
    }
  });
});
