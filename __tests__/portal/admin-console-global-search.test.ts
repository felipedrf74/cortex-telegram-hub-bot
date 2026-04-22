// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Structural pins for the global search modal in admin-console.html
 * (OI-UX-101a, branch feature/nexus-hub-portal-uiux-admin-user-console,
 * 2026-04-22).
 *
 * Companion to __tests__/portal/user-console-global-search.test.ts —
 * similar invariants, but:
 *   - Admin-plane result groups (tenants, platform admins, adoption
 *     risk, audit) instead of books / channels / notes / links /
 *     teammates / activity.
 *   - Tenant hits DEEP-LINK to openTenantDrawer() rather than plain
 *     showPage() — the search box doubles as a command palette for
 *     tenant drill-in.
 *   - 11 admin pages indexed (Overview ... Settings).
 *   - State caching refactor: loadTenants / loadPlatformAdmins /
 *     paintOverview now capture into state.tenants /
 *     state.platformAdmins / state.inactiveTenants.
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const HTML_PATH = path.resolve(__dirname, '../../src/portal/admin-console.html');
function loadHtml(): string { return fs.readFileSync(HTML_PATH, 'utf-8'); }

describe('admin-console.html — Global search markup (OI-UX-101a)', () => {
  const html = loadHtml();

  it('app bar has the search trigger with Cmd+K hint', () => {
    expect(html).toContain('id="searchTrigger"');
    expect(html).toMatch(/onclick="searchOpen\(\)"/);
    expect(html).toContain('id="searchKbd"');
  });

  it('trigger placeholder references admin-plane terms (not user-plane)', () => {
    // Copy should guide the user toward admin expectations.
    expect(html).toMatch(/Search tenants, admins, audit/);
  });

  it('modal has role="dialog" + aria-label', () => {
    expect(html).toMatch(/id="searchModal"[^>]+role="dialog"/);
    expect(html).toMatch(/aria-label="Global search"/);
  });

  it('input + results + footer containers present', () => {
    expect(html).toContain('id="searchOverlay"');
    expect(html).toContain('id="searchInput"');
    expect(html).toContain('id="searchResults"');
    expect(html).toContain('id="searchCountLabel"');
  });
});

