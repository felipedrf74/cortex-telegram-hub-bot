import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  assertCanaryGateOrThrow,
  evaluateCanaryGate,
  isTenantInCanaryCohort,
  shouldServeCanaryForTenant,
  CHAT_CORE_V2_CANARY_DEFAULT_MIN_RECALL_AT_8,
} from '../../src/services/chat-core-v2/canary-gate-guard';
import {
  setChatCoreV2RuntimeOverride,
  _resetChatCoreV2RuntimeOverridesForTests,
} from '../../src/services/chat-core-v2/activation-flags';
import { CHAT_CORE_V2_GOLDEN_CORPUS_SEED } from '../../src/services/chat-core-v2/golden-corpus-seed';
import type { ChatCoreV2GoldenCorpus } from '../../src/services/chat-core-v2/golden-corpus';

type Env = Record<string, string | undefined>;

const ALL_FOUR_NON_CANARY_MODES: Array<Env['CHAT_CORE_V2_ORCHESTRATOR_MODE']> = [
  'off',
  'shadow',
  'on',
  undefined /* absent => parses to 'off' */,
];

// A producer that always returns an empty candidate set drives recall@8 to 0,
// which lets us exercise the recall_below_floor path deterministically without
// mutating the real selector. No user text is ever inspected.
const emptyProducer = (): string[] => [];

// A producer that always emits the seed's ground truth so recall is 1.0
// regardless of the synthetic phrasings — used to prove the floor passes.
function perfectProducer(corpus: ChatCoreV2GoldenCorpus): (message: string) => string[] {
  const byMessage = new Map<string, string[]>();
  for (const item of corpus.items) byMessage.set(item.message, item.expectedCapabilityIds);
  return (message: string) => byMessage.get(message) ?? [];
}

afterEach(() => {
  _resetChatCoreV2RuntimeOverridesForTests();
});

describe('canary-gate-guard inertness in off/shadow/on/absent (CANARY-ONLY)', () => {
  for (const mode of ALL_FOUR_NON_CANARY_MODES) {
    const label = mode ?? 'absent';

    it(`assertCanaryGateOrThrow is a NO-OP in mode=${label} regardless of recall floor`, () => {
      // recall floor impossible to meet (>1) AND empty producer => recall 0.
      const env: Env = {
        CHAT_CORE_V2_ORCHESTRATOR_MODE: mode,
        CHAT_CORE_V2_CANARY_MIN_RECALL_AT_8: '1',
      };
      expect(() =>
        assertCanaryGateOrThrow({ env, producer: emptyProducer }),
      ).not.toThrow();
    });

    it(`assertCanaryGateOrThrow is a NO-OP in mode=${label} regardless of cohort or NODE_ENV`, () => {
      const env: Env = {
        CHAT_CORE_V2_ORCHESTRATOR_MODE: mode,
        CHAT_CORE_V2_CANARY_ENABLED_TENANT_IDS: '', // empty cohort
        NODE_ENV: 'production',
        CHAT_CORE_V2_CANARY_GATE_OVERRIDE: 'force',
        CHAT_CORE_V2_CANARY_ALLOW_PROD: '0',
        CHAT_CORE_V2_CANARY_MIN_RECALL_AT_8: '1',
      };
      expect(() =>
        assertCanaryGateOrThrow({ env, producer: emptyProducer }),
      ).not.toThrow();
    });

    it(`shouldServeCanaryForTenant is false in mode=${label} even for a cohort tenant`, () => {
      const env: Env = {
        CHAT_CORE_V2_ORCHESTRATOR_MODE: mode,
        CHAT_CORE_V2_CANARY_ENABLED_TENANT_IDS: 'tenant-a',
      };
      expect(shouldServeCanaryForTenant('tenant-a', env)).toBe(false);
    });
  }
});

