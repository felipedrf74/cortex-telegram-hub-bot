// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Structural pins for the onboarding wizard (OI-USR-404) added to
 * user-console.html on branch feature/nexus-hub-portal-uiux-admin-
 * user-console (2026-04-22).
 *
 * Pure HTML/JS introspection tests — no browser. They assert:
 *   - the wizard markup exists with the right ids and 3+1 steps,
 *   - the auto-open gate is conjunctive (admin + <100% + no dismiss),
 *   - "Skip" is session-scoped; "Don't show again" is persistent,
 *   - the Home Setup panel exposes a manual-launch button,
 *   - each step's action wires to the REAL endpoints (no stubs),
 *   - reference save pops to /workspace/books | links | content,
 *   - invite uses /workspace/invites and generates the canonical
 *     /invite/accept?code= URL that OI-NAV-203 now resolves.
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const HTML_PATH = path.resolve(__dirname, '../../src/portal/user-console.html');
function loadHtml(): string { return fs.readFileSync(HTML_PATH, 'utf-8'); }

describe('user-console.html — onboarding wizard markup (OI-USR-404)', () => {
  const html = loadHtml();

  it('wizard overlay + card are present with correct ids and ARIA', () => {
    expect(html).toContain('id="wizardOverlay"');
    expect(html).toContain('id="wizard"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-labelledby="wizardTitle"');
  });

  it('renders 3 step dots + connector bars in the progress indicator', () => {
    for (const n of [1, 2, 3]) {
      expect(html).toContain(`data-step-dot="${n}"`);
    }
    expect(html).toContain('data-step-bar="1-2"');
    expect(html).toContain('data-step-bar="2-3"');
  });

  it('has 4 step panels (3 interactive + 1 confirmation)', () => {
    for (const n of [1, 2, 3, 4]) {
      expect(html).toContain(`data-step="${n}"`);
    }
  });

  it('step 2 has all 3 reference-type tabs and matching forms', () => {
    for (const t of ['book', 'link', 'note']) {
      expect(html).toContain(`data-ref-type="${t}"`);
      expect(html).toContain(`data-ref-form="${t}"`);
    }
  });

  it('step 3 has both team-choice buttons (invite, solo)', () => {
    expect(html).toContain('data-choice="invite"');
    expect(html).toContain('data-choice="solo"');
    expect(html).toContain('id="wizInviteForm"');
  });

  it('footer exposes all 4 controls: dismiss, skip, prev, next', () => {
    for (const id of ['wizardDismissBtn', 'wizardSkipBtn', 'wizardPrevBtn', 'wizardNextBtn']) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('Home Setup panel has a manual "Launch wizard" button', () => {
    expect(html).toContain('id="launchWizardBtn"');
    expect(html).toMatch(/onclick="wizardOpen\(1\)"/);
  });
});

describe('user-console.html — onboarding wizard behavior pins', () => {
  const html = loadHtml();

  it('auto-open gate is conjunctive: admin AND <100% AND no-dismiss AND no-skip', () => {
    // All four early-return guards must exist in maybeAutoOpenWizard.
    expect(html).toMatch(/role\s*!==\s*['"]tenant_admin['"]/);
    expect(html).toMatch(/state\.home\.setup\.percent\s*>=\s*100/);
    expect(html).toContain("localStorage.getItem('nx.usr.onboarded-dismissed')");
    expect(html).toContain("sessionStorage.getItem('nx.usr.onboarded-skipped')");
  });

  it('loadHome triggers the auto-open check on every fresh payload', () => {
    // The call must live inside loadHome (not a one-shot boot).
    expect(html).toMatch(/paintHome\(r\.data\);[\s\S]*?maybeAutoOpenWizard\(\);/);
  });

  it('two-tier dismissal: "Skip" is session-scoped, "Don\'t show again" is persistent', () => {
    // Skip → sessionStorage.setItem
    expect(html).toMatch(/wizardSkip[\s\S]*?sessionStorage\.setItem\(['"]nx\.usr\.onboarded-skipped['"]/);
    // Dismiss forever → localStorage.setItem
    expect(html).toMatch(/wizardDismissForever[\s\S]*?localStorage\.setItem\(['"]nx\.usr\.onboarded-dismissed['"]/);
  });

  it('overlay click triggers wizardSkip (session-only), not wizardDismissForever', () => {
    // Clicking outside should NOT persistently dismiss — that would
    // punish accidental misclicks.
    expect(html).toMatch(/id="wizardOverlay"[^\n]*onclick="wizardSkip\(\)"/);
  });

  it('step 2 save-reference wires to the REAL workspace endpoints', () => {
    for (const p of ['/workspace/books', '/workspace/links', '/workspace/content']) {
      expect(html).toContain(`'${p}'`);
    }
    // POSTed with a JSON body, not GET.
    expect(html).toMatch(/wizardSaveReference[\s\S]*?method:\s*['"]POST['"]/);
  });

  it('step 2 allows advancing without saving if all forms are empty (non-coercive)', () => {
    // saveReference returns 'empty' when inputs are blank; wizardNext
    // then advances the step anyway.
    expect(html).toMatch(/return 'empty'/);
    expect(html).toMatch(/saved === 'error'/);
  });

  it('step 3 invite uses /workspace/invites and builds the OI-NAV-203 canonical URL', () => {
    expect(html).toMatch(/\/workspace\/invites['"]\s*,\s*\{\s*method:\s*['"]POST['"]/);
    expect(html).toContain("'/invite/accept?code='");
    expect(html).toContain('encodeURIComponent(code)');
  });

  it('step 3 "Solo" branch requires NO server call', () => {
    // wizardNext on step 3 with teamChoice === 'solo' should advance
    // to step 4 without calling wizardSendInvite. Pin: the invite
    // call is gated on `teamChoice === 'invite'` and `!inviteSent`.
    expect(html).toMatch(/wizard\.teamChoice === ['"]invite['"]\s*&&\s*!wizard\.inviteSent/);
  });

  it('finishing the wizard refreshes Home so new counts/milestones reflect', () => {
    // After step 3 → step 4 transition we must call loadHome() so the
    // new book / invite shows up in the Setup panel.
    expect(html).toMatch(/wizard\.step === 3[\s\S]*?loadHome\(\)/);
  });

  it('Next button label changes based on step + state (not static)', () => {
    // step 2, nothing saved → "Save & continue"
    // step 2, already saved → "Continue"
    // step 3, invite chosen + not sent → "Send invite & finish"
    // step 3, other → "Finish"
    expect(html).toContain('Save &amp; continue');
    expect(html).toContain('Send invite &amp; finish');
  });
});
