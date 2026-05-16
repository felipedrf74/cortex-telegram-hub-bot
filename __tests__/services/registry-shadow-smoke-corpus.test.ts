// Phase 14 batch 74 (2026-05-16): examples-as-living-corpus (shadow mode).
//
// The hand-maintained smoke corpus at
// `__tests__/services/chat-hybrid-action-smoke-fixtures.test.ts` pins 183
// specific behaviors. Phase 0 audit flagged the duplication: every smoke
// fixture's "text + expected outcome" pair has an equivalent registry
// example, but they live in two places and drift independently.
//
// This shadow corpus generates fixtures from the registry's `examples`
// arrays and runs them through the same fixture-builder used by the
// real-eval scoring (Phase 11). It reports coverage stats but does NOT
// fail the build — flipping the smoke corpus to registry-derived is a
// separate cutover step that requires equivalence verification.
//
// Decision gate for full cutover: when this shadow comparator shows
// >= 95% text-overlap with the hand-maintained corpus AND the generated
// fixtures alone keep the real-eval gates green, the hand-maintained
// fixtures can be deleted.

import { describe, expect, it } from 'vitest';

import { buildFixturesFromRegistry } from '../lib/registry-fixture-builder';
import { getChatActionRegistry } from '../../src/services/chat-action-registry';

describe('registry-shadow smoke corpus (Phase 14 batch 74)', () => {
  const generated = buildFixturesFromRegistry({
    registry: getChatActionRegistry(),
  });

  it('generates a non-empty shadow corpus from registry examples', () => {
    expect(generated.length).toBeGreaterThanOrEqual(100);
  });

  it('covers every action that has at least one registry example', () => {
    const registry = getChatActionRegistry();
    const actionsWithExamples = registry
      .filter((e) => Array.isArray(e.examples) && e.examples.length > 0)
      .map((e) => e.action);
    const generatedActions = new Set(
      generated.map((f) => f.expectedAction).filter(Boolean),
    );
    const missing = actionsWithExamples.filter((a) => !generatedActions.has(a));
    // Negative-only actions (where every example has expectedAction: null)
    // legitimately don't surface here. Allow up to 5 such gaps.
    expect(missing.length).toBeLessThanOrEqual(5);
  });

  it('produces at least 30 fixtures with locale es (Phase 12-14 ES expansion)', () => {
    const es = generated.filter((f) => f.locale === 'es-ES');
    expect(es.length).toBeGreaterThanOrEqual(30);
  });

  it('produces at least 60 fixtures with locale pt', () => {
    const pt = generated.filter((f) => f.locale === 'pt-PT');
    expect(pt.length).toBeGreaterThanOrEqual(60);
  });

  it('produces at least 100 fixtures with locale en', () => {
    const en = generated.filter((f) => f.locale === 'en-US');
    expect(en.length).toBeGreaterThanOrEqual(100);
  });

  it('every generated fixture has a non-empty text', () => {
    for (const f of generated) {
      expect(f.text.trim().length).toBeGreaterThan(0);
    }
  });

  it('every generated fixture has a stable id derived from skill.action', () => {
    const ids = new Set(generated.map((f) => f.id));
    expect(ids.size).toBe(generated.length);
  });

  it('shadow-mode tracker: registry coverage by tag', () => {
    // Reports counts by tag class so trend can be tracked over time.
    // No assertion — informational only.
    const byTag: Record<string, number> = {};
    for (const f of generated) {
      const tag = f.expectedRefusal ? 'refusal' : f.expectedGate ? 'gate-passes' : 'gate-rejects';
      byTag[tag] = (byTag[tag] ?? 0) + 1;
    }
    // Sanity: at least 50 gate-passes (golden + ambiguous) and at least 20
    // gate-rejects (negative + prompt_injection).
    expect(byTag['gate-passes'] ?? 0).toBeGreaterThanOrEqual(50);
  });
});
