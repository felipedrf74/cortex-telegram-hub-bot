// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * OI-USR-403 (2026-04-24) — structural pins for the User Console
 * Integrations page.
 *
 * What we pin (and why):
 *   - The Integrations section no longer shows the legacy
 *     "Integration management lives in the iOS app" empty state.
 *     Its replacement renders a live #integrationsTable + meta
 *     counter populated by loadIntegrations().
 *   - showPage('integrations') calls loadIntegrations().
 *   - loadIntegrations fetches GET /workspace/integrations, reads
 *     r.data.integrations, and renders through renderIntegrationRow
 *     per row + a trailing iOS hand-off note.
 *   - renderIntegrationRow branches on `connected` + healthStatus,
 *     emits the 5 columns, and HTML-escapes user-controlled fields
 *     (provider, error messages) — defense-in-depth even though
 *     the server controls these today.
 *   - formatIntegrationDate defensively handles malformed
 *     timestamps (never renders "Invalid Date").
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const USER_CONSOLE_HTML = path.resolve(__dirname, '../../src/portal/user-console.html');
function read(): string { return fs.readFileSync(USER_CONSOLE_HTML, 'utf-8'); }

describe('user-console.html — Integrations page markup (OI-USR-403)', () => {
  const src = read();

  it('legacy "Integration management lives in the iOS app" empty state is GONE', () => {
    // The empty-state used to tell users "this page is a
    // placeholder; go to iOS". With live data, that copy must be
    // removed so users don't get conflicting signals.
    expect(src).not.toContain('Integration management lives in the iOS app');
  });

  it('Integrations section renders a panel with #integrationsTable + #integrationsMeta', () => {
    expect(src).toMatch(/<section[^>]*data-page="integrations"[\s\S]*?id="integrationsTable"/);
    expect(src).toMatch(/<section[^>]*data-page="integrations"[\s\S]*?id="integrationsMeta"/);
  });

  it('subtitle messages that this page is read-only (iOS owns connect/disconnect)', () => {
    // UX invariant: we don't want users to click things here
    // expecting to trigger OAuth. Messaging upfront prevents
    // confused-user tickets.
    expect(src).toMatch(
      /<section[^>]*data-page="integrations"[\s\S]*?read-only/i,
    );
  });
});

describe('user-console.html — showPage dispatch (OI-USR-403)', () => {
  const src = read();

  it('showPage("integrations") calls loadIntegrations()', () => {
    expect(src).toMatch(/if \(id === ['"]integrations['"]\)\s*loadIntegrations\(\)/);
  });
});

describe('user-console.html — loadIntegrations helper (OI-USR-403)', () => {
  const src = read();

  it('is declared as an async function', () => {
    expect(src).toMatch(/async function loadIntegrations\(\)/);
  });

  it('fetches GET /workspace/integrations via fetchJson', () => {
    expect(src).toMatch(
      /loadIntegrations[\s\S]{0,500}?await fetchJson\(['"]\/workspace\/integrations['"]\)/,
    );
  });

  it('reads the rows off r.data.integrations + defends against missing arrays', () => {
    // A production-side bug that returns `{ok:true, data:{}}` (no
    // integrations field) must NOT break the page. Array.isArray
    // guard keeps the "No providers to show" fallback working.
    expect(src).toMatch(
      /const rows = Array\.isArray\(r\?\.data\?\.integrations\)\s*\?\s*r\.data\.integrations\s*:\s*\[\]/,
    );
  });

  it('shows a "N of M connected" meta counter', () => {
    expect(src).toMatch(/connectedCount[\s\S]{0,300}?connected/i);
    expect(src).toMatch(/connectedCount = rows\.filter\(\(x\) => x\.connected\)\.length/);
  });

  it('renders each row through renderIntegrationRow (no inline row template)', () => {
    // Keeps the table generator readable; renderIntegrationRow is
    // unit-pinned below. A future contributor who inlines the
    // template breaks this pin and is nudged to keep the split.
    expect(src).toMatch(/rows\.map\(\(x\) => renderIntegrationRow\(x\)\)\.join\(['"]['"]\)/);
  });

  it('appends a read-only hand-off note pointing users to the iOS app', () => {
    expect(src).toMatch(
      /loadIntegrations[\s\S]{0,2000}?open the Nexus Hub iOS app[\s\S]{0,100}?read-only/i,
    );
  });

  it('renders an error banner when fetchJson rejects (network / 5xx)', () => {
    expect(src).toMatch(
      /loadIntegrations[\s\S]{0,2000}?class="error-banner">Failed to load integrations/,
    );
  });
});

describe('user-console.html — renderIntegrationRow (OI-USR-403)', () => {
  const src = read();

  it('emits a Connected pill for connected providers + Not-connected for others', () => {
    expect(src).toMatch(/renderIntegrationRow[\s\S]{0,500}?x\.connected\s*\?\s*['"`]<span class="pill ready">Connected/);
    expect(src).toMatch(/Not connected/);
  });

  it('maps healthStatus to a distinct pill class (ok/fail/skipped/unknown)', () => {
    expect(src).toMatch(
      /renderIntegrationRow[\s\S]{0,600}?healthStatus === ['"]ok['"]\s*\?\s*['"]ready['"][\s\S]{0,200}?['"]fail['"]\s*\?\s*['"]danger['"][\s\S]{0,200}?['"]skipped['"]\s*\?\s*['"]info['"]/,
    );
  });

  it('emits 5 columns (provider / status / connected / expires / health)', () => {
    // Match the <td> count in the row template.
    const rowBlock = src.match(/function renderIntegrationRow[\s\S]{0,2000}?return `<tr>([\s\S]*?)<\/tr>`/);
    expect(rowBlock).not.toBeNull();
    const tdCount = (rowBlock![1].match(/<td/g) || []).length;
    expect(tdCount).toBe(5);
  });

  it('escapes user-controlled fields via esc() (defense in depth)', () => {
    // provider + error message flow from server responses; even
    // though the server controls them, HTML-escaping here is a
    // belt-and-suspenders defense against an injection regression
    // in the API.
    expect(src).toMatch(/renderIntegrationRow[\s\S]{0,2000}?esc\(x\.provider\)/);
    expect(src).toMatch(/renderIntegrationRow[\s\S]{0,2500}?esc\(x\.healthError\)/);
  });

  it('hides expiresAt for disconnected providers; shows "never" when connected but no expiry', () => {
    // The visual: disconnected rows show '—' in the expiry column
    // (no info). Connected rows with null expiresAt show 'never'
    // (factual: provider issues non-expiring tokens). A real ISO
    // date runs through formatIntegrationDate.
    expect(src).toMatch(
      /renderIntegrationRow[\s\S]{0,1500}?x\.expiresAt\s*\?\s*formatIntegrationDate\(x\.expiresAt\)\s*:\s*\(x\.connected\s*\?\s*['"]never['"]\s*:\s*['"]—['"]\)/,
    );
  });
});

describe('user-console.html — formatIntegrationDate (OI-USR-403)', () => {
  const src = read();

  it('parses ISO timestamps into YYYY-MM-DD (compact, aligns columns)', () => {
    expect(src).toMatch(
      /function formatIntegrationDate\([\s\S]{0,200}?d\.toISOString\(\)\.slice\(0,\s*10\)/,
    );
  });

  it('falls back to the raw input on invalid dates (no "Invalid Date" in the UI)', () => {
    expect(src).toMatch(
      /function formatIntegrationDate[\s\S]{0,300}?Number\.isNaN\(d\.getTime\(\)\)\s*\)\s*return iso/,
    );
  });
});
