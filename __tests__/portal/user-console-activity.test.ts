// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Structural pins for the Activity page in user-console.html
 * (OI-DATA-005, branch feature/nexus-hub-portal-uiux-admin-user-console,
 * 2026-04-22).
 *
 * Pure HTML/JS introspection — no browser. Asserts:
 *   - the empty-state is replaced with a real filter form + table,
 *   - Activity is lazy-loaded by showPage('activity'),
 *   - the client calls /workspace/activity,
 *   - DateTime-local inputs normalize T→space (SQLite-friendly),
 *   - pagination prev/next + filter meta are wired,
 *   - audit-row expand uses the shared audit-details pattern.
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const HTML_PATH = path.resolve(__dirname, '../../src/portal/user-console.html');
function loadHtml(): string { return fs.readFileSync(HTML_PATH, 'utf-8'); }

describe('user-console.html — Activity page markup (OI-DATA-005)', () => {
  const html = loadHtml();

  it('has filter inputs for actor / action / from / to', () => {
    for (const id of ['actFActor', 'actFAction', 'actFFrom', 'actFTo']) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('has an Apply button that calls activityApply()', () => {
    expect(html).toMatch(/onclick="activityApply\(\)"/);
  });

  it('has an activity table + pager + filter meta containers', () => {
    expect(html).toContain('id="activityTable"');
    expect(html).toContain('id="activityPager"');
    expect(html).toContain('id="actFilterMeta"');
    expect(html).toContain('id="actPagerMeta"');
  });

  it('NO empty-state link-out to legacy remains', () => {
    expect(html).not.toContain('Activity view in progress');
  });

  it('documents that create/update events are intentionally not audited today', () => {
    expect(html).toMatch(/CREATE \/ UPDATE events do not yet write audit rows/i);
  });
});

describe('user-console.html — Activity behavior pins', () => {
  const html = loadHtml();

  it("showPage('activity') lazy-loads the feed", () => {
    expect(html).toMatch(/id\s*===\s*['"]activity['"]\s*\)\s*loadActivity\(\)/);
  });

  it('loadActivity calls /workspace/activity (not /owner/audit)', () => {
    expect(html).toMatch(/fetchJson\(['"`]\/workspace\/activity\?['"`]\s*\+\s*buildActivityQuery\(\)\)/);
  });

  it('datetime-local inputs normalize T→space (SQLite-friendly)', () => {
    // Same invariant as Admin Console's audit viewer — the SQLite
    // server-side compare is deterministic when both sides are in
    // the 'YYYY-MM-DD HH:MM:SS' format.
    expect(html).toMatch(/f\.from\.replace\(['"]T['"],\s*['"] ['"]\)/);
    expect(html).toMatch(/f\.to\.replace\(['"]T['"],\s*['"] ['"]\)/);
  });

  it('pagination respects total / limit / offset (prev and next)', () => {
    expect(html).toContain('activityState.offset');
    expect(html).toContain('activityState.limit');
    expect(html).toContain('activityState.total');
    expect(html).toMatch(/activityPage\(-1\)/);
    expect(html).toMatch(/activityPage\(1\)/);
  });

  it('audit-row click expands to pre-formatted JSON details (and collapses on 2nd click)', () => {
    expect(html).toContain('attachActivityExpand');
    expect(html).toContain("classList.contains('audit-details')");
  });

  it('filter query built via URLSearchParams (not string concat)', () => {
    expect(html).toMatch(/buildActivityQuery[\s\S]*?new URLSearchParams\(\)/);
  });

  it('activityApply resets offset to 0 before re-loading', () => {
    expect(html).toMatch(/activityApply[\s\S]*?activityState\.offset = 0/);
  });

  it('renderActivityRow derives a human summary from details.title / .email / .targetUserId', () => {
    expect(html).toContain('d.title');
    expect(html).toContain('d.email');
    expect(html).toContain('d.targetUserId');
  });
});
