// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * OI-UX-001 (2026-04-24) — "Copy invite link" button.
 *
 * Admins who approve waitlist entries or create team invites need to
 * paste a full clickable URL into an email, not a raw invite code
 * that the recipient would have to copy, navigate to /invite/accept,
 * and paste themselves. This file pins the presence of the new
 * "Copy link" action across every surface that displays invite
 * codes:
 *
 *   - src/portal/portal.html       — admin waitlist approval view
 *                                    (new copyInviteLink helper +
 *                                    primary-action button on the
 *                                    approved-row action bar)
 *   - src/portal/workspace-ui.html — legacy tenant workspace demo
 *                                    (new "copy link" button +
 *                                    acceptUrl const)
 *   - src/portal/user-console.html — already had copyInvite +
 *                                    "Copy link" on the Team page
 *                                    (regression pin so a rename or
 *                                    refactor doesn't silently drop
 *                                    the primary-action behavior)
 *
 * The URL shape is pinned (/invite/accept?code=<encoded>) because
 * the landing page OI-NAV-203 reads the `code` query param. A URL
 * shape drift would silently break every invite email we've ever
 * sent; pinning the construction defends against that.
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const PORTAL_HTML = path.resolve(__dirname, '../../src/portal/portal.html');
const WORKSPACE_UI_HTML = path.resolve(__dirname, '../../src/portal/workspace-ui.html');
const USER_CONSOLE_HTML = path.resolve(__dirname, '../../src/portal/user-console.html');

function read(p: string): string { return fs.readFileSync(p, 'utf-8'); }

// ─── portal.html (admin waitlist approval view) ──────────────────

describe('portal.html — copyInviteLink helper (OI-UX-001)', () => {
  const src = read(PORTAL_HTML);

  it('defines window.copyInviteLink as an async function', () => {
    expect(src).toMatch(/window\.copyInviteLink\s*=\s*async\s+function/);
  });

  it('constructs the URL as location.origin + /invite/accept?code=<encoded>', () => {
    // Pinning both halves so a refactor that e.g. hard-codes
    // "https://nexushub.me/" (breaking the staging dev preview)
    // or drops encodeURIComponent (breaking codes with `+` / `/`)
    // trips immediately.
    expect(src).toMatch(
      /const url = location\.origin \+ ['"]\/invite\/accept\?code=['"]\s*\+\s*encodeURIComponent\(code\)/,
    );
  });

  it('writes the URL to the clipboard via navigator.clipboard.writeText', () => {
    expect(src).toMatch(
      /copyInviteLink[\s\S]{0,400}?await navigator\.clipboard\.writeText\(url\)/,
    );
  });

  it('shows a success toast on copy', () => {
    expect(src).toMatch(
      /copyInviteLink[\s\S]{0,500}?showToast\(['"]Copied invite link['"]/,
    );
  });

  it('has a prompt() fallback for insecure contexts (clipboard API rejects on http)', () => {
    // The Clipboard API requires https/localhost; on staging over
    // plain http the writeText() rejects. prompt() works everywhere
    // and the admin can select + copy manually.
    expect(src).toMatch(/copyInviteLink[\s\S]{0,700}?window\.prompt\(['"]Copy this invite link/);
  });

  it('approved-row actions include the new "Copy link" primary button', () => {
    // The button must be adjacent to the pre-existing "Copy code"
    // and "Mark emailed" buttons, and wired to copyInviteLink with
    // the invite code escaped. The onclick is assembled by string
    // concatenation in the row template — match the whole line.
    expect(src).toMatch(
      /onclick="copyInviteLink\(\\'['"]\s*\+\s*esc\(r\.invite_code\)\s*\+\s*['"]\\'\)">Copy link<\/button>/,
    );
  });

  it('"Copy code" secondary action survives — admins may still want the raw code', () => {
    // Regression guard: I didn't mean to remove copyInviteCode,
    // just add copyInviteLink alongside it. If a future refactor
    // drops the secondary action, reviewers should notice.
    expect(src).toMatch(
      /onclick="copyInviteCode\(\\'['"]\s*\+\s*esc\(r\.invite_code\)\s*\+\s*['"]\\'\)">Copy code<\/button>/,
    );
  });

  it('"Copy link" is the PRIMARY (btn-primary) action, "Copy code" is default-style', () => {
    // UX intent: the primary class draws the eye to the action the
    // admin almost always wants (sending a clickable URL).
    expect(src).toMatch(
      /<button class="btn btn-primary btn-xs" onclick="copyInviteLink/,
    );
  });
});

// ─── workspace-ui.html (legacy tenant workspace) ─────────────────

describe('workspace-ui.html — copy-link affordance (OI-UX-001)', () => {
  const src = read(WORKSPACE_UI_HTML);

  it('renderInviteRow constructs acceptUrl from inv.inviteCode via encodeURIComponent', () => {
    expect(src).toMatch(
      /const acceptUrl = location\.origin \+ ['"]\/invite\/accept\?code=['"]\s*\+\s*encodeURIComponent\(inv\.inviteCode\)/,
    );
  });

  it('inline row has a "copy link" button wired to acceptUrl', () => {
    expect(src).toMatch(
      /navigator\.clipboard\.writeText\(['"]\$\{escape\(acceptUrl\)\}['"]\)[\s\S]{0,200}?copy link/,
    );
  });

  it('inline row also keeps "copy code" for raw-code contexts', () => {
    // Regression guard — the legacy UI is rarely seen but we don't
    // want to silently remove an existing button.
    expect(src).toMatch(
      /navigator\.clipboard\.writeText\(['"]\$\{escape\(inv\.inviteCode\)\}['"]\)[\s\S]{0,200}?copy code/,
    );
  });

  it('copy feedback uses showBanner (matches legacy UI convention)', () => {
    // Other legacy-UI notifications use showBanner — the Copy-link
    // flow should match so users don't see a mix of styles.
    expect(src).toMatch(
      /showBanner\(['"]Invite link copied['"]\s*,\s*['"]success['"]\s*,\s*2000\)/,
    );
  });
});

// ─── user-console.html (already had copyInvite; regression pin) ──

describe('user-console.html — existing copyInvite survives (OI-UX-001 regression pin)', () => {
  const src = read(USER_CONSOLE_HTML);

  it('window.copyInvite is defined and constructs the accept URL', () => {
    expect(src).toMatch(
      /window\.copyInvite\s*=\s*function\(code\)[\s\S]{0,200}?const url = location\.origin \+ ['"]\/invite\/accept\?code=['"]\s*\+\s*encodeURIComponent\(code\)/,
    );
  });

  it('Team-page pending invites still have a "Copy link" button wired to copyInvite', () => {
    // The action column on pending invites must call copyInvite
    // with the invite code escaped — if someone refactors the
    // onclick binding away, tests fail loudly rather than at
    // runtime on a real invite flow.
    expect(src).toMatch(
      /onclick="copyInvite\(['"]\$\{esc\(i\.inviteCode \|\| i\.invite_code\)\}['"]\)">Copy link/,
    );
  });

  it('post-create banner shows the full URL + a Copy button that writes it', () => {
    // Extra belt-and-suspenders: when an admin first creates an
    // invite, the success banner includes the URL + a Copy
    // shortcut so they don't have to re-find the row.
    expect(src).toMatch(/const url = location\.origin \+ ['"]\/invite\/accept\?code=['"]\s*\+\s*encodeURIComponent\(code\)/);
    expect(src).toMatch(/navigator\.clipboard\.writeText\(['"]\$\{esc\(url\)\}['"]\)/);
  });
});
