import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mocks for the orchestrator wiring-contract describe below. They are
// inert for the pure-counter unit tests (which never import the orchestrator).
const orchestratorMocks = vi.hoisted(() => ({
  dispatchLocalReasoning: vi.fn(),
}));

vi.mock('../../src/services/provider-registry', () => ({
  ensureActiveProvider: vi.fn(() => ({
    dispatchLocalReasoning: orchestratorMocks.dispatchLocalReasoning,
  })),
}));

vi.mock('../../src/services/chat-core-v2/cloud-allowlist-answer', () => ({
  dispatchCloudAllowlistAnswer: vi.fn(),
}));

import { logger } from '../../src/utils/logger';
import * as traceRecorder from '../../src/services/chat-core-v2/trace-recorder';
import type { AnswerCompositionMode } from '../../src/services/chat-core-v2/answer-composition';
import * as composerModeCounter from '../../src/services/chat-core-v2/composer-mode-counter';
import {
  _resetComposerModeCounterForTests,
  recordComposerModeTurn,
} from '../../src/services/chat-core-v2/composer-mode-counter';
import { runChatCoreV2LocalChatTurn } from '../../src/services/chat-core-v2/local-chat-orchestrator';
import { _resetLocalInferenceGateForTests } from '../../src/services/chat-core-v2/local-inference-concurrency-gate';

function envWith(orchestratorMode?: string): NodeJS.ProcessEnv {
  return (orchestratorMode === undefined
    ? {}
    : { CHAT_CORE_V2_ORCHESTRATOR_MODE: orchestratorMode }) as NodeJS.ProcessEnv;
}

/**
 * Records `count` turns of `mode` against `env`. Returns nothing; the caller
 * inspects the logger spy to assert drift behavior.
 */
function recordMany(mode: AnswerCompositionMode, count: number, env: NodeJS.ProcessEnv): void {
  for (let i = 0; i < count; i += 1) {
    recordComposerModeTurn(mode, env);
  }
}

/** Returns the warn-spy calls that carry a composer_mode_drift event. */
function driftCalls(warnSpy: ReturnType<typeof vi.spyOn>): unknown[][] {
  return warnSpy.mock.calls.filter((call) => {
    const payload = call[0] as { event?: { failureMode?: string } } | undefined;
    return payload?.event?.failureMode === 'composer_mode_drift';
  });
}

