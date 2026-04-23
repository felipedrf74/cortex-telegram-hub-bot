// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Structural + behavior pins for the invite-expiry countdown
 * (OI-USR-406, 2026-04-23).
 *
 * The invites table used to show an ISO timestamp that's hard to
 * reason about ("2026-04-30T12:00:00Z" vs "how much time do I
 * have?"). This PR adds a relative countdown column with 5 states:
 *
 *   none      expiresAt is null — "never" (muted italic)
 *   fresh     > 24h — "expires in Nd"
 *   soon      1-24h — "expires in Nh"
 *   expiring  < 1h  — "expires in Nm" (orange tint)
 *   expired   past  — "expired Nd ago" (danger tint)
 *
 * Since `formatCountdown` is a pure function we can actually
 * execute it against the HTML source by extracting the function
 * body + eval-ing it. That gives us real behavior pins, not just
 * structural shape pins — important for a display function where
 * the boundaries (24h vs 23h 59m) are the bug-prone regions.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const HTML_PATH = path.resolve(__dirname, '../../src/portal/user-console.html');
const loadHtml = (): string => fs.readFileSync(HTML_PATH, 'utf-8');

// Extract a named function from the HTML by matching `function
// <name>(...) { ... }` at top-level indentation. Used only in this
// test file — since the function is pure (no DOM, no state), we
// can eval it in a sandboxed Function() and test outputs directly.
function extractFn(html: string, name: string): Function {
  // We need to match the balanced braces. Grab a generous window,
  // then trim to the closing brace that matches the opening one.
  const match = html.match(new RegExp(`function ${name}\\s*\\([^)]*\\)[\\s\\S]{0,2000}`));
  if (!match) throw new Error(`function ${name} not found`);
  const start = match[0];
  // Find the opening brace of the function body
  const openIdx = start.indexOf('{');
  let depth = 0;
  let endIdx = -1;
  for (let i = openIdx; i < start.length; i++) {
    if (start[i] === '{') depth++;
    else if (start[i] === '}') { depth--; if (depth === 0) { endIdx = i; break; } }
  }
  if (endIdx === -1) throw new Error(`unbalanced braces in ${name}`);
  const body = start.slice(0, endIdx + 1);
  // Wrap as a module-returning Function so humanizeDuration is
  // reachable from formatCountdown (they both live in the same
  // evaluation scope).
  const helperSrc = extractRawBody(html, 'humanizeDuration');
  // eslint-disable-next-line no-new-func
  const compiled = new Function(`${helperSrc}\n${body}\nreturn ${name};`);
  return compiled();
}
function extractRawBody(html: string, name: string): string {
  const match = html.match(new RegExp(`function ${name}\\s*\\([^)]*\\)[\\s\\S]{0,2000}`));
  if (!match) return '';
  const start = match[0];
  const openIdx = start.indexOf('{');
  let depth = 0;
  let endIdx = -1;
  for (let i = openIdx; i < start.length; i++) {
    if (start[i] === '{') depth++;
    else if (start[i] === '}') { depth--; if (depth === 0) { endIdx = i; break; } }
  }
  return start.slice(0, endIdx + 1);
}

describe('formatCountdown — pure behavior (OI-USR-406)', () => {
  const html = loadHtml();
  const formatCountdown = extractFn(html, 'formatCountdown') as (iso: string | null) => { label: string; kind: string };

  const NOW = new Date('2026-04-23T12:00:00Z').getTime();
  afterEach(() => { vi.useRealTimers(); });
  const freeze = (): void => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  };
  const iso = (msOffset: number): string => new Date(NOW + msOffset).toISOString();

  it('null / undefined / empty → { label: "never", kind: "none" }', () => {
    expect(formatCountdown(null)).toEqual({ label: 'never', kind: 'none' });
    expect(formatCountdown('' as any)).toEqual({ label: 'never', kind: 'none' });
    expect(formatCountdown(undefined as any)).toEqual({ label: 'never', kind: 'none' });
  });

  it('unparseable ISO → "unknown" + kind none (not a crash)', () => {
    expect(formatCountdown('nope' as any)).toEqual({ label: 'unknown', kind: 'none' });
  });

  it('> 24h remaining → "fresh" bucket', () => {
    freeze();
    expect(formatCountdown(iso(48 * 3600_000))).toEqual({ label: 'expires in 2d', kind: 'fresh' });
    expect(formatCountdown(iso(25 * 3600_000))).toEqual({ label: 'expires in 1d', kind: 'fresh' });
  });

  it('exactly 24h → "fresh" (1d), 23h → "soon"', () => {
    freeze();
    expect(formatCountdown(iso(24 * 3600_000))).toEqual({ label: 'expires in 1d', kind: 'fresh' });
    expect(formatCountdown(iso(23 * 3600_000))).toEqual({ label: 'expires in 23h', kind: 'soon' });
  });

  it('1h-24h remaining → "soon" bucket', () => {
    freeze();
    expect(formatCountdown(iso(5 * 3600_000))).toEqual({ label: 'expires in 5h', kind: 'soon' });
    expect(formatCountdown(iso(1 * 3600_000))).toEqual({ label: 'expires in 1h', kind: 'soon' });
  });

  it('< 1h remaining → "expiring" bucket (orange tint)', () => {
    freeze();
    expect(formatCountdown(iso(45 * 60_000))).toEqual({ label: 'expires in 45m', kind: 'expiring' });
    expect(formatCountdown(iso(1 * 60_000))).toEqual({ label: 'expires in 1m', kind: 'expiring' });
  });

  it('< 1m remaining still reports "expires in 1m" (no "0m")', () => {
    freeze();
    expect(formatCountdown(iso(30 * 1000))).toEqual({ label: 'expires in 1m', kind: 'expiring' });
  });

  it('past expiry → "expired" bucket', () => {
    freeze();
    expect(formatCountdown(iso(-2 * 86400_000))).toEqual({ label: 'expired 2d ago', kind: 'expired' });
    expect(formatCountdown(iso(-3 * 3600_000))).toEqual({ label: 'expired 3h ago', kind: 'expired' });
    expect(formatCountdown(iso(-15 * 60_000))).toEqual({ label: 'expired 15m ago', kind: 'expired' });
  });

  it('exactly 0 (edge) → expired bucket', () => {
    freeze();
    expect(formatCountdown(iso(0)).kind).toBe('expired');
  });
});

