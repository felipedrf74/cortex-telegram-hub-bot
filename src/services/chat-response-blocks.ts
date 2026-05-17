// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Phase 16 batch 83 (2026-05-17): typed block schema for chat responses.
//
// Before Phase 16 the assistant reply was a single `text: string` field
// carrying mixed conventions — markdown `**bold**`, HTML `<b>...</b>`,
// and plain prose — that iOS's `MarkdownRenderer.richTextView` silently
// fell back to verbatim when the parser threw. iOS users saw raw `*` and
// `**` characters bleed through into chat bubbles.
//
// This module declares the target contract: structured blocks the iOS
// client can render natively (one SwiftUI view per block kind) and the
// Telegram + WhatsApp adapters can downgrade to clean markdown via
// `downgradeBlocksToText`. The legacy `text: string` field stays in the
// envelope as a fallback for older iOS builds during the rollout window
// (per Phase 16 cross-platform release pairing).
//
// New block kinds must be added here AND in the iOS `ChatResponseBlock`
// decoder + `BlockRenderer` view (separate repo). The Phase 16 batch 87
// work pairs each new kind with an iOS rendering view.

/**
 * Inline emphasis run inside a paragraph or bullet item. Renders as
 * bold/italic/code/link without leaking raw markdown to the bubble.
 */
export type BlockEmphasisRun =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'italic'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string };

/**
 * Text content with optional emphasis runs. Plain strings are accepted
 * as a shorthand (treated as a single `text` run).
 */
export type BlockText = string | BlockEmphasisRun[];

/**
 * Discriminated union over every supported block kind. iOS renders each
 * via a dedicated SwiftUI view; Telegram/WhatsApp adapters downgrade
 * each via `downgradeBlocksToText`.
 */
export type ChatResponseBlock =
  | { kind: 'paragraph'; text: BlockText }
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'bulletList'; items: BlockText[] }
  | { kind: 'numberedList'; items: BlockText[] }
  | { kind: 'codeBlock'; language?: string | null; text: string }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'alert'; level: 'info' | 'warn' | 'error' | 'success'; text: BlockText }
  | { kind: 'divider' };

// ─────────────────────────────────────────────────────
// Block constructors (DX helpers)
// ─────────────────────────────────────────────────────

export function paragraph(text: BlockText): ChatResponseBlock {
  return { kind: 'paragraph', text };
}

export function heading(level: 1 | 2 | 3, text: string): ChatResponseBlock {
  return { kind: 'heading', level, text };
}

export function bulletList(items: BlockText[]): ChatResponseBlock {
  return { kind: 'bulletList', items };
}

export function numberedList(items: BlockText[]): ChatResponseBlock {
  return { kind: 'numberedList', items };
}

export function codeBlock(text: string, language?: string | null): ChatResponseBlock {
  return { kind: 'codeBlock', language: language ?? null, text };
}

export function alert(
  level: 'info' | 'warn' | 'error' | 'success',
  text: BlockText,
): ChatResponseBlock {
  return { kind: 'alert', level, text };
}

export function divider(): ChatResponseBlock {
  return { kind: 'divider' };
}

// ─────────────────────────────────────────────────────
// Markdown → blocks (forward parser, used during the
// migration window so existing producers can be wrapped
// incrementally — Batch 84+).
// ─────────────────────────────────────────────────────

/**
 * Parse backend-produced markdown text into typed blocks. Used to
 * migrate text-producing call sites to block emission incrementally
 * during Phase 16 Batches 84-85. Best-effort parser tuned for the
 * conventions the existing producers emit:
 *
 * - `# Title` / `## Subtitle` / `### Header` → heading blocks
 * - `- foo` / `* foo` lines → bulletList block
 * - `1. foo` / `2. bar` lines → numberedList block
 * - ```` ```lang\ncode\n``` ```` → codeBlock
 * - `| h | h2 |\n|---|---|\n| c | c2 |` → table block
 * - `> info: text` → alert (level info|warn|error|success keyword)
 * - blank lines split paragraphs
 *
 * Inline emphasis (`**bold**`, `*italic*`, `` `code` ``,
 * `[link](href)`) is parsed inside paragraphs and bullets into
 * `BlockEmphasisRun[]`. Stray, unbalanced, or malformed inline
 * markup is preserved as plain text — the parser never strips, only
 * converts.
 */
