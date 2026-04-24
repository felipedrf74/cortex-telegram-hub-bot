// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Structural pins for the cold-invitee views added to
 * invite-accept.html (OI-NAV-203a, 2026-04-24).
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const HTML = path.resolve(__dirname, '../../src/portal/invite-accept.html');
const loadHtml = (): string => fs.readFileSync(HTML, 'utf-8');

describe('invite-accept.html — cold-invitee views (OI-NAV-203a)', () => {
  const html = loadHtml();

  it('renders a cold-signup view for invitees without an existing Nexus Hub account', () => {
    expect(html).toMatch(/<div class="card hidden" id="view-cold-signup">/);
    expect(html).toMatch(/id="coldSignupTenant"/);
    expect(html).toMatch(/id="coldSignupEmail"/);
    expect(html).toMatch(/id="coldJwtInput"/);
    expect(html).toMatch(/id="coldSignInBtn"/);
    // OI-NAV-203c replaced the App Store guidance with an "Email me
    // a link" primary CTA — iOS token paste remains as a secondary
    // affordance below the divider.
    expect(html).toMatch(/id="requestMagicLinkBtn"/);
  });

  it('renders a sign-in-prompt view for invitees whose email DOES have an account', () => {
    expect(html).toMatch(/<div class="card hidden" id="view-sign-in-prompt">/);
    expect(html).toMatch(/id="signInEmail"/);
    expect(html).toMatch(/id="signInTenant"/);
    expect(html).toMatch(/id="signInJwtInput"/);
    expect(html).toMatch(/id="signInContinueBtn"/);
  });

  it('show() switches include the new cold-signup + sign-in-prompt views', () => {
    expect(html).toMatch(/function show\(viewId\)[\s\S]*?'cold-signup',\s*'sign-in-prompt'/);
  });
});

describe('invite-accept.html — inspectInvite pre-check (OI-NAV-203a)', () => {
  const html = loadHtml();

  it('defines inspectInvite async fn that calls /invite/inspect/<code>', () => {
    expect(html).toMatch(/async function inspectInvite\(c\)/);
    expect(html).toMatch(/\/invite\/inspect\/['"]\s*\+\s*encodeURIComponent\(c\)/);
  });

  it('handles network errors by returning { valid: false, reason: "network_error" }', () => {
    expect(html).toMatch(/inspectInvite[\s\S]*?valid:\s*false,\s*reason:\s*['"]network_error['"]/);
  });

  it('bootColdOrWarmPath routes to cold-signup when info.hasAccount === false', () => {
    expect(html).toMatch(
      /bootColdOrWarmPath[\s\S]*?info\.hasAccount === true[\s\S]*?show\(['"]sign-in-prompt['"]\)/,
    );
    expect(html).toMatch(/bootColdOrWarmPath[\s\S]*?show\(['"]cold-signup['"]\)/);
  });

  it('bootColdOrWarmPath shows expired / revoked / already_accepted error views from inspect status', () => {
    expect(html).toMatch(/info\.isExpired[\s\S]*?renderExpiredOrStale\(['"]expired['"]\)/);
    expect(html).toMatch(/info\.status === ['"]revoked['"][\s\S]*?renderExpiredOrStale\(['"]revoked['"]\)/);
    expect(html).toMatch(/info\.status === ['"]accepted['"][\s\S]*?renderExpiredOrStale\(['"]already_accepted['"]\)/);
  });

  it('boot only calls bootColdOrWarmPath when we have a code AND no cached JWT', () => {
    // The warm path (existing JWT in sessionStorage) skips inspect
    // entirely and goes straight to acceptInvite — probing would
    // leak an unnecessary round-trip for users already signed in.
    expect(html).toMatch(/if \(!code\)\s*\{\s*show\(['"]no-code['"]\);[\s\S]*?\}\s*else if \(!jwt\)\s*\{\s*\/\/ Cold path[\s\S]*?bootColdOrWarmPath\(\)/);
  });
});

describe('invite-accept.html — cold continue buttons (OI-NAV-203a)', () => {
  const html = loadHtml();

  it('coldSignInBtn saves pasted JWT + fires existing acceptInvite flow', () => {
    expect(html).toMatch(
      /coldSignInBtn['"]\)\.addEventListener\(['"]click['"][\s\S]*?sessionStorage\.setItem\(['"]nx\.usr\.jwt['"],\s*jwt\)[\s\S]*?acceptInvite\(\)/,
    );
  });

  it('signInContinueBtn saves pasted JWT + fires existing acceptInvite flow', () => {
    expect(html).toMatch(
      /signInContinueBtn['"]\)\.addEventListener\(['"]click['"][\s\S]*?sessionStorage\.setItem\(['"]nx\.usr\.jwt['"],\s*jwt\)[\s\S]*?acceptInvite\(\)/,
    );
  });
});

describe('invite-accept.html — regression: warm path still intact (OI-NAV-203a)', () => {
  const html = loadHtml();

  it('original view-need-auth still exists for warm-path users', () => {
    expect(html).toMatch(/<div class="card hidden" id="view-need-auth">/);
    expect(html).toMatch(/id="jwtInput"/);
    expect(html).toMatch(/id="signInBtn">Continue</);
  });

  it('acceptInvite still POSTs to /workspace/my-invites/<code>/accept', () => {
    expect(html).toMatch(/fetch\(['"]\/workspace\/my-invites\/['"]\s*\+\s*encodeURIComponent\(code\)\s*\+\s*['"]\/accept['"]/);
  });
});
