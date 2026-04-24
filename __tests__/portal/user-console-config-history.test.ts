// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Structural pins for the per-key config history drawer
 * (OI-DATA-003e, 2026-04-24).
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const HTML_PATH = path.resolve(__dirname, '../../src/portal/user-console.html');
const loadHtml = (): string => fs.readFileSync(HTML_PATH, 'utf-8');

describe('user-console.html — #configHistoryModal structure', () => {
  const html = loadHtml();

  it('shared modal is declared once with role=dialog + aria-label', () => {
    expect(html).toMatch(
      /<div id="configHistoryModal" class="kb-modal hidden" role="dialog" aria-label="Config change history">/,
    );
  });

  it('modal header has Close button wired to closeConfigHistory()', () => {
    expect(html).toMatch(
      /<button class="btn ghost small" onclick="closeConfigHistory\(\)">Close<\/button>/,
    );
  });

  it('modal body container has id=configHistoryBody with a default empty-state message', () => {
    expect(html).toMatch(/<div id="configHistoryBody"/);
    expect(html).toMatch(/Click a 🕐 next to any field to see its change history/);
  });

  it('footer advertises the audit-trail invariant (values are never shown)', () => {
    expect(html).toMatch(/values are never shown/i);
    expect(html).toMatch(/audit-trail invariant/i);
  });
});

describe('user-console.html — collectConfigFieldKeyMap', () => {
  const html = loadHtml();

  it('defined and calls all 5 *ConfigFieldIds helpers', () => {
    expect(html).toMatch(/function collectConfigFieldKeyMap\(\)/);
    for (const skill of ['content', 'secretary', 'training', 'finance', 'cooking']) {
      expect(html).toMatch(new RegExp(`add\\(\\s*['"]${skill}['"],\\s*${skill}ConfigFieldIds\\(\\)\\)`));
    }
  });
});

describe('user-console.html — attachHistoryButtonsToConfigFields (boot injection)', () => {
  const html = loadHtml();

  it('defined + idempotent via .field-history-btn existence check', () => {
    expect(html).toMatch(/function attachHistoryButtonsToConfigFields\(\)/);
    expect(html).toMatch(
      /attachHistoryButtonsToConfigFields[\s\S]*?label\.querySelector\(['"]\.field-history-btn['"]\)/,
    );
  });

  it('creates a button element with data-skill-id + data-config-key attributes', () => {
    // Data attributes on the injected button let tests + future
    // features query/annotate buttons without reaching into the
    // event-listener closures.
    expect(html).toMatch(/btn\.setAttribute\(['"]data-skill-id['"],\s*skillId\)/);
    expect(html).toMatch(/btn\.setAttribute\(['"]data-config-key['"],\s*key\)/);
  });

  it('button onclick opens the history modal with (skillId, key)', () => {
    expect(html).toMatch(
      /btn\.addEventListener\(['"]click['"],\s*\(e\)\s*=>\s*\{[\s\S]*?openConfigHistory\(skillId,\s*key\)/,
    );
  });

  it('boot-time hook runs inside a setTimeout so DOM is stable', () => {
    // Matches the pattern used by skill-picker init + tag-ac init.
    expect(html).toMatch(/setTimeout\(attachHistoryButtonsToConfigFields,\s*0\)/);
  });
});

describe('user-console.html — openConfigHistory / closeConfigHistory', () => {
  const html = loadHtml();

  it('both functions defined + exposed on window', () => {
    expect(html).toMatch(/async function openConfigHistory\(skillId,\s*key\)/);
    expect(html).toMatch(/function closeConfigHistory\(\)/);
    expect(html).toMatch(/window\.openConfigHistory\s*=\s*openConfigHistory/);
    expect(html).toMatch(/window\.closeConfigHistory\s*=\s*closeConfigHistory/);
  });

  it('fires GET to /workspace/skills/<skillId>/config/history with encoded params', () => {
    expect(html).toMatch(/\/workspace\/skills\/'\s*\+\s*encodeURIComponent\(skillId\)/);
    expect(html).toMatch(/\/config\/history\?key='\s*\+\s*encodeURIComponent\(key\)/);
    expect(html).toMatch(/&limit=20/);
  });

  it('shows empty-state when no entries returned', () => {
    expect(html).toMatch(/entries\.length === 0[\s\S]*?No changes recorded for this field yet/);
  });

  it('entry row shows actor + timestamp + "other keys touched" meta', () => {
    // Implementation uses string concatenation (no template literals),
    // so pin the concat shape: `'<strong>' + esc(actor) + '</strong>'`.
    expect(html).toMatch(/<strong>['"]\s*\+\s*esc\(actor\)\s*\+\s*['"]<\/strong>/);
    expect(html).toMatch(/small['"]>['"]\s*\+\s*esc\(e\.ts\)/);
    expect(html).toMatch(/Also touched:|Only this field was changed/);
  });

  it('actor falls back to "user #<id>" when email absent', () => {
    expect(html).toMatch(/const actor = e\.actorEmail \|\| \(\s*['"]user #['"]\s*\+\s*e\.actorUserId\s*\)/);
  });

  it('esc()-wraps every user-controlled interpolation (XSS defense)', () => {
    expect(html).toMatch(/openConfigHistory[\s\S]*?esc\(actor\)/);
    expect(html).toMatch(/openConfigHistory[\s\S]*?esc\(e\.ts\)/);
    expect(html).toMatch(/openConfigHistory[\s\S]*?other\.map\(esc\)/);
    expect(html).toMatch(/openConfigHistory[\s\S]*?esc\(\(e && e\.message\)\s*\|\|\s*['"]unknown error['"]\)/);
  });

  it('Escape key closes the modal when it is visible', () => {
    expect(html).toMatch(
      /e\.key === ['"]Escape['"][\s\S]*?configHistoryModal[\s\S]*?closeConfigHistory\(\)/,
    );
  });
});

describe('user-console.html — CSS', () => {
  const html = loadHtml();

  it('.field-history-btn uses low-opacity default + full-opacity hover (subtle affordance)', () => {
    expect(html).toMatch(/\.field-history-btn\s*\{[\s\S]*?opacity:\s*0\.6/);
    expect(html).toMatch(/\.field-history-btn:hover\s*\{\s*opacity:\s*1/);
  });

  it('.history-item has border-bottom except for the last child', () => {
    expect(html).toMatch(/\.history-item\s*\{[\s\S]*?border-bottom:\s*1px solid/);
    expect(html).toMatch(/\.history-item:last-child\s*\{\s*border-bottom:\s*0/);
  });

  it('.history-item-row uses flex + justify-between for actor | timestamp layout', () => {
    expect(html).toMatch(/\.history-item-row\s*\{[\s\S]*?display:\s*flex[\s\S]*?justify-content:\s*space-between/);
  });

  it('.history-item-loading + .history-item-empty are muted italic (matching skill-add-item-empty DNA)', () => {
    expect(html).toMatch(/\.history-item-loading,\s*\.history-item-empty\s*\{[\s\S]*?font-style:\s*italic/);
  });
});
