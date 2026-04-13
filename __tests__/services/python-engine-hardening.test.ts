// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Regression tests for Python content-engine hardening (April 2026).
 *
 * These tests verify the structural fixes by reading the Python source
 * files and checking for the presence/absence of key patterns. This is
 * a pragmatic approach since the Python engine doesn't have its own
 * test framework — we validate that the code changes are correct by
 * inspecting the source.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ENGINE_DIR = path.join(__dirname, '..', '..', 'content-engine', 'services');

function readPy(relativePath: string): string {
  return fs.readFileSync(path.join(ENGINE_DIR, relativePath), 'utf-8');
}

describe('Python claude_client.py — routes through TS AI proxy', () => {
  const src = readPy('claude_client.py');

  it('calls TS backend AI proxy instead of Anthropic directly', () => {
    expect(src).toContain('/api/v1/internal/ai-complete');
    // Must NOT call Anthropic API directly
    expect(src).not.toContain('api.anthropic.com');
  });

  it('does NOT import or use Anthropic API key', () => {
    expect(src).not.toContain('x-api-key');
    expect(src).not.toContain('anthropic_api_key');
    expect(src).not.toContain('anthropic-version');
  });

  it('accepts category parameter for cost attribution', () => {
    expect(src).toContain('category: str = "content_engine"');
  });

  it('reads INTERNAL_API_SECRET from env', () => {
    expect(src).toContain('INTERNAL_API_SECRET');
  });

  it('keeps MODEL and FAST_MODEL constants for backward compat', () => {
    expect(src).toContain('MODEL =');
    expect(src).toContain('FAST_MODEL =');
  });

  it('sends shared secret in x-internal-secret header', () => {
    expect(src).toContain('x-internal-secret');
  });

  it('logs which provider was used', () => {
    expect(src).toContain('provider');
  });
});

describe('Python feedback_loop.py — no more feedback.json', () => {
  const src = readPy(path.join('learning', 'feedback_loop.py'));

  it('does NOT have _load_history or _save_history functions', () => {
    expect(src).not.toContain('def _load_history');
    expect(src).not.toContain('def _save_history');
  });

  it('does NOT use FEEDBACK_FILE constant', () => {
    expect(src).not.toContain('FEEDBACK_FILE');
  });

  it('does NOT write JSON files', () => {
    expect(src).not.toContain('json.dump(');
  });

  it('still calls Claude for analysis', () => {
    expect(src).toContain('ask_claude_json');
  });

  it('passes category to ask_claude_json', () => {
    expect(src).toContain('category="content_engine_feedback"');
  });
});

describe('Python report_gen.py — no more feedback.json', () => {
  const src = readPy(path.join('learning', 'report_gen.py'));

  it('does NOT use FEEDBACK_FILE constant or load from JSON file', () => {
    expect(src).not.toContain('FEEDBACK_FILE');
    expect(src).not.toContain('_load_history');
    expect(src).not.toContain('json.load(f)');
  });

  it('fetches from TS backend instead', () => {
    expect(src).toContain('_fetch_performance_history');
    expect(src).toContain('/api/v1/internal/performance-summary');
  });

  it('passes category to ask_claude_json', () => {
    expect(src).toContain('category="content_engine_report"');
  });
});

describe('Python script_writer.py — JSON metadata parsing', () => {
  const src = readPy(path.join('creative', 'script_writer.py'));

  it('instructs Claude to output ---METADATA--- separator', () => {
    expect(src).toContain('---METADATA---');
  });

  it('parses JSON metadata block', () => {
    expect(src).toContain('json.loads(metadata_raw)');
  });

  it('has fallback to legacy line parsing', () => {
    expect(src).toContain('_fallback_parse');
    expect(src).toContain('def _fallback_parse');
  });

  it('passes category to ask_claude', () => {
    expect(src).toContain('category="content_engine_script"');
  });
});

describe('Python book_knowledge.py — no hallucination on empty search', () => {
  const src = readPy('book_knowledge.py');

  it('does NOT ask Claude to "Use your knowledge"', () => {
    expect(src).not.toContain('Use your knowledge');
  });

  it('returns partial BookDNA when search is empty', () => {
    expect(src).toContain('[LOW CONFIDENCE]');
    expect(src).toContain('return BookDNA(');
  });

  it('logs a warning when search returns empty', () => {
    expect(src).toContain('No web search results for');
  });

  it('passes category to ask_claude_json', () => {
    expect(src).toContain('category="content_engine_book"');
  });
});

describe('Python creator_profile.py — reads from canonical config', () => {
  const src = readPy('creator_profile.py');

  it('reads from prompts/creator-config.md', () => {
    expect(src).toContain('creator-config.md');
    expect(src).toContain('_CONFIG_PATH');
  });

  it('does NOT have hardcoded CREATOR_PROFILE block', () => {
    // The old file had 60+ lines of hardcoded profile text
    // The new file reads from the canonical config file
    expect(src).not.toContain('BRAND PILLARS (not niches');
    expect(src).not.toContain('Asmongold-style delivery');
  });

  it('has a fallback for when the config file is missing', () => {
    expect(src).toContain('_FALLBACK_PROFILE');
    expect(src).toContain('FileNotFoundError');
  });
});
