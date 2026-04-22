// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Structural pins for the Profile editor in user-console.html
 * (OI-USR-407, branch feature/nexus-hub-portal-uiux-admin-user-console,
 * 2026-04-22).
 *
 * Pure HTML/JS introspection — no browser. Asserts:
 *   - 6 editable fields (firstName/lastName/username/avatarUrl/
 *     language/timezone) are wired to real IDs
 *   - email and tier stay READ-ONLY (no input with that id)
 *   - Save + Revert buttons present; dirty-state meta label
 *   - Browser detection helpers for language + timezone
 *   - Save is a PATCH to /workspace/profile
 *   - Empty-string → null conversion (so cleared fields properly
 *     NULL in the DB, not empty strings)
 *   - Diff-only payload (unchanged fields not sent)
 *   - Post-save re-baseline so Revert means "undo unsaved"
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const HTML_PATH = path.resolve(__dirname, '../../src/portal/user-console.html');
function loadHtml(): string { return fs.readFileSync(HTML_PATH, 'utf-8'); }

describe('user-console.html — Profile editor markup (OI-USR-407)', () => {
  const html = loadHtml();

  it('has 6 editable input fields with stable ids', () => {
    for (const id of ['profFirstName', 'profLastName', 'profUsername', 'profAvatarUrl', 'profLanguage', 'profTimezone']) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('Save + Revert buttons present with onclicks', () => {
    expect(html).toMatch(/id="profileSaveBtn"[^>]*onclick="profileSave\(\)"/);
    expect(html).toMatch(/id="profileResetBtn"[^>]*onclick="profileReset\(\)"/);
  });

  it('dirty-state meta label container present', () => {
    expect(html).toContain('id="profileDirtyMeta"');
  });

  it('Email + Tier rendered read-only (no inputs with those ids)', () => {
    // Read-only block is filled by JS; there should be no editable
    // <input id="profEmail"> or similar.
    expect(html).not.toMatch(/id="profEmail"/);
    expect(html).not.toMatch(/id="profTier"/);
    // And the identity panel carries a read-only disclosure.
    expect(html).toMatch(/Read-only/);
  });

  it('legacy "Profile edits live in the iOS app for now" copy is GONE', () => {
    expect(html).not.toContain('Profile edits live in the iOS app for now');
  });

  it('has Detect-from-browser buttons for language and timezone', () => {
    expect(html).toMatch(/onclick="profileDetectLanguage\(\)"/);
    expect(html).toMatch(/onclick="profileDetectTimezone\(\)"/);
  });
});

describe('user-console.html — Profile editor behavior pins', () => {
  const html = loadHtml();

  it("showPage('profile') calls loadProfile", () => {
    expect(html).toMatch(/id\s*===\s*['"]profile['"]\s*\)\s*loadProfile\(\)/);
  });

  it('Save wires to PATCH /workspace/profile', () => {
    // Method must be PATCH (not POST/PUT), path canonical.
    expect(html).toMatch(/profileSave[\s\S]*?['"`]\/workspace\/profile['"`][\s\S]*?method:\s*['"]PATCH['"]/);
  });

  it('diff-only payload: only changed fields are sent', () => {
    // The save function iterates fields and only adds to patch{}
    // when current !== baseline.
    expect(html).toMatch(/if \(curr !== \(profileBaseline\[field\] \|\| ''\)\)/);
  });

  it('empty string saves as null (so cleared fields NULL in DB)', () => {
    expect(html).toMatch(/curr === ''\s*\?\s*null\s*:\s*curr/);
  });

  it('post-save re-baselines so subsequent Revert means "undo unsaved"', () => {
    // After a successful PATCH we update profileBaseline to match
    // the new saved values.
    expect(html).toMatch(/profileBaseline\[field\]\s*=\s*el\.value/);
  });

  it('Revert restores every field from baseline (not page-load state)', () => {
    expect(html).toMatch(/profileReset[\s\S]*?el\.value\s*=\s*profileBaseline\[field\]/);
  });

  it('dirty-state toggle enables/disables Save button', () => {
    expect(html).toMatch(/saveEl\.disabled\s*=\s*!dirty/);
  });

  it('Detect-language uses navigator.language', () => {
    expect(html).toMatch(/profileDetectLanguage[\s\S]*?navigator\.language/);
  });

  it('Detect-timezone uses Intl.DateTimeFormat().resolvedOptions().timeZone', () => {
    expect(html).toMatch(/profileDetectTimezone[\s\S]*?Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone/);
  });

  it('Save triggers loadMe() to refresh the context strip after update', () => {
    // Without this, the "You are <Name>" header stays stale until
    // the next full reload.
    expect(html).toMatch(/profileSave[\s\S]*?await loadMe\(\)/);
  });

  it('input change triggers profileUpdateDirty listener', () => {
    // Listener is attached once per element (dataset.profBound guard).
    expect(html).toMatch(/el\.addEventListener\(['"]input['"]\s*,\s*profileUpdateDirty\)/);
    expect(html).toMatch(/el\.dataset\.profBound\s*=\s*'1'/);
  });
});
