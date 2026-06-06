/**
 * Creator Config & Evaluation Suite Tests
 *
 * Covers:
 *   1. Creator config is the canonical single source
 *   2. Shared app-facing content prompts do not inject the owner/founder profile
 *   3. Prompt loader keeps the legacy creator config opt-in only
 *   4. Eval criteria cover script quality and hook quality
 *   5. No Telegram HTML formatting in core prompts
 *   6. SFX/EDIT library centralized in one file
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const PROMPTS_DIR = path.resolve(__dirname, '../../prompts');

// ═══════════════════════════════════════════════════════════════════
// 1. Creator Config — Single Source of Truth
// ═══════════════════════════════════════════════════════════════════

describe('creator-config: single source of truth', () => {
  const configPath = path.join(PROMPTS_DIR, 'creator-config.md');
  const config = fs.readFileSync(configPath, 'utf8');

  it('creator-config.md exists', () => {
    expect(fs.existsSync(configPath)).toBe(true);
  });

  it('contains CREATOR CONFIGURATION header', () => {
    expect(config).toContain('CREATOR CONFIGURATION');
  });

  // Identity-safety (May 2026 audit): creator-config.md is now a NEUTRAL
  // TEMPLATE. It MUST NOT contain a specific creator identity, founder
  // name, owner persona, worldview, audience profile, or political/
  // religious/dietary defaults. Real creator identity is loaded per-
  // request from the authenticated user's saved Voice DNA.

  it('does NOT name a specific creator (no founder identity leak)', () => {
    expect(config).not.toContain('Felipe Dominguez');
    expect(config).not.toContain('"The Operator"');
  });

  it('does NOT hardcode a specific worldview (no political/religious/ideological default)', () => {
    expect(config).not.toMatch(/Conservative Christian/i);
    expect(config).not.toMatch(/Austrian Economics/i);
    expect(config).not.toMatch(/Non-Aggression Principle/i);
    expect(config).not.toMatch(/Libertarian \/ anti-state/i);
  });

  it('does NOT hardcode specific content pillars or quota percentages', () => {
    expect(config).not.toMatch(/AI\/Tech.*~35%/i);
    expect(config).not.toMatch(/Commentary\/Reactions.*~30%/i);
    expect(config).not.toMatch(/Training\/Lifestyle.*~20%/i);
  });

  it('defines SFX library', () => {
    expect(config).toContain('SFX LIBRARY');
    expect(config).toContain('Vine Boom');
    expect(config).toContain('FAHHH');
    expect(config).toContain('Metal Pipe');
  });

  it('defines editing techniques', () => {
    expect(config).toContain('EDITING TECHNIQUES');
    expect(config).toContain('zoom punch');
    expect(config).toContain('speed ramp');
    expect(config).toContain('chaos layering');
  });

  it('defines density guide', () => {
    expect(config).toContain('DENSITY GUIDE');
    expect(config).toContain('12-15 seconds');
    expect(config).toContain('2-3 SFX per minute');
  });

  it('defines content accuracy rules', () => {
    expect(config).toContain('CONTENT ACCURACY');
    expect(config).toContain('NEEDS VERIFICATION');
    expect(config).toContain('VERIFIED: source');
    // Identity-safety: the published-asset language must NOT be hardcoded
    // PT-BR. The verified-sources rule is now language-neutral.
    expect(config).toContain('verified-sources');
  });

  it('defines output format without HTML', () => {
    expect(config).toContain('OUTPUT FORMAT');
    expect(config).toContain('Do NOT use HTML tags');
  });

  it('does NOT hardcode a specific target audience (May 2026 audit)', () => {
    // The neutral template tells callers to use the authenticated user's
    // saved target audience, never a single demographic default.
    expect(config).not.toContain('Male, Brazilian, 18-35');
    expect(config).not.toContain('Portuguese-speaking men 18-40');
  });

  it('explicitly tells callers to load identity per-request from authenticated user', () => {
    expect(config).toContain('authenticated');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. Content Prompts Reference Config (No Duplication)
// ═══════════════════════════════════════════════════════════════════

describe('creator-config: prompts keep owner profile out of shared app-facing defaults', () => {
  it('content.md does not use the global {{CREATOR_CONFIG}} placeholder', () => {
    const content = fs.readFileSync(path.join(PROMPTS_DIR, 'content.md'), 'utf8');
    expect(content).not.toContain('{{CREATOR_CONFIG}}');
    expect(content).not.toContain('Felipe');
    expect(content).not.toContain('The Operator');
  });

  it('topic-generation.md does not use the global {{CREATOR_CONFIG}} placeholder', () => {
    const topicGen = fs.readFileSync(path.join(PROMPTS_DIR, 'topic-generation.md'), 'utf8');
    expect(topicGen).not.toContain('{{CREATOR_CONFIG}}');
    expect(topicGen).not.toContain('Felipe');
    expect(topicGen).not.toContain('The Operator');
  });

  it('content.md does NOT duplicate worldview inline', () => {
    const content = fs.readFileSync(path.join(PROMPTS_DIR, 'content.md'), 'utf8');
    // Should not contain the old inline worldview block
    expect(content).not.toContain('Austrian Economics');
    expect(content).not.toContain('von Mises');
    expect(content).not.toContain('Conservative Christian');
  });

  it('topic-generation.md does NOT duplicate worldview inline', () => {
    const topicGen = fs.readFileSync(path.join(PROMPTS_DIR, 'topic-generation.md'), 'utf8');
    expect(topicGen).not.toContain('Austrian Economics');
    expect(topicGen).not.toContain('von Mises');
    expect(topicGen).not.toContain('Conservative Christian');
  });

  it('content.md does NOT duplicate SFX library', () => {
    const content = fs.readFileSync(path.join(PROMPTS_DIR, 'content.md'), 'utf8');
    expect(content).not.toContain('Vine Boom');
    expect(content).not.toContain('SFX LIBRARY');
  });

  it('content.md does NOT duplicate pillar percentages', () => {
    const content = fs.readFileSync(path.join(PROMPTS_DIR, 'content.md'), 'utf8');
    expect(content).not.toContain('≈35%');
    expect(content).not.toContain('≈30%');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. No Telegram HTML in Core Prompts
// ═══════════════════════════════════════════════════════════════════

describe('creator-config: no Telegram HTML', () => {
  it('creator-config.md does not USE HTML tags (mentions them only in "Do NOT use" rule)', () => {
    const config = fs.readFileSync(path.join(PROMPTS_DIR, 'creator-config.md'), 'utf8');
    // The config mentions <b>, <i> etc. in the "Do NOT use HTML tags" instruction.
    // That's correct — it's telling the AI not to use them, not using them itself.
    // Verify there's no actual HTML formatting in the config (no parse_mode, no Telegram).
    expect(config).not.toContain('parse_mode');
    expect(config).not.toContain('Telegram');
    // The "Do NOT use HTML tags" line is the ONLY place HTML tags appear
    const lines = config.split('\n');
    const htmlLines = lines.filter(l =>
      (l.includes('<b>') || l.includes('<i>') || l.includes('<code>'))
      && !l.includes('Do NOT use HTML tags'),
    );
    expect(htmlLines).toHaveLength(0);
  });

  it('content.md has no HTML tags', () => {
    const content = fs.readFileSync(path.join(PROMPTS_DIR, 'content.md'), 'utf8');
    expect(content).not.toContain('<b>');
    expect(content).not.toContain('<i>');
    expect(content).not.toContain('Telegram');
  });

  it('topic-generation.md has no HTML tags', () => {
    const topicGen = fs.readFileSync(path.join(PROMPTS_DIR, 'topic-generation.md'), 'utf8');
    expect(topicGen).not.toContain('<b>');
    expect(topicGen).not.toContain('<i>');
    expect(topicGen).not.toContain('Telegram');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. Prompt Loader Config Injection
// ═══════════════════════════════════════════════════════════════════

vi.mock('../../src/services/database', () => ({
  getDb: () => ({
    prepare: () => ({ run: vi.fn(), get: vi.fn(), all: vi.fn().mockReturnValue([]) }),
  }),
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

vi.mock('../../src/config', () => ({
  config: { anthropic: { apiKey: 'test' }, app: { timezone: 'Europe/Lisbon' } },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

describe('creator-config: prompt loader', () => {
  it('loadCreatorConfig returns the neutral template (no founder identity)', async () => {
    const { loadCreatorConfig } = await import('../../src/utils/prompt-loader');
    const config = loadCreatorConfig();
    expect(config).toContain('CREATOR CONFIGURATION');
    // Identity-safety: the neutral template does NOT carry a specific
    // creator identity. Real identity is loaded per-request from the
    // authenticated user's saved Voice DNA.
    expect(config).not.toContain('"The Operator"');
    expect(config).not.toContain('Felipe Dominguez');
  });

  it('loadPromptWithConfig does not inject creator config into content.md without an explicit placeholder', async () => {
    const { loadPromptWithConfig } = await import('../../src/utils/prompt-loader');
    const content = loadPromptWithConfig('content');
    expect(content).not.toContain('{{CREATOR_CONFIG}}');
    expect(content).not.toContain('The Operator');
    expect(content).not.toContain('Felipe Dominguez');
    expect(content).not.toContain('Austrian Economics');
    expect(content).not.toContain('SFX LIBRARY');
  });

  it('loadPromptWithConfig does not inject owner profile into topic-generation.md without an explicit placeholder', async () => {
    const { loadPromptWithConfig } = await import('../../src/utils/prompt-loader');
    const topicGen = loadPromptWithConfig('topic-generation', {
      FORMAT_DESC: 'test format',
      TRENDING_INSTRUCTION: 'test trending',
    });
    expect(topicGen).not.toContain('{{CREATOR_CONFIG}}');
    expect(topicGen).not.toContain('The Operator');
    expect(topicGen).not.toContain('Felipe Dominguez');
    expect(topicGen).toContain('test format');
  });

  it('anthropic content prompt path uses the neutral content prompt, not global creator-config injection', () => {
    const anthropicSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/services/anthropic.ts'),
      'utf8',
    );
    expect(anthropicSource).toContain('basePrompt = loadPrompt(domain)');
    expect(anthropicSource).not.toContain('loadPromptWithConfig(domain)');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. Eval Criteria — Script Quality & Hook Quality Targets
// ═══════════════════════════════════════════════════════════════════

import { getEvalTarget, getAllTargets, getTargetIds } from '../../src/services/eval-criteria';

describe('creator-config: eval criteria', () => {
  it('script_quality target exists', () => {
    const target = getEvalTarget('script_quality');
    expect(target).toBeDefined();
    expect(target!.id).toBe('script_quality');
  });

  it('script_quality has 7 criteria', () => {
    const target = getEvalTarget('script_quality')!;
    expect(target.criteria).toHaveLength(7);
    const ids = target.criteria.map(c => c.id);
    expect(ids).toContain('voice_fit');
    expect(ids).toContain('hook_strength');
    expect(ids).toContain('title_usefulness');
    expect(ids).toContain('source_grounding');
    expect(ids).toContain('format_compliance');
    expect(ids).toContain('signal_usefulness');
    expect(ids).toContain('overall_quality');
  });

  it('script_quality has 5 test inputs', () => {
    const target = getEvalTarget('script_quality')!;
    expect(target.testInputs).toHaveLength(5);
    // Should cover different pillars
    const descriptions = target.testInputs.map(t => t.description);
    expect(descriptions.some(d => d.includes('Tech'))).toBe(true);
    expect(descriptions.some(d => d.includes('Reaction'))).toBe(true);
    expect(descriptions.some(d => d.includes('training'))).toBe(true);
    expect(descriptions.some(d => d.includes('Economics'))).toBe(true);
  });

  it('hook_quality target exists', () => {
    const target = getEvalTarget('hook_quality');
    expect(target).toBeDefined();
    expect(target!.id).toBe('hook_quality');
  });

  it('hook_quality has 4 criteria', () => {
    const target = getEvalTarget('hook_quality')!;
    expect(target.criteria).toHaveLength(4);
    const ids = target.criteria.map(c => c.id);
    expect(ids).toContain('specificity');
    expect(ids).toContain('scroll_stop');
    expect(ids).toContain('pt_br_natural');
    expect(ids).toContain('brand_voice');
  });

  it('total eval targets is now 8', () => {
    const all = getAllTargets();
    expect(all.length).toBe(8);
  });

  it('getTargetIds returns all 8 IDs', () => {
    const ids = getTargetIds();
    expect(ids).toHaveLength(8);
    expect(ids).toContain('secretary');
    expect(ids).toContain('content');
    expect(ids).toContain('script_quality');
    expect(ids).toContain('hook_quality');
  });

  it('voice_fit criterion has highest weight (3)', () => {
    const target = getEvalTarget('script_quality')!;
    const voiceFit = target.criteria.find(c => c.id === 'voice_fit');
    expect(voiceFit!.weight).toBe(3);
  });

  it('source_grounding references VERIFIED and NEEDS VERIFICATION tags', () => {
    const target = getEvalTarget('script_quality')!;
    const sourceGrounding = target.criteria.find(c => c.id === 'source_grounding');
    expect(sourceGrounding!.question).toContain('VERIFIED');
    expect(sourceGrounding!.question).toContain('NEEDS VERIFICATION');
    expect(sourceGrounding!.question).toContain('FONTES VERIFICADAS');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. Config Consistency — Python Creator Profile
// ═══════════════════════════════════════════════════════════════════

describe('creator-config: consistency with Python', () => {
  const pyProfilePath = path.resolve(__dirname, '../../content-engine/services/creator_profile.py');
  const pyExists = fs.existsSync(pyProfilePath);

  it.skipIf(!pyExists)('Python creator_profile.py reads from canonical creator-config.md', () => {
    const py = fs.readFileSync(pyProfilePath, 'utf8');

    // The Python file should reference the canonical config file path,
    // NOT duplicate the config values inline.
    expect(py).toContain('creator-config.md');
    expect(py).toContain('_CONFIG_PATH');
    expect(py).toContain('_load_config');
  });

  it.skipIf(!pyExists)('Canonical creator-config.md is now a NEUTRAL template (May 2026 audit)', () => {
    const config = fs.readFileSync(path.join(PROMPTS_DIR, 'creator-config.md'), 'utf8');
    // Identity-safety: Python (and TS) consumers now read the SAME
    // creator-config.md, but the file is NEUTRAL — no founder identity,
    // no worldview defaults, no pillar-percentage hardcoding, no
    // political/economic-philosophy lexicon. Real creator identity is
    // loaded per-request from the authenticated user's saved Voice DNA
    // (see content-creative-memory and tenant-scoped services).
    expect(config).not.toContain('35%');
    expect(config).not.toContain('Austrian Economics');
    expect(config).not.toContain('Mises');
    expect(config).not.toContain('Hayek');
    // The neutral template still names the doc category and the
    // user-scoped guidance.
    expect(config).toContain('CREATOR CONFIGURATION');
    expect(config).toContain('NEUTRAL TEMPLATE');
    expect(config).toContain('authenticated');
  });
});