describe('ChatCoreV2 composer-mode counter + drift', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetComposerModeCounterForTests();
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => true as unknown as void);
    warnSpy.mockClear();
  });

  afterEach(() => {
    _resetComposerModeCounterForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('is a no-op when the orchestrator is off (absent and explicit off): no drift ever fires', () => {
    // Absent mode resolves to 'off' (default-off). Push well past the window
    // minimum entirely with model_constrained — drift would fire if it counted.
    recordMany('model_constrained', 200, envWith(undefined));
    expect(driftCalls(warnSpy)).toHaveLength(0);

    // Explicit off.
    recordMany('model_constrained', 200, envWith('off'));
    expect(driftCalls(warnSpy)).toHaveLength(0);

    // Sanity: messy explicit off ('OFF ' / ' Off') also resolves to off.
    recordMany('model_constrained', 200, envWith('OFF '));
    expect(driftCalls(warnSpy)).toHaveLength(0);
  });

  it('records turns when active (on / shadow / canary) without throwing', () => {
    for (const mode of ['on', 'shadow', 'canary'] as const) {
      _resetComposerModeCounterForTests();
      // A small, non-drifting window: a few model_constrained turns under the
      // min-sample guard never fire.
      expect(() => recordMany('model_constrained', 5, envWith(mode))).not.toThrow();
      expect(driftCalls(warnSpy)).toHaveLength(0);
    }
  });

  it('does NOT fire at exactly 0.30 model_constrained share (30 of 100)', () => {
    const env = envWith('on');
    recordMany('templated', 70, env);
    recordMany('model_constrained', 30, env);
    expect(driftCalls(warnSpy)).toHaveLength(0);
  });

  it('does NOT fire at exactly 0.35 model_constrained share (35 of 100)', () => {
    // Boundary: strictly-exceeds means 0.35 itself does not fire.
    const env = envWith('on');
    recordMany('templated', 65, env);
    recordMany('model_constrained', 35, env);
    expect(driftCalls(warnSpy)).toHaveLength(0);
  });

  it('FIRES the moment model_constrained share strictly exceeds 0.35', () => {
    const env = envWith('on');
    // 64 templated first, then model_constrained one at a time. The share
    // crosses strictly above 0.35 at the 35th model_constrained turn
    // (35 / 99 = 0.3535 > 0.35), and drift fires exactly then.
    recordMany('templated', 64, env);
    expect(driftCalls(warnSpy)).toHaveLength(0);
    recordMany('model_constrained', 34, env); // 34/98 = 0.3469 → still no fire
    expect(driftCalls(warnSpy)).toHaveLength(0);
    recordComposerModeTurn('model_constrained', env); // 35/99 = 0.3535 → fires

    const calls = driftCalls(warnSpy);
    // De-dupe: it logs only on the transition into drift, not on every turn.
    expect(calls).toHaveLength(1);

    const payload = calls[0][0] as {
      event: {
        failureMode: string;
        reasonCode: string;
        metricValue?: number;
        threshold: string;
        safeMetadata: Record<string, unknown>;
      };
    };
    expect(payload.event.failureMode).toBe('composer_mode_drift');
    expect(payload.event.metricValue).toBeGreaterThan(0.35);
    expect(payload.event.safeMetadata.window_count).toBe(99);
    expect(payload.event.safeMetadata.threshold).toBe(0.35);
    expect(payload.event.safeMetadata.mode_share).toBeGreaterThan(0.35);
  });

  it('fixed-window boundary: no fire at 35/100 (0.35), fires at 36/100 (0.36)', () => {
    // Build a fixed 100-turn window where model_constrained is interleaved so no
    // prefix exceeds 0.35 until the final turn. Pattern: 2 templated then 1
    // model_constrained, repeated — yields ~33% along the way, ending at a
    // controlled boundary. We construct exactly: 65 templated + 35
    // model_constrained interleaved (max prefix share <= 0.35), so the 100-turn
    // window sits at exactly 0.35 and does NOT fire...
    const noFireEnv = envWith('on');
    const pattern: AnswerCompositionMode[] = [];
    let mc = 0;
    let tmpl = 0;
    // Interleave to keep every prefix share <= 0.35 until total = 100.
    while (pattern.length < 100) {
      const total = pattern.length + 1;
      const wantMc = mc + 1;
      if (wantMc / total <= 0.35 && mc < 35) {
        pattern.push('model_constrained');
        mc += 1;
      } else {
        pattern.push('templated');
        tmpl += 1;
      }
    }
    expect(mc).toBe(35);
    expect(tmpl).toBe(65);
    for (const mode of pattern) recordComposerModeTurn(mode, noFireEnv);
    expect(driftCalls(warnSpy)).toHaveLength(0); // 35/100 = 0.35 exactly → no fire

    // ...and a fresh window with 36/100 = 0.36 DOES fire.
    _resetComposerModeCounterForTests();
    warnSpy.mockClear();
    const fireEnv = envWith('on');
    const firePattern: AnswerCompositionMode[] = [];
    let mc2 = 0;
    while (firePattern.length < 100) {
      const total = firePattern.length + 1;
      // Allow up to 0.36 so the final count reaches 36.
      if ((mc2 + 1) / total <= 0.36 && mc2 < 36) {
        firePattern.push('model_constrained');
        mc2 += 1;
      } else {
        firePattern.push('templated');
      }
    }
    expect(mc2).toBe(36);
    for (const mode of firePattern) recordComposerModeTurn(mode, fireEnv);
    const calls = driftCalls(warnSpy);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const payload = calls[calls.length - 1][0] as { event: { safeMetadata: { mode_share: number } } };
    expect(payload.event.safeMetadata.mode_share).toBeGreaterThan(0.35);
  });

  it('does not re-log on every turn once sustained over threshold (non-spammy)', () => {
    const env = envWith('on');
    recordMany('templated', 64, env);
    recordMany('model_constrained', 36, env); // first crossing → 1 log
    // Keep adding model_constrained; share stays > 0.35 but no new log.
    recordMany('model_constrained', 50, env);
    expect(driftCalls(warnSpy)).toHaveLength(1);
  });

  it('prunes entries older than the 1h window (LRU expiry)', () => {
    const env = envWith('on');
    const base = 1_000_000_000_000;
    // Phase 1 (at t0): a full over-threshold window that WOULD drift.
    vi.spyOn(Date, 'now').mockReturnValue(base);
    recordMany('templated', 64, env);
    recordMany('model_constrained', 36, env);
    expect(driftCalls(warnSpy)).toHaveLength(1);

    // Reset the latch by clearing logged calls; advance time past the 1h window
    // (3.6e6 ms) plus a margin, then record a SMALL all-templated window. If
    // pruning works, the old over-threshold samples are gone, the new window is
    // below the min-sample guard, and no further drift fires.
    warnSpy.mockClear();
    vi.spyOn(Date, 'now').mockReturnValue(base + 3.6e6 + 60_000);
    recordMany('templated', 5, env);
    expect(driftCalls(warnSpy)).toHaveLength(0);

    // And a fresh, post-expiry over-threshold window fires again (proving the
    // old entries no longer dominate the share).
    recordMany('templated', 59, env);
    recordMany('model_constrained', 36, env);
    expect(driftCalls(warnSpy)).toHaveLength(1);
  });

  it('PRIVACY: drift event carries no per-tenant identity and writes NO trace span', () => {
    const traceSpy = vi.spyOn(traceRecorder, 'recordChatV2TraceSpan');
    const env = envWith('on');
    recordMany('templated', 64, env);
    recordMany('model_constrained', 36, env);

    const calls = driftCalls(warnSpy);
    expect(calls).toHaveLength(1);

    // No trace span is ever written for this system-level aggregate signal.
    expect(traceSpy).not.toHaveBeenCalled();

    // The full logged payload must contain no tenant/user identity, anywhere.
    const serialized = JSON.stringify(calls[0][0]);
    expect(serialized).not.toMatch(/tenantId/i);
    expect(serialized).not.toMatch(/userId/i);
    expect(serialized).not.toMatch(/"tenant_id"/i);
    expect(serialized).not.toMatch(/"user_id"/i);

    // safeMetadata must be aggregate numbers only (no strings leaked through).
    const payload = calls[0][0] as { event: { safeMetadata: Record<string, unknown> } };
    for (const value of Object.values(payload.event.safeMetadata)) {
      expect(typeof value).toBe('number');
    }
  });

  it('threshold uses the code value 0.35 from ANSWER_COMPOSITION_MODE_BUDGETS', () => {
    // Documented spec/code divergence: code value 0.35 (spec cites 0.30).
    const env = envWith('on');
    recordMany('templated', 64, env);
    recordMany('model_constrained', 36, env);
    const payload = driftCalls(warnSpy)[0][0] as { event: { safeMetadata: { threshold: unknown } } };
    expect(payload.event.safeMetadata.threshold).toBe(0.35);
  });
});