export function buildBlocksFromMarkdown(text: string): ChatResponseBlock[] {
  if (!text || !text.trim()) return [];
  const blocks: ChatResponseBlock[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Fenced code block
    const fenceMatch = line.match(/^```(\w+)?\s*$/);
    if (fenceMatch) {
      const language = fenceMatch[1] ?? null;
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      blocks.push({ kind: 'codeBlock', language, text: codeLines.join('\n') });
      if (i < lines.length) i++;
      continue;
    }
    // Heading
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length as 1 | 2 | 3;
      blocks.push({ kind: 'heading', level, text: headingMatch[2].trim() });
      i++;
      continue;
    }
    // Alert: `> info: …` / `> warn: …` / etc.
    const alertMatch = line.match(/^>\s+(info|warn|warning|error|success):\s+(.+)$/i);
    if (alertMatch) {
      const rawLevel = alertMatch[1].toLowerCase();
      const level: 'info' | 'warn' | 'error' | 'success' =
        rawLevel === 'warning' ? 'warn' : (rawLevel as 'info' | 'warn' | 'error' | 'success');
      blocks.push({ kind: 'alert', level, text: parseInlineEmphasis(alertMatch[2].trim()) });
      i++;
      continue;
    }
    // Markdown table. We only treat a pipe row as a table when it is
    // followed by a separator row, which avoids hijacking ordinary prose
    // that happens to contain a pipe character.
    const tableHeader = parseMarkdownTableRow(line);
    if (tableHeader && i + 1 < lines.length && isMarkdownTableSeparator(lines[i + 1])) {
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length) {
        const row = parseMarkdownTableRow(lines[i]);
        if (!row) break;
        rows.push(row);
        i++;
      }
      blocks.push({ kind: 'table', header: tableHeader, rows });
      continue;
    }
    // Bullet list
    if (/^[-*•]\s+/.test(line)) {
      const items: BlockText[] = [];
      while (i < lines.length && /^[-*•]\s+/.test(lines[i])) {
        items.push(parseInlineEmphasis(lines[i].replace(/^[-*•]\s+/, '').trim()));
        i++;
      }
      blocks.push({ kind: 'bulletList', items });
      continue;
    }
    // Numbered list
    if (/^\d+\.\s+/.test(line)) {
      const items: BlockText[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(parseInlineEmphasis(lines[i].replace(/^\d+\.\s+/, '').trim()));
        i++;
      }
      blocks.push({ kind: 'numberedList', items });
      continue;
    }
    // Divider
    if (/^---+$/.test(line.trim())) {
      blocks.push({ kind: 'divider' });
      i++;
      continue;
    }
    // Blank line — paragraph boundary
    if (!line.trim()) {
      i++;
      continue;
    }
    // Otherwise: paragraph. Preserve soft line breaks instead of collapsing
    // them so markdown → blocks → text round trips do not lose information.
    const paragraphLines: string[] = [line];
    let j = i + 1;
    while (
      j < lines.length
      && lines[j].trim()
      && !/^(#{1,3})\s+/.test(lines[j])
      && !/^[-*•]\s+/.test(lines[j])
      && !/^\d+\.\s+/.test(lines[j])
      && !/^```/.test(lines[j])
      && !/^>\s+/.test(lines[j])
      && !/^---+$/.test(lines[j].trim())
    ) {
      paragraphLines.push(lines[j]);
      j++;
    }
    blocks.push({ kind: 'paragraph', text: parseInlineEmphasis(paragraphLines.join('\n').trim()) });
    i = j;
  }
  return blocks;
}

function parseMarkdownTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  const cells = trimmed
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim());
  return cells.length >= 2 ? cells : null;
}

