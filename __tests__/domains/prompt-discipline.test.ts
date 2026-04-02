/**
 * Prompt Discipline Tests — Anti-Hallucination Guards
 *
 * Validates that all domain system prompts contain explicit response discipline
 * rules to prevent the bot from generating unsolicited status reports, briefings,
 * or irrelevant content. This is a regression guard for the P0 hallucination bug
 * where the bot invented status reports instead of executing user commands.
 *
 * Root cause: system prompts were too verbose with briefing templates and lacked
 * explicit instructions to respond only to what was asked. Combined with heavy
 * context injection ([Current State] with todos, calendar, Garmin), Claude would
 * treat every message as a briefing request.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const PROMPTS_DIR = path.resolve(__dirname, '..', '..', 'prompts');

function readPrompt(name: string): string {
  return fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), 'utf-8');
}

// ═══════════════════════════════════════════════════════════════════
// RESPONSE DISCIPLINE — All domain prompts must have anti-hallucination rules
// ═══════════════════════════════════════════════════════════════════

describe('Prompt discipline — anti-hallucination guards', () => {
  const DOMAIN_PROMPTS = ['secretary', 'triathlon', 'content'] as const;

  describe.each(DOMAIN_PROMPTS)('%s prompt', (domain) => {
    let prompt: string;

    beforeAll(() => {
      prompt = readPrompt(domain);
    });

    it('contains RESPONSE DISCIPLINE section', () => {
      expect(prompt).toContain('RESPONSE DISCIPLINE');
    });

    it('instructs to respond only to what was asked', () => {
      expect(prompt).toMatch(/respond\s+only\s+to\s+what\s+the\s+user\s+(actually\s+)?asked/i);
    });

    it('warns against unsolicited content generation', () => {
      // Each domain should warn against generating unsolicited content
      expect(prompt).toMatch(/(?:never|do\s+not)\s+generate\s+unsolicited/i);
    });

    it('instructs not to summarize [Current State] unprompted', () => {
      expect(prompt).toMatch(/\[current\s+state\].*(?:reference|context)\s+data/i);
    });

    it('has greeting handling instruction', () => {
      // Must mention greetings and brief/briefly somewhere in the prompt
      expect(prompt).toMatch(/greetings?/i);
      expect(prompt).toMatch(/brief/i);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// SECRETARY-SPECIFIC — Briefing templates must be conditional
// ═══════════════════════════════════════════════════════════════════

describe('Secretary prompt — conditional briefing templates', () => {
  let prompt: string;

  beforeAll(() => {
    prompt = readPrompt('secretary');
  });

  it('makes briefing templates conditional on explicit user request', () => {
    // The prompt must contain language making templates conditional
    expect(prompt).toMatch(/only\s+when\s+.*(?:explicitly|user)\s+(?:asks|requests)/i);
  });

  it('still contains daily overview template', () => {
    expect(prompt).toContain('AGENDA');
    expect(prompt).toContain('ALERTAS');
  });

  it('still contains weekly overview template', () => {
    expect(prompt).toContain('SEMANA');
    expect(prompt).toContain('BALANÇO');
  });

  it('contains instruction for unknown commands', () => {
    expect(prompt).toMatch(/unknown\s+commands?/i);
  });

  it('instructs to execute actions briefly without status report', () => {
    expect(prompt).toMatch(/confirm\s+briefly/i);
  });

  it('uses Telegram HTML formatting only', () => {
    expect(prompt).toContain('Telegram HTML only');
    expect(prompt).toContain('NEVER use markdown');
  });
});

// ═══════════════════════════════════════════════════════════════════
// PROMPT SIZE — Guard against unbounded growth
// ═══════════════════════════════════════════════════════════════════

describe('Prompt size limits', () => {
  const MAX_PROMPT_CHARS: Record<string, number> = {
    secretary: 4500,   // includes briefing templates + tool instructions
    triathlon: 3200,   // includes response discipline block (grew with anti-hallucination guards)
    content: 6000,     // legitimately large (SFX library, accuracy rules, script rules)
    classifier: 2000,  // includes JSON format examples
  };

  it.each(Object.entries(MAX_PROMPT_CHARS))(
    '%s prompt stays under %d characters',
    (name, maxChars) => {
      const prompt = readPrompt(name);
      expect(prompt.length).toBeLessThanOrEqual(maxChars);
    },
  );
});
