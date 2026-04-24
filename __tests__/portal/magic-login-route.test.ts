// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Structural pins for GET /magic-login (OI-WELCOME-201b, 2026-04-24).
 *
 * The handler spans several subsystems (magic-link service, user
 * service, JWT signing, HTML rendering) — we pin the WIRING here
 * and the actual end-to-end behavior is exercised in
 * welcome-email-service.test.ts via the token-issued-with-metadata
 * test.
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const SERVER_TS = path.resolve(__dirname, '../../src/portal/server.ts');
const loadSrc = (): string => fs.readFileSync(SERVER_TS, 'utf-8');

describe('server.ts — /magic-login handler structure (OI-WELCOME-201b)', () => {
  const src = loadSrc();

  it('registered as app.get("/magic-login") (not POST — clicked from email)', () => {
    expect(src).toMatch(/app\.get\(['"]\/magic-login['"]/);
  });

  it('lazy-requires the 3 services it composes (magic-link + user-service + jsonwebtoken)', () => {
    // Search the full source — the route handler block contains all three.
    expect(src).toMatch(/app\.get\(['"]\/magic-login['"][\s\S]*?consumeMagicLinkToken[\s\S]*?require\(['"]\.\.\/services\/magic-link-service['"]\)/);
    expect(src).toMatch(/app\.get\(['"]\/magic-login['"][\s\S]*?getUserById[\s\S]*?require\(['"]\.\.\/services\/user-service['"]\)/);
    expect(src).toMatch(/app\.get\(['"]\/magic-login['"][\s\S]*?jwtLib = require\(['"]jsonwebtoken['"]\)/);
  });

  it('renders error HTML (not JSON) when token is missing', () => {
    // Critical: users click this from email → they're in a browser;
    // a JSON body would render as a raw string in the browser tab.
    expect(src).toMatch(/if \(!rawToken\)\s*\{\s*renderMagicLoginError\(res,\s*400/);
  });

  it('maps consume reasons to error pages (not_found 410 / expired 410 / already_consumed 410)', () => {
    expect(src).toMatch(/not_found:\s*\{\s*title:\s*['"]Login link not recognised['"]/);
    expect(src).toMatch(/expired:\s*\{\s*title:\s*['"]Login link expired['"]/);
    expect(src).toMatch(/already_consumed:\s*\{\s*title:\s*['"]Login link already used['"]/);
  });

  it('defense-in-depth: rejects tokens with intent != passwordless_login', () => {
    // If someone re-uses an invite_signup token on /magic-login,
    // we should refuse rather than cross the wires between flows.
    expect(src).toMatch(
      /tokenRow\.intent !== ['"]passwordless_login['"][\s\S]*?renderMagicLoginError\(res,\s*400/,
    );
  });

  it('requires welcomeUserId in token metadata (defends against hand-crafted tokens)', () => {
    expect(src).toMatch(/welcomeUserId = typeof tokenRow\.metadata\?\.welcomeUserId === ['"]number['"]/);
    expect(src).toMatch(
      /welcomeUserId === null[\s\S]*?renderMagicLoginError[\s\S]*?500/,
    );
  });

  it('verifies the resolved user still exists (not deleted since token issuance)', () => {
    expect(src).toMatch(/const user = getUserById\(welcomeUserId\)/);
    expect(src).toMatch(
      /if \(!user\)[\s\S]*?renderMagicLoginError\(res,\s*404/,
    );
  });

  it('verifies token.email matches user.email (case-insensitive)', () => {
    expect(src).toMatch(
      /user\.email && tokenRow\.email\.toLowerCase\(\) !== user\.email\.toLowerCase\(\)/,
    );
  });

  it('mints JWT with deviceId=web-magic-login-<hex> (distinguishable from iOS + invite-signup)', () => {
    expect(src).toMatch(/deviceId = ['"]web-magic-login-['"]\s*\+\s*crypto\.randomBytes\(16\)\.toString\(['"]hex['"]\)/);
  });

  it('uses 7-day JWT expiry (matches iOS + invite-signup tokens)', () => {
    expect(src).toMatch(/jwtLib\.sign\(\s*\{\s*userId:\s*user\.id,\s*deviceId\s*\},\s*secret,\s*\{\s*expiresIn:\s*['"]7d['"]\s*\}\)/);
  });

  it('retrofits consumed_by on the magic-link row with the real user id', () => {
    // Best-effort audit continuity — same pattern as /invite/signup/consume.
    expect(src).toMatch(
      /UPDATE magic_link_tokens SET consumed_by = \? WHERE id = \?/,
    );
  });

  it('503 AUTH_UNCONFIGURED when IOS_API_JWT_SECRET is missing', () => {
    expect(src).toMatch(/!secret[\s\S]*?503[\s\S]*?Server misconfigured/);
  });

  it('success response is HTML with Cache-Control: no-store (never cached)', () => {
    expect(src).toMatch(/\/magic-login[\s\S]*?res\.set\(['"]Cache-Control['"],\s*['"]no-store['"]\)/);
    expect(src).toMatch(/\/magic-login[\s\S]*?res\.type\(['"]html['"]\)\.send\(renderMagicLoginHandoff/);
  });
});

describe('server.ts — renderMagicLoginHandoff (OI-WELCOME-201b)', () => {
  const src = loadSrc();

  it('defined at module scope (not inside the route handler)', () => {
    // Module-scope means the function is easy to unit-test AND
    // isn't re-created on every request.
    expect(src).toMatch(/^function renderMagicLoginHandoff\(jwtToken: string, tenantId: string\): string/m);
  });

  it('handoff page writes JWT + tenantId to sessionStorage', () => {
    expect(src).toMatch(/sessionStorage\.setItem\(['"]nx\.usr\.jwt['"],\s*\$\{JSON\.stringify\(jwtToken\)\}\)/);
    expect(src).toMatch(/sessionStorage\.setItem\(['"]nx\.usr\.tenantId['"],\s*\$\{JSON\.stringify\(tenantId\)\}\)/);
  });

  it('redirects to /console via window.location.replace (not pushState — user goes IN not back)', () => {
    expect(src).toMatch(/window\.location\.replace\(['"]\/console['"]\)/);
  });

  it('has <meta name="robots" content="noindex"> (don\'t index session handoff pages)', () => {
    expect(src).toMatch(/renderMagicLoginHandoff[\s\S]*?<meta name="robots" content="noindex">/);
  });

  it('JSON.stringify wraps the inlined JWT (XSS-safe under escape rules)', () => {
    // JSON.stringify on a string produces a valid JS string literal
    // with quotes — no risk of breaking out of the script context
    // via embedded quotes or newlines.
    expect(src).toMatch(/JSON\.stringify\(jwtToken\)/);
  });

  it('JWT is sanitized to URL-safe charset before inlining (defense in depth)', () => {
    // Even though JSON.stringify is safe, we strip any char not in
    // the JWT charset as a belt-and-suspenders measure. jsonwebtoken
    // produces base64url + dots; nothing else should ever appear.
    expect(src).toMatch(/safeJwt = String\(jwtToken\)\.replace\(\/\[\^A-Za-z0-9\._\\-=\]\/g,\s*['"]['"]\)/);
  });
});

describe('server.ts — renderMagicLoginError (OI-WELCOME-201b)', () => {
  const src = loadSrc();

  it('defined at module scope', () => {
    expect(src).toMatch(
      /^function renderMagicLoginError\(res: Response, status: number, title: string, body: string\): void/m,
    );
  });

  it('escapes title + body for XSS defense (template renders user-controlled error copy)', () => {
    expect(src).toMatch(
      /renderMagicLoginError[\s\S]*?const escapeHtml/,
    );
  });

  it('always sets Cache-Control: no-store (error pages with state-referring copy must not be cached)', () => {
    expect(src).toMatch(/renderMagicLoginError[\s\S]*?Cache-Control['"],\s*['"]no-store/);
  });
});
