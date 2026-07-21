// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Milestone 14 — deterministic clarify policy (flag: AI_ROUTING_CLARIFY,
 * default OFF, suppressed by AI_ROUTING_MANIFEST_KILL).
 *
 * Policy under test: clarify ONLY when the top-2 calibrated manifest
 * candidates are within epsilon AND the turn is an actionable WRITE.
 * Reads NEVER clarify. One templated question max; a clarify-response turn
 * (detected via the continuity-state lastAssistantMessage) never re-clarifies.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  analyzeChatSkillOrchestration,
  buildChatSkillRoutingPromptBlock,
} from '../../src/services/chat-skill-orchestrator';
import {
  buildRoutingClarifyQuestion,
  isRoutingClarifyQuestion,
} from '../../src/services/chat/planner/clarification';
import {
  _resetRoutingCalibrationForTests,
} from '../../src/services/intent-resolution/confidence';
import {
  _setCompiledIntentVocabularyForTests,
  resetIntentVocabularyForTests,
  type CompiledCapabilityVocabulary,
} from '../../src/services/intent-resolution/vocabulary';
import {
  getRoutingClarifyCounters,
  resetRoutingClarifyCountersForTests,
} from '../../src/services/chat-hybrid-metrics';

function vocabularyEntry(
  capabilityId: string,
  domain: string,
  terms: string[],
  examples: string[] = [],
  order = 0,
): CompiledCapabilityVocabulary {
  return {
    capabilityId,
    domain,
    skill: capabilityId,
    order,
    matchers: terms.map((term, index) => ({
      label: `locale:en:${term}`,
      regex: new RegExp(`\\b(?:${term})\\b`, 'i'),
      // index keeps labels stable/unique
      ...(index >= 0 ? {} : {}),
    })),
    normalizedExamples: examples,
  };
}

/**
 * Synthetic vocabulary: "add" + "expense" hit finance (2 matchers), "add" +
 * "workout" hit training (2 matchers) → an ambiguous write like
 * "Add my workout expense" scores 2 vs 2 (same calibration bucket, gap 0).
 * "Add this receipt" normalizes to the seeded finance example (score 7 →
 * top calibration bucket) while training only matches "add" (score 1) —
 * a clear winner.
 */
const SYNTHETIC_VOCABULARY: CompiledCapabilityVocabulary[] = [
  vocabularyEntry('finance', 'finance', ['add', 'expense', 'receipt'], ['add this receipt'], 0),
  vocabularyEntry('triathlon', 'triathlon', ['add', 'workout', 'session'], [], 1),
  vocabularyEntry('secretary', 'secretary', ['task', 'reminder'], [], 2),
];

beforeEach(() => {
  _setCompiledIntentVocabularyForTests(SYNTHETIC_VOCABULARY);
  resetRoutingClarifyCountersForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetIntentVocabularyForTests();
  _resetRoutingCalibrationForTests();
  resetRoutingClarifyCountersForTests();
});

const AMBIGUOUS_WRITE = 'Add my workout expense';

describe('flag OFF (default) — zero behavior change', () => {
  beforeEach(() => {
    // Pin the flag off so this describe stays correct in a dedicated
    // flags-on verification run (AI_ROUTING_CLARIFY=true vitest ...).
    vi.stubEnv('AI_ROUTING_CLARIFY', 'false');
  });

  it('never emits a clarify decision', () => {
    const decision = analyzeChatSkillOrchestration({
      message: AMBIGUOUS_WRITE,
      userId: 42,
      tenantId: 42,
    });
    expect(decision.clarify).toBeNull();
  });

  it('does not render a clarify block into the prompt', () => {
    const decision = analyzeChatSkillOrchestration({ message: AMBIGUOUS_WRITE, userId: 42, tenantId: 42 });
    expect(buildChatSkillRoutingPromptBlock(decision)).not.toContain('<clarify_first');
  });

  it('records no clarify telemetry even when the deciding site opts in', () => {
    analyzeChatSkillOrchestration({
      message: AMBIGUOUS_WRITE,
      countClarifyTelemetry: true,
      userId: 42,
      tenantId: 42,
    });
    expect(getRoutingClarifyCounters()).toEqual({ evaluatedTurns: 0, clarifiedTurns: 0 });
  });
});