describe('humanizeDuration — pure behavior (OI-USR-406)', () => {
  const html = loadHtml();
  const humanizeDuration = extractFn(html, 'humanizeDuration') as (ms: number) => string;

  it('days > hours > minutes ladder', () => {
    expect(humanizeDuration(3 * 86400_000)).toBe('3d');
    expect(humanizeDuration(5 * 3600_000)).toBe('5h');
    expect(humanizeDuration(30 * 60_000)).toBe('30m');
  });

  it('sub-minute still reports 1m (no "0m")', () => {
    expect(humanizeDuration(30 * 1000)).toBe('1m');
    expect(humanizeDuration(0)).toBe('1m');
  });
});

describe('user-console.html — invites table uses countdown column (OI-USR-406)', () => {
  const html = loadHtml();

  it('thead gets an Expires column between Created and the action column', () => {
    expect(html).toMatch(
      /<th>Email<\/th><th>Role<\/th><th>Status<\/th><th>Created<\/th><th>Expires<\/th><th><\/th>/,
    );
  });

  it('each row picks up expiresAt or expires_at (camelCase first, snake fallback)', () => {
    expect(html).toMatch(/const iso = i\.expiresAt \|\| i\.expires_at \|\| ['"]['"]/);
  });

  it('row calls formatCountdown(iso || null) — null-normalised so the "none" branch fires', () => {
    // Empty string must NOT return "expires in 0m" — we pass null
    // when iso is empty so the helper hits its early-return branch.
    expect(html).toMatch(/formatCountdown\(iso \|\| null\)/);
  });

  it('countdown span carries class="invite-countdown <kind>" + data-expires + title', () => {
    expect(html).toMatch(
      /<span class="invite-countdown \$\{esc\(c\.kind\)\}" data-expires="\$\{esc\(iso\)\}" title="\$\{esc\(iso\) \|\| ['"]no expiry set['"]\}">\$\{esc\(c\.label\)\}<\/span>/,
    );
  });
});

describe('user-console.html — 30s refresh tick (OI-USR-406)', () => {
  const html = loadHtml();

  it('refreshInviteCountdowns defined + queries .invite-countdown[data-expires]', () => {
    expect(html).toMatch(/function refreshInviteCountdowns\(\)/);
    expect(html).toMatch(
      /refreshInviteCountdowns[\s\S]*?document\.querySelectorAll\(['"]\.invite-countdown\[data-expires\]['"]\)/,
    );
  });

  it('tick mutates textContent + className only (no row replacement)', () => {
    // Row replacement would blow away in-flight button clicks like
    // "Copy link" → clipboard. Pin the textContent-only update.
    expect(html).toMatch(/refreshInviteCountdowns[\s\S]*?el\.textContent = c\.label/);
    expect(html).toMatch(/refreshInviteCountdowns[\s\S]*?el\.className = ['"]invite-countdown ['"]\s*\+\s*c\.kind/);
  });

  it('tick passes iso || null so empty-string expiresAt hits the none branch', () => {
    expect(html).toMatch(/refreshInviteCountdowns[\s\S]*?formatCountdown\(iso \|\| null\)/);
  });

  it('setInterval armed at 30000ms (30s cadence)', () => {
    expect(html).toMatch(/setInterval\(refreshInviteCountdowns,\s*30000\)/);
  });
});

describe('user-console.html — CSS for countdown pill (OI-USR-406)', () => {
  const html = loadHtml();

  it('.invite-countdown uses tabular-nums so digits do not jitter during tick', () => {
    // Without tabular-nums, "12h" vs "13h" shift pixel width as
    // numbers change — visible jitter on every 30s refresh.
    expect(html).toMatch(/\.invite-countdown\s*\{[\s\S]*?font-variant-numeric:\s*tabular-nums/);
  });

  it('5 kind classes exist with distinct colors', () => {
    for (const kind of ['none', 'fresh', 'soon', 'expiring', 'expired']) {
      expect(html).toMatch(new RegExp(`\\.invite-countdown\\.${kind}\\b`));
    }
  });

  it('expired has a red/danger color + slight bold for attention', () => {
    expect(html).toMatch(/\.invite-countdown\.expired[\s\S]*?color:\s*var\(--danger/);
    expect(html).toMatch(/\.invite-countdown\.expired[\s\S]*?font-weight:\s*500/);
  });

  it('expiring uses orange (distinct from danger + from accent) for < 1h urgency', () => {
    expect(html).toMatch(/\.invite-countdown\.expiring\s*\{[\s\S]*?color:\s*#d97706/);
  });

  it('none uses italic + muted (reads as "nothing to count down from")', () => {
    expect(html).toMatch(/\.invite-countdown\.none\s*\{[\s\S]*?font-style:\s*italic/);
  });
});

describe('user-console.html — regression: table row rendering unchanged for other columns (OI-USR-406)', () => {
  const html = loadHtml();

  it('Email / Role / Status / Created / action cells still render identically', () => {
    expect(html).toMatch(/<td>\$\{esc\(i\.email\)\}<\/td>/);
    expect(html).toMatch(/<td><span class="pill role">\$\{esc\(labelFor\(['"]role['"],\s*i\.role\)\)\}/);
    expect(html).toMatch(/labelFor\(['"]inviteStatus['"],\s*i\.status\)/);
    expect(html).toMatch(/i\.status === ['"]pending['"] \? `<button class="btn ghost small"/);
  });

  it('OI-UX-104 label map still applied to role + inviteStatus on invites', () => {
    expect(html).toMatch(/labelFor\(['"]role['"],\s*i\.role\)/);
    expect(html).toMatch(/labelFor\(['"]inviteStatus['"],\s*i\.status\)/);
  });
});
