// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Regression tests for the /invite/accept landing page (OI-NAV-203).
 *
 * The route is a static HTML server (no auth — the HTML does auth
 * itself against /workspace/my-invites/:code/accept). These tests
 * pin the shape of the served HTML so future edits can't regress:
 *
 *   - the page is served with anti-indexing + security headers,
 *   - it calls the canonical accept endpoint path,
 *   - it strips the ?code= query string from the URL on load
 *     (history.replaceState) — a privacy invariant,
 *   - it does not embed the raw code anywhere in the initial HTML
 *     (the code only arrives at runtime via location.search),
 *   - every documented error code from the accept endpoint has a
 *     corresponding branch in the client script.
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const HTML_PATH = path.resolve(__dirname, '../../src/portal/invite-accept.html');

function loadHtml(): string {
  return fs.readFileSync(HTML_PATH, 'utf-8');
}

describe('/invite/accept landing — HTML shape pins', () => {
  const html = loadHtml();

  it('sets anti-indexing meta so invite URLs are not crawlable', () => {
    expect(html).toMatch(/<meta\s+name="robots"\s+content="noindex,\s*nofollow"/i);
  });

  it('strips ?code= from the visible URL on load (history.replaceState)', () => {
    // The page reads `new URLSearchParams(location.search)` and then
    // calls `history.replaceState({}, '', clean)` to erase the query.
    // Regression pin: both calls must remain.
    expect(html).toContain('URLSearchParams(location.search)');
    expect(html).toMatch(/history\.replaceState\(\s*\{\s*\}\s*,\s*''\s*,\s*clean\s*\)/);
  });

  it('POSTs to the canonical /workspace/my-invites/:code/accept endpoint', () => {
    // Path must match the server-side route. Use a loose regex so
    // whitespace / template-literal formatting changes don't break
    // the pin.
    expect(html).toMatch(/['"`]\/workspace\/my-invites\/['"`]\s*\+\s*encodeURIComponent\(code\)\s*\+\s*['"`]\/accept['"`]/);
    // Must be a POST, must include Bearer auth.
    expect(html).toMatch(/method:\s*['"]POST['"]/);
    expect(html).toMatch(/Authorization['"`]?\s*:\s*['"`]Bearer\s*['"`]\s*\+\s*jwt/);
  });

  it('encodes the code via encodeURIComponent (defensive against special chars)', () => {
    expect(html).toContain('encodeURIComponent(code)');
  });

  it('does NOT hardcode any invite code in the initial markup', () => {
    // The code should only enter the page via URLSearchParams at
    // runtime. A regression where a dev pastes a test code into the
    // HTML would leak it on every page load.
    // Invite codes are 32-byte base64url → 43 chars of [A-Za-z0-9_-].
    // Pick a long enough match to avoid false positives on CSS / tokens.
    expect(html).not.toMatch(/['"`][A-Za-z0-9_-]{32,}['"`]/);
  });

  it('handles every documented server-error code with a bespoke branch', () => {
    // Contract of /workspace/my-invites/:code/accept (see
    // portal-workspace-router.ts accept handler) — every code below
    // must have a branch in the client-side error mapper.
    const requiredCodes = [
      'NOT_FOUND',
      'EMAIL_MISMATCH',
      'REVOKED',
      'EXPIRED',
      'ALREADY_ACCEPTED',
      'NETWORK',      // client-synthesized on fetch failure
    ];
    for (const code of requiredCodes) {
      expect(html).toContain(code);
    }
    // And a 401 branch that clears the stale JWT.
    expect(html).toMatch(/httpStatus\s*===\s*401/);
    expect(html).toMatch(/sessionStorage\.removeItem\(['"]nx\.usr\.jwt['"]\)/);
  });

  it('persists the newly-joined tenant as the active tenant on success', () => {
    // The User Console (user-console.html) reads nx.usr.tenantId on
    // boot and sends it as X-Tenant-Id. A freshly-accepted invite
    // should auto-land on the NEW tenant, not on the user's default.
    expect(html).toMatch(/sessionStorage\.setItem\(['"]nx\.usr\.tenantId['"]/);
  });

  it('redirects to /console on success (not /workspace-ui — the new console is the default)', () => {
    expect(html).toContain("location.href = '/console'");
  });

  it('shows a masked preview of the code — never the raw code in the UI', () => {
    // Preview format: first 3 + last 3, separated by an ellipsis.
    expect(html).toContain('c.slice(0, 3)');
    expect(html).toContain('c.slice(-3)');
  });

  it('shows five distinct UX views: no-code, need-auth, loading, success, error', () => {
    for (const v of ['view-no-code', 'view-need-auth', 'view-loading', 'view-success', 'view-error']) {
      expect(html).toContain(`id="${v}"`);
    }
  });
});

describe('/invite/accept route wiring', () => {
  it('is mounted in server.ts with anti-cache + clickjacking headers', () => {
    const serverPath = path.resolve(__dirname, '../../src/portal/server.ts');
    const src = fs.readFileSync(serverPath, 'utf-8');
    // The route uses the shared serveShell() helper which sets the
    // Cache-Control, X-Frame-Options, X-Content-Type-Options headers.
    expect(src).toMatch(/app\.get\(['"]\/invite\/accept['"]\s*,\s*serveShell\(['"]invite-accept\.html['"]\)\)/);
    // Pin the helper still sets those headers.
    expect(src).toMatch(/serveShell\s*=\s*\(filename:\s*string\)/);
    expect(src).toMatch(/Cache-Control['"]\s*,\s*['"]no-cache/);
    expect(src).toMatch(/X-Frame-Options['"]\s*,\s*['"]DENY/);
    expect(src).toMatch(/X-Content-Type-Options['"]\s*,\s*['"]nosniff/);
  });
});
