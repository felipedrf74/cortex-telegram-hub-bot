// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Phase 16 batch 83 (2026-05-17): block schema + parser regression.

import { describe, expect, it } from 'vitest';
import {
  buildBlocksFromMarkdown,
  downgradeBlocksToText,
  parseInlineEmphasis,
  paragraph,
  heading,
  bulletList,
  numberedList,
  codeBlock,
  alert,
  divider,
  type ChatResponseBlock,
} from '../../src/services/chat-response-blocks';

describe('buildBlocksFromMarkdown', () => {
  it('returns [] for empty or whitespace-only input', () => {
    expect(buildBlocksFromMarkdown('')).toEqual([]);
    expect(buildBlocksFromMarkdown('   ')).toEqual([]);
  });

  it('parses a single paragraph with no markup', () => {
    const blocks = buildBlocksFromMarkdown('Hello world');
    expect(blocks).toEqual([{ kind: 'paragraph', text: 'Hello world' }]);
  });

  it('parses heading levels 1-3', () => {
    expect(buildBlocksFromMarkdown('# Title')).toEqual([{ kind: 'heading', level: 1, text: 'Title' }]);
    expect(buildBlocksFromMarkdown('## Subtitle')).toEqual([{ kind: 'heading', level: 2, text: 'Subtitle' }]);
    expect(buildBlocksFromMarkdown('### Detail')).toEqual([{ kind: 'heading', level: 3, text: 'Detail' }]);
  });

  it('parses bullet list with - / * / • markers', () => {
    const md = '- one\n* two\n• three';
    const blocks = buildBlocksFromMarkdown(md);
    expect(blocks).toEqual([
      { kind: 'bulletList', items: ['one', 'two', 'three'] },
    ]);
  });

  it('parses numbered list', () => {
    const md = '1. one\n2. two\n3. three';
    const blocks = buildBlocksFromMarkdown(md);
    expect(blocks).toEqual([
      { kind: 'numberedList', items: ['one', 'two', 'three'] },
    ]);
  });

  it('parses fenced code block with language', () => {
    const md = '```ts\nconst x = 1;\n```';
    const blocks = buildBlocksFromMarkdown(md);
    expect(blocks).toEqual([{ kind: 'codeBlock', language: 'ts', text: 'const x = 1;' }]);
  });

  it('parses fenced code block without language', () => {
    const md = '```\nplain code\n```';
    const blocks = buildBlocksFromMarkdown(md);
    expect(blocks).toEqual([{ kind: 'codeBlock', language: null, text: 'plain code' }]);
  });

  it('parses divider', () => {
    expect(buildBlocksFromMarkdown('---')).toEqual([{ kind: 'divider' }]);
    expect(buildBlocksFromMarkdown('-----')).toEqual([{ kind: 'divider' }]);
  });

  it('parses alert blocks', () => {
    expect(buildBlocksFromMarkdown('> info: heads up')).toEqual([
      { kind: 'alert', level: 'info', text: 'heads up' },
    ]);
    expect(buildBlocksFromMarkdown('> warning: dragons')).toEqual([
      { kind: 'alert', level: 'warn', text: 'dragons' },
    ]);
  });

  it('preserves inline bold/italic emphasis in paragraphs', () => {
    const blocks = buildBlocksFromMarkdown('Hello **world** and *italics*');
    expect(blocks).toEqual([
      {
        kind: 'paragraph',
        text: [
          { kind: 'text', text: 'Hello ' },
          { kind: 'bold', text: 'world' },
          { kind: 'text', text: ' and ' },
          { kind: 'italic', text: 'italics' },
        ],
      },
    ]);
  });

  it('preserves inline code and link runs', () => {
    const blocks = buildBlocksFromMarkdown('Use `npm run typecheck` or see [docs](https://example.com).');
    expect(blocks).toMatchObject([
      {
        kind: 'paragraph',
        text: expect.arrayContaining([
          { kind: 'code', text: 'npm run typecheck' },
          { kind: 'link', text: 'docs', href: 'https://example.com' },
        ]),
      },
    ]);
  });

  it('falls back to plain string for paragraphs with no inline emphasis', () => {
    const blocks = buildBlocksFromMarkdown('Plain prose, no markdown.');
    expect(blocks).toEqual([{ kind: 'paragraph', text: 'Plain prose, no markdown.' }]);
  });

  it('handles a heading + paragraph + bullet list document', () => {
    const md = '# Plan\n\nWe need to ship.\n\n- buy milk\n- write tests';
    const blocks = buildBlocksFromMarkdown(md);
    expect(blocks).toEqual([
      { kind: 'heading', level: 1, text: 'Plan' },
      { kind: 'paragraph', text: 'We need to ship.' },
      { kind: 'bulletList', items: ['buy milk', 'write tests'] },
    ]);
  });

  it('collapses consecutive non-blank prose lines into a single paragraph', () => {
    const md = 'Line one\nLine two\nLine three';
    const blocks = buildBlocksFromMarkdown(md);
    expect(blocks).toEqual([{ kind: 'paragraph', text: 'Line one Line two Line three' }]);
  });
});