describe('canary-gate-guard recall floor (canary mode)', () => {
  it('throws recall_below_floor when synthetic-seed recall is below the floor', () => {
    const env: Env = {
      CHAT_CORE_V2_ORCHESTRATOR_MODE: 'canary',
      CHAT_CORE_V2_CANARY_ENABLED_TENANT_IDS: 'tenant-a',
    };
    expect(() =>
      assertCanaryGateOrThrow({ env, producer: emptyProducer }),
    ).toThrow(/recall_below_floor/);
  });

  it('returns (no throw) when recall is above the floor', () => {
    const env: Env = {
      CHAT_CORE_V2_ORCHESTRATOR_MODE: 'canary',
      CHAT_CORE_V2_CANARY_ENABLED_TENANT_IDS: 'tenant-a',
    };
    // Default real selector over the real seed (recall@8 ≈ 0.9772 >= 0.80).
    expect(() => assertCanaryGateOrThrow({ env })).not.toThrow();
  });

  it('verdict carries the default 0.80 boot floor and the measured recall', () => {
    const verdict = evaluateCanaryGate({
      env: { CHAT_CORE_V2_ORCHESTRATOR_MODE: 'canary' },
    });
    expect(verdict.minRecallAt8).toBe(CHAT_CORE_V2_CANARY_DEFAULT_MIN_RECALL_AT_8);
    expect(verdict.recallAt8).toBeGreaterThanOrEqual(0.8);
    expect(verdict.mode).toBe('canary');
    expect(verdict.allowed).toBe(true);
  });

  it('honors a per-env recall floor override', () => {
    const verdict = evaluateCanaryGate({
      env: {
        CHAT_CORE_V2_ORCHESTRATOR_MODE: 'canary',
        CHAT_CORE_V2_CANARY_MIN_RECALL_AT_8: '0.99',
      },
    });
    // Synthetic recall ≈ 0.9772 < 0.99 => below floor.
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons).toContain('recall_below_floor');
  });
});

