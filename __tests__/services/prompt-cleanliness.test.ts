/**
 * Prompt Cleanliness — No Telegram-era assumptions in core prompts.
 *
 * Verifies that domain prompts are transport-agnostic and the system
 * is described as an iOS-first product, not a Telegram bot.
 *
 * Covers:
 *   1. No "Telegram HTML only" blocks in domain prompts
 *   2. No HTML tag instructions in formatting sections
 *   3. System descriptions say "iOS app" not "Telegram bot"
 *   4. Content command labels are not slash-commands
 *   5. Chat fastpath is framed as app actions
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const PROMPTS_DIR = path.resolve(__dirname, '../../prompts');
const SRC_DIR = path.resolve(__dirname, '../../src');

// ═══════════════════════════════════════════════════════════════════
// 1. Domain Prompts — No Telegram Formatting
// ═══════════════════════════════════════════════════════════════════

const DOMAIN_PROMPTS = [
  'secretary.md',
  'finance.md',
  'cooking.md',
  'triathlon.md',
  'triathlon/swim.md',
  'triathlon/running.md',
  'triathlon/gym.md',
  'triathlon/cycling.md',
  'content.md',
  'creator-config.md',
  'topic-generation.md',
];

describe('prompt-cleanliness: no Telegram formatting in domain prompts', () => {
  for (const promptFile of DOMAIN_PROMPTS) {
    const filePath = path.join(PROMPTS_DIR, promptFile);
    if (!fs.existsSync(filePath)) continue;

    describe(promptFile, () => {
      const content = fs.readFileSync(filePath, 'utf8');

      it('does not contain "Telegram HTML only"', () => {
        expect(content).not.toContain('Telegram HTML only');
      });

      it('does not contain "Use ONLY these HTML tags"', () => {
        expect(content).not.toContain('Use ONLY these HTML tags');
      });

      it('does not contain "parse_mode"', () => {
        expect(content).not.toContain('parse_mode');
      });

      it('does not mention "Telegram" as the primary surface', () => {
        // Allow "Telegram" only in legacy/deprecation context, not as product identity
        const lines = content.split('\n');
        const telegramLines = lines.filter((l: string) => {
          const t = l.trim();
          // Skip lines that explicitly mark Telegram as legacy
          if (t.includes('legacy') || t.includes('Legacy') || t.includes('deprecated')) return false;
          return t.includes('Telegram bot') || t.includes('the bot sends') || t.includes('sends Telegram');
        });
        expect(telegramLines).toHaveLength(0);
      });
    });
  }
});

describe('prompt-cleanliness: training prompts are not founder-persona prompts', () => {
  const trainingPrompts = [
    'triathlon.md',
    'triathlon/swim.md',
    'triathlon/running.md',
    'triathlon/gym.md',
    'triathlon/cycling.md',
  ];
  const founderPersonaPattern = /Felipe|The Operator|4-5x\/week|never suggest plant-based|Carnivore default|Carnivore diet/i;

  for (const promptFile of trainingPrompts) {
    it(`${promptFile} avoids single-tenant founder defaults`, () => {
      const content = fs.readFileSync(path.join(PROMPTS_DIR, promptFile), 'utf8');
      expect(content).not.toMatch(founderPersonaPattern);
    });
  }
});

describe('prompt-cleanliness: shared app-facing prompts are not founder-persona prompts', () => {
  const appFacingPrompts = [
    'secretary.md',
    'finance.md',
    'cooking.md',
    'content.md',
    'topic-generation.md',
    // Identity-safety (May 2026 audit): creator-config.md is auto-injected
    // anywhere `{{CREATOR_CONFIG}}` is used. It MUST stay free of any
    // specific creator identity, founder name, owner persona, worldview,
    // or audience profile — those values are loaded per-request from the
    // authenticated user's saved Voice DNA / creator memory rows.
    'creator-config.md',
    // Identity-safety: cross-skill-and-memory.md doc was historically a
    // founder-persona feature spec ("Felipe says /remember ..."). The
    // May 2026 audit rewrote it to be authenticated-user-scoped; this
    // regression test pins that the rewrite stays.
    'cross-skill-and-memory.md',
  ];
  const founderPersonaPattern = /\bFelipe\b|Felipe's|"The Operator"|founder routines|Brazilian freelancer \(PJ|Carnivore default|Carnivore diet/i;

  for (const promptFile of appFacingPrompts) {
    it(`${promptFile} avoids hardcoded founder identity defaults`, () => {
      const content = fs.readFileSync(path.join(PROMPTS_DIR, promptFile), 'utf8');
      expect(content).not.toMatch(founderPersonaPattern);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════
// Identity-safety: skill-bundled prompts must also avoid founder defaults
// ═══════════════════════════════════════════════════════════════════

describe('prompt-cleanliness: skill-bundled prompts are not founder-persona prompts', () => {
  // Skills under src/skills/<skill>/prompts/system.md are loaded by the
  // skill manager at runtime. Any user enabling the skill receives the
  // skill prompt; therefore the skill prompts must be authenticated-user
  // scoped — never hardcode "founder-athlete-creator" or single-tenant
  // defaults.
  const skillPromptFiles = [
    path.join(SRC_DIR, 'skills/secretary/prompts/system.md'),
    path.join(SRC_DIR, 'skills/finance/prompts/system.md'),
  ];
  const founderPersonaPattern =
    /\bFelipe\b|Felipe's|"The Operator"|founder routines|founder-athlete-creator|founder\/athlete\/creator|founder, athlete, creator|Brazilian freelancer \(PJ|Carnivore default|Carnivore diet|strong Brazilian tax literacy/i;

  for (const filePath of skillPromptFiles) {
    if (!fs.existsSync(filePath)) continue;
    const relativeName = filePath.split('/skills/')[1];
    it(`skill prompt ${relativeName} avoids hardcoded founder identity defaults`, () => {
      const content = fs.readFileSync(filePath, 'utf8');
      expect(content).not.toMatch(founderPersonaPattern);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════
// 2. System Descriptions — iOS-First
// ═══════════════════════════════════════════════════════════════════

describe('prompt-cleanliness: system descriptions are iOS-first', () => {
  it('cross-skill-and-memory.md describes system as iOS-first', () => {
    const content = fs.readFileSync(path.join(PROMPTS_DIR, 'cross-skill-and-memory.md'), 'utf8');
    expect(content).toContain('iOS app');
    expect(content).not.toContain('Nexus Hub is a Telegram bot');
  });

  it('daily-content-discovery.md describes system as iOS-first', () => {
    // This old feature prompt contains founder-specific design notes and
    // must stay archived, not loaded as a live runtime prompt.
    expect(fs.existsSync(path.join(PROMPTS_DIR, 'daily-content-discovery.md'))).toBe(false);
    expect(
      fs.existsSync(path.resolve(__dirname, '../../docs/archive/2026-05/content/daily-content-discovery.md')),
    ).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. Content Command Labels — Not Slash Commands
// ═══════════════════════════════════════════════════════════════════

describe('prompt-cleanliness: content commands use operation labels', () => {
  it('CONTENT_COMMANDS labels do not start with /', () => {
    const source = fs.readFileSync(
      path.join(SRC_DIR, 'api/routes/content-dashboard.ts'),
      'utf8',
    );

    // Extract label values from the CONTENT_COMMANDS array
    const labelMatches = source.matchAll(/label:\s*'([^']+)'/g);
    const labels = Array.from(labelMatches).map(m => m[1]);

    expect(labels.length).toBeGreaterThan(10); // Sanity: found labels
    for (const label of labels) {
      expect(label).not.toMatch(/^\//); // No label starts with /
    }
  });

  it('command registry doc comment does not say "slash command"', () => {
    const source = fs.readFileSync(
      path.join(SRC_DIR, 'api/routes/content-dashboard.ts'),
      'utf8',
    );
    // The doc comment above CONTENT_COMMANDS should not frame these as slash commands
    const lines = source.split('\n');
    const registryDoc = lines.slice(
      lines.findIndex(l => l.includes('Content operations registry')),
      lines.findIndex(l => l.includes('Content operations registry')) + 8,
    ).join('\n');
    expect(registryDoc).not.toContain('slash command');
    expect(registryDoc.toLowerCase()).toContain('content operations');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. Chat Fastpath — App Actions, Not Bot Commands
// ═══════════════════════════════════════════════════════════════════

describe('prompt-cleanliness: chat fastpath is app-framed', () => {
  it('chat-fastpath.ts JSDoc says "iOS chat endpoint"', () => {
    const source = fs.readFileSync(
      path.join(SRC_DIR, 'api/routes/chat-fastpath.ts'),
      'utf8',
    );
    expect(source).toContain('iOS chat endpoint');
    expect(source).not.toContain('slash commands and answers them');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. Formatting Instructions — Consistent "Do NOT use HTML" Pattern
// ═══════════════════════════════════════════════════════════════════

describe('prompt-cleanliness: formatting instructions are transport-agnostic', () => {
  const promptsWithFormatting = [
    'secretary.md', 'finance.md', 'cooking.md', 'triathlon.md',
    'triathlon/swim.md', 'triathlon/running.md', 'triathlon/gym.md',
    'triathlon/cycling.md', 'creator-config.md',
  ];

  for (const promptFile of promptsWithFormatting) {
    const filePath = path.join(PROMPTS_DIR, promptFile);
    if (!fs.existsSync(filePath)) continue;

    it(`${promptFile} says "Do NOT use HTML tags"`, () => {
      const content = fs.readFileSync(filePath, 'utf8');
      expect(content).toContain('Do NOT use HTML tags');
    });
  }
});