/**
 * Wiring contract (orchestrator-level): the counter must be recorded exactly
 * ONCE per NON-DEGRADED successful return, with the actual composer mode, and
 * NEVER on a degraded answer or a null return. These tests spy on the real
 * `recordComposerModeTurn` (which the orchestrator imports from the same module
 * namespace) and assert the call contract, not the response shape.
 */
describe('ChatCoreV2 composer-mode counter — orchestrator wiring contract', () => {
  let recordSpy: ReturnType<typeof vi.spyOn>;

  function wiringEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
    return {
      NODE_ENV: 'test',
      CHAT_CORE_V2_ORCHESTRATOR_MODE: 'canary',
      CHAT_CORE_V2_ALLOWED_SURFACES: 'ios',
      CHAT_CORE_V2_CANARY_ENABLED_TENANT_IDS: '84',
      CHAT_CORE_V2_LOCAL_CHAT_LLM_MODE: 'canary',
      CHAT_CORE_V2_LOCAL_CHAT_MODEL: 'qwen2.5:3b-instruct-q4_K_M',
      ...overrides,
    } as NodeJS.ProcessEnv;
  }

  beforeEach(() => {
    orchestratorMocks.dispatchLocalReasoning.mockReset();
    _resetLocalInferenceGateForTests();
    _resetComposerModeCounterForTests();
    // Replace the real implementation so the assertion is purely on the wiring
    // call, decoupled from the drift-window math (covered above).
    recordSpy = vi
      .spyOn(composerModeCounter, 'recordComposerModeTurn')
      .mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records exactly once with the real composer mode on a NON-DEGRADED local-llm return', async () => {
    orchestratorMocks.dispatchLocalReasoning.mockResolvedValue({
      text: 'Escolhe uma prioridade pequena e protege um bloco curto para terminá-la.',
      providerMetadata: { providerUsed: 'ollama', modelUsed: 'qwen2.5:3b-instruct-q4_K_M', fallbackUsed: false },
    });

    const env = wiringEnv();
    const result = await runChatCoreV2LocalChatTurn({
      normalizedText: 'Como posso manter foco hoje?',
      userId: 42,
      tenantId: 84,
      requestId: 'req-wire-ok',
      locale: 'pt-BR',
      surface: 'ios',
      env,
    });

    // The real success path (not a vacuous assertion): a non-degraded answer.
    expect(result?.degraded).toBe(false);
    expect(result?.response.routeMethod).toBe('chat-core-v2-local-llm');
    expect(result?.response.metadata.compositionMode).toBe('model_constrained');

    // Recorded exactly once, with the returned answer's composer mode + same env.
    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy).toHaveBeenCalledWith('model_constrained', env);
  });

  it('does NOT record on a degraded validation-failed return', async () => {
    // Empty text → draft fails validateComposedAnswerDraft → degraded return.
    orchestratorMocks.dispatchLocalReasoning.mockResolvedValue({
      text: '   ',
      providerMetadata: { providerUsed: 'ollama', modelUsed: 'qwen2.5:3b-instruct-q4_K_M', fallbackUsed: false },
    });

    const result = await runChatCoreV2LocalChatTurn({
      normalizedText: 'Como posso manter foco hoje?',
      userId: 42,
      tenantId: 84,
      requestId: 'req-wire-degraded',
      locale: 'pt-BR',
      surface: 'ios',
      env: wiringEnv(),
    });

    expect(result?.degraded).toBe(true);
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it('does NOT record on a null return (write-intent short-circuit)', async () => {
    const result = await runChatCoreV2LocalChatTurn({
      normalizedText: 'Mark comprar suplementos QA LOCAL task as done',
      userId: 42,
      tenantId: 84,
      requestId: 'req-wire-null',
      locale: 'en',
      surface: 'ios',
      env: wiringEnv(),
    });

    expect(result).toBeNull();
    expect(recordSpy).not.toHaveBeenCalled();
    expect(orchestratorMocks.dispatchLocalReasoning).not.toHaveBeenCalled();
  });
});