describe('canary-gate-guard prod-override refusal (canary mode)', () => {
  const baseEnv: Env = {
    CHAT_CORE_V2_ORCHESTRATOR_MODE: 'canary',
    CHAT_CORE_V2_CANARY_ENABLED_TENANT_IDS: 'tenant-a',
    NODE_ENV: 'production',
    CHAT_CORE_V2_CANARY_GATE_OVERRIDE: 'force-on',
  };

  it('throws prod_override_refused in production with override set and ALLOW_PROD != 1', () => {
    const env: Env = { ...baseEnv, CHAT_CORE_V2_CANARY_ALLOW_PROD: '0' };
    // perfectProducer keeps recall at 1.0 so only the prod-override path fires.
    expect(() =>
      assertCanaryGateOrThrow({ env, producer: perfectProducer(CHAT_CORE_V2_GOLDEN_CORPUS_SEED) }),
    ).toThrow(/prod_override_refused/);
  });

  it('also refuses when ALLOW_PROD is entirely absent (not opted in)', () => {
    const env: Env = { ...baseEnv };
    const verdict = evaluateCanaryGate({
      env,
      producer: perfectProducer(CHAT_CORE_V2_GOLDEN_CORPUS_SEED),
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons).toContain('prod_override_refused');
  });

  it('allows when CHAT_CORE_V2_CANARY_ALLOW_PROD === 1 (explicit opt-in)', () => {
    const env: Env = { ...baseEnv, CHAT_CORE_V2_CANARY_ALLOW_PROD: '1' };
    const verdict = evaluateCanaryGate({
      env,
      producer: perfectProducer(CHAT_CORE_V2_GOLDEN_CORPUS_SEED),
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.reasons).not.toContain('prod_override_refused');
    expect(() =>
      assertCanaryGateOrThrow({ env, producer: perfectProducer(CHAT_CORE_V2_GOLDEN_CORPUS_SEED) }),
    ).not.toThrow();
  });

  it('does not refuse when override is unset, even in production', () => {
    const env: Env = {
      CHAT_CORE_V2_ORCHESTRATOR_MODE: 'canary',
      NODE_ENV: 'production',
      CHAT_CORE_V2_CANARY_ALLOW_PROD: '0',
    };
    const verdict = evaluateCanaryGate({
      env,
      producer: perfectProducer(CHAT_CORE_V2_GOLDEN_CORPUS_SEED),
    });
    expect(verdict.reasons).not.toContain('prod_override_refused');
    expect(verdict.allowed).toBe(true);
  });

  it('does not refuse outside production, even with override set and ALLOW_PROD != 1', () => {
    const env: Env = {
      CHAT_CORE_V2_ORCHESTRATOR_MODE: 'canary',
      NODE_ENV: 'staging',
      CHAT_CORE_V2_CANARY_GATE_OVERRIDE: 'force-on',
      CHAT_CORE_V2_CANARY_ALLOW_PROD: '0',
    };
    const verdict = evaluateCanaryGate({
      env,
      producer: perfectProducer(CHAT_CORE_V2_GOLDEN_CORPUS_SEED),
    });
    expect(verdict.reasons).not.toContain('prod_override_refused');
    expect(verdict.allowed).toBe(true);
  });
});

describe('canary cohort filter (isTenantInCanaryCohort)', () => {
  it('empty/absent cohort list means no tenant is in canary', () => {
    expect(isTenantInCanaryCohort('tenant-a', {})).toBe(false);
    expect(isTenantInCanaryCohort('tenant-a', { CHAT_CORE_V2_CANARY_ENABLED_TENANT_IDS: '' })).toBe(false);
    expect(isTenantInCanaryCohort('tenant-a', { CHAT_CORE_V2_CANARY_ENABLED_TENANT_IDS: '   ' })).toBe(false);
  });

  it('isolates tenants: only listed ids are in the cohort', () => {
    const env: Env = { CHAT_CORE_V2_CANARY_ENABLED_TENANT_IDS: 'tenant-a, tenant-c' };
    expect(isTenantInCanaryCohort('tenant-a', env)).toBe(true);
    expect(isTenantInCanaryCohort('tenant-c', env)).toBe(true);
    expect(isTenantInCanaryCohort('tenant-b', env)).toBe(false);
    expect(isTenantInCanaryCohort(undefined, env)).toBe(false);
  });

  it('empty cohort is observed (reason) but does NOT block the boot floor', () => {
    const verdict = evaluateCanaryGate({
      env: { CHAT_CORE_V2_ORCHESTRATOR_MODE: 'canary', CHAT_CORE_V2_CANARY_ENABLED_TENANT_IDS: '' },
      producer: perfectProducer(CHAT_CORE_V2_GOLDEN_CORPUS_SEED),
    });
    expect(verdict.cohortTenantIds).toEqual([]);
    expect(verdict.reasons).toContain('empty_cohort');
    expect(verdict.allowed).toBe(true);
    expect(() =>
      assertCanaryGateOrThrow({
        env: { CHAT_CORE_V2_ORCHESTRATOR_MODE: 'canary', CHAT_CORE_V2_CANARY_ENABLED_TENANT_IDS: '' },
        producer: perfectProducer(CHAT_CORE_V2_GOLDEN_CORPUS_SEED),
      }),
    ).not.toThrow();
  });
});

describe('shouldServeCanaryForTenant honors the per-tenant kill-switch demotion', () => {
  it('serves a cohort tenant in canary mode by default', () => {
    const env: Env = {
      CHAT_CORE_V2_ORCHESTRATOR_MODE: 'canary',
      CHAT_CORE_V2_CANARY_ENABLED_TENANT_IDS: 'tenant-a',
    };
    expect(shouldServeCanaryForTenant('tenant-a', env)).toBe(true);
    expect(shouldServeCanaryForTenant('tenant-b', env)).toBe(false);
  });

  it('demotes a single cohort tenant when its runtime override forces off (no restart)', () => {
    const env: Env = {
      CHAT_CORE_V2_ORCHESTRATOR_MODE: 'canary',
      CHAT_CORE_V2_CANARY_ENABLED_TENANT_IDS: 'tenant-a, tenant-b',
    };
    setChatCoreV2RuntimeOverride('tenant-a', { mode: 'off' });
    expect(shouldServeCanaryForTenant('tenant-a', env)).toBe(false);
    // tenant-b is untouched.
    expect(shouldServeCanaryForTenant('tenant-b', env)).toBe(true);
  });

  it('demotes a single cohort tenant when its runtime override forces shadow', () => {
    const env: Env = {
      CHAT_CORE_V2_ORCHESTRATOR_MODE: 'canary',
      CHAT_CORE_V2_CANARY_ENABLED_TENANT_IDS: 'tenant-a',
    };
    setChatCoreV2RuntimeOverride('tenant-a', { mode: 'shadow' });
    expect(shouldServeCanaryForTenant('tenant-a', env)).toBe(false);
  });

  it('an explicit env-off master kill switch demotes every tenant', () => {
    const env: Env = {
      CHAT_CORE_V2_ORCHESTRATOR_MODE: 'off',
      CHAT_CORE_V2_CANARY_ENABLED_TENANT_IDS: 'tenant-a',
    };
    expect(shouldServeCanaryForTenant('tenant-a', env)).toBe(false);
  });
});

describe('verdict NEVER references gateCanPromote (separation from promotion gate)', () => {
  it('the executable source never imports or calls gateCanPromote', () => {
    const source = readFileSync(
      join(__dirname, '../../src/services/chat-core-v2/canary-gate-guard.ts'),
      'utf8',
    );
    // Strip block comments and line comments so the doc comments (which
    // deliberately NAME gateCanPromote to document the separation) do not count.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/gateCanPromote/);
    expect(code).not.toMatch(/gate-metrics-store/);
  });

  it('the verdict object exposes no promotion-readiness field', () => {
    const verdict = evaluateCanaryGate({ env: { CHAT_CORE_V2_ORCHESTRATOR_MODE: 'canary' } });
    expect(verdict).not.toHaveProperty('gateCanPromote');
    expect(verdict).not.toHaveProperty('canPromote');
    expect(Object.keys(verdict).sort()).toEqual(
      ['allowed', 'cohortTenantIds', 'minRecallAt8', 'mode', 'reasons', 'recallAt8'].sort(),
    );
  });
});
