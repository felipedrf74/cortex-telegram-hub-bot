/**
 * Transport Boundary Tests — content services stay transport-agnostic.
 *
 * The legacy Telegram formatter (content-telegram-formatter.ts) and its
 * re-exports were deleted with the Telegram legacy delivery path (2026-07).
 * These tests pin the invariants that remain:
 *   1. content-engine.ts has no inline format functions or Telegram HTML output
 *   2. Core response types are structured (not strings)
 *   3. No Telegram bot framework usage in content services
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC_DIR = path.resolve(__dirname, '../../src');
const SERVICES_DIR = path.join(SRC_DIR, 'services');

// ═══════════════════════════════════════════════════════════════════
// 1. content-engine.ts — No Inline Format Implementations
// ═══════════════════════════════════════════════════════════════════

describe('transport-boundary: content-engine is format-free', () => {
  const engineSource = fs.readFileSync(
    path.join(SERVICES_DIR, 'content-engine.ts'),
    'utf8',
  );

  it('content-engine.ts has no inline format function definitions', () => {
    const lines = engineSource.split('\n');
    const formatDefs = lines.filter((line: string) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//')) return false;
      return trimmed.startsWith('export function format');
    });
    expect(formatDefs).toHaveLength(0);
  });

  it('content-engine.ts has no private escapeHtml function', () => {
    const lines = engineSource.split('\n');
    const escapeHtmlDefs = lines.filter((line: string) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//')) return false;
      return trimmed.includes('function escapeHtml');
    });
    expect(escapeHtmlDefs).toHaveLength(0);
  });

  it('content-engine.ts has no isSafeUrl function', () => {
    const lines = engineSource.split('\n');
    const isSafeUrlDefs = lines.filter((line: string) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//')) return false;
      return trimmed.includes('function isSafeUrl');
    });
    expect(isSafeUrlDefs).toHaveLength(0);
  });

  it('content-engine.ts has no Telegram format function bodies producing HTML', () => {
    // The engine may have HTML tag references in utility functions (stripHtml,
    // text conversion) — those are transport-agnostic input parsers, not formatters.
    // What we're checking: no function that GENERATES Telegram HTML output.
    const lines = engineSource.split('\n');
    const telegramOutputPatterns = lines.filter((line: string) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return false;
      // Format functions characteristically use `msg +=` with <b> or parse_mode
      return (trimmed.includes('msg +=') && trimmed.includes('<b>'))
        || trimmed.includes('parse_mode');
    });
    expect(telegramOutputPatterns).toHaveLength(0);
  });

  it('content-engine.ts no longer references the deleted Telegram formatter module', () => {
    expect(engineSource).not.toContain("from './content-telegram-formatter'");
  });

});

// ═══════════════════════════════════════════════════════════════════
// 2. Core Response Types — Structured (not strings)
// ═══════════════════════════════════════════════════════════════════

describe('transport-boundary: core response types are structured', () => {
  const engineSource = fs.readFileSync(
    path.join(SERVICES_DIR, 'content-engine.ts'),
    'utf8',
  );

  const structuredTypes = [
    'ScriptResponse', 'DeepSearchResponse', 'HotNewsResponse',
    'TrendingResponse', 'ReactionResponse', 'HooksResponse',
    'TitlesResponse', 'ThumbnailResponse', 'CaptionResponse',
    'CompetitorResponse', 'GapsResponse', 'SeoResponse',
    'RepurposeResponse', 'FeedbackResponse', 'ReportResponse',
    'SourcesResponse',
  ];

  for (const type of structuredTypes) {
    it(`${type} is exported as a structured interface`, () => {
      expect(engineSource).toContain(`export interface ${type}`);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════
// 3. No Telegram bot framework in content services
// ═══════════════════════════════════════════════════════════════════

describe('transport-boundary: no Telegram bot framework in content services', () => {
  const files = [
    'content-engine.ts',
    'content-workflow.ts',
    'content-notification-store.ts',
  ];

  for (const file of files) {
    it(`${file} has no Telegram bot framework import`, () => {
      const source = fs.readFileSync(path.join(SERVICES_DIR, file), 'utf8');
      const lines = source.split('\n');
      const botImports = lines.filter((l: string) => {
        const t = l.trim();
        if (t.startsWith('//')) return false;
        return t.startsWith('import') && t.includes("'grammy'");
      });
      expect(botImports).toHaveLength(0);
    });
  }

  it('the legacy content-telegram-formatter module is gone', () => {
    expect(fs.existsSync(path.join(SERVICES_DIR, 'content-telegram-formatter.ts'))).toBe(false);
  });
});
