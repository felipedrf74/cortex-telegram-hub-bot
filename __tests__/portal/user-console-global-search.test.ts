// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Structural pins for the global search modal in user-console.html
 * (OI-UX-101, branch feature/nexus-hub-portal-uiux-admin-user-console,
 * 2026-04-22).
 *
 * Pure HTML/JS introspection. Asserts:
 *   - the search trigger in the app bar + modal markup exists
 *   - ⌘K / Ctrl+K opens+closes the modal
 *   - arrow keys navigate; Enter picks; Esc closes
 *   - the pages index covers every nav destination (16 entries)
 *   - search matches title AND secondary field (author / url / body)
 *   - substring match (no regex, no fuzzy library dependency)
 *   - match highlighting wraps in <mark>
 *   - platform-aware kbd label (Mac ⌘K vs others Ctrl+K)
 *   - search picks navigate via the shell's showPage()
 *   - empty-state + "visit a tab" banner wiring present
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const HTML_PATH = path.resolve(__dirname, '../../src/portal/user-console.html');
function loadHtml(): string { return fs.readFileSync(HTML_PATH, 'utf-8'); }

describe('user-console.html — Global search markup (OI-UX-101)', () => {
  const html = loadHtml();

  it('app bar has a search trigger with Cmd+K label', () => {
    expect(html).toContain('id="searchTrigger"');
    expect(html).toMatch(/onclick="searchOpen\(\)"/);
    expect(html).toContain('id="searchKbd"');
  });

  it('modal + overlay + input + results container present', () => {
    expect(html).toContain('id="searchOverlay"');
    expect(html).toContain('id="searchModal"');
    expect(html).toContain('id="searchInput"');
    expect(html).toContain('id="searchResults"');
    expect(html).toContain('id="searchCountLabel"');
  });

  it('modal has role="dialog" + aria-label for screen readers', () => {
    expect(html).toMatch(/id="searchModal"[^>]+role="dialog"/);
    expect(html).toMatch(/aria-label="Global search"/);
  });

  it('footer shows keyboard hints (arrow / enter / esc)', () => {
    expect(html).toMatch(/↑<\/kbd><kbd>↓/);
    expect(html).toMatch(/↵<\/kbd>\s*pick/);
    expect(html).toMatch(/Esc<\/kbd>\s*close/);
  });

  it('overlay click closes the modal (not persists)', () => {
    expect(html).toMatch(/id="searchOverlay"[^>]*onclick="searchClose\(\)"/);
  });
});

describe('user-console.html — Global search behavior pins', () => {
  const html = loadHtml();

  it('Cmd+K / Ctrl+K toggles the modal (meta OR ctrl, case-insensitive)', () => {
    // Both macOS (metaKey) and Windows/Linux (ctrlKey) must work.
    expect(html).toMatch(/e\.metaKey\s*\|\|\s*e\.ctrlKey/);
    expect(html).toMatch(/e\.key === ['"]k['"] \|\| e\.key === ['"]K['"]/);
    expect(html).toMatch(/searchModalState\.open\s*\)\s*searchClose\(\);\s*else searchOpen\(\)/);
  });

  it('Escape closes the modal (only when open)', () => {
    expect(html).toMatch(/!searchModalState\.open\s*\)\s*return/);
    expect(html).toMatch(/e\.key === ['"]Escape['"][\s\S]*?searchClose\(\)/);
  });

  it('ArrowUp + ArrowDown update focusedIdx with Math.max/min clamp', () => {
    expect(html).toContain("e.key === 'ArrowDown'");
    expect(html).toContain("e.key === 'ArrowUp'");
    expect(html).toMatch(/Math\.min\(searchModalState\.focusedIdx \+ 1/);
    expect(html).toMatch(/Math\.max\(searchModalState\.focusedIdx - 1/);
  });

  it('Enter calls searchPick(focusedIdx)', () => {
    expect(html).toMatch(/e\.key === ['"]Enter['"][\s\S]*?searchPick\(searchModalState\.focusedIdx\)/);
  });

  it('platform-aware kbd label: ⌘K on Mac, Ctrl+K elsewhere', () => {
    expect(html).toMatch(/navigator\.platform/);
    expect(html).toContain("'⌘K'");
    expect(html).toContain("'Ctrl+K'");
  });

  it('pages index covers every nav destination in the sidebar (at least home, skills, references, team, profile)', () => {
    // Check a sampling of required nav ids are present in PAGES_INDEX.
    const required = [
      'home', 'insights', 'dependencies',
      'skill-content', 'skill-secretary', 'skill-training', 'skill-finance', 'skill-cooking',
      'ref-books', 'ref-channels', 'ref-links', 'ref-notes',
      'activity', 'integrations', 'team', 'profile',
    ];
    for (const id of required) {
      // Must appear as `id: 'foo'` in the PAGES_INDEX.
      expect(html).toMatch(new RegExp(`id:\\s*['"]${id}['"]`));
    }
  });

  it('searchMatch uses substring indexOf (not regex, not fuzzy lib)', () => {
    // Ensures the search is cheap and predictable.
    expect(html).toMatch(/lower\.indexOf\(q\)/);
    // And no import of a fuzzy library.
    expect(html).not.toMatch(/fuse\.js|match-sorter|fuzzysort/i);
  });

  it('searchMatch wraps hits in <mark>', () => {
    expect(html).toContain("'<mark>'");
    expect(html).toContain("'</mark>'");
  });

  it('searchPick navigates via showPage(nav)', () => {
    expect(html).toMatch(/searchPick\s*=\s*function[\s\S]*?showPage\(it\.nav\)/);
  });

  it('searchBuild indexes all 6 client collections + pages', () => {
    // Each collection is guarded by `if (state.foo.length)` so empty
    // ones don't clutter the results. Check each call site exists.
    expect(html).toMatch(/pushGroup\(['"]page['"]/);
    expect(html).toMatch(/pushGroup\(['"]book['"]/);
    expect(html).toMatch(/pushGroup\(['"]channel['"]/);
    expect(html).toMatch(/pushGroup\(['"]link['"]/);
    expect(html).toMatch(/pushGroup\(['"]note['"]/);
    expect(html).toMatch(/pushGroup\(['"]member['"]/);
    expect(html).toMatch(/pushGroup\(['"]event['"]/);
  });

  it('shows a "visit a tab" banner when collections are empty AND a query is active', () => {
    // The banner only fires when missing.length > 0 AND the user is
    // actively searching — no banner on an empty initial open.
    expect(html).toMatch(/searchModalState\.query\s*&&\s*missing\.length > 0/);
    expect(html).toMatch(/class="search-notice"/);
  });

  it('empty-state copy differentiates "no query" vs "no matches"', () => {
    expect(html).toMatch(/Start typing to search your workspace/);
    expect(html).toMatch(/No matches for/);
  });

  it('result count label updates on each render ("N results", singular/plural)', () => {
    expect(html).toMatch(/result' \+ \(searchModalState\.items\.length === 1 \? ''\s*:\s*'s'\)/);
  });

  it('focused item scrolls into view on keyboard navigation', () => {
    expect(html).toMatch(/scrollIntoView\(\{ block: ['"]nearest['"] \}\)/);
  });
});
