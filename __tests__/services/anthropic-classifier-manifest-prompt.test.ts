/**
 * M15 — getClassifierSystemPrompt flag gating.
 *
 *  - Flag OFF (default): the legacy prompts/classifier.md string is used
 *    VERBATIM (plus the pre-existing skill-hints block) — byte parity with
 *    pre-M15 behavior.
 *  - Flag ON (AI_CLASSIFY_MANIFEST_PROMPT=true): the manifest-generated
 *    build artifact prompts/classifier-manifest.md is served byte-identically.
 *  - Master kill (AI_ROUTING_MANIFEST_KILL=true) forces the legacy prompt
 *    even when the flag is on.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getClassifierSystemPrompt } from '../../src/services/anthropic';
import { buildManifestClassifierPrompt } from '../../src/router/classifier-prompt-builder';
import { getClassificationHints } from '../../src/skills/skill-config';
import { resetPromptLoaderForTests } from '../../src/utils/prompt-loader';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const CHAT_ROUTABLE = new Set(['secretary', 'triathlon', 'content', 'finance', 'cooking']);

/**
 * Byte-exact replica of the pre-M15 legacy prompt algorithm. The hints block
 * is appended through a runtime `require` inside a try/catch in
 * getClassifierSystemPrompt; under vitest that interop can fail (caught →
 * base prompt only), so BOTH legal legacy outputs are accepted — but the
 * classifier.md prefix must be byte-verbatim in every case.
 */
function expectedLegacyPrompts(): string[] {
  const basePrompt = fs.readFileSync(path.join(REPO_ROOT, 'prompts', 'classifier.md'), 'utf-8');
  const hints = getClassificationHints().filter((h) => CHAT_ROUTABLE.has(h.label));
  if (!hints.length) return [basePrompt];
  const block = hints
    .map((h) => {
      const examples = Array.isArray((h as { examples?: string[] }).examples)
        ? (h as { examples: string[] }).examples.slice(0, 3)
        : [];
      const exampleLine = examples.length ? ` Examples: ${examples.map((e) => `"${e}"`).join(', ')}.` : '';
      return `- "${h.label}" → ${h.description}${exampleLine}`;
    })
    .join('\n');
  return [
    basePrompt,
    `${basePrompt}\n\nSkill-level hints for the 5 chat-routable domains (additive to the blurbs above):\n${block}`,
  ];
}

function expectLegacyPrompt(prompt: string): void {
  const basePrompt = fs.readFileSync(path.join(REPO_ROOT, 'prompts', 'classifier.md'), 'utf-8');
  // Old prompt string used VERBATIM as the prefix…
  expect(prompt.startsWith(basePrompt)).toBe(true);
  // …and the whole output is one of the two legal legacy shapes.
  expect(expectedLegacyPrompts()).toContain(prompt);
}

const FLAG = 'AI_CLASSIFY_MANIFEST_PROMPT';
const KILL = 'AI_ROUTING_MANIFEST_KILL';

describe('getClassifierSystemPrompt — M15 flag gating', () => {
  let savedFlag: string | undefined;
  let savedKill: string | undefined;

  beforeEach(() => {
    savedFlag = process.env[FLAG];
    savedKill = process.env[KILL];
    delete process.env[FLAG];
    delete process.env[KILL];
    resetPromptLoaderForTests();
  });

  afterEach(() => {
    if (savedFlag === undefined) delete process.env[FLAG]; else process.env[FLAG] = savedFlag;
    if (savedKill === undefined) delete process.env[KILL]; else process.env[KILL] = savedKill;
    resetPromptLoaderForTests();
  });

  it('flag OFF (default): byte-identical to the legacy classifier.md prompt (+ optional hints block)', () => {
    const prompt = getClassifierSystemPrompt();
    expectLegacyPrompt(prompt);
    expect(prompt).not.toContain('[CANDIDATE SHORTLIST]');
    expect(prompt).not.toContain('"skill" (optional)');
  });

  it('flag ON: serves the checked-in manifest build artifact byte-identically', () => {
    process.env[FLAG] = 'true';
    const prompt = getClassifierSystemPrompt();
    const artifact = fs.readFileSync(path.join(REPO_ROOT, 'prompts', 'classifier-manifest.md'), 'utf-8');
    expect(prompt).toBe(artifact);
    // …and the artifact itself is a fresh regeneration + trailing newline.
    expect(artifact).toBe(`${buildManifestClassifierPrompt()}\n`);
    expect(prompt).toContain('- "connections"');
    expect(prompt).toContain('- "notifications"');
    expect(prompt).toContain('- "decision_center"');
  });

  it('master kill forces the legacy prompt even when the flag is on', () => {
    process.env[FLAG] = 'true';
    process.env[KILL] = 'true';
    expectLegacyPrompt(getClassifierSystemPrompt());
  });
});
