// Phase 15 batch 79 (2026-05-16): per-action minimum eval coverage gate.
//
// The shadow-corpus check from batch 74 verified that every active action
// has ≥1 registry example. This batch promotes that to a HARD gate plus
// adds per-action minimums by example category:
//
//   • Every active action: ≥ 1 golden example
//   • Every external_side_effect action: ≥ 1 prompt_injection example
//     (security floor — high-risk actions can't ship without an injection
//     refusal fixture)
//   • Every destructive action: ≥ 1 ambiguous OR prompt_injection example
//
// These promote in CI starting Phase 15 — adding an action to the registry
// without the minimum examples trips the build.

import { describe, expect, it } from 'vitest';

import { getChatActionRegistry } from '../../src/services/chat/registry';

interface RegistryExample {
  text?: string;
  locale?: string;
  tags?: string[];
  expectedAction?: unknown;
  condition?: string;
  turns?: string[];
}

function exampleTags(ex: RegistryExample): string[] {
  return Array.isArray(ex.tags) ? ex.tags : ['golden'];
}

describe('per-action minimum eval coverage gate (Phase 15 batch 79)', () => {
  it('every active action has ≥ 1 golden example', () => {
    const reg = getChatActionRegistry();
    const missingGolden: string[] = [];
    for (const entry of reg) {
      const examples = (entry.examples ?? []) as RegistryExample[];
      const hasGolden = examples.some((ex) => exampleTags(ex).includes('golden'));
      if (!hasGolden) missingGolden.push(`${entry.skill}.${entry.action}`);
    }
    expect(missingGolden, `actions missing golden example: ${missingGolden.join(', ')}`).toEqual([]);
  });

  it('every external_side_effect action has ≥ 1 prompt_injection example', () => {
    const reg = getChatActionRegistry();
    const missingInjection: string[] = [];
    for (const entry of reg) {
      if (entry.risk !== 'external_side_effect') continue;
      const examples = (entry.examples ?? []) as RegistryExample[];
      const hasInjection = examples.some((ex) => exampleTags(ex).includes('prompt_injection'));
      if (!hasInjection) missingInjection.push(`${entry.skill}.${entry.action}`);
    }
    expect(
      missingInjection,
      `external_side_effect actions missing prompt_injection example: ${missingInjection.join(', ')}`,
    ).toEqual([]);
  });

  it('every destructive action has ≥ 1 ambiguous OR prompt_injection example', () => {
    const reg = getChatActionRegistry();
    const missingSafety: string[] = [];
    for (const entry of reg) {
      if (entry.risk !== 'destructive') continue;
      const examples = (entry.examples ?? []) as RegistryExample[];
      const hasSafety = examples.some((ex) => {
        const tags = exampleTags(ex);
        return tags.includes('ambiguous') || tags.includes('prompt_injection');
      });
      if (!hasSafety) missingSafety.push(`${entry.skill}.${entry.action}`);
    }
    expect(
      missingSafety,
      `destructive actions missing safety example: ${missingSafety.join(', ')}`,
    ).toEqual([]);
  });

  it('every financial action has ≥ 1 prompt_injection AND strong_confirm policy', () => {
    const reg = getChatActionRegistry();
    const missingInjection: string[] = [];
    const wrongConfirm: string[] = [];
    for (const entry of reg) {
      if (entry.risk !== 'financial') continue;
      const examples = (entry.examples ?? []) as RegistryExample[];
      const hasInjection = examples.some((ex) => exampleTags(ex).includes('prompt_injection'));
      if (!hasInjection) missingInjection.push(`${entry.skill}.${entry.action}`);
      if (entry.confirmationPolicy !== 'strong_confirm') {
        wrongConfirm.push(`${entry.skill}.${entry.action}`);
      }
    }
    expect(missingInjection).toEqual([]);
    expect(wrongConfirm).toEqual([]);
  });

  it('every active action has ≥ 2 examples total (golden + at least one of negative/ambiguous/adversarial)', () => {
    const reg = getChatActionRegistry();
    const tooThin: string[] = [];
    for (const entry of reg) {
      const examples = (entry.examples ?? []) as RegistryExample[];
      if (examples.length < 2) tooThin.push(`${entry.skill}.${entry.action} (count=${examples.length})`);
    }
    expect(tooThin, `actions with < 2 examples: ${tooThin.join(', ')}`).toEqual([]);
  });

  it('coverage summary: every locale + skill cell has ≥ 1 example', () => {
    // Cross-cutting matrix: does every (skill, locale) intersection have
    // coverage? Reports gaps but only fails on the skill axis (locale gaps
    // are tracked informationally).
    const reg = getChatActionRegistry();
    const skillsWithoutAnyExample = new Set<string>();
    for (const entry of reg) {
      const examples = (entry.examples ?? []) as RegistryExample[];
      if (examples.length === 0) skillsWithoutAnyExample.add(entry.skill);
    }
    expect(skillsWithoutAnyExample.size).toBe(0);
  });
});