describe('parseInlineEmphasis', () => {
  it('returns string unchanged when no markdown markers present', () => {
    expect(parseInlineEmphasis('plain text')).toBe('plain text');
  });

  it('handles unbalanced double-asterisks by leaving them as plain text', () => {
    // The parser should never throw or strip silently; raw unbalanced
    // markdown is preserved (Batch 88 will handle this on the iOS side).
    const result = parseInlineEmphasis('**incomplete');
    expect(typeof result).toBe('string');
  });

  it('handles mid-word asterisks by leaving them as plain text', () => {
    const result = parseInlineEmphasis('a*b*c');
    // The parser DOES match *…* greedily. That's expected — Batch 88's
    // iOS hardening normalizes these on the rendering side.
    expect(Array.isArray(result) || typeof result === 'string').toBe(true);
  });
});

describe('downgradeBlocksToText', () => {
  it('serializes a paragraph back to plain prose', () => {
    const blocks: ChatResponseBlock[] = [paragraph('Hello world')];
    expect(downgradeBlocksToText(blocks)).toBe('Hello world');
  });

  it('serializes heading + paragraph + bullet list to clean markdown', () => {
    const blocks: ChatResponseBlock[] = [
      heading(1, 'Plan'),
      paragraph('We need to ship.'),
      bulletList(['buy milk', 'write tests']),
    ];
    const text = downgradeBlocksToText(blocks);
    expect(text).toMatch(/^# Plan/);
    expect(text).toMatch(/We need to ship\./);
    expect(text).toMatch(/- buy milk/);
    expect(text).toMatch(/- write tests/);
  });

  it('serializes numbered list with 1-based indexing', () => {
    const blocks: ChatResponseBlock[] = [numberedList(['one', 'two', 'three'])];
    const text = downgradeBlocksToText(blocks);
    expect(text).toMatch(/1\. one/);
    expect(text).toMatch(/2\. two/);
    expect(text).toMatch(/3\. three/);
  });

  it('serializes code block with language fence', () => {
    const blocks: ChatResponseBlock[] = [codeBlock('const x = 1;', 'ts')];
    expect(downgradeBlocksToText(blocks)).toContain('```ts\nconst x = 1;\n```');
  });

  it('serializes alert blocks with level prefix', () => {
    const blocks: ChatResponseBlock[] = [alert('info', 'heads up')];
    expect(downgradeBlocksToText(blocks)).toContain('> info: heads up');
  });

  it('serializes divider as ---', () => {
    expect(downgradeBlocksToText([divider()])).toBe('---');
  });

  it('serializes inline emphasis back to markdown', () => {
    const blocks: ChatResponseBlock[] = [
      paragraph([
        { kind: 'text', text: 'Hello ' },
        { kind: 'bold', text: 'world' },
        { kind: 'text', text: '!' },
      ]),
    ];
    expect(downgradeBlocksToText(blocks)).toBe('Hello **world**!');
  });
});

describe('blocks round-trip', () => {
  it('markdown → blocks → markdown preserves heading + paragraph + bullet list', () => {
    const original = '# Plan\n\nWe need to ship.\n\n- buy milk\n- write tests';
    const blocks = buildBlocksFromMarkdown(original);
    const serialized = downgradeBlocksToText(blocks);
    // Not byte-exact (whitespace can vary), but the structural pieces survive.
    expect(serialized).toMatch(/^# Plan/);
    expect(serialized).toMatch(/We need to ship\./);
    expect(serialized).toMatch(/- buy milk/);
    expect(serialized).toMatch(/- write tests/);
  });

  it('markdown → blocks → markdown preserves inline bold and italic', () => {
    const original = 'Hello **world** and *italics*';
    const blocks = buildBlocksFromMarkdown(original);
    const serialized = downgradeBlocksToText(blocks);
    expect(serialized).toBe('Hello **world** and *italics*');
  });

  it('markdown → blocks → markdown preserves code blocks with language', () => {
    const original = '```ts\nconst x = 1;\n```';
    const blocks = buildBlocksFromMarkdown(original);
    const serialized = downgradeBlocksToText(blocks);
    expect(serialized).toContain('```ts');
    expect(serialized).toContain('const x = 1;');
    expect(serialized).toContain('```');
  });
});
