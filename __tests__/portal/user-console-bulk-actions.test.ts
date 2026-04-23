// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Structural + behavior pins for bulk actions on reference tables
 * (OI-UX-103, 2026-04-23).
 *
 * The feature adds:
 *   - Per-kind selection Set<id> tracked in state.bulkSel
 *   - A context-sensitive toolbar (bulk delete / bulk add-skill)
 *     shown above each reference collection when ≥1 row is
 *     selected
 *   - Checkbox columns on all 4 reference renderers (books /
 *     channels / links / notes — notes uses a leading flex-inline
 *     "Select all" row since it's a div-list, not a table)
 *
 * The pins lock in the correctness contracts that keep bulk
 * operations safe in a dense multi-tenant UI:
 *
 *   1. Selection is per-kind Set, not global — no cross-kind leak.
 *   2. "Select all" acts on VISIBLE rows only (matches intent when
 *      a filter is active).
 *   3. Bulk delete confirms before firing + reports partial
 *      success ("Deleted 8 of 10; 2 failed").
 *   4. Bulk add-skill is idempotent (skip rows that already carry
 *      the skill) and preserves non-skill tags.
 *   5. Operations are sequential (not Promise.all) so rate limiter
 *      pressure stays predictable.
 *   6. Selection clears after every bulk action so a stale
 *      selection doesn't leak into the next batch.
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const HTML_PATH = path.resolve(__dirname, '../../src/portal/user-console.html');
const loadHtml = (): string => fs.readFileSync(HTML_PATH, 'utf-8');

const KINDS = ['book', 'link', 'note', 'channel'] as const;
const KIND_PATHS: Record<string, string> = {
  book: '/workspace/books/',
  link: '/workspace/links/',
  note: '/workspace/content/',
  channel: '/workspace/channels/',
};

describe('user-console.html — state.bulkSel declared per kind (OI-UX-103)', () => {
  const html = loadHtml();

  it('state.bulkSel declared with a Set per kind', () => {
    expect(html).toMatch(
      /bulkSel:\s*\{\s*book:\s*new Set\(\),\s*link:\s*new Set\(\),\s*note:\s*new Set\(\),\s*channel:\s*new Set\(\)\s*\}/,
    );
  });
});

describe('user-console.html — BULK_KINDS lookup (OI-UX-103)', () => {
  const html = loadHtml();

  it('declared with all 4 reference kinds', () => {
    expect(html).toMatch(/const BULK_KINDS\s*=\s*\{/);
    for (const kind of KINDS) {
      expect(html).toMatch(new RegExp(`${kind}:\\s*\\{[\\s\\S]*?path:\\s*['"]${KIND_PATHS[kind]}['"]`));
    }
  });

  it('each kind wires reload + render + findById', () => {
    for (const kind of KINDS) {
      // findById pulls from the right state array
      const arrName = kind === 'note' ? 'notes' : `${kind}s`;
      expect(html).toMatch(new RegExp(`${kind}:\\s*\\{[\\s\\S]*?findById:\\s*\\(id\\)\\s*=>\\s*state\\.${arrName}\\.find`));
      // reload calls loadX + loadHome (dep refresh)
      const loaderName = kind === 'note' ? 'loadNotes' : `load${kind.charAt(0).toUpperCase()}${kind.slice(1)}s`;
      expect(html).toMatch(new RegExp(`${kind}:[\\s\\S]*?${loaderName}\\(\\);\\s*loadHome\\(\\)`));
    }
  });
});

describe('user-console.html — selection toggles (OI-UX-103)', () => {
  const html = loadHtml();

  it('bulkToggle flips one id in the Set', () => {
    expect(html).toMatch(/function bulkToggle\(kind,\s*id\)/);
    expect(html).toMatch(/bulkToggle[\s\S]*?if \(s\.has\(id\)\) s\.delete\(id\); else s\.add\(id\)/);
  });

  it('bulkToggleAll acts on VISIBLE rows only, not global list', () => {
    // Key contract: "select all" must operate on the rows argument
    // so a filtered-out row is never included.
    expect(html).toMatch(/function bulkToggleAll\(kind,\s*ids\)/);
    expect(html).toMatch(/bulkToggleAll[\s\S]*?ids\.every\(\(id\)\s*=>\s*s\.has\(id\)\)/);
  });

  it('toggleAll treats "all-selected" as toggle-OFF (progressive affordance)', () => {
    expect(html).toMatch(
      /bulkToggleAll[\s\S]*?if \(allSelected\)\s*\{\s*ids\.forEach\(\(id\)\s*=>\s*s\.delete\(id\)\)/,
    );
  });

  it('bulkClear + bulkClearAndRender defined', () => {
    expect(html).toMatch(/function bulkClear\(kind\)[\s\S]*?state\.bulkSel\[kind\]\.clear\(\)/);
    expect(html).toMatch(/function bulkClearAndRender\(kind\)/);
  });

  it('toggles re-render the owning table (no stale checkbox state)', () => {
    expect(html).toMatch(/bulkToggle[\s\S]*?BULK_KINDS\[kind\]\.render\(\)/);
    expect(html).toMatch(/bulkToggleAll[\s\S]*?BULK_KINDS\[kind\]\.render\(\)/);
  });

  it('helpers exposed on window for inline onclick handlers', () => {
    for (const fn of ['bulkToggle', 'bulkToggleAll', 'bulkClearAndRender']) {
      expect(html).toMatch(new RegExp(`window\\.${fn}\\s*=\\s*${fn}`));
    }
  });
});

describe('user-console.html — bulkDelete (OI-UX-103)', () => {
  const html = loadHtml();

  it('defined as async + uses sequential for-of loop (not Promise.all)', () => {
    expect(html).toMatch(/async function bulkDelete\(kind\)/);
    // If Promise.all replaced the for-of, the rate-limiter pressure
    // guarantee changes. Pin the shape.
    expect(html).toMatch(/bulkDelete[\s\S]*?for \(const id of ids\)/);
    expect(html).not.toMatch(/bulkDelete[\s\S]*?Promise\.all/);
  });

  it('confirms before firing (destructive-action gate)', () => {
    expect(html).toMatch(/bulkDelete[\s\S]*?confirm\(`Delete \$\{ids\.length\}/);
  });

  it('reports partial-success ("Deleted N of M; E failed")', () => {
    // A partial-failure toast is much more actionable than "error".
    expect(html).toMatch(
      /bulkDelete[\s\S]*?toast\(`Deleted \$\{ok\} of \$\{ids\.length\};\s*\$\{errs\} failed`/,
    );
  });

  it('issues DELETE against BULK_KINDS[kind].path + id', () => {
    expect(html).toMatch(
      /bulkDelete[\s\S]*?fetchJson\(meta\.path\s*\+\s*id,\s*\{\s*method:\s*['"]DELETE['"]\s*\}\)/,
    );
  });

  it('clears selection + reloads after completing the batch', () => {
    expect(html).toMatch(/bulkDelete[\s\S]*?bulkClear\(kind\)/);
    expect(html).toMatch(/bulkDelete[\s\S]*?meta\.reload\(\)/);
  });
});

describe('user-console.html — bulkAddSkill (OI-UX-103)', () => {
  const html = loadHtml();

  it('defined as async + requires a skillId', () => {
    expect(html).toMatch(/async function bulkAddSkill\(kind,\s*skillId\)/);
    expect(html).toMatch(/bulkAddSkill[\s\S]*?if \(!skillId\)\s*return toast\(['"]Pick a skill first['"]/);
  });

  it('idempotent: skip rows that already carry the skill', () => {
    // The "skipped" counter + early continue lets us report
    // "Tagged 5 books (3 already had it)" — important UX so users
    // don't think Apply failed on some rows.
    expect(html).toMatch(/bulkAddSkill[\s\S]*?currentSkills\.includes\(skillId\)[\s\S]*?skipped\+\+;/);
  });

  it('preserves non-skill tags via stripSkillTags + mergeTagsWithSkills', () => {
    expect(html).toMatch(/bulkAddSkill[\s\S]*?stripSkillTags\(row\.tags\)/);
    expect(html).toMatch(/bulkAddSkill[\s\S]*?mergeTagsWithSkills\(nonSkill,\s*\[\.\.\.currentSkills,\s*skillId\]\)/);
  });

  it('sends PATCH with { tags: newTags } (rides existing reference routes)', () => {
    expect(html).toMatch(
      /bulkAddSkill[\s\S]*?method:\s*['"]PATCH['"][\s\S]*?JSON\.stringify\(\{\s*tags:\s*newTags\s*\}\)/,
    );
  });

  it('toast includes skill LABEL (not raw skillId) for humanised feedback', () => {
    expect(html).toMatch(
      /bulkAddSkill[\s\S]*?SKILLS_LIST\.find\(\(s\)\s*=>\s*s\.id === skillId\)/,
    );
    expect(html).toMatch(/Tagged \$\{changed\} \$\{kind\}/);
  });

  it('sequential for-of (not Promise.all)', () => {
    expect(html).toMatch(/bulkAddSkill[\s\S]*?for \(const id of ids\)/);
    expect(html).not.toMatch(/bulkAddSkill[\s\S]*?Promise\.all/);
  });

  it('clears selection + reloads after completing the batch', () => {
    expect(html).toMatch(/bulkAddSkill[\s\S]*?bulkClear\(kind\)/);
    expect(html).toMatch(/bulkAddSkill[\s\S]*?meta\.reload\(\)/);
  });
});

describe('user-console.html — renderBulkToolbar (OI-UX-103)', () => {
  const html = loadHtml();

  it('defined + returns empty string when nothing selected', () => {
    expect(html).toMatch(/function renderBulkToolbar\(kind\)/);
    // No toolbar at zero selected keeps the shell quiet by default.
    expect(html).toMatch(/renderBulkToolbar[\s\S]*?if \(n === 0\) return ['"]['"]/);
  });

  it('toolbar markup has count + skill-select + Apply + Delete + Clear', () => {
    expect(html).toMatch(/class="bulk-toolbar"/);
    expect(html).toMatch(/renderBulkToolbar[\s\S]*?bulk-count/);
    expect(html).toMatch(/renderBulkToolbar[\s\S]*?id="bulk-\$\{esc\(kind\)\}-skill"/);
    expect(html).toMatch(/renderBulkToolbar[\s\S]*?bulkAddSkill\(['"]\$\{esc\(kind\)\}['"]/);
    expect(html).toMatch(/renderBulkToolbar[\s\S]*?bulkDelete\(['"]\$\{esc\(kind\)\}['"]/);
    expect(html).toMatch(/renderBulkToolbar[\s\S]*?bulkClearAndRender\(['"]\$\{esc\(kind\)\}['"]/);
  });

  it('accessible: role="toolbar" + aria-label mentions the kind', () => {
    expect(html).toMatch(/renderBulkToolbar[\s\S]*?role="toolbar"\s+aria-label="Bulk actions for selected \$\{esc\(kind\)\}s"/);
  });

  it('esc()-wraps kind in every interpolation (XSS-guard even on fixed values)', () => {
    // SKILL_EDIT_KINDS-style defence: if a future caller passes an
    // unchecked kind, no escape-less interpolation leaks HTML.
    const hits = (html.match(/esc\(kind\)/g) || []).length;
    expect(hits).toBeGreaterThanOrEqual(6);
  });
});

describe('user-console.html — checkbox column wired into all 4 renderers (OI-UX-103)', () => {
  const html = loadHtml();

  it('Books table header has a bulk-check-col with "select all" checkbox', () => {
    expect(html).toMatch(
      /renderBooks[\s\S]*?<th class="bulk-check-col">[\s\S]*?bulkToggleAll\(['"]book['"],\s*\[\$\{visibleIds\.join\(['"],['"]\)\}\]\)/,
    );
  });

  it('Books body row has checkbox + row-selected class when selected', () => {
    expect(html).toMatch(/renderBooks[\s\S]*?bulkToggle\(['"]book['"],\s*\$\{b\.id\}\)/);
    expect(html).toMatch(/renderBooks[\s\S]*?state\.bulkSel\.book\.has\(b\.id\) \? ['"] class="row-selected"['"]/);
  });

  it('Links table header + rows wired (same shape as Books)', () => {
    expect(html).toMatch(/renderLinks[\s\S]*?bulkToggleAll\(['"]link['"]/);
    expect(html).toMatch(/renderLinks[\s\S]*?bulkToggle\(['"]link['"],\s*\$\{l\.id\}\)/);
    expect(html).toMatch(/renderLinks[\s\S]*?state\.bulkSel\.link\.has\(l\.id\) \? ['"] class="row-selected"['"]/);
  });

  it('Channels table header + rows wired', () => {
    expect(html).toMatch(/renderChannels[\s\S]*?bulkToggleAll\(['"]channel['"]/);
    expect(html).toMatch(/renderChannels[\s\S]*?bulkToggle\(['"]channel['"],\s*\$\{ch\.id\}\)/);
    expect(html).toMatch(/renderChannels[\s\S]*?state\.bulkSel\.channel\.has\(ch\.id\) \? ['"] class="row-selected"['"]/);
  });

  it('Notes uses a leading "Select all" flex-inline row (div-list adaptation)', () => {
    // Notes isn't a table — we render a discrete row at the top
    // with the same checkbox semantics so the affordance still
    // shows above the first note.
    expect(html).toMatch(/renderNotes[\s\S]*?class="row-inline note-select-all"/);
    expect(html).toMatch(/renderNotes[\s\S]*?bulkToggleAll\(['"]note['"]/);
  });

  it('Notes per-row checkbox lives inside the row-inline header', () => {
    expect(html).toMatch(/renderNotes[\s\S]*?bulkToggle\(['"]note['"],\s*\$\{n\.id\}\)/);
  });

  it('all 4 renderers prepend renderBulkToolbar(<kind>) output', () => {
    expect(html).toMatch(/renderBooks[\s\S]*?c\.innerHTML = renderBulkToolbar\(['"]book['"]\)/);
    expect(html).toMatch(/renderLinks[\s\S]*?c\.innerHTML = renderBulkToolbar\(['"]link['"]\)/);
    expect(html).toMatch(/renderChannels[\s\S]*?c\.innerHTML = renderBulkToolbar\(['"]channel['"]\)/);
    expect(html).toMatch(/renderNotes[\s\S]*?c\.innerHTML = renderBulkToolbar\(['"]note['"]\)/);
  });

  it('visible-ids ternary pins "select all only reflects visible rows"', () => {
    // If someone changes visibleIds to state.books.map, a filter
    // would hide rows but "select all" would include them — the
    // exact bug spec mentions. Pin the visibleIds-derived shape.
    for (const [rend, state] of [['renderBooks', 'book'], ['renderLinks', 'link'], ['renderChannels', 'channel'], ['renderNotes', 'note']]) {
      expect(html).toMatch(new RegExp(
        `${rend}[\\s\\S]*?const visibleIds = rows\\.map[\\s\\S]*?state\\.bulkSel\\.${state}\\.size > 0 && visibleIds\\.every`,
      ));
    }
  });
});

describe('user-console.html — CSS for bulk toolbar + selection (OI-UX-103)', () => {
  const html = loadHtml();

  it('.bulk-toolbar uses accent-subtle tint (signals active selection)', () => {
    expect(html).toMatch(/\.bulk-toolbar\s*\{[\s\S]*?background:\s*var\(--accent-subtle\)/);
  });

  it('.bulk-toolbar displays inline via flex + gap', () => {
    expect(html).toMatch(/\.bulk-toolbar\s*\{[\s\S]*?display:\s*flex/);
    expect(html).toMatch(/\.bulk-toolbar\s*\{[\s\S]*?gap:\s*var\(--space-2\)/);
  });

  it('.bulk-count uses accent color + semi-bold for prominence', () => {
    expect(html).toMatch(/\.bulk-toolbar \.bulk-count\s*\{[\s\S]*?color:\s*var\(--accent\)/);
    expect(html).toMatch(/\.bulk-toolbar \.bulk-count\s*\{[\s\S]*?font-weight:\s*600/);
  });

  it('.bulk-check-col is narrow + centered (24-32px sweet spot)', () => {
    expect(html).toMatch(/\.bulk-check-col\s*\{[\s\S]*?width:\s*32px/);
    expect(html).toMatch(/\.bulk-check-col\s*\{[\s\S]*?text-align:\s*center/);
  });

  it('tr.row-selected + .row.row-selected get accent tint background', () => {
    expect(html).toMatch(/tr\.row-selected td,\s*\.row\.row-selected\s*\{\s*background:\s*var\(--accent-subtle\)/);
  });
});

describe('user-console.html — regression: inline Remove buttons untouched (OI-UX-103)', () => {
  const html = loadHtml();

  it('per-row deleteBook/deleteLink/deleteNote/deleteChannel buttons still exist', () => {
    // Bulk delete doesn't replace inline delete. A user still wants
    // a one-row-off removal without selecting a checkbox first.
    for (const fn of ['deleteBook', 'deleteLink', 'deleteNote', 'deleteChannel']) {
      expect(html).toMatch(new RegExp(`onclick="${fn}\\(`));
    }
  });

  it('existing tag autocomplete (OI-UX-102) not disturbed', () => {
    expect(html).toMatch(/function initAllTagAutocomplete\(\)/);
  });

  it('skill-badges-editable renderer (OI-USR-405a) still wired into rows', () => {
    for (const [rend, kind, param] of [['renderBooks', 'book', 'b'], ['renderLinks', 'link', 'l'], ['renderChannels', 'channel', 'ch'], ['renderNotes', 'note', 'n']]) {
      expect(html).toMatch(new RegExp(
        `${rend}[\\s\\S]*?renderSkillBadgesEditable\\(${param}\\.tags,\\s*['"]${kind}['"]`,
      ));
    }
  });
});