describe('flag ON — clarify triggers', () => {
  beforeEach(() => {
    vi.stubEnv('AI_ROUTING_CLARIFY', 'true');
  });

  it('epsilon-margin write/write → clarify with one templated EN question', () => {
    const decision = analyzeChatSkillOrchestration({
      message: AMBIGUOUS_WRITE,
      userId: 42,
      tenantId: 42,
    });
    expect(decision.clarify).not.toBeNull();
    expect(decision.clarify!.candidateDomains).toEqual(['finance', 'triathlon']);
    expect(decision.clarify!.question).toBe('Did you mean Finance or Training?');
    expect(decision.clarify!.reason).toBe('ambiguous_write_intents');
    expect(decision.reasonCodes).toContain('clarify_ambiguous_write_intents');
  });

  it('clear winner (example-utterance match) → act, no clarify', () => {
    const decision = analyzeChatSkillOrchestration({
      // Normalizes to the seeded finance example → finance bucket 0.95 vs
      // triathlon at 0.6: the gap exceeds epsilon, so the winner acts.
      message: 'Add this receipt',
      userId: 42,
      tenantId: 42,
    });
    expect(decision.clarify).toBeNull();
  });

  it('reads never clarify even when candidates tie', () => {
    const decision = analyzeChatSkillOrchestration({
      // Ambiguous domains but no write verb → information turn.
      message: 'my workout expense',
      userId: 42,
      tenantId: 42,
    });
    expect(decision.intentKinds).toContain('information');
    expect(decision.clarify).toBeNull();
  });

  it('write with a single actionable candidate → act, no clarify', () => {
    const decision = analyzeChatSkillOrchestration({
      message: 'Create a reminder task',
      userId: 42,
      tenantId: 42,
    });
    expect(decision.clarify).toBeNull();
  });

  it('loop prevention: a clarify-response turn does not re-clarify', () => {
    const decision = analyzeChatSkillOrchestration({
      message: AMBIGUOUS_WRITE,
      activeContext: {
        domain: 'finance',
        lastAssistantMessage: 'Did you mean Finance or Training?',
      },
      userId: 42,
      tenantId: 42,
    });
    expect(decision.clarify).toBeNull();
  });

  it('explicit-confirmation turns do not clarify', () => {
    const decision = analyzeChatSkillOrchestration({
      message: 'Yes, cancel the workout expense log',
      userId: 42,
      tenantId: 42,
    });
    expect(decision.safety.explicitConfirmation).toBe(true);
    expect(decision.clarify).toBeNull();
  });

  it('renders PT and ES templated questions using clarification locale conventions', () => {
    const pt = analyzeChatSkillOrchestration({ message: AMBIGUOUS_WRITE, locale: 'pt-BR', userId: 42, tenantId: 42 });
    expect(pt.clarify!.question).toBe('Queres dizer Finance ou Training?');
    const es = analyzeChatSkillOrchestration({ message: AMBIGUOUS_WRITE, locale: 'es-419', userId: 42, tenantId: 42 });
    expect(es.clarify!.question).toBe('¿Te refieres a Finance o a Training?');
  });

  it('never renders a clarify block into the prompt — clarify is a pipeline terminal, not a prompt hint', () => {
    const decision = analyzeChatSkillOrchestration({ message: AMBIGUOUS_WRITE, userId: 42, tenantId: 42 });
    expect(decision.clarify).not.toBeNull();
    const block = buildChatSkillRoutingPromptBlock(decision);
    expect(block).not.toContain('<clarify_first');
    expect(block).not.toContain(decision.clarify!.question);
  });

  it('counts the budget only for calls that explicitly opt in (the pipeline deciding site)', () => {
    // Non-deciding evaluations — never counted, with or without routedDomain
    // (context engine / simulations / websocket pass routedDomain too).
    analyzeChatSkillOrchestration({ message: AMBIGUOUS_WRITE, userId: 42, tenantId: 42 });
    analyzeChatSkillOrchestration({ message: AMBIGUOUS_WRITE, routedDomain: 'finance', userId: 42, tenantId: 42 });
    expect(getRoutingClarifyCounters()).toEqual({ evaluatedTurns: 0, clarifiedTurns: 0 });
    // Deciding site — counted exactly once per turn.
    analyzeChatSkillOrchestration({ message: AMBIGUOUS_WRITE, countClarifyTelemetry: true, userId: 42, tenantId: 42 });
    analyzeChatSkillOrchestration({ message: 'Create a reminder task', countClarifyTelemetry: true, userId: 42, tenantId: 42 });
    expect(getRoutingClarifyCounters()).toEqual({ evaluatedTurns: 2, clarifiedTurns: 1 });
  });

  it('master kill suppresses clarify even with the flag on', () => {
    vi.stubEnv('AI_ROUTING_MANIFEST_KILL', 'true');
    const decision = analyzeChatSkillOrchestration({ message: AMBIGUOUS_WRITE, userId: 42, tenantId: 42 });
    expect(decision.clarify).toBeNull();
  });
});

describe('clarify question rendering helpers (manifest displayNames)', () => {
  beforeEach(() => {
    resetIntentVocabularyForTests();
  });

  it('uses manifest displayNames for the real domains', () => {
    expect(buildRoutingClarifyQuestion(['triathlon', 'finance'], 'en-US')).toBe('Did you mean Training or Finance?');
    expect(buildRoutingClarifyQuestion(['secretary', 'content'], 'pt-BR')).toBe('Queres dizer Secretary ou Content?');
    expect(buildRoutingClarifyQuestion(['cooking', 'finance'], 'es-419')).toBe('¿Te refieres a Cooking o a Finance?');
  });

  it('detects its own templates for loop prevention in all three locales', () => {
    expect(isRoutingClarifyQuestion('Did you mean Training or Finance?')).toBe(true);
    expect(isRoutingClarifyQuestion('Queres dizer Secretary ou Content?')).toBe(true);
    expect(isRoutingClarifyQuestion('¿Te refieres a Cooking o a Finance?')).toBe(true);
    expect(isRoutingClarifyQuestion('Here is your agenda for today.')).toBe(false);
    expect(isRoutingClarifyQuestion('')).toBe(false);
  });
});

describe('calibrated confidence routed through the table (flag-independent)', () => {
  it('resolveConfidence branch values come from the calibration table', async () => {
    const { _setRoutingCalibrationForTests, BOOTSTRAP_ROUTING_CALIBRATION } =
      await import('../../src/services/intent-resolution/confidence');
    _setRoutingCalibrationForTests({
      ...BOOTSTRAP_ROUTING_CALIBRATION,
      orchestrator: {
        ...BOOTSTRAP_ROUTING_CALIBRATION.orchestrator,
        branches: { ...BOOTSTRAP_ROUTING_CALIBRATION.orchestrator.branches, default: 0.8 },
      },
    });
    const decision = analyzeChatSkillOrchestration({
      message: 'my workout expense',
      userId: 42,
      tenantId: 42,
    });
    expect(decision.confidence).toBe(0.8);
  });
});
