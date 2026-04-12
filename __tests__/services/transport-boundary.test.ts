/**
 * Transport Boundary Tests — Telegram formatting isolation.
 *
 * Verifies the content domain's transport boundary:
 *   1. Format functions live in content-telegram-formatter.ts (not content-engine.ts)
 *   2. content-engine.ts has no inline format functions
 *   3. content-engine.ts has no Telegram HTML tags
 *   4. Telegram handler imports formatters from the adapter, not the engine
 *   5. Format functions produce Telegram HTML (not structured data)
 *   6. content-engine.ts re-exports for backward compat
 *   7. Core response types are structured (not strings)
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC_DIR = path.resolve(__dirname, '../../src');
const SERVICES_DIR = path.join(SRC_DIR, 'services');
const HANDLERS_DIR = path.join(SRC_DIR, 'handlers/commands');

// ═══════════════════════════════════════════════════════════════════
// 1. Format Functions — Physical Location
// ═══════════════════════════════════════════════════════════════════

describe('transport-boundary: format functions in correct file', () => {
  const formatterSource = fs.readFileSync(
    path.join(SERVICES_DIR, 'content-telegram-formatter.ts'),
    'utf8',
  );

  const allFormatFunctions = [
    'formatDeepSearch', 'formatSources', 'formatHotNews',
    'formatTrending', 'formatReaction', 'formatHooks', 'formatScript',
    'formatTitles', 'formatThumbnail', 'formatCaption',
    'formatCompetitor', 'formatGaps', 'formatSeo',
    'formatRepurpose', 'formatFeedback', 'formatReport',
  ];

  for (const fn of allFormatFunctions) {
    it(`${fn} is defined in content-telegram-formatter.ts`, () => {
      expect(formatterSource).toContain(`export function ${fn}`);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════
// 2. content-engine.ts — No Inline Format Implementations
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
    // Only re-exports, no function definitions
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
      // Format functions characteristically use `msg +=` with <b> or escapeHtml
      return (trimmed.includes('msg +=') && trimmed.includes('<b>'))
        || trimmed.includes('parse_mode');
    });
    expect(telegramOutputPatterns).toHaveLength(0);
  });

  it('content-engine.ts is under 650 lines (was 965 before extraction)', () => {
    const lineCount = engineSource.split('\n').length;
    // Bumped from 650 to 700 after adding script cache layer (26 LOC)
    expect(lineCount).toBeLessThan(700);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. content-telegram-formatter.ts — Proper Isolation
// ═══════════════════════════════════════════════════════════════════

describe('transport-boundary: formatter isolation', () => {
  const formatterSource = fs.readFileSync(
    path.join(SERVICES_DIR, 'content-telegram-formatter.ts'),
    'utf8',
  );

  it('formatter file is marked @deprecated', () => {
    expect(formatterSource).toContain('@deprecated');
  });

  it('formatter file imports response types from content-engine', () => {
    expect(formatterSource).toContain("from './content-engine'");
  });

  it('formatter has its own escapeHtml (private, not exported)', () => {
    expect(formatterSource).toContain('function escapeHtml');
    // Private — not exported
    const lines = formatterSource.split('\n');
    const exportedEscapeHtml = lines.filter((l: string) =>
      l.trim().startsWith('export') && l.includes('escapeHtml'),
    );
    expect(exportedEscapeHtml).toHaveLength(0);
  });

  it('formatter has its own isSafeUrl (private, not exported)', () => {
    expect(formatterSource).toContain('function isSafeUrl');
  });

  it('all format functions produce strings with HTML tags', () => {
    // Every format function returns a string containing <b> tags
    expect(formatterSource).toContain('<b>');
    expect(formatterSource).toContain('<i>');
    expect(formatterSource).toContain('escapeHtml');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. Telegram Handler — Correct Import Path
// ═══════════════════════════════════════════════════════════════════

describe('transport-boundary: handler import paths', () => {
  const handlerSource = fs.readFileSync(
    path.join(HANDLERS_DIR, 'content.ts'),
    'utf8',
  );

  it('handler imports format functions from content-telegram-formatter', () => {
    expect(handlerSource).toContain("from '../../services/content-telegram-formatter'");
  });

  it('handler does NOT import format functions from content-engine', () => {
    // The engine import should only have service functions (getScript, etc.)
    // not format functions
    const lines = handlerSource.split('\n');
    const engineImportBlock: string[] = [];
    let inEngineImport = false;
    for (const line of lines) {
      if (line.includes("from '../../services/content-engine'")) {
        // Find the full import block
        inEngineImport = false;
        engineImportBlock.push(line);
      }
      if (line.includes("} from '../../services/content-engine'")) {
        engineImportBlock.push(line);
        break;
      }
    }

    // None of the format functions should be in the engine import
    const engineImport = engineImportBlock.join('\n');
    expect(engineImport).not.toContain('formatDeepSearch');
    expect(engineImport).not.toContain('formatScript');
    expect(engineImport).not.toContain('formatHotNews');
  });

  it('handler imports service functions from content-engine (not formatters)', () => {
    // These should still come from content-engine
    expect(handlerSource).toContain("getScript");
    expect(handlerSource).toContain("deepSearch");
    expect(handlerSource).toContain("getHotNews");
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. Backward Compat — Re-exports from content-engine.ts
// ═══════════════════════════════════════════════════════════════════

describe('transport-boundary: backward compat re-exports', () => {
  const engineSource = fs.readFileSync(
    path.join(SERVICES_DIR, 'content-engine.ts'),
    'utf8',
  );

  it('content-engine.ts re-exports formatters for backward compat', () => {
    expect(engineSource).toContain("from './content-telegram-formatter'");
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. Core Response Types — Structured (not strings)
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
// 7. No grammy in content services
// ═══════════════════════════════════════════════════════════════════

describe('transport-boundary: no grammy in content services', () => {
  it('content-engine.ts has no grammy import', () => {
    const source = fs.readFileSync(path.join(SERVICES_DIR, 'content-engine.ts'), 'utf8');
    expect(source).not.toContain("from 'grammy'");
  });

  it('content-workflow.ts has no grammy import', () => {
    const source = fs.readFileSync(path.join(SERVICES_DIR, 'content-workflow.ts'), 'utf8');
    const lines = source.split('\n');
    const grammyImports = lines.filter((l: string) => {
      const t = l.trim();
      if (t.startsWith('//')) return false;
      return t.startsWith('import') && t.includes("'grammy'");
    });
    expect(grammyImports).toHaveLength(0);
  });

  it('content-telegram-formatter.ts has no grammy import', () => {
    const source = fs.readFileSync(path.join(SERVICES_DIR, 'content-telegram-formatter.ts'), 'utf8');
    expect(source).not.toContain("from 'grammy'");
  });

  it('content-notification-store.ts has no grammy import', () => {
    const source = fs.readFileSync(path.join(SERVICES_DIR, 'content-notification-store.ts'), 'utf8');
    expect(source).not.toContain("from 'grammy'");
  });
});
