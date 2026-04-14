/**
 * Creator Config & Evaluation Suite Tests
 *
 * Covers:
 *   1. Creator config is the canonical single source
 *   2. Content prompts reference config via {{CREATOR_CONFIG}}, not inline duplication
 *   3. Prompt loader injects config correctly
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

  it('defines brand identity', () => {
    expect(config).toContain('The Operator');
    expect(config).toContain('Felipe Dominguez');
  });

  it('defines all 5 content pillars', () => {
    expect(config).toContain('AI/Tech');
    expect(config).toContain('Commentary/Reactions');
    expect(config).toContain('Training/Lifestyle');
    expect(config).toContain('Gaming');
    expect(config).toContain('Wild Cards');
  });

  it('defines worldview', () => {
    expect(config).toContain('Conservative Christian');
    expect(config).toContain('Austrian Economics');
    expect(config).toContain('Non-Aggression Principle');
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
    expect(config).toContain('FONTES VERIFICADAS');
  });

  it('defines output format without HTML', () => {
    expect(config).toContain('OUTPUT FORMAT');
    expect(config).toContain('Do NOT use HTML tags');
  });

  it('defines target audience', () => {
    expect(config).toContain('Male, Brazilian, 18-35');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. Content Prompts Reference Config (No Duplication)
// ═══════════════════════════════════════════════════════════════════

describe('creator-config: prompts reference config', () => {
  it('content.md uses {{CREATOR_CONFIG}} placeholder', () => {
    const content = fs.readFileSync(path.join(PROMPTS_DIR, 'content.md'), 'utf8');
    expect(content).toContain('{{CREATOR_CONFIG}}');
  });

  it('topic-generation.md uses {{CREATOR_CONFIG}} placeholder', () => {
    const topicGen = fs.readFileSync(path.join(PROMPTS_DIR, 'topic-generation.md'), 'utf8');
    expect(topicGen).toContain('{{CREATOR_CONFIG}}');
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
}));

vi.mock('../../src/config', () => ({
  config: { anthropic: { apiKey: 'test' }, app: { timezone: 'Europe/Lisbon' } },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
}));

describe('creator-config: prompt loader', () => {
  it('loadCreatorConfig returns creator config content', async () => {
    const { loadCreatorConfig } = await import('../../src/utils/prompt-loader');
    const config = loadCreatorConfig();
    expect(config).toContain('CREATOR CONFIGURATION');
    expect(config).toContain('The Operator');
  });

  it('loadPromptWithConfig injects creator config into content.md', async () => {
    const { loadPromptWithConfig } = await import('../../src/utils/prompt-loader');
    const content = loadPromptWithConfig('content');
    // After injection, the {{CREATOR_CONFIG}} placeholder should be gone
    expect(content).not.toContain('{{CREATOR_CONFIG}}');
    // And the config content should be present
    expect(content).toContain('The Operator');
    expect(content).toContain('Austrian Economics');
    expect(content).toContain('SFX LIBRARY');
  });

  it('loadPromptWithConfig injects into topic-generation.md', async () => {
    const { loadPromptWithConfig } = await import('../../src/utils/prompt-loader');
    const topicGen = loadPromptWithConfig('topic-generation', {
      FORMAT_DESC: 'test format',
      TRENDING_INSTRUCTION: 'test trending',
    });
    expect(topicGen).not.toContain('{{CREATOR_CONFIG}}');
    expect(topicGen).toContain('The Operator');
    expect(topicGen).toContain('test format');
  });

  it('anthropic content prompt path uses loadPromptWithConfig for content domain', () => {
    const anthropicSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/services/anthropic.ts'),
      'utf8',
    );
    expect(anthropicSource).toContain("basePrompt = domain === 'content'");
    expect(anthropicSource).toContain("? loadPromptWithConfig(domain)");
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

  it.skipIf(!pyExists)('Canonical creator-config.md contains required worldview values', () => {
    const config = fs.readFileSync(path.join(PROMPTS_DIR, 'creator-config.md'), 'utf8');
    // The config (which Python now reads) should contain these values
    expect(config).toContain('35%');
    expect(config).toContain('30%');
    expect(config).toContain('20%');
    expect(config).toContain('Austrian Economics');
    expect(config).toContain('Mises');
    expect(config).toContain('Hayek');
  });
});
