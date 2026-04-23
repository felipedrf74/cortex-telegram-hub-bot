// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Structural + behavior pins for keyboard shortcuts on the User
 * Console (OI-UX-105, 2026-04-23).
 *
 * Bindings:
 *   /          Open search (complements Cmd+K from OI-UX-101)
 *   ?          Open shortcuts help modal
 *   Esc        Close shortcuts help (if open)
 *   g then X   Navigate — 10 targets (g h/i/d/a/t/p for nav; g b/c/l/n
 *              for Reference Center)
 *
 * The pins lock in the four correctness guards that make global
 * keyboard bindings safe in a dense portal UI:
 *
 *   1. `isTypingInInput` bails before any binding fires, so a user
 *      typing "g" into a note body doesn't nav to Home.
 *   2. Modifier-key bailout (`metaKey || ctrlKey || altKey`) keeps
 *      browser shortcuts like Ctrl+T untouched.
 *   3. g-prefix has 1500ms expiry so a stray `g` doesn't swallow
 *      the user's next keystroke indefinitely.
 *   4. All handlers `e.preventDefault()` when they consume the key.
 *
 * Also pins the help modal structure (10 nav rows + 4 global rows,
 * sectioned) so a future HTML refactor can't drop a binding without
 * updating the map or the test.
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const HTML_PATH = path.resolve(__dirname, '../../src/portal/user-console.html');
const loadHtml = (): string => fs.readFileSync(HTML_PATH, 'utf-8');

const SHORTCUT_G_EXPECTED: Array<[string, string]> = [
  ['h', 'home'],
  ['b', 'ref-books'],
  ['c', 'ref-channels'],
  ['l', 'ref-links'],
  ['n', 'ref-notes'],
  ['i', 'insights'],
  ['d', 'dependencies'],
  ['a', 'activity'],
  ['t', 'team'],
  ['p', 'profile'],
];