function isMarkdownTableSeparator(line: string): boolean {
  const cells = parseMarkdownTableRow(line);
  if (!cells) return false;
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

/**
 * Parse inline emphasis (`**bold**`, `*italic*`, `` `code` ``,
 * `[text](href)`) into a BlockEmphasisRun[]. Returns a plain string
 * when no emphasis is found (avoids allocating a single-element array
 * for the common case).
 */
export function parseInlineEmphasis(text: string): BlockText {
  if (!text) return '';
  // Quick fast-path: no markdown markers at all.
  if (!/[*`[]/.test(text)) return text;
  const runs: BlockEmphasisRun[] = [];
  // Greedy alternation: bold (**…**), italic (*…*), code (`…`), link ([text](href))
  // Stray asterisks/backticks that don't match a complete pair are kept as plain text.
  const pattern = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      runs.push({ kind: 'text', text: text.slice(lastIndex, match.index) });
    }
    if (match[1] !== undefined) runs.push({ kind: 'bold', text: match[1] });
    else if (match[2] !== undefined) runs.push({ kind: 'italic', text: match[2] });
    else if (match[3] !== undefined) runs.push({ kind: 'code', text: match[3] });
    else if (match[4] !== undefined && match[5] !== undefined) {
      runs.push({ kind: 'link', text: match[4], href: match[5] });
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) {
    runs.push({ kind: 'text', text: text.slice(lastIndex) });
  }
  if (runs.length === 0) return text;
  if (runs.length === 1 && runs[0].kind === 'text') return runs[0].text;
  return runs;
}

// ─────────────────────────────────────────────────────
// Blocks → markdown (reverse serializer, used by Telegram
// and WhatsApp adapters during the transition).
// ─────────────────────────────────────────────────────

/**
 * Re-serialize blocks to clean markdown text. Used by Telegram +
 * WhatsApp adapters and the legacy `text` field in the response
 * envelope. Output is normalized — no HTML, no half-formed markdown,
 * no stray characters.
 */
export function downgradeBlocksToText(blocks: ChatResponseBlock[]): string {
  if (!blocks.length) return '';
  const lines: string[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case 'paragraph':
        lines.push(blockTextToMarkdown(block.text));
        lines.push('');
        break;
      case 'heading': {
        const prefix = '#'.repeat(block.level);
        lines.push(`${prefix} ${block.text}`);
        lines.push('');
        break;
      }
      case 'bulletList':
        for (const item of block.items) lines.push(`- ${blockTextToMarkdown(item)}`);
        lines.push('');
        break;
      case 'numberedList':
        block.items.forEach((item, idx) => lines.push(`${idx + 1}. ${blockTextToMarkdown(item)}`));
        lines.push('');
        break;
      case 'codeBlock': {
        const fence = block.language ? `\`\`\`${block.language}` : '```';
        lines.push(fence);
        lines.push(block.text);
        lines.push('```');
        lines.push('');
        break;
      }
      case 'table': {
        if (block.header.length > 0) lines.push(`| ${block.header.join(' | ')} |`);
        if (block.header.length > 0) lines.push(`| ${block.header.map(() => '---').join(' | ')} |`);
        for (const row of block.rows) lines.push(`| ${row.join(' | ')} |`);
        lines.push('');
        break;
      }
      case 'alert':
        lines.push(`> ${block.level}: ${blockTextToMarkdown(block.text)}`);
        lines.push('');
        break;
      case 'divider':
        lines.push('---');
        lines.push('');
        break;
    }
  }
  return lines.join('\n').trimEnd();
}

function blockTextToMarkdown(text: BlockText): string {
  if (typeof text === 'string') return text;
  return text.map(runToMarkdown).join('');
}

function runToMarkdown(run: BlockEmphasisRun): string {
  switch (run.kind) {
    case 'text': return run.text;
    case 'bold': return `**${run.text}**`;
    case 'italic': return `*${run.text}*`;
    case 'code': return `\`${run.text}\``;
    case 'link': return `[${run.text}](${run.href})`;
  }
}
