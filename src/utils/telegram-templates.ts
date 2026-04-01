// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Telegram HTML Message Template System
 *
 * Reusable building blocks for Telegram HTML messages.
 * Telegram supports only: <b>, <i>, <u>, <s>, <code>, <pre>, <a href="">.
 *
 * Design principles:
 * 1. Components are pure functions returning HTML strings
 * 2. All user-provided text is escaped via escapeHtml()
 * 3. Templates compose — combine blocks to build full messages
 * 4. splitMessage() handles the 4096-char limit
 */

import { escapeHtml, splitMessage } from './telegram-formatter';

export { escapeHtml, splitMessage };

// ── Typography Components ──────────────────────────────────────────

/** Bold header with optional emoji prefix. */
export function header(text: string, emoji?: string): string {
  const prefix = emoji ? `${emoji} ` : '';
  return `${prefix}<b>${escapeHtml(text)}</b>`;
}

/** Section title with divider line above. */
export function section(title: string, emoji?: string): string {
  const prefix = emoji ? `${emoji} ` : '';
  return `\n${prefix}<b>${escapeHtml(title)}</b>`;
}

/** Muted/secondary text. */
export function muted(text: string): string {
  return `<i>${escapeHtml(text)}</i>`;
}

/** Monospace/code text (for values, amounts, codes). */
export function code(text: string): string {
  return `<code>${escapeHtml(text)}</code>`;
}

/** Link with text. */
export function link(text: string, url: string): string {
  return `<a href="${url}">${escapeHtml(text)}</a>`;
}

// ── Layout Components ──────────────────────────────────────────────

/** Bullet list item with optional prefix emoji. */
export function bullet(text: string, emoji = '•'): string {
  return `  ${emoji} ${text}`;
}

/** Key-value pair. */
export function kv(key: string, value: string): string {
  return `  <b>${escapeHtml(key)}:</b> ${escapeHtml(value)}`;
}

/** Key-value pair with code-formatted value. */
export function kvCode(key: string, value: string): string {
  return `  <b>${escapeHtml(key)}:</b> ${code(value)}`;
}

/** Horizontal divider (emoji-based for Telegram). */
export function divider(): string {
  return '━━━━━━━━━━━━━━━━━━━━━━';
}

/** Spacer (empty line). */
export function spacer(): string {
  return '';
}

// ── Stat Components ────────────────────────────────────────────────

/** Stat with label and value (e.g. "Messages Today: 42"). */
export function stat(label: string, value: string | number, emoji?: string): string {
  const prefix = emoji ? `${emoji} ` : '';
  return `${prefix}${escapeHtml(label)}: <b>${escapeHtml(String(value))}</b>`;
}

/** Compact stat row (multiple stats on one line, separated by ·). */
export function statRow(...stats: { label: string; value: string | number }[]): string {
  return stats.map(s => `${escapeHtml(s.label)}: <b>${escapeHtml(String(s.value))}</b>`).join('  ·  ');
}

/** Progress indicator (e.g. "3/5 steps completed"). */
export function progress(current: number, total: number, label?: string): string {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  const bar = progressBar(current, total);
  const suffix = label ? ` ${escapeHtml(label)}` : '';
  return `${bar} ${current}/${total} (${pct}%)${suffix}`;
}

/** Simple text-based progress bar. */
function progressBar(current: number, total: number, width = 10): string {
  const filled = total > 0 ? Math.round((current / total) * width) : 0;
  return '▓'.repeat(filled) + '░'.repeat(width - filled);
}

// ── Status Components ──────────────────────────────────────────────

/** Status badge. */
export function statusBadge(status: 'ok' | 'warning' | 'error' | 'info' | 'pending'): string {
  const badges = {
    ok: '✅',
    warning: '⚠️',
    error: '❌',
    info: 'ℹ️',
    pending: '⏳',
  };
  return badges[status] || '•';
}

/** Status line with badge + text. */
export function statusLine(status: 'ok' | 'warning' | 'error' | 'info' | 'pending', text: string): string {
  return `${statusBadge(status)} ${escapeHtml(text)}`;
}

// ── Table Components ───────────────────────────────────────────────

/** Simple table using aligned columns (monospace pre block). */
export function table(headers: string[], rows: string[][]): string {
  // Calculate column widths
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => (r[i] || '').length)),
  );

  const headerLine = headers.map((h, i) => h.padEnd(widths[i])).join('  ');
  const separator = widths.map(w => '─'.repeat(w)).join('──');
  const bodyLines = rows.map(row =>
    row.map((cell, i) => (cell || '').padEnd(widths[i])).join('  '),
  );

  return `<pre>${headerLine}\n${separator}\n${bodyLines.join('\n')}</pre>`;
}

// ── Message Builder ────────────────────────────────────────────────

/**
 * Build a Telegram message from an array of components.
 * Each component is a string (line). Empty strings become spacers.
 */
export function buildMessage(...lines: (string | string[])[]): string {
  return lines
    .flat()
    .join('\n');
}

// ── Pre-built Templates ────────────────────────────────────────────

/** Standard report header with title, subtitle, and timestamp. */
export function reportHeader(title: string, emoji: string, subtitle?: string): string {
  const lines = [header(title, emoji)];
  if (subtitle) lines.push(muted(subtitle));
  return lines.join('\n');
}

/** Summary card — a boxed section with key-value pairs. */
export function summaryCard(title: string, emoji: string, items: { key: string; value: string }[]): string {
  const lines = [section(title, emoji)];
  for (const item of items) {
    lines.push(kv(item.key, item.value));
  }
  return lines.join('\n');
}

/** Alert/notification block. */
export function alertBlock(
  level: 'ok' | 'warning' | 'error' | 'info',
  title: string,
  details?: string[],
): string {
  const lines = [statusLine(level, title)];
  if (details) {
    for (const d of details) {
      lines.push(bullet(escapeHtml(d)));
    }
  }
  return lines.join('\n');
}

/** Action footer — quick command suggestions. */
export function actionFooter(commands: string[]): string {
  return `\n${commands.join(' · ')}`;
}
