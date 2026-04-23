// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Structural pins for the <768 px responsive collapse
 * (OI-UX-106, 2026-04-23).
 *
 * What the feature does: both consoles ship a `@media (max-width:
 * 768px)` block that (a) shows a hamburger button in the app-bar,
 * (b) turns the sidebar into a slide-in drawer with a 280px max
 * width (or 80vw on very small viewports), (c) tightens app-bar
 * chrome by hiding the scope pill + search label + console-switch
 * padding, and (d) on user-console specifically, wraps dense
 * reference tables in a horizontal-scroll container so the page
 * body doesn't require sideways scrolling.
 *
 * The JS side of this PR exposes `toggleMobileNav` + `closeMobileNav`
 * on both consoles, auto-closes the drawer from `showPage()`, and
 * adds a click-outside-closes handler on document.
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const USER = path.resolve(__dirname, '../../src/portal/user-console.html');
const ADMIN = path.resolve(__dirname, '../../src/portal/admin-console.html');
const loadUser = (): string => fs.readFileSync(USER, 'utf-8');
const loadAdmin = (): string => fs.readFileSync(ADMIN, 'utf-8');

describe('both consoles — hamburger button + media query block (OI-UX-106)', () => {
  for (const [name, load] of [['user-console', loadUser], ['admin-console', loadAdmin]] as const) {
    describe(name, () => {
      const html = load();

      it('#mobileNavToggle button declared in app-bar with aria-label + aria-expanded', () => {
        expect(html).toMatch(
          /<button id="mobileNavToggle" class="mobile-nav-toggle" onclick="toggleMobileNav\(\)" aria-label="Toggle navigation" aria-expanded="false">/,
        );
      });

      it('.mobile-nav-toggle defaults to display: none (hidden at desktop)', () => {
        expect(html).toMatch(/\.mobile-nav-toggle\s*\{\s*display:\s*none;/);
      });

      it('single @media (max-width: 768px) block exists', () => {
        expect(html).toMatch(/@media \(max-width:\s*768px\)\s*\{/);
      });

      it('@768 shows the hamburger via inline-flex', () => {
        expect(html).toMatch(
          /@media \(max-width:\s*768px\)[\s\S]*?\.mobile-nav-toggle\s*\{[\s\S]*?display:\s*inline-flex/,
        );
      });

      it('@768 collapses shell to single column (grid-areas: bar / main)', () => {
        expect(html).toMatch(
          /@media \(max-width:\s*768px\)[\s\S]*?\.shell\s*\{[\s\S]*?grid-template-areas:\s*['"]bar['"]\s*['"]main['"]/,
        );
      });

      it('@768 sidebar becomes a fixed-position slide-in drawer', () => {
        expect(html).toMatch(
          /@media \(max-width:\s*768px\)[\s\S]*?\.sidebar\s*\{[\s\S]*?position:\s*fixed/,
        );
        expect(html).toMatch(
          /\.sidebar\s*\{[\s\S]*?transform:\s*translateX\(-100%\)/,
        );
      });

      it('@768 drawer has bounded width: min(280px, 80vw)', () => {
        expect(html).toMatch(/\.sidebar\s*\{[\s\S]*?width:\s*min\(280px,\s*80vw\)/);
      });

      it('@768 .sidebar.mobile-open slides the drawer into view', () => {
        expect(html).toMatch(/\.sidebar\.mobile-open\s*\{\s*transform:\s*translateX\(0\)/);
      });

      it('@768 backdrop pseudo-element has pointer-events: none (click-through)', () => {
        // Pointer-events: none is load-bearing: clicks pass through
        // to the document click-outside listener, which closes the
        // drawer. Without it, a tap outside would hit the backdrop
        // and do nothing.
        expect(html).toMatch(
          /\.sidebar\.mobile-open::after\s*\{[\s\S]*?pointer-events:\s*none/,
        );
      });

      it('@768 app-bar hides divider + scope-pill to save space', () => {
        expect(html).toMatch(
          /@media \(max-width:\s*768px\)[\s\S]*?\.app-bar \.divider,\s*\.app-bar \.scope-pill\s*\{\s*display:\s*none/,
        );
      });

      it('@768 search-trigger hides label + kbd shortcut hint (icon-only)', () => {
        expect(html).toMatch(/\.app-bar \.search-trigger \.search-label\s*\{\s*display:\s*none/);
        expect(html).toMatch(/\.app-bar \.search-trigger \.search-kbd\s*\{\s*display:\s*none/);
      });
    });
  }
});

describe('user-console — extra responsive rules (OI-UX-106)', () => {
  const html = loadUser();

  it('@768 tightens page padding', () => {
    expect(html).toMatch(
      /@media \(max-width:\s*768px\)[\s\S]*?\.page\s*\{\s*padding:\s*var\(--space-3\)\s+var\(--space-3\)\s+var\(--space-5\)/,
    );
  });

  it('@768 wraps dense tables in a horizontal-scroll container', () => {
    // The rule targets `.page table.data` specifically (not every
    // table — team invites, drawer tables, etc. keep their flow).
    // Horizontal scroll beats stacking into cards at this scope:
    // the user can see the columns they expect.
    expect(html).toMatch(
      /@media \(max-width:\s*768px\)[\s\S]*?\.page table\.data\s*\{[\s\S]*?overflow-x:\s*auto/,
    );
  });

  it('@768 bulk toolbar wraps (so Apply/Delete/Clear flow onto 2 rows on narrow screens)', () => {
    expect(html).toMatch(
      /@media \(max-width:\s*768px\)[\s\S]*?\.bulk-toolbar\s*\{\s*flex-wrap:\s*wrap/,
    );
  });

  it('@768 shortcuts-help modal sections stack (single column instead of 2-col grid)', () => {
    expect(html).toMatch(
      /@media \(max-width:\s*768px\)[\s\S]*?\.kb-modal-body\s*\{\s*grid-template-columns:\s*1fr/,
    );
  });

  it('@768 modals sit near the top (top: 5vh) with room for keyboard-open', () => {
    expect(html).toMatch(
      /\.search-modal,\s*\.kb-modal\s*\{\s*top:\s*5vh/,
    );
  });
});

describe('both consoles — mobile nav JS helpers (OI-UX-106)', () => {
  for (const [name, load] of [['user-console', loadUser], ['admin-console', loadAdmin]] as const) {
    describe(name, () => {
      const html = load();

      it('toggleMobileNav defined + exposed on window', () => {
        expect(html).toMatch(/function toggleMobileNav\(\)/);
        expect(html).toMatch(/window\.toggleMobileNav\s*=\s*toggleMobileNav/);
      });

      it('closeMobileNav defined (used by showPage + click-outside)', () => {
        expect(html).toMatch(/function closeMobileNav\(\)/);
      });

      it('toggle flips mobile-open class + updates aria-expanded', () => {
        expect(html).toMatch(
          /toggleMobileNav[\s\S]*?nav\.classList\.toggle\(['"]mobile-open['"]\)/,
        );
        expect(html).toMatch(
          /toggleMobileNav[\s\S]*?btn\.setAttribute\(['"]aria-expanded['"],\s*String\(open\)\)/,
        );
      });

      it('closeMobileNav resets aria-expanded to "false"', () => {
        expect(html).toMatch(
          /closeMobileNav[\s\S]*?btn\.setAttribute\(['"]aria-expanded['"],\s*['"]false['"]\)/,
        );
      });

      it('showPage() auto-closes drawer via closeMobileNav() at the end', () => {
        // Calling closeMobileNav from showPage ensures every
        // navigation (nav click, search pick, keyboard shortcut,
        // deep link) leaves the drawer closed.
        expect(html).toMatch(/function showPage\(id\)[\s\S]*?closeMobileNav\(\);\s*\}/);
      });

      it('document click-outside handler closes the drawer', () => {
        expect(html).toMatch(
          /document\.addEventListener\(['"]click['"],\s*\(e\)\s*=>\s*\{[\s\S]*?mobile-open[\s\S]*?closeMobileNav\(\)/,
        );
      });

      it('click-outside handler bails if target is inside the drawer', () => {
        // Prevents a tap on a nav-item from double-firing (existing
        // click handler runs showPage, which closes; we then must
        // NOT also close again inside click-outside).
        expect(html).toMatch(
          /document\.addEventListener\(['"]click['"][\s\S]*?if \(nav\.contains\(e\.target\)\) return/,
        );
      });

      it('click-outside handler bails if target is the hamburger itself', () => {
        // The hamburger has its own onclick=toggleMobileNav; if we
        // also closed via click-outside, the net effect of tapping
        // the hamburger would always be "close", never "open".
        expect(html).toMatch(
          /document\.addEventListener\(['"]click['"][\s\S]*?btn\.contains\(e\.target\)\) return/,
        );
      });
    });
  }
});

describe('regression: desktop-width rendering untouched (OI-UX-106)', () => {
  for (const [name, load] of [['user-console', loadUser], ['admin-console', loadAdmin]] as const) {
    describe(name, () => {
      const html = load();

      it('default `.shell` grid still uses 260px sidebar + 1fr main at desktop widths', () => {
        // The media query only flips at <=768px; desktop must keep
        // the original grid. Pin the un-wrapped rule.
        expect(html).toMatch(/\.shell\s*\{[\s\S]*?grid-template-columns:\s*260px 1fr/);
      });

      it('default `.sidebar` has no `position: fixed` at desktop (stays in grid)', () => {
        // Pin the UN-wrapped sidebar rule to confirm fixed-position
        // only applies inside the media query.
        const unwrapped = html.match(/^\.sidebar\s*\{[\s\S]*?^\}/m);
        // The first `.sidebar {` block must not contain position: fixed
        expect(unwrapped?.[0] || '').not.toMatch(/position:\s*fixed/);
      });
    });
  }
});
