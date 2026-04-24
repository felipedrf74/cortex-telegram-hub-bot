// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Pins the admin-console.html wiring for OI-ADM-301 (tenant detail
 * drawer) and OI-ADM-303 (filtered audit viewer), branch
 * feature/nexus-hub-portal-uiux-admin-user-console, 2026-04-22.
 *
 * These are structural tests — they check the HTML contains the
 * right element ids, the script references the right endpoints,
 * and the UX invariants we committed to (ESC-to-close, click-
 * through from tenant rows, CSV export, expandable audit rows).
 * They do NOT load a browser; see __tests__/portal/ for the pattern.
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const HTML_PATH = path.resolve(__dirname, '../../src/portal/admin-console.html');

function loadHtml(): string {
  return fs.readFileSync(HTML_PATH, 'utf-8');
}

describe('admin-console.html — tenant detail drawer (OI-ADM-301)', () => {
  const html = loadHtml();

  it('declares a drawer root + overlay with the right ids', () => {
    expect(html).toContain('id="drawerOverlay"');
    expect(html).toContain('id="drawer"');
    // aria-labelledby wires the header to the dialog for screen readers
    expect(html).toMatch(/aria-labelledby="drawerTitle"/);
    expect(html).toContain('role="dialog"');
  });

  it('has four subtabs inside the drawer: details / members / usage / audit', () => {
    for (const tab of ['details', 'members', 'usage', 'audit']) {
      expect(html).toContain(`data-sub="${tab}"`);
      expect(html).toContain(`data-sub-section="drawer.${tab}"`);
    }
  });

  it('tenant rows are click-through to openTenantDrawer()', () => {
    // The loadTenants renderer stamps onclick="openTenantDrawer(...)"
    expect(html).toContain('onclick="openTenantDrawer(');
  });

  it('drawer fetches from the four expected endpoints in parallel', () => {
    expect(html).toMatch(/\/owner\/tenants\/['"]?\s*\+\s*tenantId\s*\)/);
    expect(html).toContain("'/owner/tenants/' + tenantId + '/members'");
    expect(html).toContain("'/owner/usage'");
    expect(html).toContain("'/owner/tenants/' + tenantId + '/audit?limit=50'");
    // Parallel: Promise.allSettled across the four jobs.
    expect(html).toContain('Promise.allSettled(jobs)');
  });

  it('ESC closes the drawer', () => {
    expect(html).toMatch(/e\.key\s*===\s*['"]Escape['"]/);
    expect(html).toMatch(/window\.closeDrawer\s*\(\s*\)/);
  });

  it('overlay click closes the drawer', () => {
    expect(html).toMatch(/drawerOverlay[^\n]*onclick="closeDrawer\(\)"/);
  });
});

describe('admin-console.html — filtered audit viewer (OI-ADM-303)', () => {
  const html = loadHtml();

  it('renders the filter form with all 5 inputs', () => {
    for (const id of ['fActor', 'fAction', 'fFrom', 'fTo', 'fQ']) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('has an Apply button that calls auditApplyFilters()', () => {
    expect(html).toMatch(/onclick="auditApplyFilters\(\)"/);
  });

  it('renders pagination + filter meta', () => {
    expect(html).toContain('id="auditPager"');
    expect(html).toContain('id="auditFilterMeta"');
  });

  it('CSV export is client-side (Blob + object URL)', () => {
    expect(html).toContain('exportAuditCsv');
    expect(html).toContain("new Blob(");
    expect(html).toContain('URL.createObjectURL');
    // Escapes CSV special chars.
    expect(html).toMatch(/\[",\\n\\r\]/);
  });

  it('paginator respects total / limit / offset math (prev / next buttons)', () => {
    expect(html).toContain('auditState.total');
    expect(html).toContain('auditState.offset');
    expect(html).toContain('auditState.limit');
    expect(html).toMatch(/auditPage\(-1\)/);
    expect(html).toMatch(/auditPage\(1\)/);
  });

  it('audit row click expands details inline (and click again collapses)', () => {
    expect(html).toContain('attachAuditExpand');
    expect(html).toContain("classList.contains('audit-details')");
  });

  it('filter query string is built via URLSearchParams (not string concat)', () => {
    expect(html).toContain('new URLSearchParams()');
  });

  it('datetime inputs normalize the T separator to a space for SQLite', () => {
    // SQLite datetime() parses both but our server-side compare is
    // safer with SQL-native format. The UI does f.from.replace('T', ' ').
    expect(html).toMatch(/f\.from\.replace\(['"]T['"],\s*['"] ['"]\)/);
    expect(html).toMatch(/f\.to\.replace\(['"]T['"],\s*['"] ['"]\)/);
  });

  it('Security page lazy-loads the audit viewer (not the legacy last-10)', () => {
    // showPage('security') should call loadAudit, not the removed
    // loadSecurity. Relaxed in OI-DATA-005c to allow additional
    // loaders in the same dispatch (e.g. loadAuditPresets) — the
    // invariant is "loadAudit fires on security page," not "it's
    // the ONLY thing that fires."
    expect(html).toMatch(/id\s*===\s*['"]security['"][\s\S]{0,80}?loadAudit\(\)/);
    expect(html).not.toContain('function loadSecurity()');
    expect(html).not.toContain('id="securityAudit"'); // old element removed
  });
});
