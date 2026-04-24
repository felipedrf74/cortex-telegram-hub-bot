// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * OI-SEC-001a (2026-04-24) — structural pins for the two new
 * admin magic-link routes in src/portal/server.ts and the
 * admin-console sign-in UI.
 *
 * These are STRUCTURAL pins (grepping the source) rather than
 * live HTTP tests because the handlers compose 5 services
 * (magic-link + mailer + admin-session + tenant-service + db).
 * The service-level round-trip is exercised in
 * __tests__/services/admin-magic-link-flow.test.ts; this file
 * pins the wiring so a future refactor can't silently drop the
 * intent check, the enumeration-oracle defense, or the handoff
 * redirect.
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const SERVER_TS = path.resolve(__dirname, '../../src/portal/server.ts');
const ADMIN_CONSOLE_HTML = path.resolve(__dirname, '../../src/portal/admin-console.html');

function read(p: string): string { return fs.readFileSync(p, 'utf-8'); }

// ═══════════════════════════════════════════════════════════════
// POST /admin/login/request
// ═══════════════════════════════════════════════════════════════

describe('server.ts — POST /admin/login/request (OI-SEC-001a)', () => {
  const src = read(SERVER_TS);

  it('is registered as app.post("/admin/login/request")', () => {
    expect(src).toMatch(/app\.post\(\s*['"]\/admin\/login\/request['"]/);
  });

  it('mounts ownerRateLimitMiddleware before any DB work (protects enumeration)', () => {
    // The middleware chain must run rate-limit FIRST; otherwise a
    // leaked portal token could be used to fire thousands of
    // /admin/login/request calls to harvest timing/response
    // signals.
    expect(src).toMatch(
      /app\.post\(\s*['"]\/admin\/login\/request['"][\s\S]*?ownerRateLimitMiddleware/,
    );
  });

  it('returns a GENERIC response regardless of whether the email is a platform admin', () => {
    // The whole point of OI-SEC-001a's anti-enumeration design —
    // the response body must not reveal admin-list membership.
    expect(src).toMatch(
      /const GENERIC_RESPONSE = \{\s*ok: true,\s*message:\s*['"]If that email is registered as a platform admin/,
    );
  });

  it('validates email shape but fails silently (no validator oracle either)', () => {
    // A 400 "invalid email" response for malformed input vs 200
    // for valid-but-non-admin would still be an oracle. So invalid
    // email → same GENERIC_RESPONSE.
    expect(src).toMatch(
      /looksLikeEmail = \/\^\[\^\\s@\]\+@\[\^\\s@\]\+\\\.\[\^\\s@\]\+\$\/\.test\(rawEmail\)/,
    );
    expect(src).toMatch(/!looksLikeEmail[\s\S]{0,100}?res\.json\(GENERIC_RESPONSE\)/);
  });

  it('resolves user by lowercase email (case-insensitive lookup)', () => {
    // Normalises to lowercase before the SQL WHERE, matching how
    // waitlist + invite flows treat emails.
    expect(src).toMatch(/SELECT id, first_name, status FROM users WHERE lower\(email\)/);
  });

  it('only issues a token when user is active AND has a platform_admins row', () => {
    expect(src).toMatch(/if \(!user \|\| user\.status !== ['"]active['"]\)/);
    expect(src).toMatch(/if \(!role\)[\s\S]{0,200}?res\.json\(GENERIC_RESPONSE\)/);
  });

  it('issues the magic link with intent=admin_session and 15-min TTL', () => {
    expect(src).toMatch(
      /issueMagicLinkToken\(\{\s*email,\s*intent:\s*['"]admin_session['"],\s*ttlSeconds:\s*TTL_SECONDS/,
    );
    expect(src).toMatch(/const TTL_SECONDS = 15 \* 60/);
  });

  it('embeds adminUserId in magic-link metadata (consume handler needs it)', () => {
    expect(src).toMatch(/metadata:\s*\{\s*adminUserId:\s*user\.id\s*\}/);
  });

  it('constructs consoleUrl from PORTAL_PUBLIC_URL + /admin/magic-login?token=', () => {
    expect(src).toMatch(
      /process\.env\.PORTAL_PUBLIC_URL[\s\S]{0,200}?\/admin\/magic-login\?token=['"]\s*\+\s*encodeURIComponent\(issueResult\.rawToken\)/,
    );
  });

  it('sends the email via sendTransactionalEmail with template=admin.magic_login', () => {
    expect(src).toMatch(
      /sendTransactionalEmail\(\{\s*template:\s*['"]admin\.magic_login['"]/,
    );
  });

  it('mailer failure is caught + logged but still returns GENERIC_RESPONSE (no mailer oracle)', () => {
    // A broken mailer mustn't leak "yes I tried to send you one"
    // vs "I didn't try" — both paths return GENERIC_RESPONSE.
    expect(src).toMatch(/sendTransactionalEmail[\s\S]{0,1500}?catch \(mailErr\)[\s\S]{0,200}?logger\.error/);
  });

  it('outer try/catch also returns GENERIC_RESPONSE (never surfaces stack traces)', () => {
    expect(src).toMatch(/admin login request failed[\s\S]{0,200}?res\.json\(GENERIC_RESPONSE\)/);
  });
});

// ═══════════════════════════════════════════════════════════════
// GET /admin/magic-login
// ═══════════════════════════════════════════════════════════════

describe('server.ts — GET /admin/magic-login (OI-SEC-001a)', () => {
  const src = read(SERVER_TS);

  it('is registered as app.get("/admin/magic-login")', () => {
    expect(src).toMatch(/app\.get\(\s*['"]\/admin\/magic-login['"]/);
  });

  it('consumes the magic-link token atomically (single-use)', () => {
    expect(src).toMatch(/consumeMagicLinkToken\(rawToken, null\)/);
  });

  it('renders HTML error (not JSON) when token is missing — this is a click target', () => {
    // Users clicking from email land in a browser; a JSON response
    // renders as raw text in the tab. Must be HTML via
    // renderMagicLoginError.
    expect(src).toMatch(
      /if \(!rawToken\)[\s\S]{0,400}?renderMagicLoginError\(res,\s*400/,
    );
  });

  it('maps consume reasons to 410 error pages (not_found / expired / already_consumed)', () => {
    expect(src).toMatch(/not_found:\s*\{\s*title:\s*['"]Admin link not recognised['"]/);
    expect(src).toMatch(/expired:\s*\{\s*title:\s*['"]Admin link expired['"]/);
    expect(src).toMatch(/already_consumed:\s*\{\s*title:\s*['"]Admin link already used['"]/);
  });

  it('REJECTS tokens whose intent is not admin_session (defense in depth)', () => {
    // A passwordless_login token reused on /admin/magic-login
    // must be rejected — otherwise a user with their own email
    // magic-link could attempt to bootstrap into admin.
    expect(src).toMatch(
      /tokenRow\.intent !== ['"]admin_session['"][\s\S]{0,300}?renderMagicLoginError\(res,\s*400/,
    );
  });

  it('requires adminUserId in token metadata (defends against hand-crafted tokens)', () => {
    expect(src).toMatch(/adminUserId = typeof tokenRow\.metadata\?\.adminUserId === ['"]number['"]/);
    expect(src).toMatch(/adminUserId === null[\s\S]{0,200}?renderMagicLoginError/);
  });

  it('re-checks platform_admins membership at consume time (revocation takes effect immediately)', () => {
    // Critical: a token issued when the user was an admin, then
    // the admin was revoked BEFORE the link is clicked, must NOT
    // log them back in. Server re-queries getPlatformRole.
    expect(src).toMatch(/role = getPlatformRole\(adminUserId\)/);
    expect(src).toMatch(/if \(!role\)[\s\S]{0,400}?renderMagicLoginError\(res,\s*403/);
  });

  it('503 when PORTAL_ADMIN_JWT_SECRET is not configured', () => {
    expect(src).toMatch(/!getAdminSessionSecret\(\)[\s\S]{0,300}?renderMagicLoginError\(res,\s*503/);
  });

  it('mints the admin session JWT with a 24h expiry', () => {
    expect(src).toMatch(/mintAdminSession\(adminUserId, role, \{\s*expiresIn:\s*['"]24h['"]/);
  });

  it('retrofits consumed_by with the admin userId (audit continuity)', () => {
    expect(src).toMatch(/UPDATE magic_link_tokens SET consumed_by = \? WHERE id = \?/);
  });

  it('success response is HTML with Cache-Control: no-store', () => {
    expect(src).toMatch(/\/admin\/magic-login[\s\S]{0,3500}?Cache-Control['"],\s*['"]no-store['"]/);
    expect(src).toMatch(/\/admin\/magic-login[\s\S]{0,3500}?renderAdminMagicLoginHandoff/);
  });
});

// ═══════════════════════════════════════════════════════════════
// renderAdminMagicLoginHandoff
// ═══════════════════════════════════════════════════════════════

describe('server.ts — renderAdminMagicLoginHandoff (OI-SEC-001a)', () => {
  const src = read(SERVER_TS);

  it('defined at module scope (not inside the route handler)', () => {
    expect(src).toMatch(/^function renderAdminMagicLoginHandoff\(jwtToken: string\): string/m);
  });

  it('handoff writes the JWT to sessionStorage key nx.adm.session', () => {
    // nx.adm.session is the admin-console's session-token key
    // (see admin-console.html). Writing a JWT here means the
    // next page render picks it up as the authenticated session.
    expect(src).toMatch(
      /sessionStorage\.setItem\(['"]nx\.adm\.session['"],\s*\$\{JSON\.stringify\(jwtToken\)\}\)/,
    );
  });

  it('does NOT write to nx.usr.jwt (user-session key; would cross-contaminate flows)', () => {
    // Regression guard: if someone copy-pastes from the user
    // magic-login handoff and forgets to change the key, an
    // admin login would stash credentials under the user key
    // and leave the admin console still showing the sign-in
    // screen.
    const adminHandoff = src.match(/function renderAdminMagicLoginHandoff[\s\S]*?^}/m);
    expect(adminHandoff).not.toBeNull();
    expect(adminHandoff![0]).not.toContain('nx.usr.jwt');
    expect(adminHandoff![0]).not.toContain('nx.usr.tenantId');
  });

  it('redirects to /admin via window.location.replace (not pushState)', () => {
    expect(src).toMatch(
      /renderAdminMagicLoginHandoff[\s\S]{0,2000}?window\.location\.replace\(['"]\/admin['"]\)/,
    );
  });

  it('has <meta name="robots" content="noindex"> (don\'t index session handoffs)', () => {
    expect(src).toMatch(/renderAdminMagicLoginHandoff[\s\S]{0,2000}?<meta name="robots" content="noindex">/);
  });
});

// ═══════════════════════════════════════════════════════════════
// admin-console.html sign-in UI
// ═══════════════════════════════════════════════════════════════

describe('admin-console.html — magic-link sign-in UI (OI-SEC-001a)', () => {
  const src = read(ADMIN_CONSOLE_HTML);

  it('includes an email input (#authEmail) + submit button (#authEmailSubmit)', () => {
    expect(src).toMatch(/id="authEmail"[\s\S]{0,200}?type="email"/);
    expect(src).toMatch(/id="authEmailSubmit"/);
  });

  it('messaging explains the 15-minute TTL + single-use semantics', () => {
    expect(src).toMatch(/15 minutes/);
    expect(src).toMatch(/single-use/);
  });

  it('POSTs to /admin/login/request with {email}', () => {
    expect(src).toMatch(
      /fetch\(['"]\/admin\/login\/request['"],[\s\S]{0,400}?JSON\.stringify\(\{\s*email\s*\}\)/,
    );
  });

  it('always renders a generic message regardless of response content', () => {
    // Matches the server-side anti-enumeration contract.
    expect(src).toMatch(
      /If that email is registered as a platform admin, a sign-in link has been sent/,
    );
  });

  it('disables + re-enables the submit button across the request lifecycle', () => {
    expect(src).toMatch(/authEmailSubmit[\s\S]{0,1500}?btn\.disabled = true[\s\S]{0,1500}?btn\.disabled = false/);
  });

  it('legacy token-paste form survives inside a <details> (regression guard)', () => {
    // OI-SEC-001 shipped a token-paste input. We moved it under
    // a <details> but didn't delete it. If a future refactor
    // does drop it, admins with CLI-minted tokens lose their
    // sign-in path — make it loud.
    expect(src).toMatch(/<details[\s\S]{0,500}?Already have a session token/);
    expect(src).toMatch(/id="authSession"/);
    expect(src).toMatch(/id="authSubmit"/);
  });
});
