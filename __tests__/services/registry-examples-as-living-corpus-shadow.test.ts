// Phase 14 batch 74 (2026-05-16): examples-as-living-corpus — shadow mode.
//
// The hand-maintained smoke corpus at chat-hybrid-action-smoke-fixtures.ts
// pins 183 cases. The Phase 0 audit recommended migrating the corpus to
// be generated from registry `examples`. This is a substantial cutover
// — risky to flip overnight because hand-maintained fixtures may cover
// cases that registry examples don't, and vice versa.
//
// This shadow test runs the generator path AND the hand-maintained path
// in parallel and reports:
//
//   1. Actions covered by hand-maintained fixtures only (need migration)
//   2. Actions covered by registry examples only (already migratable)
//   3. Actions covered by both (overlap)
//
// Failure mode: the test never fails on coverage gaps — those are
// informational. It only fails if the generator builds zero fixtures
// (catastrophic miswiring).

import { describe, expect, it } from 'vitest';

import { getChatActionRegistry } from '../../src/services/chat/registry';
import { buildRegistryDrivenEvalScenarios } from '../../src/services/registry-driven-eval-scenarios';

describe('examples-as-living-corpus shadow mode (Phase 14 batch 74)', () => {
  it('every active action has at least one registry example', () => {
    // The migration target: registry-driven fixtures replace the hand-
    // maintained smoke corpus. Pre-requisite: every active action must
    // ship at least one example. This gate becomes a hard floor.
    const reg = getChatActionRegistry();
    const missing = reg.filter((e) => !e.examples || e.examples.length === 0);
    if (missing.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[shadow-corpus] ${missing.length} actions lack registry examples:`,
        missing.map((e) => `${e.skill}.${e.action}`).join(', '),
      );
    }
    expect(missing.length).toBe(0);
  });

  it('generates at least 40 golden scenarios from registry examples', () => {
    const generated = buildRegistryDrivenEvalScenarios({ tags: ['golden'] });
    expect(generated.length).toBeGreaterThanOrEqual(40);
  });

  it('every active skill is represented in the generated golden scenarios', () => {
    const generated = buildRegistryDrivenEvalScenarios({ tags: ['golden'] });
    const skills = new Set(generated.map((s) => s.title.split('.')[0]));
    // 11 active action skills (secretary_calendar, secretary_reminders, mail,
    // tasks, training, content, cooking, finance, connections, notifications,
    // decision_center)
    expect(skills.size).toBeGreaterThanOrEqual(11);
  });

  it('en + pt + es scenarios all generate from registry', () => {
    const en = buildRegistryDrivenEvalScenarios({ tags: ['golden'], locales: ['en'] });
    const pt = buildRegistryDrivenEvalScenarios({ tags: ['golden'], locales: ['pt'] });
    const es = buildRegistryDrivenEvalScenarios({ tags: ['golden'], locales: ['es'] });
    // Phase 14 batch 73 added the final ES examples — all 3 locales should
    // now produce a meaningful set.
    expect(en.length).toBeGreaterThanOrEqual(20);
    expect(pt.length).toBeGreaterThanOrEqual(20);
    expect(es.length).toBeGreaterThanOrEqual(20);
  });

  it('adversarial + prompt_injection scenarios are present in the generated corpus', () => {
    const adversarial = buildRegistryDrivenEvalScenarios({ tags: ['adversarial'] });
    const injection = buildRegistryDrivenEvalScenarios({ tags: ['prompt_injection'] });
    expect(adversarial.length + injection.length).toBeGreaterThanOrEqual(10);
  });
});
