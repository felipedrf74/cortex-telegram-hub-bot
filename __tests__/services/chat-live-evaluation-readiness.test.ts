import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatLiveEvalRequestContext } from '../../src/services/chat-live-evaluation-contract';

const mocks = vi.hoisted(() => ({
  entitlement: vi.fn(),
  skillAccess: vi.fn(),
}));

vi.mock('../../src/services/entitlement', async () => ({
  ...(await vi.importActual('../../src/services/entitlement')),
  getEffectiveEntitlement: (...args: unknown[]) => mocks.entitlement(...args),
}));

vi.mock('../../src/services/skill-tiers', async () => ({
  ...(await vi.importActual('../../src/services/skill-tiers')),
  checkSkillAccess: (...args: unknown[]) => mocks.skillAccess(...args),
}));

import {
  assertChatLiveEvalDeployedStagingRelease,
  assertChatLiveEvalRealProviderReadiness,
} from '../../src/services/chat-live-evaluation-readiness';

const allParentSkills = new Set(['secretary', 'triathlon', 'content', 'cooking', 'finance']);
const DEPLOYED_SHA = 'c'.repeat(40);
const DEPLOYED_DIGEST = 'd'.repeat(64);

/** Mirrors what the release transaction exports into the serving process. */
function stubDeployedStagingRelease(overrides: Record<string, string | undefined> = {}): void {
  const values: Record<string, string | undefined> = {
    NEXUS_RELEASE_SHA: DEPLOYED_SHA,
    NEXUS_RELEASE_ARTIFACT_SHA256: DEPLOYED_DIGEST,
    NEXUS_RELEASE_ROLE: 'staging',
    ...overrides,
  };
  for (const [name, value] of Object.entries(values)) {
    vi.stubEnv(name, value as string);
  }
}

function context(mode: 'local_engine' | 'real_provider' = 'real_provider'): ChatLiveEvalRequestContext {
  return {
    version: 'chat-live-eval-v1',
    mode,
    runId: 'chat-eval-readiness-test',
    scenarioId: null,
    budget: mode === 'real_provider'
      ? { totalCeilingUsd: 0.5, targetCeilingUsd: 0.45, judgeCeilingUsd: 0.05 }
      : { totalCeilingUsd: 0.000001, targetCeilingUsd: 0.000001, judgeCeilingUsd: 0 },
    targetBaseCategory: mode === 'real_provider' ? 'chat_live_eval_real' : 'chat_live_eval_local',
    providerPolicy: mode === 'real_provider' ? 'metered_cloud_only' : 'ollama_only_zero_cloud',
    userId: 42,
    tenantId: 42,
    productionDataUsed: false,
  };
}

function founderEntitlement(overrides: Record<string, unknown> = {}) {
  return {
    userId: 42,
    plan: 'max',
    source: 'founder',
    aiAccessAllowed: true,
    allowedSkills: allParentSkills,
    ...overrides,
  };
}