describe('admin-console.html — Global search behavior pins', () => {
  const html = loadHtml();

  it('Cmd+K / Ctrl+K toggles', () => {
    expect(html).toMatch(/e\.metaKey\s*\|\|\s*e\.ctrlKey/);
    expect(html).toMatch(/e\.key === ['"]k['"] \|\| e\.key === ['"]K['"]/);
  });

  it('platform-aware kbd label', () => {
    expect(html).toMatch(/navigator\.platform/);
    expect(html).toContain("'⌘K'");
    expect(html).toContain("'Ctrl+K'");
  });

  it('11 admin pages indexed covering every sidebar destination', () => {
    const required = [
      'overview', 'tenants', 'users', 'usage', 'skills', 'security',
      'references', 'integrations', 'operations', 'growth', 'settings',
    ];
    for (const id of required) {
      expect(html).toMatch(new RegExp(`id:\\s*['"]${id}['"]`));
    }
  });

  it('searchMatch uses substring indexOf, no regex / fuzzy library', () => {
    expect(html).toMatch(/lower\.indexOf\(q\)/);
    expect(html).not.toMatch(/fuse\.js|match-sorter|fuzzysort/i);
  });

  it('searchMatch wraps hits in <mark>', () => {
    expect(html).toContain("'<mark>'");
    expect(html).toContain("'</mark>'");
  });

  it('ArrowUp + ArrowDown navigate with Math.max/min clamp', () => {
    expect(html).toContain("e.key === 'ArrowDown'");
    expect(html).toContain("e.key === 'ArrowUp'");
    expect(html).toMatch(/Math\.min\(searchModalState\.focusedIdx \+ 1/);
    expect(html).toMatch(/Math\.max\(searchModalState\.focusedIdx - 1/);
  });

  it('Enter calls searchPick', () => {
    expect(html).toMatch(/e\.key === ['"]Enter['"][\s\S]*?searchPick\(searchModalState\.focusedIdx\)/);
  });

  it('Escape closes only when open', () => {
    expect(html).toMatch(/!searchModalState\.open\s*\)\s*return/);
    expect(html).toMatch(/e\.key === ['"]Escape['"][\s\S]*?searchClose\(\)/);
  });

  it('indexes all 4 admin result groups + pages', () => {
    for (const kind of ['page', 'tenant', 'risk', 'admin', 'event']) {
      expect(html).toMatch(new RegExp(`pushGroup\\(['"]${kind}['"]`));
    }
  });

  it('banner flags missing collections (tenants / admins / audit)', () => {
    expect(html).toMatch(/searchModalState\.query\s*&&\s*missing\.length > 0/);
    expect(html).toMatch(/class="search-notice"/);
    // Each of the 3 admin collections should be checked.
    expect(html).toMatch(/state\.tenants\.length/);
    expect(html).toMatch(/state\.platformAdmins\.length/);
    expect(html).toMatch(/auditState\.lastRows\.length/);
  });
});

describe('admin-console.html — tenant-drawer deep-link (command-palette mode)', () => {
  const html = loadHtml();

  it('tenant results carry action.type === "tenant-drawer" with id + slug', () => {
    expect(html).toMatch(/type:\s*['"]tenant-drawer['"]\s*,\s*tenantId:\s*t\.id\s*,\s*slug:\s*t\.slug/);
  });

  it('adoption-risk results also deep-link to the tenant drawer', () => {
    // Same action, different source collection.
    expect(html).toMatch(/id:\s*['"]risk:['"]\s*\+\s*t\.id,\s*action:\s*\{\s*type:\s*['"]tenant-drawer['"]/);
  });

  it('searchPick for tenant-drawer action calls openTenantDrawer (not just showPage)', () => {
    expect(html).toMatch(/it\.action\.type === ['"]tenant-drawer['"][\s\S]*?openTenantDrawer\(it\.action\.tenantId,\s*it\.action\.slug\)/);
  });

  it('navigates to the Tenants tab BEFORE opening the drawer (so drawer overlays familiar context)', () => {
    // Sequence: showPage('tenants'), then setTimeout → openTenantDrawer.
    expect(html).toMatch(/showPage\(['"]tenants['"]\);\s*\/\/[\s\S]*?setTimeout\([\s\S]*?openTenantDrawer/);
  });

  it('non-tenant results use nav dispatch', () => {
    expect(html).toMatch(/it\.action\.type === ['"]nav['"][\s\S]*?showPage\(it\.action\.nav\)/);
  });

  it('audit event hits route to the Security page (not Overview)', () => {
    // Events are rendered on /admin-console → Security with the
    // filtered viewer. The event result should deep-link there.
    expect(html).toMatch(/auditState\.lastRows[\s\S]*?action:\s*\{\s*type:\s*['"]nav['"]\s*,\s*nav:\s*['"]security['"]/);
  });
});

describe('admin-console.html — state caching refactor', () => {
  const html = loadHtml();

  it('state bag includes new collections', () => {
    expect(html).toMatch(/tenants:\s*\[\]/);
    expect(html).toMatch(/platformAdmins:\s*\[\]/);
    expect(html).toMatch(/inactiveTenants:\s*\[\]/);
  });

  it('loadTenants caches into state.tenants', () => {
    expect(html).toMatch(/loadTenants[\s\S]*?state\.tenants\s*=\s*tenants/);
  });

  it('loadPlatformAdmins caches into state.platformAdmins', () => {
    expect(html).toMatch(/loadPlatformAdmins[\s\S]*?state\.platformAdmins\s*=\s*admins/);
  });

  it('paintOverview caches adoption-risk into state.inactiveTenants', () => {
    expect(html).toMatch(/state\.inactiveTenants\s*=\s*inactive/);
  });

  it('auditState is reused from OI-ADM-303 — not redeclared', () => {
    // Single declaration of auditState; the search reads it.
    const matches = html.match(/const auditState\s*=\s*\{/g) || [];
    expect(matches.length).toBe(1);
  });
});
