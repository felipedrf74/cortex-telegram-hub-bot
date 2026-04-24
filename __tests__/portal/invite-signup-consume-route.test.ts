// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Structural pins for POST /invite/signup/consume (OI-NAV-203c,
 * 2026-04-24). End-to-end behavior is exercised by the individual
 * service tests (magic-link-service, tenant-invite-service,
 * user-service); this file pins the handler's GLUE — step order,
 * error mapping, and security-relevant guards.
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const SERVER_TS = path.resolve(__dirname, '../../src/portal/server.ts');
const loadSrc = (): string => fs.readFileSync(SERVER_TS, 'utf-8');

describe('server.ts — /invite/signup/consume handler structure (OI-NAV-203c)', () => {
  const src = loadSrc();

  it('registered as app.post with express.json body parser', () => {
    expect(src).toMatch(
      /app\.post\(['"]\/invite\/signup\/consume['"],\s*express\.json\(\{\s*limit:\s*['"]16kb['"]\s*\}\),/,
    );
  });

  it('lazy-requires 4 services: magic-link + tenant-invite + user-service + jwt', () => {
    const handlerSection = src.match(/signup\/consume[\s\S]*?^\s*\}\);\s*$/m)?.[0] || '';
    expect(handlerSection).toMatch(/consumeMagicLinkToken.*require\(['"]\.\.\/services\/magic-link-service['"]\)/);
    expect(handlerSection).toMatch(/getInviteByCode,\s*acceptInvite[\s\S]*?require\(['"]\.\.\/services\/tenant-invite-service['"]\)/);
    expect(handlerSection).toMatch(/createPasswordlessEmailUser[\s\S]*?require\(['"]\.\.\/services\/user-service['"]\)/);
    expect(handlerSection).toMatch(/jwtLib = require\(['"]jsonwebtoken['"]\)/);
  });

  it('400 when code or magic is missing', () => {
    expect(src).toMatch(/signup\/consume[\s\S]*?if \(!code \|\| !magic\)[\s\S]*?BAD_REQUEST/);
  });

  it('maps consume reason to HTTP status: not_found→404 / expired→410 / already_consumed→409', () => {
    expect(src).toMatch(/signup\/consume[\s\S]*?not_found:\s*404[\s\S]*?expired:\s*410[\s\S]*?already_consumed:\s*409/);
  });

  it('consume error response code is prefixed with MAGIC_LINK_<REASON>', () => {
    expect(src).toMatch(/code:\s*`MAGIC_LINK_\$\{reason\.toUpperCase\(\)\}`/);
  });

  it('validates metadata.inviteCode matches body.code (prevents code-swap attack)', () => {
    expect(src).toMatch(
      /signup\/consume[\s\S]*?metaCode[\s\S]*?metaCode !== code[\s\S]*?MAGIC_LINK_CODE_MISMATCH/,
    );
  });

  it('validates token email matches invite email (defense-in-depth)', () => {
    expect(src).toMatch(
      /signup\/consume[\s\S]*?tokenRow\.email\.toLowerCase\(\) !== invite\.email\.toLowerCase\(\)[\s\S]*?MAGIC_LINK_EMAIL_MISMATCH/,
    );
  });

  it('creates user via createPasswordlessEmailUser ONLY when no existing user', () => {
    expect(src).toMatch(/signup\/consume[\s\S]*?let user = getUserByEmail\(invite\.email\)/);
    expect(src).toMatch(/signup\/consume[\s\S]*?if \(!user\)\s*\{\s*user = createPasswordlessEmailUser\(invite\.email\)/);
  });

  it('accepts the invite via the existing acceptInvite path (idempotent layer)', () => {
    expect(src).toMatch(
      /signup\/consume[\s\S]*?acceptInvite\(\{\s*code,\s*userId:\s*user\.id,\s*userEmail:\s*invite\.email\s*\}\)/,
    );
  });

  it('mints a web-session JWT with deviceId=web-session-<hex> (distinguishable from iOS)', () => {
    expect(src).toMatch(/deviceId = ['"]web-session-['"]\s*\+\s*crypto\.randomBytes\(16\)\.toString\(['"]hex['"]\)/);
  });

  it('JWT signed with config.ios.jwtSecret + 7-day expiry (matches iOS format)', () => {
    expect(src).toMatch(/jwtLib\.sign\(\{\s*userId:\s*user\.id,\s*deviceId\s*\},\s*secret,\s*\{\s*expiresIn:\s*['"]7d['"]\s*\}\)/);
  });

  it('returns 503 AUTH_UNCONFIGURED when IOS_API_JWT_SECRET is missing', () => {
    expect(src).toMatch(/signup\/consume[\s\S]*?!secret[\s\S]*?503[\s\S]*?AUTH_UNCONFIGURED/);
  });

  it('retrofits magic_link_tokens.consumed_by with the real user id (best-effort)', () => {
    expect(src).toMatch(
      /signup\/consume[\s\S]*?UPDATE magic_link_tokens SET consumed_by = \? WHERE id = \?[\s\S]*?\.run\(user\.id,\s*tokenRow\.id\)/,
    );
  });

  it('success response includes jwt + userId + tenantId + email + userCreated flag', () => {
    expect(src).toMatch(
      /signup\/consume[\s\S]*?userCreated:\s*created,\s*userId:\s*user\.id,\s*tenantId:\s*invite\.tenantId,\s*jwt:\s*jwtToken/,
    );
  });

  it('InviteError from acceptInvite is mapped to the error payload (duck-type on code)', () => {
    // Duck-typing on the `code` property lets the handler recognise
    // InviteError across dynamic-require module boundaries without
    // relying on `instanceof` which is fragile through require().
    expect(src).toMatch(/typeof ae\.code === ['"]string['"]/);
  });
});

describe('invite-accept.html — OI-NAV-203c UI integration', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../../src/portal/invite-accept.html'), 'utf-8');

  it('view-magic-sent rendered with "Check your inbox" copy + debug banner', () => {
    expect(html).toMatch(/<div class="card hidden" id="view-magic-sent">/);
    expect(html).toMatch(/Check your inbox/);
    expect(html).toMatch(/id="magicSentEmail"/);
    expect(html).toMatch(/id="magicSentDebug"/);
    expect(html).toMatch(/id="magicSentDebugLink"/);
  });

  it('view-magic-processing rendered with spinner + "Verifying your link…"', () => {
    expect(html).toMatch(/<div class="card hidden" id="view-magic-processing">/);
    expect(html).toMatch(/Verifying your link/);
    expect(html).toMatch(/<span class="spinner"><\/span>/);
  });

  it('Email me a link button exists in view-cold-signup + hint line', () => {
    expect(html).toMatch(/id="requestMagicLinkBtn"/);
    expect(html).toMatch(/Email me a link/);
    expect(html).toMatch(/id="magicLinkHint"/);
  });

  it('show() switches include magic-sent + magic-processing', () => {
    expect(html).toMatch(/function show\(viewId\)[\s\S]*?'magic-sent',\s*'magic-processing'/);
  });

  it('URL parsing captures magicFromUrl + strips it from the URL alongside code', () => {
    expect(html).toMatch(/let magicFromUrl = null/);
    expect(html).toMatch(/magicFromUrl = \(params\.get\(['"]magic['"]\)\s*\|\|\s*['"]['"]\)\.trim\(\)\s*\|\|\s*null/);
    expect(html).toMatch(/if \(code \|\| magicFromUrl\)\s*\{\s*const clean = location\.pathname;\s*history\.replaceState/);
  });

  it('boot routes to consumeMagicLink FIRST when code + magicFromUrl both present', () => {
    expect(html).toMatch(
      /if \(code && magicFromUrl\)\s*\{\s*consumeMagicLink\(magicFromUrl\)/,
    );
  });

  it('requestMagicLink POSTs to /invite/request-signup-link with { code }', () => {
    expect(html).toMatch(/requestMagicLink[\s\S]*?\/invite\/request-signup-link/);
    expect(html).toMatch(/requestMagicLink[\s\S]*?JSON\.stringify\(\{\s*code\s*\}\)/);
  });

  it('requestMagicLink surfaces a clear error message when mailer is unconfigured (503)', () => {
    expect(html).toMatch(/MAILER_UNCONFIGURED[\s\S]*?Email provider is not configured/);
  });

  it('requestMagicLink shows debugUrl in a dev-banner when present', () => {
    expect(html).toMatch(/requestMagicLink[\s\S]*?body\.data\.debugUrl[\s\S]*?debugBanner\.classList\.remove\(['"]hidden['"]\)/);
  });

  it('consumeMagicLink POSTs to /invite/signup/consume with { code, magic }', () => {
    expect(html).toMatch(/consumeMagicLink[\s\S]*?\/invite\/signup\/consume/);
    expect(html).toMatch(/consumeMagicLink[\s\S]*?JSON\.stringify\(\{\s*code,\s*magic\s*\}\)/);
  });

  it('consumeMagicLink stores JWT + tenantId in sessionStorage on success', () => {
    expect(html).toMatch(/consumeMagicLink[\s\S]*?sessionStorage\.setItem\(['"]nx\.usr\.jwt['"],\s*jwt\)/);
    expect(html).toMatch(/consumeMagicLink[\s\S]*?sessionStorage\.setItem\(['"]nx\.usr\.tenantId['"],\s*String\(body\.data\.tenantId\)\)/);
  });

  it('consumeMagicLink failure routes to view-error with the server error code', () => {
    expect(html).toMatch(
      /consumeMagicLink[\s\S]*?codeEl\.textContent = errCode[\s\S]*?show\(['"]error['"]\)/,
    );
  });
});