describe('chat live-evaluation dedicated-tenant readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.entitlement.mockReturnValue(founderEntitlement());
    mocks.skillAccess.mockReturnValue({ allowed: true });
    stubDeployedStagingRelease();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not apply paid-entitlement checks to local-engine evidence', () => {
    expect(() => assertChatLiveEvalRealProviderReadiness(context('local_engine'))).not.toThrow();
    expect(mocks.entitlement).not.toHaveBeenCalled();
  });

  it.each([
    ['free', { plan: 'free', source: 'free', aiAccessAllowed: false }],
    ['beta', { plan: 'beta', source: 'beta', aiAccessAllowed: false }],
    ['owner', { plan: 'owner', source: 'owner', aiAccessAllowed: true }],
    ['synthetic provider', { plan: 'max', source: 'beta', aiAccessAllowed: true }],
  ])('rejects %s entitlement before any real-provider work', (_label, override) => {
    mocks.entitlement.mockReturnValue(founderEntitlement(override));
    expect(() => assertChatLiveEvalRealProviderReadiness(context())).toThrow(
      /complete dedicated-tenant scenario access/i,
    );
  });

  it('rejects a paid plan whose entitlement capability set is incomplete', () => {
    mocks.entitlement.mockReturnValue(founderEntitlement({
      allowedSkills: new Set(['secretary', 'triathlon', 'cooking', 'finance']),
    }));
    expect(() => assertChatLiveEvalRealProviderReadiness(context())).toThrow(
      /complete dedicated-tenant scenario access/i,
    );
  });

  it('rejects a globally or user-disabled action skill', () => {
    mocks.skillAccess.mockImplementation((_user: unknown, skillId: string) => ({
      allowed: skillId !== 'content',
    }));
    expect(() => assertChatLiveEvalRealProviderReadiness(context())).toThrow(
      /complete dedicated-tenant scenario access/i,
    );
  });

  it('fails closed with the same generic contract error when access resolution throws', () => {
    mocks.entitlement.mockImplementation(() => { throw new Error('private database detail'); });
    expect(() => assertChatLiveEvalRealProviderReadiness(context())).toThrowError(
      expect.objectContaining({
        code: 'CHAT_LIVE_EVAL_DISABLED',
        message: 'Real-provider chat evaluation requires complete dedicated-tenant scenario access.',
      }),
    );
  });

  it('accepts canonical max founder access only after all six action surfaces pass', () => {
    expect(() => assertChatLiveEvalRealProviderReadiness(context())).not.toThrow();
    expect(mocks.skillAccess.mock.calls.map((call) => call[1])).toEqual([
      'secretary.calendar',
      'secretary.tasks',
      'triathlon',
      'content',
      'cooking',
      'finance',
    ]);
  });
});

describe('chat live-evaluation deployed-release provenance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.entitlement.mockReturnValue(founderEntitlement());
    mocks.skillAccess.mockReturnValue({ allowed: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the identity the release transaction exported into the serving process', () => {
    stubDeployedStagingRelease();
    expect(assertChatLiveEvalDeployedStagingRelease(context())).toEqual({
      runtimeSha: DEPLOYED_SHA,
      artifactDigest: DEPLOYED_DIGEST,
      role: 'staging',
    });
  });

  it.each([
    ['no release identity at all', { NEXUS_RELEASE_SHA: undefined, NEXUS_RELEASE_ARTIFACT_SHA256: undefined, NEXUS_RELEASE_ROLE: undefined }],
    ['an unattested runtime sha', { NEXUS_RELEASE_SHA: 'unknown' }],
    ['an unattested artifact digest', { NEXUS_RELEASE_ARTIFACT_SHA256: 'unknown' }],
    ['a missing release role', { NEXUS_RELEASE_ROLE: undefined }],
  ])('refuses paid evaluation when the serving process reports %s', (_label, overrides) => {
    stubDeployedStagingRelease(overrides);
    expect(() => assertChatLiveEvalDeployedStagingRelease(context())).toThrowError(
      expect.objectContaining({
        code: 'CHAT_LIVE_EVAL_DISABLED',
        status: 403,
        message: 'Real-provider chat evaluation requires a verified deployed release identity.',
      }),
    );
  });

  it('refuses paid evaluation against a production release', () => {
    stubDeployedStagingRelease({ NEXUS_RELEASE_ROLE: 'production' });
    expect(() => assertChatLiveEvalDeployedStagingRelease(context())).toThrowError(
      expect.objectContaining({
        code: 'CHAT_LIVE_EVAL_DISABLED',
        status: 403,
        message: 'Real-provider chat evaluation is restricted to a deployed staging release.',
      }),
    );
  });

  it('reports the identity without requiring one for local-engine evidence', () => {
    stubDeployedStagingRelease({ NEXUS_RELEASE_SHA: undefined });
    expect(assertChatLiveEvalDeployedStagingRelease(context('local_engine'))).toBeNull();

    stubDeployedStagingRelease({ NEXUS_RELEASE_ROLE: 'production' });
    expect(assertChatLiveEvalDeployedStagingRelease(context('local_engine'))?.role).toBe('production');
  });

  it('blocks a real-provider run on provenance before any entitlement lookup happens', () => {
    stubDeployedStagingRelease({ NEXUS_RELEASE_SHA: undefined });
    expect(() => assertChatLiveEvalRealProviderReadiness(context())).toThrow(
      /verified deployed release identity/i,
    );
    expect(mocks.entitlement).not.toHaveBeenCalled();
  });
});