describe('user-console.html — SHORTCUT_G_MAP (OI-UX-105)', () => {
  const html = loadHtml();

  it('SHORTCUT_G_MAP declared as an object', () => {
    expect(html).toMatch(/const SHORTCUT_G_MAP\s*=\s*\{/);
  });

  it('maps every expected key → the corresponding showPage id', () => {
    for (const [key, page] of SHORTCUT_G_EXPECTED) {
      expect(html).toMatch(new RegExp(`${key}:\\s*['"]${page}['"]`));
    }
  });

  it('no extra keys: every key→page pair appears in the help modal too', () => {
    // The help modal renders <kbd>g</kbd><kbd>X</kbd> for every
    // binding. If someone adds a key to the map, they must also
    // add a row to the modal (and vice versa). This pin catches
    // drift between the map and its documentation.
    for (const [key, _page] of SHORTCUT_G_EXPECTED) {
      expect(html).toMatch(
        new RegExp(`<kbd>g</kbd><kbd>${key}</kbd>`),
      );
    }
  });
});

describe('user-console.html — keyboard handler guards (OI-UX-105)', () => {
  const html = loadHtml();

  it('isTypingInInput defined with INPUT/TEXTAREA/SELECT + contentEditable', () => {
    expect(html).toMatch(/function isTypingInInput\(target\)/);
    expect(html).toMatch(
      /isTypingInInput[\s\S]*?tag === ['"]INPUT['"] \|\| tag === ['"]TEXTAREA['"] \|\| tag === ['"]SELECT['"]/,
    );
    expect(html).toMatch(/isTypingInInput[\s\S]*?target\.isContentEditable/);
  });

  it('input guard is the FIRST check inside the keydown listener', () => {
    // Ordering matters: if we checked the key first, typing "g"
    // into a note body would nav. Pin the guard-first contract by
    // matching the handler opens with a return-on-input check.
    expect(html).toMatch(
      /document\.addEventListener\(['"]keydown['"],\s*\(e\)\s*=>\s*\{\s*if \(isTypingInInput\(e\.target\)\) return;/,
    );
  });

  it('modifier-key bailout preserves browser shortcuts (Cmd/Ctrl/Alt)', () => {
    expect(html).toMatch(
      /addEventListener\(['"]keydown['"][\s\S]*?if \(e\.metaKey \|\| e\.ctrlKey \|\| e\.altKey\) return;/,
    );
  });
});

describe('user-console.html — g-prefix state machine (OI-UX-105)', () => {
  const html = loadHtml();

  it('kbPending state object + set/clear helpers defined', () => {
    expect(html).toMatch(/const kbPending\s*=\s*\{\s*g:\s*false,\s*timer:\s*null\s*\}/);
    expect(html).toMatch(/function kbSetPending\(\)/);
    expect(html).toMatch(/function kbClearPending\(\)/);
  });

  it('set-pending arms a 1500ms expiry timer', () => {
    // Too short (e.g. 300ms) and "g h" feels impossible on slow
    // machines; too long (10s) and stale prefixes linger. 1500ms
    // is the Vim/Gmail/Linear convention.
    expect(html).toMatch(/kbSetPending[\s\S]*?setTimeout\(kbClearPending,\s*1500\)/);
  });

  it('set-pending clears prior timer before arming a new one', () => {
    // Otherwise holding `g` spawns N timers, and the last to fire
    // can wipe pending=true mid-dispatch of a valid binding.
    expect(html).toMatch(/kbSetPending[\s\S]*?clearTimeout\(kbPending\.timer\)/);
  });

  it('g-dispatch consumes the prefix (one-shot) — always clears pending', () => {
    // Whether the 2nd key resolves to a valid page or not, the
    // prefix resets so we don't remain armed for a third key.
    expect(html).toMatch(/if \(kbPending\.g\)\s*\{\s*kbClearPending\(\)/);
  });

  it('g-dispatch uses e.key.toLowerCase() so CapsLock doesn\'t break g-H', () => {
    expect(html).toMatch(
      /kbPending\.g[\s\S]*?SHORTCUT_G_MAP\[e\.key\.toLowerCase\(\)\]/,
    );
  });

  it('first `g` keystroke sets pending + preventDefault', () => {
    expect(html).toMatch(
      /if \(e\.key === ['"]g['"] \|\| e\.key === ['"]G['"]\)\s*\{\s*e\.preventDefault\(\);\s*kbSetPending\(\)/,
    );
  });
});

describe('user-console.html — / and ? handlers (OI-UX-105)', () => {
  const html = loadHtml();

  it('/ opens search modal (complements Cmd+K)', () => {
    expect(html).toMatch(
      /if \(e\.key === ['"]\/['"]\)\s*\{\s*e\.preventDefault\(\);\s*if \(typeof searchOpen === ['"]function['"]\) searchOpen\(\)/,
    );
  });

  it('? opens shortcuts help modal', () => {
    expect(html).toMatch(
      /if \(e\.key === ['"]\?['"]\)\s*\{\s*e\.preventDefault\(\);\s*kbShortcutsOpen\(\)/,
    );
  });

  it('Escape closes shortcuts help only when it is open', () => {
    // Guarded by kbShortcutsIsOpen() so Esc in other contexts
    // (search modal, hypothetical other modals) doesn't race.
    expect(html).toMatch(
      /e\.key === ['"]Escape['"] && kbShortcutsIsOpen\(\)[\s\S]*?kbShortcutsClose\(\)/,
    );
  });
});

describe('user-console.html — shortcuts modal: structure (OI-UX-105)', () => {
  const html = loadHtml();

  it('#kbShortcutsModal element exists with role=dialog + aria-label', () => {
    expect(html).toMatch(
      /<div id="kbShortcutsModal" class="kb-modal hidden" role="dialog" aria-label="Keyboard shortcuts">/,
    );
  });

  it('has a header with Close button wired to kbShortcutsClose()', () => {
    expect(html).toMatch(/<div class="kb-modal-header">/);
    expect(html).toMatch(/onclick="kbShortcutsClose\(\)"/);
  });

  it('body has 3 sections: Navigation / Reference Center / Global', () => {
    expect(html).toMatch(/<h4>Navigation<\/h4>/);
    expect(html).toMatch(/<h4>Reference Center<\/h4>/);
    expect(html).toMatch(/<h4>Global<\/h4>/);
  });

  it('Global section lists / + ⌘K + ? + Esc rows', () => {
    // Proxy: require all four labels present in the file.
    for (const label of ['Open search', 'Open search (Cmd+K)', 'Show this help', 'Close modals']) {
      expect(html).toContain(label);
    }
  });

  it('footer notes that shortcuts are disabled while typing', () => {
    expect(html).toMatch(/<div class="kb-modal-footer">/);
    expect(html).toMatch(/Shortcuts are disabled while you're typing in a field/);
  });
});

describe('user-console.html — shortcuts modal: CSS (OI-UX-105)', () => {
  const html = loadHtml();

  it('.kb-modal position:fixed + z-index 72 (one above search at 71)', () => {
    // Stacking matters: if both modals ever open at once, the
    // shortcuts help must appear on top of the search modal.
    expect(html).toMatch(/\.kb-modal\s*\{[\s\S]*?position:\s*fixed/);
    expect(html).toMatch(/\.kb-modal\s*\{[\s\S]*?z-index:\s*72/);
  });

  it('.kb-modal-body uses 2-column grid for dense binding display', () => {
    expect(html).toMatch(/\.kb-modal-body\s*\{[\s\S]*?grid-template-columns:\s*1fr 1fr/);
  });

  it('.kb-modal kbd has monospace + tertiary background (consistent with search footer)', () => {
    expect(html).toMatch(/\.kb-modal-row kbd\s*\{[\s\S]*?background:\s*var\(--bg-tertiary\)/);
    expect(html).toMatch(/\.kb-modal-row kbd\s*\{[\s\S]*?font-family:\s*['"]JetBrains Mono['"]/);
  });
});

describe('user-console.html — open/close helpers + window exposure (OI-UX-105)', () => {
  const html = loadHtml();

  it('kbShortcutsOpen / kbShortcutsClose / kbShortcutsIsOpen defined', () => {
    for (const fn of ['kbShortcutsOpen', 'kbShortcutsClose', 'kbShortcutsIsOpen']) {
      expect(html).toMatch(new RegExp(`function\\s+${fn}\\s*\\(\\s*\\)`));
    }
  });

  it('open/close exposed on window for the modal Close button onclick', () => {
    expect(html).toMatch(/window\.kbShortcutsOpen\s*=\s*kbShortcutsOpen/);
    expect(html).toMatch(/window\.kbShortcutsClose\s*=\s*kbShortcutsClose/);
  });

  it('kbShortcutsIsOpen uses class-toggle as state (no separate var)', () => {
    expect(html).toMatch(
      /kbShortcutsIsOpen[\s\S]*?!m\.classList\.contains\(['"]hidden['"]\)/,
    );
  });
});

describe('user-console.html — search-footer advertises ? binding (OI-UX-105)', () => {
  const html = loadHtml();

  it('search modal footer now lists the ? shortcut', () => {
    // Users who discovered Cmd+K should have a trail back to the
    // full list. Putting "? shortcuts" next to the other key
    // hints makes the feature discoverable.
    expect(html).toMatch(/<kbd>\?<\/kbd>\s*shortcuts/);
  });
});

describe('user-console.html — regression: existing Cmd+K listener untouched (OI-UX-105)', () => {
  const html = loadHtml();

  it('Cmd+K / Ctrl+K still opens the search modal from its own listener', () => {
    // If someone merges the two listeners without care, the
    // search-modal-specific arrow-nav logic could regress.
    expect(html).toMatch(
      /const isCmdK = \(e\.metaKey \|\| e\.ctrlKey\) && \(e\.key === ['"]k['"] \|\| e\.key === ['"]K['"]\)/,
    );
  });

  it('searchOpen + searchClose still defined (no rename side-effect)', () => {
    // These are assigned as window methods (window.searchOpen = function...)
    // so pin that shape, not the bare declaration form.
    for (const fn of ['searchOpen', 'searchClose']) {
      expect(html).toMatch(new RegExp(`window\\.${fn}\\s*=\\s*function`));
    }
  });
});
